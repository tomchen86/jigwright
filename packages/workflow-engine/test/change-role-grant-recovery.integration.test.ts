import test from 'node:test';
import {
  type ChangeRoleAssignmentGrantObservationV1,
  changeRoleAssignmentGrantTransitionDefinitions,
  createChangeRoleAssignmentGrantRequest,
} from '../src/modules/provider-orchestration/change-role-assignment-grant.ts';
import { workflowError, ExitCode } from '../src/foundation/errors/errors.ts';
import { rethrowChangeRoleAssignmentGrantCurrentSourceDrift } from '../src/composition-root/change-role-assignment-grant-production.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import {
  grantStorePaths,
  readGrantRecord,
  assertGrantLifecycleBarrier,
} from '../src/runtime/storage-journal/grant-store.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  parseGrantPolicyV2,
  codeOwnedApprovalModuleRegistry,
} from '../src/modules/authority/grant-policy.ts';
import assert from 'node:assert/strict';
import { isWorkflowError } from './fixture.ts';
import {
  withRuntime,
  CHALLENGE_ID,
  OPERATION_ID,
  policyInput,
  NOW,
  humanProof,
} from './grant-coordinator-fixture.ts';

test('role-assignment prepared recovery terminalizes production current-source drift and releases the barrier', async () => {
  await withRuntime(async (runtimeRoot) => {
    let drifted = false;
    let activationAttempts = 0;
    let activation: ChangeRoleAssignmentGrantObservationV1['activation'] = null;
    const observation: ChangeRoleAssignmentGrantObservationV1 = Object.freeze({
      schemaVersion: 1,
      kind: 'change-role-assignment-grant-observation.v1',
      repositoryId: 'github:example/jigwright',
      changeId: 'role-grant-recovery',
      planningGeneration: '1'.repeat(64),
      invocationId: 'provider-invocation-role-grant-recovery',
      recordDigest: '2'.repeat(64),
      assignmentDigest: '3'.repeat(64),
      grantRequirementDigest: '4'.repeat(64),
      exactRolePairs: Object.freeze(['author-reviewer'] as const),
      activation: null,
    });
    const definition = changeRoleAssignmentGrantTransitionDefinitions({
      observe() {
        if (activation !== null) {
          return Object.freeze({ ...observation, activation });
        }
        if (drifted) {
          try {
            throw workflowError(
              'AGENT_RUNTIME_DATA_AUTHORIZATION_STALE',
              'The current data-authorization policy changed before activation.',
              ExitCode.staleState,
            );
          } catch (error) {
            rethrowChangeRoleAssignmentGrantCurrentSourceDrift(error);
          }
        }
        return observation;
      },
      activate(context) {
        activationAttempts += 1;
        if (activationAttempts === 1) {
          throw new Error('simulated role-assignment activation crash');
        }
        activation = Object.freeze({
          challengeId: context.challengeId,
          challengeDigest: context.approvalSubject.challengeDigest,
          operationId: context.operationId,
          approvalSubjectDigest: context.approvalSubjectDigest,
        });
        return Object.freeze({ ...observation, activation });
      },
    })[0]!;
    const freshChallengeId = '33333333-3333-4333-8333-333333333333';
    const freshOperationId = '44444444-4444-4444-8444-444444444444';
    const ids = [
      CHALLENGE_ID,
      OPERATION_ID,
      freshChallengeId,
      freshOperationId,
    ];
    const coordinator = createGrantCoordinatorKernel({
      paths: grantStorePaths(runtimeRoot),
      registry: createTransitionRegistry([definition]),
      policy: parseGrantPolicyV2(policyInput(), {
        registry: codeOwnedApprovalModuleRegistry(),
      }),
      now: () => new Date(NOW),
      randomUUID: () => ids.shift()!,
      challengeTtlMs: 10 * 60_000,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              reasonCode: 'approve-exact-role-independence-exception',
              reason: 'Approve this exact current role assignment only.',
              approvalMethod: 'human-presence' as const,
              sessionNonce: 'nonce-role-grant-recovery-00000000000001',
            };
          },
          async authenticate(subject) {
            return [humanProof(subject.approvalSubjectDigest)];
          },
          async close() {},
        };
      },
      async withLifecycleOperation(_challengeId, operation) {
        return operation(() => undefined);
      },
    });
    const request = createChangeRoleAssignmentGrantRequest(
      observation,
      'Authorize only this exact current role assignment.',
    );
    const parameters = definition.validateParameters(
      request.candidates[0]!.parameters,
    );
    await coordinator.requestGrant(request);

    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated role-assignment activation crash/,
    );
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'prepared',
    );
    assert.throws(
      () => assertGrantLifecycleBarrier(runtimeRoot),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );

    drifted = true;
    const driftBinding = await definition.observeState(parameters);
    const recovered = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.outcome, 'failed');
    assert.equal(recovered.recovered, true);
    assert.equal(activationAttempts, 1);
    const failed = readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID);
    assert.equal(failed.state, 'failed');
    if (failed.state !== 'failed') assert.fail('expected failed challenge');
    assert.deepEqual(failed.outcome, {
      outcome: 'failed',
      details: {
        schemaVersion: 1,
        kind: 'grant-transition-state-drift.v1',
        failureCode: 'GRANT_STATE_CHANGED',
        transitionCompleted: false,
        transitionErrorCode: 'CHANGE_ROLE_ASSIGNMENT_GRANT_STATE_CHANGED',
        expectedStateBinding: request.stateBinding,
        observedStateBinding: driftBinding,
      },
    });
    assert.equal(activation, null);
    assert.doesNotThrow(() => assertGrantLifecycleBarrier(runtimeRoot));
    await assert.rejects(coordinator.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'GRANT_CHALLENGE_UNAVAILABLE'),
    );

    drifted = false;
    const fresh = await coordinator.requestGrant(
      createChangeRoleAssignmentGrantRequest(
        observation,
        'Authorize the repaired exact current role assignment.',
      ),
    );
    assert.equal(fresh.challengeId, freshChallengeId);
    const completed = await coordinator.resolveChallenge(freshChallengeId);
    assert.equal(completed.outcome, 'completed');
    assert.equal(activationAttempts, 2);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'failed',
    );
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), freshChallengeId).state,
      'completed',
    );
  });
});

