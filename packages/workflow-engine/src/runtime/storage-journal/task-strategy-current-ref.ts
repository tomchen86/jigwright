/**
 * Reads and compare-and-swaps the durable current RED reference.
 * Target validation precedes exact replay, expected-digest CAS, and transition admission.
 */
import {
  type TaskStrategyCurrentRef,
  parseTaskStrategyCurrentRef,
} from '../../modules/assurance/task-strategy-current-ref.ts';
export {
  type TaskStrategyCurrentRef,
  type TaskStrategyCurrentRefInput,
  createTaskStrategyCurrentRef,
  parseTaskStrategyCurrentRef,
} from '../../modules/assurance/task-strategy-current-ref.ts';
import {
  revisionStateCorrupt,
  DIGEST,
} from '../../modules/assurance/task-strategy-red-revision-values.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import {
  privatePathExists,
  readPrivateCanonicalJson,
  createPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from '../journal-primitives/investigation-private-files.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  readTaskStrategyTransactionByDigest,
  isSameReviewedTaskStrategyLineage,
} from './task-strategy-transactions.ts';
import path from 'node:path';

export function readTaskStrategyCurrentRef(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): TaskStrategyCurrentRef | null {
  const sessionId = assertSessionId(requestedSessionId);
  const target = currentRefPath(paths, sessionId);
  if (!privatePathExists(paths, target, revisionStateCorrupt)) return null;
  const current = parseTaskStrategyCurrentRef(
    readPrivateCanonicalJson(paths, target, revisionStateCorrupt),
  );
  if (current.sessionId !== sessionId) throw revisionStateCorrupt();
  return current;
}

export function compareAndSwapTaskStrategyCurrentRef(
  paths: InvestigationRuntimePaths,
  input: Readonly<{
    sessionId: string;
    expectedRefDigest: string | null;
    next: TaskStrategyCurrentRef;
  }>,
): TaskStrategyCurrentRef {
  const sessionId = assertSessionId(input.sessionId);
  if (
    input.expectedRefDigest !== null &&
    !DIGEST.test(input.expectedRefDigest)
  ) {
    throw revisionStateCorrupt();
  }
  const next = parseTaskStrategyCurrentRef(input.next);
  if (next.sessionId !== sessionId) throw revisionStateCorrupt();
  const current = readTaskStrategyCurrentRef(paths, sessionId);
  assertCurrentRefTargetAvailable(paths, next);
  if (current?.refDigest === next.refDigest) return current;
  const observedDigest = current?.refDigest ?? null;
  if (observedDigest !== input.expectedRefDigest) {
    throw workflowError(
      'TASK_STRATEGY_CURRENT_REF_CAS_MISMATCH',
      'Task strategy current ref changed during compare-and-swap.',
      ExitCode.conflict,
      {
        details: {
          expectedRefDigest: input.expectedRefDigest,
          observedRefDigest: observedDigest,
          nextRefDigest: next.refDigest,
        },
      },
    );
  }
  assertCurrentRefTransition(paths, current, next);
  const target = currentRefPath(paths, sessionId);
  if (current === null) {
    createPrivateCanonicalJson(
      paths,
      target,
      next,
      revisionStateCorrupt,
      'TASK_STRATEGY_CURRENT_REF_CAS_MISMATCH',
    );
  } else {
    writePrivateCanonicalJsonAtomic(paths, target, next, revisionStateCorrupt);
  }
  const published = readTaskStrategyCurrentRef(paths, sessionId);
  if (published?.refDigest !== next.refDigest) throw revisionStateCorrupt();
  return published;
}

function assertCurrentRefTransition(
  paths: InvestigationRuntimePaths,
  current: TaskStrategyCurrentRef | null,
  next: TaskStrategyCurrentRef,
): void {
  if (current === null) {
    if (
      next.state !== 'red-sealed' ||
      next.predecessorTransactionDigest !== null ||
      next.revisionId !== null
    ) {
      throw revisionStateCorrupt();
    }
    return;
  }
  if (
    current.state === 'red-sealed'
      ? next.state !== 'red-authoring' ||
        next.predecessorTransactionDigest !== current.transactionDigest ||
        next.taskContractDigest !== current.taskContractDigest
      : next.state !== 'red-sealed' ||
        next.predecessorTransactionDigest !==
          current.predecessorTransactionDigest ||
        next.revisionId !== current.revisionId ||
        next.taskContractDigest !== current.taskContractDigest
  ) {
    throw revisionStateCorrupt();
  }
}

function assertCurrentRefTargetAvailable(
  paths: InvestigationRuntimePaths,
  next: TaskStrategyCurrentRef,
): void {
  const transactionDigest =
    next.state === 'red-authoring'
      ? next.predecessorTransactionDigest
      : next.transactionDigest;
  const transaction = readTaskStrategyTransactionByDigest(
    paths,
    next.sessionId,
    transactionDigest,
  );
  if (
    transaction === null ||
    transaction.taskContractDigest !== next.taskContractDigest
  ) {
    throw revisionStateCorrupt();
  }
  if (next.state === 'red-authoring') return;
  if (
    next.predecessorTransactionDigest !== null &&
    !isSameReviewedTaskStrategyLineage(
      transaction,
      readTaskStrategyTransactionByDigest(
        paths,
        next.sessionId,
        next.predecessorTransactionDigest,
      ),
    )
  ) {
    throw revisionStateCorrupt();
  }
}

function currentRefPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
): string {
  return path.join(paths.refs, 'task-strategy-current', `${sessionId}.json`);
}
