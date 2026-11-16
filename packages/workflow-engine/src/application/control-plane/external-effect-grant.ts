/** Issues and inspects exact grants, composing locked transaction and reconciliation operations. */
import {
  externalEffectRefusalBinding,
  EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
  EXTERNAL_EFFECT_MAX_TTL_SECONDS,
  type Sha256Digest,
  type ExternalEffectGrantRequest,
  type ExternalEffectGrantPayload,
  type ExternalEffectGrantEnvelope,
  type ExternalEffectGrantInspection,
  type ExternalEffectGrantPublicInspection,
  type ExternalEffectIssueOptions,
  assertProductionExternalEffectExecutor,
  inspectionFromState,
  redactTransactionToken,
  assertTrustedSigner,
  expired,
  exactDate,
  assertUuid,
  assertSignature,
  sha256,
  invalidGrant,
  unsafeStore,
  isWorkflowFailure,
} from '../../modules/authority/external-effect-grant.ts';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import {
  parseRequest,
  parsePayload,
  parseEnvelope,
  canonicalExternalEffectGrantPayload,
  canonicalExternalEffectGrantEnvelope,
} from '../../modules/authority/external-effect-grant-envelope.ts';
import {
  createAvailableRecord,
  createPendingRecord,
  parsePending,
  assertPendingMatchesRequest,
  parseAvailable,
  canonicalAvailable,
  canonicalPending,
} from '../../modules/authority/external-effect-grant-records.ts';
import { auditInput } from '../../modules/authority/external-effect-grant-audit.ts';
import { type MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';

import { type ExternalEffectGrantServices } from '../../modules/authority/external-effect-grant-services.ts';
import { createExternalEffectGrantContext } from './external-effect-grant-context.ts';
import { createExternalEffectGrantTransaction } from './external-effect-grant-transaction.ts';
import { createExternalEffectGrantReconciliation } from './external-effect-grant-reconciliation.ts';
export function createExternalEffectGrantOperations(
  services: ExternalEffectGrantServices,
) {
  const context = createExternalEffectGrantContext(services);
  const {
    taskMandate,
    clockNow,
    loadTrustContext,

    withAuthorityRefusalAudit,
    externalEffectStorePaths,
    grantPath,
    readOptionalPrivateFile,
    validateEnvelopeForRepository,
    createInteractiveSshSigner,
    assertExternalAuditRoot,
    discoverRepository,
    ensureStore,
    assertGrantAbsent,
    createPrivateFileAtomic,
    assertIdempotencyAvailable,
    emitAudit,
    createIdempotencyIndex,
    unlinkIfExact,
    readStoreState,
  } = context;
  const transaction = createExternalEffectGrantTransaction(context);
  const reconciliation = createExternalEffectGrantReconciliation(
    context,
    transaction.terminalize,
  );
  function issueExternalEffectGrant(
    cwd: string,
    request: ExternalEffectGrantRequest,
    options: ExternalEffectIssueOptions,
  ): {
    grantId: string;
    grantDigest: Sha256Digest;
    recordPath: string;
    envelope: ExternalEffectGrantEnvelope;
  } {
    const parsed = parseRequest(request);
    const now = exactDate(options.now ?? clockNow());
    const ttlSeconds = parsed.ttlSeconds ?? EXTERNAL_EFFECT_MAX_TTL_SECONDS;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > EXTERNAL_EFFECT_MAX_TTL_SECONDS
    ) {
      throw invalidGrant();
    }
    const grantId = assertUuid(options.grantId);
    const trust = loadTrustContext(cwd);
    const activeMandateBinding = taskMandate.inspectActiveTaskMandateBinding(
      trust.repository.repositoryRoot,
      parsed.mandateBinding.mandateTaskId,
      { now, signer: options.signer },
    );
    const refusalBinding = externalEffectRefusalBinding(
      trust.repository.repositoryRoot,
      trust.policy.repository.id,
      activeMandateBinding,
      grantId,
      parsed,
    );
    const refusalOptions = {
      now,
      serviceHooks: options.testAuditServiceHooks,
    };
    withAuthorityRefusalAudit(refusalBinding, refusalOptions, () => {
      if (
        canonicalJson(activeMandateBinding) !==
        canonicalJson(parsed.mandateBinding)
      ) {
        throw workflowError(
          'EXTERNAL_EFFECT_MANDATE_MISMATCH',
          'External effect grant does not match the exact active Task Mandate.',
          ExitCode.staleState,
        );
      }
      assertProductionExternalEffectExecutor(parsed.effectKind);
    });
    const paths = externalEffectStorePaths(trust.repository.gitCommonDirectory);
    const pendingPath = grantPath(paths.pending, grantId);
    const recoveredPendingRaw = readOptionalPrivateFile(pendingPath);
    const { envelope, grantDigest } = withAuthorityRefusalAudit(
      refusalBinding,
      refusalOptions,
      () => {
        if (recoveredPendingRaw !== null) {
          const pending = parsePending(recoveredPendingRaw);
          validateEnvelopeForRepository(
            trust.repository.repositoryRoot,
            pending.envelope,
            options.signer,
          );
          assertPendingMatchesRequest(
            pending,
            parsed,
            grantId,
            ttlSeconds,
            trust.repository.head,
          );
          if (expired(pending.envelope.payload, now)) {
            throw workflowError(
              'EXTERNAL_EFFECT_GRANT_STALE',
              'Pending external effect grant expired before audit recovery.',
              ExitCode.staleState,
            );
          }
          return {
            envelope: pending.envelope,
            grantDigest: pending.grantDigest,
          };
        }
        const signer =
          options.signer ??
          createInteractiveSshSigner(
            trust.repository.repositoryRoot,
            trust.policy,
          );
        signer.assertHumanPresent();
        const identity = signer.identity();
        assertTrustedSigner(trust.policy, identity);
        const payload: ExternalEffectGrantPayload = parsePayload({
          kind: 'external-effect-grant.v1',
          grantId,
          repositoryId: trust.policy.repository.id,
          repositoryOrigin: trust.policy.repository.origin,
          baseCommit: trust.repository.head,
          policyBlob: trust.policyBlob,
          externalAuditRoot: assertExternalAuditRoot(
            activeMandateBinding.externalAuditRoot,
            trust.repository.repositoryRoot,
          ),
          changeId: activeMandateBinding.changeId,
          mandateId: activeMandateBinding.mandateId,
          taskId: activeMandateBinding.mandateTaskId,
          mandateDigest: activeMandateBinding.mandateDigest,
          effectKind: parsed.effectKind,
          target: parsed.target,
          artifactDigest: parsed.artifactDigest,
          prestateDigest: parsed.prestateDigest,
          rollbackPlan: parsed.rollbackPlan,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
          uses: 1,
          idempotencyKey: parsed.idempotencyKey,
          signer: identity,
        });
        let signature: string;
        try {
          signature = signer.sign(
            canonicalExternalEffectGrantPayload(payload),
            EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
          );
          assertSignature(signature);
          signer.verify(
            canonicalExternalEffectGrantPayload(payload),
            signature,
            identity,
            EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
          );
        } catch (error) {
          if (isWorkflowFailure(error)) throw error;
          throw workflowError(
            'EXTERNAL_EFFECT_SIGNATURE_INVALID',
            'External effect grant signature could not be created or verified.',
            ExitCode.verification,
          );
        }
        const issuedEnvelope = parseEnvelope({ payload, signature });
        return {
          envelope: issuedEnvelope,
          grantDigest: sha256(
            canonicalExternalEffectGrantEnvelope(issuedEnvelope),
          ),
        };
      },
    );
    const record = createAvailableRecord(envelope, grantDigest);
    const recordPath = grantPath(paths.available, grantId);

    return withAuthorityRefusalAudit(refusalBinding, refusalOptions, () =>
      taskMandate.withActiveTaskMandateBinding(
        trust.repository.repositoryRoot,
        activeMandateBinding.mandateTaskId,
        { now, signer: options.signer },
        (binding, assertOwned) => {
          if (canonicalJson(binding) !== canonicalJson(parsed.mandateBinding)) {
            throw workflowError(
              'EXTERNAL_EFFECT_MANDATE_MISMATCH',
              'External effect grant does not match the exact active Task Mandate.',
              ExitCode.staleState,
            );
          }
          const current = discoverRepository(trust.repository.repositoryRoot);
          if (current.head !== trust.repository.head) {
            throw workflowError(
              'EXTERNAL_EFFECT_GRANT_STALE',
              'Repository HEAD moved before external effect grant publication.',
              ExitCode.staleState,
            );
          }
          ensureStore(paths);
          const observedPendingRaw = readOptionalPrivateFile(pendingPath);
          if (observedPendingRaw === null) {
            assertGrantAbsent(paths, grantId);
            createPrivateFileAtomic(
              pendingPath,
              canonicalPending(createPendingRecord(envelope, grantDigest)),
            );
          } else if (
            canonicalPending(parsePending(observedPendingRaw)) !==
            canonicalPending(createPendingRecord(envelope, grantDigest))
          ) {
            throw unsafeStore();
          }
          assertIdempotencyAvailable(
            paths,
            envelope.payload.idempotencyKey,
            grantId,
            grantDigest,
          );
          assertOwned();
          emitAudit(
            trust.repository.repositoryRoot,
            options,
            auditInput(
              envelope,
              grantDigest,
              'grant-issued',
              new Date(envelope.payload.issuedAt),
              {
                result: 'authorized',
              },
            ),
          );
          assertOwned();
          createIdempotencyIndex(
            paths,
            envelope.payload.idempotencyKey,
            grantId,
            grantDigest,
          );
          const existingAvailable = readOptionalPrivateFile(recordPath);
          if (existingAvailable === null) {
            createPrivateFileAtomic(recordPath, canonicalAvailable(record));
          } else if (
            canonicalAvailable(parseAvailable(existingAvailable)) !==
            canonicalAvailable(record)
          ) {
            throw unsafeStore();
          }
          unlinkIfExact(
            pendingPath,
            canonicalPending(createPendingRecord(envelope, grantDigest)),
          );
          assertOwned();
          return { grantId, grantDigest, recordPath, envelope };
        },
      ),
    );
  }
  function inspectExternalEffectGrant(
    cwd: string,
    requestedGrantId: string,
    options: { now?: Date; signer?: MaintainerSignerProvider } = {},
  ): ExternalEffectGrantPublicInspection {
    return redactTransactionToken(
      inspectExternalEffectGrantForExecutor(cwd, requestedGrantId, options),
    );
  }

  function inspectExternalEffectGrantForExecutor(
    cwd: string,
    requestedGrantId: string,
    options: { now?: Date; signer?: MaintainerSignerProvider } = {},
  ): ExternalEffectGrantInspection {
    const grantId = assertUuid(requestedGrantId);
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    const state = readStoreState(paths, grantId);
    validateEnvelopeForRepository(
      repository.repositoryRoot,
      state.record.envelope,
      options.signer,
    );
    return inspectionFromState(state, exactDate(options.now ?? clockNow()));
  }
  return {
    issueExternalEffectGrant,
    inspectExternalEffectGrant,
    inspectExternalEffectGrantForExecutor,
    reserveExternalEffectGrant: transaction.reserveExternalEffectGrant,
    markExternalEffectDispatchIssued:
      transaction.markExternalEffectDispatchIssued,
    recordExternalEffectObservation:
      transaction.recordExternalEffectObservation,
    consumeExternalEffectGrant: transaction.consumeExternalEffectGrant,
    terminalizeExternalEffectGrant: transaction.terminalizeExternalEffectGrant,
    assertActivePublishTransaction: transaction.assertActivePublishTransaction,
    ...reconciliation,
  };
}
export type ExternalEffectGrantOperations = ReturnType<
  typeof createExternalEffectGrantOperations
>;
