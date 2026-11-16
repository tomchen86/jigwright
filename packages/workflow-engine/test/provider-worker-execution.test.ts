import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  runProviderWorkerWithMandate,
  runProviderWorkerAsyncWithMandate,
  type ProviderWorkerExecutionEffects,
  type ProviderWorkerOptions,
  type ProviderWorkerRepositoryContext,
} from '../src/application/provider-worker/provider-worker-execution.ts';
import type { ProviderWorkerClaimTaskMandate } from '../src/application/provider-worker/provider-worker-claim.ts';
import type { ProviderInvocationRecord } from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import type { ProviderInvocationCompletionInput } from '../src/modules/provider-orchestration/provider-invocation-lifecycle.ts';
import type {
  AgentRuntimeSingleShotInput,
  AgentRuntimeSingleShotReport,
  AgentRuntimeCompletionReceipt,
  CurrentAgentRuntimeAssignmentV1,
  ProviderInvocationAcceptanceBinding,
  ProviderWorkerRuntimePort,
} from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import { BLIND_SURVEY_OUTPUT_SCHEMA } from '../src/modules/provider-orchestration/blind-survey-output.ts';
import { TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA } from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';

type ImplementationOwner = ReturnType<
  ProviderWorkerExecutionEffects['assertTaskStrategyImplementationProviderOwnerCurrent']
>;
type FailureObservation = Parameters<
  ProviderWorkerExecutionEffects['recordProviderWorkerFailure']
>[0];

