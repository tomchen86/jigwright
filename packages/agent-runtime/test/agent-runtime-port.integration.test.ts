import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentRuntimePortContractError,
  agentRuntimeNativeSessionIdDigestV1,
  agentRuntimeOutputSchemaDigestV1,
  assertAgentRuntimeDefinitionIdentityV1,
  assertAgentRuntimeResumeInputV1,
  assertAgentRuntimeStartInputV1,
  createAgentRuntimeAttemptBindingV1,
  createAgentRuntimeCapabilitiesV1,
  createAgentRuntimeUnavailableDefinitionIdentityV1,
  type AgentRuntimeAttemptBindingV1,
  type AgentRuntimeDefinitionIdentityV1,
  type AgentRuntimeEventV1,
  type AgentRuntimeLaunchDefinitionSourceV1,
  type AgentRuntimePrivateSessionIdentityV1,
  type AgentRuntimeResumeInputV1,
  type AgentRuntimeStartInputV1,
} from '@jigwright/core/agent-runtime-port';

import {
  AgentRuntimeOperationConflictError,
  createHostObservedAgentRuntimePortV1,
  type AgentRuntimeDriverControlV1,
  type AgentRuntimeDriverV1,
  type AgentRuntimeDriverEventV1,
} from '../src/agent-runtime-port.ts';
import {
  assertProviderDefinitionSnapshot,
  createProviderDefinitionSnapshot,
  type ProviderDefinitionSnapshot,
} from '../src/provider-definition-snapshot.ts';

const definitionValue = {
  schemaVersion: 1,
  kind: 'test-driver-definition.v1',
  providerFamily: 'test-driver',
  protocol: 'test-driver-jsonl-v1',
  definitionDigest: 'a'.repeat(64),
} as const;
const definition = assertAgentRuntimeDefinitionIdentityV1(
  definitionValue,
) as typeof definitionValue & AgentRuntimeDefinitionIdentityV1;
const capabilities = createAgentRuntimeCapabilitiesV1({
  structuredStreaming: true,
  structuredOutput: true,
  resumableAfterTurn: true,
  forkable: false,
  reattachableInFlight: false,
  cancellationAck: true,
  usageReporting: 'actual',
});
const outputSchema = { type: 'object' } as const;

type TestDriver = Readonly<{
  probe(): ReturnType<AgentRuntimeDriverV1['probe']>;
  start(
    input: AgentRuntimeStartInputV1,
    control: AgentRuntimeDriverControlV1,
  ): AsyncIterable<AgentRuntimeDriverEventV1>;
  resume(
    input: AgentRuntimeResumeInputV1,
    control: AgentRuntimeDriverControlV1,
  ): AsyncIterable<AgentRuntimeDriverEventV1>;
  cancel: AgentRuntimeDriverV1['cancel'];
}>;

function createTestRuntime(
  options: Readonly<{
    definition: typeof definition;
    driver: TestDriver;
  }>,
) {
  return createHostObservedAgentRuntimePortV1<typeof definition>({
    definition: options.definition,
    admitDefinition: (value) =>
      assertAgentRuntimeDefinitionIdentityV1(value) as typeof definition,
    projectDefinitionIdentity: assertAgentRuntimeDefinitionIdentityV1,
    admitStartInput: assertAgentRuntimeStartInputV1,
    admitResumeInput: assertAgentRuntimeResumeInputV1,
    driver: {
      probe: () => options.driver.probe(),
      start: (_snapshot, input, control) =>
        options.driver.start(input, control),
      resume: (_snapshot, input, control) =>
        options.driver.resume(input, control),
      cancel: (input, control) => options.driver.cancel(input, control),
    },
  });
}

test('runtime factory binds probe/start/resume to one definition and keeps raw session identity private', async () => {
  let startCalls = 0;
  let resumeCalls = 0;
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => ({
        status: 'ready',
        executableIdentity: executableIdentity(),
        providerVersion: 'test-driver-1.0.0',
        authentication: 'authenticated',
        capabilities,
      }),
      start(input) {
        startCalls += 1;
        return successfulEvents(input, 'private-native-start-1', 'start');
      },
      resume(input) {
        resumeCalls += 1;
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  const binding = attemptBinding('operation-success-1');
  const privateIdentities: Array<{
    schemaVersion: 1;
    kind: 'agent-runtime-private-session-identity.v1';
    action: 'start' | 'resume';
    nativeSessionId: string;
    nativeSessionIdDigest: string;
    continuityToken: string | null;
    protocolReceiptDigest: string;
  }> = [];
  const startInput = executionInput(binding, {
    action: 'start',
    mode: 'provider-observed-native',
    privateSessionIdentitySink(identity) {
      privateIdentities.push(identity);
    },
  });

  assert.equal(runtime.contractVersion, 'jigwright.agent-runtime-port.v1');
  assert.equal((await runtime.probe(definition)).status, 'ready');
  const unavailableDefinition =
    createAgentRuntimeUnavailableDefinitionIdentityV1({
      providerFamily: 'test-driver',
      status: 'host-disabled',
    }) as unknown as typeof definition;
  assert.throws(
    () => runtime.start(unavailableDefinition, startInput),
    invalidContract,
  );
  assert.equal(startCalls, 0);
  const startedStream = runtime.start(definition, startInput);
  const started = await collect(startedStream);
  assert.equal(startCalls, 1);
  assert.equal(resumeCalls, 0);
  assert.deepEqual(
    started.map((event) => event.type),
    [
      'process-activity',
      'provider-activity',
      'session-started',
      'semantic-progress',
      'usage',
      'completed',
    ],
  );
  assert.equal(
    started.every(
      (event) =>
        !('sequence' in event) &&
        !('operationId' in event) &&
        !('bindingDigest' in event),
    ),
    true,
  );
  assert.equal(
    JSON.stringify(started).includes('private-native-start-1'),
    false,
  );
  assert.deepEqual(privateIdentities, [
    {
      schemaVersion: 1,
      kind: 'agent-runtime-private-session-identity.v1',
      action: 'start',
      nativeSessionId: 'private-native-start-1',
      nativeSessionIdDigest: agentRuntimeNativeSessionIdDigestV1(
        'private-native-start-1',
      ),
      continuityToken: 'continuity-start',
      protocolReceiptDigest: '6'.repeat(64),
    },
  ]);
  await assert.rejects(() => collect(startedStream), operationConflict);

  const resumeBinding = attemptBinding('operation-resume-1');
  const resumeInput = executionInput(resumeBinding, {
    action: 'resume',
    mode: 'engine-supplied-native',
    nativeSessionId: 'private-native-start-1',
    nativeSessionIdDigest: agentRuntimeNativeSessionIdDigestV1(
      'private-native-start-1',
    ),
    predecessorCompletionDigest: '8'.repeat(64),
    continuityToken: 'continuity-start',
  });
  const resumed = await collect(runtime.resume(definition, resumeInput));
  assert.equal(startCalls, 1);
  assert.equal(resumeCalls, 1);
  assert.equal(resumed.at(-1)?.type, 'completed');
  assert.equal(
    JSON.stringify(resumed).includes('private-native-start-1'),
    false,
  );

  assert.throws(
    () => runtime.probe({ ...definition, definitionDigest: '9'.repeat(64) }),
    invalidContract,
  );
  assert.throws(
    () =>
      runtime.start(definition, {
        ...startInput,
        binding: attemptBinding('operation-wrong-definition', {
          definitionDigest: '9'.repeat(64),
        }),
      }),
    invalidContract,
  );
  assert.throws(
    () =>
      runtime.resume(definition, {
        ...resumeInput,
        binding: attemptBinding('operation-bad-resume'),
        nativeSessionIdDigest: '7'.repeat(64),
      }),
    invalidContract,
  );
  assert.equal(startCalls, 1, 'resume never falls back to start');
});

test('runtime bounds one single-consumer stream and rejects duplicate or post-terminal frames', async () => {
  const binding = attemptBinding('operation-post-terminal');
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield completedDriverEvent({ ok: true }, 1);
          yield {
            type: 'failed',
            phase: 'protocol',
            code: 'LATE_TERMINAL',
            elapsedMs: 2,
          };
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await runtime.probe(definition);
  const postTerminal = await collect(
    runtime.start(
      definition,
      executionInput(binding, {
        action: 'start',
        mode: 'single-shot',
      }),
    ),
  );
  const postTerminalResult = postTerminal.at(-1);
  assert.equal(postTerminalResult?.type, 'failed');
  if (postTerminalResult?.type === 'failed') {
    assert.equal(postTerminalResult.code, 'POST_TERMINAL_EVENT');
  }

  const boundedRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield { type: 'provider-activity', phase: 'tool', elapsedMs: 1 };
          yield { type: 'provider-activity', phase: 'model', elapsedMs: 2 };
          yield completedDriverEvent({ ok: true }, 3);
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: false, forced: true }),
    },
  });
  await boundedRuntime.probe(definition);
  const eventLimited = await collect(
    boundedRuntime.start(
      definition,
      executionInput(attemptBinding('operation-event-limit'), {
        action: 'start',
        mode: 'single-shot',
        limits: { maxEventCount: 2 },
      }),
    ),
  );
  assert.equal(eventLimited.at(-1)?.type, 'cancelled');

  const aggregateRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield {
            type: 'semantic-progress',
            summary: 'x'.repeat(768),
            elapsedMs: 1,
          };
          yield completedDriverEvent({ ok: true }, 2);
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: false, forced: true }),
    },
  });
  await aggregateRuntime.probe(definition);
  const byteLimited = await collect(
    aggregateRuntime.start(
      definition,
      executionInput(attemptBinding('operation-byte-limit'), {
        action: 'start',
        mode: 'single-shot',
        limits: { aggregateOutputBytes: 512 },
      }),
    ),
  );
  assert.equal(byteLimited.at(-1)?.type, 'cancelled');
});

