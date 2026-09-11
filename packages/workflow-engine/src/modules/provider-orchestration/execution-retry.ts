/**
 * Decides retry eligibility, budget grants, and projected execution failure
 * state.
 *
 * Invariants:
 * - Retry guards retain their defined order and first applicable reason
 *   code.
 */
import type { GrantRequest } from '../authority/execution-governance.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode } from '../../foundation/errors/errors.ts';
import type {
  WorkflowRecord,
  JobRecord,
  AttemptRecord,
  FailureDescriptor,
  ExecutionPolicySnapshot,
  RetryDecision,
  ExecutionFailureStateProjection,
  JobStatus,
  WorkflowBlocker,
  RetryMode,
} from './execution-record-types.ts';
import {
  assertWorkflowRecord,
  assertJobRecord,
  assertAttemptRecord,
  assertFailureDescriptor,
  requireExecutionJobMandateBinding,
  assertExecutionPolicy,
} from './execution-records.ts';
import {
  assertTimestamp,
  executionInvalid,
  deepFreeze,
  RETRY_MODES,
  digestCanonical,
  isPlainObject,
  hasExactKeys,
  assertIdentifier,
  assertPositiveInteger,
  assertExecutionJobMandateBinding,
  assertJsonPointer,
  assertBoundedString,
  assertBoundedPositiveInteger,
  executionError,
  assertNonnegativeInteger,
} from './execution-values.ts';

export function decideRetry(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  failure: FailureDescriptor;
  sameFingerprintCount: number;
  boundedGrantRequest?: GrantRequest;
  currentExecutionPolicy?: ExecutionPolicySnapshot;
  providerAttemptCount?: number;
  nextRuntimeMs?: number;
  nextProviderCostMicros?: number;
  nextProviderTokens?: number;
  now?: string;
}): RetryDecision {
  const workflow = assertWorkflowRecord(input.workflow);
  const job = assertJobRecord(input.job);
  const attempt = assertAttemptRecord(input.attempt);
  const failure = assertFailureDescriptor(input.failure);
  const now = assertTimestamp(input.now ?? new Date().toISOString());
  if (
    !Number.isSafeInteger(input.sameFingerprintCount) ||
    input.sameFingerprintCount < 1
  ) {
    throw executionInvalid('sameFingerprintCount must be a positive integer.');
  }

  // The order below is normative. Do not combine these guards: callers depend
  // on the first stable reason code that applies.
  if (workflow.status === 'cancelled' || job.status === 'cancelled') {
    return noRetry('WORKFLOW_CANCELLED');
  }
  if (workflow.status !== 'active') {
    return noRetry('WORKFLOW_NOT_ACTIVE');
  }
  if (
    workflow.currentEpoch !== job.epoch ||
    workflow.currentEpoch !== attempt.epoch ||
    workflow.contextDigest !== job.contextDigest ||
    workflow.contextDigest !== attempt.contextDigest
  ) {
    return {
      retryable: true,
      automatic: false,
      retryMode: 'new-context',
      reasonCode: 'STALE_EPOCH',
    };
  }
  if (failure.sideEffectState === 'unknown') {
    return noRetry('MANUAL_RECONCILIATION_REQUIRED');
  }
  if (failure.source === 'state' || failure.code === 'STATE_CORRUPTION') {
    return noRetry('STATE_CORRUPTION');
  }
  if (job.acceptedAttemptId !== null) {
    return noRetry('JOB_RESULT_ALREADY_ACCEPTED');
  }
  // Repeated failures are informational; terminal failures still cannot retry.
  if (failure.retryClass === 'terminal') {
    return noRetry(failure.code);
  }
  const requiredStrategyReason =
    failure.code === 'PROVIDER_TOOL_UNAVAILABLE'
      ? 'PROVIDER_TOOL_CONFIGURATION_REQUIRED'
      : failure.code === 'PROVIDER_OUTPUT_LIMIT_EXCEEDED' ||
          failure.code === 'PROVIDER_STDOUT_TRUNCATED'
        ? 'PROVIDER_OUTPUT_CONTEXT_REDUCTION_REQUIRED'
        : null;
  if (requiredStrategyReason !== null) {
    return deepFreeze({
      retryable: true,
      automatic: false,
      retryMode: 'strategy-change',
      changedStrategyRequired: true,
      reasonCode: requiredStrategyReason,
    });
  }
  const grant =
    input.boundedGrantRequest === undefined
      ? undefined
      : assertExecutionBudgetGrantRequest(input.boundedGrantRequest, job);
  const withinBudget =
    executionRetryBudgetChanges({
      job,
      attempt,
      failure,
      providerAttemptCount: input.providerAttemptCount,
      nextRuntimeMs: input.nextRuntimeMs,
      nextProviderCostMicros: input.nextProviderCostMicros,
      nextProviderTokens: input.nextProviderTokens,
      now,
    }).length === 0;
  if (withinBudget) {
    const retryMode = inferRetryMode(
      failure,
      attempt,
      input.currentExecutionPolicy,
    );
    const decision: RetryDecision = {
      retryable: true,
      automatic: true,
      retryMode,
      reasonCode:
        input.sameFingerprintCount >= job.retryPolicy.maxSameFailureFingerprint
          ? 'REPEATED_FAILURE_WARNING'
          : failure.code,
    };
    if (failure.retryAfterMs !== null) {
      decision.retryAfterMs = failure.retryAfterMs;
    }
    return deepFreeze(decision);
  }
  if (grant !== undefined) {
    return grantDecision(grant, 'EXECUTION_GRANT_REQUIRED');
  }
  return noRetry('RETRY_BUDGET_EXHAUSTED');
}

