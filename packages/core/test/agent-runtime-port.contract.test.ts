import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  AGENT_RUNTIME_OUTPUT_SCHEMA_DIGEST_V1_GRAMMAR,
  AgentRuntimePortContractError,
  agentRuntimeNativeSessionIdDigestV1,
  agentRuntimeOutputSchemaDigestV1,
  assertAgentRuntimeAttemptBindingV1,
  assertAgentRuntimeDefinitionIdentityV1,
  assertAgentRuntimeProbeEvidenceV1,
  assertAgentRuntimeUnavailableDefinitionIdentityV1,
  assertAgentRuntimeStartInputV1,
  createAgentRuntimeAttemptBindingV1,
  createAgentRuntimeCapabilitiesV1,
  createAgentRuntimeEventV1,
  createAgentRuntimeProbeEvidenceV1,
  createAgentRuntimeUnavailableDefinitionIdentityV1,
  createHostObservedProviderProbeEvidenceAdmissionPortV1,
  createSyntheticFixtureProviderProbeEvidenceAdmissionPortV1,
  type AgentRuntimeDefinitionIdentityV1,
  type AgentRuntimeEventV1,
  type AgentRuntimePortV1,
  type AgentRuntimeResumeInputV1,
  type AgentRuntimeStartInputV1,
  type AgentRuntimeUnavailableDefinitionIdentityV1,
  type ProviderProbeEvidenceAdmissionPortV1,
} from '../src/agent-runtime-port.ts';

type IsAssignable<From, To> = [From] extends [To] ? true : false;

type ProjectedUnavailableDefinitionIdentityV1 = Pick<
  AgentRuntimeUnavailableDefinitionIdentityV1,
  'schemaVersion' | 'kind' | 'providerFamily' | 'protocol' | 'definitionDigest'
>;

type BrandedUnavailableDefinitionIdentityV1 = AgentRuntimeDefinitionIdentityV1 &
  ProjectedUnavailableDefinitionIdentityV1;

type UnavailableOnlyRuntimeCalls = {
  start(
    snapshot: BrandedUnavailableDefinitionIdentityV1,
    input: AgentRuntimeStartInputV1,
  ): AsyncIterable<AgentRuntimeEventV1>;
  resume(
    snapshot: BrandedUnavailableDefinitionIdentityV1,
    input: AgentRuntimeResumeInputV1,
  ): AsyncIterable<AgentRuntimeEventV1>;
};

const definition = {
  schemaVersion: 1,
  kind: 'fixture-agent-definition.v1',
  providerFamily: 'fixture',
  protocol: 'fixture-jsonl-v1',
  definitionDigest: 'a'.repeat(64),
} as const;

const capabilitiesInput = {
  structuredStreaming: true,
  structuredOutput: true,
  resumableAfterTurn: true,
  forkable: false,
  reattachableInFlight: false,
  cancellationAck: true,
  usageReporting: 'actual' as const,
};

