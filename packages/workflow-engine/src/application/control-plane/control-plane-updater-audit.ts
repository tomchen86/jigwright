// control plane updater audit; repository effects remain bound by the public module.
import type {
  ControlPlaneUpdaterAuditBindings,
  ControlPlaneUpdaterAuditBindingsTypes,
} from './intervention-control-updater.ts';
type PersistedControlPlaneUpdateRecord =
  ControlPlaneUpdaterAuditBindingsTypes['PersistedControlPlaneUpdateRecord'];
type RuntimeControlPlanePromotionBundle =
  ControlPlaneUpdaterAuditBindingsTypes['RuntimeControlPlanePromotionBundle'];
type ControlPlaneUpdaterDependencies =
  ControlPlaneUpdaterAuditBindingsTypes['ControlPlaneUpdaterDependencies'];
type ControlPlaneUpdaterAuditRecord =
  ControlPlaneUpdaterAuditBindingsTypes['ControlPlaneUpdaterAuditRecord'];
type ControlPlaneTaskMandateBinding =
  ControlPlaneUpdaterAuditBindingsTypes['ControlPlaneTaskMandateBinding'];
type ControlPlaneUpdaterAuditEvent =
  ControlPlaneUpdaterAuditBindingsTypes['ControlPlaneUpdaterAuditEvent'];

export function createControlPlaneUpdaterAudit(
  bindings: () => ControlPlaneUpdaterAuditBindings,
) {
  function emitAuditHistory(
    record: PersistedControlPlaneUpdateRecord,
    bundle: RuntimeControlPlanePromotionBundle,
    dependencies: ControlPlaneUpdaterDependencies,
  ): void {
    const boundServices: ControlPlaneUpdaterAuditBindings = bindings();
    const { canonicalDigest } = boundServices;

    const prepared = createAuditRecord({
      repositoryId: bundle.repositoryId,
      ...controlPlaneAuditMandateFields(record.envelope.payload.mandateBinding),
      grantId: record.envelope.payload.grantId,
      txId: record.transaction.txId,
      grantEnvelopeDigest: canonicalDigest(record.envelope),
      promotionBundleDigest: bundle.bundleDigest,
      sequence: 0,
      event: 'prepared',
      fromState: 'PREPARED',
      toState: 'PREPARED',
      evidenceDigest: bundle.bundleDigest,
      recordedAt: record.createdAt,
    });
    dependencies.auditSink.append(prepared);
    for (const observation of record.observations) {
      dependencies.auditSink.append(
        createAuditRecord({
          repositoryId: bundle.repositoryId,
          ...controlPlaneAuditMandateFields(
            record.envelope.payload.mandateBinding,
          ),
          grantId: record.envelope.payload.grantId,
          txId: record.transaction.txId,
          grantEnvelopeDigest: canonicalDigest(record.envelope),
          promotionBundleDigest: bundle.bundleDigest,
          sequence: observation.sequence,
          event: auditEventForObservation(observation.eventKind),
          fromState: observation.fromState,
          toState: observation.toState,
          evidenceDigest: observation.evidenceDigest,
          recordedAt: observation.recordedAt,
        }),
      );
    }
  }

  function createAuditRecord(
    input: Omit<
      ControlPlaneUpdaterAuditRecord,
      'kind' | 'recordId' | 'recordDigest'
    >,
  ): ControlPlaneUpdaterAuditRecord {
    const boundServices: ControlPlaneUpdaterAuditBindings = bindings();
    const { canonicalDigest, deepFreeze } = boundServices;

    const identity = {
      kind: 'control-plane-updater-audit-id.v1' as const,
      repositoryId: input.repositoryId,
      mandateBinding: input.mandateBinding,
      grantId: input.grantId,
      txId: input.txId,
      sequence: input.sequence,
      event: input.event,
    };
    const payload = {
      kind: 'control-plane-updater-audit.v1' as const,
      recordId: canonicalDigest(identity),
      ...input,
    };
    return deepFreeze({ ...payload, recordDigest: canonicalDigest(payload) });
  }

  function controlPlaneAuditMandateFields(
    binding: ControlPlaneTaskMandateBinding,
  ): Pick<
    ControlPlaneUpdaterAuditRecord,
    'mandateBinding' | 'parentTaskId' | 'changeId' | 'externalAuditRoot'
  > {
    const boundServices: ControlPlaneUpdaterAuditBindings = bindings();
    const { normalizeControlPlaneTaskMandateBinding } = boundServices;

    const exact = normalizeControlPlaneTaskMandateBinding(binding);
    return {
      mandateBinding: exact,
      parentTaskId: exact.parentTaskId,
      changeId: exact.changeId,
      externalAuditRoot: exact.externalAuditRoot,
    };
  }

  function auditEventForObservation(
    event: string,
  ): ControlPlaneUpdaterAuditEvent {
    const boundServices: ControlPlaneUpdaterAuditBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    switch (event) {
      case 'old-closure-verified':
        return 'old-closure-verified';
      case 'candidate-verified':
        return 'candidate-verified';
      case 'recovery-bundle-verified':
        return 'recovery-verified';
      case 'atomic-switch-completed':
        return 'switched';
      case 'self-tests-passed':
        return 'self-tested';
      case 'self-tests-failed':
        return 'rollback-required';
      case 'finalize':
        return 'finalized';
      case 'rollback-completed':
        return 'rolled-back';
      default:
        throw workflowError(
          'CONTROL_PLANE_AUDIT_EVENT_INVALID',
          'Persisted updater observation has no audit event mapping.',
          ExitCode.verification,
        );
    }
  }
  return { emitAuditHistory };
}
