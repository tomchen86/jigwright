/** Routes failed invocations to their lifecycle owner before journaling a bounded retry. */
import { defaultProviderRetryExplanation } from '../../modules/provider-orchestration/provider-retry-explanation.ts';
import {
  type ExecutionFailureKind,
  projectProviderInvocationExecution,
} from '../../modules/provider-orchestration/execution-core.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import {
  type ProviderInvocationRequest,
  createProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type {
  ProviderInvocationRecord,
  ProviderInvocationFailure,
} from '../../modules/provider-orchestration/provider-invocation-record.ts';

import {
  exactTimestamp,
  deepFreeze,
  providerRetryScheduleUnsafe,
} from '../../modules/provider-orchestration/provider-retry-schedule.ts';
import type {
  ProviderFailureRetryPorts,
  ProviderRetryPublication,
  ProviderFailureRetryResult,
  ProcessProviderFailureRetryOptions,
} from '../../modules/provider-orchestration/provider-retry-service-port.ts';
import type { ConsumedRoleReplayPort } from '../../modules/provider-orchestration/role-admission-contracts.ts';

/**
 * Reconcile one durable failed invocation into its bounded next action. The
 * existing Survey/PlanReview lifecycle remains the publication authority for
 * replacement work; this service only adds a durable due-time/dispatch journal
 * around that exact transition.
 */
export function processProviderFailureRetry(
  ports: ProviderFailureRetryPorts,
  requestedInvocationId: string,
  options: ProcessProviderFailureRetryOptions = {},
): ProviderFailureRetryResult {
  const now = exactTimestamp(options.now ?? new Date().toISOString());
  const existing = ports.runtime.readSchedule(requestedInvocationId);
  if (existing !== null) {
    return ports.runtime.continueSchedule(existing, now, options.dispatcher);
  }

  const { failed, request: failedRequest } = ports.runtime.readFailure(
    requestedInvocationId,
  );
  const projection = projectProviderInvocationExecution({
    record: failed,
    request: failedRequest,
  });
  if (
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable'
  ) {
    return deepFreeze({
      kind: 'not-retryable' as const,
      jobId: projection.job.jobId,
      reasonCode: failed.failure?.code ?? 'PROVIDER_INVOCATION_NOT_RETRYABLE',
    });
  }
  // TaskDiffReview and task implementation are not owned by the
  // investigation/PlanReview retry state machine. Until their exact
  // WorkflowSession owner publishes a replacement, fail closed instead of
  // routing the invocation through `resumePropose`.
  if (
    failed.purpose === 'task-diff-review' ||
    failed.purpose === 'task-implementation'
  ) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode:
        failed.purpose === 'task-diff-review'
          ? 'TASK_DIFF_REVIEW_RETRY_OWNER_REQUIRED'
          : 'TASK_IMPLEMENTATION_RETRY_OWNER_REQUIRED',
    });
  }
  const strategyDecision = ports.inspectDecision(projection.job.jobId);
  if (
    strategyDecision?.retryable === true &&
    strategyDecision.automatic === false &&
    strategyDecision.retryMode === 'strategy-change' &&
    strategyDecision.changedStrategyRequired === true
  ) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode: strategyDecision.reasonCode,
    });
  }
  const executionKind = providerExecutionFailureKind(failed.failure);
  if (executionKind === null || executionKind === 'unknown-side-effect') {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode: failed.failure.code,
    });
  }
  if (executionKind === 'probe-transient') {
    return scheduleProbeRetry(ports, failed, projection.job.jobId, now);
  }
  if (!PROVIDER_REPLACEMENT_FAILURE_KINDS.has(executionKind)) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId: projection.job.jobId,
      reasonCode: failed.failure.code,
    });
  }

  let replacementInvocationId: string;
  try {
    replacementInvocationId = publishReplacement(
      ports.publication,
      failed,
      options.consumedRoleResultReplay,
    );
  } catch (error) {
    if (!isExpectedRetryDecisionError(error)) throw error;
    return decisionWithoutReplacement(ports, projection.job.jobId, error.code);
  }
  const schedule = ports.runtime.persistReplacement(
    failed,
    projection.job.jobId,
    replacementInvocationId,
    now,
  );
  return ports.runtime.continueSchedule(schedule, now, options.dispatcher);
}

const PROVIDER_REPLACEMENT_FAILURE_KINDS = new Set<ExecutionFailureKind>([
  'provider-timeout',
  'network',
  'rate-limit',
  'provider-process-crash',
  'worker-crash',
  'lease-expiry',
  'temporary-file-lock',
  'provider-capacity',
  'stdout-truncated',
  'process-nonzero',
  'json-parse',
  'schema-mismatch',
  'missing-required-field',
  'citation-out-of-range',
]);

