import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '@jigwright/core/canonical-json';
import { isRecord } from '@jigwright/core/contract-values';

import {
  loadWorkflowConfig,
  parseTasks,
  type ParsedTask,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { replaceTextAtomic } from '../../runtime/repository-transaction/atomic-text.ts';
import { discoverRepository } from '../../runtime/repository-transaction/git.ts';
import { assertChangeId } from '../../runtime/session-workspace/paths.ts';
import {
  listActiveWorkflowSessionIds,
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../../runtime/session-workspace/session-store.ts';
import {
  CHANGE_ROUTING_CONTINUATION_CONSEQUENCE_DIGEST,
  CHANGE_ROUTING_CONTINUATION_PARAMETER_SCHEMA_DIGEST,
  CHANGE_ROUTING_CONTINUATION_TRANSITION_ID,
} from './change-routing-grant-contract.ts';

export const changeLifecycleRelativePath = 'openspec/change-lifecycle.json';

export type ChangeRoutingBlocker = Readonly<{
  kind: 'change' | 'external';
  id: string;
  resumeCondition: 'done' | 'merged' | 'archived' | 'manual';
}>;

export type ChangeRoutingIntent = Readonly<{
  schemaVersion: 1;
  action:
    | Readonly<{ kind: 'focus'; changeId: string }>
    | Readonly<{ kind: 'clear-focus' }>
    | Readonly<{ kind: 'set-concurrent'; changeId: string }>
    | Readonly<{ kind: 'clear-concurrent' }>
    | Readonly<{
        kind: 'block';
        changeId: string;
        taskId: string;
        reason: string;
        blocker: ChangeRoutingBlocker;
      }>
    | Readonly<{ kind: 'park'; changeId: string; reason: string }>
    | Readonly<{
        kind: 'resume';
        changeId: string;
        grantChallengeId?: string;
      }>;
}>;

type RoutingRecord = Readonly<{
  changeId: string;
  disposition: 'ready' | 'blocked' | 'parked';
  reason: string | null;
  taskId: string | null;
  blocker: ChangeRoutingBlocker | null;
}>;

export type ChangeLifecycleSource = Readonly<{
  schemaVersion: 1;
  routingRevision: number;
  maxConcurrent: 1;
  concurrentChangeIds: readonly string[];
  primaryChangeId: string | null;
  records: readonly RoutingRecord[];
}>;

export type ChangeRoutingAuthorityFacts = Readonly<{
  changeId: string;
  manifestDigest: string;
  investigationTargetDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
  reviewRoleResultDigest: string;
}>;

/**
 * Lower-layer contract for resolving current routing authority. The lifecycle
 * kernel owns the required facts, while the composition root supplies the
 * stable Manifest v3 + PlanReview validator used in production.
 */
export type ChangeRoutingAuthorityPort = Readonly<{
  loadCurrentAuthority(
    repositoryRoot: string,
    changeId: string,
  ): ChangeRoutingAuthorityFacts;
}>;

export type ChangeRoutingContinuationGrantPort = Readonly<{
  readGrantRecord(repositoryRoot: string, challengeId: string): unknown;
}>;

export type ChangeRoutingContinuationAuthority = Readonly<{
  contractVersion: 'central-grant-completed-authority-ref.v1';
  challengeId: string;
  challengeDigest: `sha256:${string}`;
  transitionId: typeof CHANGE_ROUTING_CONTINUATION_TRANSITION_ID;
  operationId: string;
  terminalOutcomeDigest: `sha256:${string}`;
}>;

export type ChangeRoutingReview = Readonly<{
  schemaVersion: 3;
  kind: 'jigwright.change-routing-review.v3';
  expectedSourceDigest: string | null;
  expectedRepositoryFactsDigest: string;
  authorityFacts: readonly ChangeRoutingAuthorityFacts[];
  continuationAuthority: ChangeRoutingContinuationAuthority | null;
  intent: ChangeRoutingIntent;
  nextSource: ChangeLifecycleSource;
  nextSourceDigest: string;
}>;

export type ChangeRoutingState =
  | 'primary'
  | 'concurrent'
  | 'ready'
  | 'blocked'
  | 'resume-available'
  | 'parked'
  | 'completed-awaiting-archive'
  | 'archived'
  | 'revising'
  | 'recovery-required';

export type ChangeRoutingObservation = Readonly<{
  changeId: string;
  state: ChangeRoutingState;
  reason: string | null;
  taskId: string | null;
  blocker: ChangeRoutingBlocker | null;
  tasks: readonly ParsedTask[];
}>;

export type ChangeRoutingInspection = Readonly<{
  schemaVersion: 1;
  sourcePresent: boolean;
  sourceDigest: string | null;
  primaryChangeId: string | null;
  concurrentChangeIds: readonly string[];
  changes: readonly ChangeRoutingObservation[];
}>;

export type ChangeRoutingAdmission = Readonly<{
  role: 'single' | 'primary' | 'concurrent';
  worksetDigest: string;
  concurrencyEnabled: boolean;
}>;

export function parseChangeRoutingIntent(value: unknown): ChangeRoutingIntent {
  if (!isRecord(value) || !hasExactKeys(value, ['action', 'schemaVersion'])) {
    throw routingInvalid('Change-routing intent has an invalid envelope.');
  }
  if (value.schemaVersion !== 1 || !isRecord(value.action)) {
    throw routingInvalid('Change-routing intent has an unsupported schema.');
  }
  const action = value.action;
  switch (action.kind) {
    case 'focus':
      assertExactKeys(action, ['changeId', 'kind']);
      return {
        schemaVersion: 1,
        action: {
          kind: 'focus',
          changeId: assertChangeIdValue(action.changeId),
        },
      };
    case 'clear-focus':
      assertExactKeys(action, ['kind']);
      return { schemaVersion: 1, action: { kind: 'clear-focus' } };
    case 'set-concurrent':
      assertExactKeys(action, ['changeId', 'kind']);
      return {
        schemaVersion: 1,
        action: {
          kind: 'set-concurrent',
          changeId: assertChangeIdValue(action.changeId),
        },
      };
    case 'clear-concurrent':
      assertExactKeys(action, ['kind']);
      return { schemaVersion: 1, action: { kind: 'clear-concurrent' } };
    case 'block':
      assertExactKeys(action, [
        'blocker',
        'changeId',
        'kind',
        'reason',
        'taskId',
      ]);
      if (!isRecord(action.blocker)) {
        throw routingInvalid('A blocked change requires one exact blocker.');
      }
      return {
        schemaVersion: 1,
        action: {
          kind: 'block',
          changeId: assertChangeIdValue(action.changeId),
          taskId: assertIdentifier(action.taskId, 'taskId'),
          reason: assertReason(action.reason),
          blocker: parseBlocker(action.blocker),
        },
      };
    case 'park':
      assertExactKeys(action, ['changeId', 'kind', 'reason']);
      return {
        schemaVersion: 1,
        action: {
          kind: 'park',
          changeId: assertChangeIdValue(action.changeId),
          reason: assertReason(action.reason),
        },
      };
    case 'resume':
      assertExactKeys(
        action,
        action.grantChallengeId === undefined
          ? ['changeId', 'kind']
          : ['changeId', 'grantChallengeId', 'kind'],
      );
      return {
        schemaVersion: 1,
        action: {
          kind: 'resume',
          changeId: assertChangeIdValue(action.changeId),
          ...(action.grantChallengeId === undefined
            ? {}
            : {
                grantChallengeId: assertGrantChallengeId(
                  action.grantChallengeId,
                ),
              }),
        },
      };
    default:
      throw routingInvalid('Change-routing intent action is unsupported.');
  }
}

export function parseChangeRoutingReview(value: unknown): ChangeRoutingReview {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'authorityFacts',
      'continuationAuthority',
      'expectedRepositoryFactsDigest',
      'expectedSourceDigest',
      'intent',
      'kind',
      'nextSource',
      'nextSourceDigest',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 3 ||
    value.kind !== 'jigwright.change-routing-review.v3' ||
    !Array.isArray(value.authorityFacts)
  ) {
    throw routingInvalid('Change-routing review has an invalid envelope.');
  }
  const expectedSourceDigest =
    value.expectedSourceDigest === null
      ? null
      : assertDigest(value.expectedSourceDigest);
  const expectedRepositoryFactsDigest = assertDigest(
    value.expectedRepositoryFactsDigest,
  );
  const authorityFacts = value.authorityFacts.map(parseRoutingAuthorityFacts);
  const sortedAuthorityChangeIds = authorityFacts
    .map(({ changeId }) => changeId)
    .sort();
  if (
    new Set(sortedAuthorityChangeIds).size !== authorityFacts.length ||
    authorityFacts.some(
      ({ changeId }, index) => changeId !== sortedAuthorityChangeIds[index],
    )
  ) {
    throw routingInvalid(
      'Change-routing authority facts must be unique and sorted.',
    );
  }
  const continuationAuthority =
    value.continuationAuthority === null
      ? null
      : parseContinuationAuthority(value.continuationAuthority);
  const nextSource = parseChangeLifecycleSource(value.nextSource);
  const nextSourceDigest = assertDigest(value.nextSourceDigest);
  if (digestSource(nextSource) !== nextSourceDigest) {
    throw routingInvalid(
      'Change-routing review next-source digest is invalid.',
    );
  }
  return {
    schemaVersion: 3,
    kind: 'jigwright.change-routing-review.v3',
    expectedSourceDigest,
    expectedRepositoryFactsDigest,
    authorityFacts: Object.freeze(authorityFacts),
    continuationAuthority,
    intent: parseChangeRoutingIntent(value.intent),
    nextSource,
    nextSourceDigest,
  };
}

export function prepareChangeRoutingReview(
  repositoryRoot: string,
  rawIntent: unknown,
  authorityPort: ChangeRoutingAuthorityPort,
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): ChangeRoutingReview {
  const intent = parseChangeRoutingIntent(rawIntent);
  const snapshot = readSourceSnapshot(repositoryRoot);
  const observed = observeChanges(repositoryRoot, authorityPort);
  const source = snapshot.source ?? synthesizeSource(observed);
  const continuationAuthority = authorizeContinuation(
    repositoryRoot,
    source,
    snapshot.digest,
    intent,
    observed,
    continuationGrantPort,
  );
  const nextSource = applyIntent(source, intent, observed);
  const authorityFacts = requiredRoutingAuthorityFacts(
    repositoryRoot,
    intent,
    nextSource,
    observed,
    authorityPort,
  );
  return Object.freeze({
    schemaVersion: 3 as const,
    kind: 'jigwright.change-routing-review.v3' as const,
    expectedSourceDigest: snapshot.digest,
    expectedRepositoryFactsDigest: digestObservedRepositoryFacts(observed),
    authorityFacts,
    continuationAuthority,
    intent,
    nextSource,
    nextSourceDigest: digestSource(nextSource),
  });
}

export function applyChangeRoutingReview(
  repositoryRoot: string,
  rawReview: unknown,
  authorityPort: ChangeRoutingAuthorityPort,
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): Readonly<{
  sourceDigest: string;
  relativePath: typeof changeLifecycleRelativePath;
  replayed: boolean;
}> {
  const review = parseChangeRoutingReview(rawReview);
  const git = discoverRepository(repositoryRoot);
  const config = loadWorkflowConfig(repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  return withRepositoryLifecycleOperation(runtime, () =>
    applyChangeRoutingReviewUnderLifecycleLock(
      repositoryRoot,
      review,
      authorityPort,
      continuationGrantPort,
    ),
  );
}

/** Composition-only kernel; callers must hold the repository lifecycle lock. */
export function applyChangeRoutingReviewUnderLifecycleLock(
  repositoryRoot: string,
  review: ChangeRoutingReview,
  authorityPort: ChangeRoutingAuthorityPort,
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): Readonly<{
  sourceDigest: string;
  relativePath: typeof changeLifecycleRelativePath;
  replayed: boolean;
}> {
  const snapshot = readSourceSnapshot(repositoryRoot);
  if (snapshot.digest === review.nextSourceDigest) {
    return {
      sourceDigest: review.nextSourceDigest,
      relativePath: changeLifecycleRelativePath,
      replayed: true,
    };
  }
  if (snapshot.digest !== review.expectedSourceDigest) {
    throw workflowError(
      'CHANGE_ROUTING_REVIEW_STALE',
      'The reviewed routing transition no longer matches the controlled lifecycle source.',
      ExitCode.staleState,
    );
  }
  const observed = observeChanges(repositoryRoot, authorityPort);
  if (
    digestObservedRepositoryFacts(observed) !==
    review.expectedRepositoryFactsDigest
  ) {
    throw workflowError(
      'CHANGE_ROUTING_REVIEW_STALE',
      'The reviewed routing transition no longer matches current task and authority facts.',
      ExitCode.staleState,
    );
  }
  const current = snapshot.source ?? synthesizeSource(observed);
  const continuationAuthority = authorizeContinuation(
    repositoryRoot,
    current,
    snapshot.digest,
    review.intent,
    observed,
    continuationGrantPort,
  );
  const recomputed = applyIntent(current, review.intent, observed);
  const authorityFacts = requiredRoutingAuthorityFacts(
    repositoryRoot,
    review.intent,
    recomputed,
    observed,
    authorityPort,
  );
  if (
    canonicalJson(recomputed) !== canonicalJson(review.nextSource) ||
    digestSource(recomputed) !== review.nextSourceDigest ||
    canonicalJson(authorityFacts) !== canonicalJson(review.authorityFacts) ||
    canonicalJson(continuationAuthority) !==
      canonicalJson(review.continuationAuthority)
  ) {
    throw workflowError(
      'CHANGE_ROUTING_REVIEW_INVALID',
      'The reviewed routing result cannot be reproduced from current repository facts.',
      ExitCode.verification,
    );
  }
  if (
    routingWorksetDigest(
      current.primaryChangeId,
      current.concurrentChangeIds,
    ) !==
    routingWorksetDigest(
      recomputed.primaryChangeId,
      recomputed.concurrentChangeIds,
    )
  ) {
    const git = discoverRepository(repositoryRoot);
    const config = loadWorkflowConfig(repositoryRoot);
    const activeSessionIds = listActiveWorkflowSessionIds(
      runtimePaths(git.gitCommonDirectory, config.runtimeDirectory),
    );
    if (activeSessionIds.length > 0) {
      throw workflowError(
        'CHANGE_ROUTING_WORKSET_BUSY',
        'The managed writer workset cannot change while a task session is active.',
        ExitCode.conflict,
        { details: { activeSessionIds } },
      );
    }
  }
  const sourcePath = path.join(repositoryRoot, changeLifecycleRelativePath);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  replaceTextAtomic(sourcePath, prettyJson(recomputed), {
    allowCreate: true,
    defaultMode: 0o644,
  });
  return {
    sourceDigest: review.nextSourceDigest,
    relativePath: changeLifecycleRelativePath,
    replayed: false,
  };
}

export function assertChangeRoutingCommitAuthorized(
  _repositoryRoot: string,
  _stagedSourceBytes: string,
): void {
  throw routingCommitUnauthorized();
}

export function inspectChangeRouting(
  repositoryRoot: string,
  authorityPort?: ChangeRoutingAuthorityPort,
): ChangeRoutingInspection {
  const snapshot = readSourceSnapshot(repositoryRoot);
  const observed = observeChanges(repositoryRoot, authorityPort);
  const source = snapshot.source ?? synthesizeSource(observed);
  const records = new Map(
    source.records.map((record) => [record.changeId, record]),
  );
  const changes = observed.map((change) => {
    const record = records.get(change.changeId) ?? readyRecord(change.changeId);
    const runtimeState = observeRuntimeState(repositoryRoot, change.changeId);
    let state: ChangeRoutingState;
    if (change.archived) state = 'archived';
    else if (change.completed) state = 'completed-awaiting-archive';
    else if (runtimeState !== null) state = runtimeState;
    else if (record.disposition === 'blocked') {
      state = blockerSatisfied(record.blocker, observed)
        ? 'resume-available'
        : 'blocked';
    } else if (record.disposition === 'parked') state = 'parked';
    else if (change.authorityChecked && change.authority === null) {
      state = 'recovery-required';
    } else if (source.primaryChangeId === change.changeId) state = 'primary';
    else if (source.concurrentChangeIds.includes(change.changeId)) {
      state = 'concurrent';
    } else state = 'ready';
    return Object.freeze({
      changeId: change.changeId,
      state,
      reason: record.reason,
      taskId: record.taskId,
      blocker: record.blocker,
      tasks: Object.freeze(
        change.tasks.map((task) => Object.freeze({ ...task })),
      ),
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    sourcePresent: snapshot.source !== null,
    sourceDigest: snapshot.digest,
    primaryChangeId:
      source.primaryChangeId !== null &&
      changes.some(
        ({ changeId, state }) =>
          changeId === source.primaryChangeId &&
          state !== 'archived' &&
          state !== 'completed-awaiting-archive' &&
          state !== 'recovery-required',
      )
        ? source.primaryChangeId
        : null,
    concurrentChangeIds: Object.freeze(
      source.concurrentChangeIds.filter((changeId) =>
        changes.some(
          (change) =>
            change.changeId === changeId &&
            change.state !== 'archived' &&
            change.state !== 'completed-awaiting-archive' &&
            change.state !== 'recovery-required',
        ),
      ),
    ),
    changes: Object.freeze(changes),
  });
}

export function assertChangeRoutingAdmission(
  repositoryRoot: string,
  requestedChangeId: string,
  authorityPort: ChangeRoutingAuthorityPort,
): ChangeRoutingAdmission {
  const changeId = assertChangeId(requestedChangeId);
  const snapshot = readSourceSnapshot(repositoryRoot);
  if (snapshot.source === null) {
    const structurallyObserved = observeChanges(repositoryRoot);
    const active = structurallyObserved.filter(
      (change) => !change.archived && !change.completed,
    );
    if (active.length <= 1) {
      return Object.freeze({
        role: 'single' as const,
        worksetDigest: routingWorksetDigest(null, []),
        concurrencyEnabled: false,
      });
    }
  }
  const observed = observeChanges(repositoryRoot, authorityPort);
  const source = snapshot.source ?? synthesizeSource(observed);
  const requested = observed.find((change) => change.changeId === changeId);
  const record =
    source.records.find((candidate) => candidate.changeId === changeId) ??
    readyRecord(changeId);
  const runtimeState = observeRuntimeState(repositoryRoot, changeId);
  const role =
    source.primaryChangeId === changeId
      ? ('primary' as const)
      : source.concurrentChangeIds.includes(changeId)
        ? ('concurrent' as const)
        : null;
  if (
    requested !== undefined &&
    !requested.archived &&
    record.disposition === 'ready' &&
    runtimeState !== 'recovery-required' &&
    role !== null
  ) {
    if (requested.authority === null) {
      authorityPort.loadCurrentAuthority(repositoryRoot, changeId);
    }
    return Object.freeze({
      role,
      worksetDigest: routingWorksetDigest(
        source.primaryChangeId,
        source.concurrentChangeIds,
      ),
      concurrencyEnabled: source.concurrentChangeIds.length > 0,
    });
  }
  throw workflowError(
    'CHANGE_ROUTING_REQUIRED',
    `Change ${changeId} is not in the managed writer workset.`,
    ExitCode.guard,
    { recovery: 'Prepare and apply an exact change-routing review first.' },
  );
}

function applyIntent(
  source: ChangeLifecycleSource,
  intent: ChangeRoutingIntent,
  observed: readonly ObservedChange[],
): ChangeLifecycleSource {
  const records = new Map(
    source.records.map((record) => [record.changeId, record]),
  );
  for (const change of observed) {
    if (!change.archived && !records.has(change.changeId)) {
      records.set(change.changeId, readyRecord(change.changeId));
    }
  }
  let primaryChangeId = source.primaryChangeId;
  let concurrentChangeIds = [...source.concurrentChangeIds];
  const action = intent.action;
  if (action.kind === 'clear-focus') {
    primaryChangeId = null;
    concurrentChangeIds = [];
  } else if (action.kind === 'clear-concurrent') {
    concurrentChangeIds = [];
  } else {
    const change = requireActiveChange(observed, action.changeId);
    if (change.completed) {
      throw routingInvalid(
        'Completed changes cannot receive a routing action.',
      );
    }
    if (action.kind === 'focus') {
      const record =
        records.get(action.changeId) ?? readyRecord(action.changeId);
      if (record.disposition !== 'ready') {
        throw routingInvalid(
          'Blocked or parked changes must be resumed before focus.',
        );
      }
      primaryChangeId = action.changeId;
      concurrentChangeIds = concurrentChangeIds.filter(
        (changeId) => changeId !== action.changeId,
      );
    } else if (action.kind === 'set-concurrent') {
      if (primaryChangeId === null) {
        throw routingInvalid(
          'Concurrent work requires one managed primary change.',
        );
      }
      if (primaryChangeId === action.changeId) {
        throw routingInvalid(
          'The primary change cannot also be the concurrent change.',
        );
      }
      const record =
        records.get(action.changeId) ?? readyRecord(action.changeId);
      if (record.disposition !== 'ready') {
        throw routingInvalid(
          'Blocked or parked changes cannot enter the concurrent workset.',
        );
      }
      concurrentChangeIds = [action.changeId];
    } else if (action.kind === 'block') {
      if (
        !change.tasks.some(
          (task) => task.id === action.taskId && !task.completed,
        )
      ) {
        throw routingInvalid(
          'Blocked routing must identify one incomplete task.',
        );
      }
      records.set(
        action.changeId,
        Object.freeze({
          changeId: action.changeId,
          disposition: 'blocked' as const,
          reason: action.reason,
          taskId: action.taskId,
          blocker: action.blocker,
        }),
      );
      if (primaryChangeId === action.changeId) {
        primaryChangeId = null;
        concurrentChangeIds = [];
      }
      concurrentChangeIds = concurrentChangeIds.filter(
        (changeId) => changeId !== action.changeId,
      );
    } else if (action.kind === 'park') {
      records.set(
        action.changeId,
        Object.freeze({
          changeId: action.changeId,
          disposition: 'parked' as const,
          reason: action.reason,
          taskId: null,
          blocker: null,
        }),
      );
      if (primaryChangeId === action.changeId) {
        primaryChangeId = null;
        concurrentChangeIds = [];
      }
      concurrentChangeIds = concurrentChangeIds.filter(
        (changeId) => changeId !== action.changeId,
      );
    } else {
      const record = records.get(action.changeId);
      if (!record || record.disposition === 'ready') {
        throw routingInvalid('Only a blocked or parked change can be resumed.');
      }
      records.set(action.changeId, readyRecord(action.changeId));
    }
  }
  const activeIds = new Set(
    observed
      .filter((change) => !change.archived)
      .map((change) => change.changeId),
  );
  const nextRecords = [...records.values()]
    .filter((record) => activeIds.has(record.changeId))
    .sort((left, right) => left.changeId.localeCompare(right.changeId));
  assertChangeDependencyGraph(nextRecords, observed);
  return Object.freeze({
    schemaVersion: 1 as const,
    routingRevision: nextRoutingRevision(source.routingRevision),
    maxConcurrent: 1 as const,
    concurrentChangeIds: Object.freeze(
      concurrentChangeIds.filter((changeId) => activeIds.has(changeId)),
    ),
    primaryChangeId,
    records: Object.freeze(nextRecords),
  });
}

type ObservedChange = Readonly<{
  changeId: string;
  archived: boolean;
  completed: boolean;
  factsDigest: string;
  authorityChecked: boolean;
  authority: ChangeRoutingAuthorityFacts | null;
  tasks: readonly ParsedTask[];
}>;

function observeChanges(
  repositoryRoot: string,
  authorityPort?: ChangeRoutingAuthorityPort,
): readonly ObservedChange[] {
  const config = loadWorkflowConfig(repositoryRoot);
  const changeRoot = path.join(repositoryRoot, config.changeRoot);
  const active = fs
    .readdirSync(changeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) =>
      observeChange(
        repositoryRoot,
        path.join(changeRoot, entry.name),
        entry.name,
        false,
        authorityPort,
      ),
    );
  const archiveRoot = path.join(changeRoot, 'archive');
  const archiveStats = fs.lstatSync(archiveRoot, { throwIfNoEntry: false });
  const archived =
    archiveStats?.isDirectory() === true
      ? fs
          .readdirSync(archiveRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            observeChange(
              repositoryRoot,
              path.join(archiveRoot, entry.name),
              archivedChangeId(entry.name),
              true,
              authorityPort,
            ),
          )
      : [];
  return Object.freeze(
    [...active, ...archived].sort((left, right) =>
      left.changeId.localeCompare(right.changeId),
    ),
  );
}

function observeChange(
  repositoryRoot: string,
  directory: string,
  changeId: string,
  archived: boolean,
  authorityPort?: ChangeRoutingAuthorityPort,
): ObservedChange {
  const tasksPath = path.join(directory, 'tasks.md');
  const tasksStats = fs.lstatSync(tasksPath, { throwIfNoEntry: false });
  if (
    !tasksStats?.isFile() ||
    tasksStats.isSymbolicLink() ||
    tasksStats.nlink !== 1
  ) {
    throw routingInvalid('Change task source is not a plain file.');
  }
  const bytes = fs.readFileSync(tasksPath, 'utf8');
  const tasks = parseTasks(bytes);
  const authorityArtifacts = observeRoutingFacts(directory);
  const completed = tasks.length > 0 && tasks.every((task) => task.completed);
  const authorityChecked = archived || completed || authorityPort !== undefined;
  const authority =
    archived || completed || authorityPort === undefined
      ? null
      : tryLoadCurrentRoutingAuthority(authorityPort, repositoryRoot, changeId);
  return Object.freeze({
    changeId: assertChangeId(changeId),
    archived,
    completed,
    authorityChecked,
    factsDigest: digestBytes(
      canonicalJson({ archived, artifacts: authorityArtifacts, authority }),
    ),
    authority,
    tasks: Object.freeze(tasks),
  });
}

function observeRoutingFacts(directory: string): readonly Readonly<{
  path: string;
  mode: '100644' | '100755';
  digest: string;
}>[] {
  const facts: Array<{
    path: string;
    mode: '100644' | '100755';
    digest: string;
  }> = [];
  const visit = (current: string): void => {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const artifactPath = path.join(current, entry.name);
      const stats = fs.lstatSync(artifactPath);
      if (stats.isSymbolicLink()) {
        throw routingInvalid('Routing authority input cannot be a symlink.');
      }
      if (stats.isDirectory()) {
        visit(artifactPath);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1) {
        throw routingInvalid('Routing authority input is not a plain file.');
      }
      facts.push({
        path: path.relative(directory, artifactPath).split(path.sep).join('/'),
        mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
        digest: digestBuffer(fs.readFileSync(artifactPath)),
      });
    }
  };
  visit(directory);
  return Object.freeze(facts.map((fact) => Object.freeze(fact)));
}

function digestObservedRepositoryFacts(
  observed: readonly ObservedChange[],
): string {
  return digestBytes(
    canonicalJson(
      observed.map(({ changeId, archived, completed, factsDigest }) => ({
        changeId,
        archived,
        completed,
        factsDigest,
      })),
    ),
  );
}

function tryLoadCurrentRoutingAuthority(
  authorityPort: ChangeRoutingAuthorityPort,
  repositoryRoot: string,
  changeId: string,
): ChangeRoutingAuthorityFacts | null {
  try {
    return authorityPort.loadCurrentAuthority(repositoryRoot, changeId);
  } catch {
    return null;
  }
}

function requiredRoutingAuthorityFacts(
  repositoryRoot: string,
  intent: ChangeRoutingIntent,
  nextSource: ChangeLifecycleSource,
  observed: readonly ObservedChange[],
  authorityPort: ChangeRoutingAuthorityPort,
): readonly ChangeRoutingAuthorityFacts[] {
  const changeIds = new Set<string>();
  if (nextSource.primaryChangeId !== null) {
    changeIds.add(nextSource.primaryChangeId);
  }
  for (const changeId of nextSource.concurrentChangeIds) {
    changeIds.add(changeId);
  }
  if (
    intent.action.kind === 'focus' ||
    intent.action.kind === 'set-concurrent' ||
    intent.action.kind === 'resume'
  ) {
    changeIds.add(intent.action.changeId);
  }
  return Object.freeze(
    [...changeIds].sort().map((changeId) => {
      const current = observed.find(
        (change) => change.changeId === changeId,
      )?.authority;
      return (
        current ?? authorityPort.loadCurrentAuthority(repositoryRoot, changeId)
      );
    }),
  );
}

export function observeChangeRoutingContinuationState(
  repositoryRoot: string,
  requestedChangeId: string,
): Readonly<{
  kind: 'change-routing-continuation';
  digest: `sha256:${string}`;
  sourceDigest: `sha256:${string}`;
  record: RoutingRecord;
}> {
  const changeId = assertChangeId(requestedChangeId);
  const snapshot = readSourceSnapshot(repositoryRoot);
  if (snapshot.source === null || snapshot.digest === null) {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_NOT_REQUIRED',
      'A protected continuation requires an existing blocked or parked routing record.',
      ExitCode.guard,
    );
  }
  const record = snapshot.source.records.find(
    (candidate) => candidate.changeId === changeId,
  );
  if (record === undefined || !protectedContinuation(record)) {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_NOT_REQUIRED',
      'The selected routing record does not require Central Grant continuation.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    kind: 'change-routing-continuation' as const,
    digest: digestBytes(
      canonicalJson({
        kind: 'change-routing-continuation.v1',
        changeId,
        sourceDigest: snapshot.digest,
        record,
      }),
    ) as `sha256:${string}`,
    sourceDigest: snapshot.digest as `sha256:${string}`,
    record,
  });
}