const outputSchema = { type: 'object' } as const;
const executableIdentity = {
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

const bindingInput = {
  operationId: 'operation-fixture-1',
  workflowId: 'workflow-fixture-1',
  workflowEpoch: 3,
  workflowContextDigest: 'b'.repeat(64),
  jobId: 'job-fixture-1',
  attemptId: 'attempt-fixture-1',
  leaseGeneration: 2,
  engineSessionId: 'engine-session-fixture-1',
  invocationId: 'invocation-fixture-1',
  requestDigest: 'c'.repeat(64),
  providerProfileId: 'fixture-primary',
  providerProfileDigest: '7'.repeat(64),
  executableCandidate: '/fixture/bin/provider',
  definitionDigest: definition.definitionDigest,
  dataAuthorizationPolicyDigest: 'd'.repeat(64),
  inputManifestDigest: 'e'.repeat(64),
  targetDigest: 'f'.repeat(64),
  assignmentDigest: '1'.repeat(64),
  outputSchemaDigest: agentRuntimeOutputSchemaDigestV1(outputSchema),
  effect: 'repository-read-only' as const,
};

test('core owns exact, immutable definition, capability, probe, and Attempt binding DTOs', () => {
  const admittedDefinition = assertAgentRuntimeDefinitionIdentityV1(definition);
  const capabilities = createAgentRuntimeCapabilitiesV1(capabilitiesInput);
  const replayCapabilities =
    createAgentRuntimeCapabilitiesV1(capabilitiesInput);
  const binding = createAgentRuntimeAttemptBindingV1(bindingInput);
  const replayBinding = createAgentRuntimeAttemptBindingV1(bindingInput);
  const probe = createAgentRuntimeProbeEvidenceV1({
    authority: 'observation-only',
    observationClass: 'synthetic-fixture',
    definition: admittedDefinition,
    status: 'ready',
    executableIdentity,
    providerVersion: 'fixture-1.0.0',
    authentication: 'not-observed',
    capabilities,
  });

  assert.deepEqual(capabilities, replayCapabilities);
  assert.deepEqual(binding, replayBinding);
  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.kind, 'agent-runtime-capabilities.v1');
  assert.match(capabilities.capabilityDigest, /^[0-9a-f]{64}$/u);
  assert.equal(binding.schemaVersion, 1);
  assert.equal(binding.kind, 'agent-runtime-attempt-binding.v1');
  assert.equal(binding.providerProfileDigest, '7'.repeat(64));
  assert.equal(binding.executableCandidate, '/fixture/bin/provider');
  assert.match(binding.bindingDigest, /^[0-9a-f]{64}$/u);
  assert.equal(probe.kind, 'agent-runtime-probe-evidence.v1');
  assert.equal(probe.authority, 'observation-only');
  assert.equal(probe.definition, admittedDefinition);
  assert.equal(probe.providerFamily, definition.providerFamily);
  assert.equal(probe.protocol, definition.protocol);
  assert.match(probe.evidenceDigest, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(probe), true);
  assert.deepEqual(Object.getOwnPropertySymbols(admittedDefinition), []);

  assert.deepEqual(assertAgentRuntimeAttemptBindingV1(binding), binding);
  assert.deepEqual(assertAgentRuntimeProbeEvidenceV1(probe), probe);
  assert.throws(
    () =>
      assertAgentRuntimeDefinitionIdentityV1({ ...definition, extra: true }),
    invalidContract,
  );
  assert.throws(
    () =>
      assertAgentRuntimeAttemptBindingV1({
        ...binding,
        effect: 'repository-write',
      }),
    invalidContract,
  );
  assert.throws(
    () =>
      assertAgentRuntimeProbeEvidenceV1({
        ...probe,
        authority: 'availability-authority',
      }),
    invalidContract,
  );
});

test('probe state relationships fail closed and raw native session identity has only a digest projection', () => {
  const capabilities = createAgentRuntimeCapabilitiesV1(capabilitiesInput);
  assert.throws(
    () =>
      createAgentRuntimeProbeEvidenceV1({
        authority: 'observation-only',
        observationClass: 'host-observed',
        definition,
        status: 'ready',
        executableIdentity: null,
        providerVersion: '1.0.0',
        authentication: 'authenticated',
        capabilities,
      }),
    invalidContract,
  );
  assert.throws(
    () =>
      createAgentRuntimeProbeEvidenceV1({
        authority: 'observation-only',
        observationClass: 'synthetic-fixture',
        definition,
        status: 'unauthenticated',
        executableIdentity,
        providerVersion: 'fixture-1.0.0',
        authentication: 'authenticated',
        capabilities,
      }),
    invalidContract,
  );

  const rawNativeSessionId = 'fixture-private-native-session';
  const digest = agentRuntimeNativeSessionIdDigestV1(rawNativeSessionId);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(digest.includes(rawNativeSessionId), false);
  assert.throws(() => agentRuntimeNativeSessionIdDigestV1(''), invalidContract);
});

