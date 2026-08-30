import assert from 'node:assert/strict';
import test from 'node:test';

import type { CentralGrantCompletedAuthorityRefV1 } from '@jigwright/core/central-grant-port';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  assertRoleIndependenceContinuationObservation,
  assertRoleIndependenceContinuationParameters,
  authenticateRoleIndependenceContinuationActivation,
  createRoleIndependenceContinuationGrantRequest,
  ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID,
  roleIndependenceContinuationParametersDigest,
  roleIndependenceContinuationStateBinding,
  roleIndependenceContinuationTransitionDefinitions,
  type RoleIndependenceContinuationObservationV1,
  type RoleIndependenceContinuationOwnerV1,
  type RoleIndependenceContinuationParametersV1,
} from '../src/modules/authority/role-independence-continuation-grant.ts';
import { grantSha256 } from '../src/modules/authority/grant-primitives.ts';

test('strict parameters preserve every source-specific owner binding', () => {
  for (const owner of owners()) {
    const parameters = assertRoleIndependenceContinuationParameters(
      parametersFor(owner),
    );
    assert.deepEqual(parameters.owner, owner);
    assert.equal(parameters.targetDigest, ownerTarget(owner));
    assert(Object.isFrozen(parameters));
    assert(Object.isFrozen(parameters.owner));
  }

  const plan = owners()[1]!;
  assert.throws(
    () =>
      assertRoleIndependenceContinuationParameters({
        ...parametersFor(plan),
        owner: { ...plan, unexpectedLegacyGrantId: 'grant-legacy' },
      }),
    hasCode('ROLE_INDEPENDENCE_CONTINUATION_GRANT_INVALID'),
  );
  assert.throws(
    () =>
      assertRoleIndependenceContinuationParameters({
        ...parametersFor(plan),
        targetDigest: digest('0'),
      }),
    hasCode('ROLE_INDEPENDENCE_CONTINUATION_GRANT_INVALID'),
  );
});

test('request builder emits one exact non-retry Central transition candidate', () => {
  const observation = observed(parametersFor(owners()[0]!), null);
  const request = createRoleIndependenceContinuationGrantRequest(
    observation,
    'Authorize only this exact degraded blind-survey continuation.',
  );

  assert.equal(request.sourceModuleId, 'role-independence-continuation');
  assert.equal(
    request.failureCode,
    'role-independence-continuation-grant-required',
  );
  assert.deepEqual(
    request.stateBinding,
    roleIndependenceContinuationStateBinding(observation),
  );
  assert.deepEqual(
    request.candidates.map(({ transitionId }) => transitionId),
    [ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID],
  );
  assert.deepEqual(request.facts.owner, observation.parameters.owner);
  assert.equal(request.facts.parametersDigest, observation.parametersDigest);
  assert.deepEqual(request.candidates[0]!.parameters, observation.parameters);
});

test('state drift changes the binding and a refused observation cannot request or execute', async () => {
  const parameters = assertRoleIndependenceContinuationParameters(
    parametersFor(owners()[2]!),
  );
  let observation = observed(parameters, null);
  const port = fakePort(
    () => observation,
    (activation) => {
      observation = observed(parameters, activation);
      return observation;
    },
  );
  const definition =
    roleIndependenceContinuationTransitionDefinitions(port)[0]!;
  const before = await definition.observeState(parameters);
  observation = Object.freeze({
    ...observation,
    sourceStateDigest: digest('0'),
  });
  assert.notDeepEqual(await definition.observeState(parameters), before);

  observation = Object.freeze({
    ...observation,
    applicability: Object.freeze({
      status: 'refused' as const,
      reasonCode: 'source-state-changed',
      factsDigest: shaDigest('e'),
    }),
  });
  assert.throws(
    () =>
      createRoleIndependenceContinuationGrantRequest(
        observation,
        'A refused source cannot request authority.',
      ),
    hasCode('ROLE_INDEPENDENCE_CONTINUATION_GRANT_NOT_APPLICABLE'),
  );
  await assert.rejects(
    definition.execute(executionContext(parameters)),
    hasCode('ROLE_INDEPENDENCE_CONTINUATION_STATE_CHANGED'),
  );
});

