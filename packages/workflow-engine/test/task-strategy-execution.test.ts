import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createTaskStrategyExecutionService } from '../src/application/execute-task/task-strategy-execution.ts';
import type { TaskStrategyExecutionOperations } from '../src/application/execute-task/task-strategy-execution-operations.ts';
import type { WorkflowSession } from '../src/modules/lifecycle/workflow-session-contract.ts';
import type { SessionInspection } from '../src/modules/lifecycle/session-inspection.ts';
import type { CrossAgentTddExecution } from '../src/modules/planning-provider/planning-artifact-types.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyTransactionInput,
  TaskStrategyFrozenFile,
} from '../src/modules/assurance/task-strategy-evidence.ts';
import type { ExpectedRedCheckResult } from '../src/modules/assurance/check-execution-port.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from '../src/foundation/evidence-node/evidence-node.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { prepareTaskStrategyTransaction } from '../src/modules/assurance/task-strategy-transaction.ts';

const NOW = '2026-10-02T01:00:00.000Z';
const ROOT = '/memory/red-sealing';
const digest = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => digest(canonicalJson(value));

function fixture() {
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
  const task: CrossAgentTddExecution = {
    ...commonTask,
    strategy: 'cross-agent-tdd',
    requiredImplementerIndependence: 'session-independent',
  };
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
    changedPaths: ['test/feature.test.ts'],
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
          unit: { command: ['node', 'test.mjs'], destructiveDatabase: false },
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
  const state = {
    after: inspection,
    current: null as TaskStrategyTransaction | null,
    tree: '3'.repeat(40),
    afterTree: '3'.repeat(40),
    previews: 0,
    environmentReads: 0,
    environments: [
      { AGENT: 'codex' },
      { RED_PREPARE: 'fresh' },
    ] as NodeJS.ProcessEnv[],
    files: [
      {
        path: 'test/feature.test.ts',
        mode: '100644',
        objectId: '4'.repeat(40),
      },
    ] as TaskStrategyFrozenFile[],
    result: {
      checkId: 'unit',
      exitCode: 1,
      runner: 'node',
      runnerDigest: digest('runner'),
      failureCategory: 'assertion',
      selector: 'unit',
      testPaths: ['test/feature.test.ts'],
      stdoutDigest: digest('failure'),
      stderrDigest: digest(''),
      failureFingerprint: digest('fingerprint'),
    } as ExpectedRedCheckResult,
    failAt: '',
  };
  const events: { name: string; args: unknown[] }[] = [];
  const sentinel = new Error('injected operation failure');
  const emit = (name: string, ...args: unknown[]) => {
    events.push({ name, args });
    if (state.failAt === name) throw sentinel;
  };
  const pinned = Object.freeze({
    runner: 'node',
    executable: '/memory/node',
    args: ['test.mjs'],
    digest: digest('runner'),
  });
  const checkEnvironment = { CHECK: 'bound' };
  const writes: EvidenceNode[] = [];
  const inputs: TaskStrategyTransactionInput[] = [];
  const operations: TaskStrategyExecutionOperations = {
    session: {
      inspect: (...args) => {
        emit('inspect', ...args);
        return inspection;
      },
      inspectExpected: (...args) => {
        emit('inspectExpected', ...args);
        return state.after;
      },
      previewCandidate: (...args) => {
        emit('preview', ...args);
        return { tree: state.previews++ === 0 ? state.tree : state.afterTree };
      },
    },
    locks: {
      runSessionOperation: (cwd, id, run) => {
        emit('lock', cwd, id);
        try {
          return run();
        } finally {
          emit('unlock');
        }
      },
    },
    observeJournal: (cwd) => {
      emit('journal', cwd);
      return {
        transaction: {
          readTransaction: (id) => {
            emit('read', id);
            return state.current;
          },
          create: (input) => {
            emit('create', input);
            inputs.push(input);
            state.current = prepareTaskStrategyTransaction(input);
            return state.current;
          },
        },
        evidence: {
          read: (id) => {
            emit('readEvidence', id);
            throw sentinel;
          },
          write: (node) => {
            emit('write', node);
            writes.push(node);
          },
        },
      };
    },
    checks: {
      pin: (...args) => {
        emit('pin', ...args);
        return pinned;
      },
      environment: (...args) => {
        emit('checkEnvironment', ...args);
        return checkEnvironment;
      },
      run: (...args) => {
        emit('run', ...args);
        return state.result;
      },
    },
    readFrozenFiles: (...args) => {
      emit('files', ...args);
      return state.files;
    },
    environment: () => {
      emit('environment');
      return state.environments[state.environmentReads++]!;
    },
    clock: {
      now: () => {
        emit('clock');
        return new Date(NOW);
      },
    },
  };
  const service = createTaskStrategyExecutionService(operations);
  const names = () => events.map(({ name }) => name);
  const args = (name: string) =>
    events.find((event) => event.name === name)!.args;
  const seal = () => service.sealTaskStrategyRed(ROOT, session.sessionId);
  const author: TaskStrategyTransaction['author'] = {
    providerId: 'claude',
    assurance: 'adapter-assigned',
  };
  const successor = (predecessorCandidateTree = '0'.repeat(40)) =>
    service.prepareTaskStrategyRedSuccessorUnlocked(ROOT, session.sessionId, {
      author,
      predecessorCandidateTree,
    });
  return {
    service,
    operations,
    session,
    inspection,
    task,
    state,
    events,
    sentinel,
    writes,
    inputs,
    pinned,
    checkEnvironment,
    names,
    args,
    seal,
    successor,
    author,
  };
}