test('cancel is fenced to the exact active binding and late completion cannot win', async () => {
  const binding = attemptBinding('operation-cancel');
  let resolveControllerReached: (() => void) | undefined;
  const controllerReached = new Promise<void>((resolve) => {
    resolveControllerReached = resolve;
  });
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start(input, control) {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          resolveControllerReached?.();
          yield { type: 'process-activity', activity: 'spawned', elapsedMs: 0 };
          await new Promise<void>((resolve) => {
            if (control.signal.aborted) resolve();
            else
              control.signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
          yield {
            type: 'cancelled',
            acknowledged: true,
            forced: false,
            elapsedMs: 2,
          };
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async (_input, control) => {
        assert.equal(control.signal.aborted, true);
        return { acknowledged: true, forced: false };
      },
    },
  });
  await runtime.probe(definition);
  const stream = runtime.start(
    definition,
    executionInput(binding, { action: 'start', mode: 'single-shot' }),
  );
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'process-activity');
  await controllerReached;

  await assert.rejects(
    () =>
      runtime.cancel({
        binding: attemptBinding('operation-cancel', { leaseGeneration: 99 }),
        reason: 'caller-requested',
      }),
    operationConflict,
  );
  const cancelled = await runtime.cancel({
    binding,
    reason: 'caller-requested',
  });
  assert.equal(cancelled.status, 'cancelled');
  if (cancelled.status === 'cancelled') {
    assert.equal(cancelled.acknowledged, true);
  }
  assert.equal((await iterator.next()).value?.type, 'cancelled');
  assert.equal((await iterator.next()).done, true);

  const afterTerminal = await runtime.cancel({
    binding,
    reason: 'shutdown',
  });
  assert.equal(afterTerminal.status, 'already-terminal');
});

test('operation registration begins on consumption and timeout cancellation wins its exact race', async () => {
  const binding = attemptBinding('operation-timeout');
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start(_input, control) {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield { type: 'process-activity', activity: 'spawned', elapsedMs: 0 };
          await new Promise<void>((resolve) => {
            if (control.signal.aborted) resolve();
            else
              control.signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
          yield {
            type: 'cancelled',
            acknowledged: false,
            forced: true,
            elapsedMs: 2,
          };
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async (_input, control) => {
        assert.equal(control.signal.aborted, true);
        return { acknowledged: false, forced: true };
      },
    },
  });
  const input = executionInput(binding, {
    action: 'start',
    mode: 'single-shot',
    limits: { timeoutMs: 20 },
  });
  await runtime.probe(definition);
  const stream = runtime.start(definition, input);
  assert.equal(
    (
      await runtime.cancel({
        binding,
        reason: 'caller-requested',
      })
    ).status,
    'not-active',
  );
  const events = await collect(stream);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, 'cancelled');
  if (terminal?.type === 'cancelled') {
    assert.equal(terminal.forced, true);
  }
  const timeoutTerminal = await runtime.cancel({
    binding,
    reason: 'shutdown',
  });
  assert.equal(timeoutTerminal.status, 'already-terminal');
});

