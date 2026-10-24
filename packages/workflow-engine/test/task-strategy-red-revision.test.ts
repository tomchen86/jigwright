import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
} from '../src/foundation/evidence-node/evidence-node.ts';
import { workflowError, ExitCode } from '../src/foundation/errors/errors.ts';
import type { WorkflowSession } from '../src/modules/lifecycle/workflow-session-contract.ts';
import type { SessionInspection } from '../src/modules/lifecycle/session-inspection.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from '../src/modules/planning-provider/planning-artifact-types.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyTransactionInput,
  TaskStrategyPatchRecord,
  TaskStrategyPatchCurrentBinding,
  TaskStrategyRedRevisionRequest,
  PreparedTaskStrategyRed,
} from '../src/modules/assurance/task-strategy-evidence.ts';
import {
  prepareTaskStrategyTransaction,
  parseTaskStrategyTransaction,
  isSameReviewedTaskStrategyLineage,
} from '../src/modules/assurance/task-strategy-transaction.ts';
import {
  createTaskStrategyCurrentRef,
  parseTaskStrategyCurrentRef,
  type TaskStrategyCurrentRef,
} from '../src/modules/assurance/task-strategy-current-ref.ts';
import {
  buildRevisionJournal,
  assertNextJournalState,
  sameJournalState,
  requestSnapshot,
  type TaskStrategyRedRevisionJournal,
  type TaskStrategyRedRevisionJournalState,
} from '../src/modules/assurance/task-strategy-red-revision-contract.ts';
import { TASK_STRATEGY_RED_REVISION_PHASES } from '../src/modules/assurance/task-strategy-red-revision-values.ts';
import { createTaskStrategyRedRevisionService } from '../src/application/execute-task/task-strategy-red-revision.ts';
import type {
  TaskStrategyRedRevisionOperations,
  TaskStrategyRedRevisionJournalOperations,
} from '../src/application/execute-task/task-strategy-red-revision-operations.ts';
import type { ImplementationReconciliationGate } from '../src/modules/why-knowledge/implementation-reconciliation.ts';

const NOW = '2026-09-23T01:00:00.000Z';
const ROOT = '/memory/task-strategy';
const digest = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => digest(canonicalJson(value));
const code = (suffix: string) => ({
  code: 'TASK_STRATEGY_RED_REVISION_' + suffix,
});
const sentinel = new Error('port fault sentinel');
function stateOf(
  journal: TaskStrategyRedRevisionJournal,
): TaskStrategyRedRevisionJournalState {
  const {
    schemaVersion,
    kind,
    journalDigest,
    previousJournalDigest,
    ...state
  } = journal;
  return state;
}
function inputOf(
  transaction: TaskStrategyTransaction,
): TaskStrategyTransactionInput {
  const { schemaVersion, kind, recordDigest, ...input } = transaction;
  return input;
}
function facts(options: { single?: boolean } = { single: true }) {
  const session: WorkflowSession = {
    schemaVersion: 1,
    sessionId: 'session-memory',
    changeId: 'memory-change',
    taskId: '1.1',
    state: 'active',
    repositoryRoot: ROOT,
    gitCommonDirectory: `${ROOT}/.git`,
    branch: 'work/memory',
    baseline: { head: '1'.repeat(40), tree: '2'.repeat(40) },
    artifacts: {},
    allowedPaths: ['src/**', 'test/**'],
    requiredChecks: ['unit'],
    requiredCheckDigests: {},
    planningAssurance: null,
    createdAt: NOW,
    isolation: {
      schemaVersion: 1,
      routingRole: 'single',
      routingWorksetDigest: `sha256:${digest('workset')}`,
      concurrencyEnabled: false,
      worktreeDigest: `sha256:${digest('worktree')}`,
      resources: [],
    },
  };
  const git = {
    repositoryRoot: ROOT,
    repositoryRealPath: ROOT,
    gitCommonDirectory: `${ROOT}/.git`,
    branch: session.branch,
    head: session.baseline.head,
    tree: session.baseline.tree,
    statusEntries: [],
  };
  const commonTask = {
    allowedPaths: session.allowedPaths,
    requiredChecks: ['unit'],
    diffReview: 'required' as const,
    enforcement: 'planned' as const,
    behaviorContractRefs: [
      {
        specPath: 'specs/feature/spec.md',
        requirement: 'Preserve implementation behavior',
        scenario: null,
      },
    ],
    testPathScopes: ['test/**'],
    fixturePathScopes: [],
    implementationPathScopes: ['src/**'],
    redCheck: 'unit',
    greenChecks: ['unit'],
  };
  const task: CrossAgentTddExecution | TddSingleAgentExecution = options.single
    ? {
        ...commonTask,
        strategy: 'tdd-single-agent',
        requiredImplementerIndependence: 'none',
      }
    : {
        ...commonTask,
        strategy: 'cross-agent-tdd',
        requiredImplementerIndependence: 'session-independent',
      };
  const redNode = createEvidenceNode({
    type: 'task-strategy-red-evidence',
    nodeSchema: 'fixture.red.v1',
    evaluator: 'fixture.v1',
    policyDigest: digest('red-policy'),
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.red-output.v1',
    output: { failed: true },
    runtimeMetadata: {},
  });
  const transaction = prepareTaskStrategyTransaction({
    sessionId: session.sessionId,
    changeId: session.changeId,
    taskId: session.taskId,
    baseline: session.baseline,
    strategy: task.strategy,
    phase: 'red-sealed',
    taskContractDigest: hash(task),
    author: { providerId: 'codex', assurance: 'runtime-hint' },
    createdAt: NOW,
    red: {
      candidateTree: '3'.repeat(40),
      changedPaths: ['test/feature.test.ts'],
      checkId: 'unit',
      runner: 'node',
      runnerDigest: digest('runner'),
      exitCode: 1,
      failureCategory: 'assertion',
      selector: 'unit',
      testPaths: ['test/feature.test.ts'],
      fixturePaths: [],
      files: [
        {
          path: 'test/feature.test.ts',
          mode: '100644',
          objectId: '4'.repeat(40),
        },
      ],
      stdoutDigest: digest('failed'),
      stderrDigest: digest(''),
      failureFingerprint: digest('red-failure'),
      evidenceNodeId: redNode.nodeId,
      evidenceResultDigest: redNode.resultDigest,
      evidenceNode: redNode,
    },
  });
  const config = {
    schemaVersion: 1 as const,
    repositoryName: 'memory',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main'],
    branchTemplate: 'work/{changeId}',
  };
  const inspection: SessionInspection = {
    git,
    session,
    policy: { allowedPaths: session.allowedPaths, requiredChecks: ['unit'] },
    artifactDigests: {},
    changedPaths: [...transaction.red.changedPaths],
    unexpectedPaths: [],
    fingerprint: digest('inspection'),
    tasksPath: 'tasks.md',
    baselineTasks: '',
    contract: {
      changeId: session.changeId,
      changeDirectory: 'openspec/changes/memory-change',
      schemaName: 'fixture',
      config,
      checks: {
        schemaVersion: 1,
        checks: {
          unit: { command: ['node', 'unit.mjs'], destructiveDatabase: false },
        },
      },
      guard: {
        schemaVersion: 1,
        changeId: session.changeId,
        tasks: {
          '1.1': {
            allowedPaths: session.allowedPaths,
            requiredChecks: ['unit'],
          },
        },
      },
      tasks: [{ id: '1.1', completed: false, title: 'Memory implementation' }],
      behaviorContracts: commonTask.behaviorContractRefs,
      execution: {
        schemaVersion: 1,
        kind: 'execution-artifact',
        changeId: session.changeId,
        tasks: { '1.1': task },
      },
      artifactPaths: [],
      artifactDigests: {},
      openspec: {
        version: '1.6.0',
        schemaName: 'fixture',
        statusComplete: true,
        validationValid: true,
      },
      diagnostics: [],
      artifactModes: {},
      contractDigest: digest('contract'),
      planningAssurance: null,
      planningProvider: {
        source: 'explicit',
        artifactPath: 'workflow/change-providers/memory-change.json',
        bindingDigest: digest('planning'),
        binding: {
          schemaVersion: 1,
          changeId: session.changeId,
          providerId: 'fixture',
          adapterContractVersion: 1,
          providerRequirement: { package: 'fixture', version: '1' },
          planningRoot: 'openspec',
        },
      },
    },
  };
  return { session, inspection, transaction, task };
}