function fixture() {
  const events: Array<[string, ...unknown[]]> = [];
  const hooks: Record<string, (() => void) | undefined> = {};
  const step = (name: string, ...args: unknown[]) => {
    events.push([name, ...args]);
    hooks[name]?.();
  };
  const initial: ProviderInvocationRecord = {
    schemaVersion: 1,
    invocationId: 'invocation-one',
    investigationId: 'investigation-one',
    changeId: 'worker-execution',
    attempt: 1,
    revision: 2,
    state: 'prepared',
    providerId: 'codex',
    purpose: 'survey',
    requestDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    leaseGeneration: 0,
    lease: null,
    result: null,
    failure: null,
    createdAt: '2030-01-02T03:04:05.000Z',
    updatedAt: '2030-01-02T03:04:05.000Z',
  };
  // Journal and owner admission are injected here; the use case consumes these
  // canonical contract references without parsing the rest of their wire shape.
  const request = {
    invocationId: initial.invocationId,
    providerId: initial.providerId,
    purpose: 'survey',
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
  } as ProviderInvocationRequest;
  const claim = {
    record: {
      ...initial,
      state: 'leased' as const,
      revision: 3,
      leaseGeneration: 1,
    },
    leaseToken: 'lease-one',
    workerFenceToken: 'fence-one',
  };
  const claimInput = {
    workerId: 'worker-one',
    leaseDurationMs: 5000,
    expectedRevision: initial.revision,
  };
  const terminal = {
    ...initial,
    state: 'succeeded' as const,
    revision: 4,
    leaseGeneration: 1,
  };
  const failed = {
    ...terminal,
    state: 'failed' as const,
    failure: {
      kind: 'retryable' as const,
      code: 'FAKE_FAILURE',
      message: 'Recorded by the existing failure owner.',
    },
  };
  const context: ProviderWorkerRepositoryContext = {
    git: { repositoryRoot: '/repo' },
    runtime: {
      base: '/git',
      root: '/runtime',
      objects: '/objects',
      refs: '/refs',
      sessions: '/sessions',
      invocations: '/invocations',
      locks: '/locks',
    },
    lifecycleRuntime: {
      root: '/lifecycle',
      locks: '/lifecycle/locks',
      operations: '/operations',
      sessions: '/lifecycle/sessions',
      reports: '/reports',
      taskRevisions: '/revisions',
    },
  };
  const secondContext = {
    ...context,
    runtime: { ...context.runtime, root: '/fresh-runtime' },
  };
  const acceptance = {
    invocationId: initial.invocationId,
    receiptRequirement: 'schema-v4',
  } as ProviderInvocationAcceptanceBinding;
  const report = {
    semanticOutput: {
      reference: initial.invocationId,
      terms: [{ kind: 'symbol', value: 'run' }],
    },
  } as AgentRuntimeSingleShotReport;
  const owner = {
    subject: {
      sessionId: 'session-implementation',
      sourceTree: 'c'.repeat(40),
    },
  } as ImplementationOwner;
  const state = {
    replay: null as ProviderInvocationRecord | null,
    reviewOwner: null as Parameters<
      ProviderWorkerExecutionEffects['claimProviderWorker']
    >[3]['taskDiffReviewOwner'],
    assignment: null as CurrentAgentRuntimeAssignmentV1 | null,
    exactCancellation: false,
    durable: initial,
    receipt: null as AgentRuntimeCompletionReceipt | null,
    locked: false,
  };
  const taskMandate: ProviderWorkerClaimTaskMandate = {
    withActiveTaskMandateBinding() {
      assert.fail('claim owner must receive mandate, not execute it here');
    },
    assertActiveTaskMandateBindingUnderLifecycleLock() {
      assert.fail('replay owner retains mandate policy');
    },
    recordTaskMandateProviderInvocationUnderLifecycleLock() {
      assert.fail('claim owner retains audit policy');
    },
  };
  const options: ProviderWorkerOptions = {
    environment: { WORKER_TEST: 'original' },
    platform: 'linux',
  };
  const inputs: AgentRuntimeSingleShotInput[] = [];
  const runtimeOptions: Array<
    Parameters<ProviderWorkerRuntimePort['runSingleShotAsync']>[1]
  > = [];
  const failures: FailureObservation[] = [];
  const completions: ProviderInvocationCompletionInput[] = [];
  const modes: ProviderInvocationAcceptanceBinding['receiptRequirement'][] = [];
  let loads = 0;
  const runtime: ProviderWorkerRuntimePort = {
    runSingleShot(input, supplied) {
      assert.equal(this, runtime);
      inputs.push(input);
      runtimeOptions.push(supplied);
      step('execute-sync');
      return report;
    },
    async runSingleShotAsync(input, supplied) {
      assert.equal(this, runtime);
      inputs.push(input);
      runtimeOptions.push(supplied);
      step('execute-async');
      supplied.onActivity?.({ type: 'spawned', elapsedMs: 0 });
      supplied.onActivity?.({ type: 'exited', elapsedMs: 1 });
      return report;
    },
  };
  const watcher = {
    signal: new AbortController().signal,
    hasExactCancellation() {
      assert.equal(this, watcher);
      step('cancellation');
      return state.exactCancellation;
    },
    stop() {
      assert.equal(this, watcher);
      step('watcher-stop');
    },
  };
  const activity = {
    stop() {
      assert.equal(this, activity);
      step('activity-stop');
    },
  };
  const assertOwned = () => {
    assert.equal(state.locked, true);
    step('assert-owned');
  };
  function complete(
    route: string,
    paths: ProviderWorkerRepositoryContext['runtime'],
    id: string,
    input: ProviderInvocationCompletionInput,
  ) {
    assert.equal(paths, context.runtime);
    assert.equal(id, request.invocationId);
    completions.push(input);
    step(route, input);
    return terminal;
  }
  const effects: ProviderWorkerExecutionEffects = {
    loadInvestigationRuntimeContext(cwd) {
      assert.equal(cwd, '/repo');
      step('load');
      return ++loads === 1 ? context : secondContext;
    },
    admitProviderWorkerReplay(mandate, cwd, observed, id, settings) {
      assert.equal(mandate, taskMandate);
      assert.equal(observed, context);
      assert.equal(settings, options);
      assert.equal(cwd, '/repo');
      assert.equal(id, 'requested');
      step('replay');
      return state.replay === null
        ? {
            kind: 'prepared',
            initial,
            request,
            taskDiffReviewOwner: state.reviewOwner,
          }
        : { kind: 'replay', record: state.replay };
    },
    claimProviderWorker(mandate, cwd, observed, facts, settings) {
      assert.equal(mandate, taskMandate);
      assert.equal(cwd, '/repo');
      assert.equal(observed, context);
      assert.equal(facts.initial, initial);
      assert.equal(facts.request, request);
      assert.equal(settings, options);
      step('claim', facts);
      return { claim, claimInput };
    },
    recordProviderWorkerFailure(observation, target) {
      failures.push(observation);
      assert.equal(target.claim, claim);
      assert.equal(target.runtime, context.runtime);
      step('failure', observation);
      step(target.usesWorkerFence() ? 'failure-fenced' : 'failure-ordinary');
      return failed;
    },
    runTerminalFollowups(cwd, record, settings) {
      assert.equal(cwd, '/repo');
      assert.equal(settings, options);
      step('followups', record);
    },
    assertTaskStrategyImplementationProviderOwnerCurrent(cwd, id) {
      assert.equal(cwd, '/repo');
      assert.equal(id, initial.invocationId);
      step('owner');
      return owner;
    },
    readPlanReviewSnapshotRuntime(paths, id) {
      assert.equal(paths, context.runtime);
      assert.equal(id, initial.invocationId);
      step('snapshot');
      return null;
    },
    readProviderInvocation(paths, id) {
      assert.equal(paths, context.runtime);
      assert.equal(id, request.invocationId);
      step('read-durable');
      return state.durable;
    },
    readProviderInvocationRuntimeReceipt(paths, id) {
      assert.equal(paths, secondContext.runtime);
      step('receipt', id);
      return state.receipt;
    },
    prepareProviderInvocationAcceptanceBinding(paths, id, mode) {
      assert.equal(paths, context.runtime);
      assert.equal(id, request.invocationId);
      modes.push(mode);
      step('acceptance');
      return acceptance;
    },
    assertProviderInvocationAcceptanceBindingTerminalCurrent(paths, binding) {
      assert.equal(paths, context.runtime);
      assert.equal(binding, acceptance);
      step('terminal-current');
    },
    completeProviderInvocationFromRunner: (paths, id, input) =>
      complete('complete', paths, id, input),
    completeProviderInvocationFromRunnerForWorkerClaim: (paths, id, input) => {
      assert.equal(input.workerFenceToken, claim.workerFenceToken);
      return complete('complete-fenced', paths, id, input);
    },
    completeProviderInvocationFromRunnerUnderLifecycleLock: (
      paths,
      id,
      input,
      held,
    ) => {
      assert.equal(held, assertOwned);
      assert.equal(state.locked, true);
      return complete('complete-held', paths, id, input);
    },
    releaseProviderInvocationWorkerFence(paths, id, token) {
      assert.equal(paths, context.runtime);
      assert.equal(id, request.invocationId);
      assert.equal(token, claim.workerFenceToken);
      step('release');
    },
    releaseProviderInvocationWorkerFenceForWorkerClaim(paths, id, input) {
      assert.equal(paths, context.runtime);
      assert.equal(id, request.invocationId);
      assert.deepEqual(input, {
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        workerFenceToken: claim.workerFenceToken,
      });
      step('release-fenced');
    },
    withRepositoryLifecycleOperation(layout, operation) {
      assert.equal(layout, context.lifecycleRuntime);
      step('lock');
      state.locked = true;
      try {
        return operation(assertOwned);
      } finally {
        state.locked = false;
        step('unlock');
      }
    },
    resolveAssignment(observed, record, original, settings) {
      assert.equal(observed, context);
      assert.equal(record, initial);
      assert.equal(original, request);
      assert.equal(settings, options);
      step('assignment');
      return state.assignment;
    },
    providerAcceptanceGovernedRuntimeInputs(paths, binding) {
      assert.equal(paths, context.runtime);
      assert.equal(binding, acceptance);
      step('acceptance-inputs');
      return [{ id: 'acceptance', path: '/acceptance' }];
    },
    providerInvocationDurableGovernedRuntimeInputs(paths, id) {
      assert.equal(paths, context.runtime);
      assert.equal(id, request.invocationId);
      step('durable-inputs');
      return [{ id: 'durable', path: '/durable' }];
    },
    productionAgentRuntime: runtime,
    createProviderInvocationCancellationWatcher(paths, id, received, signal) {
      assert.equal(paths, context.runtime);
      assert.equal(id, request.invocationId);
      assert.equal(received, claim);
      assert.equal(signal, options.signal);
      step('watcher');
      return watcher;
    },
    startProviderInvocationActivityHeartbeat(paths, input) {
      assert.equal(paths, context.runtime);
      step('heartbeat', input);
      return activity;
    },
  };
  return {
    effects,
    taskMandate,
    options,
    initial,
    request,
    claim,
    claimInput,
    terminal,
    failed,
    state,
    owner,
    context,
    secondContext,
    acceptance,
    report,
    runtime,
    watcher,
    activity,
    events,
    hooks,
    inputs,
    runtimeOptions,
    failures,
    completions,
    modes,
    stages: () => events.map(([name]) => name),
    run: () =>
      runProviderWorkerWithMandate(
        effects,
        taskMandate,
        '/repo',
        'requested',
        options,
      ),
    runAsync: () =>
      runProviderWorkerAsyncWithMandate(
        effects,
        taskMandate,
        '/repo',
        'requested',
        options,
      ),
  };
}

