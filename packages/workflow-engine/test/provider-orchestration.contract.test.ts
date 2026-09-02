import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  listBuiltInProviderCapabilityDescriptors,
  listBuiltInProviderFamilies,
} from '@jigwright/agent-runtime';

import { resolveActorIdentity } from '../src/modules/provider-orchestration/actor-identity.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createProviderInvocationRequest,
  evaluateProviderProcess,
  MAX_PROVIDER_LIMITS,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  listBuiltInProviders,
  requireProviderCapability,
} from '../src/modules/provider-orchestration/provider-registry.ts';
import {
  admitRoleResult,
  assertAdmittedRoleResultRecord,
  assessRoleIndependence,
  scheduleOrdinaryRole,
  type GrantedSameProviderRoleAssignment,
  type ProviderRoleAssignment,
  type RoleAssignment,
  type RoleParticipant,
} from '../src/modules/provider-orchestration/role-scheduler.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

const DIGESTS = {
  authorization: '1'.repeat(64),
  baseTree: '2'.repeat(40),
  target: '3'.repeat(64),
  manifest: '4'.repeat(64),
  outputSchema: '5'.repeat(64),
  policy: '6'.repeat(64),
} as const;

test('built-in provider registry is exact, immutable, and capability-scoped', () => {
  const providers = listBuiltInProviders();

  assert.deepEqual(providers, [
    {
      id: 'codex',
      capabilities: [
        {
          purpose: 'survey',
          profile: 'repository-read-only',
        },
        {
          purpose: 'plan-review',
          profile: 'repository-read-only',
        },
        {
          purpose: 'task-implementation',
          profile: 'repository-read-only',
        },
        {
          purpose: 'task-diff-review',
          profile: 'repository-read-only',
        },
      ],
    },
    {
      id: 'claude',
      capabilities: [
        {
          purpose: 'survey',
          profile: 'repository-read-only',
        },
        {
          purpose: 'plan-review',
          profile: 'repository-read-only',
        },
        {
          purpose: 'task-implementation',
          profile: 'repository-read-only',
        },
        {
          purpose: 'task-diff-review',
          profile: 'repository-read-only',
        },
      ],
    },
  ]);
  assert.equal(Object.isFrozen(providers), true);
  assert.equal(Object.isFrozen(providers[0]), true);
  assert.equal(Object.isFrozen(providers[0]?.capabilities), true);
  assert.equal(Object.isFrozen(providers[0]?.capabilities[0]), true);
  assert.strictEqual(listBuiltInProviders(), providers);
  assert.deepEqual(
    providers.map(({ id }) => id),
    listBuiltInProviderFamilies(),
  );
  assert.deepEqual(
    providers,
    listBuiltInProviderCapabilityDescriptors().map(
      ({ providerFamily: id, capabilities }) => ({ id, capabilities }),
    ),
  );

  const registrySource = fs.readFileSync(
    new URL(
      '../src/modules/provider-orchestration/provider-registry.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(registrySource, /from '@jigwright\/agent-runtime';/u);
  assert.doesNotMatch(
    registrySource,
    /export type ProviderId\s*=\s*['"]codex['"]\s*\|\s*['"]claude['"]/u,
  );
  assert.doesNotMatch(
    registrySource,
    /\[\s*['"]codex['"]\s*,\s*['"]claude['"]\s*\]/u,
  );
  assert.doesNotMatch(registrySource, /function readOnlyCapabilities\(/u);
  assert.doesNotMatch(
    registrySource,
    /export type CapabilityPurpose\s*=\s*['"]survey['"]/u,
  );

  assert.equal(
    requireProviderCapability('claude', 'plan-review', 'repository-read-only')
      .id,
    'claude',
  );
  assert.throws(
    () =>
      requireProviderCapability(
        'unknown' as 'codex',
        'survey',
        'repository-read-only',
      ),
    (error) => isWorkflowError(error, 'PROVIDER_UNKNOWN'),
  );
  assert.throws(
    () =>
      requireProviderCapability(
        'codex',
        'implementation' as 'survey',
        'repository-read-only',
      ),
    (error) => isWorkflowError(error, 'PROVIDER_CAPABILITY_UNSUPPORTED'),
  );
});

test('actor resolution preserves all agreeing soft signals and their grade', () => {
  const result = resolveActorIdentity({
    explicitActor: 'claude',
    environment: {
      AGENT: 'claude',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      PATH: '/tmp/fake-provider-bin',
    },
  });

  assert.deepEqual(result, {
    outcome: 'resolved',
    actor: {
      providerId: 'claude',
      assurance: 'runtime-hint',
    },
    signals: [
      {
        source: 'explicit',
        name: '--actor',
        providerId: 'claude',
        assurance: 'self-declared',
      },
      {
        source: 'runtime-hint',
        name: 'AGENT',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDECODE',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDE_CODE_ENTRYPOINT',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
    ],
  });
  assert.equal(
    JSON.stringify(result).includes('/tmp/fake-provider-bin'),
    false,
  );
});

test('actor resolution distinguishes explicit-only, missing, and conflicts', () => {
  assert.deepEqual(
    resolveActorIdentity({
      explicitActor: 'codex',
      environment: {},
    }),
    {
      outcome: 'resolved',
      actor: {
        providerId: 'codex',
        assurance: 'self-declared',
      },
      signals: [
        {
          source: 'explicit',
          name: '--actor',
          providerId: 'codex',
          assurance: 'self-declared',
        },
      ],
    },
  );
  assert.deepEqual(
    resolveActorIdentity({
      environment: {
        AGENT: 'unknown-agent',
        CLAUDECODE: '0',
        CLAUDE_CODE_ENTRYPOINT: '',
        CODEX_SANDBOX: '',
      },
    }),
    {
      outcome: 'actor-resolution-required',
      code: 'ACTOR_IDENTITY_REQUIRED',
      signals: [],
    },
  );

  const conflict = resolveActorIdentity({
    explicitActor: 'codex',
    environment: {
      CLAUDECODE: '1',
      CODEX_SANDBOX: 'seatbelt',
    },
  });
  assert.deepEqual(conflict, {
    outcome: 'actor-resolution-required',
    code: 'ACTOR_IDENTITY_CONFLICT',
    signals: [
      {
        source: 'explicit',
        name: '--actor',
        providerId: 'codex',
        assurance: 'self-declared',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDECODE',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CODEX_SANDBOX',
        providerId: 'codex',
        assurance: 'runtime-hint',
      },
    ],
  });
  assert.equal('actor' in conflict, false);

  const runtimeConflict = resolveActorIdentity({
    environment: {
      AGENT: 'codex',
      CLAUDECODE: '1',
    },
  });
  assert.deepEqual(runtimeConflict, {
    outcome: 'actor-resolution-required',
    code: 'ACTOR_IDENTITY_CONFLICT',
    signals: [
      {
        source: 'runtime-hint',
        name: 'AGENT',
        providerId: 'codex',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDECODE',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
    ],
  });
  assert.equal('actor' in runtimeConflict, false);

  assert.throws(
    () =>
      resolveActorIdentity({
        explicitActor: 'unregistered',
        environment: {},
      }),
    (error) => isWorkflowError(error, 'ACTOR_PROVIDER_UNKNOWN'),
  );
});

test('role independence keeps provider, session, and principal dimensions separate', () => {
  const author = participant({
    providerId: 'codex',
    sessionId: 'author-session',
    principalId: 'principal-a',
  });

  assert.deepEqual(
    assessRoleIndependence(
      author,
      participant({
        providerId: 'codex',
        sessionId: 'fresh-session',
        principalId: 'principal-b',
      }),
    ),
    {
      principalIndependent: true,
      providerIndependent: false,
      sessionIndependent: true,
      achievedIndependence: 'principal-independent',
    },
  );
  assert.deepEqual(
    assessRoleIndependence(
      author,
      participant({
        providerId: 'claude',
        sessionId: 'author-session',
        principalId: 'principal-a',
      }),
    ),
    {
      principalIndependent: false,
      providerIndependent: true,
      sessionIndependent: false,
      achievedIndependence: 'provider-independent',
    },
  );
  assert.deepEqual(
    assessRoleIndependence(author, {
      providerId: undefined,
      sessionId: undefined,
      principalId: undefined,
      identityAssurance: 'self-declared',
      engineSpawned: false,
    }),
    {
      principalIndependent: null,
      providerIndependent: false,
      sessionIndependent: false,
      achievedIndependence: 'none',
    },
  );
  assert.deepEqual(
    assessRoleIndependence(
      {
        providerId: undefined,
        sessionId: undefined,
        principalId: undefined,
        identityAssurance: 'self-declared',
        engineSpawned: false,
      },
      participant({
        providerId: 'claude',
        sessionId: 'adapter-session',
        identityAssurance: 'adapter-assigned',
      }),
    ),
    {
      principalIndependent: null,
      providerIndependent: false,
      sessionIndependent: false,
      achievedIndependence: 'none',
    },
  );
});

test('ordinary role scheduling uses fresh sessions and preserves explicit provider diversity', () => {
  const author = participant({
    providerId: 'codex',
    sessionId: 'author-session',
  });
  const scheduled = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    author,
    targetDigest: DIGESTS.target,
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'codex-survey',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'claude-survey',
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(scheduled.outcome, 'assigned');
  if (scheduled.outcome !== 'assigned') {
    assert.fail('expected an assigned alternate provider');
  }
  assert.equal(scheduled.assignment.providerId, 'codex');
  assert.equal(
    scheduled.assignment.requiredIndependence,
    'session-independent',
  );
  assert.equal(
    scheduled.assignment.achievedIndependence,
    'session-independent',
  );

  const providerDiverse = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    author,
    targetDigest: DIGESTS.target,
    requestedIndependence: 'provider-independent',
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'codex-survey',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'claude-survey',
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(providerDiverse.outcome, 'assigned');
  if (providerDiverse.outcome !== 'assigned') {
    assert.fail('expected an explicitly provider-diverse assignment');
  }
  assert.equal(providerDiverse.assignment.providerId, 'claude');
  assert.equal(
    providerDiverse.assignment.achievedIndependence,
    'provider-independent',
  );

  const sameProviderReviewer = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    purpose: 'survey',
    author,
    targetDigest: DIGESTS.target,
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'fresh-codex-review',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'claude-review',
        enabled: false,
        available: true,
      },
    ],
  });
  assert.equal(sameProviderReviewer.outcome, 'assigned');
  if (sameProviderReviewer.outcome !== 'assigned') {
    assert.fail('expected a fresh Reviewer session assignment');
  }
  assert.deepEqual(sameProviderReviewer.assignment, {
    role: 'plan-reviewer',
    providerId: 'codex',
    sessionId: 'fresh-codex-review',
    targetDigest: DIGESTS.target,
    requiredIndependence: 'session-independent',
    achievedIndependence: 'session-independent',
  });
  const preAnchorRequest = createProviderInvocationRequest({
    ...requestInput(sameProviderReviewer.assignment),
    purpose: 'survey',
  });
  assert.equal(preAnchorRequest.roleAssignment.role, 'plan-reviewer');
  assert.equal(preAnchorRequest.purpose, 'survey');
  assert.deepEqual(
    scheduleOrdinaryRole({
      role: 'plan-reviewer',
      author,
      targetDigest: DIGESTS.target,
      candidates: [
        {
          providerId: 'claude',
          sessionId: 'unavailable-claude-survey',
          enabled: true,
          available: false,
        },
      ],
    }),
    {
      outcome: 'collaboration-grant-required',
      role: 'plan-reviewer',
      requiredIndependence: 'session-independent',
      reason: 'NO_REQUIRED_INDEPENDENCE_CANDIDATE',
    },
  );
  assert.throws(
    () =>
      scheduleOrdinaryRole({
        role: 'plan-reviewer',
        author,
        targetDigest: DIGESTS.target,
        candidates: [
          {
            providerId: 'unregistered' as 'claude',
            sessionId: 'unknown-provider-session',
            enabled: true,
            available: true,
          },
        ],
      }),
    (error) => isWorkflowError(error, 'PROVIDER_UNKNOWN'),
  );
  assert.deepEqual(
    scheduleOrdinaryRole({
      role: 'plan-reviewer',
      author,
      targetDigest: DIGESTS.target,
      requestedIndependence: 'provider-independent',
      candidates: [],
    }),
    {
      outcome: 'collaboration-grant-required',
      role: 'plan-reviewer',
      requiredIndependence: 'provider-independent',
      reason: 'NO_REQUIRED_INDEPENDENCE_CANDIDATE',
    },
  );
});

test('typed provider request is immutable, bounded, and assignment-bound', () => {
  assert.equal(MAX_PROVIDER_LIMITS.timeoutMs, 3_600_000);
  const assignment = surveyAssignment();
  const source = requestInput(assignment);
  const request = createProviderInvocationRequest(source);

  source.targetDigest = 'f'.repeat(64);
  source.limits.timeoutMs = 1;
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.targetDigest, DIGESTS.target);
  assert.equal(request.limits.timeoutMs, 3_600_000);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.roleAssignment), true);
  assert.equal(Object.isFrozen(request.limits), true);
  assert.equal(Object.isFrozen(request.outputSchema), true);
  assert.equal(Object.isFrozen(request.writeAllowedPaths), true);
  assert.equal(request.providerId, request.roleAssignment.providerId);
  assert.deepEqual(request.writeAllowedPaths, []);
  assert.match(request.requestDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    createProviderInvocationRequest(requestInput(surveyAssignment()))
      .requestDigest,
    request.requestDigest,
  );
  assert.notEqual(
    createProviderInvocationRequest({
      ...requestInput(surveyAssignment()),
      repositoryId: 'expense-app@other-canonical-origin',
    }).requestDigest,
    request.requestDigest,
  );

  for (const limits of [
    { timeoutMs: 0, aggregateOutputBytes: 1024 },
    { timeoutMs: 1.5, aggregateOutputBytes: 1024 },
    {
      timeoutMs: MAX_PROVIDER_LIMITS.timeoutMs + 1,
      aggregateOutputBytes: 1024,
    },
    { timeoutMs: 1000, aggregateOutputBytes: 0 },
    {
      timeoutMs: 1000,
      aggregateOutputBytes: MAX_PROVIDER_LIMITS.aggregateOutputBytes + 1,
    },
  ]) {
    assert.throws(
      () =>
        createProviderInvocationRequest({
          ...requestInput(surveyAssignment()),
          limits,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
    );
  }

  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput(surveyAssignment()),
        providerId: 'codex',
      }),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput({
          ...surveyAssignment(),
          requiredIndependence: 'none',
          achievedIndependence: 'none',
        }),
      }),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput(surveyAssignment()),
        writeAllowedPaths: ['openspec/changes/example/design.md'],
      }),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput({
          ...surveyAssignment(),
          targetDigest: 'f'.repeat(64),
        }),
      }),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
  assert.throws(
    () =>
      createProviderInvocationRequest({
        ...requestInput(surveyAssignment()),
        unexpected: true,
      } as ReturnType<typeof requestInput>),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
});