type Event = { name: string; args: unknown[]; frame?: number };
function memory() {
  const f = facts();
  f.session.latestCheckReportId = 'check-before';
  const layout = {
    root: '/lock/root',
    locks: '/lock/locks',
    operations: '/lock/operations',
    sessions: '/lock/sessions',
    reports: '/lock/reports',
    taskRevisions: '/lock/revisions',
  };
  const request: TaskStrategyRedRevisionRequest = {
    schemaVersion: 1,
    kind: 'task-strategy-red-revision-request',
    sessionId: f.session.sessionId,
    expectedTransactionDigest: f.transaction.recordDigest,
    reason: 'Correct the expectation',
  };
  const initialRef = createTaskStrategyCurrentRef({
    sessionId: f.session.sessionId,
    state: 'red-sealed',
    transactionDigest: f.transaction.recordDigest,
    predecessorTransactionDigest: null,
    revisionId: null,
    taskContractDigest: f.transaction.taskContractDigest,
    updatedAt: NOW,
  });
  assert.ok(initialRef.state === 'red-sealed');
  const successorInput: TaskStrategyTransactionInput = {
    ...inputOf(f.transaction),
    red: { ...f.transaction.red, candidateTree: '5'.repeat(40) },
    createdAt: '2026-09-23T01:00:01.000Z',
  };
  const state = {
    session: f.session,
    ref: initialRef as TaskStrategyCurrentRef | null,
    transaction: f.transaction as TaskStrategyTransaction | null,
    requests: new Map<string, TaskStrategyRedRevisionRequest>(),
    journals: new Map<string, TaskStrategyRedRevisionJournal>(),
    transactions: new Map([[f.transaction.recordDigest, f.transaction]]),
    evidence: new Map<string, EvidenceNode>(),
    patch: null as TaskStrategyPatchRecord | null,
    binding: null as TaskStrategyPatchCurrentBinding | null,
    finalize: false,
    redRuns: 0,
  };
  const trace: Event[] = [];
  let frame = 0;
  let ticks = 0;
  let repositoryOwned = false;
  let sessionOwned = false;
  let before: ((event: Event, index: number) => void) | undefined;
  let after: ((event: Event, index: number) => void) | undefined;
  let inspectionTransform = (inspection: SessionInspection, _count: number) =>
    inspection;
  let inspections = 0;
  let gateResult: ReturnType<
    ImplementationReconciliationGate<SessionInspection>
  > = null;
  let prepared: PreparedTaskStrategyRed = {
    transactionInput: successorInput,
    evidenceNode: successorInput.red.evidenceNode,
  };
  const environments: NodeJS.ProcessEnv[] = [
    { FRAME: 'first' },
    { FRAME: 'second' },
  ];
  let envCount = 0;
  function event<T>(
    name: string,
    args: unknown[],
    body: () => T,
    observedFrame?: number,
  ): T {
    const entry = {
      name,
      args,
      ...(observedFrame === undefined ? {} : { frame: observedFrame }),
    };
    const index = trace.push(entry) - 1;
    before?.(entry, index);
    const result = body();
    after?.(entry, index);
    return result;
  }
  const assertOwned = () =>
    event('assertOwned', [], () => {
      assert.ok(repositoryOwned && sessionOwned);
    });
  const gate: ImplementationReconciliationGate<SessionInspection> = (
    inspection,
  ) => event('gate', [inspection], () => gateResult);
  const operations: TaskStrategyRedRevisionOperations = {
    session: {
      loadActive: (cwd, id) =>
        event('loadActive', [cwd, id], () => ({
          git: f.inspection.git,
          config: f.inspection.contract.config,
          runtime: layout,
          session: state.session,
        })),
      inspect: (cwd, id) =>
        event('inspect', [cwd, id], () =>
          inspectionTransform(
            { ...f.inspection, session: state.session },
            ++inspections,
          ),
        ),
    },
    locks: {
      repository: (runtime, operation) =>
        event('repository.enter', [runtime], () => {
          assert.equal(runtime, layout);
          assert.equal(repositoryOwned, false);
          repositoryOwned = true;
          try {
            return operation(assertOwned);
          } finally {
            repositoryOwned = false;
            trace.push({ name: 'repository.release', args: [] });
          }
        }),
      session: (runtime, id, operation) =>
        event('session.enter', [runtime, id], () => {
          assert.equal(runtime, layout);
          assert.ok(repositoryOwned);
          sessionOwned = true;
          try {
            return operation();
          } finally {
            sessionOwned = false;
            trace.push({ name: 'session.release', args: [] });
          }
        }),
    },
    observeJournal: (cwd) =>
      event('observe', [cwd], () => {
        const n = ++frame;
        const call = <T>(name: string, args: unknown[], body: () => T) =>
          event(name, args, body, n);
        const journal: TaskStrategyRedRevisionJournalOperations = {
          revision: {
            read: (id, revisionId) =>
              call(
                'revision.read',
                [id, revisionId],
                () => state.journals.get(revisionId) ?? null,
              ),
            readActive: (id) =>
              call('revision.active', [id], () => {
                const active = [...state.requests.entries()].filter(
                  ([key]) => state.journals.get(key)?.phase !== 'completed',
                );
                assert.ok(active.length <= 1);
                const entry = active[0];
                return entry
                  ? {
                      request: entry[1],
                      journal: state.journals.get(entry[0]) ?? null,
                    }
                  : null;
              }),
            persistRequest: (value) =>
              call('request.persist', [value], () => {
                const snap = requestSnapshot(value);
                const current = state.requests.get(snap.revisionId);
                if (current)
                  assert.equal(canonicalJson(current), canonicalJson(value));
                state.requests.set(snap.revisionId, value);
                return snap;
              }),
            create: (input) =>
              call('journal.create', [input], () => {
                assert.equal(input.phase, 'prepared');
                assert.equal(
                  hash(state.requests.get(input.revisionId)),
                  input.requestDigest,
                );
                const j = buildRevisionJournal(input, null);
                state.journals.set(j.revisionId, j);
                return j;
              }),
            update: (input) =>
              call('journal.' + input.next.phase, [input], () => {
                const current = state.journals.get(input.revisionId)!;
                assert.ok(current);
                if (sameJournalState(current, input.next)) return current;
                assert.equal(
                  current.journalDigest,
                  input.expectedJournalDigest,
                );
                assertNextJournalState(current, input.next);
                const next = buildRevisionJournal(
                  input.next,
                  current.journalDigest,
                );
                state.journals.set(input.revisionId, next);
                return next;
              }),
          },
          transaction: {
            readTransaction: (id) =>
              call('transaction.current', [id], () => state.transaction),
            readByDigest: (id, d) =>
              call(
                'transaction.digest',
                [id, d],
                () => state.transactions.get(d) ?? null,
              ),
            persist: (value) =>
              call('transaction.persist', [value], () => {
                const tx = parseTaskStrategyTransaction(value);
                const existing = state.transactions.get(tx.recordDigest);
                if (existing)
                  assert.equal(canonicalJson(existing), canonicalJson(tx));
                state.transactions.set(tx.recordDigest, tx);
                return tx;
              }),
          },
          currentRef: {
            read: (id) => call('ref.read', [id], () => state.ref),
            compareAndSwap: (input) =>
              call('ref.' + input.next.state, [input], () => {
                const next = parseTaskStrategyCurrentRef(input.next);
                const target = state.transactions.get(
                  next.transactionDigest ?? next.predecessorTransactionDigest!,
                );
                assert.ok(target);
                assert.equal(
                  target.taskContractDigest,
                  next.taskContractDigest,
                );
                if (
                  next.state === 'red-sealed' &&
                  next.predecessorTransactionDigest
                )
                  assert.ok(
                    isSameReviewedTaskStrategyLineage(
                      target,
                      state.transactions.get(
                        next.predecessorTransactionDigest,
                      ) ?? null,
                    ),
                  );
                if (state.ref?.refDigest === next.refDigest) return state.ref;
                assert.equal(
                  state.ref?.refDigest ?? null,
                  input.expectedRefDigest,
                );
                state.ref = next;
                state.transaction =
                  next.state === 'red-authoring' ? null : target;
                return next;
              }),
          },
          patch: {
            readCurrentBinding: (...args) =>
              call('patch.binding', args, () => state.binding),
            readRecord: (...args) =>
              call('patch.record', args, () => state.patch),
          },
          evidence: {
            write: (node) =>
              call('evidence.write', [node], () => {
                state.evidence.set(node.nodeId, node);
              }),
          },
          session: {
            read: (id) => call('session.read', [id], () => state.session),
            write: (id, next) =>
              call('session.write', [id, next], () => {
                state.session = next;
              }),
          },
          hasFinalizeTransaction: (id) =>
            call('finalize', [id], () => state.finalize),
        };
        return journal;
      }),
    pinCheckRunner: (...args) =>
      event('pin', args, () => ({
        runner: 'node',
        executable: 'node',
        args: [],
        digest: digest('runner'),
      })),
    restoreImplementationToRed: (...args) =>
      event('restore', args, () => {
        assert.equal(args[3], assertOwned);
        assert.ok(repositoryOwned && sessionOwned);
        return state.patch;
      }),
    prepareSuccessor: (...args) =>
      event('prepare', args, () => {
        state.redRuns++;
        return prepared;
      }),
    environment: () =>
      event(
        'environment',
        [],
        () => environments[envCount++ % environments.length]!,
      ),
    clock: {
      now: () =>
        event('clock', [], () => new Date(Date.parse(NOW) + 1000 * ++ticks)),
    },
  };
  const create = (override: TaskStrategyRedRevisionOperations = operations) =>
    createTaskStrategyRedRevisionService(override, gate);
  const begin = () => create().beginTaskStrategyRedRevision(ROOT, request);
  const continueRevision = (environment: NodeJS.ProcessEnv = {}) =>
    create().continueTaskStrategyRedRevision(
      ROOT,
      request.sessionId,
      environment,
    );
  return {
    f,
    state,
    trace,
    request,
    initialRef,
    operations,
    create,
    begin,
    continueRevision,
    assertOwned,
    layout,
    environments,
    get journal() {
      return state.journals.get(requestSnapshot(request).revisionId)!;
    },
    get prepared() {
      return prepared;
    },
    set prepared(value: PreparedTaskStrategyRed) {
      prepared = value;
    },
    set before(value: typeof before) {
      before = value;
    },
    set after(value: typeof after) {
      after = value;
    },
    set inspect(value: typeof inspectionTransform) {
      inspectionTransform = value;
    },
    set gateResult(value: typeof gateResult) {
      gateResult = value;
    },
    clear() {
      trace.length = 0;
    },
  };
}
function names(m: ReturnType<typeof memory>) {
  return m.trace.map((e) => e.name);
}
function journalTimes(m: ReturnType<typeof memory>) {
  return m.trace
    .filter((event) => event.name.startsWith('journal.'))
    .map((event) => {
      const input = event.args[0] as
        | TaskStrategyRedRevisionJournalState
        | { next: TaskStrategyRedRevisionJournalState };
      const state = 'next' in input ? input.next : input;
      return [event.name, state.createdAt, state.updatedAt];
    });
}
function crash(
  m: ReturnType<typeof memory>,
  name: string,
  run: () => unknown,
  after = true,
) {
  const fault = (e: Event) => {
    if (e.name === name) throw sentinel;
  };
  if (after) m.after = fault;
  else m.before = fault;
  assert.throws(run, (e) => e === sentinel);
  m.before = undefined;
  m.after = undefined;
}
function reach(phase: TaskStrategyRedRevisionJournal['phase']) {
  const m = memory();
  if (phase === 'prepared') crash(m, 'journal.create', m.begin);
  else if (
    [
      'implementation-restored',
      'current-authoring',
      'session-evidence-cleared',
    ].includes(phase)
  )
    crash(m, 'journal.' + phase, m.begin);
  else {
    m.begin();
    crash(m, 'journal.' + phase, m.continueRevision);
  }
  m.clear();
  return m;
}

