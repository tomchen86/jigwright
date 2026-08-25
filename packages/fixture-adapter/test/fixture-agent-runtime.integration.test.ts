import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentRuntimeNativeSessionIdDigestV1,
  agentRuntimeOutputSchemaDigestV1,
  createAgentRuntimeAttemptBindingV1,
  type AgentRuntimeAttemptBindingV1,
  type AgentRuntimeLaunchDefinitionSourceV1,
  type AgentRuntimePrivateSessionIdentityV1,
  type AgentRuntimeResumeInputV1,
  type AgentRuntimeStartInputV1,
} from '@jigwright/core/agent-runtime-port';

import {
  FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
  FIXTURE_AGENT_RUNTIME_EXECUTABLE_IDENTITY_V1,
  createFixtureAgentRuntimeV1,
} from '../src/fixture-agent-runtime.ts';

test('fixture adapter is a deterministic synthetic AgentRuntimePortV1 implementation', async () => {
  const launchSource: AgentRuntimeLaunchDefinitionSourceV1 =
    FIXTURE_AGENT_RUNTIME_DEFINITION_V1;
  const runtime = createFixtureAgentRuntimeV1();
  const probe = await runtime.probe(FIXTURE_AGENT_RUNTIME_DEFINITION_V1);
  assert.equal(probe.authority, 'observation-only');
  assert.equal(probe.observationClass, 'synthetic-fixture');
  assert.equal(probe.status, 'ready');
  assert.equal(launchSource, FIXTURE_AGENT_RUNTIME_DEFINITION_V1);
  assert.deepEqual(
    Object.getOwnPropertySymbols(FIXTURE_AGENT_RUNTIME_DEFINITION_V1),
    [],
  );
  assert.deepEqual(
    probe.executableIdentity,
    FIXTURE_AGENT_RUNTIME_EXECUTABLE_IDENTITY_V1,
  );

  const binding = fixtureBinding('fixture-operation-1');
  const privateSessions: AgentRuntimePrivateSessionIdentityV1[] = [];
  const input = fixtureInput(binding, {
    action: 'start' as const,
    mode: 'provider-observed-native' as const,
    privateSessionIdentitySink(identity) {
      privateSessions.push(identity);
    },
  });
  const first = await collect(
    runtime.start(FIXTURE_AGENT_RUNTIME_DEFINITION_V1, input),
  );
  const replayRuntime = createFixtureAgentRuntimeV1();
  await replayRuntime.probe(FIXTURE_AGENT_RUNTIME_DEFINITION_V1);
  const replay = await collect(
    replayRuntime.start(FIXTURE_AGENT_RUNTIME_DEFINITION_V1, input),
  );

  assert.deepEqual(first, replay);
  assert.equal(first.at(-1)?.type, 'completed');
  assert.equal(privateSessions.length, 2);
  assert.equal(
    JSON.stringify(first).includes(privateSessions[0]!.nativeSessionId),
    false,
  );
  const sessionEvent = first.find((event) => event.type === 'session-started');
  assert.ok(
    first.findIndex((event) => event.type === 'session-started') <
      first.findIndex((event) => event.type === 'semantic-progress'),
  );
  assert.equal(
    sessionEvent?.nativeSessionIdDigest,
    agentRuntimeNativeSessionIdDigestV1(privateSessions[0]!.nativeSessionId),
  );
  const completed = first.at(-1);
  if (completed?.type !== 'completed') assert.fail('missing completion');
  assert.deepEqual(completed.observation.executable, probe.executableIdentity);
  const completionDigest = readCompletionDigest(completed.output);
  const resumeBinding = fixtureBinding('fixture-operation-resume-1');
  const resumed = await collect(
    runtime.resume(
      FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
      fixtureInput(resumeBinding, {
        action: 'resume',
        mode: 'engine-supplied-native',
        nativeSessionId: privateSessions[0]!.nativeSessionId,
        nativeSessionIdDigest: privateSessions[0]!.nativeSessionIdDigest,
        predecessorCompletionDigest: completionDigest,
        continuityToken: privateSessions[0]!.continuityToken,
      }),
    ),
  );
  assert.equal(resumed.at(-1)?.type, 'completed');
  assert.equal(resumed.filter((event) => event.type === 'completed').length, 1);
});

test('fixture resume rejects arbitrary, stale, and rebound native sessions before execution', async () => {
  const runtime = createFixtureAgentRuntimeV1();
  await runtime.probe(FIXTURE_AGENT_RUNTIME_DEFINITION_V1);
  const nativeSessionId = 'fixture-native-arbitrary';
  const base = {
    action: 'resume' as const,
    mode: 'engine-supplied-native' as const,
    nativeSessionId,
    nativeSessionIdDigest: agentRuntimeNativeSessionIdDigestV1(nativeSessionId),
    predecessorCompletionDigest: '8'.repeat(64),
    continuityToken: 'fixture-continuity-arbitrary',
  };
  assert.throws(
    () =>
      runtime.resume(
        FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
        fixtureInput(fixtureBinding('fixture-arbitrary-resume'), base),
      ),
    /invalid/iu,
  );
});

