/**
 * Validates revision requests and digest-bound RED recovery journal states.
 *
 * Invariants:
 * - Canonical bodies retain exact field order, digest binding, and nullable phase payloads.
 * - Successor, restoration, and session-evidence transitions remain bound to the original request.
 *
 * Depends on: RED revision phases, current-ref contracts, and immutable transaction codecs.
 * Failure modes: forged journal transitions, changed replay bytes, or recovery applied to another RED lineage.
 */
import {
  type TaskStrategyTransaction,
  parseTaskStrategyTransaction,
} from './task-strategy-transactions.ts';
import {
  type TaskStrategyRedRevisionPhase,
  revisionRequestInvalid,
  sha256,
  isRecord,
  hasExactKeys,
  isDigest,
  isRevisionId,
  isCanonicalSessionId,
  isRevisionPhase,
  isTimestamp,
  revisionStateCorrupt,
  TASK_STRATEGY_RED_REVISION_PHASES,
  revisionPhaseInvalid,
  MAX_REASON_BYTES,
  containsControlCharacter,
  isGitObjectId,
  CHANGE_ID,
  TASK_ID,
} from './task-strategy-red-revision-values.ts';
import {
  type TaskStrategyCurrentRef,
  parseTaskStrategyCurrentRef,
} from './task-strategy-current-ref.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { WorkflowError } from '../../foundation/errors/errors.ts';
import { isProviderId } from '../../modules/provider-orchestration/provider-registry.ts';

export type TaskStrategyRedRevisionRequest = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-red-revision-request';
  sessionId: string;
  expectedTransactionDigest: string;
  reason: string;
}>;

export type TaskStrategyRedRevisionRequestSnapshot = Readonly<{
  revisionId: string;
  requestDigest: string;
  request: TaskStrategyRedRevisionRequest;
}>;

export type TaskStrategyRedRevisionJournalState = Readonly<{
  revisionId: string;
  sessionId: string;
  phase: TaskStrategyRedRevisionPhase;
  request: TaskStrategyRedRevisionRequest;
  requestDigest: string;
  predecessor: Readonly<{
    transactionDigest: string;
    candidateTree: string;
    currentRefDigest: string;
  }>;
  binding: Readonly<{
    changeId: string;
    taskId: string;
    baseline: Readonly<{ head: string; tree: string }>;
    strategy: TaskStrategyTransaction['strategy'];
    taskContractDigest: string;
    checkId: string;
    runner: string;
    runnerDigest: string;
    author: TaskStrategyTransaction['author'];
  }>;
  restoration: Readonly<{
    sourceTree: string;
    implementationCandidateTree: string | null;
    patchRecordDigest: string | null;
    patchDigest: string | null;
  }>;
  sessionTransition: Readonly<{
    before: Readonly<Record<string, unknown>>;
    beforeDigest: string;
    after: Readonly<Record<string, unknown>>;
    afterDigest: string;
  }>;
  authoringRef: TaskStrategyCurrentRef;
  successorTransaction: TaskStrategyTransaction | null;
  successorRef: TaskStrategyCurrentRef | null;
  createdAt: string;
  updatedAt: string;
}>;

export type TaskStrategyRedRevisionJournal =
  TaskStrategyRedRevisionJournalState &
    Readonly<{
      schemaVersion: 1;
      kind: 'task-strategy-red-revision-journal.v1';
      journalDigest: string;
      previousJournalDigest: string | null;
    }>;

export type ActiveTaskStrategyRedRevision = Readonly<{
  request: TaskStrategyRedRevisionRequest;
  journal: TaskStrategyRedRevisionJournal | null;
}>;

export function parseTaskStrategyRedRevisionRequest(
  value: unknown,
): TaskStrategyRedRevisionRequest {
  return parseRevisionRequest(value, revisionRequestInvalid);
}

export function taskStrategyRedRevisionRequestDigest(
  request: TaskStrategyRedRevisionRequest,
): string {
  return sha256(
    canonicalJson(parseRevisionRequest(request, revisionRequestInvalid)),
  );
}

export function taskStrategyRedRevisionId(
  request: TaskStrategyRedRevisionRequest,
): string {
  return `red-revision-${taskStrategyRedRevisionRequestDigest(request)}`;
}

export function taskStrategyRedRevisionSnapshotDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function parseTaskStrategyRedRevisionJournal(
  value: unknown,
): TaskStrategyRedRevisionJournal {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'journalDigest',
      'previousJournalDigest',
      'revisionId',
      'sessionId',
      'phase',
      'request',
      'requestDigest',
      'predecessor',
      'binding',
      'restoration',
      'sessionTransition',
      'authoringRef',
      'successorTransaction',
      'successorRef',
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-red-revision-journal.v1' ||
    !isDigest(value.journalDigest) ||
    (value.previousJournalDigest !== null &&
      !isDigest(value.previousJournalDigest)) ||
    !isRevisionId(value.revisionId) ||
    !isCanonicalSessionId(value.sessionId) ||
    !isRevisionPhase(value.phase) ||
    !isDigest(value.requestDigest) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    throw revisionStateCorrupt();
  }
  if ((value.phase === 'prepared') !== (value.previousJournalDigest === null)) {
    throw revisionStateCorrupt();
  }

  const request = parseRevisionRequest(value.request, revisionStateCorrupt);
  const predecessor = parsePredecessor(value.predecessor);
  const binding = parseBinding(value.binding);
  const restoration = parseRestoration(value.restoration);
  const sessionTransition = parseSessionTransition(value.sessionTransition);
  const authoringRef = parseTaskStrategyCurrentRef(value.authoringRef);
  const successorTransaction = parseNullableTransaction(
    value.successorTransaction,
  );
  const successorRef = parseNullableCurrentRef(value.successorRef);

  const journal = value as unknown as TaskStrategyRedRevisionJournal;
  if (
    request.sessionId !== journal.sessionId ||
    taskStrategyRedRevisionRequestDigest(request) !== journal.requestDigest ||
    taskStrategyRedRevisionId(request) !== journal.revisionId ||
    request.expectedTransactionDigest !== predecessor.transactionDigest ||
    restoration.sourceTree !== predecessor.candidateTree ||
    authoringRef.sessionId !== journal.sessionId ||
    authoringRef.state !== 'red-authoring' ||
    authoringRef.predecessorTransactionDigest !==
      predecessor.transactionDigest ||
    authoringRef.revisionId !== journal.revisionId ||
    authoringRef.taskContractDigest !== binding.taskContractDigest ||
    sessionTransition.before.sessionId !== journal.sessionId ||
    sessionTransition.beforeDigest !==
      taskStrategyRedRevisionSnapshotDigest(sessionTransition.before) ||
    sessionTransition.after.sessionId !== journal.sessionId ||
    sessionTransition.afterDigest !==
      taskStrategyRedRevisionSnapshotDigest(sessionTransition.after) ||
    !isExactSessionEvidenceClearingTransition(sessionTransition) ||
    !journalPhasePayloadIsValid(
      journal.phase,
      sessionTransition,
      successorTransaction,
      successorRef,
    ) ||
    !successorBindingIsValid(
      journal.sessionId,
      predecessor,
      binding,
      successorTransaction,
      successorRef,
      journal.revisionId,
    )
  ) {
    throw revisionStateCorrupt();
  }

  const { journalDigest, ...body } = value;
  if (journalDigest !== sha256(canonicalJson(body))) {
    throw revisionStateCorrupt();
  }
  return Object.freeze({
    ...journal,
    request,
    predecessor,
    binding,
    restoration,
    sessionTransition,
    authoringRef,
    successorTransaction,
    successorRef,
  });
}

export function buildRevisionJournal(
  input: TaskStrategyRedRevisionJournalState,
  previousJournalDigest: string | null,
): TaskStrategyRedRevisionJournal {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-red-revision-journal.v1' as const,
    previousJournalDigest,
    revisionId: input.revisionId,
    sessionId: input.sessionId,
    phase: input.phase,
    request: input.request,
    requestDigest: input.requestDigest,
    predecessor: input.predecessor,
    binding: input.binding,
    restoration: input.restoration,
    sessionTransition: input.sessionTransition,
    authoringRef: input.authoringRef,
    successorTransaction: input.successorTransaction,
    successorRef: input.successorRef,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
  return parseTaskStrategyRedRevisionJournal({
    ...body,
    journalDigest: sha256(canonicalJson(body)),
  });
}