// D01-D04, D13, D17: the actual state machine, not a substituted use case.
test('RED factory is lazy, isolated, locks in order and opens through exact durable steps', () => {
  const m = memory();
  const other = memory();
  m.create();
  other.create();
  assert.equal(m.trace.length, 0);
  assert.equal(other.trace.length, 0);
  const result = m.begin();
  assert.equal(result.phase, 'session-evidence-cleared');
  assert.equal(result.transaction, null);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(names(m), [
    'loadActive',
    'repository.enter',
    'session.enter',
    'assertOwned',
    'observe',
    'revision.read',
    'revision.active',
    'ref.read',
    'transaction.current',
    'inspect',
    'pin',
    'observe',
    'finalize',
    'patch.binding',
    'clock',
    'request.persist',
    'journal.create',
    'transaction.digest',
    'inspect',
    'pin',
    'observe',
    'finalize',
    'ref.read',
    'restore',
    'clock',
    'journal.implementation-restored',
    'ref.red-authoring',
    'clock',
    'journal.current-authoring',
    'session.read',
    'session.write',
    'session.read',
    'clock',
    'journal.session-evidence-cleared',
    'session.release',
    'repository.release',
  ]);
  const j = m.journal;
  const createdAt = '2026-09-23T01:00:01.000Z';
  assert.deepEqual(journalTimes(m), [
    ['journal.create', createdAt, '2026-09-23T01:00:01.000Z'],
    ['journal.implementation-restored', createdAt, '2026-09-23T01:00:02.000Z'],
    ['journal.current-authoring', createdAt, '2026-09-23T01:00:03.000Z'],
    ['journal.session-evidence-cleared', createdAt, '2026-09-23T01:00:04.000Z'],
  ]);
  assert.equal(j.createdAt, createdAt);
  assert.equal(j.updatedAt, '2026-09-23T01:00:04.000Z');
  assert.equal(j.authoringRef.updatedAt, createdAt);
  assert.equal(j.request, m.request);
  assert.notEqual(j.sessionTransition.before, m.f.session);
  assert.notEqual(j.sessionTransition.before.isolation, m.f.session.isolation);
  assert.equal(m.f.session.latestCheckReportId, 'check-before');
  assert.equal(m.state.session.latestCheckReportId, undefined);
  assert.equal(m.state.ref, j.authoringRef);
  assert.equal(m.state.transaction, null);
  assert.deepEqual(
    m.trace.filter((e) => e.name === 'finalize').map((e) => e.frame),
    [2, 3],
  );
  assert.ok(
    m.trace
      .filter((e) => e.frame !== undefined && !['finalize'].includes(e.name))
      .every((e) => e.frame === 1),
  );
  for (const e of m.trace.filter((e) => e.name === 'pin'))
    assert.equal(e.args[2], m.f.inspection.contract.checks.checks.unit);
  assert.equal(other.trace.length, 0);
  assert.equal(other.state.journals.size, 0);
});

