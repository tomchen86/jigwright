import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runProviderWorkerTerminalFollowups,
  isRoleAssignmentGrantRequired,
  type ProviderWorkerTerminalEffects,
  type ProviderWorkerTerminalOptions,
} from '../src/application/provider-worker/provider-terminal-followups.ts';
import type { ProviderInvocationRecord } from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';

function fixture(state: 'succeeded' | 'failed' = 'failed') {
  const events: Array<[string, ...unknown[]]> = [];
  // The use case receives admitted terminal facts; it must not mutate them.
  const terminal = Object.freeze({
    invocationId: 'invocation-terminal',
    state,
    revision: 4,
    updatedAt: '2030-08-29T02:00:00.000Z',
  }) as ProviderInvocationRecord;
  const ignored = new Proxy(
    {},
    {
      get() {
        throw new Error('maintenance results must not be inspected');
      },
    },
  );
  const effects: ProviderWorkerTerminalEffects = {
    processProviderFailureRetry(this: unknown, ...args) {
      assert.equal(this, undefined);
      events.push(['retry', ...args]);
      return ignored as ReturnType<
        ProviderWorkerTerminalEffects['processProviderFailureRetry']
      >;
    },
    pumpProviderRetrySchedules(this: unknown, ...args) {
      assert.equal(this, undefined);
      events.push(['pump', ...args]);
      return ignored as ReturnType<
        ProviderWorkerTerminalEffects['pumpProviderRetrySchedules']
      >;
    },
    runEvidenceRetentionMaintenance(this: unknown, ...args) {
      assert.equal(this, undefined);
      events.push(['retention', ...args]);
      return ignored as ReturnType<
        ProviderWorkerTerminalEffects['runEvidenceRetentionMaintenance']
      >;
    },
    recordTerminalWarning(this: unknown, ...args) {
      assert.equal(this, undefined);
      events.push(['warning', ...args]);
    },
    dispatchProviderWorker() {
      assert.fail('the use case must only forward the dispatcher');
    },
    consumedPlanReviewReplay: {
      verify() {
        assert.fail('the use case must only forward replay');
      },
      verifyRoleContextSharing() {
        assert.fail('the use case must only forward replay');
      },
    },
  };
  return { events, terminal, effects, ignored };
}

const runtime = {
  runSingleShot() {
    assert.fail('followups must not execute the injected runtime');
  },
  async runSingleShotAsync() {
    assert.fail('followups must not execute the injected runtime');
  },
};

for (const state of ['failed', 'succeeded'] as const) {
  for (const injection of ['none', 'runtime', 'runner'] as const) {
    for (const enabled of [undefined, false, true]) {
      test(`terminal ${state}, ${injection}, enabled ${String(enabled)}`, () => {
        const f = fixture(state);
        const options: ProviderWorkerTerminalOptions = {
          ...(injection === 'runtime' ? { agentRuntime: runtime } : {}),
          ...(injection === 'runner' ? { runner: runtime.runSingleShot } : {}),
          ...(enabled === undefined
            ? {}
            : {
                automaticRetry: { enabled },
                schedulePump: { enabled },
              }),
        };
        assert.equal(
          runProviderWorkerTerminalFollowups(
            f.effects,
            '/repo',
            f.terminal,
            options,
          ),
          undefined,
        );
        const enabledTrace =
          state === 'failed'
            ? ['retry', 'pump', 'retention']
            : ['pump', 'retention'];
        assert.deepEqual(
          f.events.map(([stage]) => stage),
          enabled === true || (enabled === undefined && injection === 'none')
            ? enabledTrace
            : ['retention'],
        );
      });
    }
  }
}

test('default arguments omit absent overrides and preserve terminal/replay identity', () => {
  const f = fixture();
  const snapshot = { ...f.terminal };
  runProviderWorkerTerminalFollowups(f.effects, '/repo', f.terminal, {});
  assert.deepEqual(f.events, [
    [
      'retry',
      '/repo',
      f.terminal.invocationId,
      {
        dispatcher: f.effects.dispatchProviderWorker,
        consumedRoleResultReplay: f.effects.consumedPlanReviewReplay,
      },
    ],
    [
      'pump',
      '/repo',
      { limit: 10, dispatcher: f.effects.dispatchProviderWorker },
    ],
    ['retention', '/repo', { limit: 10 }],
  ]);
  const retryOptions = f.events[0]?.[3] as Parameters<
    ProviderWorkerTerminalEffects['processProviderFailureRetry']
  >[2];
  assert.equal(
    retryOptions?.consumedRoleResultReplay,
    f.effects.consumedPlanReviewReplay,
  );
  assert.deepEqual(f.terminal, snapshot);
});