test('provider requests admit only ordinary or granted same-provider assignments', () => {
  const ordinary = surveyAssignment();
  const admitted = admitRoleResult({
    assignment: ordinary,
    author: participant({
      providerId: 'codex',
      sessionId: 'author-session',
      engineSpawned: false,
    }),
    participant: participant({
      providerId: ordinary.providerId,
      sessionId: ordinary.sessionId,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    }),
    content: roleContent(),
    providerInvocation: {
      invocationId: 'invocation-1',
      requestDigest: '7'.repeat(64),
      outputDigest: '8'.repeat(64),
      providerId: ordinary.providerId,
      sessionId: ordinary.sessionId,
      targetDigest: ordinary.targetDigest,
      engineSpawned: true,
    },
    grantUse: null,
    grantValidation: null,
  });
  assert.equal(admitted.form, 'ordinary-provider');
  assert.equal(admitted.orchestration, 'engine-spawned-provider');
  assert.equal(
    assertAdmittedRoleResultRecord(admitted).resultDigest,
    admitted.resultDigest,
  );
  assert.throws(
    () =>
      assertAdmittedRoleResultRecord({
        ...admitted,
        author: { ...admitted.author, principalId: 'forged-author' },
      }),
    (error) => isWorkflowError(error, 'ROLE_RESULT_INVALID'),
  );

  const granted = grantedSameProviderAssignment();
  const request = createProviderInvocationRequest(requestInput(granted));
  assert.equal(
    request.roleAssignment.achievedIndependence,
    'session-independent',
  );
  assert.equal(request.providerId, 'codex');

  assert.throws(
    () =>
      createProviderInvocationRequest(
        requestInput({
          ...granted,
          orchestration: 'caller-supplied',
          engineSpawned: false,
        } as unknown as ProviderRoleAssignment),
      ),
    (error) => isWorkflowError(error, 'PROVIDER_REQUEST_INVALID'),
  );
});

