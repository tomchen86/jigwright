import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitProviderWorkerReplay,
  type ProviderWorkerReplayEffects,
} from '../src/application/provider-worker/provider-worker-replay.ts';
import type { ProviderWorkerTerminalOptions } from '../src/application/provider-worker/provider-terminal-followups.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';
import type { TaskMandateBinding } from '../src/modules/authority/task-mandate-contract.ts';
import type { ProviderInvocationRecord } from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';

type Owner = ReturnType<
  ProviderWorkerReplayEffects['assertTaskDiffReviewProviderOwnerCurrent']
>;

function fixture(
  state: ProviderInvocationRecord['state'] = 'prepared',
  purpose: 'survey' | 'task-diff-review' = 'survey',
) {
  const events: Array<[string, ...unknown[]]> = [];
  const hooks: Record<string, (() => void) | undefined> = {};
  const step = (stage: string, ...args: unknown[]) => {
    events.push([stage, ...args]);
    hooks[stage]?.();
  };
  const binding: TaskMandateBinding = {
    schemaVersion: 1,
    mandateTaskId: 'task-replay',
    mandateId: '592f65ab-1941-429e-a2c8-c76d361063fb',
    mandateDigest: 'a'.repeat(64),
    changeId: 'replay-change',
    externalAuditRoot: '/outside/authority-audit',
  };
  const initial: ProviderInvocationRecord = {
    schemaVersion: 1,
    invocationId: 'invocation-observed',
    investigationId: 'investigation-replay',
    changeId: binding.changeId,
    mandateBinding: binding,
    attempt: 1,
    revision: 2,
    state,
    providerId: 'codex',
    purpose,
    requestDigest: 'b'.repeat(64),
    manifestDigest: 'c'.repeat(64),
    leaseGeneration: 1,
    lease: null,
    result: null,
    failure:
      state === 'failed'
        ? {
            kind: 'retryable',
            code: 'ORIGINAL_FAILURE',
            message: 'Original reason.',
          }
        : null,
    createdAt: '2030-01-02T03:04:05.000Z',
    updatedAt: '2030-01-02T03:04:06.000Z',
  };
  const request = {
    invocationId: initial.invocationId,
    purpose,
  } as ProviderInvocationRequest;
  // Owner verification is its own effect. Keep full-contract references here;
  // the replay use case consumes only the already admitted owner facts.
  const firstOwner = {
    sessionId: 'session-replay',
    changeId: initial.changeId,
    mandateBinding: binding,
  } as Owner;
  const freshOwner = {
    sessionId: 'session-replay',
    changeId: initial.changeId,
    mandateBinding: { ...binding },
  } as Owner;
  const recovered: ProviderInvocationRecord = {
    ...initial,
    state: 'succeeded',
    revision: 3,
  };
  const settings: {
    native: ProviderInvocationRecord | null | undefined;
    candidate: boolean;
    locked: boolean;
    recoveries: 'ordinary' | 'held' | null;
  } = { native: null, candidate: false, locked: false, recoveries: null };
  const options: ProviderWorkerTerminalOptions = {};
  let assertions = 0;
  const assertOwned = function (this: unknown) {
    assert.equal(this, undefined);
    assert.equal(settings.locked, true);
    step(`assert-${++assertions}`);
  };
  const recovery = {
    get record() {
      assert.equal(settings.locked, settings.recoveries === 'held');
      step('recovered-record', recovered);
      return recovered;
    },
    repaired: true,
    candidateDigest: 'd'.repeat(64),
  };
  let ownerReads = 0;
  const effects: ProviderWorkerReplayEffects = {
    recoverNativeContinuation(this: unknown, id) {
      assert.equal(this, undefined);
      assert.equal(id, 'invocation-requested');
      step('native', id);
      // An undefined fake also verifies the original nullish fallback semantics.
      return settings.native as ProviderInvocationRecord | null;
    },
    readInvocation(this: unknown, id) {
      assert.equal(this, undefined);
      assert.equal(id, 'invocation-requested');
      step('strict', id);
      return initial;
    },
    readRequest(this: unknown, record) {
      assert.equal(this, undefined);
      assert.equal(record, settings.native ?? initial);
      step('request', record);
      return request;
    },
    completionCandidateExists(this: unknown, record) {
      assert.equal(this, undefined);
      assert.equal(record, settings.native ?? initial);
      step('candidate', record);
      return settings.candidate;
    },
    recoverCompletion(this: unknown, record) {
      assert.equal(this, undefined);
      assert.equal(record, settings.native ?? initial);
      assert.equal(settings.locked, false);
      settings.recoveries = 'ordinary';
      step('ordinary-recovery', record);
      return recovery;
    },
    recoverCompletionUnderLifecycleLock(this: unknown, record, held) {
      assert.equal(this, undefined);
      assert.equal(record, settings.native ?? initial);
      assert.equal(held, assertOwned);
      assert.equal(settings.locked, true);
      settings.recoveries = 'held';
      step('held-recovery', record, held);
      return recovery;
    },
    assertTaskDiffReviewProviderOwnerCurrent(
      this: unknown,
      cwd,
      id,
      validation,
    ) {
      assert.equal(this, undefined);
      assert.equal(cwd, '/repo');
      assert.equal(
        validation?.consumedRoleResultReplay,
        effects.consumedRoleResultReplay,
      );
      const index = ++ownerReads;
      step(`owner-${index}`, cwd, id, validation);
      return index === 1 ? firstOwner : freshOwner;
    },
    withTaskDiffReviewProviderLifecycleOperation(
      this: unknown,
      cwd,
      sessionId,
      operation,
    ) {
      assert.equal(this, undefined);
      step('lock', cwd, sessionId);
      settings.locked = true;
      const result = operation(assertOwned);
      step('unlock', result);
      settings.locked = false;
      return result;
    },
    taskMandate: {
      assertActiveTaskMandateBindingUnderLifecycleLock(cwd, received, held) {
        assert.equal(this, effects.taskMandate);
        assert.equal(received, initial.mandateBinding);
        assert.equal(held, assertOwned);
        assert.equal(settings.locked, true);
        step('mandate', cwd, received, held);
        // Its result must not replace the original binding or record.
        return { ...binding, mandateDigest: 'ignored-return' };
      },
    },
    consumedRoleResultReplay: {
      verify() {
        assert.fail('only the owner service may verify replay');
      },
    },
    runTerminalFollowups(this: unknown, cwd, record, receivedOptions) {
      assert.equal(this, undefined);
      assert.equal(cwd, '/repo');
      assert.equal(receivedOptions, options);
      assert.equal(settings.locked, false);
      step('followups', cwd, record, receivedOptions);
    },
  };
  return {
    initial,
    request,
    firstOwner,
    freshOwner,
    recovered,
    recovery,
    binding,
    settings,
    options,
    effects,
    assertOwned,
    events,
    hooks,
    stages: () => events.map(([stage]) => stage),
    run: () =>
      admitProviderWorkerReplay(
        effects,
        '/repo',
        'invocation-requested',
        options,
      ),
  };
}