function authorizeContinuation(
  repositoryRoot: string,
  source: ChangeLifecycleSource,
  sourceDigest: string | null,
  intent: ChangeRoutingIntent,
  observed: readonly ObservedChange[],
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): ChangeRoutingContinuationAuthority | null {
  if (intent.action.kind !== 'resume') return null;
  const action = intent.action;
  const record = source.records.find(
    (candidate) => candidate.changeId === action.changeId,
  );
  if (record === undefined || record.disposition === 'ready') {
    throw routingInvalid('Only a blocked or parked change can be resumed.');
  }
  if (!protectedContinuation(record)) {
    if (action.grantChallengeId !== undefined) {
      throw routingInvalid(
        'Automatic change continuation cannot consume a manual grant.',
      );
    }
    if (!blockerSatisfied(record.blocker, observed)) {
      throw workflowError(
        'CHANGE_ROUTING_RESUME_NOT_READY',
        'The exact automatic resume condition is not yet satisfied.',
        ExitCode.guard,
      );
    }
    return null;
  }
  if (action.grantChallengeId === undefined) {
    const continuation = observeChangeRoutingContinuationState(
      repositoryRoot,
      action.changeId,
    );
    if (sourceDigest === null || continuation.sourceDigest !== sourceDigest) {
      throw workflowError(
        'CHANGE_ROUTING_REVIEW_STALE',
        'The protected routing record changed while its continuation was being prepared.',
        ExitCode.staleState,
      );
    }
    throw workflowError(
      'CHANGE_ROUTING_GRANT_REQUIRED',
      'Manual, external, and parked continuation requires one exact completed Central Grant transition.',
      ExitCode.guard,
      {
        details: {
          schemaVersion: 1,
          kind: 'change-routing-grant-required.v1',
          changeId: action.changeId,
          sourceDigest: continuation.sourceDigest,
          stateBindingDigest: continuation.digest,
        },
        recovery:
          'Resolve the exact Central Grant challenge, add its challengeId to the resume intent, and prepare the review again.',
      },
    );
  }
  return verifyCompletedContinuationGrant(
    repositoryRoot,
    action.changeId,
    action.grantChallengeId,
    continuationGrantPort,
  );
}