function scheduleProbeRetry(
  ports: ProviderFailureRetryPorts,
  failed: ProviderInvocationRecord,
  jobId: string,
  now: string,
): ProviderFailureRetryResult {
  const probe = failed.failure?.probe;
  if (probe === undefined) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId,
      reasonCode: 'ENVIRONMENT_PROBE_REQUEST_MISSING',
    });
  }
  const decision = ports.inspectDecision(jobId);
  if (decision?.requiredGrant !== undefined) {
    return deepFreeze({
      kind: 'grant-required' as const,
      jobId,
      grantRequest: decision.requiredGrant,
    });
  }
  if (decision?.automatic !== true || decision.retryable !== true) {
    return deepFreeze({
      kind: 'decision-denied' as const,
      jobId,
      reasonCode: decision?.reasonCode ?? failed.failure!.code,
    });
  }
  const schedule = ports.runtime.persistProbe(
    failed,
    jobId,
    probe,
    failed.failure!.retryAfterMs ?? decision.retryAfterMs ?? 0,
    now,
  );
  return deepFreeze({ kind: 'probe-scheduled' as const, schedule });
}

export function publishReplacement(
  publication: ProviderRetryPublication,
  failed: ProviderInvocationRecord,
  consumedRoleResultReplay?: ConsumedRoleReplayPort,
): string {
  if (failed.purpose === 'survey') {
    const existing = publication.readSurveyReservation(failed);
    if (existing !== null) {
      if (existing.previousInvocationId !== failed.invocationId)
        throw providerRetryScheduleUnsafe();
      return existing.invocationId;
    }
    const input = publication.readSurveyInput(failed);
    const replacementRequest = replacementProviderRequest(
      input.request,
      input.policyDigest,
      input.limits,
      input.identity,
      failed.failure,
    );
    const retried = publication.publishSurvey(
      failed,
      input.revision,
      replacementRequest,
    );
    if (
      retried.invocationId !== replacementRequest.invocationId ||
      retried.attempt !== failed.attempt + 1
    )
      throw providerRetryScheduleUnsafe();
    return retried.invocationId;
  }
  const invocationId = publication.publishPlanReview(
    failed,
    consumedRoleResultReplay,
  );
  if (invocationId === undefined || invocationId === failed.invocationId)
    throw providerRetryScheduleUnsafe();
  return invocationId;
}

function replacementProviderRequest(
  failed: ProviderInvocationRequest,
  policyDigest: string,
  limits: { timeoutMs: number; aggregateOutputBytes: number },
  identity: string,
  failure: ProviderInvocationRecord['failure'],
): ProviderInvocationRequest {
  return createProviderInvocationRequest({
    invocationId: `invocation-auto-retry-${identity}`,
    nonce: `provider-auto-retry-${identity}`,
    purpose: failed.purpose,
    providerId: failed.providerId,
    roleAssignment: failed.roleAssignment,
    capabilityProfile: failed.capabilityProfile,
    repositoryId: failed.repositoryId,
    baseCommit: failed.baseCommit,
    baseTree: failed.baseTree,
    targetDigest: failed.targetDigest,
    inputManifestDigest: failed.inputManifestDigest,
    authorizationNodeId: failed.authorizationNodeId,
    writeAllowedPaths: [...failed.writeAllowedPaths],
    outputSchema: failed.outputSchema,
    evaluatorVersion: failed.evaluatorVersion,
    retryExplanation: defaultProviderRetryExplanation(failure),
    policyDigest,
    limits: {
      timeoutMs: limits.timeoutMs,
      aggregateOutputBytes: limits.aggregateOutputBytes,
    },
  });
}

function decisionWithoutReplacement(
  ports: ProviderFailureRetryPorts,
  jobId: string,
  fallbackReasonCode: string,
): ProviderFailureRetryResult {
  const decision = ports.inspectDecision(jobId);
  if (decision?.requiredGrant !== undefined) {
    return deepFreeze({
      kind: 'grant-required' as const,
      jobId,
      grantRequest: decision.requiredGrant,
    });
  }
  return deepFreeze({
    kind: 'decision-denied' as const,
    jobId,
    reasonCode: decision?.reasonCode ?? fallbackReasonCode,
  });
}

function providerExecutionFailureKind(
  failure: ProviderInvocationFailure,
): ExecutionFailureKind | null {
  if (failure.executionKind !== undefined) return failure.executionKind;
  const code = failure.code;
  if (code === 'PROVIDER_TIMEOUT') return 'provider-timeout';
  if (code === 'NETWORK_TRANSIENT') return 'network';
  if (code === 'PROVIDER_RATE_LIMIT') return 'rate-limit';
  if (code === 'PROVIDER_PROCESS_CRASH') return 'provider-process-crash';
  if (code === 'PROVIDER_INVOCATION_LEASE_EXPIRED') return 'lease-expiry';
  if (code === 'PROVIDER_NATIVE_OUTPUT_INVALID') return 'schema-mismatch';
  if (code === 'ENVIRONMENT_PROBE_TRANSIENT' && failure.probe !== undefined) {
    return 'probe-transient';
  }
  return null;
}

function isExpectedRetryDecisionError(error: unknown): error is WorkflowError {
  return (
    error instanceof WorkflowError &&
    new Set([
      'PROVIDER_RETRY_DECISION_DENIED',
      'PROVIDER_RETRY_GRANT_REQUIRED',
      'PROVIDER_RETRY_STRATEGY_CHANGE_REQUIRED',
      'PLAN_REVIEW_RETRY_DECISION_DENIED',
      'PLAN_REVIEW_RETRY_GRANT_REQUIRED',
      'PLAN_REVIEW_RETRY_STRATEGY_CHANGE_REQUIRED',
    ]).has(error.code)
  );
}
