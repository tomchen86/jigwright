/**
 * Preflights and executes signed control-plane rollback recovery against
 * durable updater state.
 *
 * Invariants:
 * - A source transaction with reserved or completion-pending recovery
 *   authority cannot obtain a competing recovery Grant.
 */
// control plane updater recovery; repository effects remain bound by the public module.
import type {
  ControlPlaneUpdaterRecoveryBindings,
  ControlPlaneUpdaterRecoveryBindingsTypes,
} from './intervention-control-updater.ts';
type ControlPlaneRecoveryExecutorDependencies =
  ControlPlaneUpdaterRecoveryBindingsTypes['ControlPlaneRecoveryExecutorDependencies'];
type ControlPlaneRecoveryPreflight =
  ControlPlaneUpdaterRecoveryBindingsTypes['ControlPlaneRecoveryPreflight'];
type ControlPlaneRecoveryGrantEnvelope =
  ControlPlaneUpdaterRecoveryBindingsTypes['ControlPlaneRecoveryGrantEnvelope'];
type ControlPlaneRecoveryRollbackResult =
  ControlPlaneUpdaterRecoveryBindingsTypes['ControlPlaneRecoveryRollbackResult'];
type ControlPlanePromotionResult =
  ControlPlaneUpdaterRecoveryBindingsTypes['ControlPlanePromotionResult'];
type ControlPlaneRecoveryContext =
  ControlPlaneUpdaterRecoveryBindingsTypes['ControlPlaneRecoveryContext'];
type ControlPlaneRecoveryStateBinding =
  ControlPlaneUpdaterRecoveryBindingsTypes['ControlPlaneRecoveryStateBinding'];
type ControlPlaneRecoveryGrantPayload =
  ControlPlaneUpdaterRecoveryBindingsTypes['ControlPlaneRecoveryGrantPayload'];
type ControlPlaneRecoveryApprovalSummary =
  ControlPlaneUpdaterRecoveryBindingsTypes['ControlPlaneRecoveryApprovalSummary'];
declare const workflowError: ControlPlaneUpdaterRecoveryBindings['workflowError'];

