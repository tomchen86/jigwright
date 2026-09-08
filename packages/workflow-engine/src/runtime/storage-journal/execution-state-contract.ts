/**
 * Defines and validates durable execution jobs and reconciliation receipts.
 *
 * Invariants:
 * - Workflow, job, attempts, and result records retain exact cross-record identity checks.
 * - Canonical state and receipt digests preserve the same fields and byte encoding.
 *
 * Depends on: execution core contracts, provider entry types, and shared digest checks.
 * Failure modes: corrupt projections are persisted or replay receipts identify different execution state.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type AttemptRecord,
  type AttemptResult,
  type JobRecord,
  type RetryMode,
  type WorkflowRecord,
  assertAttemptRecord,
  assertAttemptResult,
  assertJobRecord,
  assertWorkflowRecord,
} from '../../modules/provider-orchestration/execution-core.ts';
import { type ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  deepFreeze,
  DIGEST,
  digestCanonical,
  EXECUTION_JOB_ID,
  executionStoreUnsafe,
  hasExactKeys,
  isExactTimestamp,
  isRecord,
  MAX_PROVIDER_ATTEMPTS,
} from './execution-state-values.ts';
import {
  type ProviderInvocationRecord,
  type ProviderRetryAccountingSnapshot,
} from './provider-invocation-store.ts';

export type ProviderExecutionEntry = Readonly<{
  record: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
  retryAccounting: ProviderRetryAccountingSnapshot;
  retryReplacement?: Readonly<{
    attemptId: string;
    retryMode: Exclude<RetryMode, 'none' | 'new-context'>;
    strategyChanges: readonly string[];
    environmentDigest: string;
    executionGrantId: string | null;
    authorizationNodeId: string;
    reservationNodeId: string;
  }> | null;
}>;

export type DurableExecutionJobState = Readonly<{
  schemaVersion: 1;
  revision: number;
  workflow: WorkflowRecord;
  job: JobRecord;
  attempts: AttemptRecord[];
  results: AttemptResult[];
  reconciliationReceipts: ExecutionReconciliationReceipt[];
  invocationProjection: {
    kind: 'provider-invocation-projection.v1';
    completeHistory: boolean;
    invocations: Array<{
      invocationId: string;
      invocationRevision: number;
      attemptId: string;
    }>;
  };
}>;

export type ExecutionReconciliationReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-execution-reconciliation.v1';
  receiptId: string;
  jobId: string;
  triggerInvocationId: string;
  expectedExecutionRevision: number;
  expectedInvocationRevision: number;
  resultingExecutionRevision: number;
  beforeStateDigest: string;
  afterProjectionDigest: string;
  acceptedAttemptId: string | null;
  reconciledInvocationIds: string[];
  recordedAt: string;
}>;

export type DurableAttemptResultAcceptance = Readonly<{
  state: DurableExecutionJobState;
  accepted: boolean;
  result: AttemptResult;
}>;

export type DurableExecutionReconciliation = Readonly<{
  state: DurableExecutionJobState;
  receipt: ExecutionReconciliationReceipt;
  replayed: boolean;
}>;

export function assertDurableExecutionJobState(
  value: unknown,
): DurableExecutionJobState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attempts',
      'job',
      'invocationProjection',
      'reconciliationReceipts',
      'results',
      'revision',
      'schemaVersion',
      'workflow',
    ]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length < 1 ||
    value.attempts.length > MAX_PROVIDER_ATTEMPTS ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.reconciliationReceipts) ||
    !isRecord(value.invocationProjection) ||
    !hasExactKeys(value.invocationProjection, [
      'completeHistory',
      'invocations',
      'kind',
    ]) ||
    value.invocationProjection.kind !== 'provider-invocation-projection.v1' ||
    typeof value.invocationProjection.completeHistory !== 'boolean' ||
    !Array.isArray(value.invocationProjection.invocations)
  ) {
    throw executionStoreUnsafe();
  }
  let workflow: WorkflowRecord;
  let job: JobRecord;
  let attempts: AttemptRecord[];
  let results: AttemptResult[];
  let reconciliationReceipts: ExecutionReconciliationReceipt[];
  try {
    workflow = assertWorkflowRecord(value.workflow);
    job = assertJobRecord(value.job);
    attempts = value.attempts.map(assertAttemptRecord);
    results = value.results.map(assertAttemptResult);
    reconciliationReceipts = value.reconciliationReceipts.map((receipt) =>
      assertExecutionReconciliationReceipt(receipt, job.jobId),
    );
  } catch (error) {
    throw executionStoreUnsafe(error);
  }
  if (
    job.workflowId !== workflow.workflowId ||
    job.epoch !== workflow.currentEpoch ||
    job.contextDigest !== workflow.contextDigest ||
    job.attemptCount !== attempts.at(-1)!.attemptNumber ||
    value.invocationProjection.invocations.length !== attempts.length
  ) {
    throw executionStoreUnsafe();
  }
  const attemptIds = new Set<string>();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const source = value.invocationProjection.invocations[index];
    if (
      attemptIds.has(attempt.attemptId) ||
      (index > 0 &&
        attempt.attemptNumber <= attempts[index - 1]!.attemptNumber) ||
      attempt.jobId !== job.jobId ||
      attempt.workflowId !== workflow.workflowId ||
      attempt.epoch !== job.epoch ||
      attempt.contextDigest !== job.contextDigest ||
      attempt.retryOf !==
        (index > 0 &&
        attempt.attemptNumber === attempts[index - 1]!.attemptNumber + 1
          ? attempts[index - 1]!.attemptId
          : null) ||
      !isRecord(source) ||
      !hasExactKeys(source, [
        'attemptId',
        'invocationId',
        'invocationRevision',
      ]) ||
      source.attemptId !== attempt.attemptId ||
      source.invocationId !== attempt.providerInvocation?.invocationId ||
      source.invocationRevision !==
        attempt.providerInvocation?.invocationRevision ||
      !Number.isSafeInteger(source.invocationRevision) ||
      (source.invocationRevision as number) < 0
    ) {
      throw executionStoreUnsafe();
    }
    attemptIds.add(attempt.attemptId);
  }
  const resultAttempts = new Set<string>();
  let acceptedResult: AttemptResult | null = null;
  let priorAttemptNumber = 0;
  for (const result of results) {
    const attempt = attempts.find(
      ({ attemptId }) => attemptId === result.attemptId,
    );
    if (
      attempt === undefined ||
      resultAttempts.has(result.attemptId) ||
      result.workflowId !== workflow.workflowId ||
      result.epoch !== workflow.currentEpoch ||
      result.contextDigest !== workflow.contextDigest ||
      result.jobId !== job.jobId ||
      attempt.attemptNumber <= priorAttemptNumber ||
      (result.acceptance === 'accepted' && attempt.status !== 'succeeded') ||
      (result.acceptance === 'late-duplicate' &&
        attempt.status !== 'late-duplicate') ||
      (result.acceptance === 'stale' && attempt.status !== 'stale')
    ) {
      throw executionStoreUnsafe();
    }
    if (result.acceptance === 'accepted') {
      if (acceptedResult !== null) throw executionStoreUnsafe();
      acceptedResult = result;
    }
    resultAttempts.add(result.attemptId);
    priorAttemptNumber = attempt.attemptNumber;
  }
  for (const attempt of attempts) {
    if (
      ['succeeded', 'late-duplicate'].includes(attempt.status) !==
      resultAttempts.has(attempt.attemptId)
    ) {
      throw executionStoreUnsafe();
    }
  }
  if (
    reconciliationReceipts.some(
      (receipt, index) =>
        receipt.resultingExecutionRevision > (value.revision as number) ||
        (index > 0 &&
          receipt.receiptId <= reconciliationReceipts[index - 1]!.receiptId),
    ) ||
    value.invocationProjection.completeHistory !==
      attempts.every(
        ({ attemptNumber }, index) => attemptNumber === index + 1,
      ) ||
    (job.acceptedAttemptId === null) !== (acceptedResult === null) ||
    (acceptedResult !== null &&
      acceptedResult.attemptId !== job.acceptedAttemptId)
  ) {
    throw executionStoreUnsafe();
  }
  return deepFreeze({
    schemaVersion: 1,
    revision: value.revision as number,
    workflow,
    job,
    attempts,
    results,
    reconciliationReceipts,
    invocationProjection: {
      kind: 'provider-invocation-projection.v1',
      completeHistory: value.invocationProjection.completeHistory,
      invocations: value.invocationProjection.invocations.map((source) => ({
        invocationId: String((source as Record<string, unknown>).invocationId),
        invocationRevision: Number(
          (source as Record<string, unknown>).invocationRevision,
        ),
        attemptId: String((source as Record<string, unknown>).attemptId),
      })),
    },
  });
}

export function assertExecutionReconciliationReceipt(
  value: unknown,
  expectedJobId: string,
): ExecutionReconciliationReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'acceptedAttemptId',
      'afterProjectionDigest',
      'beforeStateDigest',
      'expectedExecutionRevision',
      'expectedInvocationRevision',
      'jobId',
      'kind',
      'receiptId',
      'reconciledInvocationIds',
      'recordedAt',
      'resultingExecutionRevision',
      'schemaVersion',
      'triggerInvocationId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-execution-reconciliation.v1' ||
    value.jobId !== expectedJobId ||
    typeof value.receiptId !== 'string' ||
    !DIGEST.test(value.receiptId) ||
    typeof value.triggerInvocationId !== 'string' ||
    !EXECUTION_JOB_ID.test(value.triggerInvocationId) ||
    !Number.isSafeInteger(value.expectedExecutionRevision) ||
    (value.expectedExecutionRevision as number) < 0 ||
    !Number.isSafeInteger(value.expectedInvocationRevision) ||
    (value.expectedInvocationRevision as number) < 0 ||
    !Number.isSafeInteger(value.resultingExecutionRevision) ||
    value.resultingExecutionRevision !==
      (value.expectedExecutionRevision as number) + 1 ||
    typeof value.beforeStateDigest !== 'string' ||
    !DIGEST.test(value.beforeStateDigest) ||
    typeof value.afterProjectionDigest !== 'string' ||
    !DIGEST.test(value.afterProjectionDigest) ||
    (value.acceptedAttemptId !== null &&
      (typeof value.acceptedAttemptId !== 'string' ||
        !EXECUTION_JOB_ID.test(value.acceptedAttemptId))) ||
    !Array.isArray(value.reconciledInvocationIds) ||
    value.reconciledInvocationIds.some(
      (invocationId) =>
        typeof invocationId !== 'string' ||
        !EXECUTION_JOB_ID.test(invocationId),
    ) ||
    canonicalJson(value.reconciledInvocationIds) !==
      canonicalJson(
        [...new Set(value.reconciledInvocationIds as string[])].sort(),
      ) ||
    !isExactTimestamp(value.recordedAt)
  ) {
    throw executionStoreUnsafe();
  }
  const expectedReceiptId = reconciliationReceiptId({
    jobId: expectedJobId,
    triggerInvocationId: value.triggerInvocationId,
    expectedExecutionRevision: value.expectedExecutionRevision as number,
    expectedInvocationRevision: value.expectedInvocationRevision as number,
  });
  if (value.receiptId !== expectedReceiptId) throw executionStoreUnsafe();
  return deepFreeze(structuredClone(value) as ExecutionReconciliationReceipt);
}

export function reconciliationReceiptId(input: {
  jobId: string;
  triggerInvocationId: string;
  expectedExecutionRevision: number;
  expectedInvocationRevision: number;
}): string {
  return digestCanonical({
    schemaVersion: 1,
    kind: 'provider-execution-reconciliation-request.v1',
    ...input,
  });
}

export function durableExecutionStateDigest(
  state: DurableExecutionJobState,
): string {
  return digestCanonical(state);
}

export function durableExecutionProjectionDigest(
  state: DurableExecutionJobState,
): string {
  return digestCanonical({
    workflow: state.workflow,
    job: state.job,
    attempts: state.attempts,
    results: state.results,
    invocationProjection: state.invocationProjection,
  });
}

export function canonicalStateIgnoringRevision(
  state: DurableExecutionJobState,
): string {
  return canonicalJson({ ...state, revision: 0 });
}
