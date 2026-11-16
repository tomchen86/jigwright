/** Private durable replacement requests, bindings and read-before-advance transactions. */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  canonicalExecutionBudgetGrantRequest,
  parseExecutionBudgetGrantRequest,
  type ExecutionBudgetGrantRequest,
} from '../../modules/authority/execution-governance-grant-contracts.ts';
import {
  assertRequestBinding,
  assertTransactionRecord,
  assertTransactionIdentity,
  createTransaction,
  phaseRank,
  grantMismatch,
  replacementUnsafe,
  type ExecutionReplacementRequestBinding,
  type ExecutionReplacementPhase,
  type ExecutionReplacementTransaction,
} from '../../modules/provider-orchestration/execution-replacement-records.ts';
import { digestText } from '../../modules/provider-orchestration/execution-values.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from '../journal-primitives/investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';

export function readPersistedRequest(
  paths: InvestigationRuntimePaths,
  storeRoot: string,
  requestDigest: string,
): ExecutionBudgetGrantRequest {
  const filePath = replacementRequestPath(storeRoot, requestDigest);
  try {
    const value = readPrivateCanonicalJson(paths, filePath, replacementUnsafe);
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

export function readRequestBinding(
  paths: InvestigationRuntimePaths,
  storeRoot: string,
  requestDigest: string,
): ExecutionReplacementRequestBinding {
  return assertRequestBinding(
    readPrivateCanonicalJson(
      paths,
      replacementRequestBindingPath(storeRoot, requestDigest),
      replacementUnsafe,
    ),
  );
}

function replacementRoot(storeRoot: string): string {
  return path.join(storeRoot, 'execution-replacements');
}

export function replacementRequestPath(
  storeRoot: string,
  digest: string,
): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw replacementUnsafe();
  return path.join(
    replacementRoot(storeRoot),
    'requests',
    `${digest.slice(7)}.json`,
  );
}

export function replacementRequestBindingPath(
  storeRoot: string,
  digest: string,
): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw replacementUnsafe();
  return path.join(
    replacementRoot(storeRoot),
    'request-bindings',
    `${digest.slice(7)}.json`,
  );
}

export function replacementTransactionPath(
  storeRoot: string,
  digest: string,
): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw replacementUnsafe();
  return path.join(
    replacementRoot(storeRoot),
    'transactions',
    `${digest.slice(7)}.json`,
  );
}

export function readTransactionIfPresent(
  paths: InvestigationRuntimePaths,
  filePath: string,
): ExecutionReplacementTransaction | null {
  if (!privatePathExists(paths, filePath, replacementUnsafe)) return null;
  return assertTransactionRecord(
    readPrivateCanonicalJson(paths, filePath, replacementUnsafe),
  );
}

export function writeTransaction(
  paths: InvestigationRuntimePaths,
  filePath: string,
  transaction: ExecutionReplacementTransaction,
  replace: boolean,
): void {
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

export function advanceTransaction(
  paths: InvestigationRuntimePaths,
  filePath: string,
  transaction: ExecutionReplacementTransaction,
  phase: ExecutionReplacementPhase,
  updatedAt: string,
): ExecutionReplacementTransaction {
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

/** Publish in request-then-binding order under the caller's lifecycle lock. */
export function writeRequestAndBinding(
  paths: InvestigationRuntimePaths,
  requestPath: string,
  bindingPath: string,
  request: ExecutionBudgetGrantRequest,
  binding: ExecutionReplacementRequestBinding,
): void {
  createPrivateCanonicalJson(
    paths,
    requestPath,
    request,
    replacementUnsafe,
    'EXECUTION_REPLACEMENT_REQUEST_CONFLICT',
  );
  createPrivateCanonicalJson(
    paths,
    bindingPath,
    binding,
    replacementUnsafe,
    'EXECUTION_REPLACEMENT_REQUEST_CONFLICT',
  );
}
