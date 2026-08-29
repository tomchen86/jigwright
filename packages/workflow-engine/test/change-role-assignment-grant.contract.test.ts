import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertChangeRoleAssignmentGrantParameters,
  CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID,
  changeRoleAssignmentGrantStateBinding,
  changeRoleAssignmentGrantTransitionDefinitions,
  createChangeRoleAssignmentGrantRequest,
  type ChangeRoleAssignmentGrantObservationV1,
} from '../src/modules/provider-orchestration/change-role-assignment-grant.ts';
import { rethrowChangeRoleAssignmentGrantCurrentSourceDrift } from '../src/composition-root/change-role-assignment-grant-production.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { AgentProviderConfigFileError } from '../src/runtime/provider-execution/agent-provider-config-file.ts';

const RECORD_DIGEST = '1'.repeat(64);
const ASSIGNMENT_DIGEST = '2'.repeat(64);
const REQUIREMENT_DIGEST = '3'.repeat(64);

test('below-floor role assignment emits one exact Central Fail-Grant transition', async () => {
  let observation = observed(null);
  const port = {
    observe() {
      return observation;
    },
    activate(
      input: Parameters<
        ReturnType<
          typeof changeRoleAssignmentGrantTransitionDefinitions
        >[number]['execute']
      >[0],
    ) {
      observation = observed({
        challengeId: input.challengeId,
        challengeDigest: input.approvalSubject.challengeDigest,
        operationId: input.operationId,
        approvalSubjectDigest: input.approvalSubjectDigest,
      });
      return observation;
    },
  };
  const request = createChangeRoleAssignmentGrantRequest(
    observation,
    'Allow this exact author/reviewer co-location for the current assignment.',
  );

  assert.equal(request.sourceModuleId, 'agent-runtime-role-assignment');
  assert.equal(request.failureCode, 'role-independence-grant-required');
  assert.deepEqual(
    request.stateBinding,
    changeRoleAssignmentGrantStateBinding(observation),
  );
  assert.deepEqual(
    request.candidates.map(({ transitionId }) => transitionId),
    [CHANGE_ROLE_ASSIGNMENT_GRANT_TRANSITION_ID],
  );
  assert.deepEqual(request.facts, {
    repositoryId: 'github:example/jigwright',
    changeId: 'demo-change',
    planningGeneration: '4'.repeat(64),
    invocationId: 'provider-invocation-1',
    recordDigest: RECORD_DIGEST,
    assignmentDigest: ASSIGNMENT_DIGEST,
    grantRequirementDigest: REQUIREMENT_DIGEST,
    exactRolePairs: ['author-reviewer'],
  });

  const definition = changeRoleAssignmentGrantTransitionDefinitions(port)[0]!;
  const parameters = definition.validateParameters(
    request.candidates[0]!.parameters,
  );
  const before = await definition.observeState(parameters);
  const outcome = await definition.execute({
    parameters,
    approvalSubject: {
      schemaVersion: 1,
      kind: 'grant-approval-subject.v1',
      challengeDigest: `sha256:${'5'.repeat(64)}`,
      choiceId: `sha256:${'6'.repeat(64)}`,
      approvalMethod: 'human-presence',
      reasonCode: 'approve-exact-role-independence-exception',
      reason: 'This exact assignment is acceptable.',
      reasonDigest: `sha256:${'7'.repeat(64)}`,
      stateDigest: before.digest,
      expiresAt: '2030-01-02T03:04:05.000Z',
      sessionNonce: 'human-gate-session-1',
    },
    approvalSubjectDigest: `sha256:${'8'.repeat(64)}`,
    challengeId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
    recovered: false,
    assertLifecycleOwned() {},
  });

  assert.equal(outcome.outcome, 'completed');
  assert.notDeepEqual(await definition.observeState(parameters), before);
  assert.deepEqual(outcome.details, {
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-activated.v1',
    changeId: 'demo-change',
    recordDigest: RECORD_DIGEST,
    assignmentDigest: ASSIGNMENT_DIGEST,
    exactRolePairs: ['author-reviewer'],
  });
});

