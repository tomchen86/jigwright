import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTaskStatusQuery,
  type TaskStatusOperations,
} from '../src/application/session-inspection/task-status.ts';
import type { WorkflowSession } from '../src/modules/lifecycle/workflow-session-contract.ts';
import type { OpenTaskLifecycleStatus } from '../src/modules/lifecycle/open-task-status.ts';
import type { GovernanceIntakeCountsV1 } from '../src/modules/governance-intake/intake-summary.ts';

const cwd = '/caller/subdirectory';

function session(state: WorkflowSession['state'] = 'active'): WorkflowSession {
  return {
    schemaVersion: 1,
    sessionId: `session-${state}`,
    changeId: `change-${state}`,
    taskId: '1.1',
    state,
    repositoryRoot: `/worktrees/${state}`,
    gitCommonDirectory: '/shared/git',
    branch: `work/${state}`,
    baseline: { head: 'head', tree: 'tree' },
    artifacts: {},
    allowedPaths: [],
    requiredChecks: [],
    requiredCheckDigests: {},
    planningAssurance: null,
    isolation: {
      schemaVersion: 1,
      routingRole: 'concurrent',
      routingWorksetDigest: 'sha256:workset',
      concurrencyEnabled: true,
      worktreeDigest: 'sha256:worktree',
      resources: [],
    },
    createdAt: '2026-10-02T00:00:00Z',
  };
}

function openTask(
  state: OpenTaskLifecycleStatus['state'],
): OpenTaskLifecycleStatus {
  return {
    kind: 'open-task-lifecycle-status.v1',
    state,
    lastDurablePhase: 'session-active',
    transactionId: 'transaction-id',
    changeId: 'change-id',
    taskId: '1.1',
    mandateTaskId: null,
    sessionId: 'session-from-open-task',
    parentCommit: 'parent',
    planningCommit: 'planning',
    baselineTree: 'baseline',
    reportId: 'report-id',
    retrySafe: false,
    recoveryCommand: 'recover exact task',
    errorCode: null,
  };
}

function observations(sessions = [session()]) {
  const events: string[][] = [];
  const error = new Error('observation failed');
  const propose = { investigation: { opaque: 'propose detail' } };
  const finalize = { durable: { phase: 17 } };
  const strategy = { decisions: ['opaque strategy detail'] };
  const revision = { lease: { revision: 4 } };
  const commits = [
    { hash: 'second', subject: 'second subject' },
    { hash: 'first', subject: 'first subject' },
  ];
  const state: {
    counts: GovernanceIntakeCountsV1;
    openTask: OpenTaskLifecycleStatus | null;
    finalize: typeof finalize | false | null;
    revision: typeof revision | null;
    failAt: number;
  } = {
    counts: { schemaVersion: 1, inbox: 2, pendingFindings: 3, backlog: 5 },
    openTask: null,
    finalize,
    revision,
    failAt: 0,
  };
  function observe(...event: string[]) {
    events.push(event);
    if (events.length === state.failAt) throw error;
  }
  const operations = {
    currentGovernanceIntakeCounts(root) {
      observe('counts', root);
      return state.counts;
    },
    getProposeStatus(root, id) {
      observe('propose', root, id);
      return propose;
    },
    findOpenTaskLifecycleStatus(root, id) {
      observe('open', root, id);
      return state.openTask;
    },
    getSession(root, id) {
      observe('session', root, id);
      return sessions[0]!;
    },
    listSessions(root) {
      observe('sessions', root);
      return sessions;
    },
    inspectFinalizeRecoveryStatus(root, id) {
      observe('finalize', root, id);
      return state.finalize;
    },
    inspectTaskStrategyLifecycle(root, id) {
      observe('strategy', root, id);
      return strategy;
    },
    inspectTaskRevisionStatus(root, id) {
      observe('revision', root, id);
      return state.revision;
    },
    findTaskCommits(root, changeId, taskId) {
      observe('commits', root, changeId, taskId);
      return commits;
    },
  } satisfies TaskStatusOperations<
    typeof propose,
    typeof finalize | false,
    typeof strategy,
    typeof revision
  >;
  return {
    events,
    error,
    state,
    operations,
    sessions,
    propose,
    finalize,
    strategy,
    revision,
    commits,
  };
}

test('task status binds lazily, keeps instances independent and observes fresh counts on each call', () => {
  const first = observations();
  const second = observations();
  const query = createTaskStatusQuery(first.operations);
  const otherQuery = createTaskStatusQuery(second.operations);
  assert.deepEqual(first.events, []);
  assert.deepEqual(second.events, []);
  const before = query(cwd, 'investigation-fresh');
  first.state.counts = {
    schemaVersion: 1,
    inbox: 8,
    pendingFindings: 0,
    backlog: 0,
  };
  const after = query(cwd, 'investigation-fresh');
  assert.notEqual(before.intakeCounts, after.intakeCounts);
  assert.equal(after.intakeCounts, first.state.counts);
  assert.deepEqual(first.events, [
    ['counts', cwd],
    ['propose', cwd, 'investigation-fresh'],
    ['counts', cwd],
    ['propose', cwd, 'investigation-fresh'],
  ]);
  assert.deepEqual(second.events, []);
  assert.equal(
    otherQuery(cwd, 'investigation-other').intakeCounts,
    second.state.counts,
  );
});