function protectedContinuation(record: RoutingRecord): boolean {
  return (
    record.disposition === 'parked' ||
    (record.disposition === 'blocked' &&
      (record.blocker?.kind === 'external' ||
        record.blocker?.resumeCondition === 'manual'))
  );
}

function verifyCompletedContinuationGrant(
  repositoryRoot: string,
  changeId: string,
  challengeId: string,
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): ChangeRoutingContinuationAuthority {
  const observed = observeChangeRoutingContinuationState(
    repositoryRoot,
    changeId,
  );
  const record = continuationGrantPort.readGrantRecord(
    repositoryRoot,
    challengeId,
  );
  const expectedOutcome = Object.freeze({
    outcome: 'completed' as const,
    details: Object.freeze({
      authorized: true,
      changeId,
      sourceDigest: observed.sourceDigest,
      autoFocus: false,
    }),
  });
  if (
    !isRecord(record) ||
    record.state !== 'completed' ||
    !isRecord(record.outcome) ||
    record.outcome.outcome !== 'completed' ||
    !isRecord(record.challenge) ||
    record.challenge.sourceModuleId !== 'change-routing' ||
    record.challenge.failureCode !== 'protected-continuation-required' ||
    !isRecord(record.challenge.stateBinding) ||
    record.challenge.stateBinding.kind !== observed.kind ||
    record.challenge.stateBinding.digest !== observed.digest ||
    !Array.isArray(record.challenge.choices) ||
    !isRecord(record.approvalSubject) ||
    record.approvalSubject.stateDigest !== observed.digest ||
    record.poststateDigest !== observed.digest ||
    canonicalJson(record.outcome) !== canonicalJson(expectedOutcome) ||
    typeof record.approvalSubject.choiceId !== 'string' ||
    typeof record.operationId !== 'string' ||
    typeof record.challenge.challengeId !== 'string' ||
    typeof record.challenge.challengeDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record.challenge.challengeDigest)
  ) {
    throw invalidContinuationGrant();
  }
  const approvalChoiceId = record.approvalSubject.choiceId;
  const choice = record.challenge.choices.find(
    (candidate) =>
      isRecord(candidate) && candidate.choiceId === approvalChoiceId,
  );
  if (
    !isRecord(choice) ||
    choice.transitionId !== CHANGE_ROUTING_CONTINUATION_TRANSITION_ID ||
    choice.parameterSchemaDigest !==
      CHANGE_ROUTING_CONTINUATION_PARAMETER_SCHEMA_DIGEST ||
    choice.consequenceDigest !==
      CHANGE_ROUTING_CONTINUATION_CONSEQUENCE_DIGEST ||
    choice.resolutionKind !== 'non-retry' ||
    !isRecord(choice.parameters) ||
    !hasExactKeys(choice.parameters, ['changeId', 'sourceDigest']) ||
    choice.parameters.changeId !== changeId ||
    choice.parameters.sourceDigest !== observed.sourceDigest
  ) {
    throw invalidContinuationGrant();
  }
  return Object.freeze({
    contractVersion: 'central-grant-completed-authority-ref.v1' as const,
    challengeId: record.challenge.challengeId,
    challengeDigest: record.challenge.challengeDigest as `sha256:${string}`,
    transitionId: CHANGE_ROUTING_CONTINUATION_TRANSITION_ID,
    operationId: record.operationId,
    terminalOutcomeDigest: digestBytes(
      canonicalJson(record.outcome),
    ) as `sha256:${string}`,
  });
}

