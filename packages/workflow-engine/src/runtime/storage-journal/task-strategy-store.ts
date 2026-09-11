/**
 * Publishes and resolves the current sealed RED transaction through its exact current ref.
 *
 * Invariants:
 * - Immutable transaction publication precedes current-ref compare-and-swap.
 * - Current reads validate the predecessor, task contract, and reviewed lineage before returning a transaction.
 */
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import {
  createTaskStrategyCurrentRef,
  compareAndSwapTaskStrategyCurrentRef,
  readTaskStrategyCurrentRef,
} from './task-strategy-current-ref.ts';
import {
  type TaskStrategyTransactionInput,
  type TaskStrategyTransaction,
  persistTaskStrategyTransaction,
  prepareTaskStrategyTransaction,
  stateCorrupt,
  readTaskStrategyTransactionByDigest,
  isSameReviewedTaskStrategyLineage,
} from './task-strategy-transactions.ts';

export {
  type TaskStrategyFrozenFile,
  type TaskStrategyTransaction,
  type TaskStrategyTransactionInput,
  createContentAddressedTaskStrategyTransaction,
  prepareTaskStrategyTransaction,
  persistTaskStrategyTransaction,
  readTaskStrategyTransactionByDigest,
  isSameReviewedTaskStrategyLineage,
  parseTaskStrategyTransaction,
} from './task-strategy-transactions.ts';

export function createTaskStrategyTransaction(
  paths: InvestigationRuntimePaths,
  input: TaskStrategyTransactionInput,
): TaskStrategyTransaction {
  const transaction = persistTaskStrategyTransaction(
    paths,
    prepareTaskStrategyTransaction(input),
  );
  const initial = createTaskStrategyCurrentRef({
    sessionId: transaction.sessionId,
    state: 'red-sealed',
    transactionDigest: transaction.recordDigest,
    predecessorTransactionDigest: null,
    revisionId: null,
    taskContractDigest: transaction.taskContractDigest,
    updatedAt: transaction.createdAt,
  });
  compareAndSwapTaskStrategyCurrentRef(paths, {
    sessionId: transaction.sessionId,
    expectedRefDigest: null,
    next: initial,
  });
  const stored = readTaskStrategyTransaction(paths, transaction.sessionId);
  if (stored?.recordDigest !== transaction.recordDigest) throw stateCorrupt();
  return stored;
}

export function readTaskStrategyTransaction(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): TaskStrategyTransaction | null {
  const sessionId = assertSessionId(requestedSessionId);
  const current = readTaskStrategyCurrentRef(paths, sessionId);
  if (current === null) return null;
  if (current.state === 'red-authoring') {
    const predecessor = readTaskStrategyTransactionByDigest(
      paths,
      sessionId,
      current.predecessorTransactionDigest,
    );
    if (
      predecessor === null ||
      predecessor.taskContractDigest !== current.taskContractDigest
    ) {
      throw stateCorrupt();
    }
    return null;
  }
  const transaction = readTaskStrategyTransactionByDigest(
    paths,
    sessionId,
    current.transactionDigest,
  );
  if (
    transaction === null ||
    transaction.taskContractDigest !== current.taskContractDigest
  ) {
    throw stateCorrupt();
  }
  if (
    current.predecessorTransactionDigest !== null &&
    !isSameReviewedTaskStrategyLineage(
      transaction,
      readTaskStrategyTransactionByDigest(
        paths,
        sessionId,
        current.predecessorTransactionDigest,
      ),
    )
  ) {
    throw stateCorrupt();
  }
  return transaction;
}
