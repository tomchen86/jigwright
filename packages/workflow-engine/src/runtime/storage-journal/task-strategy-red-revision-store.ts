/**
 * Persists RED revision requests and advances their durable recovery journals.
 *
 * Invariants:
 * - Request, predecessor, and phase checks retain their original order before publication.
 * - Journal compare-and-swap and exact replay preserve immutable prior state and current-ref authority.
 */
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  assertPrivateInvestigationDirectory,
  writePrivateCanonicalJsonAtomic,
} from '../journal-primitives/investigation-private-files.ts';
import {
  type TaskStrategyRedRevisionRequest,
  type TaskStrategyRedRevisionRequestSnapshot,
  parseRevisionRequest,
  requestSnapshot,
  type TaskStrategyRedRevisionJournalState,
  type TaskStrategyRedRevisionJournal,
  buildRevisionJournal,
  parseTaskStrategyRedRevisionJournal,
  type ActiveTaskStrategyRedRevision,
  sameJournalState,
  assertNextJournalState,
} from '../../modules/assurance/task-strategy-red-revision-contract.ts';
import {
  revisionRequestInvalid,
  revisionStateCorrupt,
  assertRevisionId,
  revisionPhaseInvalid,
  isRevisionId,
  DIGEST,
} from '../../modules/assurance/task-strategy-red-revision-values.ts';
import path from 'node:path';
import fs from 'node:fs';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { readTaskStrategyTransactionByDigest } from './task-strategy-transactions.ts';
import { readTaskStrategyCurrentRef } from './task-strategy-current-ref.ts';

export {
  TASK_STRATEGY_RED_REVISION_PHASES,
  type TaskStrategyRedRevisionPhase,
} from '../../modules/assurance/task-strategy-red-revision-values.ts';
export {
  type TaskStrategyRedRevisionRequest,
  type TaskStrategyRedRevisionRequestSnapshot,
  type TaskStrategyRedRevisionJournalState,
  type TaskStrategyRedRevisionJournal,
  type ActiveTaskStrategyRedRevision,
  parseTaskStrategyRedRevisionRequest,
  taskStrategyRedRevisionRequestDigest,
  taskStrategyRedRevisionId,
  taskStrategyRedRevisionSnapshotDigest,
  parseTaskStrategyRedRevisionJournal,
} from '../../modules/assurance/task-strategy-red-revision-contract.ts';
export {
  type TaskStrategyCurrentRef,
  type TaskStrategyCurrentRefInput,
  createTaskStrategyCurrentRef,
  parseTaskStrategyCurrentRef,
  readTaskStrategyCurrentRef,
  compareAndSwapTaskStrategyCurrentRef,
} from './task-strategy-current-ref.ts';

export function persistTaskStrategyRedRevisionRequest(
  paths: InvestigationRuntimePaths,
  input: TaskStrategyRedRevisionRequest,
): TaskStrategyRedRevisionRequestSnapshot {
  const request = parseRevisionRequest(input, revisionRequestInvalid);
  const snapshot = requestSnapshot(request);
  createPrivateCanonicalJson(
    paths,
    revisionRequestPath(paths, request.sessionId, snapshot.revisionId),
    request,
    revisionStateCorrupt,
    'TASK_STRATEGY_RED_REVISION_REQUEST_CONFLICT',
  );
  const stored = readTaskStrategyRedRevisionRequest(
    paths,
    request.sessionId,
    snapshot.revisionId,
  );
  if (stored === null) throw revisionStateCorrupt();
  return stored;
}

export function readTaskStrategyRedRevisionRequest(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedRevisionId: string,
): TaskStrategyRedRevisionRequestSnapshot | null {
  const sessionId = assertSessionId(requestedSessionId);
  const revisionId = assertRevisionId(requestedRevisionId);
  const target = revisionRequestPath(paths, sessionId, revisionId);
  if (!privatePathExists(paths, target, revisionStateCorrupt)) return null;
  const request = parseRevisionRequest(
    readPrivateCanonicalJson(paths, target, revisionStateCorrupt),
    revisionStateCorrupt,
  );
  const snapshot = requestSnapshot(request);
  if (request.sessionId !== sessionId || snapshot.revisionId !== revisionId) {
    throw revisionStateCorrupt();
  }
  return snapshot;
}