test('unavailable definition identity is exact, status-bound, and never launchable', () => {
  const unavailableIsLaunchIdentity: IsAssignable<
    AgentRuntimeUnavailableDefinitionIdentityV1,
    AgentRuntimeDefinitionIdentityV1
  > = false;
  const unavailableFitsDefaultRuntime: IsAssignable<
    AgentRuntimeUnavailableDefinitionIdentityV1,
    Parameters<AgentRuntimePortV1['start']>[0]
  > = false;
  const unavailableFitsDefaultResume: IsAssignable<
    AgentRuntimeUnavailableDefinitionIdentityV1,
    Parameters<AgentRuntimePortV1['resume']>[0]
  > = false;
  const projectedUnavailableIsLaunchIdentity: IsAssignable<
    ProjectedUnavailableDefinitionIdentityV1,
    AgentRuntimeDefinitionIdentityV1
  > = false;
  type UnavailableDefinition = AgentRuntimeUnavailableDefinitionIdentityV1;
  // @ts-expect-error unavailable identities must not instantiate a launch port
  type RejectedUnavailablePort = AgentRuntimePortV1<UnavailableDefinition>;
  const rejectedExplicitUnavailablePort: RejectedUnavailablePort | null = null;
  const unavailableOnlyCallsFitLaunchPort: IsAssignable<
    UnavailableOnlyRuntimeCalls,
    Pick<AgentRuntimePortV1, 'start' | 'resume'>
  > = false;
  const disabled = createAgentRuntimeUnavailableDefinitionIdentityV1({
    providerFamily: 'fixture',
    status: 'host-disabled',
  });
  const unsupported = createAgentRuntimeUnavailableDefinitionIdentityV1({
    providerFamily: 'fixture',
    status: 'unsupported-platform',
  });

  assert.deepEqual(
    assertAgentRuntimeUnavailableDefinitionIdentityV1(disabled),
    disabled,
  );
  assert.equal(unavailableIsLaunchIdentity, false);
  assert.equal(unavailableFitsDefaultRuntime, false);
  assert.equal(unavailableFitsDefaultResume, false);
  assert.equal(projectedUnavailableIsLaunchIdentity, false);
  assert.equal(rejectedExplicitUnavailablePort, null);
  assert.equal(unavailableOnlyCallsFitLaunchPort, false);
  assert.deepEqual(Object.getOwnPropertySymbols(disabled), []);
  assert.equal(disabled.kind, 'unavailable-agent-runtime-definition.v1');
  assert.equal(disabled.protocol, 'unavailable-host-disabled-v1');
  assert.equal(
    disabled.definitionDigest,
    'e5a261519848aab4ffd9eb4b6a3e24ee955922b077ad8f835320f71d00c46d6b',
  );
  assert.equal(unsupported.protocol, 'unavailable-unsupported-platform-v1');
  assert.notEqual(disabled.definitionDigest, unsupported.definitionDigest);
  assert.throws(
    () => assertAgentRuntimeDefinitionIdentityV1(disabled),
    invalidContract,
  );
  assert.throws(
    () =>
      assertAgentRuntimeUnavailableDefinitionIdentityV1({
        ...disabled,
        protocol: 'unavailable-unsupported-platform-v1',
      }),
    invalidContract,
  );
  assert.throws(
    () =>
      createAgentRuntimeUnavailableDefinitionIdentityV1({
        providerFamily: 'fixture',
        status: 'absent' as never,
      }),
    invalidContract,
  );
});

test('host probe evidence enforces the complete status fact matrix', () => {
  const capabilities = createAgentRuntimeCapabilitiesV1(capabilitiesInput);
  const hostPort = createHostObservedProviderProbeEvidenceAdmissionPortV1();
  const unavailable = createAgentRuntimeUnavailableDefinitionIdentityV1({
    providerFamily: 'fixture',
    status: 'host-disabled',
  });
  const disabled = createAgentRuntimeProbeEvidenceV1({
    authority: 'observation-only',
    observationClass: 'host-observed',
    definition: unavailable,
    status: 'host-disabled',
    executableIdentity: null,
    providerVersion: null,
    authentication: 'not-observed',
    capabilities: null,
  });

  assert.deepEqual(hostPort.admit(disabled), disabled);
  for (const mutation of [
    { executableIdentity },
    { providerVersion: 'forged-version' },
    { authentication: 'authenticated' as const },
    { capabilities },
    { status: 'unsupported-platform' as const },
  ]) {
    assert.throws(
      () =>
        createAgentRuntimeProbeEvidenceV1({
          authority: 'observation-only',
          observationClass: 'host-observed',
          definition: unavailable,
          status: 'host-disabled',
          executableIdentity: null,
          providerVersion: null,
          authentication: 'not-observed',
          capabilities: null,
          ...mutation,
        }),
      invalidContract,
    );
  }

  for (const status of [
    'unsupported-platform',
    'absent',
    'unsafe-candidate',
  ] as const) {
    assert.throws(
      () =>
        createAgentRuntimeProbeEvidenceV1({
          authority: 'observation-only',
          observationClass: 'host-observed',
          definition,
          status,
          executableIdentity,
          providerVersion: 'forged-version',
          authentication: 'authenticated',
          capabilities,
        }),
      invalidContract,
    );
  }

  assert.throws(
    () =>
      createAgentRuntimeProbeEvidenceV1({
        authority: 'observation-only',
        observationClass: 'host-observed',
        definition,
        status: 'incompatible',
        executableIdentity: null,
        providerVersion: null,
        authentication: 'not-observed',
        capabilities: null,
      }),
    invalidContract,
  );
  assert.doesNotThrow(() =>
    createAgentRuntimeProbeEvidenceV1({
      authority: 'observation-only',
      observationClass: 'host-observed',
      definition,
      status: 'incompatible',
      executableIdentity,
      providerVersion: null,
      authentication: 'not-observed',
      capabilities: null,
    }),
  );
});