test('fixture requires literal-true output validation before publishing session state', async () => {
  const runtime = createFixtureAgentRuntimeV1();
  await runtime.probe(FIXTURE_AGENT_RUNTIME_DEFINITION_V1);
  const binding = fixtureBinding('fixture-thenable-validator');
  const privateSessions: AgentRuntimePrivateSessionIdentityV1[] = [];
  const events = await collect(
    runtime.start(
      FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
      fixtureInput(binding, {
        action: 'start',
        mode: 'provider-observed-native',
        validate: (() => Promise.resolve(true)) as unknown as (
          value: unknown,
        ) => boolean,
        privateSessionIdentitySink(identity) {
          privateSessions.push(identity);
        },
      }),
    ),
  );
  assert.equal(events.at(-1)?.type, 'failed');
  assert.equal(privateSessions.length, 0);
  assert.equal(
    events.some((event) => event.type === 'completed'),
    false,
  );
  const rejectedValidationEvents = await collect(
    runtime.start(
      FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
      fixtureInput(fixtureBinding('fixture-rejected-validator'), {
        action: 'start',
        mode: 'provider-observed-native',
        validate: (() =>
          Promise.reject(
            new Error('fixture validator rejection'),
          )) as unknown as (value: unknown) => boolean,
      }),
    ),
  );
  assert.equal(rejectedValidationEvents.at(-1)?.type, 'failed');
  assert.equal(
    rejectedValidationEvents.some((event) => event.type === 'completed'),
    false,
  );

  const nativeSessionId = `fixture-native-${binding.bindingDigest}`;
  assert.throws(
    () =>
      runtime.resume(
        FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
        fixtureInput(fixtureBinding('fixture-thenable-resume'), {
          action: 'resume',
          mode: 'engine-supplied-native',
          nativeSessionId,
          nativeSessionIdDigest:
            agentRuntimeNativeSessionIdDigestV1(nativeSessionId),
          predecessorCompletionDigest: '8'.repeat(64),
          continuityToken: `fixture-continuity-${binding.bindingDigest}`,
        }),
      ),
    /invalid/iu,
  );

  for (const [index, sinkResult] of [
    () => Promise.resolve(undefined),
    () => Promise.reject(new Error('fixture sink rejection')),
  ].entries()) {
    const sinkBinding = fixtureBinding(`fixture-thenable-sink-${index}`);
    const sinkEvents = await collect(
      runtime.start(
        FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
        fixtureInput(sinkBinding, {
          action: 'start',
          mode: 'provider-observed-native',
          privateSessionIdentitySink: (() => sinkResult()) as unknown as (
            identity: AgentRuntimePrivateSessionIdentityV1,
          ) => void,
        }),
      ),
    );
    assert.equal(sinkEvents.at(-1)?.type, 'failed');
    assert.equal(
      sinkEvents.some((event) => event.type === 'completed'),
      false,
    );
  }
});

test('fixture reserves one predecessor atomically and pre-next return owns no operation', async () => {
  const runtime = createFixtureAgentRuntimeV1();
  await runtime.probe(FIXTURE_AGENT_RUNTIME_DEFINITION_V1);
  const privateSessions: AgentRuntimePrivateSessionIdentityV1[] = [];
  const startBinding = fixtureBinding('fixture-concurrent-start');
  const started = await collect(
    runtime.start(
      FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
      fixtureInput(startBinding, {
        action: 'start',
        mode: 'provider-observed-native',
        privateSessionIdentitySink(identity) {
          privateSessions.push(identity);
        },
      }),
    ),
  );
  const startedTerminal = started.at(-1);
  if (startedTerminal?.type !== 'completed') assert.fail('missing completion');
  const predecessorCompletionDigest = readCompletionDigest(
    startedTerminal.output,
  );
  const session = privateSessions[0]!;
  const resumeVariant = {
    action: 'resume' as const,
    mode: 'engine-supplied-native' as const,
    nativeSessionId: session.nativeSessionId,
    nativeSessionIdDigest: session.nativeSessionIdDigest,
    predecessorCompletionDigest,
    continuityToken: session.continuityToken,
  };
  const firstIterator = runtime
    .resume(
      FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
      fixtureInput(
        fixtureBinding('fixture-concurrent-resume-one'),
        resumeVariant,
      ),
    )
    [Symbol.asyncIterator]();
  const secondIterator = runtime
    .resume(
      FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
      fixtureInput(
        fixtureBinding('fixture-concurrent-resume-two'),
        resumeVariant,
      ),
    )
    [Symbol.asyncIterator]();
  assert.equal((await firstIterator.next()).value?.type, 'process-activity');
  await assert.rejects(() => secondIterator.next(), /invalid/iu);
  const firstResumeRemainder = await collectIterator(firstIterator);
  assert.equal(firstResumeRemainder.at(-1)?.type, 'completed');
  assert.throws(
    () =>
      runtime.resume(
        FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
        fixtureInput(
          fixtureBinding('fixture-stale-predecessor'),
          resumeVariant,
        ),
      ),
    /invalid/iu,
  );

  const unstartedBinding = fixtureBinding('fixture-return-before-next');
  const unstartedIterator = runtime
    .start(
      FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
      fixtureInput(unstartedBinding, {
        action: 'start',
        mode: 'provider-observed-native',
      }),
    )
    [Symbol.asyncIterator]();
  assert.equal((await unstartedIterator.return?.())?.done, true);
  assert.equal(
    (
      await runtime.cancel({
        binding: unstartedBinding,
        reason: 'caller-requested',
      })
    ).status,
    'not-active',
  );
});