for (const purpose of ['survey', 'task-diff-review'] as const) {
  for (const state of ['prepared', 'leased', 'succeeded', 'failed'] as const) {
    test(`${purpose} ${state}: keep the exact state-specific admission path`, () => {
      const f = fixture(state, purpose);
      const result = f.run();
      assert.deepEqual(f.stages(), [
        'native',
        'strict',
        'request',
        ...(purpose === 'task-diff-review' &&
        (state === 'prepared' || state === 'leased')
          ? ['owner-1']
          : []),
        ...(state === 'leased' ? ['candidate'] : []),
        ...(state === 'succeeded' || state === 'failed' ? ['followups'] : []),
      ]);
      if (state === 'prepared') {
        assert.equal(result.kind, 'prepared');
        if (result.kind !== 'prepared')
          assert.fail('expected prepared handoff');
        assert.equal(result.initial, f.initial);
        assert.equal(result.request, f.request);
        assert.equal(
          result.taskDiffReviewOwner,
          purpose === 'task-diff-review' ? f.firstOwner : null,
        );
      } else {
        assert.equal(result.kind, 'replay');
        if (result.kind !== 'replay') assert.fail('expected replay');
        assert.equal(result.record, f.initial);
        assert.equal(result.record.failure, f.initial.failure);
      }
    });
  }
}