test('provider probe evidence admission is synchronous, pure, and observation-class bound', () => {
  const capabilities = createAgentRuntimeCapabilitiesV1(capabilitiesInput);
  const hostEvidence = createAgentRuntimeProbeEvidenceV1({
    authority: 'observation-only',
    observationClass: 'host-observed',
    definition,
    status: 'ready',
    executableIdentity,
    providerVersion: 'host-1.0.0',
    authentication: 'authenticated',
    capabilities,
  });
  const syntheticEvidence = createAgentRuntimeProbeEvidenceV1({
    authority: 'observation-only',
    observationClass: 'synthetic-fixture',
    definition,
    status: 'ready',
    executableIdentity,
    providerVersion: 'fixture-1.0.0',
    authentication: 'not-observed',
    capabilities,
  });
  const hostPort: ProviderProbeEvidenceAdmissionPortV1 =
    createHostObservedProviderProbeEvidenceAdmissionPortV1();
  const fixturePort: ProviderProbeEvidenceAdmissionPortV1 =
    createSyntheticFixtureProviderProbeEvidenceAdmissionPortV1();

  assert.deepEqual(Object.keys(hostPort), ['admit']);
  assert.deepEqual(Object.keys(fixturePort), ['admit']);
  assert.deepEqual(hostPort.admit(hostEvidence), hostEvidence);
  assert.deepEqual(fixturePort.admit(syntheticEvidence), syntheticEvidence);
  assert.throws(() => hostPort.admit(syntheticEvidence), invalidContract);
  assert.throws(() => fixturePort.admit(hostEvidence), invalidContract);
  assert.throws(
    () =>
      hostPort.admit({
        ...hostEvidence,
        decision: 'available',
      } as never),
    invalidContract,
  );
  assert.equal(Object.isFrozen(hostPort), true);
  assert.equal(Object.isFrozen(fixturePort), true);
});

test('AgentRuntimePortV1 exposes only probe/start/resume/cancel execution capabilities', () => {
  const unused: AgentRuntimePortV1 = {
    contractVersion: 'jigwright.agent-runtime-port.v1',
    probe: async () => {
      throw new Error('not invoked');
    },
    start: () => emptyEvents(),
    resume: () => emptyEvents(),
    cancel: async () => {
      throw new Error('not invoked');
    },
  };
  assert.deepEqual(Object.keys(unused).sort(), [
    'cancel',
    'contractVersion',
    'probe',
    'resume',
    'start',
  ]);
});

