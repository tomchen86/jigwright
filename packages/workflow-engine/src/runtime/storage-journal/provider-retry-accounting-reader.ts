/**
 * Collects validated durable Job and policy accounting for an explicit retry decision.
 *
 * Invariants:
 * - Source selection is checked before reading accounting; policy readers retain receipt inspection.
 * - Collection does not decide retry eligibility, charge an Attempt, or publish a reservation.
 */
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderRetryAccountingEvidence } from '../../modules/provider-orchestration/provider-retry-accounting.ts';
import { projectProviderInvocationExecution } from '../../modules/provider-orchestration/execution-core.ts';
import { assertProviderRetrySource } from '../../modules/provider-orchestration/provider-retry-decision.ts';
import { readExecutionJobState } from './execution-store.ts';
import { readProviderInvocationRequest } from './provider-invocation-artifacts.ts';
import { readProviderExecutionPolicySnapshot } from './provider-invocation-policy.ts';

export function readProviderRetryAccountingEvidence(
  paths: InvestigationRuntimePaths,
  failed: ProviderInvocationRecord,
  failedRequest: ProviderInvocationRequest,
): ProviderRetryAccountingEvidence {
  const projection = projectProviderInvocationExecution({
    record: failed,
    request: failedRequest,
  });
  const { state } = assertProviderRetrySource(
    readExecutionJobState(paths, projection.job.jobId),
    { failed, failedRequest },
  );
  return Object.freeze({
    state,
    invocations: Object.freeze(
      state.invocationProjection.invocations.map(({ invocationId }) => {
        const request = readProviderInvocationRequest(paths, invocationId);
        const { accounting } = readProviderExecutionPolicySnapshot(
          paths,
          request,
        );
        return Object.freeze({ invocationId, request, accounting });
      }),
    ),
  });
}
