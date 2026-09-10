/**
 * Creates execution jobs and attempts and applies lease and result
 * transitions.
 *
 * Invariants:
 * - A semantic job specification must bind its workflow contract, stage,
 *   and context.
 */
import type { TaskMandateBinding } from '../authority/task-mandate.ts';
import { ExitCode } from '../../foundation/errors/errors.ts';
import { createAttemptAcceptanceBindingV1 } from '@jigwright/core/job-attempt-runtime';
import type {
  WorkflowRecord,
  SemanticJobSpec,
  ExecutionPolicySnapshot,
  RetryPolicy,
  JobRecord,
  AttemptRecord,
  RetryMode,
  RepairContext,
  JsonValue,
  ChangedField,
  AttemptResult,
} from './execution-record-types.ts';
import {
  assertWorkflowRecord,
  assertSemanticJobSpec,
  assertExecutionPolicy,
  assertRetryPolicy,
  assertJobRecord,
  assertAttemptRecord,
  assertRepairContext,
  assertAttemptResult,
} from './execution-records.ts';
import {
  assertExecutionJobMandateBinding,
  executionError,
  assertIdentifier,
  assertDigest,
  assertTimestamp,
  executionInvalid,
  digestCanonical,
  deepFreeze,
  diffJson,
  normalizeUniqueStrings,
  digestText,
  constantTimeEqual,
} from './execution-values.ts';

export function createExecutionJob(input: {
  workflow: WorkflowRecord;
  mandateBinding: TaskMandateBinding;
  jobId: string;
  attemptId: string;
  stage: string;
  semanticSpec: SemanticJobSpec;
  executionPolicy: ExecutionPolicySnapshot;
  environmentDigest: string;
  retryPolicy: RetryPolicy;
  createdAt?: string;
}): { job: JobRecord; attempt: AttemptRecord } {
  const workflow = assertWorkflowRecord(input.workflow);
  const mandateBinding = assertExecutionJobMandateBinding(input.mandateBinding);
  if (workflow.status !== 'active') {
    throw executionError(
      'EXECUTION_WORKFLOW_NOT_ACTIVE',
      'A Job may only be created for an active Workflow.',
      ExitCode.guard,
    );
  }
  const jobId = assertIdentifier(input.jobId, 'jobId');
  const attemptId = assertIdentifier(input.attemptId, 'attemptId');
  const stage = assertIdentifier(input.stage, 'stage');
  const semanticSpec = assertSemanticJobSpec(input.semanticSpec);
  const executionPolicy = assertExecutionPolicy(input.executionPolicy);
  const environmentDigest = assertDigest(input.environmentDigest);
  const retryPolicy = assertRetryPolicy(input.retryPolicy);
  const createdAt = assertTimestamp(
    input.createdAt ?? new Date().toISOString(),
  );
  if (
    semanticSpec.contractVersion !== workflow.contractVersion ||
    semanticSpec.stage !== stage ||
    semanticSpec.contextDigest !== workflow.contextDigest
  ) {
    throw executionInvalid(
      'Semantic Job specification is not bound to its Workflow.',
    );
  }
  const semanticRequestDigest = digestCanonical({
    kind: 'semantic-job-spec',
    jobId,
    workflowId: workflow.workflowId,
    epoch: workflow.currentEpoch,
    mandateBinding,
    semanticSpec,
  });
  const attemptRequestDigest = composeAttemptRequestDigest({
    jobId,
    attemptNumber: 1,
    semanticSpec,
    executionPolicy,
    retryMode: 'none',
    repairContext: null,
    strategyChanges: [],
    grantId: null,
  });
  const job: JobRecord = {
    schemaVersion: 2,
    jobId,
    workflowId: workflow.workflowId,
    epoch: workflow.currentEpoch,
    mandateBinding,
    stage,
    contextDigest: workflow.contextDigest,
    requestDigest: semanticRequestDigest,
    semanticSpec,
    status: 'queued',
    acceptedAttemptId: null,
    attemptCount: 1,
    cumulativeRuntimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    repairAttemptCount: 0,
    retryPolicy,
    createdAt,
    updatedAt: createdAt,
  };
  const attempt: AttemptRecord = {
    schemaVersion: 2,
    attemptId,
    jobId,
    workflowId: workflow.workflowId,
    epoch: workflow.currentEpoch,
    attemptNumber: 1,
    retryOf: null,
    provider: executionPolicy.provider,
    status: 'created',
    inputDigest: semanticSpec.inputDigest,
    requestDigest: attemptRequestDigest,
    contextDigest: workflow.contextDigest,
    environmentDigest,
    retryMode: 'none',
    policySnapshot: executionPolicy,
    changedFields: [],
    repairContext: null,
    strategyChanges: [],
    grantId: null,
    failure: null,
    failureFingerprint: null,
    leaseGeneration: 0,
    lease: null,
    runtimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    retention: 'active',
    providerInvocation: null,
    createdAt,
    updatedAt: createdAt,
  };
  return deepFreeze({
    job: assertJobRecord(job),
    attempt: assertAttemptRecord(attempt),
  });
}