for (const state of ['prepared', 'leased', 'succeeded', 'failed'] as const) {
  test(`native ${state} result bypasses strict fallback but retains the explicit request read`, () => {
    const f = fixture(state);
    const native = { ...f.initial, invocationId: 'native-record' };
    f.settings.native = native;
    f.hooks.strict = () => {
      throw new Error('strict fallback must not run after native recovery');
    };
    const result = f.run();
    assert.deepEqual(f.stages(), [
      'native',
      'request',
      ...(state === 'leased' ? ['candidate'] : []),
      ...(state === 'succeeded' || state === 'failed' ? ['followups'] : []),
    ]);
    assert.equal(
      result.kind === 'prepared' ? result.initial : result.record,
      native,
    );
    assert.equal(f.events[1]?.[1], native);
  });
}

test('undefined native result preserves nullish strict fallback', () => {
  const f = fixture();
  f.settings.native = undefined;
  f.run();
  assert.deepEqual(f.stages(), ['native', 'strict', 'request']);
});

for (const purpose of ['survey', 'task-diff-review'] as const) {
  test(`${purpose} accepted candidate recovers before terminal followups`, () => {
    const f = fixture('leased', purpose);
    f.settings.candidate = true;
    const result = f.run();
    assert.deepEqual(
      f.stages(),
      purpose === 'survey'
        ? [
            'native',
            'strict',
            'request',
            'candidate',
            'ordinary-recovery',
            'recovered-record',
            'followups',
          ]
        : [
            'native',
            'strict',
            'request',
            'owner-1',
            'candidate',
            'lock',
            'assert-1',
            'owner-2',
            'mandate',
            'assert-2',
            'held-recovery',
            'recovered-record',
            'unlock',
            'followups',
          ],
    );
    assert.equal(result.kind, 'replay');
    if (result.kind !== 'replay') assert.fail('expected recovered replay');
    assert.equal(result.record, f.recovered);
    assert.equal(f.events.at(-1)?.[2], f.recovered);
    assert.equal(f.events.at(-1)?.[3], f.options);
    if (purpose === 'task-diff-review') {
      assert.deepEqual(
        f.events.find(([stage]) => stage === 'lock'),
        ['lock', '/repo', 'session-replay'],
      );
      assert.equal(
        f.events.find(([stage]) => stage === 'unlock')?.[1],
        f.recovered,
      );
    }
  });
}

test('prepared recovery handoff retains pre-recovery request and first full owner references', () => {
  const f = fixture('leased', 'task-diff-review');
  f.settings.candidate = true;
  f.recovered.state = 'prepared';
  f.recovered.invocationId = 'different-recovered-identity';
  const result = f.run();
  assert.equal(result.kind, 'prepared');
  if (result.kind !== 'prepared') assert.fail('expected prepared handoff');
  assert.equal(result.initial, f.recovered);
  assert.equal(result.request, f.request);
  assert.equal(result.taskDiffReviewOwner, f.firstOwner);
  assert.notEqual(result.taskDiffReviewOwner, f.freshOwner);
  assert.equal(f.stages().filter((stage) => stage === 'request').length, 1);
  assert.equal(f.stages().includes('followups'), false);
});

test('recovery session is captured before lock while record identity and revision remain live', () => {
  const f = fixture('leased', 'task-diff-review');
  f.settings.candidate = true;
  f.hooks.lock = () => {
    Object.defineProperty(f.firstOwner, 'sessionId', {
      value: 'mutated-first-session',
    });
    f.initial.invocationId = 'identity-after-lock';
  };
  f.hooks['owner-2'] = () => {
    f.initial.revision = 91;
  };
  f.hooks['held-recovery'] = () => {
    assert.equal(f.initial.invocationId, 'identity-after-lock');
    assert.equal(f.initial.revision, 91);
  };
  f.run();
  assert.deepEqual(
    f.events.find(([stage]) => stage === 'lock'),
    ['lock', '/repo', 'session-replay'],
  );
  assert.equal(
    f.events.find(([stage]) => stage === 'owner-1')?.[2],
    'invocation-observed',
  );
  assert.equal(
    f.events.find(([stage]) => stage === 'owner-2')?.[2],
    'identity-after-lock',
  );
  assert.equal(
    f.events.find(([stage]) => stage === 'held-recovery')?.[1],
    f.initial,
  );
});