test('RED continuation pins canonical successor before evidence transaction and current-ref publication', () => {
  const m = memory();
  m.begin();
  m.clear();
  const env = { AGENT: 'codex' };
  const result = m.continueRevision(env)!;
  assert.deepEqual(names(m), [
    'loadActive',
    'repository.enter',
    'session.enter',
    'assertOwned',
    'observe',
    'revision.active',
    'request.persist',
    'transaction.digest',
    'inspect',
    'pin',
    'observe',
    'finalize',
    'ref.read',
    'prepare',
    'assertOwned',
    'clock',
    'journal.reseal-prepared',
    'evidence.write',
    'transaction.persist',
    'clock',
    'journal.successor-persisted',
    'ref.red-sealed',
    'clock',
    'journal.current-sealed',
    'clock',
    'journal.completed',
    'assertOwned',
    'session.release',
    'repository.release',
  ]);
  const createdAt = '2026-09-23T01:00:01.000Z';
  assert.deepEqual(journalTimes(m), [
    ['journal.reseal-prepared', createdAt, '2026-09-23T01:00:05.000Z'],
    ['journal.successor-persisted', createdAt, '2026-09-23T01:00:06.000Z'],
    ['journal.current-sealed', createdAt, '2026-09-23T01:00:07.000Z'],
    ['journal.completed', createdAt, '2026-09-23T01:00:08.000Z'],
  ]);
  assert.equal(m.journal.createdAt, createdAt);
  assert.equal(m.journal.updatedAt, '2026-09-23T01:00:08.000Z');
  assert.equal(result.phase, 'completed');
  assert.ok(Object.isFrozen(result));
  assert.equal(result.transaction, m.journal.successorTransaction);
  assert.equal(
    m.state.transaction?.recordDigest,
    result.transaction?.recordDigest,
  );
  assert.equal(
    m.state.transactions.get(m.f.transaction.recordDigest),
    m.f.transaction,
  );
  const opts = m.trace.find((e) => e.name === 'prepare')!.args[2] as {
    author: unknown;
    environment: unknown;
  };
  assert.equal(opts.author, m.journal.binding.author);
  assert.equal(opts.environment, env);
  assert.deepEqual(m.trace.find((event) => event.name === 'prepare')!.args, [
    ROOT,
    m.request.sessionId,
    {
      author: m.journal.binding.author,
      predecessorCandidateTree: m.f.transaction.red.candidateTree,
      environment: env,
    },
  ]);
  assert.equal(
    m.trace.find((e) => e.name === 'evidence.write')!.args[0],
    m.journal.successorTransaction!.red.evidenceNode,
  );
  assert.equal(
    m.journal.successorRef!.updatedAt,
    m.prepared.transactionInput.createdAt,
  );
  assert.equal(m.state.redRuns, 1);
});

test('RED environment default is observed per call before loadActive; explicit references bypass it', () => {
  const m = memory();
  const svc = m.create();
  assert.equal(m.trace.length, 0);
  svc.continueTaskStrategyRedRevision(ROOT, m.request.sessionId);
  assert.deepEqual(names(m).slice(0, 2), ['environment', 'loadActive']);
  m.clear();
  svc.continueTaskStrategyRedRevision(ROOT, m.request.sessionId, undefined);
  assert.deepEqual(names(m).slice(0, 2), ['environment', 'loadActive']);
  m.clear();
  svc.continueTaskStrategyRedRevision(ROOT, m.request.sessionId, {});
  assert.ok(!names(m).includes('environment'));
  for (const explicit of [false, true]) {
    const x = memory();
    x.begin();
    x.clear();
    const env = {};
    x.create().continueTaskStrategyRedRevision(
      ROOT,
      x.request.sessionId,
      ...((explicit ? [env] : []) as [] | [NodeJS.ProcessEnv]),
    );
    const received = (
      x.trace.find((e) => e.name === 'prepare')!.args[2] as {
        environment: unknown;
      }
    ).environment;
    assert.equal(received, explicit ? env : x.environments[0]);
  }
  const x = memory();
  x.before = (e) => {
    if (e.name === 'environment') throw sentinel;
  };
  assert.throws(
    () => x.create().continueTaskStrategyRedRevision(ROOT, x.request.sessionId),
    (e) => e === sentinel,
  );
  assert.deepEqual(names(x), ['environment']);
});

test('RED exact completed replay bypasses inventory and opening while absent continue stays read-only', () => {
  const m = reach('completed');
  const j = m.journal;
  const result = m.begin();
  assert.equal(result.transaction, j.successorTransaction);
  assert.deepEqual(names(m), [
    'loadActive',
    'repository.enter',
    'session.enter',
    'assertOwned',
    'observe',
    'revision.read',
    'session.release',
    'repository.release',
  ]);
  m.clear();
  assert.equal(m.continueRevision(), null);
  assert.deepEqual(names(m), [
    'loadActive',
    'repository.enter',
    'session.enter',
    'assertOwned',
    'observe',
    'revision.active',
    'session.release',
    'repository.release',
  ]);
});

test('RED incomplete exact begin reconciles each phase without preparing or re-persisting request', () => {
  for (const phase of TASK_STRATEGY_RED_REVISION_PHASES.filter(
    (p) => p !== 'completed',
  )) {
    const m = reach(phase);
    const out = m.begin();
    assert.equal(
      out.phase,
      TASK_STRATEGY_RED_REVISION_PHASES.indexOf(phase) < 3
        ? 'session-evidence-cleared'
        : phase,
    );
    assert.ok(!names(m).includes('request.persist'));
    assert.ok(!names(m).includes('prepare'));
    assert.equal(names(m).includes('restore'), phase === 'prepared');
  }
});

test('RED distinct active request conflicts; same request-only resume builds a journal lazily', () => {
  const m = memory();
  crash(m, 'request.persist', m.begin);
  assert.equal(m.state.journals.size, 0);
  m.clear();
  assert.throws(
    () =>
      m.create().beginTaskStrategyRedRevision(ROOT, {
        ...m.request,
        reason: 'another',
      }),
    code('ACTIVE'),
  );
  assert.ok(!names(m).includes('transaction.current'));
  m.clear();
  const result = m.continueRevision()!;
  assert.equal(result.phase, 'completed');
  assert.ok(
    names(m).indexOf('request.persist') <
      names(m).indexOf('transaction.current'),
  );
  assert.equal(m.state.redRuns, 1);
  const x = memory();
  crash(x, 'request.persist', x.begin);
  x.clear();
  assert.equal(x.begin().phase, 'session-evidence-cleared');
});

// Malformed returned records below are consumer-boundary faults, not claimed
// admissible durable bytes. Normal memory transitions use canonical codecs.
test('RED preflight independently rejects each stale current observation before inspection or publication', () => {
  const mutations: Array<(m: ReturnType<typeof memory>) => void> = [
    (m) => {
      m.state.transaction = null;
    },
    (m) => {
      m.state.transaction = {
        ...m.f.transaction,
        recordDigest: digest('wrong'),
      };
    },
    (m) => {
      m.state.ref = null;
    },
    (m) => {
      m.state.ref = createTaskStrategyCurrentRef({
        ...m.initialRef,
        state: 'red-authoring',
        transactionDigest: null,
        predecessorTransactionDigest: m.f.transaction.recordDigest,
        revisionId: requestSnapshot(m.request).revisionId,
      });
    },
    (m) => {
      m.state.ref = { ...m.initialRef, transactionDigest: digest('wrong') };
    },
  ];
  for (const mutate of mutations) {
    const m = memory();
    mutate(m);
    assert.throws(m.begin, code('STALE'));
    assert.ok(names(m).includes('transaction.current'));
    assert.ok(!names(m).includes('inspect'));
    assert.equal(m.state.requests.size, 0);
  }
});

