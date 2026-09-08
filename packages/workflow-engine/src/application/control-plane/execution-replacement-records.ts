// execution replacement records; repository effects remain bound by the public module.
import type {
  ExecutionReplacementRecordsBindings,
  ExecutionReplacementRecordsBindingsTypes,
} from './execution-replacement.ts';
type ExecutionReplacementRequestBinding =
  ExecutionReplacementRecordsBindingsTypes['ExecutionReplacementRequestBinding'];
type ExecutionReplacementTransaction =
  ExecutionReplacementRecordsBindingsTypes['ExecutionReplacementTransaction'];
type ExecutionBudgetGrantRequest =
  ExecutionReplacementRecordsBindingsTypes['ExecutionBudgetGrantRequest'];
type ExecutionBudgetConsumeReceipt =
  ExecutionReplacementRecordsBindingsTypes['ExecutionBudgetConsumeReceipt'];
type InvestigationRuntimePaths =
  ExecutionReplacementRecordsBindingsTypes['InvestigationRuntimePaths'];
type ExecutionReplacementPhase =
  ExecutionReplacementRecordsBindingsTypes['ExecutionReplacementPhase'];
declare const recreateProviderInvocationRequest: ExecutionReplacementRecordsBindings['recreateProviderInvocationRequest'];

export function createExecutionReplacementRecords(
  bindings: () => ExecutionReplacementRecordsBindings,
) {
  function createRequestBinding(
    input: Omit<
      ExecutionReplacementRequestBinding,
      'schemaVersion' | 'kind' | 'recordDigest'
    >,
  ): ExecutionReplacementRequestBinding {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { digestCanonical } = boundServices;

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

  function assertRequestBinding(
    value: unknown,
  ): ExecutionReplacementRequestBinding {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const {
      isRecord,
      hasExactKeys,
      isDigest,
      isProviderDigest,
      isIdentity,
      replacementUnsafe,
      digestCanonical,
    } = boundServices;

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
      !hasExactKeys(value, keys) ||
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
    const { recordDigest, ...core } = value;
    if (recordDigest !== digestCanonical(core)) throw replacementUnsafe();
    return Object.freeze(
      structuredClone(value),
    ) as ExecutionReplacementRequestBinding;
  }

  function createTransaction(
    input: Omit<ExecutionReplacementTransaction, 'recordDigest'>,
  ): ExecutionReplacementTransaction {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { digestCanonical } = boundServices;

    return assertTransactionRecord({
      ...input,
      recordDigest: digestCanonical(input),
    });
  }

  function assertTransactionRecord(
    value: unknown,
  ): ExecutionReplacementTransaction {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const {
      isRecord,
      hasExactKeys,
      isDigest,
      isUuid,
      isIdentity,
      isTimestamp,
      replacementUnsafe,
      parseExecutionBudgetGrantRequest,
      canonicalJson,
      recreateProviderInvocationRequest,
      digestText,
      canonicalExecutionBudgetGrantRequest,
      digestCanonical,
    } = boundServices;

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
    let replacementRequest: ReturnType<
      typeof recreateProviderInvocationRequest
    >;
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
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const {
      isRecord,
      hasExactKeys,
      isDigest,
      isUuid,
      isIdentity,
      isTimestamp,
      digestText,
      canonicalJson,
    } = boundServices;

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

  function readPersistedRequest(
    paths: InvestigationRuntimePaths,
    storeRoot: string,
    requestDigest: string,
  ): ExecutionBudgetGrantRequest {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const {
      readPrivateCanonicalJson,
      replacementUnsafe,
      parseExecutionBudgetGrantRequest,
      canonicalJson,
      digestText,
      canonicalExecutionBudgetGrantRequest,
      grantMismatch,
    } = boundServices;

    const filePath = replacementRequestPath(storeRoot, requestDigest);
    try {
      const value = readPrivateCanonicalJson(
        paths,
        filePath,
        replacementUnsafe,
      );
      const request = parseExecutionBudgetGrantRequest(
        `${canonicalJson(value)}\n`,
      );
      if (
        digestText(canonicalExecutionBudgetGrantRequest(request)) !==
        requestDigest
      ) {
        throw replacementUnsafe();
      }
      return request;
    } catch {
      throw grantMismatch(
        'Canonical execution replacement request is missing or unsafe.',
      );
    }
  }

  function readRequestBinding(
    paths: InvestigationRuntimePaths,
    storeRoot: string,
    requestDigest: string,
  ): ExecutionReplacementRequestBinding {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { readPrivateCanonicalJson, replacementUnsafe } = boundServices;

    return assertRequestBinding(
      readPrivateCanonicalJson(
        paths,
        replacementRequestBindingPath(storeRoot, requestDigest),
        replacementUnsafe,
      ),
    );
  }

  function replacementRoot(storeRoot: string): string {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { path } = boundServices;

    return path.join(storeRoot, 'execution-replacements');
  }

  function replacementRequestPath(storeRoot: string, digest: string): string {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { replacementUnsafe, path } = boundServices;

    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw replacementUnsafe();
    return path.join(
      replacementRoot(storeRoot),
      'requests',
      `${digest.slice(7)}.json`,
    );
  }

  function replacementRequestBindingPath(
    storeRoot: string,
    digest: string,
  ): string {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { replacementUnsafe, path } = boundServices;

    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw replacementUnsafe();
    return path.join(
      replacementRoot(storeRoot),
      'request-bindings',
      `${digest.slice(7)}.json`,
    );
  }

  function replacementTransactionPath(
    storeRoot: string,
    digest: string,
  ): string {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { replacementUnsafe, path } = boundServices;

    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw replacementUnsafe();
    return path.join(
      replacementRoot(storeRoot),
      'transactions',
      `${digest.slice(7)}.json`,
    );
  }

  function readTransactionIfPresent(
    paths: InvestigationRuntimePaths,
    filePath: string,
  ): ExecutionReplacementTransaction | null {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { privatePathExists, replacementUnsafe, readPrivateCanonicalJson } =
      boundServices;

    if (!privatePathExists(paths, filePath, replacementUnsafe)) return null;
    return assertTransactionRecord(
      readPrivateCanonicalJson(paths, filePath, replacementUnsafe),
    );
  }

  function writeTransaction(
    paths: InvestigationRuntimePaths,
    filePath: string,
    transaction: ExecutionReplacementTransaction,
    replace: boolean,
  ): void {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const {
      createPrivateCanonicalJson,
      replacementUnsafe,
      writePrivateCanonicalJsonAtomic,
    } = boundServices;

    assertTransactionRecord(transaction);
    if (!replace) {
      createPrivateCanonicalJson(
        paths,
        filePath,
        transaction,
        replacementUnsafe,
        'EXECUTION_REPLACEMENT_TRANSACTION_CONFLICT',
      );
      return;
    }
    writePrivateCanonicalJsonAtomic(
      paths,
      filePath,
      transaction,
      replacementUnsafe,
    );
  }

  function advanceTransaction(
    paths: InvestigationRuntimePaths,
    filePath: string,
    transaction: ExecutionReplacementTransaction,
    phase: ExecutionReplacementPhase,
    updatedAt: string,
  ): ExecutionReplacementTransaction {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { replacementUnsafe } = boundServices;

    const durable = readTransactionIfPresent(paths, filePath);
    if (durable === null) throw replacementUnsafe();
    assertTransactionIdentity(durable, {
      transactionId: transaction.transactionId,
      grantId: transaction.grantId,
      requestDigest: transaction.requestDigest,
      jobId: transaction.jobId,
      replacementAttemptId: transaction.replacementAttemptId,
      replacementInvocationId: transaction.replacementInvocationId,
    });
    if (phaseRank(durable.phase) >= phaseRank(phase)) return durable;
    if (phaseRank(durable.phase) + 1 !== phaseRank(phase)) {
      throw replacementUnsafe();
    }
    const { recordDigest: _recordDigest, ...durableCore } = durable;
    const next = createTransaction({ ...durableCore, phase, updatedAt });
    writeTransaction(paths, filePath, next, true);
    return next;
  }

  function phaseRank(phase: ExecutionReplacementPhase): number {
    return [
      'prepared',
      'grant-consumed',
      'invocation-published',
      'dispatch-issued',
      'complete',
    ].indexOf(phase);
  }

  function assertReceipt(
    transaction: ExecutionReplacementTransaction,
    receipt: ExecutionBudgetConsumeReceipt | null,
  ): asserts receipt is ExecutionBudgetConsumeReceipt {
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { grantMismatch } = boundServices;

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

  function assertTransactionIdentity(
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
    const boundServices: ExecutionReplacementRecordsBindings = bindings();
    const { replacementUnsafe } = boundServices;

    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (transaction[key] !== expected[key]) throw replacementUnsafe();
    }
  }
  return {
    createRequestBinding,
    createTransaction,
    readPersistedRequest,
    readRequestBinding,
    replacementRequestPath,
    replacementRequestBindingPath,
    replacementTransactionPath,
    readTransactionIfPresent,
    writeTransaction,
    advanceTransaction,
    assertReceipt,
    assertTransactionIdentity,
  };
}