for (const async of [false, true]) {
  test(`${async ? 'async' : 'sync'} execution keeps wrapper receipt mode, original references and terminal cleanup order`, async () => {
    const f = fixture();
    const result = async ? await f.runAsync() : f.run();
    assert.equal(result.state, 'succeeded');
    assert.equal(result.launched, true);
    assert.equal(Object.isFrozen(result), async);
    assert.deepEqual(f.modes, [
      async ? 'schema-v4' : 'synchronous-no-activity',
    ]);
    assert.equal(f.inputs[0]!.request, f.request);
    assert.equal(f.inputs[0]!.acceptanceBinding, f.acceptance);
    assert.equal(f.inputs[0]!.sourceEnvironment, f.options.environment);
    assert.equal(f.completions[0]!.report, f.report);
    assert.equal(
      f.completions[0]!.runtimeProgress?.processState,
      async ? 'exited' : undefined,
    );
    const stages = f.stages();
    assert.ok(stages.indexOf('claim') < stages.indexOf('assignment'));
    assert.ok(stages.indexOf('assignment') < stages.indexOf('acceptance'));
    if (async) {
      assert.ok(stages.indexOf('activity-stop') < stages.indexOf('release'));
      assert.ok(stages.indexOf('release') < stages.indexOf('watcher-stop'));
      assert.ok(stages.indexOf('watcher-stop') < stages.indexOf('followups'));
      assert.deepEqual(stages.slice(-2), ['load', 'receipt']);
    } else {
      assert.ok(stages.indexOf('followups') < stages.indexOf('release'));
      assert.equal(stages.includes('heartbeat'), false);
      assert.equal(stages.includes('watcher'), false);
    }
  });
}