export function assertNextJournalState(
  current: TaskStrategyRedRevisionJournal,
  next: TaskStrategyRedRevisionJournalState,
): void {
  const currentIndex = TASK_STRATEGY_RED_REVISION_PHASES.indexOf(current.phase);
  const nextIndex = TASK_STRATEGY_RED_REVISION_PHASES.indexOf(next.phase);
  if (nextIndex !== currentIndex + 1) throw revisionPhaseInvalid();
  if (
    next.revisionId !== current.revisionId ||
    next.sessionId !== current.sessionId ||
    canonicalJson(next.request) !== canonicalJson(current.request) ||
    next.requestDigest !== current.requestDigest ||
    canonicalJson(next.predecessor) !== canonicalJson(current.predecessor) ||
    canonicalJson(next.binding) !== canonicalJson(current.binding) ||
    canonicalJson(next.restoration) !== canonicalJson(current.restoration) ||
    canonicalJson(next.authoringRef) !== canonicalJson(current.authoringRef) ||
    next.createdAt !== current.createdAt ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    canonicalJson(next.sessionTransition.before) !==
      canonicalJson(current.sessionTransition.before) ||
    next.sessionTransition.beforeDigest !==
      current.sessionTransition.beforeDigest ||
    canonicalJson(next.sessionTransition.after) !==
      canonicalJson(current.sessionTransition.after) ||
    next.sessionTransition.afterDigest !==
      current.sessionTransition.afterDigest ||
    (current.successorTransaction !== null &&
      canonicalJson(next.successorTransaction) !==
        canonicalJson(current.successorTransaction)) ||
    (current.successorRef !== null &&
      canonicalJson(next.successorRef) !== canonicalJson(current.successorRef))
  ) {
    throw revisionStateCorrupt();
  }
}

export function sameJournalState(
  current: TaskStrategyRedRevisionJournal,
  next: TaskStrategyRedRevisionJournalState,
): boolean {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    journalDigest: _journalDigest,
    previousJournalDigest: _previousJournalDigest,
    ...state
  } = current;
  return canonicalJson(state) === canonicalJson(next);
}

function journalPhasePayloadIsValid(
  phase: TaskStrategyRedRevisionPhase,
  sessionTransition: TaskStrategyRedRevisionJournal['sessionTransition'],
  successorTransaction: TaskStrategyTransaction | null,
  successorRef: TaskStrategyCurrentRef | null,
): boolean {
  const index = TASK_STRATEGY_RED_REVISION_PHASES.indexOf(phase);
  const resealPrepared =
    TASK_STRATEGY_RED_REVISION_PHASES.indexOf('reseal-prepared');
  return index < resealPrepared
    ? successorTransaction === null && successorRef === null
    : successorTransaction !== null && successorRef !== null;
}

function successorBindingIsValid(
  sessionId: string,
  predecessor: TaskStrategyRedRevisionJournal['predecessor'],
  binding: TaskStrategyRedRevisionJournal['binding'],
  successor: TaskStrategyTransaction | null,
  successorRef: TaskStrategyCurrentRef | null,
  revisionId: string,
): boolean {
  if (successor === null || successorRef === null) {
    return successor === null && successorRef === null;
  }
  return (
    successor.sessionId === sessionId &&
    successor.recordDigest !== predecessor.transactionDigest &&
    successor.changeId === binding.changeId &&
    successor.taskId === binding.taskId &&
    canonicalJson(successor.baseline) === canonicalJson(binding.baseline) &&
    successor.strategy === binding.strategy &&
    successor.taskContractDigest === binding.taskContractDigest &&
    canonicalJson(successor.author) === canonicalJson(binding.author) &&
    successor.red.checkId === binding.checkId &&
    successor.red.runner === binding.runner &&
    successor.red.runnerDigest === binding.runnerDigest &&
    successorRef.sessionId === sessionId &&
    successorRef.state === 'red-sealed' &&
    successorRef.transactionDigest === successor.recordDigest &&
    successorRef.predecessorTransactionDigest ===
      predecessor.transactionDigest &&
    successorRef.revisionId === revisionId &&
    successorRef.taskContractDigest === binding.taskContractDigest
  );
}

export function parseRevisionRequest(
  value: unknown,
  invalid: () => WorkflowError,
): TaskStrategyRedRevisionRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'sessionId',
      'expectedTransactionDigest',
      'reason',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-red-revision-request' ||
    !isCanonicalSessionId(value.sessionId) ||
    !isDigest(value.expectedTransactionDigest) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length === 0 ||
    Buffer.byteLength(value.reason, 'utf8') > MAX_REASON_BYTES ||
    containsControlCharacter(value.reason)
  ) {
    throw invalid();
  }
  return Object.freeze(value as TaskStrategyRedRevisionRequest);
}