test('forwards exact overrides, zero pump limit and bare retention callback', () => {
  const f = fixture();
  const dispatch = () => assert.fail('dispatcher must be passed unchanged');
  const probe = () => assert.fail('probe must be passed unchanged');
  const fault = () => assert.fail('fault injector must be passed unchanged');
  const options: ProviderWorkerTerminalOptions = {
    runner: runtime.runSingleShot,
    automaticRetry: { enabled: true, now: 'retry-now', dispatcher: dispatch },
    schedulePump: {
      enabled: true,
      limit: 0,
      now: 'pump-now',
      dispatcher: dispatch,
      probeExecutor: probe,
      faultInjector: fault,
    },
    retentionNow: 'retention-now',
    retentionMaintenance(this: unknown, ...args) {
      assert.equal(this, undefined);
      f.events.push(['override-retention', ...args]);
      return f.ignored as ReturnType<
        ProviderWorkerTerminalEffects['runEvidenceRetentionMaintenance']
      >;
    },
  };
  runProviderWorkerTerminalFollowups(f.effects, '/repo', f.terminal, options);
  assert.deepEqual(f.events, [
    [
      'retry',
      '/repo',
      f.terminal.invocationId,
      {
        now: 'retry-now',
        dispatcher: dispatch,
        consumedRoleResultReplay: f.effects.consumedPlanReviewReplay,
      },
    ],
    [
      'pump',
      '/repo',
      {
        limit: 0,
        now: 'pump-now',
        dispatcher: dispatch,
        probeExecutor: probe,
        faultInjector: fault,
      },
    ],
    ['override-retention', '/repo', { limit: 10, now: 'retention-now' }],
  ]);
});

test('own undefined overrides are omitted while gates remain independent', () => {
  const f = fixture();
  runProviderWorkerTerminalFollowups(f.effects, '/repo', f.terminal, {
    automaticRetry: { enabled: false, now: undefined, dispatcher: undefined },
    schedulePump: {
      enabled: true,
      limit: undefined,
      now: undefined,
      dispatcher: undefined,
      probeExecutor: undefined,
      faultInjector: undefined,
    },
    retentionNow: undefined,
    retentionMaintenance: undefined,
  });
  assert.deepEqual(f.events, [
    [
      'pump',
      '/repo',
      { limit: 10, dispatcher: f.effects.dispatchProviderWorker },
    ],
    ['retention', '/repo', { limit: 10 }],
  ]);
});

test('each stage observes the original options after prior effects and warnings', () => {
  const f = fixture();
  const retryError = new Error('retry');
  const pumpError = new Error('pump');
  const options: ProviderWorkerTerminalOptions = {
    schedulePump: { enabled: false },
  };
  const retry = () => {
    f.events.push(['retry']);
    options.agentRuntime = runtime;
    options.schedulePump = {};
    throw retryError;
  };
  runProviderWorkerTerminalFollowups(
    {
      ...f.effects,
      processProviderFailureRetry: retry,
      pumpProviderRetrySchedules(_cwd, input) {
        f.events.push(['pump', input.now]);
        options.retentionNow = 'too-early';
        throw pumpError;
      },
      recordTerminalWarning(cwd, terminal, operation, error) {
        assert.equal(cwd, '/repo');
        assert.equal(terminal, f.terminal);
        f.events.push(['warning', operation]);
        if (operation === 'automatic-retry') {
          assert.equal(error, retryError);
          // The pump's default must see the runtime injection removed by warning.
          delete options.agentRuntime;
          options.schedulePump = { now: 'after-retry-warning' };
        } else {
          assert.equal(error, pumpError);
          options.retentionNow = 'after-pump-warning';
          options.retentionMaintenance = function (this: unknown, _cwd, input) {
            assert.equal(this, undefined);
            f.events.push(['override-retention', input.now]);
            return f.ignored as ReturnType<
              ProviderWorkerTerminalEffects['runEvidenceRetentionMaintenance']
            >;
          };
        }
      },
    },
    '/repo',
    f.terminal,
    options,
  );
  assert.deepEqual(f.events, [
    ['retry'],
    ['warning', 'automatic-retry'],
    ['pump', 'after-retry-warning'],
    ['warning', 'retry-schedule-pump'],
    ['override-retention', 'after-pump-warning'],
  ]);
});