test('RED reviewed contract and pinned runner guards preserve field order and original definition', () => {
  const faults: Array<(i: SessionInspection) => SessionInspection> = [
    (i) => ({ ...i, contract: { ...i.contract, execution: undefined } }),
    ...['sessionId', 'changeId', 'taskId'].map(
      (field) => (i: SessionInspection) => ({
        ...i,
        session: { ...i.session, [field]: 'different' },
      }),
    ),
    (i) => ({
      ...i,
      session: {
        ...i.session,
        baseline: { ...i.session.baseline, head: '8'.repeat(40) },
      },
    }),
    (i) => ({
      ...i,
      session: {
        ...i.session,
        baseline: { ...i.session.baseline, tree: '8'.repeat(40) },
      },
    }),
    (i) => ({
      ...i,
      contract: {
        ...i.contract,
        execution: {
          ...i.contract.execution!,
          tasks: {
            '1.1': {
              ...i.contract.execution!.tasks['1.1']!,
              requiredChecks: ['other'],
            },
          },
        },
      },
    }),
  ];
  for (const change of faults) {
    const m = memory();
    m.inspect = change;
    assert.throws(m.begin, code('PLAN_REQUIRED'));
    assert.ok(!names(m).includes('pin'));
    assert.equal(m.state.requests.size, 0);
  }
  for (const field of ['strategy', 'taskContractDigest'] as const) {
    const m = memory();
    m.state.transaction = {
      ...m.f.transaction,
      [field]: field === 'strategy' ? 'cross-agent-tdd' : digest('drift'),
    };
    assert.throws(m.begin, code('PLAN_REQUIRED'));
    assert.ok(!names(m).includes('pin'));
  }
  for (const kind of ['missing', 'destructive']) {
    const m = memory();
    m.inspect = (i) => ({
      ...i,
      contract: {
        ...i.contract,
        checks: {
          schemaVersion: 1,
          checks:
            kind === 'missing'
              ? ({} as SessionInspection['contract']['checks']['checks'])
              : { unit: { command: ['node'], destructiveDatabase: true } },
        },
      },
    });
    assert.throws(m.begin, code('PLAN_REQUIRED'));
    assert.ok(!names(m).includes('pin'));
  }
  for (const field of ['checkId', 'runner', 'runnerDigest'] as const) {
    const m = memory();
    m.state.transaction = {
      ...m.f.transaction,
      red: { ...m.f.transaction.red, [field]: 'changed' },
    };
    assert.throws(m.begin, code('PLAN_REQUIRED'));
    assert.equal(names(m).filter((n) => n === 'pin').length, 1);
    assert.equal(
      m.trace.find((e) => e.name === 'pin')!.args[2],
      m.f.inspection.contract.checks.checks.unit,
    );
    assert.equal(m.state.requests.size, 0);
  }
  const m = memory();
  m.state.transaction = {
    ...m.f.transaction,
    red: { ...m.f.transaction.red, checkId: 'wrong' },
  };
  m.before = (e) => {
    if (e.name === 'pin') throw sentinel;
  };
  assert.throws(m.begin, (e) => e === sentinel);
});

test('RED applicability observes fresh context before each restriction and checks strict finalize afterwards', () => {
  for (const field of [
    'state',
    'revisionLeaseId',
    'completionReportId',
    'finishReportId',
    'commitReportId',
  ]) {
    const m = memory();
    m.state.session = {
      ...m.state.session,
      [field]: field === 'state' ? 'committed' : 'held',
    };
    assert.throws(m.begin, code('NOT_APPLICABLE'));
    assert.equal(names(m).filter((n) => n === 'observe').length, 2);
    assert.ok(!names(m).includes('finalize'));
    assert.equal(m.state.requests.size, 0);
  }
  const m = memory();
  m.state.finalize = true;
  assert.throws(m.begin, (e: unknown) => {
    const x = e as { code: string; recovery: string };
    assert.equal(x.code, code('FINALIZE_RECOVERY_REQUIRED').code);
    assert.equal(
      x.recovery,
      `pnpm workflow finalize-recover ${m.request.sessionId} --json`,
    );
    return true;
  });
  assert.equal(m.state.requests.size, 0);
  const x = memory();
  x.before = (e) => {
    if (e.name === 'finalize') throw sentinel;
  };
  assert.throws(x.begin, (e) => e === sentinel);
  const y = memory();
  let n = 0;
  y.after = (e) => {
    if (e.name === 'finalize' && ++n === 1) y.state.finalize = true;
  };
  assert.throws(y.begin, code('FINALIZE_RECOVERY_REQUIRED'));
  assert.equal(y.journal.phase, 'prepared');
  assert.ok(!names(y).includes('restore'));
});

function patchFacts(m: ReturnType<typeof memory>) {
  const record: TaskStrategyPatchRecord = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-record.v1',
    recordDigest: digest('patch-record'),
    sessionId: m.request.sessionId,
    changeId: m.f.session.changeId,
    taskId: m.f.session.taskId,
    strategy: m.f.transaction.strategy,
    sourceTree: m.f.transaction.red.candidateTree,
    candidateTree: '6'.repeat(40),
    taskContractDigest: m.f.transaction.taskContractDigest,
    patchDigest: digest('patch'),
    patchBase64: Buffer.from('patch').toString('base64'),
    changedPaths: ['src/feature.ts'],
    changes: [],
    implementer: m.f.transaction.author,
    createdAt: NOW,
  };
  const binding: TaskStrategyPatchCurrentBinding = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-current.v1',
    bindingDigest: digest('binding'),
    sessionId: m.request.sessionId,
    patchDigest: record.patchDigest,
    recordDigest: record.recordDigest,
    receiptDigest: digest('receipt'),
    candidateTree: record.candidateTree,
    createdAt: NOW,
  };
  return { record, binding };
}
test('RED patch observations and restore return independently bind the exact restoration triple', () => {
  const m = memory();
  const { record, binding } = patchFacts(m);
  m.state.binding = binding;
  assert.throws(m.begin, code('STATE_CORRUPT'));
  assert.deepEqual(m.trace.find((e) => e.name === 'patch.record')!.args, [
    m.request.sessionId,
    binding.patchDigest,
    m.f.transaction.red.candidateTree,
  ]);
  for (const field of [
    'recordDigest',
    'patchDigest',
    'candidateTree',
    'null',
  ] as const) {
    const x = memory();
    const p = patchFacts(x);
    x.state.binding = p.binding;
    x.state.patch = p.record;
    x.before = (e) => {
      if (e.name === 'restore')
        x.state.patch =
          field === 'null'
            ? null
            : {
                ...p.record,
                [field]: 'f'.repeat(field === 'candidateTree' ? 40 : 64),
              };
    };
    assert.throws(x.begin, code('STATE_CORRUPT'));
    assert.ok(!names(x).includes('journal.implementation-restored'));
  }
  const x = memory();
  const p = patchFacts(x);
  x.state.binding = p.binding;
  x.state.patch = p.record;
  x.begin();
  assert.deepEqual(x.journal.restoration, {
    sourceTree: x.f.transaction.red.candidateTree,
    implementationCandidateTree: p.record.candidateTree,
    patchRecordDigest: p.record.recordDigest,
    patchDigest: p.record.patchDigest,
  });
  assert.equal(
    x.trace.find((e) => e.name === 'restore')!.args[3],
    x.assertOwned,
  );
});