export function createTaskStrategyRedRevisionJournal(
  paths: InvestigationRuntimePaths,
  input: TaskStrategyRedRevisionJournalState,
): TaskStrategyRedRevisionJournal {
  if (input.phase !== 'prepared') throw revisionPhaseInvalid();
  const journal = buildRevisionJournal(input, null);
  assertPersistedRequestMatchesJournal(paths, journal);
  assertPreparedJournalPredecessor(paths, journal);
  createPrivateCanonicalJson(
    paths,
    revisionJournalPath(paths, journal.sessionId, journal.revisionId),
    journal,
    revisionStateCorrupt,
    'TASK_STRATEGY_RED_REVISION_JOURNAL_CONFLICT',
  );
  const stored = readTaskStrategyRedRevisionJournal(
    paths,
    journal.sessionId,
    journal.revisionId,
  );
  if (stored === null) throw revisionStateCorrupt();
  return stored;
}

export function readTaskStrategyRedRevisionJournal(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedRevisionId: string,
): TaskStrategyRedRevisionJournal | null {
  const sessionId = assertSessionId(requestedSessionId);
  const revisionId = assertRevisionId(requestedRevisionId);
  const target = revisionJournalPath(paths, sessionId, revisionId);
  if (!privatePathExists(paths, target, revisionStateCorrupt)) return null;
  const journal = parseTaskStrategyRedRevisionJournal(
    readPrivateCanonicalJson(paths, target, revisionStateCorrupt),
  );
  if (journal.sessionId !== sessionId || journal.revisionId !== revisionId) {
    throw revisionStateCorrupt();
  }
  assertPersistedRequestMatchesJournal(paths, journal);
  return journal;
}

/**
 * Discover the one incomplete RED revision independently of the mutable
 * current ref. The request is the first durable record, so this also recovers
 * crashes before journal creation or before current-ref publication.
 */
export function readActiveTaskStrategyRedRevision(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): ActiveTaskStrategyRedRevision | null {
  const sessionId = assertSessionId(requestedSessionId);
  const root = path.join(paths.refs, 'task-strategy-red-revisions');
  const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (rootStats === undefined) return null;
  assertPrivateInvestigationDirectory(paths, root, revisionStateCorrupt);

  const sessionDirectory = path.join(root, sessionId);
  const sessionStats = fs.lstatSync(sessionDirectory, {
    throwIfNoEntry: false,
  });
  if (sessionStats === undefined) return null;
  assertPrivateInvestigationDirectory(
    paths,
    sessionDirectory,
    revisionStateCorrupt,
  );

  const active: ActiveTaskStrategyRedRevision[] = [];
  const entries = fs
    .readdirSync(sessionDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !isRevisionId(entry.name)
    ) {
      throw revisionStateCorrupt();
    }
    const directory = revisionDirectory(paths, sessionId, entry.name);
    assertPrivateInvestigationDirectory(paths, directory, revisionStateCorrupt);
    const artifacts = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    const names = artifacts.map(({ name }) => name);
    if (
      artifacts.some(
        (artifact) => artifact.isSymbolicLink() || !artifact.isFile(),
      ) ||
      (canonicalJson(names) !== canonicalJson(['request.json']) &&
        canonicalJson(names) !==
          canonicalJson(['journal.json', 'request.json']))
    ) {
      throw revisionStateCorrupt();
    }
    const requestSnapshot = readTaskStrategyRedRevisionRequest(
      paths,
      sessionId,
      entry.name,
    );
    if (requestSnapshot === null) throw revisionStateCorrupt();
    const journal = names.includes('journal.json')
      ? readTaskStrategyRedRevisionJournal(paths, sessionId, entry.name)
      : null;
    if (names.includes('journal.json') && journal === null) {
      throw revisionStateCorrupt();
    }
    if (journal?.phase !== 'completed') {
      active.push(Object.freeze({ request: requestSnapshot.request, journal }));
      if (active.length > 1) throw revisionStateCorrupt();
    }
  }
  return active[0] ?? null;
}

