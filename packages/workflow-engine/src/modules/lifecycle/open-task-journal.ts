/** Journal schema, stable transaction identity and phase rules without external effects. */
import crypto from 'node:crypto';
import path from 'node:path';
import type { OpenTaskPhase } from './open-task-status.ts';
import type { TaskMandateBinding } from '../authority/task-mandate-contract.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  assertChangeId,
  assertTaskId,
  normalizeChangedPath,
} from '../../foundation/repository-path/repository-path.ts';

export const OPEN_TASK_COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const SHA256 = /^[0-9a-f]{64}$/;

const SHA256_PREFIX = /^sha256:[0-9a-f]{64}$/;

const MANDATE_TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MANDATE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type OpenTaskJournal = Readonly<{
  schemaVersion: 2;
  kind: 'open-task-transaction.v2';
  transactionId: string;
  phase: OpenTaskPhase;
  changeId: string;
  taskId: string;
  mandateTaskId: string | null;
  mandateBinding: TaskMandateBinding | null;
  authorizationPolicyDigest: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  worktree: string;
  branch: string;
  parentCommit: string;
  parentTree: string;
  planningCommit: string;
  baselineTree: string;
  reportId: string;
  changedPaths: readonly string[];
  sessionId: string;
  createdAt: string;
  completedAt: string | null;
}>;

export function createPreparedOpenTaskJournal(
  input: Omit<
    OpenTaskJournal,
    'schemaVersion' | 'kind' | 'transactionId' | 'phase' | 'completedAt'
  >,
): OpenTaskJournal {
  const stable = {
    schemaVersion: 2 as const,
    kind: 'open-task-transaction.v2' as const,
    changeId: input.changeId,
    taskId: input.taskId,
    mandateTaskId: input.mandateTaskId,
    mandateBinding: structuredClone(input.mandateBinding),
    authorizationPolicyDigest: input.authorizationPolicyDigest,
    repositoryRoot: input.repositoryRoot,
    gitCommonDirectory: input.gitCommonDirectory,
    worktree: input.worktree,
    branch: input.branch,
    parentCommit: input.parentCommit,
    parentTree: input.parentTree,
    planningCommit: input.planningCommit,
    baselineTree: input.baselineTree,
    reportId: input.reportId,
    changedPaths: [...input.changedPaths],
    sessionId: input.sessionId,
    createdAt: input.createdAt,
  };
  return parseOpenTaskJournal({
    ...stable,
    transactionId: transactionDigest(stable),
    phase: 'prepared',
    completedAt: null,
  });
}

export function advanceOpenTaskJournalPhase(
  journal: OpenTaskJournal,
  nextPhase: 'plan-committed' | 'session-active',
): OpenTaskJournal {
  const expectedCurrent =
    nextPhase === 'plan-committed' ? 'prepared' : 'plan-committed';
  if (journal.phase !== expectedCurrent) {
    throw openTaskPhaseDiverged(
      `Open-task cannot advance from ${journal.phase} to ${nextPhase}.`,
    );
  }
  const next = parseOpenTaskJournal({ ...journal, phase: nextPhase });
  return next;
}

export function assertOpenTaskCompletionPhase(journal: OpenTaskJournal): void {
  if (journal.phase !== 'session-active') {
    throw openTaskPhaseDiverged(
      'Open-task cannot complete before its exact session-active phase.',
    );
  }
}

