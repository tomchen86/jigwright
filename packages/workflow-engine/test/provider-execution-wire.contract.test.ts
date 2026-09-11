/** Typed provider request/result wire bindings, semantic output, and process outcome contracts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PROVIDER_LIMITS,
  createProviderInvocationRequest,
  evaluateProviderProcess,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import type { ProviderProcessOutcome } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  admitRoleResult,
  assertAdmittedRoleResultRecord,
} from '../src/composition-root/role-admission-production.ts';
import type { ProviderRoleAssignment } from '../src/modules/provider-orchestration/role-assignment.ts';
import fs from 'node:fs';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  surveyAssignment,
  requestInput,
  DIGESTS,
  isWorkflowError,
  participant,
  roleContent,
  grantedSameProviderAssignment,
  processOutcome,
  providerResult,
  outputValidator,
} from './provider-orchestration-fixture.ts';

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
