import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentProviderConfigToml } from '@jigwright/core/agent-provider-config';
import {
  recordProviderWorkerFailure,
  type ProviderWorkerFailureObservation,
} from '../src/application/provider-worker/provider-failure-recording.ts';
import { createAgentRuntimeAssignmentBindingV1 } from '../src/modules/provider-orchestration/agent-runtime-assignment-binding.ts';
import {
  createAgentRuntimeHostExecutionBindingV1,
  createAgentRuntimeHostProbeEvidenceV1,
  providerDefinitionExecutableBindingDigest,
} from '../src/modules/provider-orchestration/agent-runtime-host-execution-binding.ts';
import type {
  AgentRuntimeAssignmentBindingV1,
  AgentRuntimeHostExecutionBindingV1,
  AgentRuntimeHostProbeEvidenceV1,
  AgentRuntimeProcessProgressProjection,
  ProviderInvocationAcceptanceBinding,
  ProviderRuntimeProtocolReceipt,
} from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import type {
  ProviderInvocationFailureInput,
  ProviderInvocationRecord,
  ProviderRepairFailureInput,
} from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import type { ProviderLeaseClaim } from '../src/modules/provider-orchestration/provider-invocation-lifecycle.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';

function assignmentBinding() {
  const profile = parseAgentProviderConfigToml(
    `schema_version = 2
global_ranking = ["claude-selected"]
[[providers]]
id = "claude-selected"
family = "claude"
trust_tier = "built-in-reviewed"
enabled = true
protocol = "claude-stream-json-v1"
executable = "/fixture/claude"
[provider_preferences]
author = ["claude-selected"]
builder = ["claude-selected"]
reviewer = ["claude-selected"]
`,
    { platform: 'darwin' },
  ).providers[0]!;
  return createAgentRuntimeAssignmentBindingV1({
    schemaVersion: 1,
    kind: 'agent-runtime-assignment-binding.v1',
    changeId: 'failure-recording',
    planningGeneration: '1'.repeat(64),
    recordDigest: '2'.repeat(64),
    assignmentDigest: '3'.repeat(64),
    role: 'author',
    logicalProviderId: profile.logicalProviderId,
    providerProfileId: profile.id,
    providerProfileSnapshot: profile,
    definitionDigest: profile.profileDigest,
    dataAuthorizationPolicyDigest: '4'.repeat(64),
    assignmentManifestDigest: '5'.repeat(64),
    inputManifestDigest: '6'.repeat(64),
    targetDigest: '7'.repeat(64),
  });
}