export function updateTaskStrategyRedRevisionJournal(
  paths: InvestigationRuntimePaths,
  input: Readonly<{
    sessionId: string;
    revisionId: string;
    expectedJournalDigest: string;
    next: TaskStrategyRedRevisionJournalState;
  }>,
): TaskStrategyRedRevisionJournal {
  const sessionId = assertSessionId(input.sessionId);
  const revisionId = assertRevisionId(input.revisionId);
  if (!DIGEST.test(input.expectedJournalDigest)) throw revisionStateCorrupt();
  const current = readTaskStrategyRedRevisionJournal(
    paths,
    sessionId,
    revisionId,
  );
  if (current === null) throw revisionStateCorrupt();
  if (sameJournalState(current, input.next)) return current;
  if (current.journalDigest !== input.expectedJournalDigest) {
    throw workflowError(
      'TASK_STRATEGY_RED_REVISION_JOURNAL_CAS_MISMATCH',
      'Task strategy RED revision journal changed during compare-and-swap.',
      ExitCode.conflict,
      {
        details: {
          expectedJournalDigest: input.expectedJournalDigest,
          observedJournalDigest: current.journalDigest,
        },
      },
    );
  }
  assertNextJournalState(current, input.next);
  const next = buildRevisionJournal(input.next, current.journalDigest);
  writePrivateCanonicalJsonAtomic(
    paths,
    revisionJournalPath(paths, sessionId, revisionId),
    next,
    revisionStateCorrupt,
  );
  const published = readTaskStrategyRedRevisionJournal(
    paths,
    sessionId,
    revisionId,
  );
  if (published?.journalDigest !== next.journalDigest) {
    throw revisionStateCorrupt();
  }
  return published;
}

function assertPersistedRequestMatchesJournal(
  paths: InvestigationRuntimePaths,
  journal: TaskStrategyRedRevisionJournal,
): void {
  const request = readTaskStrategyRedRevisionRequest(
    paths,
    journal.sessionId,
    journal.revisionId,
  );
  if (
    request === null ||
    request.requestDigest !== journal.requestDigest ||
    canonicalJson(request.request) !== canonicalJson(journal.request)
  ) {
    throw revisionStateCorrupt();
  }
}

function assertPreparedJournalPredecessor(
  paths: InvestigationRuntimePaths,
  journal: TaskStrategyRedRevisionJournal,
): void {
  const predecessor = readTaskStrategyTransactionByDigest(
    paths,
    journal.sessionId,
    journal.predecessor.transactionDigest,
  );
  if (
    predecessor === null ||
    predecessor.red.candidateTree !== journal.predecessor.candidateTree ||
    predecessor.changeId !== journal.binding.changeId ||
    predecessor.taskId !== journal.binding.taskId ||
    canonicalJson(predecessor.baseline) !==
      canonicalJson(journal.binding.baseline) ||
    predecessor.strategy !== journal.binding.strategy ||
    predecessor.taskContractDigest !== journal.binding.taskContractDigest ||
    predecessor.red.checkId !== journal.binding.checkId ||
    predecessor.red.runner !== journal.binding.runner ||
    predecessor.red.runnerDigest !== journal.binding.runnerDigest ||
    canonicalJson(predecessor.author) !== canonicalJson(journal.binding.author)
  ) {
    throw revisionStateCorrupt();
  }
  const current = readTaskStrategyCurrentRef(paths, journal.sessionId);
  if (
    current === null ||
    current.refDigest !== journal.predecessor.currentRefDigest ||
    current.state !== 'red-sealed' ||
    current.transactionDigest !== predecessor.recordDigest
  ) {
    throw workflowError(
      'TASK_STRATEGY_CURRENT_REF_CAS_MISMATCH',
      'Task strategy current ref changed before RED revision preparation.',
      ExitCode.conflict,
      {
        details: {
          expectedRefDigest: journal.predecessor.currentRefDigest,
          observedRefDigest: current?.refDigest ?? null,
        },
      },
    );
  }
}

function revisionDirectory(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  revisionId: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-red-revisions',
    sessionId,
    revisionId,
  );
}

function revisionRequestPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  revisionId: string,
): string {
  return path.join(
    revisionDirectory(paths, sessionId, revisionId),
    'request.json',
  );
}

function revisionJournalPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  revisionId: string,
): string {
  return path.join(
    revisionDirectory(paths, sessionId, revisionId),
    'journal.json',
  );
}