test('RED factory is lazy, exposes exactly three use cases, and keeps independent journals', () => {
  const a = fixture(),
    b = fixture();
  assert.deepEqual(a.names(), []);
  assert.deepEqual(Object.keys(a.service).sort(), [
    'inspectTaskStrategyTransaction',
    'prepareTaskStrategyRedSuccessorUnlocked',
    'sealTaskStrategyRed',
  ]);
  const transaction = a.seal();
  assert.strictEqual(
    a.service.inspectTaskStrategyTransaction(ROOT, 'session-memory'),
    transaction,
  );
  assert.equal(
    b.service.inspectTaskStrategyTransaction('/another', 'requested-id'),
    null,
  );
  assert.deepEqual(b.events, [
    { name: 'journal', args: ['/another'] },
    { name: 'read', args: ['requested-id'] },
  ]);
  b.service.inspectTaskStrategyTransaction('/fresh', 'second-id');
  assert.deepEqual(b.events.slice(2), [
    { name: 'journal', args: ['/fresh'] },
    { name: 'read', args: ['second-id'] },
  ]);
});

test('initial RED observes two fresh environments, pins before execution, publishes evidence before the whole transaction result', () => {
  const f = fixture();
  const result = f.seal();
  assert.strictEqual(result, f.state.current);
  assert.deepEqual(f.names(), [
    'lock',
    'inspect',
    'environment',
    'journal',
    'read',
    'environment',
    'preview',
    'pin',
    'checkEnvironment',
    'run',
    'inspectExpected',
    'preview',
    'files',
    'clock',
    'write',
    'create',
    'unlock',
  ]);
  assert.deepEqual(f.args('lock'), [ROOT, f.session.sessionId]);
  assert.deepEqual(f.args('preview'), [
    ROOT,
    f.session.baseline.head,
    f.inspection.changedPaths,
  ]);
  assert.notStrictEqual(f.args('preview')[2], f.inspection.changedPaths);
  assert.deepEqual(f.args('pin'), [
    ROOT,
    'unit',
    f.inspection.contract.checks.checks.unit,
  ]);
  assert.deepEqual(f.args('checkEnvironment'), [
    ROOT,
    f.state.environments[1],
    false,
  ]);
  assert.strictEqual(f.args('checkEnvironment')[1], f.state.environments[1]);
  assert.deepEqual(f.args('run'), [
    ROOT,
    'unit',
    f.inspection.contract.checks.checks.unit,
    f.pinned,
    f.checkEnvironment,
  ]);
  assert.strictEqual(f.args('run')[3], f.pinned);
  assert.strictEqual(f.args('run')[4], f.checkEnvironment);
  assert.strictEqual(f.args('inspectExpected')[2], f.session);
  assert.strictEqual(f.inputs[0]!.red.evidenceNode, f.writes[0]);
  assert.strictEqual(f.inputs[0]!.baseline, f.session.baseline);
  assert.notStrictEqual(
    f.inputs[0]!.red.changedPaths,
    f.inspection.changedPaths,
  );
  assert.notStrictEqual(f.inputs[0]!.red.testPaths, f.state.result.testPaths);
});