export function createControlPlaneUpdaterRecovery(
  bindings: () => ControlPlaneUpdaterRecoveryBindings,
) {
  function preflightControlPlaneRecoveryRollback(
    storageRoot: string,
    sourceControlPlaneGrantId: string,
    input: { humanSigner: string; issuedAt: string },
    dependencies: ControlPlaneRecoveryExecutorDependencies,
  ): ControlPlaneRecoveryPreflight {
    const boundServices: ControlPlaneUpdaterRecoveryBindings = bindings();
    const {
      withUpdaterLock,
      requireRecoveryDependencies,
      updaterNow,
      exactDate,
      workflowError,
      ExitCode,
      throwControlPlaneRecoveryAlreadyConsumed,
      createControlPlaneRecoveryGrantPayload,
      deepFreeze,
    } = boundServices;

    return withUpdaterLock(
      storageRoot,
      `recovery-preflight:${sourceControlPlaneGrantId}`,
      () => {
        requireRecoveryDependencies(dependencies);
        const now = updaterNow(dependencies);
        const issuedAt = exactDate(
          new Date(input.issuedAt),
          'HARNESS_RECOVERY_GRANT_CLOCK_INVALID',
        ).toISOString();
        if (issuedAt !== now.toISOString()) {
          throw workflowError(
            'HARNESS_RECOVERY_GRANT_CLOCK_INVALID',
            'Recovery Grant issuance time must come from the sealed executor clock.',
            ExitCode.guard,
          );
        }
        const existing = dependencies.recoveryGrants.findForSource(
          storageRoot,
          sourceControlPlaneGrantId,
        );
        if (existing?.state === 'consumed') {
          throwControlPlaneRecoveryAlreadyConsumed();
        }
        if (existing?.state === 'failed') {
          throw recoveryRepairRequired();
        }
        if (
          existing?.state === 'reserved' ||
          existing?.state === 'completion-pending'
        ) {
          throw workflowError(
            'HARNESS_RECOVERY_GRANT_ALREADY_RESERVED',
            'An exact signed Recovery Grant is already active for this control-plane transaction.',
            ExitCode.conflict,
          );
        }
        const context = readControlPlaneRecoveryContext(
          storageRoot,
          sourceControlPlaneGrantId,
          dependencies,
        );
        assertInitialRecoveryContext(context);
        const payload = createControlPlaneRecoveryGrantPayload({
          ...recoveryStateBinding(context),
          issuedAt,
          humanSigner: input.humanSigner,
        });
        return deepFreeze({
          payload,
          summary: recoveryApprovalSummary(payload),
        });
      },
    );
  }

  function executeControlPlaneRecoveryRollback(
    storageRoot: string,
    envelope: ControlPlaneRecoveryGrantEnvelope,
    dependencies: ControlPlaneRecoveryExecutorDependencies,
  ): ControlPlaneRecoveryRollbackResult {
    const boundServices: ControlPlaneUpdaterRecoveryBindings = bindings();
    const {
      isRecord,
      withUpdaterLock,
      requireRecoveryDependencies,
      updaterNow,
      throwControlPlaneRecoveryAlreadyConsumed,
      workflowError,
      ExitCode,
      throwControlPlaneRecoveryFailed,
      canonicalJson,
      verifyControlPlaneRecoveryGrant,
      canonicalDigest,
      createControlPlaneRecoveryAuditRecord,
      driveControlPlanePromotion,
      createControlPlaneRecoveryFailure,
      workflowFailureCode,
      laterIso,
      createControlPlaneRecoveryReceipt,
      deepFreeze,
    } = boundServices;

    const requestedSourceGrantId =
      isRecord(envelope) && isRecord(envelope.payload)
        ? envelope.payload.sourceControlPlaneGrantId
        : null;
    return withUpdaterLock(
      storageRoot,
      `recovery-execute:${
        typeof requestedSourceGrantId === 'string'
          ? requestedSourceGrantId
          : 'invalid'
      }`,
      () => {
        requireRecoveryDependencies(dependencies);
        const now = updaterNow(dependencies);
        const existing =
          typeof requestedSourceGrantId === 'string'
            ? dependencies.recoveryGrants.findForSource(
                storageRoot,
                requestedSourceGrantId,
              )
            : null;
        if (existing?.state === 'consumed') {
          throwControlPlaneRecoveryAlreadyConsumed();
        }
        const requestedRecoveryGrantId =
          isRecord(envelope) && isRecord(envelope.payload)
            ? envelope.payload.grantId
            : null;
        if (
          existing?.state === 'expired' &&
          existing.envelope.payload.grantId === requestedRecoveryGrantId
        ) {
          throw workflowError(
            'HARNESS_RECOVERY_GRANT_EXPIRED',
            'Recovery Grant is an expired one-shot tombstone.',
            ExitCode.staleState,
          );
        }
        if (
          existing?.state === 'failed' &&
          existing.envelope.payload.grantId === requestedRecoveryGrantId
        ) {
          throwControlPlaneRecoveryFailed();
        }
        const pending =
          existing?.state === 'reserved' ||
          existing?.state === 'completion-pending'
            ? existing
            : null;
        if (
          pending !== null &&
          canonicalJson(pending.envelope) !== canonicalJson(envelope)
        ) {
          throw workflowError(
            'HARNESS_RECOVERY_GRANT_RESERVATION_MISMATCH',
            'Reserved Recovery Grant bytes differ from the requested envelope.',
            ExitCode.verification,
          );
        }

        // Signature and schema are always revalidated. Expiry is completion-
        // obligatory only after this exact reservation has begun a rollback.
        const payload = verifyControlPlaneRecoveryGrant(envelope, {
          now: new Date(
            isRecord(envelope) && isRecord(envelope.payload)
              ? String(envelope.payload.issuedAt)
              : Number.NaN,
          ),
          verifyHumanSignature: dependencies.verifyHumanSignature,
          enforceLive: false,
        });
        const context = readControlPlaneRecoveryContext(
          storageRoot,
          payload.sourceControlPlaneGrantId,
          dependencies,
        );
        const exactPrestate = recoveryContextMatchesPayload(context, payload);
        const envelopeDigest = canonicalDigest(envelope);
        if (
          pending?.state === 'reserved' &&
          exactPrestate &&
          now.getTime() >= Date.parse(payload.expiresAt)
        ) {
          const terminalExpiredAt = payload.expiresAt;
          dependencies.recoveryAuditSink.append(
            createControlPlaneRecoveryAuditRecord({
              payload,
              envelopeDigest,
              event: 'authorized',
              poststateDigest: null,
              receiptDigest: null,
              recordedAt: pending.createdAt,
            }),
          );
          dependencies.recoveryAuditSink.append(
            createControlPlaneRecoveryAuditRecord({
              payload,
              envelopeDigest,
              event: 'expired',
              poststateDigest: null,
              receiptDigest: null,
              recordedAt: terminalExpiredAt,
            }),
          );
          dependencies.recoveryGrants.expire(storageRoot, {
            recoveryGrantId: payload.grantId,
            expectedRecordDigest: pending.recordDigest,
            expiredAt: terminalExpiredAt,
          });
          throw workflowError(
            'HARNESS_RECOVERY_GRANT_EXPIRED',
            'Recovery Grant expired before any rollback effect and was terminalized.',
            ExitCode.staleState,
          );
        }
        if (pending === null || exactPrestate) {
          verifyControlPlaneRecoveryGrant(envelope, {
            now,
            verifyHumanSignature: dependencies.verifyHumanSignature,
          });
        } else if (!isRecoveryCompletionContext(context, payload)) {
          throw recoveryStateBindingMismatch();
        }
        if (pending === null && !exactPrestate) {
          throw recoveryStateBindingMismatch();
        }

        const reservation =
          pending ??
          dependencies.recoveryGrants.reserve(
            storageRoot,
            envelope,
            now.toISOString(),
          );
        dependencies.recoveryAuditSink.append(
          createControlPlaneRecoveryAuditRecord({
            payload,
            envelopeDigest,
            event: 'authorized',
            poststateDigest: null,
            receiptDigest: null,
            recordedAt: reservation.createdAt,
          }),
        );

        const rollbackEffectPerformed =
          context.record.transaction.state !== 'ROLLED_BACK';
        let result: ControlPlanePromotionResult;
        try {
          result = driveControlPlanePromotion(
            storageRoot,
            payload.sourceControlPlaneGrantId,
            dependencies,
          );
        } catch (error) {
          const failedContext = readControlPlaneRecoveryContext(
            storageRoot,
            payload.sourceControlPlaneGrantId,
            dependencies,
          );
          if (isRollbackSelectedForRecoveryFailure(failedContext, payload)) {
            const failure = createControlPlaneRecoveryFailure({
              payload,
              errorCode: workflowFailureCode(error),
              selectedClosureDigest:
                failedContext.supervisor.activeArtifact.closureDigest,
              selectedArtifactId:
                failedContext.supervisor.activeArtifact.artifactId,
              supervisorStateDigest: failedContext.supervisor.recordDigest,
              supervisorGeneration: failedContext.supervisor.generation,
              controlPlaneJournalDigest:
                failedContext.record.transaction.journalDigest,
              failedAt: laterIso(
                failedContext.record.updatedAt,
                failedContext.supervisor.updatedAt,
              ),
            });
            dependencies.recoveryGrants.fail(storageRoot, {
              recoveryGrantId: payload.grantId,
              expectedRecordDigest: reservation.recordDigest,
              failure,
            });
            dependencies.recoveryAuditSink.append(
              createControlPlaneRecoveryAuditRecord({
                payload,
                envelopeDigest,
                event: 'failed',
                poststateDigest: failure.failureDigest,
                receiptDigest: null,
                recordedAt: failure.failedAt,
              }),
            );
          }
          throw error;
        }
        if (
          result.record.transaction.state !== 'ROLLED_BACK' ||
          result.supervisor.activeArtifact.closureDigest !==
            payload.previousClosureDigest
        ) {
          throw workflowError(
            'HARNESS_RECOVERY_ROLLBACK_INCOMPLETE',
            'Recovery executor did not restore the exact previous trusted closure.',
            ExitCode.verification,
          );
        }
        const poststateDigest = canonicalDigest({
          kind: 'control-plane-recovery-poststate.v1',
          controlPlaneUpdateRecordDigest: result.record.recordDigest,
          controlPlaneJournalDigest: result.record.transaction.journalDigest,
          supervisorStateDigest: result.supervisor.recordDigest,
          supervisorGeneration: result.supervisor.generation,
          selectedClosureDigest: result.supervisor.activeArtifact.closureDigest,
          selectedArtifactId: result.supervisor.activeArtifact.artifactId,
        });
        const completedAt = laterIso(
          result.record.updatedAt,
          result.supervisor.updatedAt,
        );
        const receipt = createControlPlaneRecoveryReceipt({
          payload,
          poststateDigest,
          controlPlaneJournalDigestAfter:
            result.record.transaction.journalDigest,
          supervisorStateDigestAfter: result.supervisor.recordDigest,
          completedAt,
        });
        dependencies.recoveryAuditSink.append(
          createControlPlaneRecoveryAuditRecord({
            payload,
            envelopeDigest,
            event: 'rolled-back',
            poststateDigest,
            receiptDigest: receipt.receiptDigest,
            recordedAt: completedAt,
          }),
        );
        const preparedConsumption =
          dependencies.recoveryGrants.prepareConsumption(storageRoot, {
            recoveryGrantId: payload.grantId,
            expectedRecordDigest: reservation.recordDigest,
            receipt,
          });
        // The terminal external audit is emitted only after a durable local
        // completion receipt has made the authority one-shot and resumable.
        dependencies.recoveryAuditSink.append(
          createControlPlaneRecoveryAuditRecord({
            payload,
            envelopeDigest,
            event: 'consumed',
            poststateDigest,
            receiptDigest: receipt.receiptDigest,
            recordedAt: completedAt,
          }),
        );
        const consumed = dependencies.recoveryGrants.consume(storageRoot, {
          recoveryGrantId: payload.grantId,
          expectedRecordDigest: preparedConsumption.recordDigest,
        });
        return deepFreeze({
          kind: 'control-plane-recovery-rollback-result.v1' as const,
          action: 'rollback-control-plane' as const,
          sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
          recoveryGrantId: payload.grantId,
          record: consumed,
          receipt,
          controlPlaneUpdate: result.record,
          supervisor: result.supervisor,
          effectsPerformed: rollbackEffectPerformed,
        });
      },
    );
  }

  function readControlPlaneRecoveryContext(
    storageRoot: string,
    sourceControlPlaneGrantId: string,
    dependencies: ControlPlaneRecoveryExecutorDependencies,
  ): ControlPlaneRecoveryContext {
    const boundServices: ControlPlaneUpdaterRecoveryBindings = bindings();
    const {
      ensureUpdaterDirectories,
      readPersistedControlPlaneUpdate,
      readPromotionBundle,
      verifyPersistedPromotion,
      readControlPlaneSupervisorState,
    } = boundServices;

    const paths = ensureUpdaterDirectories(storageRoot);
    const record = readPersistedControlPlaneUpdate(
      storageRoot,
      sourceControlPlaneGrantId,
    );
    const bundle = readPromotionBundle(paths, sourceControlPlaneGrantId);
    verifyPersistedPromotion(record, bundle, dependencies);
    const supervisor = readControlPlaneSupervisorState(storageRoot);
    if (
      record.envelope.payload.grantId !== sourceControlPlaneGrantId ||
      record.transaction.grantId !== sourceControlPlaneGrantId ||
      record.transaction.txId !== supervisor.transition?.txId ||
      supervisor.transition.grantId !== sourceControlPlaneGrantId ||
      supervisor.repositoryId !== bundle.repositoryId ||
      record.transaction.beforeClosureDigest !== bundle.beforeClosureDigest ||
      record.transaction.afterClosureDigest !== bundle.afterClosureDigest ||
      record.transaction.recoveryBundleDigest !==
        bundle.recoveryBundle.bundleDigest
    ) {
      throw recoveryStateBindingMismatch();
    }
    return { record, bundle, supervisor };
  }

  function assertInitialRecoveryContext(
    context: ControlPlaneRecoveryContext,
  ): void {
    const boundServices: ControlPlaneUpdaterRecoveryBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    const { record, bundle, supervisor } = context;
    if (
      record.grantState !== 'reserved' ||
      !['RECOVERY_VERIFIED', 'SWITCHED', 'ROLLBACK_REQUIRED'].includes(
        record.transaction.state,
      ) ||
      supervisor.transition?.phase !== 'candidate-selected' ||
      supervisor.activeArtifact.artifactId !==
        bundle.candidateArtifact.artifactId ||
      supervisor.activeArtifact.executableDigest !==
        bundle.candidateArtifact.executableDigest ||
      supervisor.activeArtifact.closureDigest !== bundle.afterClosureDigest
    ) {
      throw workflowError(
        'HARNESS_RECOVERY_ROLLBACK_NOT_REQUIRED',
        'Recovery Grant requires the exact broken candidate closure to be selected by an incomplete control-plane transaction.',
        ExitCode.conflict,
      );
    }
  }

  function recoveryStateBinding(
    context: ControlPlaneRecoveryContext,
  ): ControlPlaneRecoveryStateBinding {
    const { record, bundle, supervisor } = context;
    assertInitialRecoveryContext(context);
    return {
      repositoryId: bundle.repositoryId,
      sourceControlPlaneGrantId: record.envelope.payload.grantId,
      previousClosureDigest: bundle.beforeClosureDigest,
      currentClosureDigest: bundle.afterClosureDigest,
      promotionBundleDigest: bundle.bundleDigest,
      recoveryBundleDigest: bundle.recoveryBundle.bundleDigest,
      controlPlaneUpdateRecordDigest: record.recordDigest,
      controlPlaneJournalDigest: record.transaction.journalDigest,
      sourceTransactionState: record.transaction
        .state as ControlPlaneRecoveryStateBinding['sourceTransactionState'],
      supervisorStateDigest: supervisor.recordDigest,
      supervisorGeneration: supervisor.generation,
      externalAuditRoot:
        record.envelope.payload.mandateBinding.externalAuditRoot,
    };
  }

  function recoveryContextMatchesPayload(
    context: ControlPlaneRecoveryContext,
    payload: ControlPlaneRecoveryGrantPayload,
  ): boolean {
    const boundServices: ControlPlaneUpdaterRecoveryBindings = bindings();
    const { canonicalJson } = boundServices;

    try {
      return (
        canonicalJson(recoveryStateBinding(context)) ===
        canonicalJson(recoveryBindingFromPayload(payload))
      );
    } catch {
      return false;
    }
  }

  function isRecoveryCompletionContext(
    context: ControlPlaneRecoveryContext,
    payload: ControlPlaneRecoveryGrantPayload,
  ): boolean {
    const { record, bundle, supervisor } = context;
    const stableIdentity =
      bundle.repositoryId === payload.repositoryId &&
      record.envelope.payload.grantId === payload.sourceControlPlaneGrantId &&
      bundle.beforeClosureDigest === payload.previousClosureDigest &&
      bundle.afterClosureDigest === payload.currentClosureDigest &&
      bundle.bundleDigest === payload.promotionBundleDigest &&
      bundle.recoveryBundle.bundleDigest === payload.recoveryBundleDigest &&
      record.envelope.payload.mandateBinding.externalAuditRoot ===
        payload.externalAuditRoot;
    if (!stableIdentity) return false;
    const state = record.transaction.state;
    const candidateSelected =
      ['SWITCHED', 'ROLLBACK_REQUIRED'].includes(state) &&
      record.grantState === 'reserved' &&
      supervisor.transition?.phase === 'candidate-selected' &&
      supervisor.activeArtifact.artifactId ===
        bundle.candidateArtifact.artifactId &&
      supervisor.activeArtifact.closureDigest ===
        payload.currentClosureDigest &&
      supervisor.generation === payload.supervisorGeneration;
    const rollbackSelected =
      ['ROLLBACK_REQUIRED', 'ROLLED_BACK'].includes(state) &&
      supervisor.transition?.phase === 'rollback-restored' &&
      supervisor.activeArtifact.artifactId ===
        bundle.recoveryBundle.restartArtifact.artifactId &&
      supervisor.activeArtifact.closureDigest ===
        payload.previousClosureDigest &&
      supervisor.generation === payload.supervisorGeneration + 1 &&
      (state === 'ROLLED_BACK') === (record.grantState === 'consumed');
    return candidateSelected || rollbackSelected;
  }

  function isRollbackSelectedForRecoveryFailure(
    context: ControlPlaneRecoveryContext,
    payload: ControlPlaneRecoveryGrantPayload,
  ): boolean {
    return (
      isRecoveryCompletionContext(context, payload) &&
      context.record.transaction.state === 'ROLLBACK_REQUIRED' &&
      context.record.grantState === 'reserved' &&
      context.supervisor.transition?.phase === 'rollback-restored' &&
      context.supervisor.activeArtifact.artifactId ===
        context.bundle.recoveryBundle.restartArtifact.artifactId &&
      context.supervisor.activeArtifact.closureDigest ===
        payload.previousClosureDigest
    );
  }

  function recoveryBindingFromPayload(
    payload: ControlPlaneRecoveryGrantPayload,
  ): ControlPlaneRecoveryStateBinding {
    return {
      repositoryId: payload.repositoryId,
      sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
      previousClosureDigest: payload.previousClosureDigest,
      currentClosureDigest: payload.currentClosureDigest,
      promotionBundleDigest: payload.promotionBundleDigest,
      recoveryBundleDigest: payload.recoveryBundleDigest,
      controlPlaneUpdateRecordDigest: payload.controlPlaneUpdateRecordDigest,
      controlPlaneJournalDigest: payload.controlPlaneJournalDigest,
      sourceTransactionState: payload.sourceTransactionState,
      supervisorStateDigest: payload.supervisorStateDigest,
      supervisorGeneration: payload.supervisorGeneration,
      externalAuditRoot: payload.externalAuditRoot,
    };
  }

  function recoveryApprovalSummary(
    payload: ControlPlaneRecoveryGrantPayload,
  ): ControlPlaneRecoveryApprovalSummary {
    const boundServices: ControlPlaneUpdaterRecoveryBindings = bindings();
    const { deepFreeze, canonicalDigest } = boundServices;

    return deepFreeze({
      kind: 'control-plane-recovery-approval-summary.v1',
      recoveryGrantId: payload.grantId,
      sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
      repositoryId: payload.repositoryId,
      operation: payload.operation,
      previousClosureDigest: payload.previousClosureDigest,
      currentClosureDigest: payload.currentClosureDigest,
      promotionBundleDigest: payload.promotionBundleDigest,
      recoveryBundleDigest: payload.recoveryBundleDigest,
      controlPlaneUpdateRecordDigest: payload.controlPlaneUpdateRecordDigest,
      controlPlaneJournalDigest: payload.controlPlaneJournalDigest,
      supervisorStateDigest: payload.supervisorStateDigest,
      supervisorGeneration: payload.supervisorGeneration,
      sourceTransactionState: payload.sourceTransactionState,
      externalAuditRoot: payload.externalAuditRoot,
      humanSigner: payload.humanSigner,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      approvalDigest: canonicalDigest(payload),
      humanReadable: [
        'Recovery operation: rollback-control-plane',
        `Recovery Grant: ${payload.grantId}`,
        `Repository: ${payload.repositoryId}`,
        `Source Control-Plane Grant: ${payload.sourceControlPlaneGrantId}`,
        `Source transaction state: ${payload.sourceTransactionState}`,
        `Current closure: ${payload.currentClosureDigest}`,
        `Restore closure: ${payload.previousClosureDigest}`,
        `Promotion bundle: ${payload.promotionBundleDigest}`,
        `Update record: ${payload.controlPlaneUpdateRecordDigest}`,
        `Update journal: ${payload.controlPlaneJournalDigest}`,
        `Supervisor state: ${payload.supervisorStateDigest} (generation ${payload.supervisorGeneration})`,
        `Recovery bundle: ${payload.recoveryBundleDigest}`,
        `External audit root: ${payload.externalAuditRoot}`,
        `Human signer: ${payload.humanSigner}`,
        `Approval digest: ${canonicalDigest(payload)}`,
        `Expires: ${payload.expiresAt}`,
      ].join('\n'),
    });
  }

  function recoveryStateBindingMismatch(): ReturnType<typeof workflowError> {
    const boundServices: ControlPlaneUpdaterRecoveryBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    return workflowError(
      'HARNESS_RECOVERY_STATE_BINDING_MISMATCH',
      'Recovery Grant no longer matches the exact control-plane journal, supervisor generation, and closure selection.',
      ExitCode.staleState,
    );
  }

  function recoveryRepairRequired(): ReturnType<typeof workflowError> {
    const boundServices: ControlPlaneUpdaterRecoveryBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    return workflowError(
      'HARNESS_RECOVERY_REPAIR_REQUIRED',
      'The immutable restart bundle failed verification; issue a distinct exact recovery operation instead of replaying this Grant.',
      ExitCode.conflict,
    );
  }
  return {
    preflightControlPlaneRecoveryRollback,
    executeControlPlaneRecoveryRollback,
  };
}
