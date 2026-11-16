import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimProviderWorker,
  type ProviderWorkerClaimEffects,
  type ProviderWorkerClaimObservation,
  type ProviderWorkerClaimOptions,
} from '../src/application/provider-worker/provider-worker-claim.ts';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import type { TaskMandateBinding } from '../src/modules/authority/task-mandate-contract.ts';
import {
  PROPOSE_EXEMPTION_SESSION_PREFIX,
  isProposeExemptionInvestigationId,
} from '../src/modules/investigation/domain/investigation-store-values.ts';
import type { ProviderInvocationRecord } from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import type { ProviderWorkerClaimInput } from '../src/modules/provider-orchestration/provider-invocation-lifecycle.ts';

type Route = 'review' | 'implementation' | 'exemption' | 'investigation';

function fixture(route: Route = 'investigation', mandated = true) {
  const events: Array<[string, ...unknown[]]> = [];
  const hooks: Record<string, (() => void) | undefined> = {};
  const visit = (stage: string, ...args: unknown[]) => {
    events.push([stage, ...args]);
    hooks[stage]?.();
  };
  const binding: TaskMandateBinding = {
    schemaVersion: 1,
    mandateTaskId: 'task-worker',
    mandateId: 'b4b042d4-74aa-4acd-90b0-ed80066d8588',
    mandateDigest: 'a'.repeat(64),
    changeId: 'worker-change',
    externalAuditRoot: '/outside/authority-audit',
  };
  const activeBinding = { ...binding };
  const initial: ProviderInvocationRecord = {
    schemaVersion: 1,
    invocationId: 'invocation-one',
    investigationId:
      route === 'exemption'
        ? `investigation-exemption-${'e'.repeat(64)}`
        : 'investigation-one',
    changeId: binding.changeId,
    ...(mandated ? { mandateBinding: binding } : {}),
    attempt: 1,
    revision: 7,
    state: 'prepared',
    providerId: 'codex',
    purpose: 'survey',
    requestDigest: 'b'.repeat(64),
    manifestDigest: 'c'.repeat(64),
    leaseGeneration: 0,
    lease: null,
    result: null,
    failure: null,
    createdAt: '2030-01-02T03:04:05.000Z',
    updatedAt: '2030-01-02T03:04:06.000Z',
  };
  // Only these request/owner facts participate in claim admission. The use case
  // receives the original full contract objects, not revalidated projections.
  const request = {
    providerId: 'codex',
    requestDigest: initial.requestDigest,
    limits: { timeoutMs: 12_345 },
  } as ProviderWorkerClaimObservation['request'];
  const reviewOwner = {
    sessionId: 'review-session',
    changeId: 'cached-owner-is-not-current',
  } as NonNullable<ProviderWorkerClaimObservation['taskDiffReviewOwner']>;
  const implementationOwner = {
    changeId: 'cached-owner-is-not-current',
  } as NonNullable<
    ProviderWorkerClaimObservation['taskStrategyImplementationOwner']
  >;
  const observation: ProviderWorkerClaimObservation = {
    initial,
    request,
    taskDiffReviewOwner: route === 'review' ? reviewOwner : null,
    taskStrategyImplementationOwner:
      route === 'implementation' ? implementationOwner : null,
  };
  const currentOwner = {
    changeId: initial.changeId,
    mandateBinding: { ...binding },
  };
  const lease = {
    record: { ...initial, state: 'leased' as const },
    leaseToken: 'lease',
    workerFenceToken: 'fence',
  };
  const inputs: ProviderWorkerClaimInput[] = [];
  const options: ProviderWorkerClaimOptions = {
    workerId: 'worker-explicit',
    environment: {},
  };
  const assertOwned = () =>
    assert.fail(
      'claim must pass the lock callback unchanged, without extra calls',
    );
  const effects: ProviderWorkerClaimEffects = {
    taskMandate: {
      withActiveTaskMandateBinding(cwd, taskId, settings, operation) {
        assert.equal(this, effects.taskMandate);
        visit('mandate-enter', cwd, taskId, settings);
        const result = operation(activeBinding, assertOwned);
        visit('mandate-exit', result);
        return result;
      },
      assertActiveTaskMandateBindingUnderLifecycleLock(cwd, value, held) {
        assert.equal(this, effects.taskMandate);
        assert.equal(value, initial.mandateBinding);
        assert.equal(held, assertOwned);
        visit('active', cwd, value, held);
        return activeBinding;
      },
      recordTaskMandateProviderInvocationUnderLifecycleLock(
        cwd,
        value,
        input,
        held,
      ) {
        assert.equal(this, effects.taskMandate);
        assert.equal(value, activeBinding);
        assert.equal(held, assertOwned);
        visit('audit', cwd, value, input, held);
        return new Proxy(
          {},
          {
            get() {
              assert.fail('audit result must remain unobserved');
            },
          },
        ) as ReturnType<
          ProviderWorkerClaimEffects['taskMandate']['recordTaskMandateProviderInvocationUnderLifecycleLock']
        >;
      },
    },
    resolveAssignment(this: unknown, received) {
      assert.equal(this, undefined);
      assert.equal(received, options);
      visit('preflight', received);
      return null;
    },
    withTaskDiffReviewProviderLifecycleOperation(
      this: unknown,
      cwd,
      sessionId,
      operation,
    ) {
      assert.equal(this, undefined);
      visit('review-enter', cwd, sessionId);
      const result = operation(assertOwned);
      visit('review-exit', result);
      return result;
    },
    assertTaskDiffReviewProviderOwnerCurrent(
      this: unknown,
      cwd,
      id,
      validation,
    ) {
      assert.equal(this, undefined);
      assert.equal(
        validation?.consumedRoleResultReplay,
        effects.consumedRoleResultReplay,
      );
      visit('review-owner', cwd, id, validation);
      return currentOwner as ReturnType<
        ProviderWorkerClaimEffects['assertTaskDiffReviewProviderOwnerCurrent']
      >;
    },
    assertTaskStrategyImplementationProviderOwnerCurrent(
      this: unknown,
      ...args
    ) {
      assert.equal(this, undefined);
      visit('implementation-owner', ...args);
      return currentOwner as ReturnType<
        ProviderWorkerClaimEffects['assertTaskStrategyImplementationProviderOwnerCurrent']
      >;
    },
    consumedRoleResultReplay: {
      verify() {
        assert.fail('only the owner verifier may consume replay');
      },
    },
    readProposeExemptionOwner(this: unknown) {
      assert.equal(this, undefined);
      visit('exemption-owner');
      return currentOwner;
    },
    readInvestigationOwner(this: unknown) {
      assert.equal(this, undefined);
      visit('investigation-owner');
      return currentOwner;
    },
    claim(this: unknown, input) {
      assert.equal(this, undefined);
      inputs.push(input);
      visit('ordinary-claim', input);
      return lease;
    },
    claimUnderLifecycleLock(this: unknown, input, held) {
      assert.equal(this, undefined);
      assert.equal(held, assertOwned);
      inputs.push(input);
      visit('held-claim', input, held);
      return lease;
    },
  };
  return {
    observation,
    initial,
    request,
    reviewOwner,
    implementationOwner,
    currentOwner,
    binding,
    activeBinding,
    lease,
    inputs,
    options,
    effects,
    assertOwned,
    events,
    hooks,
    stages: () => events.map(([stage]) => stage),
    run: () => claimProviderWorker(effects, '/repo', observation, options),
  };
}