test('explicit environment bypasses lazy defaults for initial sealing and replay', () => {
  const f = fixture(),
    environment = { ONLY: 'explicit' };
  const initial = f.service.sealTaskStrategyRed(ROOT, f.session.sessionId, {
    explicitActor: 'codex',
    environment,
  });
  assert.equal(f.state.environmentReads, 0);
  assert.strictEqual(f.args('checkEnvironment')[1], environment);
  f.events.length = 0;
  assert.strictEqual(
    f.service.sealTaskStrategyRed(ROOT, f.session.sessionId, {
      explicitActor: 'codex',
      environment,
    }),
    initial,
  );
  assert.deepEqual(f.names(), [
    'lock',
    'inspect',
    'journal',
    'read',
    'preview',
    'files',
    'unlock',
  ]);
});

test('completed replay reads one environment and returns the stored object without preparation', () => {
  const f = fixture(),
    initial = f.seal();
  f.events.length = 0;
  f.state.environments.push({ AGENT: 'codex' });
  assert.strictEqual(f.seal(), initial);
  assert.deepEqual(f.names(), [
    'lock',
    'inspect',
    'environment',
    'journal',
    'read',
    'preview',
    'files',
    'unlock',
  ]);
  assert.deepEqual(f.args('files'), [
    ROOT,
    initial.red.candidateTree,
    initial.red.files.map(({ path }) => path),
  ]);
});

for (const [name, mutate] of [
  [
    'missing task',
    (f: ReturnType<typeof fixture>) => {
      delete f.inspection.contract.execution!.tasks['1.1'];
    },
  ],
  [
    'missing actor',
    (f: ReturnType<typeof fixture>) => {
      f.state.environments[0] = {};
    },
  ],
  [
    'conflicting actor',
    (f: ReturnType<typeof fixture>) => {
      f.state.environments[0] = { AGENT: 'codex', CLAUDECODE: '1' };
    },
  ],
] as const) {
  test(`RED rejects ${name} before journal discovery`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(f.seal, {
      code:
        name === 'missing task'
          ? 'TASK_STRATEGY_RED_NOT_APPLICABLE'
          : name === 'missing actor'
            ? 'ACTOR_IDENTITY_REQUIRED'
            : 'ACTOR_IDENTITY_CONFLICT',
    });
    assert.equal(f.names().includes('journal'), false);
    assert.equal(f.names().at(-1), 'unlock');
  });
}

for (const field of [
  'sessionId',
  'changeId',
  'taskId',
  'baseline',
  'strategy',
  'taskContractDigest',
  'author',
] as const) {
  test(`completed replay rejects changed ${field} before preview`, () => {
    const f = fixture(),
      original = f.seal();
    const changes = {
      sessionId: 'session-other',
      changeId: 'other-change',
      taskId: '2.1',
      baseline: { head: 'f'.repeat(40), tree: 'e'.repeat(40) },
      strategy: 'tdd-single-agent' as const,
      taskContractDigest: digest('other'),
      author: {
        providerId: 'claude' as const,
        assurance: 'runtime-hint' as const,
      },
    };
    f.state.current = { ...original, [field]: changes[field] };
    f.state.environments.push({ AGENT: 'codex' });
    f.events.length = 0;
    assert.throws(f.seal, { code: 'TASK_STRATEGY_RED_STALE' });
    assert.equal(f.names().includes('preview'), false);
  });
}