test('start requires the latest successful host probe and stale probe completion cannot unlock effects', async () => {
  let probeCall = 0;
  let startCalls = 0;
  let resolveSlowProbe:
    ((value: ReturnType<typeof hostProbe>) => void) | undefined;
  const slowProbe = new Promise<ReturnType<typeof hostProbe>>((resolve) => {
    resolveSlowProbe = resolve;
  });
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe() {
        probeCall += 1;
        if (probeCall === 1) return slowProbe;
        if (probeCall === 2) {
          return Promise.resolve({
            status: 'absent' as const,
            executableIdentity: null,
            providerVersion: null,
            authentication: 'not-observed' as const,
            capabilities: null,
          });
        }
        return Promise.resolve(hostProbe());
      },
      start(input) {
        startCalls += 1;
        return successfulEvents(input, 'private-current-session', 'start');
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  const input = executionInput(attemptBinding('operation-probe-current'), {
    action: 'start',
    mode: 'single-shot',
  });

  assert.throws(() => runtime.start(definition, input), invalidContract);
  const older = runtime.probe(definition);
  assert.equal((await runtime.probe(definition)).status, 'absent');
  resolveSlowProbe?.(hostProbe());
  assert.equal((await older).status, 'ready');
  assert.throws(() => runtime.start(definition, input), invalidContract);
  assert.equal(startCalls, 0);

  assert.equal((await runtime.probe(definition)).status, 'ready');
  const captured = runtime.start(definition, input);
  assert.equal((await runtime.probe(definition)).status, 'ready');
  await assert.rejects(
    () => captured[Symbol.asyncIterator]().next(),
    invalidContract,
  );
  assert.equal(startCalls, 0);
});

test('probe rejects provider failures and hostile observations with one fixed contract error', async () => {
  const privateDetails = [
    'PRIVATE_PROBE_REJECTION',
    'PRIVATE_PROBE_GETTER',
  ] as const;
  for (const [index, privateDetail] of privateDetails.entries()) {
    let startCalls = 0;
    const runtime = createTestRuntime({
      definition,
      driver: {
        probe: async () => {
          if (index === 0) throw new Error(privateDetail);
          return new Proxy(hostProbe(), {
            ownKeys() {
              throw new Error(privateDetail);
            },
          });
        },
        start(input) {
          startCalls += 1;
          return successfulEvents(input, 'private-probe-failure', 'start');
        },
        resume(input) {
          return successfulEvents(input, input.nativeSessionId, 'resume');
        },
        cancel: async () => ({ acknowledged: true, forced: false }),
      },
    });
    let observedError: unknown;
    try {
      await runtime.probe(definition);
    } catch (error) {
      observedError = error;
    }
    assert.equal(invalidContract(observedError), true);
    assert.equal(String(observedError).includes(privateDetail), false);
    assert.throws(
      () =>
        runtime.start(
          definition,
          executionInput(attemptBinding(`operation-after-bad-probe-${index}`), {
            action: 'start',
            mode: 'single-shot',
          }),
        ),
      invalidContract,
    );
    assert.equal(startCalls, 0);
  }
});

test('resume requires an exact ready probe with resumable capability before driver effects', async () => {
  let resumeCalls = 0;
  const nonResumableCapabilities = createAgentRuntimeCapabilitiesV1({
    structuredStreaming: true,
    structuredOutput: true,
    resumableAfterTurn: false,
    forkable: false,
    reattachableInFlight: false,
    cancellationAck: true,
    usageReporting: 'actual',
  });
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => ({
        ...hostProbe(),
        capabilities: nonResumableCapabilities,
      }),
      start(input) {
        return successfulEvents(input, 'private-start', 'start');
      },
      resume(input) {
        resumeCalls += 1;
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await runtime.probe(definition);
  const nativeSessionId = 'private-resume-gate';
  assert.throws(
    () =>
      runtime.resume(
        definition,
        executionInput(attemptBinding('operation-resume-gate'), {
          action: 'resume',
          mode: 'engine-supplied-native',
          nativeSessionId,
          nativeSessionIdDigest:
            agentRuntimeNativeSessionIdDigestV1(nativeSessionId),
          predecessorCompletionDigest: '8'.repeat(64),
          continuityToken: 'continuity-start',
        }),
      ),
    invalidContract,
  );
  assert.equal(resumeCalls, 0);
});

test('raw session identity is committed only after one valid terminal and EOF', async () => {
  const privateSessions: AgentRuntimePrivateSessionIdentityV1[] = [];
  let cancelCalls = 0;
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield {
            type: 'session-started',
            nativeSessionId: 'private-never-committed',
            continuityToken: 'continuity-never-committed',
            protocolReceiptDigest: '6'.repeat(64),
            elapsedMs: 1,
          };
          yield completedDriverEvent({ ok: true }, 2);
          yield { type: 'provider-activity', phase: 'model', elapsedMs: 3 };
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => {
        cancelCalls += 1;
        return { acknowledged: true, forced: false };
      },
    },
  });
  await runtime.probe(definition);
  const events = await collect(
    runtime.start(
      definition,
      executionInput(attemptBinding('operation-private-delay'), {
        action: 'start',
        mode: 'provider-observed-native',
        privateSessionIdentitySink(identity) {
          privateSessions.push(identity);
        },
      }),
    ),
  );
  assert.equal(events.at(-1)?.type, 'failed');
  assert.equal(privateSessions.length, 0);
  assert.equal(cancelCalls, 1);
});

test('native identity secrets never cross any public event surface', async () => {
  const rawNativeSessionId = 'private-native-secret-value';
  const continuityToken = 'private-continuity-secret-value';

  const earlyContentRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield { type: 'process-activity', activity: 'spawned', elapsedMs: 0 };
          yield {
            type: 'semantic-progress',
            summary: 'content before native identity',
            elapsedMs: 1,
          };
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await earlyContentRuntime.probe(definition);
  const earlyEvents = await collect(
    earlyContentRuntime.start(
      definition,
      executionInput(attemptBinding('operation-content-before-session'), {
        action: 'start',
        mode: 'provider-observed-native',
      }),
    ),
  );
  assert.equal(earlyEvents.at(-1)?.type, 'failed');

  for (const leakSurface of [
    'semantic-progress',
    'output',
    'residuals',
    'protocol-evidence',
  ] as const) {
    let sinkCalls = 0;
    let validatorCalls = 0;
    const runtime = createTestRuntime({
      definition,
      driver: {
        probe: async () => hostProbe(),
        start() {
          return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
            yield {
              type: 'process-activity',
              activity: 'spawned',
              elapsedMs: 0,
            };
            yield {
              type: 'session-started',
              nativeSessionId: rawNativeSessionId,
              continuityToken,
              protocolReceiptDigest: '6'.repeat(64),
              elapsedMs: 1,
            };
            if (leakSurface === 'semantic-progress') {
              yield {
                type: 'semantic-progress',
                summary: `leaked ${rawNativeSessionId}`,
                elapsedMs: 2,
              };
              return;
            }
            const completion = completedDriverEvent(
              leakSurface === 'output'
                ? { ok: true, leaked: rawNativeSessionId }
                : { ok: true },
              2,
            );
            if (completion.type !== 'completed') assert.fail('bad fixture');
            yield {
              ...completion,
              observation: {
                ...completion.observation,
                residuals:
                  leakSurface === 'residuals'
                    ? [`leaked ${rawNativeSessionId}`]
                    : [],
                protocolEvidence:
                  leakSurface === 'protocol-evidence'
                    ? { leaked: continuityToken }
                    : null,
              },
            };
          })();
        },
        resume(input) {
          return successfulEvents(input, input.nativeSessionId, 'resume');
        },
        cancel: async () => ({ acknowledged: true, forced: false }),
      },
    });
    await runtime.probe(definition);
    const baseInput = executionInput(
      attemptBinding(`operation-private-leak-${leakSurface}`),
      {
        action: 'start',
        mode: 'provider-observed-native',
        privateSessionIdentitySink() {
          sinkCalls += 1;
        },
      },
    );
    const events = await collect(
      runtime.start(definition, {
        ...baseInput,
        output: {
          ...baseInput.output,
          validate(value) {
            validatorCalls += 1;
            return baseInput.output.validate(value);
          },
        },
      }),
    );
    assert.equal(events.at(-1)?.type, 'failed');
    assert.equal(sinkCalls, 0);
    assert.equal(validatorCalls, 0);
    assert.equal(JSON.stringify(events).includes(rawNativeSessionId), false);
    assert.equal(JSON.stringify(events).includes(continuityToken), false);
  }

  const resumeRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start(input) {
        return successfulEvents(input, rawNativeSessionId, 'start');
      },
      resume() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield { type: 'process-activity', activity: 'spawned', elapsedMs: 0 };
          yield {
            type: 'semantic-progress',
            summary: `resume leaked ${rawNativeSessionId}`,
            elapsedMs: 1,
          };
        })();
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await resumeRuntime.probe(definition);
  const resumedEvents = await collect(
    resumeRuntime.resume(
      definition,
      executionInput(attemptBinding('operation-private-resume-leak'), {
        action: 'resume',
        mode: 'engine-supplied-native',
        nativeSessionId: rawNativeSessionId,
        nativeSessionIdDigest:
          agentRuntimeNativeSessionIdDigestV1(rawNativeSessionId),
        predecessorCompletionDigest: '8'.repeat(64),
        continuityToken,
      }),
    ),
  );
  assert.equal(resumedEvents.at(-1)?.type, 'failed');
  assert.equal(
    JSON.stringify(resumedEvents).includes(rawNativeSessionId),
    false,
  );
  assert.equal(JSON.stringify(resumedEvents).includes(continuityToken), false);

  const numericNativeSessionId = '12345678';
  const numericSecretRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start(input) {
        return successfulEvents(input, numericNativeSessionId, 'start');
      },
      resume() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield {
            type: 'usage',
            basis: 'actual',
            inputTokens: Number(numericNativeSessionId),
            outputTokens: null,
            costMicros: null,
            elapsedMs: 0,
          };
        })();
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await numericSecretRuntime.probe(definition);
  const numericSecretEvents = await collect(
    numericSecretRuntime.resume(
      definition,
      executionInput(attemptBinding('operation-private-numeric-leak'), {
        action: 'resume',
        mode: 'engine-supplied-native',
        nativeSessionId: numericNativeSessionId,
        nativeSessionIdDigest: agentRuntimeNativeSessionIdDigestV1(
          numericNativeSessionId,
        ),
        predecessorCompletionDigest: '8'.repeat(64),
        continuityToken: 'continuity-numeric-secret',
      }),
    ),
  );
  assert.equal(numericSecretEvents.at(-1)?.type, 'failed');
  assert.equal(
    JSON.stringify(numericSecretEvents).includes(numericNativeSessionId),
    false,
  );
});

