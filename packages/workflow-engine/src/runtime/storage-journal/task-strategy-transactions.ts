import type {
  TaskStrategyFrozenFile,
  TaskStrategyTransaction,
  TaskStrategyTransactionInput,
} from '../../modules/assurance/task-strategy-evidence.ts';
export type {
  TaskStrategyFrozenFile,
  TaskStrategyTransaction,
  TaskStrategyTransactionInput,
} from '../../modules/assurance/task-strategy-evidence.ts';
/**
 * Validates and persists immutable task strategy RED transactions by content digest.
 *
 * Invariants:
 * - Canonical transaction bytes, RED evidence checks, and reviewed-lineage comparisons remain exact.
 * - Immutable publication and subsequent reads retain session and record digest validation.
 */
import {
  type ProviderId,
  isProviderId,
} from '../../modules/provider-orchestration/provider-registry.ts';
import {
  type EvidenceNode,
  assertStoredEvidenceNode,
} from '../../foundation/evidence-node/evidence-node.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  assertSessionId,
  normalizeChangedPath,
} from '../../foundation/repository-path/repository-path.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from './investigation-private-files.ts';
import path from 'node:path';
import crypto from 'node:crypto';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

const DIGEST = /^[0-9a-f]{64}$/;

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const TASK_ID = /^\d+(?:\.\d+)+$/;

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/**
 * Build and validate an immutable RED transaction without publishing it. This
 * lets a recovery journal pin the exact successor bytes before any descendant
 * object or current ref becomes durable.
 */
export function prepareTaskStrategyTransaction(
  input: TaskStrategyTransactionInput,
): TaskStrategyTransaction {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-transaction.v1' as const,
    ...input,
  };
  return parseTaskStrategyTransaction({
    ...body,
    recordDigest: sha256(canonicalJson(body)),
  });
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

export function isSameReviewedTaskStrategyLineage(
  successor: TaskStrategyTransaction,
  predecessor: TaskStrategyTransaction | null,
): boolean {
  return (
    predecessor !== null &&
    successor.recordDigest !== predecessor.recordDigest &&
    successor.sessionId === predecessor.sessionId &&
    successor.changeId === predecessor.changeId &&
    successor.taskId === predecessor.taskId &&
    canonicalJson(successor.baseline) === canonicalJson(predecessor.baseline) &&
    successor.strategy === predecessor.strategy &&
    successor.taskContractDigest === predecessor.taskContractDigest &&
    canonicalJson(successor.author) === canonicalJson(predecessor.author) &&
    successor.red.checkId === predecessor.red.checkId &&
    successor.red.runner === predecessor.red.runner &&
    successor.red.runnerDigest === predecessor.red.runnerDigest
  );
}

export function parseTaskStrategyTransaction(
  value: unknown,
): TaskStrategyTransaction {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'sessionId',
      'changeId',
      'taskId',
      'baseline',
      'strategy',
      'phase',
      'taskContractDigest',
      'author',
      'red',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-transaction.v1' ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest) ||
    !isCanonicalSessionId(value.sessionId) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    !isBaseline(value.baseline) ||
    (value.strategy !== 'cross-agent-tdd' &&
      value.strategy !== 'tdd-single-agent') ||
    value.phase !== 'red-sealed' ||
    typeof value.taskContractDigest !== 'string' ||
    !DIGEST.test(value.taskContractDigest) ||
    !isAuthor(value.author) ||
    !isRed(value.red) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw stateCorrupt();
  }
  const { recordDigest, ...body } = value;
  if (recordDigest !== sha256(canonicalJson(body))) throw stateCorrupt();
  return Object.freeze(value as TaskStrategyTransaction);
}

function isBaseline(
  value: unknown,
): value is TaskStrategyTransaction['baseline'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    GIT_OBJECT_ID.test(value.head) &&
    typeof value.tree === 'string' &&
    GIT_OBJECT_ID.test(value.tree)
  );
}

function isAuthor(value: unknown): value is TaskStrategyTransaction['author'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['providerId', 'assurance']) &&
    typeof value.providerId === 'string' &&
    isProviderId(value.providerId) &&
    ['self-declared', 'runtime-hint', 'adapter-assigned'].includes(
      String(value.assurance),
    )
  );
}

function isRed(value: unknown): value is TaskStrategyTransaction['red'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'candidateTree',
      'changedPaths',
      'checkId',
      'runner',
      'runnerDigest',
      'exitCode',
      'failureCategory',
      'selector',
      'testPaths',
      'fixturePaths',
      'files',
      'stdoutDigest',
      'stderrDigest',
      'failureFingerprint',
      'evidenceNodeId',
      'evidenceResultDigest',
      'evidenceNode',
    ]) ||
    typeof value.candidateTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.candidateTree) ||
    !isSortedPaths(value.changedPaths, false) ||
    typeof value.checkId !== 'string' ||
    value.checkId.length === 0 ||
    typeof value.runner !== 'string' ||
    value.runner.length === 0 ||
    typeof value.runnerDigest !== 'string' ||
    !DIGEST.test(value.runnerDigest) ||
    !Number.isSafeInteger(value.exitCode) ||
    (value.exitCode as number) === 0 ||
    (value.failureCategory !== 'assertion' &&
      value.failureCategory !== 'behavior-mismatch') ||
    typeof value.selector !== 'string' ||
    value.selector.length === 0 ||
    !isSortedPaths(value.testPaths, true) ||
    !isSortedPaths(value.fixturePaths, false) ||
    !isFrozenFiles(value.files) ||
    !isDigest(value.stdoutDigest) ||
    !isDigest(value.stderrDigest) ||
    !isDigest(value.failureFingerprint) ||
    !isDigest(value.evidenceNodeId) ||
    !isDigest(value.evidenceResultDigest)
  ) {
    return false;
  }
  let evidenceNode: EvidenceNode;
  try {
    evidenceNode = assertStoredEvidenceNode(value.evidenceNode, stateCorrupt);
  } catch {
    return false;
  }
  return (
    evidenceNode.type === 'task-strategy-red-evidence' &&
    evidenceNode.nodeId === value.evidenceNodeId &&
    evidenceNode.resultDigest === value.evidenceResultDigest
  );
}

function isFrozenFiles(
  value: unknown,
): value is readonly TaskStrategyFrozenFile[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['path', 'mode', 'objectId']) &&
        isCanonicalPath(entry.path) &&
        (entry.mode === '100644' || entry.mode === '100755') &&
        typeof entry.objectId === 'string' &&
        GIT_OBJECT_ID.test(entry.objectId),
    ) &&
    value.every(
      (entry, index) => index === 0 || value[index - 1]!.path < entry.path,
    )
  );
}

function isSortedPaths(value: unknown, nonEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (!nonEmpty || value.length > 0) &&
    value.length <= 1024 &&
    value.every((entry) => isCanonicalPath(entry)) &&
    value.every((entry, index) => index === 0 || value[index - 1]! < entry)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isCanonicalSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertSessionId(value) === value;
  } catch {
    return false;
  }
}

function isCanonicalPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return normalizeChangedPath(value) === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function stateCorrupt() {
  return workflowError(
    'TASK_STRATEGY_STATE_CORRUPT',
    'Task strategy transaction state is malformed or unsafe.',
    ExitCode.staleState,
  );
}