for (const mode of ['tree', 'bytes', 'order'] as const) {
  test(`completed replay rejects different frozen ${mode}`, () => {
    const f = fixture();
    f.inspection.changedPaths.push('test/other.test.ts');
    f.state.result = {
      ...f.state.result,
      testPaths: [...f.inspection.changedPaths],
    };
    f.state.files.push({
      path: 'test/other.test.ts',
      mode: '100755',
      objectId: '5'.repeat(40),
    });
    f.seal();
    f.state.environments.push({ AGENT: 'codex' });
    f.events.length = 0;
    if (mode === 'tree') f.state.afterTree = 'f'.repeat(40);
    else if (mode === 'bytes')
      f.state.files = f.state.files.map((x) => ({
        ...x,
        objectId: 'f'.repeat(40),
      }));
    else f.state.files = [...f.state.files].reverse();
    assert.throws(f.seal, { code: 'TASK_STRATEGY_RED_STALE' });
    assert.equal(f.names().includes('files'), mode !== 'tree');
    assert.equal(f.names().includes('run'), false);
  });
}

for (const paths of [
  ['src/implementation.ts'],
  ['unknown.txt'],
  ['test/fixtures/input.json'],
]) {
  test(`RED refuses invalid path scope ${paths.join(',')}`, () => {
    const f = fixture();
    f.task.fixturePathScopes = ['test/fixtures/**'];
    f.inspection.changedPaths = paths;
    assert.throws(f.seal, { code: 'TASK_STRATEGY_RED_SCOPE_INVALID' });
    assert.equal(f.names().includes('preview'), false);
  });
}
for (const missing of [true, false]) {
  test(`RED refuses ${missing ? 'missing' : 'destructive'} check before preview or pin`, () => {
    const f = fixture();
    if (missing) delete f.inspection.contract.checks.checks.unit;
    else f.inspection.contract.checks.checks.unit!.destructiveDatabase = true;
    assert.throws(f.seal, { code: 'TASK_STRATEGY_RED_CHECK_UNSAFE' });
    assert.equal(f.names().includes('preview'), false);
  });
}

for (const category of [
  'assertion',
  'behavior-mismatch',
  'syntax',
  'missing-dependency',
  'unsafe-database',
  'unrelated',
] as const) {
  test(`RED classifies observed runner category ${category}`, () => {
    const f = fixture();
    f.state.result = { ...f.state.result, failureCategory: category };
    if (category === 'assertion' || category === 'behavior-mismatch')
      assert.equal(f.seal().red.failureCategory, category);
    else {
      assert.throws(f.seal, { code: 'TASK_STRATEGY_RED_FAILURE_INVALID' });
      assert.equal(f.names().includes('inspectExpected'), false);
      assert.deepEqual(f.writes, []);
    }
  });
}
for (const paths of [[], ['test/other.test.ts'], ['test/b.ts', 'test/a.ts']]) {
  test(`runner must cover exact sorted test path array ${paths.join(',')}`, () => {
    const f = fixture();
    if (paths.length === 2)
      f.inspection.changedPaths = ['test/b.ts', 'test/a.ts'];
    f.state.result = { ...f.state.result, testPaths: paths };
    assert.throws(f.seal, { code: 'TASK_STRATEGY_RED_SCOPE_INVALID' });
    assert.equal(f.names().includes('inspectExpected'), false);
  });
}

for (const change of ['tree', 'list', 'order'] as const) {
  test(`postcheck rejects changed ${change} before frozen reads or clock`, () => {
    const f = fixture();
    f.inspection.changedPaths = ['test/a.ts', 'test/b.ts'];
    f.state.result = {
      ...f.state.result,
      testPaths: [...f.inspection.changedPaths],
    };
    f.state.after = {
      ...f.inspection,
      changedPaths:
        change === 'list'
          ? ['test/a.ts']
          : change === 'order'
            ? ['test/b.ts', 'test/a.ts']
            : [...f.inspection.changedPaths],
    };
    if (change === 'tree') f.state.afterTree = 'f'.repeat(40);
    assert.throws(f.seal, { code: 'TASK_STRATEGY_RED_STALE' });
    assert.strictEqual(f.args('inspectExpected')[2], f.session);
    assert.equal(f.names().includes('files'), false);
    assert.equal(f.names().includes('clock'), false);
  });
}

test('postcheck previews fresh inspection facts but freezes the original candidate root and tree', () => {
  const f = fixture();
  f.state.after = {
    ...f.inspection,
    git: { ...f.inspection.git, repositoryRoot: '/fresh/root' },
    session: {
      ...f.session,
      baseline: { ...f.session.baseline, head: 'f'.repeat(40) },
    },
  };
  f.seal();
  assert.deepEqual(
    f.events.filter((x) => x.name === 'preview').map((x) => x.args),
    [
      [ROOT, f.session.baseline.head, ['test/feature.test.ts']],
      ['/fresh/root', 'f'.repeat(40), ['test/feature.test.ts']],
    ],
  );
  assert.deepEqual(f.args('files'), [
    ROOT,
    '3'.repeat(40),
    ['test/feature.test.ts'],
  ]);
});

