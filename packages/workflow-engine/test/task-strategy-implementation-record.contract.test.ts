import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  parseTaskStrategyImplementationReservation,
  parseTaskStrategyImplementationResultBinding,
  parseTaskStrategyCallerImplementationReservation,
  parseTaskStrategyCallerImplementationBinding,
  type TaskStrategyImplementationReservation,
  type TaskStrategyCallerImplementationReservation,
} from '../src/modules/assurance/task-strategy-implementation-record.ts';
import type {
  TaskStrategyImplementationResultBinding,
  TaskStrategyCallerImplementationBinding,
} from '../src/modules/assurance/task-strategy-evidence.ts';
import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import type { CollaborationGrantUseProjection } from '../src/modules/authority/collaboration-grant-records.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  scheduleOrdinaryRole,
  type GrantedRoleAssignment,
  type GrantedSameProviderRoleAssignment,
  type RecordedRoleParticipant,
} from '../src/modules/provider-orchestration/role-assignment.ts';
import type { RoleContentAdmission } from '../src/modules/provider-orchestration/role-admission-contracts.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  createTaskStrategyImplementationManifest,
  createTaskStrategyImplementationSubject,
} from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';

const CREATED_AT = '2026-09-23T01:00:00.000Z';
const GRANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_GRANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STALE = { code: 'TASK_STRATEGY_IMPLEMENTATION_STATE_CORRUPT' };
const ROLE_RESULT_SCHEMA = 'admitted-role-result.v1';

type FixtureOptions = {
  providerForm?: 'ordinary-independent' | 'ordinary-same-provider' | 'granted';
  gitIdLength?: 40 | 64;
  createdAt?: string;
};