function invalidContinuationGrant() {
  return workflowError(
    'CHANGE_ROUTING_GRANT_INVALID',
    'The supplied Central Grant record is not the exact completed registered continuation transition.',
    ExitCode.verification,
  );
}

function assertChangeDependencyGraph(
  records: readonly RoutingRecord[],
  observed: readonly ObservedChange[],
): void {
  const observedIds = new Set(observed.map(({ changeId }) => changeId));
  const edges = new Map<string, string>();
  for (const record of records) {
    if (record.disposition !== 'blocked' || record.blocker?.kind !== 'change') {
      continue;
    }
    if (!observedIds.has(record.blocker.id)) {
      throw routingInvalid(
        'A change blocker must identify one tracked active or archived change.',
      );
    }
    edges.set(record.changeId, record.blocker.id);
  }
  for (const origin of edges.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = origin;
    while (current !== undefined) {
      if (visited.has(current)) {
        throw routingInvalid(
          'Change-routing blocker dependencies form a cycle.',
        );
      }
      visited.add(current);
      current = edges.get(current);
    }
  }
}

function archivedChangeId(entry: string): string {
  const match = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(entry);
  return match?.[1] ?? entry;
}

function synthesizeSource(
  observed: readonly ObservedChange[],
): ChangeLifecycleSource {
  const active = observed.filter((change) => !change.archived);
  return Object.freeze({
    schemaVersion: 1 as const,
    routingRevision: 0,
    maxConcurrent: 1 as const,
    concurrentChangeIds: Object.freeze([]),
    primaryChangeId: null,
    records: Object.freeze(
      active.map((change) => readyRecord(change.changeId)),
    ),
  });
}