function fixture() {
  const events: string[] = [];
  const sentinel = new Error('injected recording failure');
  const error = workflowError(
    'PROVIDER_RATE_LIMIT',
    'Retry later.',
    ExitCode.verification,
    { details: { retryAfterMs: 23 } },
  );
  Object.defineProperty(error, 'code', {
    get() {
      events.push('classify');
      return 'PROVIDER_RATE_LIMIT';
    },
  });
  const schema = Object.freeze({ type: 'object' });
  // These already admitted values are opaque to the recording operation.
  const acceptance = Object.freeze({
    bindingDigest: 'a'.repeat(64),
  }) as ProviderInvocationAcceptanceBinding;
  const receipt = Object.freeze({
    kind: 'opaque-protocol-receipt',
  }) as unknown as ProviderRuntimeProtocolReceipt;
  const terminal = new Proxy({} as ProviderInvocationRecord, {
    get() {
      throw new Error('publication result must not be inspected');
    },
  });
  const progress: AgentRuntimeProcessProgressProjection = Object.freeze({
    schemaVersion: 1,
    kind: 'agent-runtime-process-progress',
    processState: 'running',
    eventCount: 1,
    stdoutBytes: 0,
    stderrBytes: 0,
    lastProcessActivityElapsedMs: 0,
    lastProviderActivityElapsedMs: null,
  });
  const state = {
    failAt: null as string | null,
    repair: null as ProviderRepairFailureInput | null,
    protocol: receipt as ProviderRuntimeProtocolReceipt | null,
    host: null as AgentRuntimeHostExecutionBindingV1 | null,
    probe: null as AgentRuntimeHostProbeEvidenceV1 | null,
    revision: 4,
  };
  function event(label: string) {
    events.push(label);
    if (state.failAt === label) throw sentinel;
  }
  const record = {
    get revision() {
      event('revision');
      return state.revision;
    },
    get leaseGeneration() {
      event('generation');
      return 2;
    },
  } as ProviderInvocationRecord;
  const claim: ProviderLeaseClaim = {
    get record() {
      event('claim-record');
      return record;
    },
    get leaseToken() {
      event('lease-token');
      return 'exact-lease-token';
    },
  };
  const observation: ProviderWorkerFailureObservation = {
    error,
    targetSchema: schema,
    acceptanceBinding: acceptance,
    preparedHostAssignmentBinding: null,
    runtimeFailureProtocolReceipt: function (this: unknown) {
      assert.equal(this, undefined);
      event('protocol');
      return state.protocol;
    },
    runtimeFailureHostExecutionBinding: function (this: unknown) {
      assert.equal(this, undefined);
      event('host');
      return state.host;
    },
    runtimeFailureHostProbeEvidence: function (this: unknown) {
      assert.equal(this, undefined);
      event('probe');
      return state.probe;
    },
    runtimeProgress: function (this: unknown) {
      assert.equal(this, undefined);
      event('progress');
      return progress;
    },
  };
  const publications: ProviderInvocationFailureInput[] = [];
  const operations = {
    extractRepairFailure(this: unknown, actual: unknown, target: unknown) {
      assert.equal(this, undefined);
      assert.equal(actual, error);
      assert.equal(target, schema);
      event('repair');
      return state.repair;
    },
    publishFailure(this: unknown, input: ProviderInvocationFailureInput) {
      assert.equal(this, undefined);
      event('publish');
      publications.push(input);
      return terminal;
    },
  };
  const run = (overrides: Partial<ProviderWorkerFailureObservation> = {}) =>
    recordProviderWorkerFailure(
      { ...observation, ...overrides },
      claim,
      operations,
    );
  assert.equal(
    events.length,
    0,
    'setting up a recording call must not observe evidence',
  );
  return {
    events,
    sentinel,
    error,
    schema,
    acceptance,
    receipt,
    progress,
    state,
    publications,
    run,
    terminal,
    observation,
  };
}

const claimEvents = [
  'claim-record',
  'revision',
  'claim-record',
  'generation',
  'lease-token',
];

test('records one failure with original callback receivers, late claim facts and result identity', () => {
  const f = fixture();
  f.state.revision = 9;
  assert.equal(f.run(), f.terminal);
  assert.deepEqual(f.events, [
    'classify',
    'repair',
    'protocol',
    'host',
    ...claimEvents,
    'progress',
    'publish',
  ]);
  assert.equal(f.publications.length, 1);
  const input = f.publications[0]!;
  assert.deepEqual(input, {
    expectedRevision: 9,
    leaseGeneration: 2,
    leaseToken: 'exact-lease-token',
    failure: {
      kind: 'retryable',
      code: 'PROVIDER_RATE_LIMIT',
      message:
        'Provider invocation failed durably (PROVIDER_RATE_LIMIT): Retry later.',
      executionKind: 'rate-limit',
      retryAfterMs: 23,
    },
    runtimeEvidence: {
      acceptanceBinding: f.acceptance,
      progress: f.progress,
      protocolReceipt: f.receipt,
    },
  });
  assert.equal(input.runtimeEvidence!.acceptanceBinding, f.acceptance);
  assert.equal(input.runtimeEvidence!.progress, f.progress);
  assert.equal(input.runtimeEvidence!.protocolReceipt, f.receipt);
  assert.equal(Object.hasOwn(input, 'repair'), false);
  assert.equal(Object.hasOwn(input, 'now'), false);
  assert.equal(
    Object.hasOwn(input.runtimeEvidence!, 'hostExecutionBinding'),
    false,
  );
});