test('RED journal predecessor binding independently rejects every returned lineage mismatch', () => {
  const mutate: Array<(t: TaskStrategyTransaction) => TaskStrategyTransaction> =
    [
      (t) => ({ ...t, recordDigest: digest('other') }),
      (t) => ({ ...t, red: { ...t.red, candidateTree: '9'.repeat(40) } }),
      ...['changeId', 'taskId', 'strategy', 'taskContractDigest'].map(
        (field) => (t: TaskStrategyTransaction) =>
          ({ ...t, [field]: 'other' }) as TaskStrategyTransaction,
      ),
      (t) => ({ ...t, baseline: { ...t.baseline, head: '9'.repeat(40) } }),
      (t) => ({ ...t, baseline: { ...t.baseline, tree: '9'.repeat(40) } }),
      ...['checkId', 'runner', 'runnerDigest'].map(
        (field) => (t: TaskStrategyTransaction) => ({
          ...t,
          red: { ...t.red, [field]: 'other' },
        }),
      ),
      (t) => ({ ...t, author: { ...t.author, providerId: 'claude' } }),
      (t) => ({ ...t, author: { ...t.author, assurance: 'self-declared' } }),
    ];
  for (const change of mutate) {
    const m = reach('prepared');
    m.state.transactions.set(
      m.f.transaction.recordDigest,
      change(m.f.transaction),
    );
    assert.throws(m.begin, code('STATE_CORRUPT'));
    assert.ok(!names(m).includes('inspect'));
  }
  const m = reach('prepared');
  m.state.transactions.clear();
  assert.throws(m.begin, code('STATE_CORRUPT'));
  assert.ok(!names(m).includes('inspect'));
});

test('RED full phase by distinct session snapshot by current-ref relation matrix', () => {
  let combinations = 0;
  for (const phase of TASK_STRATEGY_RED_REVISION_PHASES)
    for (const snapshot of ['before', 'after', 'foreign'])
      for (const ref of [
        'predecessor',
        'authoring',
        'successor',
        'null',
        'foreign',
      ]) {
        const m = reach(phase);
        const j = m.journal;
        m.state.session = structuredClone(
          (snapshot === 'before'
            ? j.sessionTransition.before
            : j.sessionTransition.after) as WorkflowSession,
        );
        if (snapshot === 'foreign')
          m.state.session.artifacts = { unrelated: 'changed' };
        const successor =
          j.successorRef ??
          createTaskStrategyCurrentRef({
            ...m.initialRef,
            transactionDigest: digest('future'),
            predecessorTransactionDigest: m.f.transaction.recordDigest,
            revisionId: j.revisionId,
          });
        m.state.ref =
          ref === 'predecessor'
            ? m.initialRef
            : ref === 'authoring'
              ? j.authoringRef
              : ref === 'successor'
                ? successor
                : ref === 'null'
                  ? null
                  : { ...m.initialRef, refDigest: digest('foreign') };
        const sessionValid =
          phase === 'completed' ||
          (['prepared', 'implementation-restored'].includes(phase)
            ? snapshot === 'before'
            : phase === 'current-authoring'
              ? snapshot !== 'foreign'
              : snapshot === 'after');
        const refValid =
          phase === 'completed' ||
          (phase === 'prepared'
            ? ref === 'predecessor'
            : phase === 'implementation-restored'
              ? ['predecessor', 'authoring'].includes(ref)
              : phase === 'successor-persisted'
                ? ['authoring', 'successor'].includes(ref)
                : phase === 'current-sealed'
                  ? ref === 'successor'
                  : ref === 'authoring');
        if (!sessionValid) {
          assert.throws(
            m.begin,
            { code: 'SESSION_CHANGED_DURING_TRANSITION' },
            `${phase}/${snapshot}/${ref}`,
          );
          assert.ok(!names(m).includes('ref.read'));
        } else if (!refValid)
          assert.throws(
            m.begin,
            code('STATE_CORRUPT'),
            `${phase}/${snapshot}/${ref}`,
          );
        else assert.ok(m.begin());
        combinations++;
      }
  assert.equal(combinations, 120);
});

test('RED clearing compares exact before/after, skips replay writes and rejects corrupt readback', () => {
  const m = reach('current-authoring');
  m.state.session = m.journal.sessionTransition.after as WorkflowSession;
  assert.ok(m.begin());
  assert.equal(names(m).filter((n) => n === 'session.read').length, 1);
  assert.ok(!names(m).includes('session.write'));
  for (const stage of ['before-read', 'after-write']) {
    const x = reach('current-authoring');
    x.before = (e) => {
      if (e.name === 'session.read' && stage === 'before-read')
        x.state.session = { ...x.state.session, artifacts: { changed: 'yes' } };
    };
    x.after = (e) => {
      if (e.name === 'session.write' && stage === 'after-write')
        x.state.session = { ...x.state.session, artifacts: { changed: 'yes' } };
    };
    assert.throws(
      x.begin,
      stage === 'before-read'
        ? { code: 'SESSION_CHANGED_DURING_TRANSITION' }
        : code('STATE_CORRUPT'),
    );
    assert.equal(x.journal.phase, 'current-authoring');
    assert.equal(names(x).includes('session.write'), stage === 'after-write');
  }
});

test('RED persisted snapshot mismatches reject before journal creation', () => {
  for (const field of ['revisionId', 'requestDigest']) {
    const m = memory();
    const ops = {
      ...m.operations,
      observeJournal: (cwd: string) => {
        const j = m.operations.observeJournal(cwd);
        return {
          ...j,
          revision: {
            ...j.revision,
            persistRequest: (r: TaskStrategyRedRevisionRequest) => ({
              ...j.revision.persistRequest(r),
              [field]: 'wrong',
            }),
          },
        };
      },
    };
    assert.throws(
      () => m.create(ops).beginTaskStrategyRedRevision(ROOT, m.request),
      code('STATE_CORRUPT'),
    );
    assert.equal(m.state.journals.size, 0);
  }
});

test('RED original hooks occur only after their exact durable effect and preserve thrown identity', () => {
  const hooks = [
    'testAfterJournalPersist',
    'testAfterWorktreeRestore',
    'testAfterRestorationRecorded',
  ] as const;
  for (const [index, hook] of hooks.entries()) {
    const m = memory();
    assert.throws(
      () =>
        m.create().beginTaskStrategyRedRevision(ROOT, m.request, {
          [hook]: () => {
            m.trace.push({ name: hook, args: [] });
            throw sentinel;
          },
        }),
      (e) => e === sentinel,
    );
    assert.equal(
      m.journal.phase,
      index === 2 ? 'implementation-restored' : 'prepared',
    );
    const n = names(m);
    assert.equal(n.at(-3), hook);
    assert.equal(
      n.at(-4),
      index === 0
        ? 'journal.create'
        : index === 1
          ? 'restore'
          : 'journal.implementation-restored',
    );
    m.clear();
    assert.ok(m.begin());
    assert.ok(
      !names(m).some((n) => hooks.includes(n as (typeof hooks)[number])),
    );
  }
});

function reconciliation(
  m: ReturnType<typeof memory>,
): NonNullable<
  ReturnType<ImplementationReconciliationGate<SessionInspection>>