test('driver exceptions and output validation failures become one typed terminal', async () => {
  const throwingRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield { type: 'process-activity', activity: 'spawned', elapsedMs: 0 };
          throw new Error('private driver detail');
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await throwingRuntime.probe(definition);
  const driverFailure = await collect(
    throwingRuntime.start(
      definition,
      executionInput(attemptBinding('operation-driver-throw'), {
        action: 'start',
        mode: 'single-shot',
      }),
    ),
  );
  assert.deepEqual(
    driverFailure.filter(isTerminal).map((event) => event.type),
    ['failed'],
  );
  const observedFailure = driverFailure.at(-1);
  if (observedFailure?.type !== 'failed') assert.fail('missing failure');
  assert.equal(observedFailure.launched, true);
  assert.equal(
    JSON.stringify(driverFailure).includes('private driver detail'),
    false,
  );

  const invalidOutputRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield completedDriverEvent({ invalid: true }, 1);
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await invalidOutputRuntime.probe(definition);
  const outputFailure = await collect(
    invalidOutputRuntime.start(
      definition,
      executionInput(attemptBinding('operation-output-invalid'), {
        action: 'start',
        mode: 'single-shot',
      }),
    ),
  );
  assert.deepEqual(
    outputFailure.filter(isTerminal).map((event) => event.type),
    ['failed'],
  );
});

test('failed launched evidence comes only from an admitted spawned observation', async () => {
  const firstNextThrow = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<AgentRuntimeDriverEventV1>> {
                throw new Error('first-next failed');
              },
            };
          },
        };
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await firstNextThrow.probe(definition);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timerAllocations = 0;
  let timerClears = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timerAllocations += 1;
    return originalSetTimeout(...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
    timerClears += 1;
    return originalClearTimeout(...args);
  }) as typeof clearTimeout;
  let firstNextEvents: Awaited<ReturnType<typeof collect<AgentRuntimeEventV1>>>;
  try {
    firstNextEvents = await collect(
      firstNextThrow.start(
        definition,
        executionInput(attemptBinding('operation-first-next-throw'), {
          action: 'start',
          mode: 'single-shot',
        }),
      ),
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(timerAllocations, timerClears);
  const firstNextTerminal = firstNextEvents.at(-1);
  if (firstNextTerminal?.type !== 'failed') assert.fail('missing failure');
  assert.equal(firstNextTerminal.launched, false);

  const malformedBeforeSpawn = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield {
            type: 'provider-activity',
            phase: 'not-a-phase',
            elapsedMs: 0,
          } as unknown as AgentRuntimeDriverEventV1;
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await malformedBeforeSpawn.probe(definition);
  const malformedEvents = await collect(
    malformedBeforeSpawn.start(
      definition,
      executionInput(attemptBinding('operation-malformed-before-spawn'), {
        action: 'start',
        mode: 'single-shot',
      }),
    ),
  );
  const malformedTerminal = malformedEvents.at(-1);
  if (malformedTerminal?.type !== 'failed') assert.fail('missing failure');
  assert.equal(malformedTerminal.launched, false);
});

test('thenable output validation cannot publish a session or completion', async () => {
  const privateSessions: AgentRuntimePrivateSessionIdentityV1[] = [];
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start(input) {
        return successfulEvents(input, 'private-thenable-session', 'start');
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await runtime.probe(definition);
  for (const [index, validationResult] of [
    () => Promise.resolve(true),
    () => Promise.reject(new Error('output validator rejection')),
  ].entries()) {
    const base = executionInput(
      attemptBinding(`operation-thenable-validator-${index}`),
      {
        action: 'start',
        mode: 'provider-observed-native',
        privateSessionIdentitySink(identity) {
          privateSessions.push(identity);
        },
      },
    );
    const events = await collect(
      runtime.start(definition, {
        ...base,
        output: {
          ...base.output,
          validate: (() =>
            validationResult()) as unknown as typeof base.output.validate,
        },
      }),
    );
    assert.equal(events.at(-1)?.type, 'failed');
    assert.equal(privateSessions.length, 0);
    assert.equal(
      events.some((event) => event.type === 'completed'),
      false,
    );
  }
});

test('private session sink must synchronously return literal undefined', async () => {
  for (const [index, sinkResult] of [
    () => Promise.resolve(undefined),
    () => Promise.reject(new Error('private sink rejection')),
  ].entries()) {
    let sinkCalls = 0;
    const runtime = createTestRuntime({
      definition,
      driver: {
        probe: async () => hostProbe(),
        start(input) {
          return successfulEvents(
            input,
            `private-thenable-sink-${index}`,
            'start',
          );
        },
        resume(input) {
          return successfulEvents(input, input.nativeSessionId, 'resume');
        },
        cancel: async () => ({ acknowledged: true, forced: false }),
      },
    });
    await runtime.probe(definition);
    const base = executionInput(
      attemptBinding(`operation-thenable-sink-${index}`),
      {
        action: 'start',
        mode: 'provider-observed-native',
      },
    );
    const events = await collect(
      runtime.start(definition, {
        ...base,
        privateSessionIdentitySink: (() => {
          sinkCalls += 1;
          return sinkResult();
        }) as unknown as typeof base.privateSessionIdentitySink,
      }),
    );
    assert.equal(sinkCalls, 1);
    assert.equal(events.at(-1)?.type, 'failed');
    assert.equal(
      events.some((event) => event.type === 'completed'),
      false,
    );
  }
});

test('iterator-return and cancel failures cannot mask terminal cleanup', async () => {
  const binding = attemptBinding('operation-return-throws');
  let nextCalls = 0;
  const returnThrowingRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<AgentRuntimeDriverEventV1>> {
                nextCalls += 1;
                return nextCalls === 1
                  ? Promise.resolve({
                      done: false,
                      value: completedDriverEvent({ ok: true }, 1),
                    })
                  : Promise.resolve({ done: true, value: undefined });
              },
              return(): Promise<IteratorResult<AgentRuntimeDriverEventV1>> {
                throw new Error('return failed');
              },
            };
          },
        };
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await returnThrowingRuntime.probe(definition);
  const events = await collect(
    returnThrowingRuntime.start(
      definition,
      executionInput(binding, { action: 'start', mode: 'single-shot' }),
    ),
  );
  assert.equal(events.at(-1)?.type, 'completed');
  assert.equal(
    (await returnThrowingRuntime.cancel({ binding, reason: 'shutdown' }))
      .status,
    'already-terminal',
  );

  const getterBinding = attemptBinding('operation-return-getter-throws');
  let getterNextCalls = 0;
  const returnGetterRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return {
          [Symbol.asyncIterator]() {
            const hostileIterator = {
              next(): Promise<IteratorResult<AgentRuntimeDriverEventV1>> {
                getterNextCalls += 1;
                return getterNextCalls === 1
                  ? Promise.resolve({
                      done: false,
                      value: completedDriverEvent({ ok: true }, 1),
                    })
                  : Promise.resolve({ done: true, value: undefined });
              },
            };
            Object.defineProperty(hostileIterator, 'return', {
              get() {
                throw new Error('PRIVATE_RETURN_GETTER');
              },
            });
            return hostileIterator;
          },
        };
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await returnGetterRuntime.probe(definition);
  const getterEvents = await collect(
    returnGetterRuntime.start(
      definition,
      executionInput(getterBinding, {
        action: 'start',
        mode: 'single-shot',
      }),
    ),
  );
  assert.equal(getterEvents.at(-1)?.type, 'completed');
  assert.equal(
    (
      await returnGetterRuntime.cancel({
        binding: getterBinding,
        reason: 'shutdown',
      })
    ).status,
    'already-terminal',
  );

  for (const [index, cancelFailure] of [
    'sync-throw',
    'rejected-promise',
  ].entries()) {
    const cancelBinding = attemptBinding(`operation-cancel-failure-${index}`);
    const runtime = createTestRuntime({
      definition,
      driver: {
        probe: async () => hostProbe(),
        start(_input, control) {
          return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
            yield {
              type: 'process-activity',
              activity: 'spawned',
              elapsedMs: 0,
            };
            await new Promise<void>((resolve) => {
              if (control.signal.aborted) resolve();
              else
                control.signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
            });
            yield {
              type: 'cancelled',
              acknowledged: false,
              forced: true,
              elapsedMs: 1,
            };
          })();
        },
        resume(input) {
          return successfulEvents(input, input.nativeSessionId, 'resume');
        },
        cancel() {
          if (cancelFailure === 'sync-throw') throw new Error('cancel failed');
          return Promise.reject(new Error('cancel rejected'));
        },
      },
    });
    await runtime.probe(definition);
    const iterator = runtime
      .start(
        definition,
        executionInput(cancelBinding, {
          action: 'start',
          mode: 'single-shot',
        }),
      )
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'process-activity');
    const cancelResult = await runtime.cancel({
      binding: cancelBinding,
      reason: 'caller-requested',
    });
    assert.equal(cancelResult.status, 'cancellation-unconfirmed');
    const terminal = (await iterator.next()).value;
    assert.equal(terminal?.type, 'failed');
    if (terminal?.type === 'failed') {
      assert.equal(terminal.code, 'CANCELLATION_UNCONFIRMED');
    }
    assert.equal((await iterator.next()).done, true);
    assert.equal(
      (await runtime.cancel({ binding: cancelBinding, reason: 'shutdown' }))
        .status,
      'already-terminal',
    );
    assert.throws(
      () =>
        runtime.start(
          definition,
          executionInput(attemptBinding(`operation-after-poison-${index}`), {
            action: 'start',
            mode: 'single-shot',
          }),
        ),
      invalidContract,
    );
  }
});