function readyRecord(changeId: string): RoutingRecord {
  return Object.freeze({
    changeId,
    disposition: 'ready' as const,
    reason: null,
    taskId: null,
    blocker: null,
  });
}

function readSourceSnapshot(repositoryRoot: string): Readonly<{
  source: ChangeLifecycleSource | null;
  digest: string | null;
}> {
  const sourcePath = path.join(repositoryRoot, changeLifecycleRelativePath);
  const stats = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!stats) return { source: null, digest: null };
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw routingInvalid('Controlled lifecycle source is not a plain file.');
  }
  const bytes = fs.readFileSync(sourcePath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw routingInvalid('Controlled lifecycle source is not valid JSON.');
  }
  const source = parseChangeLifecycleSource(value);
  if (bytes !== prettyJson(source)) {
    throw routingInvalid(
      'Controlled lifecycle source bytes are not canonical.',
    );
  }
  return { source, digest: digestBytes(bytes) };
}

export function parseChangeLifecycleSource(
  value: unknown,
): ChangeLifecycleSource {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'concurrentChangeIds',
      'maxConcurrent',
      'primaryChangeId',
      'records',
      'routingRevision',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.routingRevision) ||
    Number(value.routingRevision) < 0 ||
    value.maxConcurrent !== 1 ||
    !Array.isArray(value.concurrentChangeIds) ||
    value.concurrentChangeIds.length > 1 ||
    !Array.isArray(value.records)
  ) {
    throw routingInvalid('Controlled lifecycle source has an invalid schema.');
  }
  const records = value.records.map(parseRecord);
  const ids = records.map((record) => record.changeId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => id !== [...ids].sort()[index])
  ) {
    throw routingInvalid(
      'Controlled lifecycle records must be unique and sorted.',
    );
  }
  const primaryChangeId =
    value.primaryChangeId === null
      ? null
      : assertChangeIdValue(value.primaryChangeId);
  if (primaryChangeId !== null && !ids.includes(primaryChangeId)) {
    throw routingInvalid(
      'Controlled lifecycle primary change is not registered.',
    );
  }
  const concurrentChangeIds =
    value.concurrentChangeIds.map(assertChangeIdValue);
  if (
    new Set(concurrentChangeIds).size !== concurrentChangeIds.length ||
    concurrentChangeIds.some((changeId) => !ids.includes(changeId)) ||
    (primaryChangeId !== null &&
      concurrentChangeIds.includes(primaryChangeId)) ||
    concurrentChangeIds.some(
      (changeId) =>
        records.find((record) => record.changeId === changeId)?.disposition !==
        'ready',
    )
  ) {
    throw routingInvalid(
      'Controlled lifecycle concurrent workset is inconsistent.',
    );
  }
  if (concurrentChangeIds.length > 0 && primaryChangeId === null) {
    throw routingInvalid(
      'Controlled lifecycle concurrent work requires one primary change.',
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    routingRevision: value.routingRevision as number,
    maxConcurrent: 1 as const,
    concurrentChangeIds: Object.freeze(concurrentChangeIds),
    primaryChangeId,
    records: Object.freeze(records),
  });
}