for (const route of [
  'review',
  'implementation',
  'exemption',
  'investigation',
] as const) {
  test(`mandated ${route}: fresh owner, exact audit, and claim share the held lock`, () => {
    const f = fixture(route);
    const result = f.run();
    assert.deepEqual(
      f.stages(),
      route === 'review'
        ? [
            'preflight',
            'review-enter',
            'active',
            'review-owner',
            'audit',
            'held-claim',
            'review-exit',
          ]
        : [
            'preflight',
            'mandate-enter',
            `${route}-owner`,
            'audit',
            'held-claim',
            'mandate-exit',
          ],
    );
    assert.deepEqual(
      f.events[1],
      route === 'review'
        ? ['review-enter', '/repo', 'review-session']
        : ['mandate-enter', '/repo', 'task-worker', {}],
    );
    assert.deepEqual(
      f.events.find(([stage]) => stage === 'audit'),
      [
        'audit',
        '/repo',
        f.activeBinding,
        {
          providerId: 'codex',
          invocationId: 'invocation-one',
          requestDigest: 'b'.repeat(64),
          occurredAt: '2030-01-02T03:04:05.000Z',
        },
        f.assertOwned,
      ],
    );
    if (route === 'review' || route === 'implementation') {
      assert.deepEqual(
        f.events.find(([stage]) => stage === `${route}-owner`)?.slice(1, 3),
        ['/repo', 'invocation-one'],
      );
    }
    assert.equal(result.claim, f.lease);
    assert.equal(result.claimInput, f.inputs[0]);
    assert.equal(f.events.at(-1)?.[1], f.lease);
    assert.deepEqual(result.claimInput, {
      workerId: 'worker-explicit',
      leaseDurationMs: 12_345,
      expectedRevision: 7,
    });
    result.claimInput.workerId = 'heartbeat-observes-this';
    assert.equal(f.inputs[0]?.workerId, 'heartbeat-observes-this');
  });
  test(`unmandated ${route} uses only ordinary journal claim`, () => {
    const f = fixture(route, false);
    assert.equal(f.run().claim, f.lease);
    assert.deepEqual(f.stages(), ['preflight', 'ordinary-claim']);
  });
}