test('activation is idempotent for one Grant operation and authenticates against its completed authority', async () => {
  const parameters = assertRoleIndependenceContinuationParameters(
    parametersFor(owners()[3]!),
  );
  let observation = observed(parameters, null);
  let activationCalls = 0;
  const port = fakePort(
    () => observation,
    (activation) => {
      activationCalls += 1;
      observation = observed(parameters, activation);
      return observation;
    },
  );
  const definition =
    roleIndependenceContinuationTransitionDefinitions(port)[0]!;
  const context = executionContext(parameters);

  const first = await definition.execute(context);
  const replay = await definition.execute({ ...context, recovered: true });
  assert.equal(first.outcome, 'completed');
  assert.deepEqual(replay, first);
  assert.equal(activationCalls, 1);

  const authority: CentralGrantCompletedAuthorityRefV1 = Object.freeze({
    contractVersion: 'central-grant-completed-authority-ref.v1',
    challengeId: context.challengeId,
    challengeDigest: context.approvalSubject.challengeDigest,
    transitionId: ROLE_INDEPENDENCE_CONTINUATION_TRANSITION_ID,
    operationId: context.operationId,
    terminalOutcomeDigest: grantSha256(canonicalJson(first)),
  });
  const authenticated = authenticateRoleIndependenceContinuationActivation(
    observation,
    authority,
    context.approvalSubjectDigest,
  );
  assert.equal(authenticated.operationId, context.operationId);
  assert.equal(authenticated.parametersDigest, observation.parametersDigest);

  assert.throws(
    () =>
      authenticateRoleIndependenceContinuationActivation(
        observation,
        { ...authority, operationId: '33333333-3333-4333-8333-333333333333' },
        context.approvalSubjectDigest,
      ),
    hasCode('ROLE_INDEPENDENCE_CONTINUATION_ACTIVATION_INVALID'),
  );
  assert.throws(
    () =>
      authenticateRoleIndependenceContinuationActivation(
        observation,
        { ...authority, terminalOutcomeDigest: shaDigest('f') },
        context.approvalSubjectDigest,
      ),
    hasCode('ROLE_INDEPENDENCE_CONTINUATION_ACTIVATION_INVALID'),
  );
  assert.throws(
    () =>
      authenticateRoleIndependenceContinuationActivation(
        observation,
        authority,
        'caller-controlled-not-a-digest',
      ),
    hasCode('ROLE_INDEPENDENCE_CONTINUATION_ACTIVATION_INVALID'),
  );
});

test('a different Grant operation cannot reuse or overwrite an activation', async () => {
  const parameters = assertRoleIndependenceContinuationParameters(
    parametersFor(owners()[4]!),
  );
  const existing = activationFor(parameters, executionContext(parameters));
  const observation = observed(parameters, existing);
  const definition = roleIndependenceContinuationTransitionDefinitions(
    fakePort(
      () => observation,
      () => assert.fail('a conflicting activation must not be overwritten'),
    ),
  )[0]!;

  await assert.rejects(
    definition.execute({
      ...executionContext(parameters),
      operationId: '33333333-3333-4333-8333-333333333333',
    }),
    hasCode('ROLE_INDEPENDENCE_CONTINUATION_ACTIVATION_CONFLICT'),
  );
});

function owners(): readonly RoleIndependenceContinuationOwnerV1[] {
  return Object.freeze([
    Object.freeze({
      kind: 'propose-blind-survey' as const,
      changeId: 'demo-change',
      intentDigest: digest('a'),
      actorResolutionDigest: digest('b'),
      currentInvestigation: null,
    }),
    Object.freeze({
      kind: 'propose-plan-review' as const,
      investigationId: 'investigation-demo-1',
      changeId: 'demo-change',
      revision: 3,
      planningGenerationDigest: digest('c'),
      planningSubjectDigest: digest('d'),
      materializationNodeId: digest('e'),
      materializationResultDigest: digest('f'),
      targetSnapshotNodeId: digest('1'),
      targetSnapshotResultDigest: digest('2'),
      requirementDigest: digest('3'),
    }),
    Object.freeze({
      kind: 'task-strategy-implementation' as const,
      sessionId: 'session-demo-1',
      changeId: 'demo-change',
      taskId: '1.1',
      transactionDigest: digest('4'),
      subjectDigest: digest('5'),
      redEvidenceNodeId: digest('6'),
      redEvidenceResultDigest: digest('7'),
      sourceTree: gitObject('8'),
      attempt: 1,
      failedInvocationId: null,
    }),
    Object.freeze({
      kind: 'task-diff-review' as const,
      sessionId: 'session-demo-1',
      changeId: 'demo-change',
      taskId: '1.1',
      subjectDigest: digest('9'),
      candidateTree: gitObject('a'),
      taskContractDigest: digest('b'),
      requiredCheckPolicyDigest: digest('c'),
      checkEvidenceDigest: digest('d'),
      reviewPolicyDigest: digest('e'),
      implementationActorDigest: digest('f'),
      requestDigest: digest('1'),
      attempt: 1,
    }),
    Object.freeze({
      kind: 'task-diff-review-continuation' as const,
      sessionId: 'session-demo-1',
      changeId: 'demo-change',
      taskId: '1.1',
      subjectDigest: digest('2'),
      reviewRecordDigest: digest('3'),
      responseDigest: digest('4'),
      continuationTargetDigest: digest('5'),
      inputDigest: digest('6'),
    }),
  ]);
}