test('unconfirmed cancellation aborts pending iteration without claiming force and poisons the runtime', async () => {
  const binding = attemptBinding('operation-unconfirmed-cancel');
  let startCalls = 0;
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        startCalls += 1;
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield { type: 'process-activity', activity: 'spawned', elapsedMs: 0 };
          await new Promise<void>(() => undefined);
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: () =>
        new Promise<Readonly<{ acknowledged: boolean; forced: boolean }>>(
          () => undefined,
        ),
    },
  });
  await runtime.probe(definition);
  const capturedSecondStream = runtime.start(
    definition,
    executionInput(attemptBinding('operation-captured-before-cancel'), {
      action: 'start',
      mode: 'single-shot',
    }),
  );
  const iterator = runtime
    .start(
      definition,
      executionInput(binding, { action: 'start', mode: 'single-shot' }),
    )
    [Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'process-activity');
  const pending = iterator.next();
  const startedAt = Date.now();
  const cancelling = runtime.cancel({
    binding,
    reason: 'caller-requested',
  });
  await assert.rejects(
    () => capturedSecondStream[Symbol.asyncIterator]().next(),
    invalidContract,
  );
  assert.throws(
    () =>
      runtime.start(
        definition,
        executionInput(attemptBinding('operation-created-during-cancel'), {
          action: 'start',
          mode: 'single-shot',
        }),
      ),
    invalidContract,
  );
  assert.equal(startCalls, 1);
  const result = await cancelling;
  assert.deepEqual(result, { status: 'cancellation-unconfirmed' });
  assert.equal('acknowledged' in result, false);
  assert.equal('forced' in result, false);
  const terminal = (await pending).value;
  assert.equal(terminal?.type, 'failed');
  if (terminal?.type === 'failed') {
    assert.equal(terminal.code, 'CANCELLATION_UNCONFIRMED');
  }
  assert.ok(Date.now() - startedAt < 1_200);
  assert.equal((await iterator.next()).done, true);
  assert.throws(
    () =>
      runtime.start(
        definition,
        executionInput(attemptBinding('operation-after-unconfirmed'), {
          action: 'start',
          mode: 'single-shot',
        }),
      ),
    invalidContract,
  );
});

test('hostile cancellation evidence becomes unconfirmed without private error leakage', async () => {
  const privateDetail = 'PRIVATE_CANCEL_EVIDENCE_GETTER';
  for (const failureKind of ['own-keys', 'property-getter'] as const) {
    const binding = attemptBinding(`operation-hostile-cancel-${failureKind}`);
    const hostileResult =
      failureKind === 'own-keys'
        ? new Proxy(
            { acknowledged: true, forced: false },
            {
              ownKeys() {
                throw new Error(privateDetail);
              },
            },
          )
        : Object.defineProperties(
            {},
            {
              acknowledged: {
                enumerable: true,
                get() {
                  throw new Error(privateDetail);
                },
              },
              forced: { enumerable: true, value: false },
            },
          );
    const runtime = createTestRuntime({
      definition,
      driver: {
        probe: async () => hostProbe(),
        start(_input, control) {
          return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
            yield {
              type: 'process-activity',
              activity: 'spawned',
              elapsedMs: 0,
            };
            await new Promise<void>((resolve) => {
              if (control.signal.aborted) resolve();
              else
                control.signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
            });
          })();
        },
        resume(input) {
          return successfulEvents(input, input.nativeSessionId, 'resume');
        },
        cancel: async () =>
          hostileResult as Readonly<{
            acknowledged: boolean;
            forced: boolean;
          }>,
      },
    });
    await runtime.probe(definition);
    const iterator = runtime
      .start(
        definition,
        executionInput(binding, { action: 'start', mode: 'single-shot' }),
      )
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'process-activity');
    const pending = iterator.next();
    const cancelResult = await runtime.cancel({
      binding,
      reason: 'caller-requested',
    });
    assert.deepEqual(cancelResult, { status: 'cancellation-unconfirmed' });
    const terminal = (await pending).value;
    assert.equal(terminal?.type, 'failed');
    if (terminal?.type === 'failed') {
      assert.equal(terminal.code, 'CANCELLATION_UNCONFIRMED');
    }
    assert.equal(JSON.stringify(terminal).includes(privateDetail), false);
    assert.equal((await iterator.next()).done, true);
    assert.throws(
      () =>
        runtime.start(
          definition,
          executionInput(
            attemptBinding(`operation-after-hostile-${failureKind}`),
            { action: 'start', mode: 'single-shot' },
          ),
        ),
      invalidContract,
    );
  }
});