test('retry mutation can suppress the later pump default', () => {
  const f = fixture();
  const options: ProviderWorkerTerminalOptions = {};
  runProviderWorkerTerminalFollowups(
    {
      ...f.effects,
      processProviderFailureRetry() {
        options.runner = runtime.runSingleShot;
        return { kind: 'not-retryable', jobId: 'job', reasonCode: 'STOP' };
      },
    },
    '/repo',
    f.terminal,
    options,
  );
  assert.deepEqual(f.events, [['retention', '/repo', { limit: 10 }]]);
});

test('succeeded records and explicit gates avoid unrelated default getters', () => {
  const f = fixture('succeeded');
  runProviderWorkerTerminalFollowups(f.effects, '/repo', f.terminal, {
    get automaticRetry(): never {
      return assert.fail('success must short-circuit retry options');
    },
    get agentRuntime(): never {
      return assert.fail('explicit pump gate must not read runtime');
    },
    get runner(): never {
      return assert.fail('explicit pump gate must not read runner');
    },
    schedulePump: { enabled: true },
  });
  assert.deepEqual(
    f.events.map(([stage]) => stage),
    ['pump', 'retention'],
  );
});

for (const stage of ['retry', 'pump'] as const) {
  test(`${stage} enabled getter throws outside the maintenance catch`, () => {
    const f = fixture();
    const sentinel = new Error('enabled getter');
    const options: ProviderWorkerTerminalOptions =
      stage === 'retry'
        ? {
            automaticRetry: {
              get enabled(): never {
                throw sentinel;
              },
            },
          }
        : {
            automaticRetry: { enabled: false },
            schedulePump: {
              get enabled(): never {
                throw sentinel;
              },
            },
          };
    assert.throws(
      () =>
        runProviderWorkerTerminalFollowups(
          f.effects,
          '/repo',
          f.terminal,
          options,
        ),
      (error) => error === sentinel,
    );
    assert.equal(f.events.length, 0);
  });
}

test('argument getter failures warn within their stage and continue', () => {
  const f = fixture();
  const retry = new Error('retry now');
  const pump = new Error('pump limit');
  const retention = new Error('retention selection');
  runProviderWorkerTerminalFollowups(f.effects, '/repo', f.terminal, {
    automaticRetry: {
      get now(): never {
        throw retry;
      },
    },
    schedulePump: {
      get limit(): never {
        throw pump;
      },
    },
    get retentionMaintenance(): never {
      throw retention;
    },
  });
  assert.deepEqual(f.events, [
    ['warning', '/repo', f.terminal, 'automatic-retry', retry],
    ['warning', '/repo', f.terminal, 'retry-schedule-pump', pump],
    ['warning', '/repo', f.terminal, 'retention-maintenance', retention],
  ]);
});

test('defined override properties are read at the original stage and count', () => {
  const f = fixture();
  const reads: string[] = [];
  const probe = () => assert.fail('forward only');
  const fault = () => assert.fail('forward only');
  runProviderWorkerTerminalFollowups(
    {
      ...f.effects,
      processProviderFailureRetry() {
        reads.push('retry');
        return { kind: 'not-retryable', jobId: 'job', reasonCode: 'STOP' };
      },
      pumpProviderRetrySchedules() {
        reads.push('pump');
        return f.ignored as ReturnType<
          ProviderWorkerTerminalEffects['pumpProviderRetrySchedules']
        >;
      },
      runEvidenceRetentionMaintenance() {
        reads.push('retention');
        return f.ignored as ReturnType<
          ProviderWorkerTerminalEffects['runEvidenceRetentionMaintenance']
        >;
      },
    },
    '/repo',
    f.terminal,
    {
      automaticRetry: {
        get now() {
          reads.push('retry.now');
          return 'retry-now';
        },
      },
      schedulePump: {
        get now() {
          reads.push('pump.now');
          return 'pump-now';
        },
        get probeExecutor() {
          reads.push('probe');
          return probe;
        },
        get faultInjector() {
          reads.push('fault');
          return fault;
        },
      },
      get retentionNow() {
        reads.push('retention.now');
        return 'retention-now';
      },
    },
  );
  assert.deepEqual(reads, [
    'retry.now',
    'retry.now',
    'retry',
    'pump.now',
    'pump.now',
    'probe',
    'probe',
    'fault',
    'fault',
    'pump',
    'retention.now',
    'retention.now',
    'retention',
  ]);
});