test('turn input binds the exact output schema and directory closure', () => {
  const binding = createAgentRuntimeAttemptBindingV1(bindingInput);
  const input = {
    action: 'start' as const,
    mode: 'single-shot' as const,
    binding,
    repositoryRoot: '/fixture/repository',
    workingDirectory: '/fixture/repository',
    runtimeDirectory: '/fixture/runtime',
    prompt: 'fixture prompt',
    output: {
      slot: 'primary' as const,
      schema: outputSchema,
      validate: () => true,
    },
    governedInputs: [
      {
        id: 'repository',
        path: '/fixture/repository',
        kind: 'directory-closure' as const,
        expectedFiles: ['input.json', 'output.json'],
        mutableContentPaths: ['output.json'],
      },
    ],
    limits: {
      timeoutMs: 1_000,
      aggregateOutputBytes: 8_192,
      maxEventCount: 16,
    },
    privateSessionIdentitySink: () => undefined,
  };
  assert.equal(assertAgentRuntimeStartInputV1(input).binding, binding);
  assert.equal(AGENT_RUNTIME_OUTPUT_SCHEMA_DIGEST_V1_GRAMMAR, '^[0-9a-f]{64}$');
  assert.throws(
    () =>
      assertAgentRuntimeStartInputV1({
        ...input,
        binding: createAgentRuntimeAttemptBindingV1({
          ...bindingInput,
          outputSchemaDigest: '0'.repeat(64),
        }),
      }),
    invalidContract,
  );
  for (const expectedFile of [
    'file.txt:stream',
    'CON',
    'con.txt',
    'COM1.log',
    'CON .txt',
    'CONIN$',
    'CONOUT$.log',
    'COM¹',
    'LPT².txt',
    'dir/file.',
    'dir /file',
    'file?.txt',
  ]) {
    assert.throws(
      () =>
        assertAgentRuntimeStartInputV1({
          ...input,
          repositoryRoot: 'C:\\Repo',
          workingDirectory: 'C:\\Repo',
          runtimeDirectory: 'C:\\runtime',
          governedInputs: [
            {
              id: 'repository',
              path: 'C:\\Repo',
              kind: 'directory-closure',
              expectedFiles: [expectedFile],
              mutableContentPaths: [],
            },
          ],
        }),
      invalidContract,
    );
  }
  assert.throws(
    () =>
      assertAgentRuntimeStartInputV1({
        ...input,
        governedInputs: [
          {
            ...input.governedInputs[0],
            mutableContentPaths: ['not-in-closure.json'],
          },
        ],
      }),
    invalidContract,
  );

  for (const invalidPath of [
    '/fixture/repository/../outside',
    '/fixture//repository',
    '/fixture/repository/./file',
    '/fixture/repository/',
    'C:\\repo\\..\\outside',
    'C:\\repo\\\\work',
    'C:\\repo\\work\\',
    '\\\\?\\C:\\repo',
    '\\\\.\\pipe\\foo',
    'C:\\repo\\file.txt:stream',
    'C:\\repo\\CON',
    'C:\\repo\\con.txt',
    'C:\\repo\\COM1.log',
    'C:\\repo\\CON .txt',
    'C:\\repo\\CONIN$',
    'C:\\repo\\CONOUT$.log',
    'C:\\repo\\COM¹',
    'C:\\repo\\LPT².txt',
    'C:\\repo\\NUL.json',
    'C:\\repo\\dir.\\file',
    'C:\\repo\\dir \\file',
    'C:\\repo\\file?.txt',
  ]) {
    assert.throws(
      () =>
        assertAgentRuntimeStartInputV1({
          ...input,
          repositoryRoot: invalidPath,
        }),
      invalidContract,
    );
  }
  assert.throws(
    () =>
      assertAgentRuntimeStartInputV1({
        ...input,
        governedInputs: [
          {
            ...input.governedInputs[0],
            expectedFiles: ['./output.json'],
            mutableContentPaths: [],
          },
        ],
      }),
    invalidContract,
  );
  for (const workingDirectory of [
    '/fixture/unrelated',
    '/fixture/repository-sibling',
    'C:\\fixture\\repository',
  ]) {
    assert.throws(
      () =>
        assertAgentRuntimeStartInputV1({
          ...input,
          workingDirectory,
        }),
      invalidContract,
    );
  }
  assert.throws(
    () =>
      assertAgentRuntimeStartInputV1({
        ...input,
        governedInputs: [
          { id: 'one', path: '/fixture/repository/file' },
          { id: 'two', path: '/fixture/repository/./file' },
        ],
      }),
    invalidContract,
  );
  assert.throws(
    () =>
      assertAgentRuntimeStartInputV1({
        ...input,
        repositoryRoot: 'C:\\Repo',
        workingDirectory: 'C:\\repo\\work',
        runtimeDirectory: 'C:\\runtime',
        governedInputs: [
          { id: 'one', path: 'C:\\Repo\\File' },
          { id: 'two', path: 'C:\\repo\\file' },
        ],
      }),
    invalidContract,
  );
  assert.throws(
    () =>
      assertAgentRuntimeStartInputV1({
        ...input,
        repositoryRoot: 'C:\\Repo',
        workingDirectory: 'C:\\repo\\work',
        runtimeDirectory: 'C:\\runtime',
        governedInputs: [
          {
            id: 'repository',
            path: 'C:\\Repo',
            kind: 'directory-closure',
            expectedFiles: ['Output.json', 'output.json'],
            mutableContentPaths: [],
          },
        ],
      }),
    invalidContract,
  );
  assert.equal(
    assertAgentRuntimeStartInputV1({
      ...input,
      repositoryRoot: 'C:\\Repo',
      workingDirectory: 'C:\\repo\\work',
      runtimeDirectory: 'C:\\runtime',
      governedInputs: [
        {
          id: 'repository',
          path: 'C:\\Repo',
          kind: 'directory-closure',
          expectedFiles: ['input.json'],
          mutableContentPaths: [],
        },
      ],
    }).repositoryRoot,
    'C:\\Repo',
  );
});