test('task status routes an exact investigation prefix and preserves its full inferred result', () => {
  const f = observations();
  const result = createTaskStatusQuery(f.operations)(
    cwd,
    'investigation-opaque value',
  );
  assert.deepEqual(f.events, [
    ['counts', cwd],
    ['propose', cwd, 'investigation-opaque value'],
  ]);
  assert.deepEqual(Object.keys(result), ['intakeCounts', 'result']);
  assert.equal(result.intakeCounts, f.state.counts);
  assert.equal(result.result, f.propose);
  assert.equal(result.result?.investigation.opaque, 'propose detail');
});

test('task status returns opening and recovery-required records before observing any session', () => {
  for (const state of ['opening', 'recovery-required'] as const) {
    const f = observations();
    f.state.openTask = openTask(state);
    const result = createTaskStatusQuery(f.operations)(cwd, 'change-alias');
    assert.deepEqual(f.events, [
      ['counts', cwd],
      ['open', cwd, 'change-alias'],
    ]);
    assert.deepEqual(Object.keys(result), ['intakeCounts', 'openTask']);
    assert.equal(result.intakeCounts, f.state.counts);
    assert.equal(result.openTask, f.state.openTask);
  }
});

test('task status resolves one session and uses its actual state for every ordered observation', () => {
  for (const [state, root] of [
    ['active', '/worktrees/active'],
    ['revising', '/worktrees/revising'],
    ['committed', cwd],
    ['aborted', cwd],
  ] as const) {
    for (const viaOpen of [false, true]) {
      for (const finalizePresent of [true, false, null]) {
        const f = observations([session(state)]);
        // Deliberately disagree with the durable session's state/root selection.
        f.state.openTask = viaOpen
          ? openTask(root === cwd ? 'active' : 'committed')
          : null;
        f.state.finalize =
          finalizePresent === true ? f.finalize : finalizePresent;
        f.state.revision = viaOpen ? f.revision : null;
        const result = createTaskStatusQuery(f.operations)(cwd, 'caller-alias');
        assert.deepEqual(f.events, [
          ['counts', cwd],
          ['open', cwd, 'caller-alias'],
          ['session', cwd, viaOpen ? 'session-from-open-task' : 'caller-alias'],
          ['finalize', root, `session-${state}`],
          ['strategy', root, `session-${state}`],
          ['revision', root, `session-${state}`],
          ['commits', root, `change-${state}`, '1.1'],
        ]);
        assert.deepEqual(Object.keys(result), [
          'intakeCounts',
          ...(viaOpen ? ['openTask'] : []),
          'session',
          ...(finalizePresent ? ['finalize'] : []),
          'taskStrategy',
          'taskRevision',
          'taskCommits',
        ]);
        assert.equal(result.intakeCounts, f.state.counts);
        assert.equal(result.openTask, f.state.openTask ?? undefined);
        assert.ok('session' in result);
        assert.equal(result.session, f.sessions[0]);
        assert.equal(result.finalize, finalizePresent ? f.finalize : undefined);
        assert.equal(
          result.finalize?.durable.phase,
          finalizePresent ? 17 : undefined,
        );
        assert.equal(result.taskStrategy, f.strategy);
        assert.equal(result.taskStrategy?.decisions, f.strategy.decisions);
        assert.equal(result.taskRevision, f.state.revision);
        assert.equal(
          result.taskRevision?.lease.revision,
          viaOpen ? 4 : undefined,
        );
        assert.equal(result.taskCommits, f.commits);
      }
    }
  }
});

test('task status does not normalize identifiers before deciding the route', () => {
  for (const identifier of ['INVESTIGATION-x', ' investigation-x', ' ']) {
    const f = observations();
    createTaskStatusQuery(f.operations)(cwd, identifier);
    assert.deepEqual(f.events.slice(0, 3), [
      ['counts', cwd],
      ['open', cwd, identifier],
      ['session', cwd, identifier],
    ]);
  }
});

const inventoryTrace = [
  ['counts', cwd],
  ['sessions', cwd],
  ['strategy', '/worktrees/revising', 'session-revising'],
  ['strategy', cwd, 'session-aborted'],
  ['strategy', '/worktrees/active', 'session-active'],
  ['strategy', cwd, 'session-committed'],
  ['revision', '/worktrees/revising', 'session-revising'],
  ['revision', cwd, 'session-aborted'],
  ['revision', '/worktrees/active', 'session-active'],
  ['revision', cwd, 'session-committed'],
  ['commits', '/worktrees/revising', 'change-revising', '1.1'],
  ['commits', cwd, 'change-aborted', '1.1'],
  ['commits', '/worktrees/active', 'change-active', '1.1'],
  ['commits', cwd, 'change-committed', '1.1'],
];