for (const stage of ['retry', 'pump', 'retention'] as const) {
  for (const exactGrant of [false, true]) {
    test(`${stage} ${exactGrant ? 'real Grant' : 'lookalike code'} follows its own error policy`, () => {
      const f = fixture();
      const sentinel = exactGrant
        ? workflowError(
            'AGENT_RUNTIME_GRANT_REQUIRED',
            'grant',
            ExitCode.verification,
          )
        : Object.assign(new Error('not a WorkflowError'), {
            code: 'AGENT_RUNTIME_GRANT_REQUIRED',
          });
      const key = {
        retry: 'processProviderFailureRetry',
        pump: 'pumpProviderRetrySchedules',
        retention: 'runEvidenceRetentionMaintenance',
      }[stage];
      const effects = {
        ...f.effects,
        [key]() {
          throw sentinel;
        },
      };
      const invoke = () =>
        runProviderWorkerTerminalFollowups(effects, '/repo', f.terminal, {});
      if (exactGrant && stage !== 'retention') {
        assert.throws(invoke, (error) => error === sentinel);
        assert.deepEqual(
          f.events.map(([name]) => name),
          stage === 'retry' ? [] : ['retry'],
        );
      } else {
        invoke();
        const warning = f.events.find(([name]) => name === 'warning');
        assert.deepEqual(warning, [
          'warning',
          '/repo',
          f.terminal,
          {
            retry: 'automatic-retry',
            pump: 'retry-schedule-pump',
            retention: 'retention-maintenance',
          }[stage],
          sentinel,
        ]);
        assert.deepEqual(
          f.events.map(([name]) => name),
          {
            retry: ['warning', 'pump', 'retention'],
            pump: ['retry', 'warning', 'retention'],
            retention: ['retry', 'pump', 'warning'],
          }[stage],
        );
      }
    });
  }
}

test('non-Grant WorkflowError is warned and the shared predicate is exact', () => {
  const f = fixture();
  const error = workflowError(
    'MAINTENANCE_FAILED',
    'failure',
    ExitCode.verification,
  );
  assert.equal(isRoleAssignmentGrantRequired(error), false);
  assert.equal(isRoleAssignmentGrantRequired(null), false);
  assert.equal(
    isRoleAssignmentGrantRequired({ code: 'AGENT_RUNTIME_GRANT_REQUIRED' }),
    false,
  );
  runProviderWorkerTerminalFollowups(
    {
      ...f.effects,
      processProviderFailureRetry() {
        throw error;
      },
    },
    '/repo',
    f.terminal,
    {},
  );
  assert.deepEqual(f.events[0], [
    'warning',
    '/repo',
    f.terminal,
    'automatic-retry',
    error,
  ]);
  assert.deepEqual(
    f.events.map(([stage]) => stage),
    ['warning', 'pump', 'retention'],
  );
});

test('warning reporter errors escape immediately without another warning', () => {
  const f = fixture();
  const failure = new Error('retry');
  const warningFailure = new Error('warning');
  assert.throws(
    () =>
      runProviderWorkerTerminalFollowups(
        {
          ...f.effects,
          processProviderFailureRetry() {
            throw failure;
          },
          recordTerminalWarning(
            this: unknown,
            _cwd,
            terminal,
            operation,
            error,
          ) {
            assert.equal(this, undefined);
            assert.equal(terminal, f.terminal);
            assert.equal(operation, 'automatic-retry');
            assert.equal(error, failure);
            throw warningFailure;
          },
        },
        '/repo',
        f.terminal,
        {},
      ),
    (error) => error === warningFailure,
  );
  assert.equal(f.events.length, 0);
});

test('a returned grant-required result is ignored without reading its payload', () => {
  const f = fixture();
  runProviderWorkerTerminalFollowups(
    {
      ...f.effects,
      processProviderFailureRetry() {
        return {
          kind: 'grant-required',
          jobId: 'job',
          get grantRequest(): never {
            return assert.fail('returned GrantRequest is opaque to followups');
          },
        };
      },
    },
    '/repo',
    f.terminal,
    {},
  );
  assert.deepEqual(
    f.events.map(([stage]) => stage),
    ['pump', 'retention'],
  );
});