test('an already activated role assignment cannot create another Fail-Grant request', () => {
  assert.throws(
    () =>
      createChangeRoleAssignmentGrantRequest(
        observed({
          challengeId: '11111111-1111-4111-8111-111111111111',
          challengeDigest: `sha256:${'5'.repeat(64)}`,
          operationId: '22222222-2222-4222-8222-222222222222',
          approvalSubjectDigest: `sha256:${'8'.repeat(64)}`,
        }),
        'Duplicate approval must not be requested.',
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_NOT_APPLICABLE',
  );
});

test('only deterministic current-source drift is normalized for prepared recovery', () => {
  for (const code of [
    'CHANGE_ROLE_ASSIGNMENT_GRANT_CURRENT_MANIFEST_REQUIRED',
    'AGENT_RUNTIME_CURRENT_MANIFEST_REQUIRED',
    'AGENT_RUNTIME_DATA_AUTHORIZATION_STALE',
    'AGENT_PROVIDER_CONFIG_FILE_STALE',
    'AGENT_RUNTIME_ASSIGNMENT_SOURCE_STALE',
    'AGENT_RUNTIME_ASSIGNMENT_UNSATISFIED',
    'AGENT_RUNTIME_DATA_AUTHORIZATION_DENIED',
    'AGENT_RUNTIME_PROVIDER_REGISTRY_MISMATCH',
    'AGENT_RUNTIME_DEFINITION_MISMATCH',
  ]) {
    const drift = workflowError(
      code,
      'The exact current role-assignment source changed.',
      ExitCode.staleState,
    );
    assert.throws(
      () => rethrowChangeRoleAssignmentGrantCurrentSourceDrift(drift),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_STATE_CHANGED' &&
        'details' in error &&
        (error.details as { sourceErrorCode?: unknown })?.sourceErrorCode ===
          code,
    );
  }

  for (const hard of [
    workflowError(
      'AGENT_RUNTIME_PROVIDER_CONFIG_REQUIRED',
      'Explicit provider configuration is required.',
      ExitCode.unsafeEnvironment,
    ),
    new AgentProviderConfigFileError('AGENT_PROVIDER_CONFIG_FILE_UNAVAILABLE'),
    new AgentProviderConfigFileError('AGENT_PROVIDER_CONFIG_FILE_UNSAFE'),
    workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_MISMATCH',
      'The immutable invocation does not match.',
      ExitCode.verification,
    ),
    workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_CONFLICT',
      'A different activation already exists.',
      ExitCode.conflict,
    ),
    workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_INVALID',
      'The activation record is corrupt.',
      ExitCode.verification,
    ),
    workflowError(
      'GRANT_TRANSITION_EFFECT_UNKNOWN',
      'The transition may have produced an unknown effect.',
      ExitCode.verification,
    ),
  ]) {
    assert.throws(
      () => rethrowChangeRoleAssignmentGrantCurrentSourceDrift(hard),
      (error: unknown) => error === hard,
    );
  }
});

test('returned immutable invocation mismatch and observed activation collision are hard errors', async () => {
  const request = createChangeRoleAssignmentGrantRequest(
    observed(null),
    'Authorize only this exact current role assignment.',
  );
  const parameters = assertChangeRoleAssignmentGrantParameters(
    request.candidates[0]!.parameters,
  );
  const context = executionContext(parameters);

  const mismatchedInvocation = changeRoleAssignmentGrantTransitionDefinitions({
    observe() {
      return Object.freeze({
        ...observed(null),
        invocationId: 'a-different-immutable-invocation',
      });
    },
    activate() {
      assert.fail('immutable invocation mismatch must block activation');
    },
  })[0]!;
  await assert.rejects(
    mismatchedInvocation.execute(context),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_MISMATCH',
  );

  const activationCollision = changeRoleAssignmentGrantTransitionDefinitions({
    observe() {
      return observed({
        challengeId: '33333333-3333-4333-8333-333333333333',
        challengeDigest: `sha256:${'a'.repeat(64)}`,
        operationId: '44444444-4444-4444-8444-444444444444',
        approvalSubjectDigest: `sha256:${'b'.repeat(64)}`,
      });
    },
    activate() {
      assert.fail('activation collision must not be normalized or overwritten');
    },
  })[0]!;
  await assert.rejects(
    activationCollision.execute(context),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_CONFLICT',
  );
});

test('immutable invocation mismatch and activation collision remain hard errors', async () => {
  const context = executionContext(
    assertChangeRoleAssignmentGrantParameters(
      createChangeRoleAssignmentGrantRequest(
        observed(null),
        'Authorize only this exact current role assignment.',
      ).candidates[0]!.parameters,
    ),
  );

  for (const [code, surface] of [
    ['CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_MISMATCH', 'observe'],
    ['CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_NOT_PREPARED', 'observe'],
    ['CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_CONFLICT', 'activate'],
  ] as const) {
    const definition = changeRoleAssignmentGrantTransitionDefinitions({
      observe() {
        if (surface === 'observe') {
          throw workflowError(
            code,
            'Immutable role-assignment state conflicts.',
            ExitCode.verification,
          );
        }
        return observed(null);
      },
      activate() {
        throw workflowError(
          code,
          'Durable role-assignment activation conflicts.',
          ExitCode.conflict,
        );
      },
    })[0]!;
    await assert.rejects(
      definition.execute(context),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === code,
    );
  }
});

function executionContext(
  parameters: ReturnType<typeof assertChangeRoleAssignmentGrantParameters>,
) {
  return {
    parameters,
    approvalSubject: {
      schemaVersion: 1 as const,
      kind: 'grant-approval-subject.v1' as const,
      challengeDigest: `sha256:${'5'.repeat(64)}` as const,
      choiceId: `sha256:${'6'.repeat(64)}` as const,
      approvalMethod: 'human-presence' as const,
      reasonCode: 'approve-exact-role-independence-exception',
      reason: 'This exact assignment is acceptable.',
      reasonDigest: `sha256:${'7'.repeat(64)}` as const,
      stateDigest: `sha256:${'9'.repeat(64)}` as const,
      expiresAt: '2030-01-02T03:04:05.000Z',
      sessionNonce: 'human-gate-session-integrity',
    },
    approvalSubjectDigest: `sha256:${'8'.repeat(64)}` as const,
    challengeId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
    recovered: true,
    assertLifecycleOwned() {},
  };
}

function observed(
  activation: ChangeRoleAssignmentGrantObservationV1['activation'],
): ChangeRoleAssignmentGrantObservationV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-observation.v1',
    repositoryId: 'github:example/jigwright',
    changeId: 'demo-change',
    planningGeneration: '4'.repeat(64),
    invocationId: 'provider-invocation-1',
    recordDigest: RECORD_DIGEST,
    assignmentDigest: ASSIGNMENT_DIGEST,
    grantRequirementDigest: REQUIREMENT_DIGEST,
    exactRolePairs: Object.freeze(['author-reviewer'] as const),
    activation,
  });
}