export function parseOpenTaskJournal(input: unknown): OpenTaskJournal {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw openTaskUnsafe('Open-task journal is not JSON.');
    }
  }
  if (!isRecord(value)) throw openTaskUnsafe('Open-task journal is malformed.');
  const commonKeys = [
    'authorizationPolicyDigest',
    'baselineTree',
    'branch',
    'changeId',
    'changedPaths',
    'completedAt',
    'createdAt',
    'gitCommonDirectory',
    'kind',
    'mandateBinding',
    'mandateTaskId',
    'parentCommit',
    'parentTree',
    'phase',
    'planningCommit',
    'reportId',
    'repositoryRoot',
    'schemaVersion',
    'sessionId',
    'taskId',
    'transactionId',
    'worktree',
  ];
  const expectedKeys = commonKeys.sort();
  if (
    Object.keys(value).sort().join('\0') !== expectedKeys.join('\0') ||
    value.schemaVersion !== 2 ||
    value.kind !== 'open-task-transaction.v2' ||
    (value.phase !== 'prepared' &&
      value.phase !== 'plan-committed' &&
      value.phase !== 'session-active' &&
      value.phase !== 'completed') ||
    typeof value.transactionId !== 'string' ||
    !SHA256.test(value.transactionId) ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    (value.mandateTaskId !== null &&
      (typeof value.mandateTaskId !== 'string' ||
        !MANDATE_TASK_ID.test(value.mandateTaskId))) ||
    typeof value.authorizationPolicyDigest !== 'string' ||
    !SHA256_PREFIX.test(value.authorizationPolicyDigest) ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.gitCommonDirectory !== 'string' ||
    typeof value.worktree !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.parentCommit !== 'string' ||
    !OPEN_TASK_COMMIT_OID.test(value.parentCommit) ||
    typeof value.parentTree !== 'string' ||
    !OPEN_TASK_COMMIT_OID.test(value.parentTree) ||
    typeof value.planningCommit !== 'string' ||
    !OPEN_TASK_COMMIT_OID.test(value.planningCommit) ||
    typeof value.baselineTree !== 'string' ||
    !OPEN_TASK_COMMIT_OID.test(value.baselineTree) ||
    typeof value.reportId !== 'string' ||
    !SHA256.test(value.reportId) ||
    !Array.isArray(value.changedPaths) ||
    value.changedPaths.some((entry) => typeof entry !== 'string') ||
    typeof value.sessionId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    (value.completedAt !== null && typeof value.completedAt !== 'string') ||
    (value.phase !== 'completed' && value.completedAt !== null) ||
    (value.phase === 'completed' && value.completedAt === null)
  ) {
    throw openTaskUnsafe('Open-task journal is malformed.');
  }
  const changeId = assertChangeId(value.changeId);
  const taskId = assertTaskId(value.taskId);
  const changedPaths = value.changedPaths.map((entry) =>
    normalizeChangedPath(entry as string),
  );
  if (
    canonicalJson(changedPaths) !==
      canonicalJson([...new Set(changedPaths)].sort()) ||
    !path.isAbsolute(value.repositoryRoot) ||
    !path.isAbsolute(value.gitCommonDirectory) ||
    !path.isAbsolute(value.worktree)
  ) {
    throw openTaskUnsafe('Open-task journal identity is malformed.');
  }
  const mandateBinding =
    value.mandateBinding === null
      ? null
      : parseMandateBinding(value.mandateBinding);
  const createdAt = exactOpenTaskTimestamp(new Date(value.createdAt));
  const completedAt =
    value.completedAt === null
      ? null
      : exactOpenTaskTimestamp(new Date(value.completedAt));
  if (
    createdAt !== value.createdAt ||
    completedAt !== value.completedAt ||
    (mandateBinding === null) !== (value.mandateTaskId === null) ||
    (mandateBinding !== null &&
      (mandateBinding.mandateTaskId !== value.mandateTaskId ||
        mandateBinding.changeId !== changeId))
  ) {
    throw openTaskUnsafe('Open-task journal bindings are not exact.');
  }
  const journal: OpenTaskJournal = {
    schemaVersion: 2,
    kind: 'open-task-transaction.v2',
    transactionId: value.transactionId,
    phase: value.phase,
    changeId,
    taskId,
    mandateTaskId: value.mandateTaskId,
    mandateBinding,
    authorizationPolicyDigest: value.authorizationPolicyDigest,
    repositoryRoot: value.repositoryRoot,
    gitCommonDirectory: value.gitCommonDirectory,
    worktree: value.worktree,
    branch: value.branch,
    parentCommit: value.parentCommit,
    parentTree: value.parentTree,
    planningCommit: value.planningCommit,
    baselineTree: value.baselineTree,
    reportId: value.reportId,
    changedPaths,
    sessionId: value.sessionId,
    createdAt,
    completedAt,
  };
  if (journal.transactionId !== transactionDigest(journal)) {
    throw openTaskUnsafe('Open-task transaction identity does not match.');
  }
  return Object.freeze(journal);
}