/**
 * Project an already-decided durable failure into the exact Job wait state and
 * Workflow blocker. This is deliberately exhaustive for grant, semantic-input,
 * and unknown-side-effect outcomes; no generic suspended state exists.
 */
export function projectExecutionFailureState(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  failure: FailureDescriptor;
  decision: RetryDecision;
}): ExecutionFailureStateProjection {
  const workflow = assertWorkflowRecord(input.workflow);
  const job = assertJobRecord(input.job);
  const attempt = assertAttemptRecord(input.attempt);
  const failure = assertFailureDescriptor(input.failure);
  const decision = input.decision;
  if (
    attempt.jobId !== job.jobId ||
    attempt.workflowId !== workflow.workflowId ||
    attempt.epoch !== job.epoch ||
    attempt.contextDigest !== job.contextDigest ||
    attempt.failureFingerprint !== failure.fingerprint ||
    typeof decision.retryable !== 'boolean' ||
    typeof decision.automatic !== 'boolean' ||
    !RETRY_MODES.has(decision.retryMode) ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(decision.reasonCode)
  ) {
    throw executionInvalid('Failure state projection is inconsistent.');
  }

  let status: JobStatus;
  let blocker: WorkflowBlocker | null;
  if (
    job.status === 'cancelled' &&
    attempt.status === 'cancelled' &&
    decision.reasonCode === 'WORKFLOW_CANCELLED'
  ) {
    status = 'cancelled';
    blocker = null;
  } else if (decision.requiredGrant !== undefined) {
    if (
      decision.requiredGrant.workflowId !== workflow.workflowId ||
      decision.requiredGrant.epoch !== job.epoch ||
      decision.requiredGrant.jobId !== job.jobId
    ) {
      throw executionInvalid('Failure grant projection is stale.');
    }
    status = 'waiting-grant';
    blocker = {
      kind: 'human-grant',
      since: failure.observedAt,
      jobId: job.jobId,
      detailsDigest: digestCanonical(decision.requiredGrant),
    };
  } else if (
    failure.code === 'NEEDS_USER_DECISION' ||
    decision.reasonCode === 'NEEDS_USER_DECISION'
  ) {
    status = 'waiting-human-input';
    blocker = {
      kind: 'human-input',
      since: failure.observedAt,
      jobId: job.jobId,
      detailsDigest: failure.fingerprint,
    };
  } else if (
    failure.sideEffectState === 'unknown' ||
    decision.reasonCode === 'MANUAL_RECONCILIATION_REQUIRED'
  ) {
    status = 'failed-terminal';
    blocker = {
      kind: 'manual-reconciliation',
      since: failure.observedAt,
      jobId: job.jobId,
      detailsDigest: failure.fingerprint,
    };
  } else if (
    decision.retryable &&
    !decision.automatic &&
    decision.retryMode === 'strategy-change' &&
    decision.changedStrategyRequired === true
  ) {
    status = 'waiting-retry';
    blocker = {
      kind: 'configuration',
      since: failure.observedAt,
      jobId: job.jobId,
      detailsDigest: failure.fingerprint,
    };
  } else if (decision.retryable && decision.automatic) {
    status = 'waiting-retry';
    if (failure.code === 'PROVIDER_RATE_LIMIT') {
      blocker = {
        kind: 'retry-delay',
        since: failure.observedAt,
        jobId: job.jobId,
        detailsDigest: failure.fingerprint,
        ...(failure.retryAfterMs === null
          ? {}
          : {
              retryAt: new Date(
                Date.parse(failure.observedAt) + failure.retryAfterMs,
              ).toISOString(),
            }),
      };
    } else if (
      failure.code === 'PROVIDER_CAPACITY' ||
      failure.code === 'PROVIDER_UNAVAILABLE'
    ) {
      blocker = {
        kind: 'provider-capacity',
        since: failure.observedAt,
        jobId: job.jobId,
        detailsDigest: failure.fingerprint,
      };
    } else {
      blocker = null;
    }
  } else {
    status = 'failed-terminal';
    blocker = null;
  }

  return deepFreeze({
    workflow: assertWorkflowRecord({ ...workflow, blocker }),
    job: assertJobRecord({
      ...job,
      status,
      updatedAt: new Date(
        Math.max(Date.parse(job.updatedAt), Date.parse(failure.observedAt)),
      ).toISOString(),
    }),
  });
}