export function createReplacementAttempt(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  previousAttempt: AttemptRecord;
  attemptId: string;
  retryMode: Exclude<RetryMode, 'none' | 'new-context'>;
  currentExecutionPolicy: ExecutionPolicySnapshot;
  policyOverrides?: Partial<Omit<ExecutionPolicySnapshot, 'schemaVersion'>>;
  repairContext?: RepairContext;
  strategyChanges?: string[];
  grantId?: string;
  environmentDigest: string;
  createdAt?: string;
}): { job: JobRecord; attempt: AttemptRecord } {
  const workflow = assertWorkflowRecord(input.workflow);
  const job = assertJobRecord(input.job);
  const previous = assertAttemptRecord(input.previousAttempt);
  const createdAt = assertTimestamp(
    input.createdAt ?? new Date().toISOString(),
  );
  if (workflow.status !== 'active') {
    throw executionError(
      'EXECUTION_WORKFLOW_NOT_ACTIVE',
      'A replacement Attempt requires an active Workflow.',
      ExitCode.guard,
    );
  }
  if (
    job.workflowId !== workflow.workflowId ||
    job.epoch !== workflow.currentEpoch ||
    job.contextDigest !== workflow.contextDigest ||
    previous.jobId !== job.jobId ||
    previous.workflowId !== job.workflowId ||
    previous.epoch !== job.epoch ||
    previous.contextDigest !== job.contextDigest
  ) {
    throw executionError(
      'EXECUTION_CONTEXT_STALE',
      'The Job or previous Attempt is not in the current Workflow context.',
      ExitCode.staleState,
    );
  }
  if (job.acceptedAttemptId !== null || job.status === 'succeeded') {
    throw executionError(
      'JOB_RESULT_ALREADY_ACCEPTED',
      'A Job with an accepted result cannot create a replacement Attempt.',
      ExitCode.conflict,
    );
  }
  if (!['failed-retryable', 'timed-out'].includes(previous.status)) {
    throw executionError(
      'ATTEMPT_NOT_REPLACEABLE',
      'The previous Attempt is not in a replaceable terminal state.',
      ExitCode.guard,
    );
  }
  if (previous.failure === null) {
    throw executionError(
      'ATTEMPT_FAILURE_REQUIRED',
      'A replacement Attempt requires the previous FailureDescriptor.',
      ExitCode.guard,
    );
  }
  if (
    (input.retryMode === 'repair') !==
    (previous.failure.retryClass === 'repairable')
  ) {
    throw executionError(
      'RETRY_MODE_MISMATCH',
      'The retry mode does not match the previous failure classification.',
      ExitCode.guard,
    );
  }
  if (
    job.attemptCount >= job.retryPolicy.maxAttempts &&
    input.grantId === undefined
  ) {
    throw executionError(
      'RETRY_BUDGET_EXHAUSTED',
      'The Job attempt budget is exhausted.',
      ExitCode.guard,
    );
  }
  const attemptId = assertIdentifier(input.attemptId, 'attemptId');
  if (attemptId === previous.attemptId) {
    throw executionInvalid('A replacement Attempt must have a new identity.');
  }
  const basePolicy = assertExecutionPolicy(input.currentExecutionPolicy);
  const policySnapshot = assertExecutionPolicy({
    ...basePolicy,
    ...(input.policyOverrides ?? {}),
    schemaVersion: 1,
    processEnvironment: {
      ...basePolicy.processEnvironment,
      ...(input.policyOverrides?.processEnvironment ?? {}),
    },
    transientToolConfig: {
      ...basePolicy.transientToolConfig,
      ...(input.policyOverrides?.transientToolConfig ?? {}),
    },
  });
  const changedFields = diffJson(
    previous.policySnapshot as unknown as JsonValue,
    policySnapshot as unknown as JsonValue,
    '',
    new Set(['/schemaVersion']),
  );
  if (
    input.retryMode === 'execution-policy-change' &&
    changedFields.length === 0
  ) {
    throw executionError(
      'RETRY_POLICY_CHANGE_EMPTY',
      'execution-policy-change requires at least one changed policy field.',
      ExitCode.usage,
    );
  }
  if (input.retryMode === 'same-input' && changedFields.length !== 0) {
    throw executionError(
      'RETRY_MODE_MISMATCH',
      'same-input cannot change the execution policy.',
      ExitCode.usage,
    );
  }
  const repairContext =
    input.repairContext === undefined
      ? null
      : assertRepairContext(input.repairContext, job);
  if ((input.retryMode === 'repair') !== (repairContext !== null)) {
    throw executionError(
      'RETRY_REPAIR_CONTEXT_INVALID',
      'A repair Attempt requires, and only a repair Attempt accepts, repair context.',
      ExitCode.usage,
    );
  }
  const strategyChanges = normalizeUniqueStrings(
    input.strategyChanges ?? [],
    'strategyChanges',
  );
  if (input.retryMode === 'strategy-change' && strategyChanges.length === 0) {
    throw executionError(
      'RETRY_STRATEGY_CHANGE_EMPTY',
      'strategy-change requires a declared strategy change.',
      ExitCode.usage,
    );
  }
  const grantId =
    input.grantId === undefined
      ? null
      : assertIdentifier(input.grantId, 'grantId');
  const attemptNumber = job.attemptCount + 1;
  const requestDigest = composeAttemptRequestDigest({
    jobId: job.jobId,
    attemptNumber,
    semanticSpec: job.semanticSpec,
    executionPolicy: policySnapshot,
    retryMode: input.retryMode,
    repairContext,
    strategyChanges,
    grantId,
  });
  const attempt: AttemptRecord = {
    schemaVersion: 2,
    attemptId,
    jobId: job.jobId,
    workflowId: job.workflowId,
    epoch: job.epoch,
    attemptNumber,
    retryOf: previous.attemptId,
    provider: policySnapshot.provider,
    status: 'created',
    inputDigest: job.semanticSpec.inputDigest,
    requestDigest,
    contextDigest: job.contextDigest,
    environmentDigest: assertDigest(input.environmentDigest),
    retryMode: input.retryMode,
    policySnapshot,
    changedFields,
    repairContext,
    strategyChanges,
    grantId,
    failure: null,
    failureFingerprint: null,
    leaseGeneration: 0,
    lease: null,
    runtimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    retention: 'active',
    providerInvocation: null,
    createdAt,
    updatedAt: createdAt,
  };
  const nextJob: JobRecord = {
    ...job,
    status: 'queued',
    attemptCount: attemptNumber,
    repairAttemptCount:
      job.repairAttemptCount + (input.retryMode === 'repair' ? 1 : 0),
    updatedAt: createdAt,
  };
  return deepFreeze({
    job: assertJobRecord(nextJob),
    attempt: assertAttemptRecord(attempt),
  });
}

