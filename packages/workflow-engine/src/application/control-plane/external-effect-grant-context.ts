/** Fresh repository/store verification and trusted refusal bindings shared by the lifecycle. */

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
  type ExternalEffectGrantPayload,
  type ExternalEffectGrantEnvelope,
  type ExternalEffectTransitionOptions,
  type StoreState,
} from '../../modules/authority/external-effect-grant.ts';
import { canonicalExternalEffectGrantPayload } from '../../modules/authority/external-effect-grant-envelope.ts';
import { resolveStoreState } from '../../modules/authority/external-effect-grant-records.ts';

import { type MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';

import { type ExternalEffectGrantServices } from '../../modules/authority/external-effect-grant-services.ts';
export function createExternalEffectGrantContext(
  services: ExternalEffectGrantServices,
) {
  const {
    externalEffectStorePaths,
    assertStore,
    grantPath,
    reconciliationPath,
    readOptionalPrivateFile,
  } = services.store;
  const {
    discoverRepository,
    loadPolicyAt,
    repositoryOrigin,
    assertExternalAuditRoot,
    createInteractiveSshSigner,
  } = services.repository;

  function refusalAuditOptions(
    now: Date,
    options: Pick<ExternalEffectTransitionOptions, 'testAuditServiceHooks'>,
  ) {
    return { now, serviceHooks: options.testAuditServiceHooks };
  }

  function readStoreState(
    paths: ReturnType<typeof externalEffectStorePaths>,
    grantId: string,
  ): StoreState {
    assertStore(paths);
    const availablePath = grantPath(paths.available, grantId);
    const transactionPath = grantPath(paths.transactions, grantId);
    const terminalPath = grantPath(paths.terminal, grantId);
    const resolvedPath = reconciliationPath(paths, grantId);
    const available = readOptionalPrivateFile(availablePath);
    const transaction = readOptionalPrivateFile(transactionPath);
    const terminal = readOptionalPrivateFile(terminalPath);
    const resolved = readOptionalPrivateFile(resolvedPath);
    return resolveStoreState(
      grantId,
      available,
      transaction,
      terminal,
      resolved,
    );
  }

  function validateEnvelopeForRepository(
    repositoryRoot: string,
    envelope: ExternalEffectGrantEnvelope,
    providedSigner?: MaintainerSignerProvider,
  ): void {
    const trust = loadTrustForPayload(repositoryRoot, envelope.payload);
    const origin = repositoryOrigin(repositoryRoot);
    assertExternalAuditRoot(envelope.payload.externalAuditRoot, repositoryRoot);
    if (
      trust.policy.repository.id !== envelope.payload.repositoryId ||
      trust.policy.repository.origin !== envelope.payload.repositoryOrigin ||
      trust.policyBlob !== envelope.payload.policyBlob ||
      origin !== envelope.payload.repositoryOrigin ||
      !trust.policy.trustedSigners.some(
        ({ identity }) => identity === envelope.payload.signer,
      )
    ) {
      throw workflowError(
        'EXTERNAL_EFFECT_REPOSITORY_MISMATCH',
        'External effect grant no longer matches the repository trust base.',
        ExitCode.staleState,
      );
    }
    const signer =
      providedSigner ??
      createInteractiveSshSigner(repositoryRoot, trust.policy);
    try {
      signer.verify(
        canonicalExternalEffectGrantPayload(envelope.payload),
        envelope.signature,
        envelope.payload.signer,
        EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
      );
    } catch {
      throw workflowError(
        'EXTERNAL_EFFECT_SIGNATURE_INVALID',
        'External effect grant signature is invalid for its dedicated domain.',
        ExitCode.verification,
      );
    }
  }

  function loadTrustContext(cwd: string) {
    const repository = discoverRepository(cwd);
    const origin = repositoryOrigin(repository.repositoryRoot);
    const loaded = loadPolicyAt(repository.repositoryRoot, repository.head);
    if (origin !== loaded.policy.repository.origin) {
      throw workflowError(
        'EXTERNAL_EFFECT_REPOSITORY_MISMATCH',
        'Repository origin differs from its trusted external effect policy.',
        ExitCode.guard,
      );
    }
    return { repository, ...loaded };
  }

  function loadTrustForPayload(
    repositoryRoot: string,
    payload: ExternalEffectGrantPayload,
  ) {
    return loadPolicyAt(repositoryRoot, payload.baseCommit);
  }
  return {
    ...services.store,
    ...services.repository,
    ...services.audit,
    taskMandate: services.taskMandate,
    clockNow: services.now,
    newTransactionEntropy: services.newTransactionEntropy,
    withRepositoryLifecycleOperation: services.withRepositoryLifecycleOperation,

    refusalAuditOptions,
    readStoreState,
    validateEnvelopeForRepository,
    loadTrustContext,
    loadTrustForPayload,
  };
}
export type ExternalEffectGrantContext = ReturnType<
  typeof createExternalEffectGrantContext
>;