test('replay skips prepared work; async receipt uses a fresh context and the rendered result ID', async () => {
  const f = fixture();
  f.state.replay = { ...f.failed, invocationId: 'observed-result' };
  f.state.receipt = {
    marker: 'receipt-reference',
  } as unknown as AgentRuntimeCompletionReceipt;
  const sync = f.run();
  assert.equal(sync.launched, false);
  assert.equal(sync.failure, f.failed.failure);
  assert.deepEqual(f.stages(), ['load', 'replay']);
  const g = fixture();
  g.state.replay = f.state.replay;
  g.state.receipt = f.state.receipt;
  const async = await g.runAsync();
  assert.equal(async.completionReceipt, f.state.receipt);
  assert.equal(async.invocationId, 'observed-result');
  assert.deepEqual(g.events.at(-1), ['receipt', 'observed-result']);
  assert.deepEqual(g.stages(), ['load', 'replay', 'load', 'receipt']);
});

test('native assignment retains its binding/turn and appends snapshot, acceptance and durable inputs in order', () => {
  const f = fixture();
  const assignment = {
    binding: { id: 'binding' },
    nativeSessionTurn: { id: 'turn' },
  } as unknown as CurrentAgentRuntimeAssignmentV1;
  f.state.assignment = assignment;
  f.effects.readPlanReviewSnapshotRuntime = () => ({
    root: '/snapshot',
    files: [{ id: 'review', path: '/snapshot/review' }],
  });
  assert.equal(f.run().state, 'succeeded');
  assert.equal(f.inputs[0]!.assignmentBinding, assignment.binding);
  assert.equal(f.inputs[0]!.nativeSessionTurn, assignment.nativeSessionTurn);
  assert.deepEqual(
    f.inputs[0]!.governedRuntimeInputs.map(({ id }) => id),
    ['review', 'acceptance', 'durable'],
  );
  assert.ok(
    f.stages().indexOf('acceptance-inputs') <
      f.stages().indexOf('durable-inputs'),
  );
});

