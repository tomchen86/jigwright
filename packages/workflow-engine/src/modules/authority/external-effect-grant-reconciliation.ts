/**
 * Reconciles uncertain external-effect outcomes and revokes eligible Grants
 * without replaying the effect.
 *
 * Invariants:
 * - Only a durable manual-reconciliation terminal (with a non-null
 *   transactionId) may be reconciled.
 * - A dispatched grant whose transaction phase is not 'reserved' cannot be
 *   revoked without reconciliation.
 */
import { withAuthorityRefusalAudit } from './authority-refusal-audit.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import type {
  ExternalEffectGrantReconciliationBindings,
  ExternalEffectGrantReconciliationTypes,
} from './external-effect-grant.ts';

type ExternalEffectReconciliationRequest =
  ExternalEffectGrantReconciliationTypes['ExternalEffectReconciliationRequest'];

type ExternalEffectTransitionOptions =
  ExternalEffectGrantReconciliationTypes['ExternalEffectTransitionOptions'];

type ExternalEffectGrantPublicInspection =
  ExternalEffectGrantReconciliationTypes['ExternalEffectGrantPublicInspection'];

type ExternalEffectRevokeOptions =
  ExternalEffectGrantReconciliationTypes['ExternalEffectRevokeOptions'];

type ExternalEffectGrantInspection =
  ExternalEffectGrantReconciliationTypes['ExternalEffectGrantInspection'];

type StoreState = ExternalEffectGrantReconciliationTypes['StoreState'];

type TerminalRecord = ExternalEffectGrantReconciliationTypes['TerminalRecord'];

type ExternalEffectReconciliation =
  ExternalEffectGrantReconciliationTypes['ExternalEffectReconciliation'];

export function createExternalEffectGrantReconciliation({
  assertUuid,
  discoverRepository,
  externalEffectStorePaths,
  exactDate,
  readStoreState,
  validateEnvelopeForRepository,
  storedExternalEffectRefusalBinding,
  refusalAuditOptions,
  parseReconciliationRequest,
  loadTrustForPayload,
  createInteractiveSshSigner,
  assertTrustedSigner,
  redactTransactionToken,
  withRepositoryLifecycleOperation,
  inspectionFromState,
  createReconciliationRecord,
  emitAudit,
  auditInput,
  createPrivateFileAtomic,
  reconciliationPath,
  canonicalReconciliation,
  assertReason,
  terminalize,
}: ExternalEffectGrantReconciliationBindings) {
  /**
   * Resolve an already-terminal unknown dispatch from independently observed
   * evidence. This API deliberately has no runner or dispatch dependency: it
   * can record what the human observed, but it can never replay the effect.
   * Audit scope and task correlation come only from the signed grant envelope.
   */
  function reconcileExternalEffectGrant(
    cwd: string,
    requestedGrantId: string,
    requestedReconciliation: ExternalEffectReconciliationRequest,
    options: ExternalEffectTransitionOptions,
  ): ExternalEffectGrantPublicInspection {
    const grantId = assertUuid(requestedGrantId);
    const repository = discoverRepository(cwd);
    const paths = externalEffectStorePaths(repository.gitCommonDirectory);
    const now = exactDate(options.now ?? new Date());
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
    const now = exactDate(options.now ?? new Date());
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

  function assertManualReconciliationState(
    state: StoreState,
  ): asserts state is Extract<StoreState, { kind: 'terminal' }> & {
    record: TerminalRecord & {
      state: 'manual-reconciliation';
      transactionId: string;
    };
  } {
    if (
      state.kind !== 'terminal' ||
      state.record.state !== 'manual-reconciliation' ||
      state.record.transactionId === null
    ) {
      throw workflowError(
        'EXTERNAL_EFFECT_RECONCILIATION_NOT_REQUIRED',
        'Only a durable manual-reconciliation terminal may be resolved.',
        ExitCode.guard,
      );
    }
  }

  function assertReconciliationReplay(
    existing: ExternalEffectReconciliation,
    request: ExternalEffectReconciliationRequest,
    resolver: string,
  ): void {
    const observed = {
      outcome: existing.outcome,
      evidenceDigest: existing.evidenceDigest,
      externalReceiptId: existing.externalReceiptId,
      poststateDigest: existing.poststateDigest,
      observedAt: existing.observedAt,
      reason: existing.reason,
    };
    if (
      canonicalJson(observed) !== canonicalJson(request) ||
      existing.resolver !== resolver
    ) {
      throw workflowError(
        'EXTERNAL_EFFECT_RECONCILIATION_CONFLICT',
        'External effect reconciliation is already bound to different human evidence.',
        ExitCode.conflict,
      );
    }
  }

  return { reconcileExternalEffectGrant, revokeExternalEffectGrant };
}