export function executionPolicyChangedFields(
  previous: ExecutionPolicySnapshot,
  current: ExecutionPolicySnapshot,
): ChangedField[] {
  const before = assertExecutionPolicy(previous);
  const after = assertExecutionPolicy(current);
  return deepFreeze(
    diffJson(
      before as unknown as JsonValue,
      after as unknown as JsonValue,
      '',
      new Set(['/schemaVersion']),
    ),
  );
}

export function leaseAttempt(
  inputAttempt: AttemptRecord,
  input: {
    workerId: string;
    leaseToken: string;
    leaseDurationMs: number;
    now?: string;
  },
): AttemptRecord {
  const attempt = assertAttemptRecord(inputAttempt);
  if (attempt.status !== 'created' || attempt.lease !== null) {
    throw executionError(
      'ATTEMPT_LEASE_CONFLICT',
      'Only an unleased created Attempt can be leased.',
      ExitCode.conflict,
    );
  }
  const workerId = assertIdentifier(input.workerId, 'workerId');
  if (
    typeof input.leaseToken !== 'string' ||
    input.leaseToken.length < 8 ||
    Buffer.byteLength(input.leaseToken, 'utf8') > 512
  ) {
    throw executionInvalid('leaseToken is invalid.');
  }
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > attempt.policySnapshot.timeoutMs
  ) {
    throw executionInvalid('leaseDurationMs is outside the Attempt policy.');
  }
  const now = assertTimestamp(input.now ?? new Date().toISOString());
  const generation = attempt.leaseGeneration + 1;
  return deepFreeze(
    assertAttemptRecord({
      ...attempt,
      status: 'leased',
      leaseGeneration: generation,
      lease: {
        generation,
        workerId,
        tokenDigest: digestText(input.leaseToken),
        acquiredAt: now,
        expiresAt: new Date(
          Date.parse(now) + input.leaseDurationMs,
        ).toISOString(),
      },
      updatedAt: now,
    }),
  );
}