// All input records are built from pure contracts and fixed wire facts. The
// grant envelope is fixture data, not evidence of a live authorization.
function records({
  providerForm = 'ordinary-independent',
  gitIdLength = 40,
  createdAt = CREATED_AT,
}: FixtureOptions = {}) {
  const subject = createTaskStrategyImplementationSubject({
    sessionId: 'session-record-contract',
    changeId: 'record-contract',
    taskId: '1.1',
    strategy: 'cross-agent-tdd',
    transactionDigest: digest('transaction'),
    taskContractDigest: digest('task-contract'),
    sourceTree: '1'.repeat(gitIdLength),
    failureFingerprint: digest('failure'),
    redEvidenceNodeId: digest('red-node'),
    redEvidenceResultDigest: digest('red-result'),
    testPaths: ['test/feature.test.ts'],
    fixturePaths: [],
    frozenFiles: [
      {
        path: 'test/feature.test.ts',
        mode: '100644',
        objectId: '2'.repeat(gitIdLength),
      },
    ],
  });
  const author = {
    providerId: 'codex' as const,
    sessionId: 'red-author-session',
    principalId: 'provider:codex',
    identityAssurance: 'self-declared' as const,
    engineSpawned: false,
  };
  const providerId =
    providerForm === 'ordinary-independent' ? 'claude' : 'codex';
  const participant = {
    providerId,
    sessionId: 'implementation-provider-session',
    principalId: `provider:${providerId}`,
    identityAssurance: 'adapter-assigned' as const,
    engineSpawned: true,
  } satisfies RecordedRoleParticipant;
  const scheduled = scheduleOrdinaryRole({
    role: 'task-implementer',
    author,
    targetDigest: subject.subjectDigest,
    candidates: [
      {
        providerId,
        sessionId: participant.sessionId,
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(scheduled.outcome, 'assigned');
  if (scheduled.outcome !== 'assigned') throw new Error('invalid fixture');
  const grantedAssignment = {
    role: 'task-implementer',
    providerId: 'codex',
    sessionId: participant.sessionId,
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'provider-independent',
    achievedIndependence: 'session-independent',
    providerIndependent: false,
    sessionIndependent: true,
    engineSpawned: true,
    orchestration: 'engine-spawned-provider',
    grantId: GRANT_ID,
    degradedForm: 'same-provider-fresh-session',
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    author,
    participant,
    callableProviderIds: ['codex'],
    directHumanReviewAttestationDigest: null,
  } satisfies GrantedSameProviderRoleAssignment;
  const assignment =
    providerForm === 'granted' ? grantedAssignment : scheduled.assignment;
  const manifest = createTaskStrategyImplementationManifest({
    repositoryId: 'record-contract',
    baseCommit: '3'.repeat(gitIdLength),
    baseTree: '4'.repeat(gitIdLength),
    subject,
    behaviorContractRefs: [
      {
        specPath: 'specs/feature/spec.md',
        requirement: 'Implementation records retain their exact subject',
        scenario: null,
      },
    ],
    implementationPathScopes: ['src/**'],
  });
  const authorizationNodeId = digest('authorization-node');
  const request = createProviderInvocationRequest({
    invocationId: 'invocation-record-contract',
    nonce: 'record-contract-nonce',
    purpose: 'task-implementation',
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: 'record-contract',
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest: subject.subjectDigest,
    inputManifestDigest: digest(canonicalJson(manifest)),
    authorizationNodeId,
    writeAllowedPaths: [],
    outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-strategy-implementation.v1',
    policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
    limits: { timeoutMs: 10_000, aggregateOutputBytes: 100_000 },
  });
  const patch = Buffer.from('fixed implementation patch bytes');
  const output = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-output.v1' as const,
    sessionId: subject.sessionId,
    sourceTree: subject.sourceTree,
    patchBase64: patch.toString('base64'),
    patchDigest: digest(patch),
  };
  const content = {
    kind: 'task-implementation' as const,
    nodeId: digest('observation-node'),
    resultDigest: digest('observation-result'),
    outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    evaluator: 'task-strategy-implementation.v1',
    policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
    contentDigest: digest('observation-result'),
    current: true as const,
  };
  const providerRoleResult = seal(
    {
      schemaVersion: 1 as const,
      form:
        providerForm === 'granted'
          ? ('granted-same-provider' as const)
          : ('ordinary-provider' as const),
      role: 'task-implementer' as const,
      targetDigest: subject.subjectDigest,
      assignment,
      author,
      participant,
      orchestration: 'engine-spawned-provider' as const,
      requiredIndependence: 'session-independent' as const,
      achievedIndependence: assignment.achievedIndependence,
      content,
      providerInvocation: {
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        outputDigest: digest(canonicalJson(output)),
        providerId: assignment.providerId,
        sessionId: assignment.sessionId,
        targetDigest: subject.subjectDigest,
        engineSpawned: true as const,
      },
      grantUse:
        providerForm === 'granted'
          ? grantUse(grantedAssignment, content)
          : null,
      directHumanReviewAttestation: null,
    },
    'resultDigest',
    ROLE_RESULT_SCHEMA,
  );
  const reservation = seal(
    {
      schemaVersion: 1 as const,
      kind: 'task-strategy-implementation-reservation.v1' as const,
      ownerInvestigationId: 'investigation-record-contract',
      sessionId: subject.sessionId,
      changeId: subject.changeId,
      taskId: subject.taskId,
      repositoryRoot: '/fixture/repository',
      gitCommonDirectory: '/fixture/repository/.git',
      branch: 'work/record-contract',
      baseline: { head: manifest.baseCommit, tree: manifest.baseTree },
      mandateBinding: null,
      subject,
      redAuthor: author,
      assignment,
      manifest,
      request,
      authorizationNodeId,
      reservationNodeId: digest('reservation-node'),
      createdAt,
    },
    'recordDigest',
  ) satisfies TaskStrategyImplementationReservation;
  const result = seal(
    {
      schemaVersion: 1 as const,
      kind: 'task-strategy-implementation-result-binding.v1' as const,
      ownerInvestigationId: reservation.ownerInvestigationId,
      sessionId: subject.sessionId,
      subjectDigest: subject.subjectDigest,
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      outputDigest: digest(canonicalJson(output)),
      runtimeObservationDigest: digest('runtime-observation'),
      providerObservationNodeId: content.nodeId,
      providerObservationDigest: content.resultDigest,
      providerResultNodeId: digest('provider-result-node'),
      providerResultDigest: digest('provider-result'),
      roleResult: providerRoleResult,
      output,
      createdAt,
    },
    'bindingDigest',
  ) satisfies TaskStrategyImplementationResultBinding;

  const callerAssignment = {
    role: 'task-implementer',
    providerId: null,
    sessionId: null,
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'provider-independent',
    achievedIndependence: 'none',
    providerIndependent: false,
    sessionIndependent: false,
    engineSpawned: false,
    orchestration: 'caller-supplied',
    grantId: GRANT_ID,
    degradedForm: 'caller-supplied',
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    author,
    participant: {
      providerId: null,
      sessionId: null,
      principalId: 'caller-record-contract',
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    callableProviderIds: [],
    directHumanReviewAttestationDigest: null,
  } satisfies GrantedRoleAssignment;
  const callerContent = {
    ...content,
    nodeId: digest('submission-node'),
    resultDigest: digest('submission-result'),
    contentDigest: digest('submission-result'),
  };
  const callerReservation = seal(
    {
      schemaVersion: 1 as const,
      kind: 'task-strategy-caller-implementation-reservation.v1' as const,
      sessionId: subject.sessionId,
      subjectDigest: subject.subjectDigest,
      grantId: GRANT_ID,
      transitionDigest: digest('transition'),
      assignment: callerAssignment,
      submissionNodeId: callerContent.nodeId,
      submissionResultDigest: callerContent.resultDigest,
      output,
      createdAt,
    },
    'reservationDigest',
  ) satisfies TaskStrategyCallerImplementationReservation;
  const callerRoleResult = seal(
    {
      schemaVersion: 1 as const,
      form: 'granted-caller-supplied' as const,
      role: 'task-implementer' as const,
      targetDigest: subject.subjectDigest,
      assignment: callerAssignment,
      author,
      participant: callerAssignment.participant,
      orchestration: 'caller-supplied' as const,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'none' as const,
      content: callerContent,
      providerInvocation: null,
      grantUse: grantUse(callerAssignment, callerContent),
      directHumanReviewAttestation: null,
    },
    'resultDigest',
    ROLE_RESULT_SCHEMA,
  );
  const callerResult = seal(
    {
      schemaVersion: 1 as const,
      kind: 'task-strategy-caller-implementation-binding.v1' as const,
      sessionId: subject.sessionId,
      subjectDigest: subject.subjectDigest,
      transitionDigest: callerReservation.transitionDigest,
      submissionNodeId: callerContent.nodeId,
      submissionResultDigest: callerContent.resultDigest,
      resultNodeId: digest('caller-result-node'),
      resultDigest: digest('caller-result'),
      roleResult: callerRoleResult,
      output,
      createdAt,
    },
    'bindingDigest',
  ) satisfies TaskStrategyCallerImplementationBinding;
  return { reservation, result, callerReservation, callerResult };
}

function grantUse(
  assignment: GrantedRoleAssignment,
  content: RoleContentAdmission,
): CollaborationGrantUseProjection {
  const payload = {
    version: 2 as const,
    signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    grantId: assignment.grantId,
    repositoryId: 'record-contract',
    repositoryOrigin: 'git@example.invalid:record-contract.git',
    policyBlob: '5'.repeat(40),
    collaborationPolicyDigest: digest('collaboration-policy'),
    changeId: 'record-contract',
    taskId: '1.1',
    baselineCommit: '3'.repeat(40),
    baselineTree: '4'.repeat(40),
    targetDigest: assignment.targetDigest,
    lifecyclePhase: 'task-implementation' as const,
    rolePair: {
      authorRole: 'red-author' as const,
      conflictingRole: 'task-implementer' as const,
    },
    availableActor:
      assignment.providerId === null
        ? {
            kind: 'caller' as const,
            callerId: 'caller-record-contract',
            assurance: 'runtime-hint' as const,
          }
        : {
            kind: 'provider' as const,
            providerId: assignment.providerId,
            assurance: 'self-declared' as const,
          },
    degradedForm: assignment.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    reason: 'No provider-independent implementation candidate is callable.',
    issuedAt: CREATED_AT,
    expiresAt: '2026-09-23T01:30:00.000Z',
    maxUses: 1 as const,
    signer: 'fixture-maintainer',
  };
  const envelope = { payload, signature: 'fixture-signature' };
  return {
    schemaVersion: 1,
    grantId: assignment.grantId,
    signedEnvelopeDigest: digest(canonicalJson(envelope)),
    transitionDigest: digest('transition'),
    reservedAt: CREATED_AT,
    lifecyclePhase: 'task-implementation',
    targetDigest: assignment.targetDigest,
    degradedForm: assignment.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    assignment,
    structuredContent: {
      kind: content.kind,
      nodeId: content.nodeId,
      resultDigest: content.resultDigest,
    },
    contentAuthority: 'reference-only-requires-governing-validator',
    directHumanReviewAttestation: null,
    retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
    replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
    residuals: COLLABORATION_GRANT_RESIDUALS,
    envelope,
  };
}

function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function seal<T extends object, K extends string>(
  value: T,
  key: K,
  schema?: string,
): T & Record<K, string> {
  const body = { ...value } as Record<string, unknown>;
  delete body[key];
  return {
    ...value,
    [key]: digest(
      canonicalJson(schema === undefined ? body : { schema, ...body }),
    ),
  } as T & Record<K, string>;
}

function assertDetachedFrozen(input: unknown, parsed: unknown): void {
  if (typeof input !== 'object' || input === null) return;
  assert.ok(typeof parsed === 'object' && parsed !== null);
  assert.notStrictEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(input), false);
  for (const [key, value] of Object.entries(input)) {
    assertDetachedFrozen(value, (parsed as Record<string, unknown>)[key]);
  }
}

const families = [
  {
    name: 'provider reservation',
    key: 'recordDigest',
    create: (options?: FixtureOptions) => records(options).reservation,
    parse: parseTaskStrategyImplementationReservation,
  },
  {
    name: 'provider result',
    key: 'bindingDigest',
    create: (options?: FixtureOptions) => records(options).result,
    parse: parseTaskStrategyImplementationResultBinding,
  },
  {
    name: 'caller reservation',
    key: 'reservationDigest',
    create: (options?: FixtureOptions) => records(options).callerReservation,
    parse: parseTaskStrategyCallerImplementationReservation,
  },
  {
    name: 'caller result',
    key: 'bindingDigest',
    create: (options?: FixtureOptions) => records(options).callerResult,
    parse: parseTaskStrategyCallerImplementationBinding,
  },
] as const;

for (const providerForm of [
  'ordinary-independent',
  'ordinary-same-provider',
  'granted',
] as const) {
  test(`provider records accept ${providerForm} without journal or composition`, () => {
    const { reservation, result } = records({ providerForm });
    assert.deepEqual(
      parseTaskStrategyImplementationReservation(reservation),
      reservation,
    );
    assert.deepEqual(
      parseTaskStrategyImplementationResultBinding(result),
      result,
    );
  });
}

for (const family of families) {
  test(`${family.name} preserves SHA-1/SHA-256 IDs and Date.parse timestamp acceptance`, () => {
    for (const gitIdLength of [40, 64] as const) {
      for (const createdAt of [
        CREATED_AT,
        '2026-09-23',
        'Wed, 23 Sep 2026 01:00:00 GMT',
      ]) {
        const value = family.create({ gitIdLength, createdAt });
        assert.deepEqual(family.parse(value), value);
      }
    }
  });

  test(`${family.name} rejects unknown keys, invalid timestamps and digest drift`, () => {
    const value = family.create();
    for (const invalid of [
      seal({ ...value, extra: true }, family.key),
      seal({ ...value, createdAt: 'invalid timestamp' }, family.key),
      { ...value, [family.key]: '0'.repeat(64) },
    ])
      assert.throws(() => family.parse(invalid), STALE);
  });

  test(`${family.name} detaches and deeply freezes accepted records without mutating input`, () => {
    const input = structuredClone(family.create());
    const snapshot = structuredClone(input);
    const parsed = family.parse(input);
    assert.deepEqual(parsed, snapshot);
    assertDetachedFrozen(input, parsed);
    Object.assign(input, { createdAt: 'changed after parsing' });
    for (const nested of Object.values(input)) {
      if (typeof nested === 'object' && nested !== null)
        Object.assign(nested, { fixtureMutation: true });
    }
    assert.deepEqual(parsed, snapshot);
  });
}

test('provider reservation rejects independently valid records cross-bound to another subject, baseline or request', () => {
  const { reservation } = records();
  const { reservation: other } = records({ gitIdLength: 64 });
  const sameProvider = records({
    providerForm: 'ordinary-same-provider',
  }).reservation;
  for (const invalid of [
    { ...reservation, sessionId: 'session-other' },
    { ...reservation, manifest: other.manifest },
    {
      ...reservation,
      baseline: { ...reservation.baseline, head: '9'.repeat(40) },
    },
    { ...reservation, authorizationNodeId: digest('other-authorization') },
    { ...reservation, assignment: sameProvider.assignment },
  ]) {
    assert.throws(
      () =>
        parseTaskStrategyImplementationReservation(
          seal(invalid, 'recordDigest'),
        ),
      STALE,
    );
  }
});

test('provider reservation validates nested request and subject digests despite a fresh outer digest', () => {
  const { reservation } = records();
  for (const invalid of [
    {
      ...reservation,
      request: {
        ...reservation.request,
        requestDigest: digest('wrong-request'),
      },
    },
    {
      ...reservation,
      subject: {
        ...reservation.subject,
        subjectDigest: digest('wrong-subject'),
      },
    },
  ])
    assert.throws(
      () =>
        parseTaskStrategyImplementationReservation(
          seal(invalid, 'recordDigest'),
        ),
      STALE,
    );
});

test('provider reservation preserves nullable and change-bound TaskMandate wire facts', () => {
  const { reservation } = records();
  const mandateBinding = {
    schemaVersion: 1 as const,
    mandateTaskId: 'mandate-task',
    mandateId: 'mandate-record',
    mandateDigest: digest('mandate'),
    changeId: reservation.changeId,
    externalAuditRoot: 'existing-nonempty-audit-reference',
  };
  const value = seal({ ...reservation, mandateBinding }, 'recordDigest');
  assert.deepEqual(parseTaskStrategyImplementationReservation(value), value);
  assert.throws(
    () =>
      parseTaskStrategyImplementationReservation(
        seal(
          {
            ...value,
            mandateBinding: { ...mandateBinding, changeId: 'another-change' },
          },
          'recordDigest',
        ),
      ),
    STALE,
  );
});

test('provider result rejects observation, invocation and output-session mismatches after redigesting', () => {
  const { result } = records();
  for (const invalid of [
    { ...result, subjectDigest: digest('other-subject') },
    { ...result, providerObservationNodeId: digest('other-observation') },
    { ...result, requestDigest: digest('other-request') },
    { ...result, invocationId: 'invocation-other' },
    { ...result, outputDigest: digest('other-output') },
    { ...result, output: { ...result.output, sessionId: 'session-other' } },
  ])
    assert.throws(
      () =>
        parseTaskStrategyImplementationResultBinding(
          seal(invalid, 'bindingDigest'),
        ),
      STALE,
    );
});

test('provider result retains nested role digest and participant/current-content checks', () => {
  const { result } = records();
  for (const roleResult of [
    { ...result.roleResult, resultDigest: digest('wrong-role-result') },
    seal(
      {
        ...result.roleResult,
        participant: {
          ...result.roleResult.participant,
          sessionId: 'other-provider-session',
        },
      },
      'resultDigest',
      ROLE_RESULT_SCHEMA,
    ),
    seal(
      {
        ...result.roleResult,
        content: { ...result.roleResult.content, current: false },
      },
      'resultDigest',
      ROLE_RESULT_SCHEMA,
    ),
  ])
    assert.throws(
      () =>
        parseTaskStrategyImplementationResultBinding(
          seal({ ...result, roleResult }, 'bindingDigest'),
        ),
      STALE,
    );
});

test('granted provider result requires its original grant form and structured content', () => {
  const { result } = records({ providerForm: 'granted' });
  const use = result.roleResult.grantUse;
  assert.ok(use);
  for (const changed of [
    { ...result.roleResult, grantUse: null },
    { ...result.roleResult, form: 'ordinary-provider' },
    { ...result.roleResult, grantUse: { ...use, grantId: OTHER_GRANT_ID } },
    {
      ...result.roleResult,
      grantUse: {
        ...use,
        structuredContent: {
          ...use.structuredContent,
          nodeId: digest('other-node'),
        },
      },
    },
  ]) {
    const roleResult = seal(changed, 'resultDigest', ROLE_RESULT_SCHEMA);
    assert.throws(
      () =>
        parseTaskStrategyImplementationResultBinding(
          seal({ ...result, roleResult }, 'bindingDigest'),
        ),
      STALE,
    );
  }
});

test('caller reservation retains caller-only assignment, grant and subject bindings', () => {
  const { callerReservation: value } = records();
  for (const invalid of [
    { ...value, grantId: OTHER_GRANT_ID },
    { ...value, subjectDigest: digest('other-subject') },
    {
      ...value,
      assignment: { ...value.assignment, callableProviderIds: ['codex'] },
    },
    {
      ...value,
      assignment: {
        ...value.assignment,
        participant: { ...value.assignment.participant, engineSpawned: true },
      },
    },
    { ...value, output: { ...value.output, sessionId: 'session-other' } },
  ])
    assert.throws(
      () =>
        parseTaskStrategyCallerImplementationReservation(
          seal(invalid, 'reservationDigest'),
        ),
      STALE,
    );
});

test('caller result retains participant, transition, effect and submission links after both digests are recomputed', () => {
  const { callerResult: value } = records();
  const use = value.roleResult.grantUse;
  for (const changed of [
    {
      ...value.roleResult,
      participant: {
        ...value.roleResult.participant,
        principalId: 'another-caller',
      },
    },
    {
      ...value.roleResult,
      grantUse: { ...use, transitionDigest: digest('other-transition') },
    },
    {
      ...value.roleResult,
      grantUse: { ...use, authorizedEffect: 'another-effect' },
    },
    {
      ...value.roleResult,
      grantUse: {
        ...use,
        assignment: { ...use.assignment, grantId: OTHER_GRANT_ID },
      },
    },
    {
      ...value.roleResult,
      grantUse: {
        ...use,
        structuredContent: {
          ...use.structuredContent,
          resultDigest: digest('other-submission'),
        },
      },
    },
  ]) {
    const roleResult = seal(changed, 'resultDigest', ROLE_RESULT_SCHEMA);
    assert.throws(
      () =>
        parseTaskStrategyCallerImplementationBinding(
          seal({ ...value, roleResult }, 'bindingDigest'),
        ),
      STALE,
    );
  }
});

test('caller result rejects a stale nested admitted-result digest and provider masquerading as caller', () => {
  const { callerResult: value, result } = records();
  for (const roleResult of [
    { ...value.roleResult, resultDigest: digest('wrong-role-result') },
    result.roleResult,
  ])
    assert.throws(
      () =>
        parseTaskStrategyCallerImplementationBinding(
          seal({ ...value, roleResult }, 'bindingDigest'),
        ),
      STALE,
    );
});

test('all patch-bearing records retain exact base64 byte-digest validation', () => {
  const { result, callerReservation, callerResult } = records();
  const output = {
    ...result.output,
    patchDigest: digest('different patch bytes'),
  };
  assert.throws(
    () =>
      parseTaskStrategyImplementationResultBinding(
        seal({ ...result, output }, 'bindingDigest'),
      ),
    STALE,
  );
  assert.throws(
    () =>
      parseTaskStrategyCallerImplementationReservation(
        seal({ ...callerReservation, output }, 'reservationDigest'),
      ),
    STALE,
  );
  assert.throws(
    () =>
      parseTaskStrategyCallerImplementationBinding(
        seal({ ...callerResult, output }, 'bindingDigest'),
      ),
    STALE,
  );
});
