/** Persists and reads immutable RED transactions through the canonical codec. */
import type {
  TaskStrategyTransaction,
  TaskStrategyTransactionInput,
} from '../../modules/assurance/task-strategy-evidence.ts';
export type {
  TaskStrategyFrozenFile,
  TaskStrategyTransaction,
  TaskStrategyTransactionInput,
} from '../../modules/assurance/task-strategy-evidence.ts';
import {
  prepareTaskStrategyTransaction,
  parseTaskStrategyTransaction,
  stateCorrupt,
} from '../../modules/assurance/task-strategy-transaction.ts';
export {
  prepareTaskStrategyTransaction,
  parseTaskStrategyTransaction,
  isSameReviewedTaskStrategyLineage,
  stateCorrupt,
} from '../../modules/assurance/task-strategy-transaction.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from '../journal-primitives/investigation-private-files.ts';
import path from 'node:path';
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Persist a successor RED transaction without publishing it as current.
 * Revision currentness is published separately through the strict current ref,
 * so a crash can never destroy the predecessor transaction.
 */
export function createContentAddressedTaskStrategyTransaction(
  paths: InvestigationRuntimePaths,
  input: TaskStrategyTransactionInput,
): TaskStrategyTransaction {
  return persistTaskStrategyTransaction(
    paths,
    prepareTaskStrategyTransaction(input),
  );
}

export function persistTaskStrategyTransaction(
  paths: InvestigationRuntimePaths,
  input: TaskStrategyTransaction,
): TaskStrategyTransaction {
  const transaction = parseTaskStrategyTransaction(input);
  createPrivateCanonicalJson(
    paths,
    contentAddressedTaskStrategyTransactionPath(
      paths,
      transaction.sessionId,
      transaction.recordDigest,
    ),
    transaction,
    stateCorrupt,
    'TASK_STRATEGY_TRANSACTION_CONFLICT',
  );
  const stored = readTaskStrategyTransactionByDigest(
    paths,
    transaction.sessionId,
    transaction.recordDigest,
  );
  if (stored === null) throw stateCorrupt();
  return stored;
}

export function readTaskStrategyTransactionByDigest(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedRecordDigest: string,
): TaskStrategyTransaction | null {
  const sessionId = assertSessionId(requestedSessionId);
  if (!DIGEST.test(requestedRecordDigest)) throw stateCorrupt();
  const target = contentAddressedTaskStrategyTransactionPath(
    paths,
    sessionId,
    requestedRecordDigest,
  );
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  const transaction = parseTaskStrategyTransaction(
    readPrivateCanonicalJson(paths, target, stateCorrupt),
  );
  if (
    transaction.sessionId !== sessionId ||
    transaction.recordDigest !== requestedRecordDigest
  ) {
    throw stateCorrupt();
  }
  return transaction;
}

function contentAddressedTaskStrategyTransactionPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  recordDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-transactions',
    sessionId,
    `${recordDigest}.json`,
  );
}