for (const binding of [undefined, null, false] as const) {
  test(`TaskDiff mandate guard keeps explicit nullish semantics: ${String(binding)}`, () => {
    const f = fixture('leased', 'task-diff-review');
    f.settings.candidate = true;
    Object.defineProperty(f.initial, 'mandateBinding', { value: binding });
    Object.defineProperty(f.freshOwner, 'mandateBinding', { value: binding });
    f.run();
    assert.deepEqual(f.stages(), [
      'native',
      'strict',
      'request',
      'owner-1',
      'candidate',
      'lock',
      'assert-1',
      'owner-2',
      ...(binding === false ? ['mandate'] : []),
      'assert-2',
      'held-recovery',
      'recovered-record',
      'unlock',
      'followups',
    ]);
  });
}

test('TaskDiff comparison normalizes absent/null bindings and canonical key order', () => {
  for (const bindings of [
    [undefined, null],
    [null, undefined],
    ['canonical', 'canonical'],
  ] as const) {
    const f = fixture('leased', 'task-diff-review');
    f.settings.candidate = true;
    Object.defineProperty(f.initial, 'mandateBinding', {
      value: bindings[0] === 'canonical' ? f.binding : bindings[0],
    });
    Object.defineProperty(f.freshOwner, 'mandateBinding', {
      value:
        bindings[1] === 'canonical'
          ? Object.fromEntries(Object.entries(f.binding).reverse())
          : bindings[1],
    });
    f.run();
    assert.ok(f.stages().includes('held-recovery'));
  }
});

function stale(error: unknown) {
  assert.ok(error instanceof WorkflowError);
  assert.equal(error.code, 'TASK_MANDATE_BINDING_STALE');
  assert.equal(
    error.message,
    'TaskDiffReview provider invocation no longer matches its exact durable owner.',
  );
  assert.equal(error.exitCode, ExitCode.staleState);
  return true;
}
for (const mismatch of ['session', 'change', 'binding'] as const) {
  test(`fresh TaskDiff ${mismatch} mismatch short circuits before mandate/recovery`, () => {
    const f = fixture('leased', 'task-diff-review');
    f.settings.candidate = true;
    if (mismatch === 'session') {
      Object.defineProperty(f.freshOwner, 'sessionId', { value: 'wrong' });
      Object.defineProperty(f.freshOwner, 'changeId', {
        get(): never {
          throw new Error('must short circuit before changeId');
        },
      });
    } else if (mismatch === 'change') {
      Object.defineProperty(f.freshOwner, 'changeId', { value: 'wrong' });
      Object.defineProperty(f.freshOwner, 'mandateBinding', {
        get(): never {
          throw new Error('must short circuit before binding');
        },
      });
    } else {
      Object.defineProperty(f.freshOwner, 'mandateBinding', {
        value: { ...f.binding, mandateDigest: 'wrong' },
      });
    }
    assert.throws(f.run, stale);
    assert.deepEqual(f.stages(), [
      'native',
      'strict',
      'request',
      'owner-1',
      'candidate',
      'lock',
      'assert-1',
      'owner-2',
    ]);
  });
}

test('canonical owner binding failure propagates before reading invocation binding', () => {
  const f = fixture('leased', 'task-diff-review');
  f.settings.candidate = true;
  Object.defineProperty(f.freshOwner, 'mandateBinding', { value: new Date() });
  Object.defineProperty(f.initial, 'mandateBinding', {
    get(): never {
      throw new Error('invocation comparison must not run');
    },
  });
  assert.throws(
    f.run,
    (error) =>
      error instanceof WorkflowError && error.code === 'CANONICAL_JSON_INVALID',
  );
  assert.equal(f.stages().at(-1), 'owner-2');
});