function assertExecutionBudgetGrantRequest(
  value: unknown,
  job: JobRecord,
): GrantRequest {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'createdAt',
      'epoch',
      'expiresAfterAttempts',
      'jobId',
      'kind',
      'mandateBinding',
      'rationale',
      'requestId',
      'requestedChanges',
      'schemaVersion',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-budget-grant-request' ||
    !Array.isArray(value.requestedChanges) ||
    value.requestedChanges.length < 1 ||
    value.requestedChanges.length > 16
  ) {
    throw executionInvalid('Execution budget grant request is invalid.');
  }
  if (
    typeof value.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.requestId,
    )
  ) {
    throw executionInvalid('Execution budget grant requestId is invalid.');
  }
  assertIdentifier(value.workflowId, 'grant workflowId');
  assertPositiveInteger(value.epoch, 'grant epoch');
  assertIdentifier(value.jobId, 'grant jobId');
  const jobBinding = requireExecutionJobMandateBinding(job);
  const requestBinding = assertExecutionJobMandateBinding(value.mandateBinding);
  let previousChange = '';
  for (const change of value.requestedChanges) {
    if (
      !isPlainObject(change) ||
      !hasExactKeys(change, ['from', 'path', 'to'])
    ) {
      throw executionInvalid('Execution budget requested change is invalid.');
    }
    const pointer = assertJsonPointer(change.path, 'grant requested path');
    canonicalJson(change.from);
    canonicalJson(change.to);
    if (
      pointer <= previousChange ||
      canonicalJson(change.from) === canonicalJson(change.to)
    ) {
      throw executionInvalid(
        'Execution budget requested changes are not canonical.',
      );
    }
    previousChange = pointer;
  }
  assertBoundedString(value.rationale, 'grant rationale');
  assertBoundedPositiveInteger(
    value.expiresAfterAttempts,
    'grant expiresAfterAttempts',
    16,
  );
  assertTimestamp(value.createdAt);
  if (
    value.workflowId !== job.workflowId ||
    value.epoch !== job.epoch ||
    value.jobId !== job.jobId ||
    canonicalJson(requestBinding) !== canonicalJson(jobBinding)
  ) {
    throw executionError(
      'EXECUTION_GRANT_REQUEST_BINDING_INVALID',
      'The bounded GrantRequest is not bound to the Job.',
      ExitCode.guard,
    );
  }
  return deepFreeze(structuredClone(value) as GrantRequest);
}