function nextRoutingRevision(current: number): number {
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw workflowError(
      'CHANGE_ROUTING_REVISION_EXHAUSTED',
      'The controlled lifecycle routing revision cannot advance safely.',
      ExitCode.guard,
    );
  }
  return current + 1;
}

function routingWorksetDigest(
  primaryChangeId: string | null,
  concurrentChangeIds: readonly string[],
): string {
  return digestBytes(
    canonicalJson({
      schemaVersion: 1,
      maxConcurrent: 1,
      primaryChangeId,
      concurrentChangeIds: [...concurrentChangeIds],
    }),
  );
}

function parseRecord(value: unknown): RoutingRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'blocker',
      'changeId',
      'disposition',
      'reason',
      'taskId',
    ]) ||
    !['ready', 'blocked', 'parked'].includes(String(value.disposition))
  ) {
    throw routingInvalid('Controlled lifecycle record is invalid.');
  }
  const disposition = value.disposition as RoutingRecord['disposition'];
  if (disposition === 'ready') {
    if (
      value.reason !== null ||
      value.taskId !== null ||
      value.blocker !== null
    ) {
      throw routingInvalid('Ready lifecycle records cannot carry blockers.');
    }
    return readyRecord(assertChangeIdValue(value.changeId));
  }
  if (disposition === 'parked') {
    if (value.taskId !== null || value.blocker !== null) {
      throw routingInvalid('Parked lifecycle records cannot carry blockers.');
    }
    return Object.freeze({
      changeId: assertChangeIdValue(value.changeId),
      disposition,
      reason: assertReason(value.reason),
      taskId: null,
      blocker: null,
    });
  }
  if (!isRecord(value.blocker)) {
    throw routingInvalid('Blocked lifecycle records require one blocker.');
  }
  return Object.freeze({
    changeId: assertChangeIdValue(value.changeId),
    disposition,
    reason: assertReason(value.reason),
    taskId: assertIdentifier(value.taskId, 'taskId'),
    blocker: parseBlocker(value.blocker),
  });
}

