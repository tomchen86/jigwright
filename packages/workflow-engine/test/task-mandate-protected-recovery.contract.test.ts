import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import { loadGrantPolicyV2 } from '../src/modules/authority/grant-policy.ts';
import { protectedTaskApplyGrantTransitionDefinitions } from '../src/modules/authority/protected-task-apply-grant.ts';
import { createProductionProtectedTaskApplyGrantPort } from '../src/composition-root/protected-task-apply-grant-production.ts';
import {
  coordinateProtectedTaskApplyRecoveryParent,
  requestChangeRoleAssignmentGrant,
  withProductionGrantLifecycleOperation,
} from '../src/composition-root/grant-production.ts';
import { dispatchAsync } from '../src/cli.ts';
import {
  assertProtectedTaskApplyRecoveryGrantRequiredDetails,
  protectedTaskApplyRecoveryGrantTransitionDefinitions,
  type ProtectedTaskApplyRecoveryGrantRequiredDetailsV1,
  type ProtectedTaskApplyRecoveryParametersV1,
} from '../src/modules/authority/protected-task-apply-recovery-grant.ts';
import { createProductionProtectedTaskApplyRecoveryGrantPort } from '../src/composition-root/protected-task-apply-recovery-grant-production.ts';
import { createProductionProtectedTaskApplyDescendantSettlementGrantPort } from '../src/composition-root/protected-task-apply-descendant-settlement-grant-production.ts';
import {
  assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails,
  protectedTaskApplyDescendantSettlementTransitionDefinitions,
  type ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1,
} from '../src/modules/authority/protected-task-apply-descendant-settlement-grant.ts';
import {
  createProductionChangeRoleAssignmentGrantPort,
  observeCurrentChangeRoleAssignmentGrantForInvocation,
} from '../src/composition-root/change-role-assignment-grant-production.ts';
import { changeRoleAssignmentGrantTransitionDefinitions } from '../src/modules/provider-orchestration/change-role-assignment-grant.ts';
import { withRepositoryLifecycleOperation } from '../src/runtime/session-workspace/session-store.ts';
import { readFinalizeTransaction } from '../src/runtime/repository-transaction/finalize-transaction.ts';
import { readFinalizeCancellation } from '../src/application/finalize/finalize-cancellation.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { readProviderInvocation } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  abortSessionAfterProtectedTaskApplyRecoveryUnderGrant,
  abortSession,
  getSession,
} from '../src/application/execute-task/session.ts';
import {
  createProtectedReviewFixture,
  createPreparedRoleGrantFixture,
} from './task-mandate-protected-fixture.ts';