export function acceptAttemptResult(input: {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
  expectedAcceptedAttemptId: string | null;
  leaseGeneration: number;
  leaseToken: string;
  outputDigest: string;
  completedAt?: string;
}): {
  accepted: boolean;
  job: JobRecord;
  attempt: AttemptRecord;
  result: AttemptResult;
} {
  const workflow = assertWorkflowRecord(input.workflow);
  const job = assertJobRecord(input.job);
  const attempt = assertAttemptRecord(input.attempt);
  const completedAt = assertTimestamp(
    input.completedAt ?? new Date().toISOString(),
  );
  if (input.expectedAcceptedAttemptId !== job.acceptedAttemptId) {
    throw executionError(
      'JOB_RESULT_CAS_CONFLICT',
      'The Job accepted-result compare-and-swap precondition changed.',
      ExitCode.staleState,
    );
  }
  assertAttemptFence(
    attempt,
    input.leaseGeneration,
    input.leaseToken,
    completedAt,
  );
  if (
    attempt.jobId !== job.jobId ||
    attempt.workflowId !== job.workflowId ||
    job.workflowId !== workflow.workflowId
  ) {
    throw executionInvalid(
      'Result identities do not bind to one Workflow and Job.',
    );
  }
  const outputDigest = assertDigest(input.outputDigest);
  if (
    workflow.status !== 'active' ||
    workflow.currentEpoch !== job.epoch ||
    workflow.currentEpoch !== attempt.epoch ||
    workflow.contextDigest !== job.contextDigest ||
    workflow.contextDigest !== attempt.contextDigest
  ) {
    const staleAttempt = assertAttemptRecord({
      ...attempt,
      status: 'stale',
      retention: 'debug',
      updatedAt: completedAt,
    });
    // Only the Attempt goes stale. A Job that already accepted a result stays
    // succeeded: marking it stale while it still names an accepted Attempt
    // contradicts the record invariant, and a late output must be classified
    // and dropped rather than crash the acceptance path.
    const staleJob =
      job.acceptedAttemptId === null
        ? assertJobRecord({
            ...job,
            status: 'stale',
            updatedAt: completedAt,
          })
        : job;
    return deepFreeze({
      accepted: false,
      job: staleJob,
      attempt: staleAttempt,
      result: createAttemptResult(
        staleAttempt,
        outputDigest,
        'stale',
        completedAt,
      ),
    });
  }
  if (job.acceptedAttemptId !== null) {
    const duplicate = assertAttemptRecord({
      ...attempt,
      status: 'late-duplicate',
      retention: 'debug',
      updatedAt: completedAt,
    });
    return deepFreeze({
      accepted: false,
      job,
      attempt: duplicate,
      result: createAttemptResult(
        duplicate,
        outputDigest,
        'late-duplicate',
        completedAt,
      ),
    });
  }
  if (!['leased', 'running'].includes(attempt.status)) {
    throw executionError(
      'ATTEMPT_RESULT_INELIGIBLE',
      'The Attempt state is not eligible to submit a result.',
      ExitCode.guard,
    );
  }
  const acceptedAttempt = assertAttemptRecord({
    ...attempt,
    status: 'succeeded',
    updatedAt: completedAt,
  });
  const acceptedJob = assertJobRecord({
    ...job,
    status: 'succeeded',
    acceptedAttemptId: attempt.attemptId,
    cumulativeRuntimeMs: job.cumulativeRuntimeMs + attempt.runtimeMs,
    providerCostMicros: job.providerCostMicros + attempt.providerCostMicros,
    providerTokens: job.providerTokens + attempt.providerTokens,
    updatedAt: completedAt,
  });
  return deepFreeze({
    accepted: true,
    job: acceptedJob,
    attempt: acceptedAttempt,
    result: createAttemptResult(
      acceptedAttempt,
      outputDigest,
      'accepted',
      completedAt,
    ),
  });
}