function parseBlocker(value: Record<string, unknown>): ChangeRoutingBlocker {
  assertExactKeys(value, ['id', 'kind', 'resumeCondition']);
  if (!['change', 'external'].includes(String(value.kind))) {
    throw routingInvalid('Routing blocker kind is unsupported.');
  }
  if (
    !['done', 'merged', 'archived', 'manual'].includes(
      String(value.resumeCondition),
    )
  ) {
    throw routingInvalid('Routing resume condition is unsupported.');
  }
  return Object.freeze({
    kind: value.kind as ChangeRoutingBlocker['kind'],
    id: assertIdentifier(value.id, 'blocker id'),
    resumeCondition:
      value.resumeCondition as ChangeRoutingBlocker['resumeCondition'],
  });
}

function blockerSatisfied(
  blocker: ChangeRoutingBlocker | null,
  observed: readonly ObservedChange[],
): boolean {
  if (blocker === null || blocker.resumeCondition === 'manual') return false;
  if (blocker.kind === 'change') {
    const dependency = observed.find(
      (change) => change.changeId === blocker.id,
    );
    if (!dependency) return false;
    return blocker.resumeCondition === 'archived'
      ? dependency.archived
      : dependency.archived || dependency.completed;
  }
  return false;
}

function observeRuntimeState(
  repositoryRoot: string,
  changeId: string,
): 'revising' | 'recovery-required' | null {
  try {
    const git = discoverRepository(repositoryRoot);
    const config = loadWorkflowConfig(repositoryRoot);
    const runtime = runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    );
    const sessionDirectory = runtime.sessions;
    const sessionStats = fs.lstatSync(sessionDirectory, {
      throwIfNoEntry: false,
    });
    if (sessionStats?.isDirectory()) {
      for (const entry of fs.readdirSync(sessionDirectory).sort()) {
        if (!entry.endsWith('.json')) continue;
        const value = JSON.parse(
          fs.readFileSync(path.join(sessionDirectory, entry), 'utf8'),
        ) as unknown;
        if (
          isRecord(value) &&
          value.changeId === changeId &&
          value.state === 'revising'
        ) {
          return 'revising';
        }
      }
    }
    const transactionDirectory = path.join(
      runtime.root,
      'open-task',
      'transactions',
    );
    const transactionStats = fs.lstatSync(transactionDirectory, {
      throwIfNoEntry: false,
    });
    if (transactionStats?.isDirectory()) {
      for (const entry of fs.readdirSync(transactionDirectory).sort()) {
        if (!entry.endsWith('.json')) continue;
        let value: unknown;
        try {
          value = JSON.parse(
            fs.readFileSync(path.join(transactionDirectory, entry), 'utf8'),
          ) as unknown;
        } catch {
          return 'recovery-required';
        }
        if (
          isRecord(value) &&
          value.changeId === changeId &&
          value.phase !== 'completed' &&
          typeof value.sessionId === 'string'
        ) {
          const sessionPath = path.join(
            runtime.sessions,
            `${value.sessionId}.json`,
          );
          if (!fs.existsSync(sessionPath)) return 'recovery-required';
        }
      }
    }
  } catch {
    return 'recovery-required';
  }
  return null;
}

