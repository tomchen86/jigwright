/**
 * Persists and validates task revision journals and their phase
 * transitions.
 *
 * Invariants:
 * - Transitions preserve lease and task identity and follow the declared
 *   phase graph.
 */
import fs from 'node:fs';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import path from 'node:path';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type {
  TaskRevisionRuntimeBindings,
  TaskRevisionRuntimeData,
} from './task-revision.ts';
type WorkflowSession = TaskRevisionRuntimeData['WorkflowSession'];
import type { ImplementationSnapshotEntry } from './task-revision-implementation-snapshot.ts';
import type { createTaskRevisionImplementationSnapshot } from './task-revision-implementation-snapshot.ts';
export type TaskRevisionPhase =
  | 'prepared'
  | 'session-revising'
  | 'revising'
  | 'planning-staging-prepared'
  | 'plan-commit-prepared'
  | 'plan-committed'
  | 'resume-prepared'
  | 'completed'
  | 'abort-prepared'
  | 'revoked';

export type StagingGeneratedMutation = Readonly<{
  path: string;
  before: string | null;
  after: string;
}>;

export type TaskRevisionJournal = Readonly<{
  schemaVersion: 1;
  kind: 'task-revision-lease.v1';
  phase: TaskRevisionPhase;
  leaseId: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  reason: string;
  actorAuthorityId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  head: string;
  tree: string;
  indexTree: string;
  contractDigest: string;
  artifactDigests: Record<string, string>;
  allowedPaths: string[];
  requiredChecks: string[];
  requiredCheckDigests: Record<string, string>;
  planningAssurance: WorkflowSession['planningAssurance'];
  implementationPaths: string[];
  implementationSnapshot: ImplementationSnapshotEntry[];
  implementationFingerprint: string;
  sessionBeforeDigest: string;
  createdAt: string;
  expiresAt: string;
  resumePreparedAt?: string;
  resumeSessionDigest?: string;
  stagingTree?: string;
  stagingChangedPaths?: string[];
  stagingGeneratedMutations?: StagingGeneratedMutation[];
  stagingPreparedAt?: string;
  planCommitHash?: string;
  planTree?: string;
  planReportId?: string;
  planChangedPaths?: string[];
  planCommittedAt?: string;
  approvalId?: string;
  completedAt?: string;
  abortPreparedAt?: string;
  abortReason?: string;
  revokedAt?: string;
}>;