test('driver failure reasons are mapped to one code-owned public value', async () => {
  const privateFailureCode = 'PRIVATESESSIONFAILURE';
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start() {
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          yield {
            type: 'failed',
            phase: 'identity',
            code: privateFailureCode,
            elapsedMs: 0,
          };
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await runtime.probe(definition);
  const events = await collect(
    runtime.start(
      definition,
      executionInput(attemptBinding('operation-private-failure-code'), {
        action: 'start',
        mode: 'provider-observed-native',
      }),
    ),
  );
  const terminal = events.at(-1);
  if (terminal?.type !== 'failed') assert.fail('missing failure');
  assert.equal(terminal.code, 'RUNTIME_DRIVER_REPORTED_FAILURE');
  assert.equal(JSON.stringify(events).includes(privateFailureCode), false);
});

test('duplicate streams fence on first consumption and consumer abandonment cancels the driver', async () => {
  let cancelCalls = 0;
  let startCalls = 0;
  let sawAbortedSignal = false;
  const runtime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start(_input, control) {
        startCalls += 1;
        return (async function* (): AsyncGenerator<AgentRuntimeDriverEventV1> {
          try {
            yield {
              type: 'process-activity',
              activity: 'spawned',
              elapsedMs: 0,
            };
            await new Promise<void>(() => undefined);
          } finally {
            sawAbortedSignal = control.signal.aborted;
          }
        })();
      },
      resume(input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async (_input, control) => {
        cancelCalls += 1;
        assert.equal(control.signal.aborted, true);
        return { acknowledged: true, forced: false };
      },
    },
  });
  await runtime.probe(definition);
  const binding = attemptBinding('operation-abandoned-consumer');
  const input = executionInput(binding, {
    action: 'start',
    mode: 'single-shot',
  });
  const firstStream = runtime.start(definition, input);
  const duplicateStream = runtime.start(definition, input);
  assert.equal(
    (await runtime.cancel({ binding, reason: 'caller-requested' })).status,
    'not-active',
  );
  const iterator = firstStream[Symbol.asyncIterator]();
  const duplicateIterator = duplicateStream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'process-activity');
  await assert.rejects(() => duplicateIterator.next(), operationConflict);
  await iterator.return?.();
  assert.equal(cancelCalls, 1);
  assert.equal(sawAbortedSignal, true);
  assert.equal(
    (await runtime.cancel({ binding, reason: 'shutdown' })).status,
    'already-terminal',
  );

  const unstartedBinding = attemptBinding('operation-return-before-next');
  const unstarted = runtime
    .start(
      definition,
      executionInput(unstartedBinding, {
        action: 'start',
        mode: 'single-shot',
      }),
    )
    [Symbol.asyncIterator]();
  assert.equal((await unstarted.return?.())?.done, true);
  assert.equal(startCalls, 1);
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