function assertAttemptFence(
  attempt: AttemptRecord,
  generation: number,
  token: string,
  completedAt: string,
): void {
  if (
    attempt.lease === null ||
    !Number.isSafeInteger(generation) ||
    generation !== attempt.leaseGeneration ||
    generation !== attempt.lease.generation ||
    typeof token !== 'string' ||
    !constantTimeEqual(attempt.lease.tokenDigest, digestText(token)) ||
    Date.parse(completedAt) > Date.parse(attempt.lease.expiresAt)
  ) {
    throw executionError(
      'ATTEMPT_FENCE_REJECTED',
      'The Attempt result was produced by an expired or stale lease holder.',
      ExitCode.staleState,
    );
  }
}

export function createAttemptResult(
  inputAttempt: AttemptRecord,
  inputOutputDigest: string,
  acceptance: AttemptResult['acceptance'],
  inputCompletedAt: string,
): AttemptResult {
  const attempt = assertAttemptRecord(inputAttempt);
  const outputDigest = assertDigest(inputOutputDigest);
  const completedAt = assertTimestamp(inputCompletedAt);
  if (!['accepted', 'stale', 'late-duplicate'].includes(acceptance)) {
    throw executionInvalid('Attempt result acceptance is invalid.');
  }
  return assertAttemptResult(
    createAttemptAcceptanceBindingV1({
      workflowId: attempt.workflowId,
      epoch: attempt.epoch,
      contextDigest: attempt.contextDigest,
      jobId: attempt.jobId,
      attemptId: attempt.attemptId,
      outputDigest,
      acceptance,
      completedAt,
    }),
  );
}

function composeAttemptRequestDigest(input: {
  jobId: string;
  attemptNumber: number;
  semanticSpec: SemanticJobSpec;
  executionPolicy: ExecutionPolicySnapshot;
  retryMode: RetryMode;
  repairContext: RepairContext | null;
  strategyChanges: string[];
  grantId: string | null;
}): string {
  return digestCanonical({
    kind: 'attempt-request',
    schemaVersion: 2,
    ...input,
  });
}