test('successor owns complete preparation, exact evidence and shallow boundaries, with no publication or actor resolution', () => {
  const f = fixture();
  f.state.environments[0] = { AGENT: 'not-a-provider', CLAUDECODE: '1' };
  const prepared = f.successor(),
    input = prepared.transactionInput,
    node = prepared.evidenceNode;
  assert.deepEqual(f.names(), [
    'inspect',
    'environment',
    'preview',
    'pin',
    'checkEnvironment',
    'run',
    'inspectExpected',
    'preview',
    'files',
    'clock',
  ]);
  assert.strictEqual(input.author, f.author);
  assert.strictEqual(input.baseline, f.session.baseline);
  assert.strictEqual(input.red.files, f.state.files);
  assert.strictEqual(input.red.evidenceNode, node);
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(input));
  assert.equal(Object.isFrozen(input.red), false);
  assert.equal(Object.isFrozen(input.red.files), false);
  assert.notStrictEqual(input.red.changedPaths, f.inspection.changedPaths);
  assert.notStrictEqual(input.red.testPaths, f.state.result.testPaths);
  assert.deepEqual(node, {
    ...node,
    type: 'task-strategy-red-evidence',
    nodeSchema: 'task-strategy-red-evidence.v1',
    evaluator: 'workflow-engine',
    policyDigest: hash({
      schemaVersion: 1,
      kind: 'task-strategy-red-policy.v1',
      admittedFailureCategories: ['assertion', 'behavior-mismatch'],
      engineOwnedCheckEvidence: true,
      frozenTestBytes: true,
    }),
    exactInputDigests: {
      candidateTree: digest(f.state.tree),
      taskContract: hash(f.task),
      runner: f.state.result.runnerDigest,
      failure: f.state.result.failureFingerprint,
      frozenFiles: hash(f.state.files),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'task-strategy-red-result.v1',
    output: {
      outcome: 'red-sealed',
      checkId: 'unit',
      failureCategory: 'assertion',
      selector: 'unit',
      testPaths: f.state.result.testPaths,
      fixturePaths: [],
      author: f.author,
    },
    runtimeMetadata: { createdAt: NOW },
  });
  assert.equal(input.createdAt, NOW);
});

test('classification gives fixtures priority then tests then implementation, sorts without deduplicating', () => {
  const f = fixture();
  f.task.fixturePathScopes = ['test/fixtures/**'];
  f.task.implementationPathScopes = ['test/**'];
  f.inspection.changedPaths = [
    'test/b.ts',
    'test/fixtures/z.json',
    'test/a.ts',
    'test/b.ts',
    'test/fixtures/a.json',
  ];
  f.state.result = {
    ...f.state.result,
    testPaths: ['test/a.ts', 'test/b.ts', 'test/b.ts'],
  };
  const input = f.successor().transactionInput;
  assert.deepEqual(input.red.changedPaths, f.inspection.changedPaths);
  assert.deepEqual(input.red.testPaths, [
    'test/a.ts',
    'test/b.ts',
    'test/b.ts',
  ]);
  assert.deepEqual(input.red.fixturePaths, [
    'test/fixtures/a.json',
    'test/fixtures/z.json',
  ]);
  assert.deepEqual(f.args('files')[2], [
    'test/a.ts',
    'test/b.ts',
    'test/b.ts',
    'test/fixtures/a.json',
    'test/fixtures/z.json',
  ]);
});

test('successor active-state guard precedes environment, while NO_CHANGE follows complete preparation and clock', () => {
  const f = fixture();
  f.session.state = 'committed';
  assert.throws(f.successor, {
    code: 'TASK_STRATEGY_RED_REVISION_NOT_APPLICABLE',
  });
  assert.deepEqual(f.names(), ['inspect']);
  f.session.state = 'active';
  f.events.length = 0;
  assert.throws(() => f.successor(f.state.tree), {
    code: 'TASK_STRATEGY_RED_REVISION_NO_CHANGE',
  });
  assert.equal(f.names().at(-1), 'clock');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.inputs, []);
});