export function createTaskRevisionJournalStore(
  runtime: TaskRevisionRuntimeBindings,
  implementationSnapshot: ReturnType<
    typeof createTaskRevisionImplementationSnapshot
  >,
) {
  const {
    runtimePaths,
    ensurePlainDirectory,
    writeJsonAtomic,
    isPlanningAssuranceBinding,
    normalizeChangedPath,
  } = runtime;
  const { sameStats, digestImplementationSnapshot } = implementationSnapshot;
  const REVISION_LEASE_ID =
    /^revision-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const REVISION_FILE =
    /^revision-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

  const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

  const SHA256 = /^[0-9a-f]{64}$/;

  const TASK_REVISION_PHASE_TRANSITIONS: Readonly<
    Record<TaskRevisionPhase, readonly TaskRevisionPhase[]>
  > = Object.freeze({
    prepared: ['session-revising', 'revising', 'abort-prepared'],
    'session-revising': ['revising', 'abort-prepared'],
    revising: [
      'planning-staging-prepared',
      'resume-prepared',
      'abort-prepared',
    ],
    'planning-staging-prepared': ['plan-commit-prepared'],
    'plan-commit-prepared': ['plan-committed'],
    'plan-committed': ['resume-prepared'],
    'resume-prepared': ['completed'],
    completed: [],
    'abort-prepared': ['revoked'],
    revoked: [],
  });

  function createRevisionJournal(
    runtime: ReturnType<typeof runtimePaths>,
    journal: TaskRevisionJournal,
  ): void {
    ensurePlainDirectory(runtime.taskRevisions);
    const filePath = revisionPath(runtime, journal.leaseId);
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
      throw corruptRevisionState();
    }
    writeJsonAtomic(filePath, journal);
    if (
      canonicalJson(readRevisionJournal(runtime, journal.leaseId)) !==
      canonicalJson(journal)
    ) {
      throw corruptRevisionState();
    }
  }

  function transitionJournal(
    runtime: ReturnType<typeof runtimePaths>,
    expected: TaskRevisionJournal,
    next: TaskRevisionJournal,
  ): TaskRevisionJournal {
    if (
      expected.leaseId !== next.leaseId ||
      expected.sessionId !== next.sessionId ||
      expected.changeId !== next.changeId ||
      expected.taskId !== next.taskId ||
      !TASK_REVISION_PHASE_TRANSITIONS[expected.phase].includes(next.phase)
    ) {
      throw corruptRevisionState();
    }
    const current = readRevisionJournal(runtime, expected.leaseId);
    if (canonicalJson(current) !== canonicalJson(expected)) {
      throw corruptRevisionState();
    }
    writeJsonAtomic(revisionPath(runtime, expected.leaseId), next);
    const persisted = readRevisionJournal(runtime, expected.leaseId);
    if (canonicalJson(persisted) !== canonicalJson(next)) {
      throw corruptRevisionState();
    }
    return persisted;
  }

  function readRevisionJournal(
    runtime: ReturnType<typeof runtimePaths>,
    leaseId: string,
  ): TaskRevisionJournal {
    if (!REVISION_LEASE_ID.test(leaseId)) throw corruptRevisionState();
    const filePath = revisionPath(runtime, leaseId);
    assertRevisionDirectory(runtime.taskRevisions);
    let descriptor: number | undefined;
    let value: unknown;
    try {
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const openedBefore = fs.fstatSync(descriptor, { bigint: true });
      const content = fs.readFileSync(descriptor, 'utf8');
      const openedAfter = fs.fstatSync(descriptor, { bigint: true });
      const observed = fs.lstatSync(filePath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        !openedBefore.isFile() ||
        openedBefore.nlink !== 1n ||
        (openedBefore.mode & 0o777n) !== 0o600n ||
        !openedAfter.isFile() ||
        !observed?.isFile() ||
        observed.isSymbolicLink() ||
        !sameStats(openedBefore, openedAfter) ||
        !sameStats(openedAfter, observed)
      ) {
        throw corruptRevisionState();
      }
      value = JSON.parse(content);
    } catch {
      throw corruptRevisionState();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    if (!isTaskRevisionJournal(value) || value.leaseId !== leaseId) {
      throw corruptRevisionState();
    }
    return value;
  }

  function listRevisionJournals(
    runtime: ReturnType<typeof runtimePaths>,
    sessionId: string,
  ): TaskRevisionJournal[] {
    const stats = fs.lstatSync(runtime.taskRevisions, {
      throwIfNoEntry: false,
    });
    if (!stats) return [];
    assertRevisionDirectory(runtime.taskRevisions);
    const entries = fs.readdirSync(runtime.taskRevisions).sort();
    if (entries.some((entry) => !REVISION_FILE.test(entry))) {
      throw corruptRevisionState();
    }
    return entries
      .map((entry) =>
        readRevisionJournal(runtime, entry.slice(0, -'.json'.length)),
      )
      .filter((journal) => journal.sessionId === sessionId)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.leaseId.localeCompare(right.leaseId)
          : left.createdAt.localeCompare(right.createdAt),
      );
  }

  function findLiveRevisionJournal(
    runtime: ReturnType<typeof runtimePaths>,
    sessionId: string,
  ): TaskRevisionJournal | null {
    const live = listRevisionJournals(runtime, sessionId).filter(
      ({ phase }) => phase !== 'completed' && phase !== 'revoked',
    );
    if (live.length > 1) throw corruptRevisionState();
    return live[0] ?? null;
  }

  function findLatestRevisionJournal(
    runtime: ReturnType<typeof runtimePaths>,
    sessionId: string,
  ): TaskRevisionJournal | null {
    return listRevisionJournals(runtime, sessionId).at(-1) ?? null;
  }

  function isTaskRevisionJournal(value: unknown): value is TaskRevisionJournal {
    if (!isRecord(value)) return false;
    const allowed = new Set([
      'schemaVersion',
      'kind',
      'phase',
      'leaseId',
      'sessionId',
      'changeId',
      'taskId',
      'reason',
      'actorAuthorityId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'head',
      'tree',
      'indexTree',
      'contractDigest',
      'artifactDigests',
      'allowedPaths',
      'requiredChecks',
      'requiredCheckDigests',
      'planningAssurance',
      'implementationPaths',
      'implementationSnapshot',
      'implementationFingerprint',
      'sessionBeforeDigest',
      'createdAt',
      'expiresAt',
      'resumePreparedAt',
      'resumeSessionDigest',
      'stagingTree',
      'stagingChangedPaths',
      'stagingGeneratedMutations',
      'stagingPreparedAt',
      'planCommitHash',
      'planTree',
      'planReportId',
      'planChangedPaths',
      'planCommittedAt',
      'approvalId',
      'completedAt',
      'abortPreparedAt',
      'abortReason',
      'revokedAt',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
    if (
      value.schemaVersion !== 1 ||
      value.kind !== 'task-revision-lease.v1' ||
      ![
        'prepared',
        'session-revising',
        'revising',
        'planning-staging-prepared',
        'plan-commit-prepared',
        'plan-committed',
        'resume-prepared',
        'completed',
        'abort-prepared',
        'revoked',
      ].includes(String(value.phase)) ||
      typeof value.leaseId !== 'string' ||
      !REVISION_LEASE_ID.test(value.leaseId) ||
      typeof value.sessionId !== 'string' ||
      typeof value.changeId !== 'string' ||
      typeof value.taskId !== 'string' ||
      typeof value.reason !== 'string' ||
      value.reason.length === 0 ||
      typeof value.actorAuthorityId !== 'string' ||
      value.actorAuthorityId.length === 0 ||
      typeof value.repositoryRoot !== 'string' ||
      typeof value.gitCommonDirectory !== 'string' ||
      typeof value.branch !== 'string' ||
      typeof value.head !== 'string' ||
      !OBJECT_ID.test(value.head) ||
      typeof value.tree !== 'string' ||
      !OBJECT_ID.test(value.tree) ||
      typeof value.indexTree !== 'string' ||
      !OBJECT_ID.test(value.indexTree) ||
      typeof value.contractDigest !== 'string' ||
      !SHA256.test(value.contractDigest) ||
      !isStringRecord(value.artifactDigests) ||
      !isSortedStringArray(value.allowedPaths) ||
      !isSortedStringArray(value.requiredChecks) ||
      !isStringRecord(value.requiredCheckDigests) ||
      !Object.hasOwn(value, 'planningAssurance') ||
      (value.planningAssurance !== null &&
        !isPlanningAssuranceBinding(value.planningAssurance)) ||
      !isSortedStringArray(value.implementationPaths) ||
      !Array.isArray(value.implementationSnapshot) ||
      typeof value.implementationFingerprint !== 'string' ||
      !SHA256.test(value.implementationFingerprint) ||
      typeof value.sessionBeforeDigest !== 'string' ||
      !SHA256.test(value.sessionBeforeDigest) ||
      !isCanonicalTimestamp(value.createdAt) ||
      !isCanonicalTimestamp(value.expiresAt)
    ) {
      return false;
    }
    if (
      value.approvalId !== undefined &&
      (typeof value.approvalId !== 'string' || !SHA256.test(value.approvalId))
    ) {
      return false;
    }
    if (
      value.approvalId !== undefined &&
      [
        'prepared',
        'session-revising',
        'revising',
        'abort-prepared',
        'revoked',
      ].includes(String(value.phase))
    ) {
      return false;
    }
    if (!value.implementationSnapshot.every(isImplementationSnapshotEntry)) {
      return false;
    }
    if (
      canonicalJson(value.implementationPaths) !==
        canonicalJson(
          value.implementationSnapshot.map((entry) => entry.path),
        ) ||
      digestImplementationSnapshot(
        value.implementationSnapshot as ImplementationSnapshotEntry[],
      ) !== value.implementationFingerprint
    ) {
      return false;
    }
    for (const field of [
      'resumePreparedAt',
      'completedAt',
      'abortPreparedAt',
      'revokedAt',
    ]) {
      if (value[field] !== undefined && !isCanonicalTimestamp(value[field])) {
        return false;
      }
    }
    if (
      value.resumeSessionDigest !== undefined &&
      (typeof value.resumeSessionDigest !== 'string' ||
        !SHA256.test(value.resumeSessionDigest))
    ) {
      return false;
    }
    const stagingFields = [
      value.stagingTree,
      value.stagingChangedPaths,
      value.stagingGeneratedMutations,
      value.stagingPreparedAt,
    ];
    if (stagingFields.some((field) => field !== undefined)) {
      if (
        typeof value.stagingTree !== 'string' ||
        !OBJECT_ID.test(value.stagingTree) ||
        !isSortedStringArray(value.stagingChangedPaths) ||
        !Array.isArray(value.stagingGeneratedMutations) ||
        !value.stagingGeneratedMutations.every(isGeneratedDocumentMutation) ||
        !isCanonicalTimestamp(value.stagingPreparedAt)
      ) {
        return false;
      }
    }
    if (
      value.phase === 'planning-staging-prepared' &&
      stagingFields.some((field) => field === undefined)
    ) {
      return false;
    }
    const planCoreFields = [
      value.planCommitHash,
      value.planTree,
      value.planReportId,
      value.planChangedPaths,
    ];
    if (
      planCoreFields.some((field) => field !== undefined) ||
      value.planCommittedAt !== undefined
    ) {
      if (
        typeof value.planCommitHash !== 'string' ||
        !OBJECT_ID.test(value.planCommitHash) ||
        typeof value.planTree !== 'string' ||
        !OBJECT_ID.test(value.planTree) ||
        typeof value.planReportId !== 'string' ||
        !SHA256.test(value.planReportId) ||
        !isSortedStringArray(value.planChangedPaths) ||
        (value.planCommittedAt !== undefined &&
          !isCanonicalTimestamp(value.planCommittedAt))
      ) {
        return false;
      }
    }
    if (
      (value.phase === 'plan-commit-prepared' ||
        value.phase === 'plan-committed') &&
      planCoreFields.some((field) => field === undefined)
    ) {
      return false;
    }
    if (
      value.phase === 'plan-committed' &&
      !isCanonicalTimestamp(value.planCommittedAt)
    ) {
      return false;
    }
    if (
      value.abortReason !== undefined &&
      typeof value.abortReason !== 'string'
    ) {
      return false;
    }
    if (
      (value.phase === 'resume-prepared' || value.phase === 'completed') &&
      (!isCanonicalTimestamp(value.resumePreparedAt) ||
        typeof value.resumeSessionDigest !== 'string' ||
        !SHA256.test(value.resumeSessionDigest))
    ) {
      return false;
    }
    if (
      value.phase === 'completed' &&
      !isCanonicalTimestamp(value.completedAt)
    ) {
      return false;
    }
    if (
      (value.phase === 'abort-prepared' || value.phase === 'revoked') &&
      (!isCanonicalTimestamp(value.abortPreparedAt) ||
        typeof value.abortReason !== 'string' ||
        value.abortReason.length === 0)
    ) {
      return false;
    }
    if (value.phase === 'revoked' && !isCanonicalTimestamp(value.revokedAt)) {
      return false;
    }
    return true;
  }

  function assertRevisionDirectory(directory: string): void {
    const absolute = path.resolve(directory);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== 0o700 ||
      fs.realpathSync(absolute) !== absolute
    ) {
      throw corruptRevisionState();
    }
  }

  function isImplementationSnapshotEntry(
    value: unknown,
  ): value is ImplementationSnapshotEntry {
    return (
      isRecord(value) &&
      Object.keys(value).sort().join('\0') ===
        ['digest', 'kind', 'mode', 'path'].sort().join('\0') &&
      typeof value.path === 'string' &&
      ['file', 'symlink', 'missing'].includes(String(value.kind)) &&
      ['100644', '100755', '120000', '000000'].includes(String(value.mode)) &&
      typeof value.digest === 'string' &&
      SHA256.test(value.digest)
    );
  }

  function isGeneratedDocumentMutation(
    value: unknown,
  ): value is StagingGeneratedMutation {
    return (
      isRecord(value) &&
      Object.keys(value).sort().join('\0') ===
        ['after', 'before', 'path'].sort().join('\0') &&
      typeof value.path === 'string' &&
      normalizeChangedPath(value.path) === value.path &&
      (value.before === null || typeof value.before === 'string') &&
      typeof value.after === 'string'
    );
  }

  function revisionPath(
    runtime: ReturnType<typeof runtimePaths>,
    leaseId: string,
  ): string {
    return path.join(runtime.taskRevisions, `${leaseId}.json`);
  }

  function corruptRevisionState() {
    return workflowError(
      'REVISION_STATE_CORRUPT',
      'The durable task revision lease or its session binding is malformed.',
      ExitCode.staleState,
    );
  }

  function isCanonicalTimestamp(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const milliseconds = Date.parse(value);
    return (
      Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value
    );
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function isStringRecord(value: unknown): value is Record<string, string> {
    return (
      isRecord(value) &&
      Object.values(value).every((entry) => typeof entry === 'string')
    );
  }

  function isSortedStringArray(value: unknown): value is string[] {
    return (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === 'string') &&
      new Set(value).size === value.length &&
      canonicalJson(value) === canonicalJson([...value].sort())
    );
  }

  return {
    createRevisionJournal,
    transitionJournal,
    readRevisionJournal,
    findLiveRevisionJournal,
    findLatestRevisionJournal,
    corruptRevisionState,
  };
}