test('TaskDiff short-circuits cancellation, while completion and release independently observe later cancellation', async () => {
  const f = fixture();
  f.state.reviewOwner = { sessionId: 'review' } as NonNullable<
    typeof f.state.reviewOwner
  >;
  assert.equal((await f.runAsync()).state, 'succeeded');
  assert.equal(f.stages().includes('cancellation'), false);
  assert.ok(f.stages().includes('complete-fenced'));
  assert.ok(f.stages().includes('release-fenced'));
  const g = fixture();
  g.hooks.complete = () => {
    g.state.exactCancellation = true;
  };
  assert.equal((await g.runAsync()).state, 'succeeded');
  assert.ok(g.stages().includes('complete'));
  assert.ok(g.stages().includes('release-fenced'));
});

function implementation(f: ReturnType<typeof fixture>) {
  f.request.purpose = 'task-implementation';
  f.request.outputSchema = TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA;
  const patch = Buffer.from('implementation patch');
  f.report.semanticOutput = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-output.v1',
    sessionId: f.owner.subject.sessionId,
    sourceTree: f.owner.subject.sourceTree,
    patchBase64: patch.toString('base64'),
    patchDigest: crypto.createHash('sha256').update(patch).digest('hex'),
  };
}

test('TaskStrategy binds the exact subject and rechecks ownership inside the held completion lock', () => {
  const f = fixture();
  implementation(f);
  assert.equal(f.run().state, 'succeeded');
  assert.deepEqual(
    f
      .stages()
      .filter((stage) =>
        ['owner', 'lock', 'assert-owned', 'complete-held', 'unlock'].includes(
          stage,
        ),
      ),
    ['owner', 'lock', 'owner', 'assert-owned', 'complete-held', 'unlock'],
  );
  const g = fixture();
  implementation(g);
  g.report.semanticOutput = {
    ...(g.report.semanticOutput as object),
    sessionId: 'session-another',
  };
  assert.equal(g.run().state, 'failed');
  const failure = g.failures[0]!.error;
  assert.ok(failure instanceof WorkflowError);
  assert.equal(failure.code, 'PROVIDER_NATIVE_OUTPUT_INVALID');
  assert.equal(g.stages().includes('terminal-current'), false);
  assert.equal(g.stages().includes('lock'), false);
  const h = fixture();
  implementation(h);
  const drift = new Error('owner changed during the run');
  h.hooks.owner = () => {
    if (h.state.locked) throw drift;
  };
  assert.equal(h.run().state, 'failed');
  assert.equal(h.failures[0]!.error, drift);
  assert.equal(h.stages().includes('complete-held'), false);
  assert.ok(h.stages().includes('unlock'));
});

for (const stage of ['replay', 'snapshot', 'claim', 'watcher'] as const) {
  test(`pre-execution ${stage} rejection does not enter failure publication or cleanup`, async () => {
    const f = fixture();
    const error = new Error(stage);
    f.hooks[stage] = () => {
      throw error;
    };
    await assert.rejects(f.runAsync(), (received) => received === error);
    assert.equal(f.failures.length, 0);
    assert.equal(
      f.stages().some((name) => name.startsWith('release')),
      false,
    );
    assert.equal(f.stages().includes('watcher-stop'), false);
  });
}

for (const stage of [
  'assignment',
  'acceptance',
  'execute-sync',
  'terminal-current',
]) {
  test(`${stage} failure preserves error identity and acceptance visibility`, () => {
    const f = fixture();
    const error = new Error(stage);
    f.hooks[stage] = () => {
      throw error;
    };
    assert.equal(f.run().state, 'failed');
    assert.equal(f.failures[0]!.error, error);
    assert.equal(
      f.failures[0]!.acceptanceBinding,
      ['assignment', 'acceptance'].includes(stage) ? null : f.acceptance,
    );
    assert.equal(f.stages().at(-1), 'release');
    assert.equal(f.stages().includes('read-durable'), false);
  });
}