test('prepares a below-floor role Grant without launching the protected reviewer', async () => {
  const {
    agentProviderConfigPath,
    protectedRepository,
    cleanup,
    protectedGrant,
    repositoryState,
    lifecycleRuntime,
    review,
  } = await createProtectedReviewFixture();
  try {
    let runnerCalls = 0;

    assert.throws(
      () =>
        runProviderWorker(protectedRepository, review.invocationId, {
          agentProviderConfigPath,
          platform: 'darwin',
          runner() {
            runnerCalls += 1;
            return assert.fail(
              'Below-floor preflight must not launch the provider.',
            );
          },
        }),
      (error) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_GRANT_REQUIRED' &&
        error.details?.invocationId === review.invocationId,
    );

    assert.equal(runnerCalls, 0);

    assert.equal(
      readProviderInvocation(
        investigationRuntimePaths(
          repositoryState.gitCommonDirectory,
          'workflow-engine',
        ),
        review.invocationId,
      ).state,
      'prepared',
    );

    const roleAssignmentOptions = {
      configFilePath: agentProviderConfigPath,
      platform: 'darwin' as const,
    };

    const roleAssignmentPort = createProductionChangeRoleAssignmentGrantPort(
      protectedRepository,
      roleAssignmentOptions,
    );

    const roleObservation =
      observeCurrentChangeRoleAssignmentGrantForInvocation(
        protectedRepository,
        review.invocationId,
        roleAssignmentOptions,
      );

    assert.equal(roleObservation.activation, null);

    assert.deepEqual(roleObservation.exactRolePairs, [
      'author-builder',
      'author-reviewer',
      'builder-reviewer',
    ]);

    const roleAssignmentCoordinator = createGrantCoordinatorKernel({
      paths: grantStorePaths(lifecycleRuntime.root),
      registry: createTransitionRegistry(
        changeRoleAssignmentGrantTransitionDefinitions({
          observe: (parameters) => roleAssignmentPort.observe(parameters),
          activate() {
            throw new Error(
              'Simulated role-assignment interruption after Grant preparation.',
            );
          },
        }),
      ),
      policy: loadGrantPolicyV2(protectedRepository).policy,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              approvalMethod: 'human-presence' as const,
              reasonCode: 'approve-exact-role-independence-exception',
              reason: 'Approve only this exact TaskDiffReview role assignment.',
              sessionNonce: 'nonce-66666666666666666666666666666666',
            };
          },
          async authenticate(subject) {
            return [
              {
                moduleId: 'human-gate-macos',
                version: '1',
                claims: ['fresh-local-device-owner'] as const,
                approvalSubjectDigest: subject.approvalSubjectDigest,
                proofDigest: `sha256:${'b'.repeat(64)}` as const,
                verifiedAt: new Date().toISOString(),
                identity: null,
                portableEvidence: null,
              },
            ];
          },
          async close() {},
        };
      },
      withLifecycleOperation(challengeId, operation) {
        return withProductionGrantLifecycleOperation(
          protectedRepository,
          challengeId,
          operation,
        );
      },
    });

    const previousProviderConfig = process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;

    process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG = agentProviderConfigPath;

    let roleAssignmentGrant: Awaited<
      ReturnType<typeof requestChangeRoleAssignmentGrant>
    >;

    try {
      roleAssignmentGrant = await requestChangeRoleAssignmentGrant(
        protectedRepository,
        review.invocationId,
        'Authorize the exact protected TaskDiffReview role assignment.',
      );
    } finally {
      if (previousProviderConfig === undefined) {
        delete process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
      } else {
        process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG = previousProviderConfig;
      }
    }

    assert.equal(
      readGrantRecord(
        grantStorePaths(lifecycleRuntime.root),
        roleAssignmentGrant.challengeId,
      ).state,
      'pending',
    );

    await assert.rejects(
      roleAssignmentCoordinator.resolveChallenge(
        roleAssignmentGrant.challengeId,
      ),
      /Simulated role-assignment interruption after Grant preparation\./u,
    );

    assert.equal(
      readGrantRecord(
        grantStorePaths(lifecycleRuntime.root),
        roleAssignmentGrant.challengeId,
      ).state,
      'prepared',
    );

    assert.equal(
      observeCurrentChangeRoleAssignmentGrantForInvocation(
        protectedRepository,
        review.invocationId,
        roleAssignmentOptions,
      ).activation,
      null,
    );

    assert.equal(
      readProviderInvocation(
        investigationRuntimePaths(
          repositoryState.gitCommonDirectory,
          'workflow-engine',
        ),
        review.invocationId,
      ).state,
      'prepared',
    );

    assert.equal(
      readGrantRecord(
        grantStorePaths(lifecycleRuntime.root),
        protectedGrant.result.grant.challengeId,
      ).state,
      'prepared',
    );

    assert.equal(
      readGrantRecord(
        grantStorePaths(lifecycleRuntime.root),
        roleAssignmentGrant.challengeId,
      ).state,
      'prepared',
    );
  } finally {
    cleanup();
  }
});