test('factory admits a full ProviderDefinitionSnapshot and exact implementation-owned inputs', async () => {
  const providerSnapshot = createProviderDefinitionSnapshot({
    definitionId: 'fixture-built-in-reviewed',
    definitionRevision: 1,
    providerFamily: 'fixture',
    protocol: 'fixture-events-v1',
    platform: 'darwin',
    executableCandidates: ['/fixture/bin/provider'],
    commandProfile: 'fixture-read-only-v1',
  });
  const launchSource: AgentRuntimeLaunchDefinitionSourceV1 = providerSnapshot;
  const projectIdentity = (snapshot: ProviderDefinitionSnapshot) =>
    assertAgentRuntimeDefinitionIdentityV1({
      schemaVersion: 1,
      kind: 'agent-runtime-definition-identity.v1',
      providerFamily: snapshot.providerFamily,
      protocol: snapshot.protocol,
      definitionDigest: snapshot.definitionDigest,
    });
  let driverStartCalls = 0;
  let observedDefinition: ProviderDefinitionSnapshot | null = null;
  let observedRequest: FixtureImplementationRequest | null = null;
  const runtime = createHostObservedAgentRuntimePortV1<
    ProviderDefinitionSnapshot,
    FixtureStartInput,
    FixtureResumeInput
  >({
    definition: providerSnapshot,
    admitDefinition: assertProviderDefinitionSnapshot,
    projectDefinitionIdentity: projectIdentity,
    admitStartInput: admitFixtureStartInput,
    admitResumeInput: admitFixtureResumeInput,
    driver: {
      probe: async (snapshot) => {
        observedDefinition = snapshot;
        return hostProbe();
      },
      start(snapshot, input) {
        driverStartCalls += 1;
        observedDefinition = snapshot;
        observedRequest = input.implementationRequest;
        return successfulEvents(input, 'fixture-private-session', 'start');
      },
      resume(snapshot, input) {
        observedDefinition = snapshot;
        observedRequest = input.implementationRequest;
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  assert.equal(launchSource, providerSnapshot);
  assert.deepEqual(Object.getOwnPropertySymbols(providerSnapshot), []);
  const binding = attemptBinding('operation-extended-input', {
    definitionDigest: providerSnapshot.definitionDigest,
  });
  const coreInput = executionInput(binding, {
    action: 'start',
    mode: 'single-shot',
  });
  const implementationRequest = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'fixture-runtime-request.v1' as const,
    role: 'investigator' as const,
    bindingDigest: binding.bindingDigest,
  });
  const extendedInput: FixtureStartInput = Object.freeze({
    ...coreInput,
    implementationRequest,
  });

  await runtime.probe(providerSnapshot);
  const events = await collect(runtime.start(providerSnapshot, extendedInput));
  assert.equal(events.at(-1)?.type, 'completed');
  assert.equal(driverStartCalls, 1);
  assert.deepEqual(observedDefinition, providerSnapshot);
  assert.deepEqual(observedRequest, implementationRequest);

  for (const invalid of [
    coreInput,
    { ...extendedInput, unexpected: true },
    {
      ...extendedInput,
      implementationRequest: {
        ...implementationRequest,
        bindingDigest: '0'.repeat(64),
      },
    },
  ]) {
    assert.throws(
      () =>
        runtime.start(
          providerSnapshot,
          invalid as unknown as FixtureStartInput,
        ),
      invalidContract,
    );
  }
  assert.equal(driverStartCalls, 1);
  assert.throws(
    () =>
      runtime.probe({
        ...providerSnapshot,
        commandProfile: 'fixture-tampered-v1',
      } as ProviderDefinitionSnapshot),
    /invalid/u,
  );
});

test('rejected thenables from synchronous admission and driver callbacks are observed before failure', async () => {
  assert.throws(
    () =>
      createHostObservedAgentRuntimePortV1({
        definition,
        admitDefinition: () =>
          rejectedValue<typeof definition>('admit definition rejection'),
        projectDefinitionIdentity: assertAgentRuntimeDefinitionIdentityV1,
        admitStartInput: assertAgentRuntimeStartInputV1,
        admitResumeInput: assertAgentRuntimeResumeInputV1,
        driver: inertDriver(),
      }),
    invalidContract,
  );
  assert.throws(
    () =>
      createHostObservedAgentRuntimePortV1({
        definition,
        admitDefinition: assertAgentRuntimeDefinitionIdentityV1,
        projectDefinitionIdentity: () =>
          rejectedValue<
            ReturnType<typeof assertAgentRuntimeDefinitionIdentityV1>
          >('project definition rejection'),
        admitStartInput: assertAgentRuntimeStartInputV1,
        admitResumeInput: assertAgentRuntimeResumeInputV1,
        driver: inertDriver(),
      }),
    invalidContract,
  );

  const rejectedAdmissionRuntime = createHostObservedAgentRuntimePortV1({
    definition,
    admitDefinition: assertAgentRuntimeDefinitionIdentityV1,
    projectDefinitionIdentity: assertAgentRuntimeDefinitionIdentityV1,
    admitStartInput: () =>
      rejectedValue<AgentRuntimeStartInputV1>('start admission rejection'),
    admitResumeInput: () =>
      rejectedValue<AgentRuntimeResumeInputV1>('resume admission rejection'),
    driver: inertDriver(),
  });
  await rejectedAdmissionRuntime.probe(definition);
  assert.throws(
    () =>
      rejectedAdmissionRuntime.start(
        definition,
        executionInput(attemptBinding('operation-rejected-start-admission'), {
          action: 'start',
          mode: 'single-shot',
        }),
      ),
    invalidContract,
  );
  const rejectedResumeNativeId = 'private-rejected-resume-admission';
  assert.throws(
    () =>
      rejectedAdmissionRuntime.resume(
        definition,
        executionInput(attemptBinding('operation-rejected-resume-admission'), {
          action: 'resume',
          mode: 'engine-supplied-native',
          nativeSessionId: rejectedResumeNativeId,
          nativeSessionIdDigest: agentRuntimeNativeSessionIdDigestV1(
            rejectedResumeNativeId,
          ),
          predecessorCompletionDigest: '8'.repeat(64),
          continuityToken: 'continuity-rejected-admission',
        }),
      ),
    invalidContract,
  );

  let rejectedDriverCancelCalls = 0;
  const rejectedDriverRuntime = createTestRuntime({
    definition,
    driver: {
      probe: async () => hostProbe(),
      start: () =>
        rejectedValue<AsyncIterable<AgentRuntimeDriverEventV1>>(
          'driver start rejection',
        ),
      resume: () =>
        rejectedValue<AsyncIterable<AgentRuntimeDriverEventV1>>(
          'driver resume rejection',
        ),
      cancel: async () => {
        rejectedDriverCancelCalls += 1;
        return { acknowledged: true, forced: false };
      },
    },
  });
  await rejectedDriverRuntime.probe(definition);
  const startEvents = await collect(
    rejectedDriverRuntime.start(
      definition,
      executionInput(attemptBinding('operation-rejected-driver-start'), {
        action: 'start',
        mode: 'single-shot',
      }),
    ),
  );
  assert.equal(startEvents.at(-1)?.type, 'failed');
  const rejectedDriverNativeId = 'private-rejected-driver-resume';
  const resumeEvents = await collect(
    rejectedDriverRuntime.resume(
      definition,
      executionInput(attemptBinding('operation-rejected-driver-resume'), {
        action: 'resume',
        mode: 'engine-supplied-native',
        nativeSessionId: rejectedDriverNativeId,
        nativeSessionIdDigest: agentRuntimeNativeSessionIdDigestV1(
          rejectedDriverNativeId,
        ),
        predecessorCompletionDigest: '8'.repeat(64),
        continuityToken: 'continuity-rejected-driver',
      }),
    ),
  );
  assert.equal(resumeEvents.at(-1)?.type, 'failed');
  assert.equal(rejectedDriverCancelCalls, 2);
});

test('factory captures admission and driver methods and rejects mutable admitted state', async () => {
  let replacementCalls = 0;
  let observedPrompt: string | null = null;
  const driver: AgentRuntimeDriverV1<typeof definition> = {
    probe: async () => hostProbe(),
    start(_snapshot, input) {
      observedPrompt = input.prompt;
      return successfulEvents(input, 'captured-driver-session', 'start');
    },
    resume(_snapshot, input) {
      return successfulEvents(input, input.nativeSessionId, 'resume');
    },
    cancel: async () => ({ acknowledged: true, forced: false }),
  };
  const options = {
    definition,
    admitDefinition: assertAgentRuntimeDefinitionIdentityV1,
    projectDefinitionIdentity: assertAgentRuntimeDefinitionIdentityV1,
    admitStartInput: assertAgentRuntimeStartInputV1,
    admitResumeInput: assertAgentRuntimeResumeInputV1,
    driver,
  };
  const runtime = createHostObservedAgentRuntimePortV1(options);
  options.admitDefinition = () => {
    replacementCalls += 1;
    throw new Error('replacement definition admission');
  };
  options.admitStartInput = () => {
    replacementCalls += 1;
    throw new Error('replacement input admission');
  };
  driver.probe = async () => {
    replacementCalls += 1;
    return hostProbe();
  };
  driver.start = (_snapshot, input) => {
    replacementCalls += 1;
    return successfulEvents(input, 'replacement-driver-session', 'start');
  };

  await runtime.probe(definition);
  const mutableInput = {
    ...executionInput(attemptBinding('operation-captured-methods'), {
      action: 'start',
      mode: 'single-shot',
    }),
  };
  const stream = runtime.start(definition, mutableInput);
  mutableInput.prompt = 'caller-mutated-after-start';
  const events = await collect(stream);
  assert.equal(events.at(-1)?.type, 'completed');
  assert.equal(observedPrompt, 'Return one fixture result.');
  assert.equal(replacementCalls, 0);

  let mutableDriverCalls = 0;
  const mutableAdmissionRuntime = createHostObservedAgentRuntimePortV1({
    definition,
    admitDefinition: assertAgentRuntimeDefinitionIdentityV1,
    projectDefinitionIdentity: assertAgentRuntimeDefinitionIdentityV1,
    admitStartInput(value) {
      const admitted = assertAgentRuntimeStartInputV1(value);
      return { ...admitted };
    },
    admitResumeInput: assertAgentRuntimeResumeInputV1,
    driver: {
      probe: async () => hostProbe(),
      start(_snapshot, input) {
        mutableDriverCalls += 1;
        return successfulEvents(input, 'mutable-admission-session', 'start');
      },
      resume(_snapshot, input) {
        return successfulEvents(input, input.nativeSessionId, 'resume');
      },
      cancel: async () => ({ acknowledged: true, forced: false }),
    },
  });
  await mutableAdmissionRuntime.probe(definition);
  assert.throws(
    () =>
      mutableAdmissionRuntime.start(
        definition,
        executionInput(attemptBinding('operation-mutable-admission'), {
          action: 'start',
          mode: 'single-shot',
        }),
      ),
    invalidContract,
  );
  assert.equal(mutableDriverCalls, 0);
});

function inertDriver(): AgentRuntimeDriverV1<typeof definition> {
  return {
    probe: async () => hostProbe(),
    start(_snapshot, input) {
      return successfulEvents(input, 'inert-driver-start', 'start');
    },
    resume(_snapshot, input) {
      return successfulEvents(input, input.nativeSessionId, 'resume');
    },
    cancel: async () => ({ acknowledged: true, forced: false }),
  };
}

function rejectedValue<T>(message: string): T {
  return Promise.reject(new Error(message)) as unknown as T;
}

async function* successfulEvents(
  input: AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1,
  nativeSessionId: string,
  action: 'start' | 'resume',
): AsyncGenerator<AgentRuntimeDriverEventV1> {
  yield { type: 'process-activity', activity: 'spawned', elapsedMs: 0 };
  yield { type: 'provider-activity', phase: 'model', elapsedMs: 1 };
  if (input.mode !== 'single-shot') {
    yield {
      type: 'session-started',
      nativeSessionId,
      continuityToken: 'continuity-start',
      protocolReceiptDigest: '6'.repeat(64),
      elapsedMs: 2,
    };
  }
  yield {
    type: 'semantic-progress',
    summary: `${action}-progress`,
    elapsedMs: 3,
  };
  yield {
    type: 'usage',
    basis: 'actual',
    inputTokens: 3,
    outputTokens: 5,
    costMicros: null,
    elapsedMs: 4,
  };
  yield completedDriverEvent({ ok: true, action }, 5);
}

function completedDriverEvent(
  output: unknown,
  elapsedMs: number,
): AgentRuntimeDriverEventV1 {
  return {
    type: 'completed',
    output,
    observation: {
      executable: executableIdentity(),
      providerVersion: 'test-driver-1.0.0',
      projection: {
        unchanged: true,
        changedCategories: [],
        beforeDigest: '7'.repeat(64),
        afterDigest: '7'.repeat(64),
      },
      residuals: [],
      protocolEvidence: null,
    },
    elapsedMs,
  };
}

type FixtureImplementationRequest = Readonly<{
  schemaVersion: 1;
  kind: 'fixture-runtime-request.v1';
  role: 'investigator';
  bindingDigest: string;
}>;

type FixtureStartInput = AgentRuntimeStartInputV1 &
  Readonly<{ implementationRequest: FixtureImplementationRequest }>;

type FixtureResumeInput = AgentRuntimeResumeInputV1 &
  Readonly<{ implementationRequest: FixtureImplementationRequest }>;

function admitFixtureStartInput(value: unknown): FixtureStartInput {
  return admitFixtureInput(value, 'start') as FixtureStartInput;
}

function admitFixtureResumeInput(value: unknown): FixtureResumeInput {
  return admitFixtureInput(value, 'resume') as FixtureResumeInput;
}

function admitFixtureInput(
  value: unknown,
  action: 'start' | 'resume',
): FixtureStartInput | FixtureResumeInput {
  if (!isRecord(value)) throw new AgentRuntimePortContractError();
  const coreKeys =
    action === 'start'
      ? [
          'action',
          'mode',
          'binding',
          'repositoryRoot',
          'workingDirectory',
          'runtimeDirectory',
          'prompt',
          'output',
          'governedInputs',
          'limits',
          'privateSessionIdentitySink',
        ]
      : [
          'action',
          'mode',
          'binding',
          'repositoryRoot',
          'workingDirectory',
          'runtimeDirectory',
          'prompt',
          'output',
          'governedInputs',
          'limits',
          'privateSessionIdentitySink',
          'nativeSessionId',
          'nativeSessionIdDigest',
          'predecessorCompletionDigest',
          'continuityToken',
        ];
  if (!hasExactKeys(value, [...coreKeys, 'implementationRequest'])) {
    throw new AgentRuntimePortContractError();
  }
  const implementationRequest = value.implementationRequest;
  if (
    !isRecord(implementationRequest) ||
    !hasExactKeys(implementationRequest, [
      'schemaVersion',
      'kind',
      'role',
      'bindingDigest',
    ]) ||
    implementationRequest.schemaVersion !== 1 ||
    implementationRequest.kind !== 'fixture-runtime-request.v1' ||
    implementationRequest.role !== 'investigator'
  ) {
    throw new AgentRuntimePortContractError();
  }
  const { implementationRequest: _request, ...core } = value;
  const admittedCore =
    action === 'start'
      ? assertAgentRuntimeStartInputV1(core)
      : assertAgentRuntimeResumeInputV1(core);
  if (
    implementationRequest.bindingDigest !== admittedCore.binding.bindingDigest
  ) {
    throw new AgentRuntimePortContractError();
  }
  return Object.freeze({
    ...admittedCore,
    implementationRequest: Object.freeze({
      schemaVersion: 1,
      kind: 'fixture-runtime-request.v1',
      role: 'investigator',
      bindingDigest: implementationRequest.bindingDigest,
    }),
  }) as FixtureStartInput | FixtureResumeInput;
}

function hostProbe() {
  return {
    status: 'ready' as const,
    executableIdentity: executableIdentity(),
    providerVersion: 'test-driver-1.0.0',
    authentication: 'authenticated' as const,
    capabilities,
  };
}

function executableIdentity() {
  return {
    candidatePath: '/fixture/bin/provider',
    realPath: '/fixture/bin/provider',
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '123456789',
    sha256: '9'.repeat(64),
  };
}

function attemptBinding(
  operationId: string,
  overrides: Partial<AgentRuntimeAttemptBindingV1> = {},
) {
  return createAgentRuntimeAttemptBindingV1({
    operationId,
    workflowId: 'workflow-test',
    workflowEpoch: 1,
    workflowContextDigest: 'b'.repeat(64),
    jobId: 'job-test',
    attemptId: `attempt-${operationId}`,
    leaseGeneration: 1,
    engineSessionId: 'engine-session-test',
    invocationId: `invocation-${operationId}`,
    requestDigest: 'c'.repeat(64),
    providerProfileId: 'test-profile',
    providerProfileDigest: '7'.repeat(64),
    executableCandidate: '/fixture/bin/provider',
    definitionDigest: overrides.definitionDigest ?? definition.definitionDigest,
    dataAuthorizationPolicyDigest: 'd'.repeat(64),
    inputManifestDigest: 'e'.repeat(64),
    targetDigest: 'f'.repeat(64),
    assignmentDigest: '1'.repeat(64),
    outputSchemaDigest: agentRuntimeOutputSchemaDigestV1(outputSchema),
    effect: 'repository-read-only',
    ...(overrides.leaseGeneration === undefined
      ? {}
      : { leaseGeneration: overrides.leaseGeneration }),
  });
}

type StartVariant = Readonly<{
  action: 'start';
  mode: 'single-shot' | 'provider-observed-native';
  privateSessionIdentitySink?: (
    identity: AgentRuntimePrivateSessionIdentityV1,
  ) => void;
  limits?: Partial<{
    timeoutMs: number;
    aggregateOutputBytes: number;
    maxEventCount: number;
  }>;
}>;

type ResumeVariant = Readonly<{
  action: 'resume';
  mode: 'engine-supplied-native';
  nativeSessionId: string;
  nativeSessionIdDigest: string;
  predecessorCompletionDigest: string;
  continuityToken: string | null;
}>;

function executionInput(
  binding: AgentRuntimeAttemptBindingV1,
  variant: StartVariant,
): AgentRuntimeStartInputV1;
function executionInput(
  binding: AgentRuntimeAttemptBindingV1,
  variant: ResumeVariant,
): AgentRuntimeResumeInputV1;
function executionInput(
  binding: AgentRuntimeAttemptBindingV1,
  variant: StartVariant | ResumeVariant,
): AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1 {
  const limitOverrides = 'limits' in variant ? variant.limits : undefined;
  const common = {
    binding,
    repositoryRoot: '/fixture/repository',
    workingDirectory: '/fixture/repository',
    runtimeDirectory: '/fixture/runtime',
    prompt: 'Return one fixture result.',
    output: {
      slot: 'primary' as const,
      schema: outputSchema,
      validate: (value: unknown) =>
        typeof value === 'object' && value !== null && 'ok' in value,
    },
    governedInputs: [
      {
        id: 'repository',
        path: '/fixture/repository',
        kind: 'directory-closure' as const,
        expectedFiles: ['input.json'],
        mutableContentPaths: [],
      },
    ],
    limits: {
      timeoutMs: 2_000,
      aggregateOutputBytes: 16_384,
      maxEventCount: limitOverrides?.maxEventCount ?? 32,
      ...(limitOverrides?.timeoutMs === undefined
        ? {}
        : { timeoutMs: limitOverrides.timeoutMs }),
      ...(limitOverrides?.aggregateOutputBytes === undefined
        ? {}
        : { aggregateOutputBytes: limitOverrides.aggregateOutputBytes }),
    },
    privateSessionIdentitySink:
      'privateSessionIdentitySink' in variant
        ? (variant.privateSessionIdentitySink ?? (() => {}))
        : () => {},
  };
  return variant.action === 'start'
    ? { ...common, action: 'start' as const, mode: variant.mode }
    : {
        ...common,
        action: 'resume' as const,
        mode: 'engine-supplied-native' as const,
        nativeSessionId: variant.nativeSessionId,
        nativeSessionIdDigest: variant.nativeSessionIdDigest,
        predecessorCompletionDigest: variant.predecessorCompletionDigest,
        continuityToken: variant.continuityToken,
      };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function isTerminal(event: { type: string }): boolean {
  return ['completed', 'failed', 'cancelled'].includes(event.type);
}

function invalidContract(error: unknown): boolean {
  return (
    error instanceof AgentRuntimePortContractError &&
    error.code === 'AGENT_RUNTIME_PORT_INVALID'
  );
}
function operationConflict(error: unknown): boolean {
  return (
    error instanceof AgentRuntimeOperationConflictError &&
    error.code === 'AGENT_RUNTIME_OPERATION_CONFLICT'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
