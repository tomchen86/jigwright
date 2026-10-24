import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { parseCollaborationGrantArguments } from '../src/entrypoints/cli/collaboration-grant-cli.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { providerOutputSchemaGeneration } from '../src/modules/assurance/provider-output-contract.ts';
import { providerInvocationManifestDigest } from '../src/runtime/storage-journal/provider-invocation-manifest-validation.ts';
import { prepareTaskStrategyGreenFailureRecord } from '../src/modules/provider-orchestration/task-strategy-correction-record.ts';
import { runGit } from '../src/runtime/repository-transaction/git.ts';
import { scheduleOrdinaryRole } from '../src/modules/provider-orchestration/role-assignment.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
  assertTaskStrategyImplementationManifest,
  createTaskStrategyImplementationManifest,
  createTaskStrategyImplementationSubject,
  createTaskStrategyCorrectionSubject,
  taskStrategyImplementationOutputValidator,
} from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';

const OID = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);

test('task implementation assignment binds one exact RED subject and provider request', () => {
  const subject = subjectFixture();
  const manifest = createTaskStrategyImplementationManifest({
    repositoryId: 'expense-app',
    baseCommit: OID,
    baseTree: TREE,
    subject,
    behaviorContractRefs: [
      {
        specPath: 'specs/demo/spec.md',
        requirement: 'Demo behavior',
        scenario: 'Demo succeeds',
      },
    ],
    implementationPathScopes: ['src/**'],
  });
  const scheduled = scheduleOrdinaryRole({
    role: 'task-implementer',
    author: {
      providerId: 'codex',
      sessionId: 'red-author-session',
      principalId: undefined,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    targetDigest: subject.subjectDigest,
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'implementation-session',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'implementation-session',
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(scheduled.outcome, 'assigned');
  if (scheduled.outcome !== 'assigned') return;
  assert.equal(scheduled.assignment.providerId, 'codex');
  assert.equal(scheduled.assignment.sessionId, 'implementation-session');
  assert.equal(
    scheduled.assignment.requiredIndependence,
    'session-independent',
  );
  assert.equal(
    scheduled.assignment.achievedIndependence,
    'session-independent',
  );

  const request = createProviderInvocationRequest({
    invocationId: `invocation-task-implementation-${'3'.repeat(64)}`,
    nonce: `task-implementation-${'3'.repeat(64)}`,
    purpose: 'task-implementation',
    providerId: scheduled.assignment.providerId,
    roleAssignment: scheduled.assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: manifest.repositoryId,
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest: subject.subjectDigest,
    inputManifestDigest: sha256(canonicalJson(manifest)),
    authorizationNodeId: '4'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-strategy-implementation.v1',
    policyDigest: '5'.repeat(64),
    limits: { timeoutMs: 60_000, aggregateOutputBytes: 65_536 },
  });
  assert.equal(
    request.inputManifestDigest,
    providerInvocationManifestDigest(manifest),
  );
  assert.equal(request.roleAssignment.role, 'task-implementer');
  assert.equal(request.targetDigest, subject.subjectDigest);
  assert.equal(providerOutputSchemaGeneration(request), 'code-owned');
  assert.throws(
    () =>
      providerOutputSchemaGeneration({
        ...request,
        outputSchema: {
          ...TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
          id: 'expense-app.workflow.task-strategy-implementation-output',
        },
      }),
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
  );
  assert.throws(
    () =>
      providerOutputSchemaGeneration({
        ...request,
        outputSchema: {
          ...TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
          id: 'unknown.workflow.task-strategy-output.v1',
        },
      }),
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
  );
  assert.deepEqual(
    assertTaskStrategyImplementationManifest(manifest),
    manifest,
  );
});

test('task implementation output accepts one exact patch and rejects digest drift', () => {
  const patch = Buffer.from(
    'diff --git a/src/feature.ts b/src/feature.ts\nnew file mode 100644\n',
  );
  const output = {
    schemaVersion: 1,
    kind: 'task-strategy-patch-output.v1',
    sessionId: 'session-20260812000000000-00000000-0000-4000-8000-000000000001',
    sourceTree: TREE,
    patchBase64: patch.toString('base64'),
    patchDigest: sha256(patch),
  };
  assert.equal(
    TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR.validate(output),
    true,
  );
  assert.equal(
    TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR.validate({
      ...output,
      patchBase64: Buffer.from('different').toString('base64'),
    }),
    false,
  );

  const bound = taskStrategyImplementationOutputValidator({
    sessionId: output.sessionId,
    sourceTree: output.sourceTree,
  });
  assert.equal(bound.validate(output), true);
  assert.equal(
    bound.validate({
      ...output,
      sessionId:
        'session-20260812000000000-00000000-0000-4000-8000-000000000002',
    }),
    false,
  );
  assert.equal(
    bound.validate({
      ...output,
      sourceTree: '3'.repeat(40),
    }),
    false,
  );
  assert.equal(
    TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR.validate({
      ...output,
      sessionId:
        'session-20260812000000000-00000000-0000-4000-8000-000000000002',
      sourceTree: '3'.repeat(40),
    }),
    true,
  );
});

test('task implementation manifest cannot carry challenge closure or disposition semantics', () => {
  const subject = subjectFixture();
  const manifest = createTaskStrategyImplementationManifest({
    repositoryId: 'expense-app',
    baseCommit: OID,
    baseTree: TREE,
    subject,
    behaviorContractRefs: [
      {
        specPath: 'specs/demo/spec.md',
        requirement: 'Demo behavior',
        scenario: 'Demo succeeds',
      },
    ],
    implementationPathScopes: ['src/**'],
  });
  assert.throws(() =>
    assertTaskStrategyImplementationManifest({
      ...manifest,
      dispositions: [],
    }),
  );
  assert.throws(() =>
    assertTaskStrategyImplementationManifest({
      ...manifest,
      challengesClosed: true,
    }),
  );
});

test('task implementation manifest uses one canonical UTF-8 byte order', () => {
  const bmpPath = 'test/\uE000.test.mjs';
  const supplementaryPath = 'test/\u{10000}.test.mjs';
  const subject = subjectFixture({
    testPaths: [supplementaryPath, bmpPath],
  });
  assert.deepEqual(subject.testPaths, [bmpPath, supplementaryPath]);
  assert.deepEqual(
    subject.frozenFiles.map((entry) => entry.path),
    [bmpPath, supplementaryPath],
  );

  const bmpScope = 'src/\uE000/**';
  const supplementaryScope = 'src/\u{10000}/**';
  const manifest = createTaskStrategyImplementationManifest({
    repositoryId: 'expense-app',
    baseCommit: OID,
    baseTree: TREE,
    subject,
    behaviorContractRefs: [
      {
        specPath: 'specs/demo/spec.md',
        requirement: '\u{10000} behavior',
        scenario: null,
      },
      {
        specPath: 'specs/demo/spec.md',
        requirement: '\uE000 behavior',
        scenario: null,
      },
    ],
    implementationPathScopes: [supplementaryScope, bmpScope],
  });

  assert.deepEqual(manifest.implementationPathScopes, [
    bmpScope,
    supplementaryScope,
  ]);
  assert.deepEqual(
    manifest.behaviorContractRefs.map((entry) => entry.requirement),
    ['\uE000 behavior', '\u{10000} behavior'],
  );
  assert.deepEqual(
    assertTaskStrategyImplementationManifest(manifest),
    manifest,
  );
});

test('task implementation manifest bounds canonical bytes and collection counts', () => {
  const tooManyPaths = Array.from(
    { length: 1_025 },
    (_, index) =>
      `test/generated-${index.toString().padStart(4, '0')}.test.mjs`,
  );
  assertManifestInvalid(() =>
    subjectFixture({
      testPaths: tooManyPaths,
    }),
  );

  const subject = subjectFixture();
  assertManifestInvalid(() =>
    createTaskStrategyImplementationManifest({
      repositoryId: 'expense-app',
      baseCommit: OID,
      baseTree: TREE,
      subject,
      behaviorContractRefs: Array.from({ length: 1_025 }, (_, index) => ({
        specPath: 'specs/demo/spec.md',
        requirement: `Behavior ${index.toString().padStart(4, '0')}`,
        scenario: null,
      })),
      implementationPathScopes: ['src/**'],
    }),
  );
  assertManifestInvalid(() =>
    createTaskStrategyImplementationManifest({
      repositoryId: 'expense-app',
      baseCommit: OID,
      baseTree: TREE,
      subject,
      behaviorContractRefs: [
        {
          specPath: 'specs/demo/spec.md',
          requirement: 'Demo behavior',
          scenario: null,
        },
      ],
      implementationPathScopes: Array.from(
        { length: 1_025 },
        (_, index) => `src/generated-${index.toString().padStart(4, '0')}/**`,
      ),
    }),
  );
  assertManifestInvalid(() =>
    createTaskStrategyImplementationManifest({
      repositoryId: 'expense-app',
      baseCommit: OID,
      baseTree: TREE,
      subject,
      behaviorContractRefs: [
        {
          specPath: 'specs/demo/spec.md',
          requirement: 'x'.repeat(262_144),
          scenario: null,
        },
      ],
      implementationPathScopes: ['src/**'],
    }),
  );
});

test('task implementation shortage reuses the typed collaboration grant vocabulary', () => {
  const baseCommit = runGit(process.cwd(), ['rev-parse', 'HEAD']).trim();
  const request = parseCollaborationGrantArguments(
    [
      'collaboration-grant',
      '--change',
      'demo-change',
      '--task',
      'mandate-task',
      '--base',
      baseCommit,
      '--target',
      DIGEST,
      '--phase',
      'task-implementation',
      '--author-role',
      'red-author',
      '--conflicting-role',
      'task-implementer',
      '--caller',
      'human-implementer',
      '--actor-assurance',
      'runtime-hint',
      '--degraded',
      'caller-supplied',
      '--reason',
      'No independent provider is currently callable.',
      '--ttl',
      '30m',
      '--uses',
      '1',
    ],
    process.cwd(),
  );
  assert.equal(request.lifecyclePhase, 'task-implementation');
  assert.deepEqual(request.rolePair, {
    authorRole: 'red-author',
    conflictingRole: 'task-implementer',
  });
  assert.equal(request.degradedForm, 'caller-supplied');
});

test('local manifest digest matches the generic validator for detached ordinary and correction builder results', () => {
  const initial = subjectFixture();
  const failureBody = {
    checkId: 'unit',
    outcome: 'failed' as const,
    exitCode: 1,
    runner: 'node',
    runnerDigest: sha256('runner'),
    stdoutDigest: sha256('failed'),
    stderrDigest: sha256(''),
    stdoutExcerpt: 'failed',
    stderrExcerpt: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  const failure = prepareTaskStrategyGreenFailureRecord({
    sessionId: initial.sessionId,
    currentRedTransactionDigest: initial.transactionDigest,
    currentPatchHead: {
      bindingDigest: sha256('binding'),
      recordDigest: sha256('record'),
      patchDigest: sha256('patch'),
      receiptDigest: sha256('receipt'),
    },
    candidateTree: '3'.repeat(40),
    checkDefinitions: [
      {
        checkId: 'unit',
        definition: {
          command: ['node', 'unit.mjs'],
          destructiveDatabase: false,
        },
        runner: 'node',
        runnerDigest: failureBody.runnerDigest,
      },
    ],
    passedChecks: [],
    failingCheck: {
      ...failureBody,
      failureFingerprint: sha256(canonicalJson(failureBody)),
    },
    createdAt: '2026-09-23T01:00:00.000Z',
  });
  for (const correction of [false, true]) {
    const subject = correction
      ? createTaskStrategyCorrectionSubject({
          subject: initial,
          round: 1,
          greenFailureRecord: failure,
        })
      : initial;
    const input = {
      repositoryId: 'fixture',
      baseCommit: OID,
      baseTree: TREE,
      subject: structuredClone(subject),
      behaviorContractRefs: [
        {
          specPath: 'specs/demo/spec.md',
          requirement: 'Demo behavior',
          scenario: null,
        },
      ],
      implementationPathScopes: ['src/**'],
      ...(correction ? { greenFailureRecord: structuredClone(failure) } : {}),
    };
    const manifest = createTaskStrategyImplementationManifest(input);
    if (correction) {
      const { greenFailureRecord: ignored, ...missingFailure } = input;
      assertManifestInvalid(() =>
        createTaskStrategyImplementationManifest(missingFailure),
      );
      assertManifestInvalid(() =>
        createTaskStrategyImplementationManifest({
          ...input,
          greenFailureRecord: prepareTaskStrategyGreenFailureRecord({
            ...failure,
            candidateTree: '9'.repeat(40),
          }),
        }),
      );
    } else {
      assertManifestInvalid(() =>
        createTaskStrategyImplementationManifest({
          ...input,
          greenFailureRecord: failure,
        }),
      );
    }
    const expected = providerInvocationManifestDigest(manifest);
    assert.equal(sha256(canonicalJson(manifest)), expected);
    assert.ok(Object.isFrozen(manifest));
    assert.ok(Object.isFrozen(manifest.subject.frozenFiles));
    assert.notStrictEqual(manifest.subject, input.subject);
    input.behaviorContractRefs[0]!.requirement = 'mutated later';
    input.implementationPathScopes.push('unrelated/**');
    Object.assign(input.subject, { sourceTree: '9'.repeat(40) });
    if (input.greenFailureRecord)
      Object.assign(input.greenFailureRecord, {
        candidateTree: '9'.repeat(40),
      });
    assert.equal(sha256(canonicalJson(manifest)), expected);
    assert.equal(providerInvocationManifestDigest(manifest), expected);
    assertManifestInvalid(() =>
      createTaskStrategyImplementationManifest({
        ...input,
        subject,
        baseCommit: 'invalid-commit',
      }),
    );
  }
});

function subjectFixture(
  input: Readonly<{
    testPaths?: readonly string[];
    fixturePaths?: readonly string[];
  }> = {},
) {
  const testPaths = input.testPaths ?? ['test/feature.test.mjs'];
  const fixturePaths = input.fixturePaths ?? [];
  return createTaskStrategyImplementationSubject({
    sessionId: 'session-20260812000000000-00000000-0000-4000-8000-000000000001',
    changeId: 'demo-change',
    taskId: '1.1',
    strategy: 'cross-agent-tdd',
    transactionDigest: DIGEST,
    taskContractDigest: 'd'.repeat(64),
    sourceTree: TREE,
    failureFingerprint: 'e'.repeat(64),
    redEvidenceNodeId: 'f'.repeat(64),
    redEvidenceResultDigest: '1'.repeat(64),
    testPaths,
    fixturePaths,
    frozenFiles: [...testPaths, ...fixturePaths].map((path) => ({
      path,
      mode: '100644',
      objectId: '2'.repeat(40),
    })),
  });
}

function assertManifestInvalid(operation: () => unknown): void {
  assert.throws(
    operation,
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'TASK_STRATEGY_IMPLEMENTATION_MANIFEST_INVALID',
  );
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