test('role-assignment recovery accepts only the exact activation written before a crash despite later source drift', async () => {
  await withRuntime(async (runtimeRoot) => {
    let drifted = false;
    let effectWrites = 0;
    let activation: ChangeRoleAssignmentGrantObservationV1['activation'] = null;
    const observation: ChangeRoleAssignmentGrantObservationV1 = Object.freeze({
      schemaVersion: 1,
      kind: 'change-role-assignment-grant-observation.v1',
      repositoryId: 'github:example/jigwright',
      changeId: 'role-grant-post-effect-recovery',
      planningGeneration: 'a'.repeat(64),
      invocationId: 'provider-invocation-role-grant-post-effect-recovery',
      recordDigest: 'b'.repeat(64),
      assignmentDigest: 'c'.repeat(64),
      grantRequirementDigest: 'd'.repeat(64),
      exactRolePairs: Object.freeze(['author-reviewer'] as const),
      activation: null,
    });
    const definition = changeRoleAssignmentGrantTransitionDefinitions({
      observe() {
        if (activation !== null) {
          return Object.freeze({ ...observation, activation });
        }
        if (drifted) {
          try {
            throw workflowError(
              'AGENT_RUNTIME_ASSIGNMENT_SOURCE_STALE',
              'The current assignment source changed after the effect.',
              ExitCode.staleState,
            );
          } catch (error) {
            rethrowChangeRoleAssignmentGrantCurrentSourceDrift(error);
          }
        }
        return observation;
      },
      activate(context) {
        if (activation === null) {
          effectWrites += 1;
          activation = Object.freeze({
            challengeId: context.challengeId,
            challengeDigest: context.approvalSubject.challengeDigest,
            operationId: context.operationId,
            approvalSubjectDigest: context.approvalSubjectDigest,
          });
          throw new Error('simulated crash after role-assignment activation');
        }
        return Object.freeze({ ...observation, activation });
      },
    })[0]!;
    const ids = [CHALLENGE_ID, OPERATION_ID];
    const coordinator = createGrantCoordinatorKernel({
      paths: grantStorePaths(runtimeRoot),
      registry: createTransitionRegistry([definition]),
      policy: parseGrantPolicyV2(policyInput(), {
        registry: codeOwnedApprovalModuleRegistry(),
      }),
      now: () => new Date(NOW),
      randomUUID: () => ids.shift()!,
      challengeTtlMs: 10 * 60_000,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              reasonCode: 'approve-exact-role-independence-exception',
              reason: 'Approve this exact current role assignment only.',
              approvalMethod: 'human-presence' as const,
              sessionNonce: 'nonce-role-grant-post-effect-00000000000001',
            };
          },
          async authenticate(subject) {
            return [humanProof(subject.approvalSubjectDigest)];
          },
          async close() {},
        };
      },
      async withLifecycleOperation(_challengeId, operation) {
        return operation(() => undefined);
      },
    });
    await coordinator.requestGrant(
      createChangeRoleAssignmentGrantRequest(
        observation,
        'Authorize only this exact current role assignment.',
      ),
    );

    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated crash after role-assignment activation/,
    );
    assert.equal(effectWrites, 1);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'prepared',
    );
    assert.throws(
      () => assertGrantLifecycleBarrier(runtimeRoot),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );

    drifted = true;
    const recovered = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.outcome, 'completed');
    assert.equal(recovered.recovered, true);
    assert.equal(effectWrites, 1);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'completed',
    );
    assert.doesNotThrow(() => assertGrantLifecycleBarrier(runtimeRoot));
  });
});

