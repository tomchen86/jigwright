/** Assembles one caught failure's evidence before its durable publication. */
import { classifyProviderInvocationFailure } from '../../modules/provider-orchestration/provider-invocation-failure.ts';
import { createAgentRuntimeHostExecutionBindingV1 } from '../../modules/provider-orchestration/agent-runtime-host-execution-binding.ts';
import type {
  AgentRuntimeAssignmentBindingV1,
  AgentRuntimeHostExecutionBindingV1,
  AgentRuntimeHostProbeEvidenceV1,
  AgentRuntimeProcessProgressProjection,
  ProviderInvocationAcceptanceBinding,
  ProviderRuntimeProtocolReceipt,
} from '../../modules/provider-orchestration/agent-runtime-port.ts';
import type {
  ProviderInvocationFailureInput,
  ProviderInvocationRecord,
  ProviderRepairFailureInput,
} from '../../modules/provider-orchestration/provider-invocation-record.ts';
import type { ProviderLeaseClaim } from '../../modules/provider-orchestration/provider-invocation-lifecycle.ts';

export type ProviderWorkerFailureObservation = Readonly<{
  error: unknown;
  targetSchema: unknown;
  acceptanceBinding: ProviderInvocationAcceptanceBinding | null;
  preparedHostAssignmentBinding: AgentRuntimeAssignmentBindingV1 | null;
  runtimeProgress?: () => AgentRuntimeProcessProgressProjection;
  runtimeFailureProtocolReceipt?: () => ProviderRuntimeProtocolReceipt | null;
  runtimeFailureHostProbeEvidence?: () => AgentRuntimeHostProbeEvidenceV1 | null;
  runtimeFailureHostExecutionBinding?: () => AgentRuntimeHostExecutionBindingV1 | null;
}>;

export function recordProviderWorkerFailure(
  {
    error,
    targetSchema,
    acceptanceBinding,
    preparedHostAssignmentBinding,
    runtimeProgress,
    runtimeFailureProtocolReceipt,
    runtimeFailureHostProbeEvidence,
    runtimeFailureHostExecutionBinding,
  }: ProviderWorkerFailureObservation,
  claim: ProviderLeaseClaim,
  {
    extractRepairFailure,
    publishFailure,
  }: Readonly<{
    extractRepairFailure: (
      error: unknown,
      targetSchema: unknown,
    ) => ProviderRepairFailureInput | null;
    publishFailure: (
      input: ProviderInvocationFailureInput,
    ) => ProviderInvocationRecord;
  }>,
): ProviderInvocationRecord {
  const failure = classifyProviderInvocationFailure(error);
  const repair = extractRepairFailure(error, targetSchema);
  const protocolReceipt = runtimeFailureProtocolReceipt?.() ?? null;
  const observedHostBinding = runtimeFailureHostExecutionBinding?.() ?? null;
  const hostExecutionBinding =
    observedHostBinding ??
    (preparedHostAssignmentBinding === null
      ? null
      : createAgentRuntimeHostExecutionBindingV1({
          assignmentBinding: preparedHostAssignmentBinding,
          probe: runtimeFailureHostProbeEvidence?.() ?? null,
          nativeSessionClaim: null,
          nativeSessionCompletionDigest: null,
        }));
  const failureInput = {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    failure,
    ...(runtimeProgress === undefined || acceptanceBinding === null
      ? {}
      : {
          runtimeEvidence: {
            acceptanceBinding,
            progress: runtimeProgress(),
            ...(protocolReceipt === null ? {} : { protocolReceipt }),
            ...(hostExecutionBinding === null ? {} : { hostExecutionBinding }),
          },
        }),
    ...(repair === null ? {} : { repair }),
  };
  return publishFailure(failureInput);
}