test('repair output is forwarded unchanged after classification and before observation', () => {
  const f = fixture();
  const repair: ProviderRepairFailureInput = Object.freeze({
    repairKind: 'schema',
    previousOutput: { answer: null },
    validationErrors: [
      {
        path: '/answer',
        code: 'OUTPUT_SCHEMA_MISMATCH',
        message: 'Expected string.',
      },
    ],
    targetSchema: { type: 'object' },
  });
  f.state.repair = repair;
  f.run();
  assert.equal(f.publications[0]!.repair, repair);
  assert.deepEqual(f.events.slice(0, 3), ['classify', 'repair', 'protocol']);
});

test('an observed native-terminal host binding wins without fallback probe or reconstruction', () => {
  const f = fixture();
  // The producer validates native evidence; this operation must carry it opaquely.
  const native = Object.freeze({
    phase: 'native-terminal',
    nativeSessionClaim: { opaqueClaim: true },
    nativeSessionCompletionDigest: 'f'.repeat(64),
  }) as unknown as AgentRuntimeHostExecutionBindingV1;
  f.state.host = native;
  f.run({
    preparedHostAssignmentBinding: {} as AgentRuntimeAssignmentBindingV1,
  });
  assert.equal(
    f.publications[0]!.runtimeEvidence!.hostExecutionBinding,
    native,
  );
  assert.equal(f.events.includes('probe'), false);
});

test('current assignment fallback uses the real canonical host binding constructor', () => {
  const f = fixture();
  const assignment = assignmentBinding();
  f.run({ preparedHostAssignmentBinding: assignment });
  assert.deepEqual(f.events, [
    'classify',
    'repair',
    'protocol',
    'host',
    'probe',
    ...claimEvents,
    'progress',
    'publish',
  ]);
  const host = f.publications[0]!.runtimeEvidence!.hostExecutionBinding!;
  assert.deepEqual(
    host,
    createAgentRuntimeHostExecutionBindingV1({
      assignmentBinding: assignment,
      probe: null,
      nativeSessionClaim: null,
      nativeSessionCompletionDigest: null,
    }),
  );
  assert.equal(host.phase, 'assignment-admitted');
  assert.equal(host.nativeSessionClaim, null);
  assert.equal(host.nativeSessionCompletionDigest, null);
  assert.equal(Object.isFrozen(host), true);
});

test('fallback preserves an admitted probe as canonical probe-attested evidence', () => {
  const f = fixture();
  const assignment = assignmentBinding();
  const executable = {
    candidatePath: '/fixture/claude',
    realPath: '/fixture/claude',
    device: '1',
    inode: '2',
    mode: 0o755,
    uid: 501,
    gid: 20,
    size: 123,
    mtimeNs: '100',
    sha256: 'a'.repeat(64),
  };
  f.state.probe = createAgentRuntimeHostProbeEvidenceV1({
    invocationId: 'invocation-failed',
    requestDigest: '1'.repeat(64),
    executionAttemptId: 'attempt-failed',
    acceptanceBindingDigest: f.acceptance.bindingDigest,
    assignmentBindingDigest: assignment.bindingDigest,
    providerProfileDigest: assignment.providerProfileSnapshot.profileDigest,
    executable,
    providerDefinitionBindingDigest: providerDefinitionExecutableBindingDigest(
      assignment.providerProfileSnapshot.profileDigest,
      executable,
    ),
    providerVersion: 'fixture-v1',
    probeRequestFileDigest: '2'.repeat(64),
    probeResultFileDigest: '3'.repeat(64),
    governedBeforeDigest: '4'.repeat(64),
    governedAfterDigest: '4'.repeat(64),
  });
  f.run({ preparedHostAssignmentBinding: assignment });
  const host = f.publications[0]!.runtimeEvidence!.hostExecutionBinding!;
  assert.equal(host.phase, 'probe-attested');
  assert.deepEqual(host.probe, f.state.probe);
  assert.equal(host.nativeSessionClaim, null);
  assert.equal(host.nativeSessionCompletionDigest, null);
  assert.equal(f.events.filter((event) => event === 'probe').length, 1);
});