function parametersFor(
  owner: RoleIndependenceContinuationOwnerV1,
): RoleIndependenceContinuationParametersV1 {
  const sameProvider = owner.kind !== 'task-diff-review-continuation';
  return {
    schemaVersion: 1,
    kind: 'role-independence-continuation-activation.v1',
    repository: {
      repositoryId: 'github:example/jigwright',
      repositoryOrigin: 'git@github.com:example/jigwright.git',
      policyBlob: gitObject('7'),
      policyDigest: digest('8'),
    },
    baseline: { commit: gitObject('9'), tree: gitObject('a') },
    owner,
    targetDigest: ownerTarget(owner),
    author: {
      providerId: 'codex',
      sessionId: 'author-session-1',
      principalId: null,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    requestedDegradation: sameProvider
      ? {
          kind: 'same-provider-fresh-session',
          participant: {
            providerId: 'codex',
            sessionId: 'provider-session-fresh-1',
            principalId: null,
            identityAssurance: 'runtime-hint',
            engineSpawned: true,
          },
          stagedInputDigest: null,
        }
      : {
          kind: 'caller-supplied',
          participant: {
            providerId: null,
            sessionId: null,
            principalId: 'external-reviewer-1',
            identityAssurance: 'self-declared',
            engineSpawned: false,
          },
          stagedInputDigest: digest('b'),
        },
    callableProviderIds: sameProvider ? ['codex'] : [],
    providerPolicyDigest: digest('c'),
    providerRegistryDigest: digest('d'),
    assignmentDigest: digest('e'),
    mandateBinding: {
      schemaVersion: 1,
      mandateTaskId: '1.1',
      mandateId: 'mandate-demo-1',
      mandateDigest: digest('f'),
      changeId: 'demo-change',
      externalAuditRoot: '/tmp/external-audit',
    },
  };
}

function ownerTarget(owner: RoleIndependenceContinuationOwnerV1): string {
  switch (owner.kind) {
    case 'propose-blind-survey':
      return owner.intentDigest;
    case 'propose-plan-review':
      return owner.planningSubjectDigest;
    case 'task-strategy-implementation':
    case 'task-diff-review':
      return owner.subjectDigest;
    case 'task-diff-review-continuation':
      return owner.continuationTargetDigest;
  }
}

function observed(
  candidate: RoleIndependenceContinuationParametersV1,
  activation: RoleIndependenceContinuationObservationV1['activation'],
): RoleIndependenceContinuationObservationV1 {
  const parameters = assertRoleIndependenceContinuationParameters(candidate);
  return assertRoleIndependenceContinuationObservation({
    schemaVersion: 1,
    kind: 'role-independence-continuation-observation.v1',
    parameters,
    parametersDigest: roleIndependenceContinuationParametersDigest(parameters),
    currentRepositoryHead: gitObject('9'),
    currentRepositoryTree: gitObject('a'),
    sourceStateDigest: digest('b'),
    providerAvailabilityDigest: digest('c'),
    mandateStateDigest: digest('d'),
    competingAttemptDigest: null,
    applicability: { status: 'applicable' },
    activation,
  });
}

function fakePort(
  observe: () => RoleIndependenceContinuationObservationV1,
  activate: (
    activation: NonNullable<
      RoleIndependenceContinuationObservationV1['activation']
    >,
  ) => RoleIndependenceContinuationObservationV1,
) {
  return {
    observe() {
      return observe();
    },
    activate(context: ReturnType<typeof executionContext>) {
      return activate(activationFor(context.parameters, context));
    },
  };
}

function activationFor(
  parameters: RoleIndependenceContinuationParametersV1,
  context: ReturnType<typeof executionContext>,
) {
  return Object.freeze({
    challengeId: context.challengeId,
    challengeDigest: context.approvalSubject.challengeDigest,
    operationId: context.operationId,
    approvalSubjectDigest: context.approvalSubjectDigest,
    parametersDigest: observed(parameters, null).parametersDigest,
  });
}

function executionContext(
  parameters: RoleIndependenceContinuationParametersV1,
) {
  return {
    parameters,
    approvalSubject: {
      schemaVersion: 1 as const,
      kind: 'grant-approval-subject.v1' as const,
      challengeDigest: shaDigest('1'),
      choiceId: shaDigest('2'),
      approvalMethod: 'human-presence' as const,
      reasonCode: 'approve-exact-role-independence-degradation',
      reason: 'Approve this exact degraded continuation.',
      reasonDigest: shaDigest('3'),
      stateDigest: shaDigest('4'),
      expiresAt: '2030-01-02T03:04:05.000Z',
      sessionNonce: 'human-gate-session-1',
    },
    approvalSubjectDigest: shaDigest('5'),
    challengeId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
    recovered: false,
    assertLifecycleOwned() {},
  };
}

function digest(character: string): string {
  return character.repeat(64);
}

function shaDigest(character: string): `sha256:${string}` {
  return `sha256:${digest(character)}`;
}

function gitObject(character: string): string {
  return character.repeat(40);
}

function hasCode(expected: string) {
  return (error: unknown) =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: unknown }).code === expected;
}