for (const state of ['succeeded', 'failed'] as const) {
  test(`${state} followups mutations keep the already selected replay decision and original references`, () => {
    const f = fixture(state, 'task-diff-review');
    const failure = {
      kind: 'retryable' as const,
      code: 'AFTER_FOLLOWUPS',
      message: 'Observed late.',
    };
    f.hooks.followups = () => {
      f.initial.state = 'prepared';
      f.initial.revision = 77;
      f.initial.failure = failure;
      f.options.retentionNow = '2030-02-01T00:00:00.000Z';
    };
    const result = f.run();
    assert.equal(result.kind, 'replay');
    if (result.kind !== 'replay')
      assert.fail('must not revisit prepared admission');
    assert.equal(result.record, f.initial);
    assert.equal(result.record.state, 'prepared');
    assert.equal(result.record.failure, failure);
    assert.equal(result.record.revision, 77);
    assert.equal(f.options.retentionNow, '2030-02-01T00:00:00.000Z');
    assert.deepEqual(f.stages(), ['native', 'strict', 'request', 'followups']);
  });
}

test('prepared and leased decisions never inspect terminal options', () => {
  for (const state of ['prepared', 'leased'] as const) {
    const f = fixture(state);
    Object.defineProperty(f.options, 'automaticRetry', {
      get(): never {
        throw new Error('terminal options were read');
      },
    });
    f.run();
    assert.equal(f.stages().includes('followups'), false);
  }
});

test('native and state guards retain the original getter read ordering', () => {
  const f = fixture('prepared', 'task-diff-review');
  Object.defineProperty(f.request, 'purpose', {
    get() {
      f.events.push(['purpose']);
      return 'task-diff-review';
    },
  });
  Object.defineProperty(f.initial, 'state', {
    get() {
      f.events.push(['state']);
      return 'prepared';
    },
  });
  Object.defineProperty(f.initial, 'invocationId', {
    get() {
      f.events.push(['id']);
      return 'id-observed-now';
    },
  });
  f.run();
  assert.deepEqual(f.stages(), [
    'native',
    'strict',
    'request',
    'purpose',
    'state',
    'state',
    'id',
    'owner-1',
    'state',
    'state',
  ]);
});

const ordinaryFailureCases: Array<
  [ProviderInvocationRecord['state'], string, string[]]
> = [
  ['prepared', 'native', ['native']],
  ['prepared', 'strict', ['native', 'strict']],
  ['prepared', 'request', ['native', 'strict', 'request']],
  ['leased', 'candidate', ['native', 'strict', 'request', 'candidate']],
  [
    'leased',
    'ordinary-recovery',
    ['native', 'strict', 'request', 'candidate', 'ordinary-recovery'],
  ],
  [
    'leased',
    'recovered-record',
    [
      'native',
      'strict',
      'request',
      'candidate',
      'ordinary-recovery',
      'recovered-record',
    ],
  ],
  ['succeeded', 'followups', ['native', 'strict', 'request', 'followups']],
];
for (const [state, stage, expected] of ordinaryFailureCases) {
  test(`${stage} error escapes ordinary replay without later actions`, () => {
    const f = fixture(state);
    f.settings.candidate = true;
    const failure =
      stage === 'followups'
        ? workflowError(
            'AGENT_RUNTIME_GRANT_REQUIRED',
            'Original Grant pause.',
            ExitCode.guard,
          )
        : Object.freeze({ failedAt: stage });
    f.hooks[stage] = () => {
      throw failure;
    };
    assert.throws(f.run, (error) => error === failure);
    assert.deepEqual(f.stages(), expected);
  });
}

const heldStages = [
  'native',
  'strict',
  'request',
  'owner-1',
  'candidate',
  'lock',
  'assert-1',
  'owner-2',
  'mandate',
  'assert-2',
  'held-recovery',
  'recovered-record',
  'unlock',
  'followups',
];
for (const stage of [
  'owner-1',
  'lock',
  'assert-1',
  'owner-2',
  'mandate',
  'assert-2',
  'held-recovery',
  'recovered-record',
  'unlock',
  'followups',
]) {
  test(`${stage} error escapes TaskDiff replay with no extra assertion or compensation`, () => {
    const f = fixture('leased', 'task-diff-review');
    f.settings.candidate = true;
    const failure = Object.freeze({ failedAt: stage });
    f.hooks[stage] = () => {
      throw failure;
    };
    assert.throws(f.run, (error) => error === failure);
    assert.deepEqual(
      f.stages(),
      heldStages.slice(0, heldStages.indexOf(stage) + 1),
    );
  });
}