const outputSchema = { type: 'object' } as const;

function fixtureBinding(operationId: string): AgentRuntimeAttemptBindingV1 {
  return createAgentRuntimeAttemptBindingV1({
    operationId,
    workflowId: 'fixture-workflow',
    workflowEpoch: 1,
    workflowContextDigest: '1'.repeat(64),
    jobId: 'fixture-job',
    attemptId: `attempt-${operationId}`,
    leaseGeneration: 1,
    engineSessionId: 'fixture-engine-session',
    invocationId: `invocation-${operationId}`,
    requestDigest: '2'.repeat(64),
    providerProfileId: 'fixture-primary',
    providerProfileDigest: '7'.repeat(64),
    executableCandidate: '/fixture/bin/provider',
    definitionDigest: FIXTURE_AGENT_RUNTIME_DEFINITION_V1.definitionDigest,
    dataAuthorizationPolicyDigest: '3'.repeat(64),
    inputManifestDigest: '4'.repeat(64),
    targetDigest: '5'.repeat(64),
    assignmentDigest: '6'.repeat(64),
    outputSchemaDigest: agentRuntimeOutputSchemaDigestV1(outputSchema),
    effect: 'repository-read-only',
  });
}

type StartVariant = Readonly<{
  action: 'start';
  mode: 'provider-observed-native';
  privateSessionIdentitySink?: (
    identity: AgentRuntimePrivateSessionIdentityV1,
  ) => void;
  validate?: (value: unknown) => boolean;
}>;

type ResumeVariant = Readonly<{
  action: 'resume';
  mode: 'engine-supplied-native';
  nativeSessionId: string;
  nativeSessionIdDigest: string;
  predecessorCompletionDigest: string;
  continuityToken: string | null;
}>;

function fixtureInput(
  binding: AgentRuntimeAttemptBindingV1,
  variant: StartVariant,
): AgentRuntimeStartInputV1;
function fixtureInput(
  binding: AgentRuntimeAttemptBindingV1,
  variant: ResumeVariant,
): AgentRuntimeResumeInputV1;
function fixtureInput(
  binding: AgentRuntimeAttemptBindingV1,
  variant: StartVariant | ResumeVariant,
): AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1 {
  const common = {
    binding,
    repositoryRoot: '/fixture/repository',
    workingDirectory: '/fixture/repository',
    runtimeDirectory: '/fixture/runtime',
    prompt: 'fixture prompt',
    output: {
      slot: 'primary' as const,
      schema: outputSchema,
      validate:
        'validate' in variant && variant.validate !== undefined
          ? variant.validate
          : (value: unknown) =>
              typeof value === 'object' && value !== null && 'fixture' in value,
    },
    governedInputs: [],
    limits: {
      timeoutMs: 1_000,
      aggregateOutputBytes: 8_192,
      maxEventCount: 16,
    },
    privateSessionIdentitySink:
      'privateSessionIdentitySink' in variant
        ? (variant.privateSessionIdentitySink ?? (() => undefined))
        : () => undefined,
  };
  return variant.action === 'start'
    ? { ...common, action: variant.action, mode: variant.mode }
    : { ...common, ...variant };
}

function readCompletionDigest(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('completionDigest' in value) ||
    typeof value.completionDigest !== 'string'
  ) {
    assert.fail('missing completion digest');
  }
  return value.completionDigest;
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function collectIterator<T>(iterator: AsyncIterator<T>): Promise<T[]> {
  const result: T[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return result;
    result.push(next.value);
  }
}