for (const acceptancePresent of [false, true]) {
  for (const progressPresent of [false, true]) {
    test(`evidence omission with acceptance=${acceptancePresent} and progress=${progressPresent} preserves earlier observers`, () => {
      const f = fixture();
      f.run({
        acceptanceBinding: acceptancePresent ? f.acceptance : null,
        runtimeProgress: progressPresent
          ? f.observation.runtimeProgress
          : undefined,
        preparedHostAssignmentBinding: assignmentBinding(),
      });
      const includeEvidence = acceptancePresent && progressPresent;
      assert.deepEqual(f.events, [
        'classify',
        'repair',
        'protocol',
        'host',
        'probe',
        ...claimEvents,
        ...(includeEvidence ? ['progress'] : []),
        'publish',
      ]);
      assert.equal(
        Object.hasOwn(f.publications[0]!, 'runtimeEvidence'),
        includeEvidence,
      );
    });
  }
}

test('absent receipt getters and pre-assignment failure retain exact omission', () => {
  const f = fixture();
  f.run({
    runtimeFailureProtocolReceipt: undefined,
    runtimeFailureHostExecutionBinding: undefined,
    runtimeFailureHostProbeEvidence: undefined,
  });
  assert.deepEqual(f.events, [
    'classify',
    'repair',
    ...claimEvents,
    'progress',
    'publish',
  ]);
  assert.deepEqual(Object.keys(f.publications[0]!.runtimeEvidence!), [
    'acceptanceBinding',
    'progress',
  ]);
});

test('explicit null receipts are observed then omitted without fallback before assignment', () => {
  const f = fixture();
  f.state.protocol = null;
  f.run();
  assert.deepEqual(f.events, [
    'classify',
    'repair',
    'protocol',
    'host',
    ...claimEvents,
    'progress',
    'publish',
  ]);
  assert.deepEqual(Object.keys(f.publications[0]!.runtimeEvidence!), [
    'acceptanceBinding',
    'progress',
  ]);
});

for (const stage of [
  'repair',
  'protocol',
  'host',
  'probe',
  'claim-record',
  'revision',
  'generation',
  'lease-token',
  'progress',
]) {
  test(`${stage} failure propagates identically and stops publication and later observers`, () => {
    const f = fixture();
    f.state.failAt = stage;
    const expected = [
      'classify',
      'repair',
      'protocol',
      'host',
      'probe',
      ...claimEvents,
      'progress',
      'publish',
    ];
    assert.throws(
      () => f.run({ preparedHostAssignmentBinding: assignmentBinding() }),
      (error) => error === f.sentinel,
    );
    assert.deepEqual(f.events, expected.slice(0, expected.indexOf(stage) + 1));
    assert.deepEqual(f.publications, []);
  });
}

test('a classification failure stops repair and all evidence observation', () => {
  const f = fixture();
  Object.defineProperty(f.error, 'message', {
    get() {
      throw f.sentinel;
    },
  });
  assert.throws(
    () => f.run(),
    (error) => error === f.sentinel,
  );
  assert.deepEqual(f.events, ['classify']);
  assert.deepEqual(f.publications, []);
});

test('host constructor rejection occurs after the probe getter and before claim or progress reads', () => {
  const f = fixture();
  assert.throws(
    () =>
      f.run({
        preparedHostAssignmentBinding: {} as AgentRuntimeAssignmentBindingV1,
      }),
    {
      name: 'TypeError',
      message: 'Agent Runtime assignment binding is invalid.',
    },
  );
  assert.deepEqual(f.events, [
    'classify',
    'repair',
    'protocol',
    'host',
    'probe',
  ]);
  assert.deepEqual(f.publications, []);
});

test('publication errors propagate identically without replaying any observation', () => {
  const f = fixture();
  f.state.failAt = 'publish';
  assert.throws(
    () => f.run(),
    (error) => error === f.sentinel,
  );
  assert.deepEqual(f.events, [
    'classify',
    'repair',
    'protocol',
    'host',
    ...claimEvents,
    'progress',
    'publish',
  ]);
});