test('settles prepared descendants before exact protected cancellation and replay', async () => {
  const {
    protectedRepository,
    cleanup,
    output,
    protectedGrant,
    lifecycleRuntime,
    roleAssignmentPort,
    roleAssignmentGrant,
  } = await createPreparedRoleGrantFixture();
  try {
    const transactionBeforeAbort = readFinalizeTransaction(
      lifecycleRuntime.root,
      output.session.sessionId,
    );

    assert.ok(transactionBeforeAbort);

    const protectedSessionBeforeAbort = getSession(
      protectedRepository,
      output.session.sessionId,
    );

    const ownedSessionLockPaths = [
      path.join(
        lifecycleRuntime.locks,
        `${protectedSessionBeforeAbort.changeId}.lock`,
      ),
      ...(protectedSessionBeforeAbort.isolation === undefined
        ? []
        : [
            path.join(
              lifecycleRuntime.root,
              'task-isolation/worktrees',
              `${protectedSessionBeforeAbort.isolation.worktreeDigest.slice('sha256:'.length)}.lock`,
            ),
            ...protectedSessionBeforeAbort.isolation.resources.map((resource) =>
              path.join(
                lifecycleRuntime.root,
                'task-isolation/resources',
                `${resource.digest.slice('sha256:'.length)}.lock`,
              ),
            ),
          ]),
    ];

    const ownedSessionLockBytes = ownedSessionLockPaths.map((lockPath) => ({
      lockPath,
      bytes: fs.readFileSync(lockPath),
    }));

    const tasksBeforeAbort = fs.readFileSync(
      path.join(protectedRepository, 'openspec/changes/demo-change/tasks.md'),
      'utf8',
    );

    let settlementDetails:
      ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1 | undefined;

    assert.throws(
      () =>
        abortSession(
          protectedRepository,
          output.session.sessionId,
          'Cancel the protected finalize and abort this task session.',
        ),
      (error) => {
        if (
          !(error instanceof WorkflowError) ||
          error.code !==
            'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_GRANT_REQUIRED'
        ) {
          return false;
        }
        settlementDetails =
          assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails(
            error.details,
          );
        return (
          settlementDetails.action === 'cancel-and-abort' &&
          settlementDetails.sessionId === output.session.sessionId &&
          settlementDetails.transactionId ===
            transactionBeforeAbort.transactionId &&
          settlementDetails.transactionDigest ===
            transactionBeforeAbort.recordDigest &&
          settlementDetails.parentChallengeId ===
            protectedGrant.result.grant.challengeId &&
          settlementDetails.preparedDescendantTree.nodes.length === 1 &&
          settlementDetails.preparedDescendantTree.nodes[0]?.challengeId ===
            roleAssignmentGrant.challengeId
        );
      },
    );

    assert.equal(
      getSession(protectedRepository, output.session.sessionId).state,
      'active',
    );

    assert.deepEqual(
      readFinalizeTransaction(lifecycleRuntime.root, output.session.sessionId),
      transactionBeforeAbort,
    );

    assert.equal(
      readGrantRecord(
        grantStorePaths(lifecycleRuntime.root),
        protectedGrant.result.grant.challengeId,
      ).state,
      'prepared',
    );

    assert.equal(
      readFinalizeCancellation(
        lifecycleRuntime.root,
        transactionBeforeAbort.transactionId,
      ),
      null,
    );

    assert.equal(
      fs.readFileSync(
        path.join(protectedRepository, 'openspec/changes/demo-change/tasks.md'),
        'utf8',
      ),
      tasksBeforeAbort,
    );

    assert.ok(settlementDetails);

    const settlementReason = settlementDetails.reason;

    const settlementFailGrant = (await dispatchAsync(
      ['abort', output.session.sessionId, '--reason', settlementReason],
      protectedRepository,
    )) as {
      result: {
        kind: string;
        failure: { code: string };
        grant: { challengeId: string; challengeDigest: string };
      };
    };

    assert.equal(
      settlementFailGrant.result.kind,
      'workflow-fail-grant-required.v1',
    );

    assert.equal(
      settlementFailGrant.result.failure.code,
      'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_GRANT_REQUIRED',
    );

    const settlementGrant = settlementFailGrant.result.grant;

    const settlementCoordinator = createGrantCoordinatorKernel({
      paths: grantStorePaths(lifecycleRuntime.root),
      registry: createTransitionRegistry([
        ...changeRoleAssignmentGrantTransitionDefinitions(roleAssignmentPort),
        ...protectedTaskApplyDescendantSettlementTransitionDefinitions(
          createProductionProtectedTaskApplyDescendantSettlementGrantPort(
            protectedRepository,
          ),
        ),
      ]),
      policy: loadGrantPolicyV2(protectedRepository).policy,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              approvalMethod: 'human-presence' as const,
              reasonCode:
                'settle-descendants-before-protected-cancel-and-abort',
              reason:
                'Settle only the exact prepared child Grant before protected recovery.',
              sessionNonce: 'nonce-67676767676767676767676767676767',
            };
          },
          async authenticate(subject) {
            return [
              {
                moduleId: 'human-gate-macos',
                version: '1',
                claims: ['fresh-local-device-owner'] as const,
                approvalSubjectDigest: subject.approvalSubjectDigest,
                proofDigest: `sha256:${'d'.repeat(64)}` as const,
                verifiedAt: new Date().toISOString(),
                identity: null,
                portableEvidence: null,
              },
            ];
          },
          async close() {},
        };
      },
      withLifecycleOperation(challengeId, operation) {
        return withProductionGrantLifecycleOperation(
          protectedRepository,
          challengeId,
          operation,
        );
      },
    });

    const settlementResult = await settlementCoordinator.resolveChallenge(
      settlementGrant.challengeId,
    );

    assert.equal(settlementResult.outcome, 'completed');

    const settledRoleGrant = readGrantRecord(
      grantStorePaths(lifecycleRuntime.root),
      roleAssignmentGrant.challengeId,
    );

    assert.equal(settledRoleGrant.state, 'failed');

    assert.equal(
      settledRoleGrant.state === 'failed' &&
        (settledRoleGrant.outcome.details as { kind?: string }).kind,
      'grant-transition-cancelled-by-ancestor-recovery.v1',
    );

    assert.equal(
      settledRoleGrant.state === 'failed' &&
        (settledRoleGrant.outcome.details as { effectState?: string })
          .effectState,
      'not-applied',
    );

    let recoveryDetails:
      ProtectedTaskApplyRecoveryGrantRequiredDetailsV1 | undefined;

    assert.throws(
      () =>
        abortSession(
          protectedRepository,
          output.session.sessionId,
          settlementReason,
        ),
      (error) => {
        if (
          !(error instanceof WorkflowError) ||
          error.code !== 'PROTECTED_TASK_APPLY_RECOVERY_GRANT_REQUIRED'
        ) {
          return false;
        }
        recoveryDetails = assertProtectedTaskApplyRecoveryGrantRequiredDetails(
          error.details,
        );
        return (
          recoveryDetails.parentChallengeId ===
          protectedGrant.result.grant.challengeId
        );
      },
    );

    assert.ok(recoveryDetails);

    const recoveryFailGrant = (await dispatchAsync(
      ['abort', output.session.sessionId, '--reason', recoveryDetails.reason],
      protectedRepository,
    )) as {
      result: {
        kind: string;
        failure: { code: string };
        grant: { challengeId: string; challengeDigest: string };
      };
    };

    assert.equal(
      recoveryFailGrant.result.failure.code,
      'PROTECTED_TASK_APPLY_RECOVERY_GRANT_REQUIRED',
    );

    const recoveryGrant = recoveryFailGrant.result.grant;

    const recoveryRecord = readGrantRecord(
      grantStorePaths(lifecycleRuntime.root),
      recoveryGrant.challengeId,
    );

    assert.equal(recoveryRecord.state, 'pending');

    const recoveryParameters = recoveryRecord.challenge.choices[0]!
      .parameters as ProtectedTaskApplyRecoveryParametersV1;

    assert.equal(
      recoveryRecord.challenge.stateBinding.kind,
      'protected-task-apply-recovery-state.v1',
    );

    assert.deepEqual(
      recoveryRecord.challenge.choices.map(
        ({ transitionId, resolutionKind }) => ({
          transitionId,
          resolutionKind,
        }),
      ),
      [
        {
          transitionId: 'task.protected-apply.cancel-recovery.v1',
          resolutionKind: 'non-retry',
        },
      ],
    );

    const recoveryCoordinator = coordinateProtectedTaskApplyRecoveryParent(
      protectedRepository,
      createGrantCoordinatorKernel({
        paths: grantStorePaths(lifecycleRuntime.root),
        registry: createTransitionRegistry([
          ...protectedTaskApplyGrantTransitionDefinitions(
            createProductionProtectedTaskApplyGrantPort(protectedRepository),
          ),
          ...protectedTaskApplyRecoveryGrantTransitionDefinitions(
            createProductionProtectedTaskApplyRecoveryGrantPort(
              protectedRepository,
            ),
          ),
        ]),
        policy: loadGrantPolicyV2(protectedRepository).policy,
        openApprovalSession(presentation) {
          return {
            async collectDecision() {
              return {
                choiceId: presentation.choices[0]!.choiceId,
                approvalMethod: 'human-presence' as const,
                reasonCode: 'cancel-and-abort-exact-protected-task-apply',
                reason:
                  'Cancel only this exact protected finalize and abort its session.',
                sessionNonce: 'nonce-77777777777777777777777777777777',
              };
            },
            async authenticate(subject) {
              return [
                {
                  moduleId: 'human-gate-macos',
                  version: '1',
                  claims: ['fresh-local-device-owner'] as const,
                  approvalSubjectDigest: subject.approvalSubjectDigest,
                  proofDigest: `sha256:${'c'.repeat(64)}` as const,
                  verifiedAt: new Date().toISOString(),
                  identity: null,
                  portableEvidence: null,
                },
              ];
            },
            async close() {},
          };
        },
        withLifecycleOperation(challengeId, operation) {
          return withProductionGrantLifecycleOperation(
            protectedRepository,
            challengeId,
            operation,
          );
        },
      }),
    );

    const recoveryResult = await recoveryCoordinator.resolveChallenge(
      recoveryGrant.challengeId,
    );

    assert.equal(recoveryResult.outcome, 'completed');

    assert.equal(
      readGrantRecord(
        grantStorePaths(lifecycleRuntime.root),
        recoveryGrant.challengeId,
      ).state,
      'completed',
    );

    assert.equal(
      getSession(protectedRepository, output.session.sessionId).state,
      'aborted',
    );

    assert.equal(
      readFinalizeTransaction(lifecycleRuntime.root, output.session.sessionId),
      null,
    );

    const cancellation = readFinalizeCancellation(
      lifecycleRuntime.root,
      transactionBeforeAbort.transactionId,
    );

    assert.equal(cancellation?.phase, 'completed');

    assert.equal(cancellation?.reason, recoveryDetails.reason);

    const failedParent = readGrantRecord(
      grantStorePaths(lifecycleRuntime.root),
      protectedGrant.result.grant.challengeId,
    );

    assert.equal(failedParent.state, 'failed');

    assert.equal(
      failedParent.state === 'failed'
        ? (failedParent.outcome.details as { kind: string }).kind
        : null,
      'protected-task-apply-cancelled.v1',
    );

    assert.match(
      fs.readFileSync(
        path.join(protectedRepository, 'openspec/changes/demo-change/tasks.md'),
        'utf8',
      ),
      /- \[ \] 1\.1/u,
    );

    for (const { lockPath, bytes } of ownedSessionLockBytes) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, bytes, { mode: 0o600 });
    }

    withRepositoryLifecycleOperation(lifecycleRuntime, (assertOwned) =>
      abortSessionAfterProtectedTaskApplyRecoveryUnderGrant(
        protectedRepository,
        recoveryParameters,
        assertOwned,
      ),
    );

    for (const { lockPath } of ownedSessionLockBytes) {
      assert.equal(
        fs.existsSync(lockPath),
        false,
        `recovery replay must release ${lockPath}`,
      );
    }
  } finally {
    cleanup();
  }
});