test('failure publication evaluates its fence thunk late and retains prepared native binding', async () => {
  const f = fixture();
  const error = new Error('runtime failed');
  f.state.assignment = {
    binding: { id: 'native-binding' },
    nativeSessionTurn: {},
  } as unknown as CurrentAgentRuntimeAssignmentV1;
  f.hooks['execute-async'] = () => {
    throw error;
  };
  f.hooks.failure = () => {
    f.state.exactCancellation = true;
  };
  assert.equal((await f.runAsync()).state, 'failed');
  assert.equal(
    f.failures[0]!.preparedHostAssignmentBinding,
    f.state.assignment.binding,
  );
  assert.ok(f.stages().includes('failure-fenced'));
  assert.ok(f.stages().includes('release-fenced'));
});

for (const terminal of [false, true]) {
  test(`GrantRequired observes durable state freshly and rethrows only when terminal=${terminal}`, () => {
    const f = fixture();
    const error = workflowError(
      'AGENT_RUNTIME_GRANT_REQUIRED',
      'grant',
      ExitCode.verification,
    );
    f.hooks['execute-sync'] = () => {
      f.state.durable = terminal ? f.terminal : f.claim.record;
      throw error;
    };
    if (terminal) {
      assert.throws(f.run, (received) => received === error);
      assert.equal(f.failures.length, 0);
    } else {
      assert.equal(f.run().state, 'failed');
      assert.equal(f.failures[0]!.error, error);
    }
    assert.equal(
      f.stages().filter((name) => name === 'read-durable').length,
      1,
    );
    assert.equal(f.stages().at(-1), 'release');
  });
}

test('sync followup failure enters catch; async followup failure occurs after cleanup and outside failure catch', async () => {
  const error = new Error('followup');
  const f = fixture();
  let calls = 0;
  f.hooks.followups = () => {
    if (++calls === 1) throw error;
  };
  assert.equal(f.run().state, 'failed');
  assert.equal(f.failures[0]!.error, error);
  assert.equal(calls, 2);
  const g = fixture();
  g.hooks.followups = () => {
    throw error;
  };
  await assert.rejects(g.runAsync(), (received) => received === error);
  assert.equal(g.failures.length, 0);
  assert.equal(g.stages().at(-1), 'followups');
  assert.ok(g.stages().includes('watcher-stop'));
});

for (const throwing of ['activity-stop', 'release', 'watcher-stop'] as const) {
  test(`async cleanup failure at ${throwing} preserves finally order and prevents followups`, async () => {
    const f = fixture();
    const error = new Error(throwing);
    f.hooks[throwing] = () => {
      throw error;
    };
    await assert.rejects(f.runAsync(), (received) => received === error);
    assert.equal(f.failures.length, 0);
    assert.equal(f.stages().includes('followups'), false);
    assert.ok(f.stages().includes('release'));
    assert.equal(f.stages().at(-1), 'watcher-stop');
  });
}

test('later cleanup errors override earlier settlements without invoking failure policy again', async () => {
  const f = fixture();
  const activity = new Error('activity');
  const release = new Error('release');
  const watcher = new Error('watcher');
  f.hooks['activity-stop'] = () => {
    throw activity;
  };
  f.hooks.release = () => {
    throw release;
  };
  f.hooks['watcher-stop'] = () => {
    throw watcher;
  };
  await assert.rejects(f.runAsync(), (error) => error === watcher);
  assert.equal(f.failures.length, 0);
});

test('heartbeat start failure keeps the original post-flag catch behavior and does not manufacture cleanup', async () => {
  const f = fixture();
  const error = new Error('heartbeat');
  f.hooks.heartbeat = () => {
    throw error;
  };
  assert.equal((await f.runAsync()).state, 'failed');
  assert.equal(f.failures[0]!.error, error);
  assert.equal(f.stages().includes('release'), false);
  assert.equal(f.stages().includes('watcher-stop'), false);
});

test('unexpected sync object thenable throws after scheduling detached completion without activity monitoring', async () => {
  const f = fixture();
  let resolve!: (report: AgentRuntimeSingleShotReport) => void;
  let markSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  f.runtime.runSingleShot = () =>
    ({
      then(accept: typeof resolve) {
        resolve = accept;
      },
    }) as unknown as AgentRuntimeSingleShotReport;
  f.hooks.followups = () => {
    markSettled();
  };
  assert.throws(f.run, {
    name: 'TypeError',
    message: 'Synchronous provider worker returned a promise.',
  });
  assert.equal(f.stages().includes('release'), false);
  await Promise.resolve();
  resolve(f.report);
  await settled;
  assert.ok(f.stages().includes('complete'));
  assert.ok(f.stages().includes('release'));
  assert.equal(f.stages().includes('heartbeat'), false);
  assert.deepEqual(f.modes, ['synchronous-no-activity']);
});