export function requestSnapshot(
  request: TaskStrategyRedRevisionRequest,
): TaskStrategyRedRevisionRequestSnapshot {
  const requestDigest = taskStrategyRedRevisionRequestDigest(request);
  return Object.freeze({
    revisionId: `red-revision-${requestDigest}`,
    requestDigest,
    request,
  });
}

function parsePredecessor(
  value: unknown,
): TaskStrategyRedRevisionJournal['predecessor'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'transactionDigest',
      'candidateTree',
      'currentRefDigest',
    ]) ||
    !isDigest(value.transactionDigest) ||
    !isGitObjectId(value.candidateTree) ||
    !isDigest(value.currentRefDigest)
  ) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(
    value as unknown as TaskStrategyRedRevisionJournal['predecessor'],
  );
}

function parseBinding(
  value: unknown,
): TaskStrategyRedRevisionJournal['binding'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'taskId',
      'baseline',
      'strategy',
      'taskContractDigest',
      'checkId',
      'runner',
      'runnerDigest',
      'author',
    ]) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    !isBaseline(value.baseline) ||
    (value.strategy !== 'cross-agent-tdd' &&
      value.strategy !== 'tdd-single-agent') ||
    !isDigest(value.taskContractDigest) ||
    typeof value.checkId !== 'string' ||
    value.checkId.length === 0 ||
    typeof value.runner !== 'string' ||
    value.runner.length === 0 ||
    !isDigest(value.runnerDigest) ||
    !isAuthor(value.author)
  ) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(
    value as unknown as TaskStrategyRedRevisionJournal['binding'],
  );
}

function parseRestoration(
  value: unknown,
): TaskStrategyRedRevisionJournal['restoration'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'sourceTree',
      'implementationCandidateTree',
      'patchRecordDigest',
      'patchDigest',
    ]) ||
    !isGitObjectId(value.sourceTree) ||
    (value.implementationCandidateTree !== null &&
      !isGitObjectId(value.implementationCandidateTree)) ||
    (value.patchRecordDigest !== null && !isDigest(value.patchRecordDigest)) ||
    (value.patchDigest !== null && !isDigest(value.patchDigest)) ||
    ((value.implementationCandidateTree === null ||
      value.patchRecordDigest === null ||
      value.patchDigest === null) &&
      (value.implementationCandidateTree !== null ||
        value.patchRecordDigest !== null ||
        value.patchDigest !== null))
  ) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(
    value as unknown as TaskStrategyRedRevisionJournal['restoration'],
  );
}

function parseSessionTransition(
  value: unknown,
): TaskStrategyRedRevisionJournal['sessionTransition'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['before', 'beforeDigest', 'after', 'afterDigest']) ||
    !isRecord(value.before) ||
    !isDigest(value.beforeDigest) ||
    !isRecord(value.after) ||
    !isDigest(value.afterDigest)
  ) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(
    value as unknown as TaskStrategyRedRevisionJournal['sessionTransition'],
  );
}

function isExactSessionEvidenceClearingTransition(
  transition: TaskStrategyRedRevisionJournal['sessionTransition'],
): boolean {
  const expected = { ...transition.before };
  delete expected.latestCheckReportId;
  delete expected.checkEvidenceEngineDigest;
  delete expected.implementationReconciliationReportId;
  delete expected.implementationReconciliationPaths;
  return canonicalJson(expected) === canonicalJson(transition.after);
}

function parseNullableTransaction(
  value: unknown,
): TaskStrategyTransaction | null {
  if (value === null) return null;
  try {
    return parseTaskStrategyTransaction(value);
  } catch {
    throw revisionStateCorrupt();
  }
}

function parseNullableCurrentRef(
  value: unknown,
): TaskStrategyCurrentRef | null {
  return value === null ? null : parseTaskStrategyCurrentRef(value);
}

function isBaseline(
  value: unknown,
): value is TaskStrategyTransaction['baseline'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    isGitObjectId(value.head) &&
    isGitObjectId(value.tree)
  );
}

function isAuthor(value: unknown): value is TaskStrategyTransaction['author'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['providerId', 'assurance']) &&
    typeof value.providerId === 'string' &&
    isProviderId(value.providerId) &&
    (value.assurance === 'self-declared' ||
      value.assurance === 'runtime-hint' ||
      value.assurance === 'adapter-assigned')
  );
}