test('the tracked PlanReview schema exposes every admitted role-result form', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../../workflow/schemas/plan-review-artifact.schema.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    $defs: {
      admittedRoleResult: { oneOf: Array<{ $ref: string }> };
      admittedRoleResultV1: {
        properties: { form: { enum: string[] } };
        allOf: Array<{
          then: {
            oneOf?: Array<{
              properties: {
                requiredIndependence: { const: string };
                achievedIndependence: { const?: string; enum?: string[] };
              };
            }>;
            properties: {
              requiredIndependence?: { const?: string; enum?: string[] };
            };
          };
        }>;
      };
      admittedRoleResultV2: {
        required: string[];
        properties: {
          schemaVersion: { const: number };
          form: { const: string };
          role: { const: string };
          orchestration: { const: string };
          grantUse: { type: string };
          roleContextSharingUse: { type: string };
        };
      };
    };
  };
  assert.deepEqual(schema.$defs.admittedRoleResult.oneOf, [
    { $ref: '#/$defs/admittedRoleResultV1' },
    { $ref: '#/$defs/admittedRoleResultV2' },
  ]);
  assert.deepEqual(schema.$defs.admittedRoleResultV1.properties.form.enum, [
    'ordinary-provider',
    'granted-same-provider',
    'granted-caller-supplied',
    'direct-human-attestation',
  ]);
  assert.equal(schema.$defs.admittedRoleResultV1.allOf.length, 4);
  assert.deepEqual(schema.$defs.admittedRoleResultV1.allOf[0]?.then.oneOf, [
    {
      properties: {
        requiredIndependence: { const: 'provider-independent' },
        achievedIndependence: { const: 'provider-independent' },
      },
    },
    {
      properties: {
        requiredIndependence: { const: 'session-independent' },
        achievedIndependence: {
          enum: ['provider-independent', 'session-independent'],
        },
      },
    },
  ]);
  assert.equal(
    schema.$defs.admittedRoleResultV2.properties.schemaVersion.const,
    2,
  );
  assert.equal(
    schema.$defs.admittedRoleResultV2.properties.form.const,
    'granted-role-context-sharing',
  );
  assert.equal(
    schema.$defs.admittedRoleResultV2.properties.role.const,
    'plan-reviewer',
  );
  assert.equal(
    schema.$defs.admittedRoleResultV2.properties.orchestration.const,
    'engine-spawned-provider',
  );
  assert.equal(
    schema.$defs.admittedRoleResultV2.properties.grantUse.type,
    'null',
  );
  assert.equal(
    schema.$defs.admittedRoleResultV2.properties.roleContextSharingUse.type,
    'object',
  );
  assert.equal(
    schema.$defs.admittedRoleResultV2.required.includes(
      'roleContextSharingUse',
    ),
    true,
  );
});