function parseMandateBinding(value: unknown): TaskMandateBinding {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'changeId',
        'externalAuditRoot',
        'mandateDigest',
        'mandateId',
        'mandateTaskId',
        'schemaVersion',
      ]
        .sort()
        .join('\0') ||
    value.schemaVersion !== 1 ||
    typeof value.mandateTaskId !== 'string' ||
    !MANDATE_TASK_ID.test(value.mandateTaskId) ||
    typeof value.mandateId !== 'string' ||
    !MANDATE_ID.test(value.mandateId) ||
    typeof value.mandateDigest !== 'string' ||
    !SHA256.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot)
  ) {
    throw openTaskUnsafe('Open-task mandate binding is malformed.');
  }
  return {
    schemaVersion: 1,
    mandateTaskId: value.mandateTaskId,
    mandateId: value.mandateId,
    mandateDigest: value.mandateDigest,
    changeId: assertChangeId(value.changeId),
    externalAuditRoot: value.externalAuditRoot,
  };
}

function transactionDigest(
  value: Omit<OpenTaskJournal, 'transactionId' | 'phase' | 'completedAt'> &
    Partial<Pick<OpenTaskJournal, 'transactionId' | 'phase' | 'completedAt'>>,
): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        schema: 'open-task-transaction.v2',
        changeId: value.changeId,
        taskId: value.taskId,
        mandateTaskId: value.mandateTaskId,
        mandateBinding: value.mandateBinding,
        authorizationPolicyDigest: value.authorizationPolicyDigest,
        repositoryRoot: value.repositoryRoot,
        gitCommonDirectory: value.gitCommonDirectory,
        worktree: value.worktree,
        branch: value.branch,
        parentCommit: value.parentCommit,
        parentTree: value.parentTree,
        planningCommit: value.planningCommit,
        baselineTree: value.baselineTree,
        reportId: value.reportId,
        changedPaths: value.changedPaths,
        sessionId: value.sessionId,
        createdAt: value.createdAt,
      }),
    )
    .digest('hex');
}

export function exactOpenTaskTimestamp(now: Date): string {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw workflowError(
      'OPEN_TASK_CLOCK_INVALID',
      'Open-task requires a valid wall-clock timestamp.',
      ExitCode.staleState,
    );
  }
  return new Date(milliseconds).toISOString();
}

export function assertOpenTaskMandateTaskId(value: string): string {
  if (!MANDATE_TASK_ID.test(value) || value.length > 128) {
    throw workflowError(
      'OPEN_TASK_MANDATE_TASK_ID_INVALID',
      'Open-task mandate task ID must be lower-case kebab-case.',
      ExitCode.usage,
    );
  }
  return value;
}

export function exactOpenTaskRetryCommand(journal: OpenTaskJournal): string {
  return `pnpm workflow open-task ${journal.changeId} --task ${journal.taskId}${
    journal.mandateTaskId === null ? '' : ` --mandate ${journal.mandateTaskId}`
  } --json`;
}

export function openTaskPhaseDiverged(message: string): WorkflowError {
  return workflowError(
    'OPEN_TASK_PHASE_DIVERGED',
    message,
    ExitCode.staleState,
  );
}

export function openTaskUnsafe(message: string) {
  return workflowError(
    'OPEN_TASK_JOURNAL_CORRUPT',
    message,
    ExitCode.staleState,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