> {
  return {
    reportId: 'reconciliation-before',
    request: {
      schemaVersion: 2,
      kind: 'implementation-reconciliation',
      changeId: m.f.session.changeId,
      sessionId: m.request.sessionId,
      baseline: m.f.session.baseline,
      requirementId: 'implementation-reconciliation',
      requirementDigest: digest('requirement'),
      investigationManifestDigest: digest('manifest'),
      implementationTargetDigest: digest('target'),
      plannedMutations: [],
      changedRanges: [],
      termDelta: {
        schemaVersion: 1,
        kind: 'implementation-term-delta',
        baselineCommit: m.f.session.baseline.head,
        implementationTree: m.f.transaction.red.candidateTree,
        knownTermIds: [],
        newTerms: [],
        scanEvidenceDigest: digest('scan'),
        affectedGroups: [],
      },
      termDispositions: [],
      actualMutations: [],
    },
    verdict: {
      reconciled: true,
      unaccountedRanges: [],
      unplannedSubjects: [],
      abandonedIntents: [],
      brokenInvariants: [],
    },
    ledgerProjection: null,
  };
}
test('RED reconciliation gate is mandatory only for a recorded report and clears exactly three fields', () => {
  for (const mode of [
    'valid',
    'null',
    'projection',
    'error',
    'absent',
    'paths-only',
  ]) {
    const m = memory();
    const record = reconciliation(m);
    if (mode !== 'absent') {
      m.state.session.implementationReconciliationPaths = ['src/semantic.ts'];
      if (mode !== 'paths-only')
        m.state.session.implementationReconciliationReportId = record.reportId;
    }
    m.gateResult =
      mode === 'null'
        ? null
        : mode === 'projection'
          ? {
              ...record,
              ledgerProjection: {
                schemaVersion: 1,
                kind: 'reconciled-semantic-ledger-projection',
                entryIds: [],
                paths: [],
                indexDigest: digest('index'),
              },
            }
          : record;
    let observed: SessionInspection | undefined;
    m.inspect = (i) => {
      observed = i;
      return i;
    };
    if (mode === 'error')
      m.before = (e) => {
        if (e.name === 'gate') {
          assert.equal(e.args[0], observed);
          throw sentinel;
        }
      };
    if (['null', 'projection'].includes(mode)) {
      assert.throws(m.begin, code('PLAN_REQUIRED'));
      assert.equal(m.state.requests.size, 0);
    } else if (mode === 'error') {
      assert.throws(m.begin, (e) => e === sentinel);
      assert.equal(m.state.requests.size, 0);
    } else if (mode === 'paths-only') {
      assert.throws(m.begin, code('STATE_CORRUPT'));
      assert.ok(!names(m).includes('gate'));
    } else {
      m.begin();
      assert.equal(
        names(m).filter((n) => n === 'gate').length,
        mode === 'valid' ? 1 : 0,
      );
      const expected = {
        ...structuredClone(m.journal.sessionTransition.before),
      };
      for (const key of [
        'latestCheckReportId',
        'implementationReconciliationReportId',
        'implementationReconciliationPaths',
      ])
        delete expected[key];
      assert.deepEqual(m.journal.sessionTransition.after, expected);
      assert.equal(m.f.session.latestCheckReportId, 'check-before');
    }
  }
});

test('RED successor uses real validation, enforces three runner bindings and rejects changed lineage in journal', () => {
  for (const field of [
    'checkId',
    'runner',
    'runnerDigest',
    'author',
    'changeId',
    'baseline',
    'invalid',
  ] as const) {
    const m = reach('session-evidence-cleared');
    const input = { ...structuredClone(m.prepared.transactionInput) };
    if (['checkId', 'runner', 'runnerDigest'].includes(field))
      input.red = {
        ...input.red,
        [field]: field === 'runnerDigest' ? digest('drift') : 'drift',
      };
    else if (field === 'author')
      input.author = { ...input.author, providerId: 'claude' };
    else if (field === 'changeId') input.changeId = 'other-change';
    else if (field === 'baseline')
      input.baseline = { ...input.baseline, head: '9'.repeat(40) };
    else input.red = { ...input.red, exitCode: 0 };
    m.prepared = { ...m.prepared, transactionInput: input };
    assert.throws(
      m.continueRevision,
      field === 'invalid'
        ? { code: 'TASK_STRATEGY_STATE_CORRUPT' }
        : ['author', 'changeId', 'baseline'].includes(field)
          ? code('STATE_CORRUPT')
          : code('PLAN_REQUIRED'),
    );
    assert.equal(m.journal.phase, 'session-evidence-cleared');
    assert.equal(m.state.evidence.size, 0);
    assert.ok(!names(m).includes('transaction.persist'));
  }
  const m = reach('session-evidence-cleared');
  const decoy = createEvidenceNode({
    ...m.prepared.evidenceNode,
    exactInputDigests: { decoy: digest('decoy') },
    output: { decoy: true },
  });
  m.prepared = { ...m.prepared, evidenceNode: decoy };
  m.continueRevision();
  assert.equal(m.state.evidence.has(decoy.nodeId), false);
  assert.ok(
    m.state.evidence.has(m.journal.successorTransaction!.red.evidenceNodeId),
  );
});

test('RED successor prepare and ownership failures stop before pinning any descendant', () => {
  const m = reach('session-evidence-cleared');
  crash(m, 'prepare', m.continueRevision, false);
  assert.ok(
    !names(m)
      .slice(names(m).indexOf('prepare') + 1)
      .includes('assertOwned'),
  );
  assert.equal(m.state.redRuns, 0);
  const x = reach('session-evidence-cleared');
  let checks = 0;
  x.before = (e) => {
    if (e.name === 'assertOwned' && ++checks === 2) throw sentinel;
  };
  assert.throws(x.continueRevision, (e) => e === sentinel);
  assert.equal(x.state.redRuns, 1);
  assert.equal(x.journal.phase, 'session-evidence-cleared');
  assert.equal(x.state.transactions.size, 1);
  x.before = undefined;
  x.continueRevision();
  assert.equal(x.state.redRuns, 2);
});

test('RED missing successor facts are consumer faults, and publication return values cannot replace pinned bytes', () => {
  for (const phase of ['reseal-prepared', 'successor-persisted'] as const) {
    const m = reach(phase);
    const broken = {
      ...m.journal,
      ...(phase === 'reseal-prepared'
        ? { successorTransaction: null }
        : { successorRef: null }),
    };
    m.state.journals.set(broken.revisionId, broken);
    assert.throws(m.continueRevision, code('STATE_CORRUPT'));
  }
  const m = reach('reseal-prepared');
  const pinned = m.journal.successorTransaction!;
  const ops = {
    ...m.operations,
    observeJournal: (cwd: string) => {
      const j = m.operations.observeJournal(cwd);
      return {
        ...j,
        transaction: {
          ...j.transaction,
          persist: (t: TaskStrategyTransaction) => {
            j.transaction.persist(t);
            return m.f.transaction;
          },
        },
      };
    },
  };
  const result = m
    .create(ops)
    .continueTaskStrategyRedRevision(ROOT, m.request.sessionId, {});
  assert.equal(result!.transaction!.recordDigest, pinned.recordDigest);
});