test('ephemeral events expose bounded observations without engine identity or raw session fields', () => {
  const completed = createAgentRuntimeEventV1({
    type: 'completed',
    output: { ok: true },
    observation: {
      observationClass: 'host-observed',
      definitionDigest: definition.definitionDigest,
      executable: executableIdentity,
      providerVersion: '1.0.0',
      assurance: 'unchanged-governed-projection',
      projection: {
        unchanged: true,
        changedCategories: [],
        beforeDigest: '3'.repeat(64),
        afterDigest: '3'.repeat(64),
      },
      sameUserProcessConfined: false,
      residuals: [],
      protocolEvidence: null,
    },
    elapsedMs: 7,
  });
  const session = createAgentRuntimeEventV1({
    type: 'session-started',
    action: 'start',
    nativeSessionIdDigest: '4'.repeat(64),
    continuityTokenDigest: '5'.repeat(64),
    protocolReceiptDigest: '6'.repeat(64),
    elapsedMs: 2,
  });
  const usage = createAgentRuntimeEventV1({
    type: 'usage',
    basis: 'reservation-only',
    inputTokens: null,
    outputTokens: null,
    costMicros: 100,
    elapsedMs: 3,
  });

  assert.deepEqual(Object.keys(completed).sort(), [
    'elapsedMs',
    'observation',
    'output',
    'outputSlot',
    'schemaVersion',
    'type',
  ]);
  assert.equal(
    ['operationId', 'bindingDigest', 'sequence', 'nativeSessionId'].some(
      (key) => key in completed || key in session,
    ),
    false,
  );
  assert.equal(session.type, 'session-started');
  assert.equal(usage.type, 'usage');
  assert.equal(completed.type, 'completed');
  if (session.type !== 'session-started') assert.fail('wrong event type');
  if (usage.type !== 'usage') assert.fail('wrong event type');
  if (completed.type !== 'completed') assert.fail('wrong event type');
  assert.equal(session.nativeSessionIdDigest, '4'.repeat(64));
  assert.equal(usage.basis, 'reservation-only');
  assert.equal(Object.isFrozen(completed.observation.projection), true);
  assert.throws(
    () =>
      createAgentRuntimeEventV1({
        type: 'completed',
        output: { ok: true },
        observation: {
          ...completed.observation,
          projection: {
            ...completed.observation.projection,
            afterDigest: '7'.repeat(64),
          },
        },
        elapsedMs: 8,
      }),
    invalidContract,
  );
});

test('core source remains implementation, provider, and authority neutral', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/agent-runtime-port.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /\b(?:codex|claude|child_process|authorize|grant|store)\b/iu,
  );
  assert.doesNotMatch(source, /runSingleShot|spawn\s*\(/u);
});

function emptyEvents() {
  return (async function* () {})();
}

function invalidContract(error: unknown): boolean {
  return (
    error instanceof AgentRuntimePortContractError &&
    error.code === 'AGENT_RUNTIME_PORT_INVALID'
  );
}