for (const effect of [
  'inspect',
  'journal',
  'read',
  'preview',
  'pin',
  'checkEnvironment',
  'run',
  'inspectExpected',
  'files',
  'clock',
  'write',
  'create',
]) {
  test(`RED propagates original ${effect} error and releases its session lock`, () => {
    const f = fixture();
    f.state.failAt = effect;
    assert.throws(f.seal, (error) => error === f.sentinel);
    assert.equal(f.names().at(-1), 'unlock');
    if (effect !== 'create') assert.equal(f.names().includes('create'), false);
    if (!['write', 'create'].includes(effect)) assert.deepEqual(f.writes, []);
  });
}

test('single-agent successor uses the same preparation and explicit environment without reading defaults', () => {
  const f = fixture();
  f.inspection.contract.execution!.tasks['1.1'] = {
    ...f.task,
    strategy: 'tdd-single-agent',
    requiredImplementerIndependence: 'none',
  };
  const environment = { RED: 'explicit' };
  const prepared = f.service.prepareTaskStrategyRedSuccessorUnlocked(
    ROOT,
    f.session.sessionId,
    {
      author: f.author,
      predecessorCandidateTree: '0'.repeat(40),
      environment,
    },
  );
  assert.equal(prepared.transactionInput.strategy, 'tdd-single-agent');
  assert.equal(f.state.environmentReads, 0);
  assert.strictEqual(f.args('checkEnvironment')[1], environment);
  assert.strictEqual(prepared.transactionInput.author, f.author);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.inputs, []);
  assert.equal(
    prepared.transactionInput.red.stdoutDigest,
    f.state.result.stdoutDigest,
  );
  assert.equal(
    prepared.transactionInput.red.stderrDigest,
    f.state.result.stderrDigest,
  );
  assert.equal(
    prepared.transactionInput.red.failureFingerprint,
    f.state.result.failureFingerprint,
  );
  assert.equal(prepared.transactionInput.red.exitCode, f.state.result.exitCode);
  assert.equal(prepared.transactionInput.red.runner, f.state.result.runner);
  assert.equal(
    prepared.transactionInput.red.runnerDigest,
    f.state.result.runnerDigest,
  );
});

// These are memory-port tests of the actual factory. The integration controls
// separately exercise the original durable writer, reader and transaction producer.
function collisionFixture() {
  const prior = fixture();
  const oldTime = '2026-10-01T01:00:00.000Z';
  prior.operations.clock = { now: () => new Date(oldTime) };
  const priorTransaction = prior.seal();
  const stored = priorTransaction.red.evidenceNode;
  const f = fixture();
  const collision = workflowError(
    'EVIDENCE_OBJECT_COLLISION',
    'existing immutable evidence',
    ExitCode.conflict,
    { details: { nodeId: stored.nodeId } },
  );
  const recovery = {
    stored: stored as unknown,
    writeError: collision as unknown,
    readError: undefined as unknown,
    reads: [] as string[],
    returned: [] as EvidenceNode[],
  };
  const observe = f.operations.observeJournal;
  f.operations.observeJournal = (cwd) => {
    const journal = observe(cwd);
    return {
      ...journal,
      evidence: {
        write(node) {
          journal.evidence.write(node);
          throw recovery.writeError;
        },
        read(id) {
          f.events.push({ name: 'readEvidence', args: [id] });
          recovery.reads.push(id);
          if (recovery.readError !== undefined) throw recovery.readError;
          const value = assertStoredEvidenceNode(recovery.stored, () =>
            workflowError(
              'EVIDENCE_OBJECT_INVALID',
              'invalid memory envelope',
              ExitCode.staleState,
            ),
          );
          recovery.returned.push(value);
          return value;
        },
      },
    };
  };
  return { ...f, recovery, collision, stored, priorTransaction, oldTime };
}