test('review takes precedence over implementation and exemption without inspecting their fields', () => {
  const f = fixture('review');
  f.observation.taskStrategyImplementationOwner = f.implementationOwner;
  Object.defineProperty(f.initial, 'investigationId', {
    get(): never {
      throw new Error('lower priority owner read');
    },
  });
  f.run();
  assert.deepEqual(f.stages(), [
    'preflight',
    'review-enter',
    'active',
    'review-owner',
    'audit',
    'held-claim',
    'review-exit',
  ]);
});

test('Grant rejection precedes every lease field read and preserves the same thrown value', () => {
  const f = fixture();
  const failure = { code: 'ROLE_ASSIGNMENT_GRANT_REQUIRED' };
  f.hooks.preflight = () => {
    throw failure;
  };
  for (const [target, key] of [
    [f.options, 'workerId'],
    [f.initial, 'invocationId'],
    [f.request, 'limits'],
    [f.initial, 'revision'],
    [f.initial, 'mandateBinding'],
  ] as const) {
    Object.defineProperty(target, key, {
      get(): never {
        throw new Error(`early ${key}`);
      },
    });
  }
  assert.throws(f.run, (error) => error === failure);
  assert.deepEqual(f.stages(), ['preflight']);
});

for (const workerId of [undefined, '', 'chosen-worker']) {
  test(`claim fields read after preflight in original order, workerId=${String(workerId)}`, () => {
    const f = fixture('investigation', false);
    Object.defineProperty(f.options, 'workerId', {
      get() {
        f.events.push(['workerId']);
        return workerId;
      },
    });
    Object.defineProperty(f.initial, 'invocationId', {
      get() {
        f.events.push(['invocationId']);
        return 'late-id';
      },
    });
    Object.defineProperty(f.request, 'limits', {
      get() {
        f.events.push(['limits']);
        return {
          get timeoutMs() {
            f.events.push(['timeout']);
            return 9;
          },
        };
      },
    });
    Object.defineProperty(f.initial, 'revision', {
      get() {
        f.events.push(['revision']);
        return 11;
      },
    });
    const result = f.run();
    assert.deepEqual(f.stages(), [
      'preflight',
      'workerId',
      ...(workerId === undefined ? ['invocationId'] : []),
      'limits',
      'timeout',
      'revision',
      'ordinary-claim',
    ]);
    assert.equal(
      result.claimInput.workerId,
      workerId ?? `provider-worker-${process.pid}-late-id`,
    );
    assert.equal(result.claimInput.leaseDurationMs, 9);
    assert.equal(result.claimInput.expectedRevision, 11);
  });
}

