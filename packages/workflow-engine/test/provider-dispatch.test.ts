import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderDispatchService } from '../src/application/provider-worker/provider-dispatch.ts';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import type { ProviderInvocationRecord } from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import type {
  ProviderDispatchObserver,
  ProviderWorkerAssignmentOptions,
  ProviderWorkerLauncher,
} from '../src/modules/provider-orchestration/provider-dispatch.ts';
import type { CurrentAgentRuntimeAssignmentV1 } from '../src/modules/provider-orchestration/agent-runtime-port.ts';

function record(
  invocationId: string,
  state: ProviderInvocationRecord['state'],
): ProviderInvocationRecord {
  return Object.freeze({
    schemaVersion: 1,
    invocationId,
    investigationId: 'investigation-fixture',
    changeId: 'dispatch-fixture',
    attempt: 1,
    revision: 1,
    state,
    providerId: 'codex',
    purpose: 'survey',
    requestDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    leaseGeneration: 0,
    lease: null,
    result: null,
    failure: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  });
}

function fixture(
  states: ProviderInvocationRecord['state'][] = ['prepared', 'prepared'],
) {
  const events: string[] = [];
  const options: ProviderWorkerAssignmentOptions = {
    environment: {},
    platform: 'darwin',
  };
  const state = {
    observationFailureAt: 0,
    failure: new Error('observation failed'),
    admissionFailure: undefined as Error | undefined,
    assignment: null as CurrentAgentRuntimeAssignmentV1 | null,
  };
  let observations = 0;
  const observe: ProviderDispatchObserver = (cwd, invocationId) => {
    assert.equal(cwd, '/requested');
    assert.equal(invocationId, 'requested-id');
    const index = ++observations;
    events.push(`observe:${index}`);
    if (state.observationFailureAt === index) throw state.failure;
    assert.ok(states[index - 1], 'unexpected additional observation');
    return {
      repositoryRoot: `/canonical-${index}`,
      invocation: record(`stored-${index}`, states[index - 1]!),
      resolveAssignment(received) {
        assert.equal(received, options, 'options must be passed by reference');
        events.push(`assignment:${index}`);
        if (state.admissionFailure) throw state.admissionFailure;
        return state.assignment;
      },
    };
  };
  const launch: ProviderWorkerLauncher = (input) => {
    events.push('launch');
    assert.deepEqual(input, {
      repositoryRoot: '/canonical-1',
      invocationId: 'stored-1',
    });
    return 4321;
  };
  const service = createProviderDispatchService({ observe, launch });
  assert.equal(events.length, 0, 'construction must not observe or launch');
  return {
    events,
    state,
    options,
    service,
    dispatch: () => service.dispatch('/requested', 'requested-id', options),
  };
}

function conflict(message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, 'PROVIDER_INVOCATION_DISPATCH_CONFLICT');
    assert.equal(error.exitCode, ExitCode.conflict);
    assert.equal(error.message, message);
    return true;
  };
}

for (const state of ['leased', 'succeeded', 'failed'] as const) {
  test(`first ${state} observation rejects dispatch without preflight or launch`, () => {
    const f = fixture([state]);
    assert.throws(
      f.dispatch,
      conflict(
        'Only the exact prepared provider invocation can be dispatched.',
      ),
    );
    assert.deepEqual(f.events, ['observe:1']);
  });
  test(`second ${state} observation rejects preflight before assignment or launch`, () => {
    const f = fixture(['prepared', state]);
    assert.throws(
      f.dispatch,
      conflict(
        'Only the exact prepared provider invocation can enter AgentRuntime Grant preflight.',
      ),
    );
    assert.deepEqual(f.events, ['observe:1', 'observe:2']);
  });
}

test('successful dispatch admits the second observation but launches the first root and stored ID', () => {
  const f = fixture();
  Object.defineProperty(f.options, 'environment', {
    get() {
      throw new Error('dispatch must not select environment');
    },
  });
  assert.deepEqual(f.dispatch(), {
    schemaVersion: 1,
    kind: 'provider-worker-dispatch',
    invocationId: 'stored-1',
    pid: 4321,
  });
  assert.deepEqual(f.events, [
    'observe:1',
    'observe:2',
    'assignment:2',
    'launch',
  ]);
});

test('assignment Grant refusal propagates the same error and never launches', () => {
  const f = fixture();
  const failure = new WorkflowError({
    code: 'AGENT_RUNTIME_GRANT_REQUIRED',
    message: 'Exact assignment requires a Grant.',
    exitCode: ExitCode.guard,
    details: { invocationId: 'requested-id' },
  });
  f.state.admissionFailure = failure;
  assert.throws(f.dispatch, (error) => error === failure);
  assert.deepEqual(f.events, ['observe:1', 'observe:2', 'assignment:2']);
});

for (const at of [1, 2]) {
  test(`strict observation ${at} failure propagates without assignment or launch`, () => {
    const f = fixture();
    f.state.observationFailureAt = at;
    assert.throws(f.dispatch, (error) => error === f.state.failure);
    assert.deepEqual(
      f.events,
      at === 1 ? ['observe:1'] : ['observe:1', 'observe:2'],
    );
  });
}

test('standalone preflight returns the exact assignment and native controller without inspection or reconstruction', () => {
  const f = fixture(['prepared']);
  // The assignment owner validates these facts; dispatch must carry its opaque
  // result unchanged, even when inspecting or cloning its fields would throw.
  const controller = Object.freeze({}) as NonNullable<
    CurrentAgentRuntimeAssignmentV1['nativeSessionTurn']
  >;
  const assignment = new Proxy(
    { nativeSessionTurn: controller } as CurrentAgentRuntimeAssignmentV1,
    {
      ownKeys() {
        throw new Error('assignment must not be cloned');
      },
      get(target, key) {
        if (key === 'nativeSessionTurn') return target.nativeSessionTurn;
        throw new Error('assignment facts must not be inspected');
      },
    },
  );
  f.state.assignment = assignment;
  const result = f.service.preflightProviderWorkerAssignment(
    '/requested',
    'requested-id',
    f.options,
  );
  assert.equal(result, assignment);
  assert.equal(result!.nativeSessionTurn, controller);
  assert.deepEqual(f.events, ['observe:1', 'assignment:1']);
});

test('standalone preflight retains the null assignment path without launching', () => {
  const f = fixture(['prepared']);
  assert.equal(
    f.service.preflightProviderWorkerAssignment(
      '/requested',
      'requested-id',
      f.options,
    ),
    null,
  );
  assert.deepEqual(f.events, ['observe:1', 'assignment:1']);
});

test('launcher failures retain identity after both admissions', () => {
  const failure = new Error('launcher failed');
  const events: string[] = [];
  const service = createProviderDispatchService({
    observe() {
      events.push('observe');
      return {
        repositoryRoot: '/canonical',
        invocation: record('stored', 'prepared'),
        resolveAssignment() {
          events.push('admit');
          return null;
        },
      };
    },
    launch() {
      events.push('launch');
      throw failure;
    },
  });
  assert.throws(
    () => service.dispatch('/requested', 'requested'),
    (error) => error === failure,
  );
  assert.deepEqual(events, ['observe', 'observe', 'admit', 'launch']);
});