test('initial exact collision reuses the whole stored proof and retains fresh transaction facts with one read and no second write', () => {
  const f = collisionFixture();
  const before = canonicalJson(f.stored);
  const result = f.seal(),
    input = f.inputs[0]!;
  assert.strictEqual(result, f.state.current);
  assert.deepEqual(f.recovery.reads, [f.stored.nodeId]);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.names().slice(-5), [
    'clock',
    'write',
    'readEvidence',
    'create',
    'unlock',
  ]);
  assert.equal(f.names().filter((n) => n === 'clock').length, 1);
  assert.strictEqual(input.red.evidenceNode, f.stored);
  assert.strictEqual(input.red.evidenceNode, f.recovery.returned[0]);
  assert.notStrictEqual(input.red.evidenceNode, f.writes[0]);
  assert.deepEqual(f.writes[0]!.runtimeMetadata, { createdAt: NOW });
  assert.deepEqual(input.red.evidenceNode.runtimeMetadata, {
    createdAt: f.oldTime,
  });
  assert.equal(canonicalJson(f.stored), before);
  assert.equal(input.createdAt, NOW);
  assert.strictEqual(input.baseline, f.session.baseline);
  assert.strictEqual(input.red.files, f.state.files);
  assert.deepEqual(input.author, {
    providerId: 'codex',
    assurance: 'runtime-hint',
  });
  assert.equal(input.red.evidenceNodeId, f.writes[0]!.nodeId);
  assert.equal(input.red.evidenceResultDigest, f.writes[0]!.resultDigest);
  assert.ok(Object.isFrozen(input));
  assert.equal(Object.isFrozen(input.red), false);
  assert.equal(Object.isFrozen(input.red.files), false);
  const { evidenceNode: storedNode, ...red } = input.red;
  const { evidenceNode: priorNode, ...priorRed } = f.priorTransaction.red;
  assert.deepEqual(red, priorRed);
  assert.strictEqual(storedNode, priorNode);
  f.state.environments.push({ AGENT: 'codex' });
  f.events.length = 0;
  assert.strictEqual(f.seal(), result);
  assert.deepEqual(f.names(), [
    'lock',
    'inspect',
    'environment',
    'journal',
    'read',
    'preview',
    'files',
    'unlock',
  ]);
  assert.equal(f.recovery.reads.length, 1);
});

test('memory factory shares identical evidence across distinct sessions without borrowing prior session, baseline or transaction time', () => {
  const f = collisionFixture();
  f.session.sessionId = 'session-new-context';
  f.session.changeId = 'new-change';
  f.session.taskId = '2.1';
  f.session.baseline = { head: 'a'.repeat(40), tree: 'b'.repeat(40) };
  f.inspection.contract.execution!.tasks = { '2.1': f.task };
  f.inspection.contract.changeId = f.session.changeId;
  const result = f.seal();
  assert.equal(result.sessionId, 'session-new-context');
  assert.equal(result.changeId, 'new-change');
  assert.equal(result.taskId, '2.1');
  assert.strictEqual(result.baseline, f.session.baseline);
  assert.equal(result.createdAt, NOW);
  assert.notEqual(result.sessionId, f.priorTransaction.sessionId);
  assert.notDeepEqual(result.baseline, f.priorTransaction.baseline);
  assert.notEqual(result.createdAt, f.priorTransaction.createdAt);
  assert.strictEqual(result.red.evidenceNode, f.stored);
  assert.equal(result.red.evidenceNode.nodeId, f.writes[0]!.nodeId);
  assert.equal(result.red.evidenceNode.resultDigest, f.writes[0]!.resultDigest);
  assert.deepEqual(f.args('preview'), [
    ROOT,
    f.session.baseline.head,
    f.inspection.changedPaths,
  ]);
  assert.equal(f.names().filter((n) => n === 'run').length, 1);
  assert.equal(f.names().filter((n) => n === 'clock').length, 1);
});

for (const code of [
  'EVIDENCE_OBJECT_UNAVAILABLE',
  'EVIDENCE_OBJECT_INVALID',
  'EVIDENCE_OBJECT_UNSAFE',
]) {
  test(`initial reconciliation preserves original collision when canonical read reports ${code}`, () => {
    const f = collisionFixture();
    f.recovery.readError = workflowError(
      code,
      'reader refused',
      ExitCode.staleState,
    );
    assert.throws(f.seal, (error) => error === f.collision);
    assert.deepEqual(f.recovery.reads, [f.stored.nodeId]);
    assert.deepEqual(f.inputs, []);
    assert.equal(f.names().at(-1), 'unlock');
  });
}