test('role-assignment hard recovery failures retain the prepared barrier', async () => {
  for (const code of [
    'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_MISMATCH',
    'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_CONFLICT',
    'AGENT_RUNTIME_PROVIDER_CONFIG_REQUIRED',
    'AGENT_PROVIDER_CONFIG_FILE_UNAVAILABLE',
    'AGENT_PROVIDER_CONFIG_FILE_UNSAFE',
    'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_INVALID',
    'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    'GRANT_TRANSITION_EFFECT_UNKNOWN',
  ]) {
    await withRuntime(async (runtimeRoot) => {
      let hardFailure = false;
      const observation: ChangeRoleAssignmentGrantObservationV1 = Object.freeze(
        {
          schemaVersion: 1,
          kind: 'change-role-assignment-grant-observation.v1',
          repositoryId: 'github:example/jigwright',
          changeId: 'role-grant-hard-recovery',
          planningGeneration: 'e'.repeat(64),
          invocationId: 'provider-invocation-role-grant-hard-recovery',
          recordDigest: 'f'.repeat(64),
          assignmentDigest: '1'.repeat(64),
          grantRequirementDigest: '2'.repeat(64),
          exactRolePairs: Object.freeze(['author-reviewer'] as const),
          activation: null,
        },
      );
      const definition = changeRoleAssignmentGrantTransitionDefinitions({
        observe() {
          if (hardFailure) {
            throw workflowError(
              code,
              'The role-assignment recovery state is hard-blocked.',
              ExitCode.verification,
            );
          }
          return observation;
        },
        activate() {
          throw new Error('simulated role-assignment activation crash');
        },
      })[0]!;
      const ids = [CHALLENGE_ID, OPERATION_ID];
      const coordinator = createGrantCoordinatorKernel({
        paths: grantStorePaths(runtimeRoot),
        registry: createTransitionRegistry([definition]),
        policy: parseGrantPolicyV2(policyInput(), {
          registry: codeOwnedApprovalModuleRegistry(),
        }),
        now: () => new Date(NOW),
        randomUUID: () => ids.shift()!,
        challengeTtlMs: 10 * 60_000,
        openApprovalSession(presentation) {
          return {
            async collectDecision() {
              return {
                choiceId: presentation.choices[0]!.choiceId,
                reasonCode: 'approve-exact-role-independence-exception',
                reason: 'Approve this exact current role assignment only.',
                approvalMethod: 'human-presence' as const,
                sessionNonce: 'nonce-role-grant-hard-recovery-000000000001',
              };
            },
            async authenticate(subject) {
              return [humanProof(subject.approvalSubjectDigest)];
            },
            async close() {},
          };
        },
        async withLifecycleOperation(_challengeId, operation) {
          return operation(() => undefined);
        },
      });
      await coordinator.requestGrant(
        createChangeRoleAssignmentGrantRequest(
          observation,
          'Authorize only this exact current role assignment.',
        ),
      );
      await assert.rejects(
        coordinator.resolveChallenge(CHALLENGE_ID),
        /simulated role-assignment activation crash/,
      );

      hardFailure = true;
      await assert.rejects(
        coordinator.recoverChallenge(CHALLENGE_ID),
        (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === code,
      );
      assert.equal(
        readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
        'prepared',
        code,
      );
      assert.throws(
        () => assertGrantLifecycleBarrier(runtimeRoot),
        (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
        code,
      );
    });
  }
});

test('role-assignment recovery keeps its barrier when invocation advancement has unknown effect', async () => {
  await withRuntime(async (runtimeRoot) => {
    let invocationAdvanced = false;
    let activationAttempts = 0;
    const observation: ChangeRoleAssignmentGrantObservationV1 = Object.freeze({
      schemaVersion: 1,
      kind: 'change-role-assignment-grant-observation.v1',
      repositoryId: 'github:example/jigwright',
      changeId: 'role-grant-unknown-effect',
      planningGeneration: '5'.repeat(64),
      invocationId: 'provider-invocation-role-grant-unknown-effect',
      recordDigest: '6'.repeat(64),
      assignmentDigest: '7'.repeat(64),
      grantRequirementDigest: '8'.repeat(64),
      exactRolePairs: Object.freeze(['author-reviewer'] as const),
      activation: null,
    });
    const definition = changeRoleAssignmentGrantTransitionDefinitions({
      observe() {
        if (invocationAdvanced) {
          throw workflowError(
            'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_NOT_PREPARED',
            'The provider invocation advanced and its effect is unknown.',
            ExitCode.staleState,
          );
        }
        return observation;
      },
      activate() {
        activationAttempts += 1;
        throw new Error('simulated role-assignment activation crash');
      },
    })[0]!;
    const ids = [CHALLENGE_ID, OPERATION_ID];
    const coordinator = createGrantCoordinatorKernel({
      paths: grantStorePaths(runtimeRoot),
      registry: createTransitionRegistry([definition]),
      policy: parseGrantPolicyV2(policyInput(), {
        registry: codeOwnedApprovalModuleRegistry(),
      }),
      now: () => new Date(NOW),
      randomUUID: () => ids.shift()!,
      challengeTtlMs: 10 * 60_000,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              reasonCode: 'approve-exact-role-independence-exception',
              reason: 'Approve this exact current role assignment only.',
              approvalMethod: 'human-presence' as const,
              sessionNonce: 'nonce-role-grant-unknown-effect-000000000001',
            };
          },
          async authenticate(subject) {
            return [humanProof(subject.approvalSubjectDigest)];
          },
          async close() {},
        };
      },
      async withLifecycleOperation(_challengeId, operation) {
        return operation(() => undefined);
      },
    });
    await coordinator.requestGrant(
      createChangeRoleAssignmentGrantRequest(
        observation,
        'Authorize only this exact current role assignment.',
      ),
    );
    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated role-assignment activation crash/,
    );

    invocationAdvanced = true;
    await assert.rejects(
      coordinator.recoverChallenge(CHALLENGE_ID),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_NOT_PREPARED',
    );
    assert.equal(activationAttempts, 1);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'prepared',
    );
    assert.throws(
      () => assertGrantLifecycleBarrier(runtimeRoot),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );
  });
});