/** Exact extra capacity needed for one next reservation; never edits policy. */
export function executionRetryBudgetChanges(input: {
  job: JobRecord;
  attempt: AttemptRecord;
  failure: FailureDescriptor;
  providerAttemptCount?: number;
  nextRuntimeMs?: number;
  nextProviderCostMicros?: number;
  nextProviderTokens?: number;
  now: string;
}): GrantRequest['requestedChanges'] {
  const { job, attempt, failure } = input;
  const providerLimit = job.retryPolicy.providerLimits[attempt.provider];
  const providerAttemptCount = input.providerAttemptCount ?? job.attemptCount;
  const nextRuntimeMs = input.nextRuntimeMs ?? attempt.policySnapshot.timeoutMs;
  const nextProviderCostMicros = input.nextProviderCostMicros ?? 0;
  const nextProviderTokens = input.nextProviderTokens ?? 0;
  for (const [value, label] of [
    [providerAttemptCount, 'providerAttemptCount'],
    [nextRuntimeMs, 'nextRuntimeMs'],
    [nextProviderCostMicros, 'nextProviderCostMicros'],
    [nextProviderTokens, 'nextProviderTokens'],
  ] as const) {
    assertNonnegativeInteger(value, label);
  }
  const changes: GrantRequest['requestedChanges'][number][] = [];
  const addCapacity = (path: string, limit: number, needed: number) => {
    if (needed > limit) changes.push({ path, from: limit, to: needed });
  };
  addCapacity(
    '/retryPolicy/maxAttempts',
    job.retryPolicy.maxAttempts,
    job.attemptCount + 1,
  );
  addCapacity(
    '/retryPolicy/maxCumulativeRuntimeMs',
    job.retryPolicy.maxCumulativeRuntimeMs,
    job.cumulativeRuntimeMs + nextRuntimeMs,
  );
  addCapacity(
    '/retryPolicy/maxProviderCostMicros',
    job.retryPolicy.maxProviderCostMicros,
    job.providerCostMicros + nextProviderCostMicros,
  );
  addCapacity(
    '/retryPolicy/maxProviderTokens',
    job.retryPolicy.maxProviderTokens,
    job.providerTokens + nextProviderTokens,
  );
  if (providerLimit !== undefined)
    addCapacity(
      `/retryPolicy/providerLimits/${attempt.provider}`,
      providerLimit,
      providerAttemptCount + 1,
    );
  if (failure.retryClass === 'repairable')
    addCapacity(
      '/retryPolicy/maxRepairAttempts',
      job.retryPolicy.maxRepairAttempts,
      job.repairAttemptCount + 1,
    );
  if (Date.parse(input.now) >= Date.parse(job.retryPolicy.deadline)) {
    changes.push({
      path: '/retryPolicy/deadline',
      from: job.retryPolicy.deadline,
      to: 'next-attempt-only',
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function inferRetryMode(
  failure: FailureDescriptor,
  attempt: AttemptRecord,
  currentPolicyInput?: ExecutionPolicySnapshot,
): Exclude<RetryMode, 'new-context' | 'none'> {
  if (failure.retryClass === 'repairable') return 'repair';
  if (currentPolicyInput !== undefined) {
    const currentPolicy = assertExecutionPolicy(currentPolicyInput);
    if (
      canonicalJson(currentPolicy) !== canonicalJson(attempt.policySnapshot)
    ) {
      return 'execution-policy-change';
    }
  }
  return 'same-input';
}

function noRetry(reasonCode: string): RetryDecision {
  return deepFreeze({
    retryable: false,
    automatic: false,
    retryMode: 'none',
    reasonCode,
  });
}

function grantDecision(
  requiredGrant: GrantRequest,
  reasonCode: string,
): RetryDecision {
  return deepFreeze({
    retryable: true,
    automatic: false,
    retryMode: 'none',
    requiredGrant,
    reasonCode,
  });
}
