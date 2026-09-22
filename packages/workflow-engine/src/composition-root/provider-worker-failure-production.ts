/** Binds failure evidence recording to repair extraction and the exact journal claim. */
import {
  recordProviderWorkerFailure as recordFailure,
  type ProviderWorkerFailureObservation,
} from '../application/provider-worker/provider-failure-recording.ts';
import type { ProviderWorkerLeaseClaim } from '../modules/provider-orchestration/provider-invocation-lifecycle.ts';
import type { ProviderInvocationRecord } from '../modules/provider-orchestration/provider-invocation-record.ts';
import type { InvestigationRuntimePaths } from '../runtime/paths/runtime-paths.ts';
import { extractProviderRepairFailure } from '../runtime/storage-journal/provider-repair-governance.ts';
import {
  failProviderInvocation,
  failProviderInvocationForWorkerClaim,
} from '../runtime/storage-journal/provider-invocation-completion.ts';

export function recordProviderWorkerFailure(
  observation: ProviderWorkerFailureObservation,
  {
    runtime,
    invocationId,
    claim,
    usesWorkerFence,
  }: Readonly<{
    runtime: InvestigationRuntimePaths;
    invocationId: string;
    claim: ProviderWorkerLeaseClaim;
    usesWorkerFence: () => boolean;
  }>,
): ProviderInvocationRecord {
  return recordFailure(observation, claim, {
    extractRepairFailure: extractProviderRepairFailure,
    publishFailure(failureInput) {
      return usesWorkerFence()
        ? failProviderInvocationForWorkerClaim(runtime, invocationId, {
            ...failureInput,
            workerFenceToken: claim.workerFenceToken,
          })
        : failProviderInvocation(runtime, invocationId, failureInput);
    },
  });
}
