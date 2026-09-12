/** Human reconciliation and revocation, with fresh locked authority checks and no effect runner. */
import {
  storedExternalEffectRefusalBinding,
  type ExternalEffectReconciliationRequest,
  type ExternalEffectGrantInspection,
  type ExternalEffectGrantPublicInspection,
  type ExternalEffectTransitionOptions,
  type ExternalEffectRevokeOptions,
  inspectionFromState,
  redactTransactionToken,
  assertTrustedSigner,
  exactDate,
  assertUuid,
  assertReason,
  assertManualReconciliationState,
  assertReconciliationReplay,
} from '../../modules/authority/external-effect-grant.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import {
  parseReconciliationRequest,
  createReconciliationRecord,
  canonicalReconciliation,
} from '../../modules/authority/external-effect-grant-records.ts';
import { auditInput } from '../../modules/authority/external-effect-grant-audit.ts';

import { type ExternalEffectGrantContext } from './external-effect-grant-context.ts';
import { type ExternalEffectGrantTransaction } from './external-effect-grant-transaction.ts';
export function createExternalEffectGrantReconciliation(
  {
    discoverRepository,
    externalEffectStorePaths,
    readStoreState,
    validateEnvelopeForRepository,

    refusalAuditOptions,
    loadTrustForPayload,
    createInteractiveSshSigner,
    withRepositoryLifecycleOperation,
    emitAudit,
    createPrivateFileAtomic,
    reconciliationPath,
    withAuthorityRefusalAudit,
    clockNow,
  }: Pick<
    ExternalEffectGrantContext,
    | 'discoverRepository'
    | 'externalEffectStorePaths'
    | 'readStoreState'
    | 'validateEnvelopeForRepository'
    | 'refusalAuditOptions'
    | 'loadTrustForPayload'
    | 'createInteractiveSshSigner'
    | 'withRepositoryLifecycleOperation'
    | 'emitAudit'
    | 'createPrivateFileAtomic'
    | 'reconciliationPath'
    | 'withAuthorityRefusalAudit'
    | 'clockNow'
  >,
  terminalize: ExternalEffectGrantTransaction['terminalize'],
) {
  function reconcileExternalEffectGrant(
    cwd: string,
    requestedGrantId: string,
    requestedReconciliation: ExternalEffectReconciliationRequest,
    options: ExternalEffectTransitionOptions,
  ): ExternalEffectGrantPublicInspection {
    const grantId = assertUuid(requestedGrantId);
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    const now = exactDate(options.now ?? clockNow());
    const initial = readStoreState(paths, grantId);
    validateEnvelopeForRepository(
      repository.repositoryRoot,
      initial.record.envelope,
      options.signer,
    );
    return withAuthorityRefusalAudit(
      storedExternalEffectRefusalBinding(
        repository.repositoryRoot,
        initial.record.envelope,
        initial.record.grantDigest,
        'external-effect.reconcile',
        { requestedReconciliation },
      ),
      refusalAuditOptions(now, options),
      () => {
        assertManualReconciliationState(initial);
        const request = parseReconciliationRequest(
          requestedReconciliation,
          initial.record,
          now,
        );
        const trust = loadTrustForPayload(
          repository.repositoryRoot,
          initial.record.envelope.payload,
        );
        const signer =
          options.signer ??
          createInteractiveSshSigner(repository.repositoryRoot, trust.policy);
        signer.assertHumanPresent();
        const resolver = signer.identity();
        assertTrustedSigner(trust.policy, resolver);

        return redactTransactionToken(
          withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
            const current = readStoreState(paths, grantId);
            validateEnvelopeForRepository(
              repository.repositoryRoot,
              current.record.envelope,
              options.signer,
            );
            assertManualReconciliationState(current);
            const exactRequest = parseReconciliationRequest(
              request,
              current.record,
              now,
            );
            if (current.reconciliation) {
              assertReconciliationReplay(
                current.reconciliation,
                exactRequest,
                resolver,
              );
              return inspectionFromState(current, now);
            }
            const reconciliation = createReconciliationRecord(
              current.record,
              exactRequest,
              resolver,
              now,
            );
            assertOwned();
            emitAudit(
              repository.repositoryRoot,
              options,
              auditInput(
                current.record.envelope,
                current.record.grantDigest,
                'reconciliation-resolved',
                now,
                {
                  transactionId: current.record.transactionId,
                  poststateDigest: reconciliation.poststateDigest,
                  evidenceDigest: reconciliation.evidenceDigest,
                  resolver,
                  result: `reconciled-${reconciliation.outcome}`,
                  reason: reconciliation.reason,
                },
              ),
            );
            assertOwned();
            createPrivateFileAtomic(
              reconciliationPath(paths, grantId),
              canonicalReconciliation(reconciliation),
            );
            assertOwned();
            return inspectionFromState(
              { kind: 'terminal', record: current.record, reconciliation },
              now,
            );
          }),
        );
      },
    );
  }

  function revokeExternalEffectGrant(
    cwd: string,
    requestedGrantId: string,
    options: ExternalEffectRevokeOptions,
  ): ExternalEffectGrantInspection {
    const grantId = assertUuid(requestedGrantId);
    const reason = assertReason(options.reason);
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    const now = exactDate(options.now ?? clockNow());
    const initial = readStoreState(paths, grantId);
    validateEnvelopeForRepository(
      repository.repositoryRoot,
      initial.record.envelope,
      options.signer,
    );
    return withAuthorityRefusalAudit(
      storedExternalEffectRefusalBinding(
        repository.repositoryRoot,
        initial.record.envelope,
        initial.record.grantDigest,
        'external-effect.revoke',
        { reason },
      ),
      refusalAuditOptions(now, options),
      () => {
        const trust = loadTrustForPayload(
          repository.repositoryRoot,
          initial.record.envelope.payload,
        );
        const signer =
          options.signer ??
          createInteractiveSshSigner(repository.repositoryRoot, trust.policy);
        signer.assertHumanPresent();
        assertTrustedSigner(trust.policy, signer.identity());
        return withRepositoryLifecycleOperation(
          paths.runtime,
          (assertOwned) => {
            const current = readStoreState(paths, grantId);
            validateEnvelopeForRepository(
              repository.repositoryRoot,
              current.record.envelope,
              options.signer,
            );
            if (current.kind === 'terminal')
              return inspectionFromState(current, now);
            if (
              current.kind === 'transaction' &&
              current.record.phase !== 'reserved'
            ) {
              throw workflowError(
                'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED',
                'A dispatched external effect cannot be revoked without reconciliation.',
                ExitCode.guard,
              );
            }
            return terminalize(
              repository.repositoryRoot,
              paths,
              current,
              'revoked',
              now,
              reason,
              options,
              assertOwned,
            );
          },
        );
      },
    );
  }
  return { reconcileExternalEffectGrant, revokeExternalEffectGrant };
}