test('RED every reachable event has an explicit before-fault stop prefix and propagates original sentinel', () => {
  const setups = [
    () => memory(),
    () => reach('session-evidence-cleared'),
    () => {
      const m = memory();
      const p = patchFacts(m);
      m.state.binding = p.binding;
      m.state.patch = p.record;
      m.state.session.implementationReconciliationReportId =
        'reconciliation-before';
      m.gateResult = reconciliation(m);
      return m;
    },
  ];
  const visited = new Set<string>();
  let checks = 0;
  for (const [index, setup] of setups.entries()) {
    const baseline = setup();
    const run = (m: ReturnType<typeof memory>) =>
      index === 1
        ? m.create().continueTaskStrategyRedRevision(ROOT, m.request.sessionId)
        : m.begin();
    run(baseline);
    const events = baseline.trace.filter((e) => !e.name.endsWith('.release'));
    for (let cut = 0; cut < events.length; cut++) {
      const m = setup();
      let count = 0;
      m.before = () => {
        if (count++ === cut) throw sentinel;
      };
      assert.throws(
        () => run(m),
        (e) => e === sentinel,
      );
      assert.deepEqual(
        m.trace.filter((e) => !e.name.endsWith('.release')).map((e) => e.name),
        events.slice(0, cut + 1).map((e) => e.name),
      );
      visited.add(events[cut]!.name);
      checks++;
    }
  }
  for (const name of [
    'loadActive',
    'repository.enter',
    'session.enter',
    'assertOwned',
    'observe',
    'pin',
    'finalize',
    'patch.record',
    'gate',
    'clock',
    'request.persist',
    'journal.create',
    'restore',
    'ref.red-authoring',
    'session.read',
    'session.write',
    'prepare',
    'evidence.write',
    'transaction.persist',
    'ref.red-sealed',
    'journal.completed',
    'environment',
  ])
    assert.ok(visited.has(name), name);
  assert.ok(checks > 90);
});

const memoryCuts = [
  ['C01', 'request.persist', 'begin', 'prepared'],
  ['C02', 'journal.create', 'begin', 'prepared'],
  ['C03', 'restore', 'begin', 'prepared'],
  [
    'C04',
    'journal.implementation-restored',
    'begin',
    'implementation-restored',
  ],
  ['C05', 'ref.red-authoring', 'begin', 'implementation-restored'],
  ['C06', 'journal.current-authoring', 'begin', 'current-authoring'],
  ['C07', 'session.write', 'begin', 'current-authoring'],
  [
    'C08',
    'journal.session-evidence-cleared',
    'begin',
    'session-evidence-cleared',
  ],
  ['C09', 'prepare', 'continue', 'session-evidence-cleared'],
  ['C10', 'journal.reseal-prepared', 'continue', 'reseal-prepared'],
  ['C11', 'evidence.write', 'continue', 'reseal-prepared'],
  ['C12', 'transaction.persist', 'continue', 'reseal-prepared'],
  ['C13', 'journal.successor-persisted', 'continue', 'successor-persisted'],
  ['C14', 'ref.red-sealed', 'continue', 'successor-persisted'],
  ['C15', 'journal.current-sealed', 'continue', 'current-sealed'],
  ['C16', 'journal.completed', 'continue', 'completed'],
] as const;
const fromReseal = [
  'request.persist',
  'evidence.write',
  'transaction.persist',
  'journal.successor-persisted',
  'ref.red-sealed',
  'journal.current-sealed',
  'journal.completed',
];
const fromPersisted = [
  'request.persist',
  'ref.red-sealed',
  'journal.current-sealed',
  'journal.completed',
];
const remainingPublications: Partial<
  Record<(typeof memoryCuts)[number][0], readonly string[]>
> = {
  C10: fromReseal,
  C11: fromReseal,
  C12: fromReseal,
  C13: fromPersisted,
  C14: fromPersisted,
  C15: ['request.persist', 'journal.completed'],
  C16: [],
};
for (const [id, cut, operation, phase] of memoryCuts)
  test(`RED ${id} write then throw at ${cut} restarts the real factory over durable memory`, () => {
    const m = memory();
    if (operation === 'continue') m.begin();
    m.clear();
    crash(m, cut, operation === 'begin' ? m.begin : m.continueRevision);
    if (id === 'C01') assert.equal(m.state.journals.size, 0);
    else assert.equal(m.journal.phase, phase);
    const pinned = id >= 'C10' ? m.journal.successorTransaction : null;
    const beforeSession = m.state.session;
    const writes = m.trace.filter((e) => e.name === 'session.write').length;
    m.clear();
    const recovered = m
      .create()
      .continueTaskStrategyRedRevision(ROOT, m.request.sessionId, {});
    const expectedPublications = remainingPublications[id];
    if (expectedPublications !== undefined)
      assert.deepEqual(
        names(m).filter(
          (name) =>
            name.startsWith('journal.') ||
            [
              'prepare',
              'restore',
              'request.persist',
              'evidence.write',
              'transaction.persist',
              'session.write',
              'ref.red-authoring',
              'ref.red-sealed',
            ].includes(name),
        ),
        expectedPublications,
        `${id} resumes only the remaining durable publications`,
      );
    if (id === 'C16') {
      assert.equal(recovered, null);
      assert.equal(m.begin().phase, 'completed');
    } else assert.equal(recovered!.phase, 'completed');
    assert.equal(m.journal.phase, 'completed');
    assert.equal(
      m.state.ref!.transactionDigest,
      m.journal.successorTransaction!.recordDigest,
    );
    assert.ok(m.state.transactions.has(m.f.transaction.recordDigest));
    assert.equal(m.state.redRuns, id === 'C09' ? 2 : 1);
    if (pinned)
      assert.equal(
        m.journal.successorTransaction!.recordDigest,
        pinned.recordDigest,
      );
    if (writes === 1) {
      assert.equal(m.state.session, beforeSession);
      assert.ok(!names(m).includes('session.write'));
    }
  });

test('RED invalid request preserves earlier admission failures and C00 publishes nothing', () => {
  const m = memory();
  const invalid = { ...m.request, reason: '' };
  m.before = (e) => {
    if (e.name === 'loadActive') throw sentinel;
  };
  assert.throws(
    () => m.create().beginTaskStrategyRedRevision(ROOT, invalid),
    (e) => e === sentinel,
  );
  m.before = undefined;
  m.clear();
  assert.throws(() => m.create().beginTaskStrategyRedRevision(ROOT, invalid), {
    code: 'TASK_STRATEGY_RED_REVISION_REQUEST_INVALID',
  });
  assert.deepEqual(names(m), [
    'loadActive',
    'repository.enter',
    'session.enter',
    'assertOwned',
    'observe',
    'session.release',
    'repository.release',
  ]);
  assert.equal(m.state.requests.size, 0);
  assert.ok(m.begin());
});

test('RED opening re-inspects after preparation and preserves first observation writes', () => {
  const m = memory();
  const inspections: SessionInspection[] = [];
  m.inspect = (i, count) => {
    const current =
      count === 2
        ? {
            ...i,
            session: {
              ...i.session,
              artifacts: { changed: 'after preparation' },
            },
          }
        : i;
    inspections.push(current);
    return current;
  };
  assert.throws(m.begin, { code: 'SESSION_CHANGED_DURING_TRANSITION' });
  assert.equal(inspections.length, 2);
  assert.notEqual(inspections[0], inspections[1]);
  assert.deepEqual(m.journal.sessionTransition.before.artifacts, {});
  assert.equal(m.journal.phase, 'prepared');
  assert.ok(!names(m).includes('restore'));
  assert.ok(
    m.trace
      .filter((e) => ['request.persist', 'journal.create'].includes(e.name))
      .every((e) => e.frame === 1),
  );
});

test('RED C16 final ownership failure preserves completed durable state and later exact replay', () => {
  const m = reach('session-evidence-cleared');
  let checks = 0;
  m.before = (e) => {
    if (e.name === 'assertOwned' && ++checks === 3) throw sentinel;
  };
  assert.throws(m.continueRevision, (e) => e === sentinel);
  assert.equal(m.journal.phase, 'completed');
  assert.equal(
    m.state.ref?.transactionDigest,
    m.journal.successorTransaction?.recordDigest,
  );
  m.before = undefined;
  assert.equal(m.continueRevision(), null);
  assert.equal(m.begin().transaction, m.journal.successorTransaction);
});