test('deterministic fake process accepts only a fully bound structured result', () => {
  const request = createProviderInvocationRequest(
    requestInput(surveyAssignment()),
  );
  const accepted = evaluateProviderProcess(
    request,
    processOutcome(providerResult(request, { terms: ['protectedBranches'] })),
    {
      id: request.outputSchema.id,
      version: request.outputSchema.version,
      digest: request.outputSchema.digest,
      validate(value) {
        assert.equal(Object.isFrozen(value), true);
        assert.equal(
          Object.isFrozen((value as { terms: unknown[] }).terms),
          true,
        );
        return (
          typeof value === 'object' &&
          value !== null &&
          Array.isArray((value as { terms?: unknown }).terms)
        );
      },
    },
  );

  assert.deepEqual(accepted.output, { terms: ['protectedBranches'] });
  assert.match(accepted.outputDigest, /^[0-9a-f]{64}$/);
  assert.equal(accepted.requestDigest, request.requestDigest);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.output), true);
  assert.equal(
    Object.isFrozen((accepted.output as { terms: unknown[] }).terms),
    true,
  );
});

test('provider results reject every mismatched request binding', () => {
  const request = createProviderInvocationRequest(
    requestInput(surveyAssignment()),
  );
  const base = providerResult(request, { terms: [] });
  const mismatches: Array<[string, unknown]> = [
    ['requestDigest', 'f'.repeat(64)],
    ['invocationId', 'different-invocation'],
    ['nonce', 'different-nonce'],
    ['purpose', 'plan-review'],
    ['providerId', 'codex'],
    ['roleAssignmentDigest', 'f'.repeat(64)],
    ['capabilityProfile', 'different-profile'],
    ['repositoryId', 'different-repository'],
    ['baseCommit', 'f'.repeat(40)],
    ['baseTree', 'f'.repeat(40)],
    ['targetDigest', 'f'.repeat(64)],
    ['inputManifestDigest', 'f'.repeat(64)],
    ['authorizationNodeId', 'f'.repeat(64)],
    ['outputSchema', { ...request.outputSchema, id: 'other-output' }],
    ['evaluatorVersion', 'other-evaluator.v1'],
    ['policyDigest', 'f'.repeat(64)],
    ['limits', { timeoutMs: 1, aggregateOutputBytes: 1024 }],
  ];

  for (const [field, value] of mismatches) {
    assert.throws(
      () =>
        evaluateProviderProcess(
          request,
          processOutcome({ ...base, [field]: value }),
          outputValidator(request),
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RESULT_UNBOUND'),
      field,
    );
  }
  assert.throws(
    () =>
      evaluateProviderProcess(
        request,
        processOutcome({ ...base, unexpected: true }),
        outputValidator(request),
      ),
    (error) => isWorkflowError(error, 'PROVIDER_RESULT_INVALID'),
  );
  for (const invalid of [
    { ...base, schemaVersion: 2 },
    { ...base, observedTouchedPaths: '' },
    { ...base, observedTouchedPaths: [1] },
    {
      ...base,
      outputSchema: { ...base.outputSchema, unexpected: true },
    },
    {
      ...base,
      limits: { ...base.limits, unexpected: true },
    },
    {
      ...base,
      limits: { ...base.limits, timeoutMs: 1.5 },
    },
    {
      ...base,
      outputSchema: { ...base.outputSchema, digest: 'not-a-digest' },
    },
  ]) {
    assert.throws(
      () =>
        evaluateProviderProcess(
          request,
          processOutcome(invalid),
          outputValidator(request),
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RESULT_INVALID'),
    );
  }
  for (const field of Object.keys(base)) {
    const missing = { ...base } as Record<string, unknown>;
    delete missing[field];
    assert.throws(
      () =>
        evaluateProviderProcess(
          request,
          processOutcome(missing),
          outputValidator(request),
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RESULT_INVALID'),
      `missing ${field}`,
    );
  }
});

test('provider process and output failures never become successful results', () => {
  const request = createProviderInvocationRequest({
    ...requestInput(surveyAssignment()),
    limits: {
      timeoutMs: 100,
      aggregateOutputBytes: 4096,
    },
  });
  const result = providerResult(request, { terms: [] });
  const failures: Array<[Partial<ProviderProcessOutcome>, string]> = [
    [{ timedOut: true }, 'PROVIDER_TIMEOUT'],
    [{ elapsedMs: 101 }, 'PROVIDER_TIMEOUT'],
    [{ signal: 'SIGTERM' }, 'PROVIDER_PROCESS_CRASH'],
    [{ spawnErrorCode: 'ABORT_ERR' }, 'PROVIDER_PROCESS_CANCELLED'],
    [{ spawnErrorCode: 'ENETUNREACH' }, 'NETWORK_TRANSIENT'],
    [{ spawnErrorCode: 'ENOENT' }, 'PROVIDER_TOOL_UNAVAILABLE'],
    [
      { exitCode: 1, stderr: 'HTTP 429 rate limit; retry later' },
      'PROVIDER_RATE_LIMIT',
    ],
    [{ exitCode: 1 }, 'PROVIDER_PROCESS_NONZERO'],
    [{ stdout: '{not-json' }, 'PROVIDER_RESULT_INVALID'],
    [
      { stdout: `${JSON.stringify(result)}\n${JSON.stringify(result)}` },
      'PROVIDER_RESULT_INVALID',
    ],
    [{ stderr: '界'.repeat(1400) }, 'PROVIDER_OUTPUT_LIMIT_EXCEEDED'],
  ];

  for (const [override, code] of failures) {
    assert.throws(
      () =>
        evaluateProviderProcess(
          request,
          processOutcome(result, override),
          outputValidator(request),
        ),
      (error) => isWorkflowError(error, code),
      code,
    );
  }
  assert.throws(
    () =>
      evaluateProviderProcess(
        request,
        processOutcome(result, {
          exitCode: 1,
          stderr: 'HTTP 429 rate limit\nRetry-After: 23',
        }),
        outputValidator(request),
      ),
    (error) =>
      error instanceof WorkflowError &&
      isWorkflowError(error, 'PROVIDER_RATE_LIMIT') &&
      error.details?.retryAfterMs === 23_000,
  );
  assert.throws(
    () =>
      evaluateProviderProcess(request, processOutcome(result), {
        ...outputValidator(request),
        validate: () => false,
      }),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
  );
  assert.throws(
    () =>
      evaluateProviderProcess(request, processOutcome(result), {
        ...outputValidator(request),
        digest: 'f'.repeat(64),
      }),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
  );
  assert.throws(
    () =>
      evaluateProviderProcess(request, processOutcome(result), {
        ...outputValidator(request),
        validate() {
          throw new Error('validator failure');
        },
      }),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
  );
  assert.throws(
    () =>
      evaluateProviderProcess(request, processOutcome(result), {
        ...outputValidator(request),
        validate: () => 1 as unknown as boolean,
      }),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
  );
});

test('aggregate provider output includes the normalized semantic output', () => {
  const request = createProviderInvocationRequest({
    ...requestInput(surveyAssignment()),
    limits: {
      timeoutMs: 100,
      aggregateOutputBytes: 4096,
    },
  });
  const output = { terms: ['x'.repeat(1500)] };
  const result = providerResult(request, output);
  const stdout = JSON.stringify(result);
  const rawBytes = Buffer.byteLength(stdout, 'utf8');
  const normalizedBytes = Buffer.byteLength(canonicalJson(output), 'utf8');
  assert.ok(rawBytes < request.limits.aggregateOutputBytes);
  assert.ok(rawBytes + normalizedBytes > request.limits.aggregateOutputBytes);

  assert.throws(
    () =>
      evaluateProviderProcess(
        request,
        processOutcome(result),
        outputValidator(request),
      ),
    (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_LIMIT_EXCEEDED'),
  );
});

test('read-only provider result rejects any observed repository mutation', () => {
  const request = createProviderInvocationRequest(
    requestInput(surveyAssignment()),
  );
  const result = providerResult(request, { terms: [] });

  assert.throws(
    () =>
      evaluateProviderProcess(
        request,
        processOutcome({
          ...result,
          observedTouchedPaths: ['openspec/changes/example/design.md'],
        }),
        outputValidator(request),
      ),
    (error) => isWorkflowError(error, 'PROVIDER_READ_ONLY_DRIFT'),
  );
});

function participant(override: Partial<RoleParticipant> = {}): RoleParticipant {
  return {
    providerId: 'codex',
    sessionId: 'session-a',
    principalId: undefined,
    identityAssurance: 'runtime-hint',
    engineSpawned: true,
    ...override,
  };
}

function surveyAssignment(): RoleAssignment {
  const scheduled = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    author: participant({
      providerId: 'codex',
      sessionId: 'author-session',
    }),
    targetDigest: DIGESTS.target,
    candidates: [
      {
        providerId: 'claude',
        sessionId: 'survey-session',
        enabled: true,
        available: true,
      },
    ],
  });
  if (scheduled.outcome !== 'assigned') {
    throw new Error('fixture role assignment was not scheduled');
  }
  return scheduled.assignment;
}

function requestInput(assignment: ProviderRoleAssignment) {
  return {
    invocationId: 'invocation-1',
    nonce: 'nonce-with-at-least-16-bytes',
    purpose: 'survey' as const,
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only' as const,
    repositoryId: 'expense-app@canonical-origin',
    baseCommit: 'a'.repeat(40),
    baseTree: DIGESTS.baseTree,
    targetDigest: DIGESTS.target,
    inputManifestDigest: DIGESTS.manifest,
    authorizationNodeId: DIGESTS.authorization,
    writeAllowedPaths: [] as string[],
    outputSchema: {
      id: 'expense-app.workflow.survey-output',
      version: 1,
      digest: DIGESTS.outputSchema,
    },
    evaluatorVersion: 'survey-evaluator.v1',
    policyDigest: DIGESTS.policy,
    limits: {
      timeoutMs: 3_600_000,
      aggregateOutputBytes: 1_048_576,
    },
  };
}

function grantedSameProviderAssignment(): GrantedSameProviderRoleAssignment {
  return {
    role: 'plan-reviewer',
    providerId: 'codex',
    sessionId: 'fresh-session',
    targetDigest: DIGESTS.target,
    requiredIndependence: 'provider-independent',
    achievedIndependence: 'session-independent',
    providerIndependent: false,
    sessionIndependent: true,
    engineSpawned: true,
    orchestration: 'engine-spawned-provider',
    grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    degradedForm: 'same-provider-fresh-session',
    authorizedEffect: 'role-independence-degradation-only',
    author: {
      providerId: 'codex',
      sessionId: 'author-session',
      principalId: null,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    participant: {
      providerId: 'codex',
      sessionId: 'fresh-session',
      principalId: null,
      identityAssurance: 'runtime-hint',
      engineSpawned: true,
    },
    callableProviderIds: ['codex'],
    directHumanReviewAttestationDigest: null,
  };
}

function roleContent() {
  return {
    kind: 'blind-survey' as const,
    nodeId: '9'.repeat(64),
    resultDigest: 'a'.repeat(64),
    outputSchema: {
      id: 'blind-survey-output.v1',
      version: 1,
      digest: DIGESTS.outputSchema,
    },
    evaluator: 'blind-survey-evaluator.v1',
    policyDigest: DIGESTS.policy,
    contentDigest: 'a'.repeat(64),
    current: true as const,
  };
}

function providerResult(request: ProviderInvocationRequest, output: unknown) {
  return {
    schemaVersion: 1,
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    nonce: request.nonce,
    purpose: request.purpose,
    providerId: request.providerId,
    roleAssignmentDigest: request.roleAssignmentDigest,
    capabilityProfile: request.capabilityProfile,
    repositoryId: request.repositoryId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    targetDigest: request.targetDigest,
    inputManifestDigest: request.inputManifestDigest,
    authorizationNodeId: request.authorizationNodeId,
    outputSchema: request.outputSchema,
    evaluatorVersion: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    limits: request.limits,
    observedTouchedPaths: [],
    output,
  };
}

function processOutcome(
  result: unknown,
  override: Partial<ProviderProcessOutcome> = {},
): ProviderProcessOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify(result),
    stderr: '',
    ...override,
  };
}

function outputValidator(request: ProviderInvocationRequest) {
  return {
    id: request.outputSchema.id,
    version: request.outputSchema.version,
    digest: request.outputSchema.digest,
    validate: () => true,
  };
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