test('admission mutations stay visible through original options, request, initial and review owner references', () => {
  const f = fixture('review');
  f.hooks.preflight = () => {
    f.options.workerId = undefined;
    f.initial.invocationId = 'after-preflight';
    f.initial.revision = 12;
    f.request.limits.timeoutMs = 88;
    Object.defineProperty(f.reviewOwner, 'sessionId', {
      value: 'after-preflight-session',
    });
  };
  f.hooks['review-enter'] = () => {
    f.initial.invocationId = 'after-lock';
  };
  f.hooks['review-owner'] = () => {
    f.initial.invocationId = 'after-owner';
    f.initial.createdAt = '2020-01-01T00:00:00.000Z';
    f.request.providerId = 'claude';
    f.request.requestDigest = 'd'.repeat(64);
  };
  f.hooks['held-claim'] = () => {
    f.inputs[0]!.workerId = 'changed-by-journal';
  };
  const result = f.run();
  assert.deepEqual(f.events[1], [
    'review-enter',
    '/repo',
    'after-preflight-session',
  ]);
  assert.deepEqual(
    f.events.find(([stage]) => stage === 'review-owner')?.slice(1, 3),
    ['/repo', 'after-lock'],
  );
  assert.deepEqual(f.events.find(([stage]) => stage === 'audit')?.[3], {
    providerId: 'claude',
    invocationId: 'after-owner',
    requestDigest: 'd'.repeat(64),
    occurredAt: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(result.claimInput, f.inputs[0]);
  assert.deepEqual(result.claimInput, {
    workerId: 'changed-by-journal',
    leaseDurationMs: 88,
    expectedRevision: 12,
  });
});

test('mandate branch observes the binding installed during preflight and fresh owner installed inside the lock', () => {
  const f = fixture('investigation', false);
  f.currentOwner.changeId = 'obsolete';
  f.hooks.preflight = () => {
    f.initial.mandateBinding = f.binding;
  };
  f.hooks['mandate-enter'] = () => {
    f.currentOwner.changeId = f.initial.changeId;
  };
  f.run();
  assert.deepEqual(f.stages(), [
    'preflight',
    'mandate-enter',
    'investigation-owner',
    'audit',
    'held-claim',
    'mandate-exit',
  ]);
});

function stale(error: unknown) {
  assert.ok(error instanceof WorkflowError);
  assert.equal(error.code, 'TASK_MANDATE_BINDING_STALE');
  assert.equal(
    error.message,
    'Provider worker invocation no longer matches its durable Task Mandate owner.',
  );
  assert.equal(error.exitCode, ExitCode.staleState);
  return true;
}

for (const mismatch of [
  'change',
  'owner-binding',
  'initial-binding',
  'missing-owner-binding',
] as const) {
  test(`stale ${mismatch} stops before audit or claim with the original error`, () => {
    const f = fixture();
    if (mismatch === 'change') {
      f.currentOwner.changeId = 'wrong';
      Object.defineProperty(f.currentOwner, 'mandateBinding', {
        get(): never {
          throw new Error('comparison must short circuit on change');
        },
      });
    } else if (mismatch === 'owner-binding') {
      let ownerBindingRead = false;
      Object.defineProperty(f.currentOwner, 'mandateBinding', {
        get() {
          ownerBindingRead = true;
          return { ...f.binding, mandateDigest: 'wrong' };
        },
      });
      Object.defineProperty(f.initial, 'mandateBinding', {
        get() {
          assert.equal(
            ownerBindingRead,
            false,
            'must not compare initial after owner mismatch',
          );
          return f.binding;
        },
      });
    } else if (mismatch === 'missing-owner-binding') {
      Reflect.deleteProperty(f.currentOwner, 'mandateBinding');
    } else {
      f.hooks['investigation-owner'] = () => {
        f.initial.mandateBinding = { ...f.binding, mandateDigest: 'wrong' };
      };
    }
    assert.throws(f.run, stale);
    assert.deepEqual(f.stages(), [
      'preflight',
      'mandate-enter',
      'investigation-owner',
    ]);
  });
}

test('binding comparison retains canonical equality across property order', () => {
  const f = fixture();
  f.currentOwner.mandateBinding = Object.fromEntries(
    Object.entries(f.binding).reverse(),
  ) as TaskMandateBinding;
  f.run();
  assert.ok(f.stages().includes('held-claim'));
});

test('initial binding removed under lock is compared without null coalescing', () => {
  const f = fixture();
  f.hooks['investigation-owner'] = () => {
    delete f.initial.mandateBinding;
  };
  // canonicalJson(undefined) is intentionally not normalized by the use case.
  assert.throws(f.run, (error) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, 'CANONICAL_JSON_INVALID');
    assert.equal(error.exitCode, ExitCode.usage);
    return true;
  });
  assert.deepEqual(f.stages(), [
    'preflight',
    'mandate-enter',
    'investigation-owner',
  ]);
});