test('callable thenables retain the synchronous report path', () => {
  const f = fixture();
  const report = Object.assign(() => {}, {
    then() {
      assert.fail('callable thenable must not be assimilated');
    },
  });
  f.runtime.runSingleShot = () =>
    report as unknown as AgentRuntimeSingleShotReport;
  assert.equal(f.run().state, 'succeeded');
  assert.equal(f.completions[0]!.report, report);
  assert.ok(f.stages().indexOf('followups') < f.stages().indexOf('release'));
});

test('runtime precedence, option getters and heartbeat worker identity remain live until their original reads', async () => {
  const f = fixture();
  const reads: string[] = [];
  Object.defineProperty(f.options, 'agentRuntime', {
    get() {
      reads.push('runtime');
      return f.runtime;
    },
  });
  Object.defineProperty(f.options, 'runner', {
    get() {
      assert.fail('selected runtime suppresses runner lookup');
    },
  });
  Object.defineProperty(f.options, 'environment', {
    get() {
      reads.push('environment');
      assert.ok(f.stages().includes('claim'));
      return process.env;
    },
  });
  Object.defineProperty(f.options, 'platform', {
    get() {
      reads.push('platform');
      return process.platform;
    },
  });
  f.hooks['execute-async'] = () => {
    f.claimInput.workerId = 'worker-mutated-at-launch';
  };
  assert.equal((await f.runAsync()).state, 'succeeded');
  assert.deepEqual(reads, ['runtime', 'runtime', 'environment', 'platform']);
  const heartbeat = f.events.find(([name]) => name === 'heartbeat')![1] as {
    workerId: string;
  };
  assert.equal(heartbeat.workerId, 'worker-mutated-at-launch');
  assert.equal(f.inputs[0]!.sourceEnvironment, process.env);
});

test('runner-only injection stays synchronous-only under the async public wrapper', async () => {
  const f = fixture();
  f.options.runner = () => {
    assert.fail('async mode must not call legacy runner');
  };
  assert.equal((await f.runAsync()).state, 'failed');
  const error = f.failures[0]!.error;
  assert.ok(error instanceof WorkflowError);
  assert.equal(error.code, 'AGENT_RUNTIME_ASYNC_UNAVAILABLE');
});

for (const [callback, message] of [
  [
    'onProtocolReceipt',
    'Agent Runtime emitted more than one terminal failure receipt.',
  ],
  [
    'onHostProbeEvidence',
    'Agent Runtime emitted more than one host probe evidence value.',
  ],
  [
    'onHostExecutionBinding',
    'Agent Runtime emitted more than one host execution binding.',
  ],
] as const) {
  test(`${callback} rejects duplicate terminal evidence and retains its first value`, async () => {
    const f = fixture();
    const first = { marker: 'first' };
    f.runtime.runSingleShotAsync = async (_input, options) => {
      const emit = options[callback] as (value: unknown) => void;
      emit(first);
      emit({ marker: 'second' });
      return f.report;
    };
    assert.equal((await f.runAsync()).state, 'failed');
    assert.deepEqual(f.failures[0]!.error, new TypeError(message));
    const observed = f.failures[0]!;
    const value =
      callback === 'onProtocolReceipt'
        ? observed.runtimeFailureProtocolReceipt?.()
        : callback === 'onHostProbeEvidence'
          ? observed.runtimeFailureHostProbeEvidence?.()
          : observed.runtimeFailureHostExecutionBinding?.();
    assert.equal(value, first);
    assert.equal(f.completions.length, 0);
  });
}

test('async report without successful exit becomes failure and never reaches durable completion', async () => {
  const f = fixture();
  f.runtime.runSingleShotAsync = async () => f.report;
  assert.equal((await f.runAsync()).state, 'failed');
  assert.equal(f.completions.length, 0);
  assert.ok(f.failures[0]!.error instanceof TypeError);
  assert.equal(f.failures[0]!.runtimeProgress?.().processState, 'not-started');
});