function inventorySessions() {
  return [
    session('revising'),
    session('aborted'),
    session('active'),
    session('committed'),
  ];
}

test('task status inventories in three ordered passes, preserving session and producer references', () => {
  const f = observations(inventorySessions());
  const strategies = f.sessions.map(({ sessionId }) => ({
    decisions: [sessionId],
  }));
  const revisions = f.sessions.map((_, i) =>
    i === 1 ? null : { lease: { revision: i } },
  );
  const result = createTaskStatusQuery({
    ...f.operations,
    inspectTaskStrategyLifecycle(root, id) {
      f.operations.inspectTaskStrategyLifecycle(root, id);
      return strategies[f.sessions.findIndex((s) => s.sessionId === id)]!;
    },
    inspectTaskRevisionStatus(root, id) {
      f.operations.inspectTaskRevisionStatus(root, id);
      return revisions[f.sessions.findIndex((s) => s.sessionId === id)]!;
    },
  })(cwd);
  assert.deepEqual(f.events, inventoryTrace);
  assert.deepEqual(Object.keys(result), [
    'intakeCounts',
    'sessions',
    'taskStrategies',
    'taskRevisions',
    'taskCommits',
  ]);
  assert.equal(result.intakeCounts, f.state.counts);
  assert.equal(result.sessions, f.sessions);
  assert.deepEqual(result.taskStrategies, strategies);
  assert.deepEqual(result.taskRevisions, revisions);
  assert.ok(result.sessions && result.taskStrategies && result.taskRevisions);
  for (const [i, row] of result.taskCommits.entries()) {
    assert.equal(result.taskStrategies[i], strategies[i]);
    assert.equal(result.taskRevisions[i], revisions[i]);
    assert.deepEqual(Object.keys(row), ['changeId', 'taskId', 'commits']);
    assert.deepEqual(row, {
      changeId: f.sessions[i]!.changeId,
      taskId: '1.1',
      commits: f.commits,
    });
    assert.equal(row.commits, f.commits);
  }
});

test('task status treats absent and empty identifiers as inventory, including empty lists and null revisions', () => {
  for (const identifier of [undefined, '']) {
    const f = observations([]);
    const result = createTaskStatusQuery(f.operations)(cwd, identifier);
    assert.deepEqual(f.events, [
      ['counts', cwd],
      ['sessions', cwd],
    ]);
    assert.equal(result.sessions, f.sessions);
    assert.deepEqual(result, {
      intakeCounts: f.state.counts,
      sessions: [],
      taskStrategies: [],
      taskRevisions: [],
      taskCommits: [],
    });
  }
  const f = observations();
  f.state.revision = null;
  assert.deepEqual(createTaskStatusQuery(f.operations)(cwd).taskRevisions, [
    null,
  ]);
});

test('task status propagates the same error and stops immediately at every reachable observation', () => {
  const sessionTrace = [
    ['counts', cwd],
    ['open', cwd, 'alias'],
    ['session', cwd, 'alias'],
    ['finalize', '/worktrees/active', 'session-active'],
    ['strategy', '/worktrees/active', 'session-active'],
    ['revision', '/worktrees/active', 'session-active'],
    ['commits', '/worktrees/active', 'change-active', '1.1'],
  ];
  for (const route of [
    {
      identifier: 'investigation-fail',
      open: null,
      sessions: [session()],
      trace: [
        ['counts', cwd],
        ['propose', cwd, 'investigation-fail'],
      ],
    },
    {
      identifier: 'alias',
      open: openTask('opening'),
      sessions: [session()],
      trace: sessionTrace.slice(0, 2),
    },
    {
      identifier: 'alias',
      open: null,
      sessions: [session()],
      trace: sessionTrace,
    },
    {
      identifier: 'alias',
      open: openTask('active'),
      sessions: [session()],
      trace: sessionTrace.map((event, i) =>
        i === 2 ? ['session', cwd, 'session-from-open-task'] : event,
      ),
    },
    {
      identifier: undefined,
      open: null,
      sessions: inventorySessions(),
      trace: inventoryTrace,
    },
  ]) {
    for (let failAt = 1; failAt <= route.trace.length; failAt++) {
      const f = observations(route.sessions);
      f.state.openTask = route.open;
      f.state.failAt = failAt;
      assert.throws(
        () => createTaskStatusQuery(f.operations)(cwd, route.identifier),
        (error) => error === f.error,
      );
      assert.deepEqual(f.events, route.trace.slice(0, failAt));
    }
  }
});