const failureCases: Array<[Route, boolean, string, string[]]> = [
  ['review', true, 'review-enter', ['preflight', 'review-enter']],
  ['review', true, 'active', ['preflight', 'review-enter', 'active']],
  [
    'review',
    true,
    'review-owner',
    ['preflight', 'review-enter', 'active', 'review-owner'],
  ],
  [
    'implementation',
    true,
    'implementation-owner',
    ['preflight', 'mandate-enter', 'implementation-owner'],
  ],
  [
    'exemption',
    true,
    'exemption-owner',
    ['preflight', 'mandate-enter', 'exemption-owner'],
  ],
  ['investigation', true, 'mandate-enter', ['preflight', 'mandate-enter']],
  [
    'investigation',
    true,
    'investigation-owner',
    ['preflight', 'mandate-enter', 'investigation-owner'],
  ],
  [
    'investigation',
    true,
    'audit',
    ['preflight', 'mandate-enter', 'investigation-owner', 'audit'],
  ],
  [
    'investigation',
    true,
    'held-claim',
    [
      'preflight',
      'mandate-enter',
      'investigation-owner',
      'audit',
      'held-claim',
    ],
  ],
  ['investigation', false, 'ordinary-claim', ['preflight', 'ordinary-claim']],
];
for (const [route, mandated, stage, expected] of failureCases) {
  test(`${stage} failure propagates unchanged without later work or cleanup`, () => {
    const f = fixture(route, mandated);
    const failure = Object.freeze({ failedAt: stage });
    f.hooks[stage] = () => {
      throw failure;
    };
    assert.throws(f.run, (error) => error === failure);
    assert.deepEqual(f.stages(), expected);
  });
}

for (const suffix of [
  'a'.repeat(64),
  'a'.repeat(63),
  'a'.repeat(65),
  'A'.repeat(64),
  'z'.repeat(64),
  'a'.repeat(64) + '\n',
]) {
  test(`exemption identity keeps exact anchored lowercase digest shape ${JSON.stringify(suffix)}`, () => {
    assert.equal(PROPOSE_EXEMPTION_SESSION_PREFIX, 'investigation-exemption-');
    const id = `investigation-exemption-${suffix}`;
    const accepted = suffix === 'a'.repeat(64);
    assert.equal(isProposeExemptionInvestigationId(id), accepted);
    const f = fixture();
    f.initial.investigationId = id;
    f.run();
    assert.equal(
      f.stages()[2],
      accepted ? 'exemption-owner' : 'investigation-owner',
    );
  });
}