const incompatibleEvidence: [string, (node: EvidenceNode) => unknown][] = [
  ['missing createdAt', (node) => ({ ...node, runtimeMetadata: {} })],
  [
    'invalid createdAt',
    (node) => ({ ...node, runtimeMetadata: { createdAt: 'not-a-time' } }),
  ],
  [
    'non-string createdAt',
    (node) => ({ ...node, runtimeMetadata: { createdAt: 0 } }),
  ],
  [
    'additional metadata',
    (node) => ({
      ...node,
      runtimeMetadata: { ...node.runtimeMetadata, other: 'different' },
    }),
  ],
  [
    'different output',
    (node) =>
      createEvidenceNode({
        ...node,
        output: {
          ...(node.output as Record<string, unknown>),
          selector: 'different',
        },
      }),
  ],
  [
    'different author',
    (node) =>
      createEvidenceNode({
        ...node,
        output: {
          ...(node.output as Record<string, unknown>),
          author: { providerId: 'claude', assurance: 'runtime-hint' },
        },
      }),
  ],
  [
    'different exact input',
    (node) =>
      createEvidenceNode({
        ...node,
        exactInputDigests: {
          ...node.exactInputDigests,
          runner: digest('different'),
        },
      }),
  ],
  [
    'different schema',
    (node) => createEvidenceNode({ ...node, nodeSchema: 'different.v1' }),
  ],
  [
    'different policy',
    (node) =>
      createEvidenceNode({ ...node, policyDigest: digest('different') }),
  ],
  [
    'different provenance',
    (node) =>
      createEvidenceNode({
        ...node,
        provenanceParentNodeIds: { prior: digest('prior') },
      }),
  ],
  [
    'different semantic parents',
    (node) =>
      createEvidenceNode({
        ...node,
        semanticParentResultDigests: { prior: digest('prior') },
      }),
  ],
  ['forged node ID', (node) => ({ ...node, nodeId: digest('forged') })],
  [
    'forged result digest',
    (node) => ({ ...node, resultDigest: digest('forged') }),
  ],
  ['extra envelope field', (node) => ({ ...node, unexpected: true })],
  ['null read', () => null],
];
for (const [name, change] of incompatibleEvidence) {
  test(`initial collision rejects ${name} without publication or replacing the original error`, () => {
    const f = collisionFixture();
    f.recovery.stored = change(f.stored);
    const before = canonicalJson(f.recovery.stored);
    assert.throws(f.seal, (error) => error === f.collision);
    assert.deepEqual(f.recovery.reads, [f.stored.nodeId]);
    assert.deepEqual(f.inputs, []);
    assert.equal(f.writes.length, 1);
    assert.equal(canonicalJson(f.recovery.stored), before);
    assert.equal(f.names().at(-1), 'unlock');
  });
}

for (const kind of [
  'plain-error',
  'plain-collision-object',
  'wrong-code',
  'wrong-node-id',
  'missing-node-id',
]) {
  test(`initial write ${kind} propagates unchanged without any recovery read`, () => {
    const f = collisionFixture();
    f.recovery.writeError =
      kind === 'plain-error'
        ? f.sentinel
        : kind === 'plain-collision-object'
          ? {
              code: 'EVIDENCE_OBJECT_COLLISION',
              details: { nodeId: f.stored.nodeId },
            }
          : workflowError(
              kind === 'wrong-code'
                ? 'EVIDENCE_OBJECT_INVALID'
                : 'EVIDENCE_OBJECT_COLLISION',
              'write refused',
              ExitCode.conflict,
              {
                details:
                  kind === 'missing-node-id'
                    ? {}
                    : {
                        nodeId:
                          kind === 'wrong-node-id'
                            ? digest('other')
                            : f.stored.nodeId,
                      },
              },
            );
    assert.throws(f.seal, (error) => error === f.recovery.writeError);
    assert.deepEqual(f.recovery.reads, []);
    assert.deepEqual(f.inputs, []);
    assert.equal(f.names().at(-1), 'unlock');
  });
}