function requireActiveChange(
  observed: readonly ObservedChange[],
  changeId: string,
): ObservedChange {
  const change = observed.find(
    (candidate) => candidate.changeId === changeId && !candidate.archived,
  );
  if (!change) throw routingInvalid(`Change ${changeId} is not active.`);
  return change;
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digestSource(value: unknown): string {
  // canonicalJson rejects non-data values/prototypes before the human-readable
  // controlled file encoding is digested.
  canonicalJson(value);
  return digestBytes(prettyJson(value));
}

function digestBytes(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function digestBuffer(value: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw routingInvalid('Change-routing digest is invalid.');
  }
  return value;
}

function assertPlainSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw routingInvalid(`Change-routing ${label} is invalid.`);
  }
  return value;
}

function parseRoutingAuthorityFacts(
  value: unknown,
): ChangeRoutingAuthorityFacts {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'investigationTargetDigest',
      'manifestDigest',
      'planTargetDigest',
      'planningGenerationId',
      'reviewNodeId',
      'reviewResultDigest',
      'reviewRoleResultDigest',
    ])
  ) {
    throw routingInvalid('Change-routing authority facts are invalid.');
  }
  return Object.freeze({
    changeId: assertChangeIdValue(value.changeId),
    manifestDigest: assertPlainSha256(value.manifestDigest, 'Manifest digest'),
    investigationTargetDigest: assertPlainSha256(
      value.investigationTargetDigest,
      'investigation target digest',
    ),
    planningGenerationId: assertPlainSha256(
      value.planningGenerationId,
      'planning generation',
    ),
    planTargetDigest: assertPlainSha256(
      value.planTargetDigest,
      'plan target digest',
    ),
    reviewNodeId: assertPlainSha256(value.reviewNodeId, 'review node'),
    reviewResultDigest: assertPlainSha256(
      value.reviewResultDigest,
      'review result digest',
    ),
    reviewRoleResultDigest: assertPlainSha256(
      value.reviewRoleResultDigest,
      'review role-result digest',
    ),
  });
}

function parseContinuationAuthority(
  value: unknown,
): ChangeRoutingContinuationAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'challengeDigest',
      'challengeId',
      'contractVersion',
      'operationId',
      'terminalOutcomeDigest',
      'transitionId',
    ]) ||
    value.contractVersion !== 'central-grant-completed-authority-ref.v1' ||
    value.transitionId !== CHANGE_ROUTING_CONTINUATION_TRANSITION_ID
  ) {
    throw routingInvalid('Change-routing continuation authority is invalid.');
  }
  return Object.freeze({
    contractVersion: 'central-grant-completed-authority-ref.v1' as const,
    challengeId: assertGrantChallengeId(value.challengeId),
    challengeDigest: assertDigest(value.challengeDigest) as `sha256:${string}`,
    transitionId: CHANGE_ROUTING_CONTINUATION_TRANSITION_ID,
    operationId: assertGrantChallengeId(value.operationId),
    terminalOutcomeDigest: assertDigest(
      value.terminalOutcomeDigest,
    ) as `sha256:${string}`,
  });
}

function assertGrantChallengeId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw routingInvalid('Central Grant challenge id is invalid.');
  }
  return value;
}

function assertChangeIdValue(value: unknown): string {
  if (typeof value !== 'string') throw routingInvalid('Change id is invalid.');
  return assertChangeId(value);
}

function assertIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 160 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) {
    throw routingInvalid(`Routing ${label} is invalid.`);
  }
  return value;
}

function assertReason(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 3 ||
    value.length > 500
  ) {
    throw routingInvalid('Routing reason must be bounded canonical text.');
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (!hasExactKeys(value, keys)) {
    throw routingInvalid('Change-routing object has unexpected fields.');
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function routingInvalid(message: string) {
  return workflowError(
    'CHANGE_ROUTING_INVALID',
    message,
    ExitCode.verification,
  );
}

function routingCommitUnauthorized() {
  return workflowError(
    'CHANGE_ROUTING_COMMIT_UNAUTHORIZED',
    'The staged lifecycle source was not produced by the exact reviewed route transition.',
    ExitCode.guard,
  );
}
