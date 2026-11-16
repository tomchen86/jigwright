/** Canonical replacement records, receipt identity and transaction phase rules. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  canonicalExecutionBudgetGrantRequest,
  parseExecutionBudgetGrantRequest,
  type ExecutionBudgetConsumeReceipt,
  type ExecutionBudgetGrantRequest,
} from '../authority/execution-governance-grant-contracts.ts';
import { isRecord } from '../authority/execution-governance-values.ts';
import {
  digestCanonical,
  digestText,
  hasExactKeys,
} from './execution-values.ts';
import {
  recreateProviderInvocationRequest,
  type ProviderInvocationRequest,
} from './provider-contracts.ts';
import {
  parseProviderRetryExplanation,
  type ProviderRetryExplanation,
} from './provider-retry-explanation.ts';

export type ExecutionReplacementRequestBinding = Readonly<{
  schemaVersion: 1;
  kind: 'execution-replacement-request-binding';
  requestDigest: string;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  failedAttemptId: string;
  failedInvocationId: string;
  failedInvocationRevision: number;
  failureFingerprint: string;
  providerPolicyDigest: string;
  providerPolicyDocumentDigest: string;
  budgetScope?: 'next-attempt';
  retryExplanation?: ProviderRetryExplanation;
  recordDigest: string;
}>;

export type ExecutionReplacementPhase =
  | 'prepared'
  | 'grant-consumed'
  | 'invocation-published'
  | 'dispatch-issued'
  | 'complete';

export type ExecutionReplacementTransaction = Readonly<{
  schemaVersion: 1;
  kind: 'execution-replacement-transaction';
  transactionId: string;
  phase: ExecutionReplacementPhase;
  grantId: string;
  requestDigest: string;
  request: ExecutionBudgetGrantRequest;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  failedAttemptId: string;
  failedInvocationId: string;
  failedInvocationRevision: number;
  failureFingerprint: string;
  replacementAttemptId: string;
  replacementInvocationId: string;
  replacementRequest: ProviderInvocationRequest;
  receipt: ExecutionBudgetConsumeReceipt | null;
  createdAt: string;
  updatedAt: string;
  recordDigest: string;
}>;

export function createRequestBinding(
  input: Omit<
    ExecutionReplacementRequestBinding,
    'schemaVersion' | 'kind' | 'recordDigest'
  >,
): ExecutionReplacementRequestBinding {
  const core = {
    schemaVersion: 1 as const,
    kind: 'execution-replacement-request-binding' as const,
    ...input,
  };
  return assertRequestBinding({
    ...core,
    recordDigest: digestCanonical(core),
  });
}

export function assertRequestBinding(
  value: unknown,
): ExecutionReplacementRequestBinding {
  const keys = [
    'contextDigest',
    'epoch',
    'failedAttemptId',
    'failedInvocationId',
    'failedInvocationRevision',
    'failureFingerprint',
    'jobId',
    'kind',
    'providerPolicyDigest',
    'providerPolicyDocumentDigest',
    'recordDigest',
    'requestDigest',
    'schemaVersion',
    'workflowId',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      ...keys,
      ...('budgetScope' in value ? ['budgetScope'] : []),
      ...('retryExplanation' in value ? ['retryExplanation'] : []),
    ]) ||
    ('budgetScope' in value && value.budgetScope !== 'next-attempt') ||
    ('retryExplanation' in value && value.budgetScope !== 'next-attempt') ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-replacement-request-binding' ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.contextDigest) ||
    !isDigest(value.failureFingerprint) ||
    !isProviderDigest(value.providerPolicyDigest) ||
    !isDigest(value.providerPolicyDocumentDigest) ||
    !isDigest(value.recordDigest) ||
    !isIdentity(value.workflowId) ||
    !isIdentity(value.jobId) ||
    !isIdentity(value.failedAttemptId) ||
    !isIdentity(value.failedInvocationId) ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !Number.isSafeInteger(value.failedInvocationRevision) ||
    (value.failedInvocationRevision as number) < 0
  ) {
    throw replacementUnsafe();
  }
  if ('retryExplanation' in value)
    parseProviderRetryExplanation(value.retryExplanation);
  const { recordDigest, ...core } = value;
  if (recordDigest !== digestCanonical(core)) throw replacementUnsafe();
  return Object.freeze(
    structuredClone(value),
  ) as ExecutionReplacementRequestBinding;
}

export function createTransaction(
  input: Omit<ExecutionReplacementTransaction, 'recordDigest'>,
): ExecutionReplacementTransaction {
  return assertTransactionRecord({
    ...input,
    recordDigest: digestCanonical(input),
  });
}

export function assertTransactionRecord(
  value: unknown,
): ExecutionReplacementTransaction {
  const keys = [
    'contextDigest',
    'createdAt',
    'epoch',
    'failedAttemptId',
    'failedInvocationId',
    'failedInvocationRevision',
    'failureFingerprint',
    'grantId',
    'jobId',
    'kind',
    'phase',
    'receipt',
    'recordDigest',
    'replacementAttemptId',
    'replacementInvocationId',
    'replacementRequest',
    'request',
    'requestDigest',
    'schemaVersion',
    'transactionId',
    'updatedAt',
    'workflowId',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-replacement-transaction' ||
    ![
      'prepared',
      'grant-consumed',
      'invocation-published',
      'dispatch-issued',
      'complete',
    ].includes(value.phase as string) ||
    !isDigest(value.transactionId) ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.contextDigest) ||
    !isDigest(value.failureFingerprint) ||
    !isDigest(value.recordDigest) ||
    !isUuid(value.grantId) ||
    !isIdentity(value.workflowId) ||
    !isIdentity(value.jobId) ||
    !isIdentity(value.failedAttemptId) ||
    !isIdentity(value.failedInvocationId) ||
    !isIdentity(value.replacementAttemptId) ||
    !isIdentity(value.replacementInvocationId) ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !Number.isSafeInteger(value.failedInvocationRevision) ||
    (value.failedInvocationRevision as number) < 0 ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw replacementUnsafe();
  }
  let request: ExecutionBudgetGrantRequest;
  let replacementRequest: ProviderInvocationRequest;
  try {
    request = parseExecutionBudgetGrantRequest(
      `${canonicalJson(value.request)}\n`,
    );
    replacementRequest = recreateProviderInvocationRequest(
      value.replacementRequest,
    );
  } catch {
    throw replacementUnsafe();
  }
  const receipt = value.receipt;
  if (
    (value.phase === 'prepared') !== (receipt === null) ||
    (receipt !== null && !isReceipt(receipt)) ||
    request.workflowId !== value.workflowId ||
    request.epoch !== value.epoch ||
    request.jobId !== value.jobId ||
    digestText(canonicalExecutionBudgetGrantRequest(request)) !==
      value.requestDigest ||
    replacementRequest.invocationId !== value.replacementInvocationId ||
    value.replacementAttemptId !==
      `attempt-provider-${value.replacementInvocationId}` ||
    value.transactionId !==
      digestCanonical({
        kind: 'execution-replacement-transaction',
        grantId: value.grantId,
        requestDigest: value.requestDigest,
        replacementAttemptId: value.replacementAttemptId,
      }) ||
    Date.parse(value.updatedAt as string) <
      Date.parse(value.createdAt as string)
  ) {
    throw replacementUnsafe();
  }
  if (receipt !== null) {
    if (
      receipt.grantId !== value.grantId ||
      receipt.requestDigest !== value.requestDigest ||
      receipt.workflowId !== value.workflowId ||
      receipt.epoch !== value.epoch ||
      receipt.jobId !== value.jobId ||
      receipt.attemptId !== value.replacementAttemptId ||
      canonicalJson(receipt.mandateBinding) !==
        canonicalJson(request.mandateBinding)
    ) {
      throw replacementUnsafe();
    }
  }
  const { recordDigest, ...core } = value;
  if (recordDigest !== digestCanonical(core)) throw replacementUnsafe();
  return Object.freeze(
    structuredClone(value),
  ) as ExecutionReplacementTransaction;
}

function isReceipt(value: unknown): value is ExecutionBudgetConsumeReceipt {
  if (!(
    isRecord(value) &&
    hasExactKeys(value, [
      'attemptId',
      'consumedAt',
      'epoch',
      'grantId',
      'jobId',
      'kind',
      'mandateBinding',
      'receiptId',
      'remainingUses',
      'requestDigest',
      'schemaVersion',
      'useNumber',
      'workflowId',
    ]) &&
    value.schemaVersion === 1 &&
    value.kind === 'execution-budget-consume-receipt' &&
    isDigest(value.receiptId) &&
    isDigest(value.requestDigest) &&
    isUuid(value.grantId) &&
    isIdentity(value.workflowId) &&
    isIdentity(value.jobId) &&
    isIdentity(value.attemptId) &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) > 0 &&
    Number.isSafeInteger(value.useNumber) &&
    (value.useNumber as number) > 0 &&
    Number.isSafeInteger(value.remainingUses) &&
    (value.remainingUses as number) >= 0 &&
    isTimestamp(value.consumedAt)
  ))
    return false;
  const { receiptId, ...core } = value;
  return receiptId === digestText(canonicalJson(core));
}

export function phaseRank(phase: ExecutionReplacementPhase): number {
  return [
    'prepared',
    'grant-consumed',
    'invocation-published',
    'dispatch-issued',
    'complete',
  ].indexOf(phase);
}

export function assertReceipt(
  transaction: ExecutionReplacementTransaction,
  receipt: ExecutionBudgetConsumeReceipt | null,
): asserts receipt is ExecutionBudgetConsumeReceipt {
  if (
    receipt === null ||
    receipt.grantId !== transaction.grantId ||
    receipt.requestDigest !== transaction.requestDigest ||
    receipt.workflowId !== transaction.workflowId ||
    receipt.epoch !== transaction.epoch ||
    receipt.jobId !== transaction.jobId ||
    receipt.attemptId !== transaction.replacementAttemptId
  ) {
    throw grantMismatch(
      'Grant receipt does not bind the exact replacement Attempt.',
    );
  }
}

export function assertTransactionIdentity(
  transaction: ExecutionReplacementTransaction,
  expected: Pick<
    ExecutionReplacementTransaction,
    | 'transactionId'
    | 'grantId'
    | 'requestDigest'
    | 'jobId'
    | 'replacementAttemptId'
    | 'replacementInvocationId'
  >,
): void {
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (transaction[key] !== expected[key]) throw replacementUnsafe();
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function isProviderDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function grantMismatch(message: string) {
  return workflowError(
    'EXECUTION_REPLACEMENT_GRANT_MISMATCH',
    message,
    ExitCode.guard,
  );
}

export function replacementUnsafe() {
  return workflowError(
    'EXECUTION_REPLACEMENT_STORE_UNSAFE',
    'Durable execution replacement state is malformed or unsafe.',
    ExitCode.staleState,
  );
}
