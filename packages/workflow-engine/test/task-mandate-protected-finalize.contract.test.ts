import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
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
import { issueProductionCollaborationGrant } from '../src/composition-root/collaboration-grant-production.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperationAsync,
} from '../src/runtime/session-workspace/session-store.ts';
import { readFinalizeTransaction } from '../src/runtime/repository-transaction/finalize-transaction.ts';
import { beginTaskDiffReview } from '../src/application/finalize/task-diff-review-lifecycle.ts';
import { assertPreparedProtectedTaskApplyAuthorization } from '../src/application/finalize/protected-task-apply-authorization.ts';
import { readProviderInvocation } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { getSession } from '../src/application/execute-task/session.ts';
import {
  authoritativeCollaborationGrantVerifierForTest,
  git,
  runtimeRoot,
} from './fixture.ts';
import {
  TASK_ID,
  CHANGE_ID,
  MANDATE_ID,
  externalAuditRoot,
  realSigningProvider,
} from './task-mandate-fixture.ts';
import {
  createProtectedPlanningFixture,
  createPendingProtectedApplyFixture,
} from './task-mandate-protected-fixture.ts';

describe('protected finalize and recovery route through exact Central Fail-Grants', () => {
  test('binds protected finalize to one exact mandate and pending apply Grant', async () => {
    const { protectedRepository, cli, protectedPath, cleanup } =
      await createProtectedPlanningFixture();
    try {
      const missing = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          cli,
          'open-task',
          CHANGE_ID,
          '--task',
          '1.1',
          '--json',
        ],
        { cwd: protectedRepository, encoding: 'utf8' },
      );

      assert.notEqual(missing.status, 0, missing.stderr);

      assert.match(
        `${missing.stdout}\n${missing.stderr}`,
        /TASK_MANDATE_REQUIRED/,
      );

      const started = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          cli,
          'open-task',
          CHANGE_ID,
          '--task',
          '1.1',
          '--mandate',
          TASK_ID,
          '--json',
        ],
        { cwd: protectedRepository, encoding: 'utf8' },
      );

      assert.equal(started.status, 0, started.stderr);

      const opened = JSON.parse(started.stdout) as {
        result: { sessionId: string };
      };

      const output = {
        session: getSession(protectedRepository, opened.result.sessionId),
      };

      assert.equal(output.session.taskId, '1.1');

      const mandateBinding = output.session.mandateBinding;

      assert.ok(mandateBinding);

      assert.deepEqual(mandateBinding, {
        schemaVersion: 1,
        mandateTaskId: TASK_ID,
        mandateId: MANDATE_ID,
        mandateDigest: mandateBinding.mandateDigest,
        changeId: CHANGE_ID,
        externalAuditRoot: externalAuditRoot(protectedRepository),
      });

      const liveConfigPath = path.join(
        protectedRepository,
        'workflow/config.json',
      );

      const liveConfig = JSON.parse(
        fs.readFileSync(liveConfigPath, 'utf8'),
      ) as Record<string, unknown>;

      delete liveConfig.taskAuthorization;

      fs.writeFileSync(
        liveConfigPath,
        `${canonicalJson(liveConfig)}\n`,
        'utf8',
      );

      fs.writeFileSync(protectedPath, 'export const protectedDemo = 2;\n');

      const protectedChangedPaths = [
        'packages/workflow-engine/src/protected-demo.ts',
        'workflow/config.json',
      ];

      const finalized = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          cli,
          'finalize',
          output.session.sessionId,
          '--message',
          'Update protected demo',
          '--json',
        ],
        { cwd: protectedRepository, encoding: 'utf8' },
      );

      assert.equal(finalized.status, 0, finalized.stderr);

      const protectedGrant = JSON.parse(finalized.stdout) as {
        ok: boolean;
        result: {
          kind: string;
          sessionId: string;
          state: string;
          nextAction: string;
          failure: {
            code: string;
            details: {
              changeId: string;
              taskId: string;
              mandateTaskId: string;
              changedPaths: string[];
              roles: string[];
              matchedPatterns: string[];
              unclassifiedScope: boolean;
            };
          };
          grant: { challengeId: string; challengeDigest: string };
          transitionAppliesOnDecision: boolean;
          inputSchema: {
            kind: string;
            inspectCommand: string;
            decisionCommand: string;
            observeAfterDecision: string;
            retryAfterDecision?: string;
          };
        };
      };

      assert.equal(protectedGrant.ok, true);

      assert.equal(
        protectedGrant.result.kind,
        'workflow-fail-grant-required.v1',
      );

      assert.equal(protectedGrant.result.sessionId, output.session.sessionId);

      assert.equal(protectedGrant.result.state, 'human-action-required');

      assert.equal(protectedGrant.result.nextAction, 'human-action');

      assert.equal(
        protectedGrant.result.failure.code,
        'PROTECTED_TASK_APPLY_REQUIRED',
      );

      assert.deepEqual(protectedGrant.result.failure.details, {
        changeId: CHANGE_ID,
        taskId: '1.1',
        mandateTaskId: TASK_ID,
        changedPaths: protectedChangedPaths,
        roles: ['control-plane'],
        matchedPatterns: ['packages/workflow-engine/src/**'],
        unclassifiedScope: true,
      });

      assert.equal(protectedGrant.result.transitionAppliesOnDecision, true);

      assert.equal(
        protectedGrant.result.inputSchema.kind,
        'central-grant-resolution.v1',
      );

      assert.match(
        protectedGrant.result.inputSchema.inspectCommand,
        /pnpm workflow grant human inspect/u,
      );

      assert.match(
        protectedGrant.result.inputSchema.decisionCommand,
        /pnpm workflow grant human decide/u,
      );

      assert.equal(
        protectedGrant.result.inputSchema.observeAfterDecision,
        `pnpm workflow status ${output.session.sessionId} --json`,
      );

      assert.equal(
        protectedGrant.result.inputSchema.retryAfterDecision,
        undefined,
      );

      const grant = readGrantRecord(
        grantStorePaths(runtimeRoot(protectedRepository)),
        protectedGrant.result.grant.challengeId,
      );

      assert.equal(grant.state, 'pending');

      assert.equal(
        grant.challenge.challengeDigest,
        protectedGrant.result.grant.challengeDigest,
      );

      assert.equal(grant.challenge.sourceModuleId, 'task-finalization');

      assert.equal(
        grant.challenge.failureCode,
        'protected-task-apply-required',
      );

      assert.equal(
        grant.challenge.stateBinding.kind,
        'protected-task-apply-state.v1',
      );

      assert.deepEqual(
        grant.challenge.choices.map(({ transitionId, resolutionKind }) => ({
          transitionId,
          resolutionKind,
        })),
        [
          {
            transitionId: 'task.protected-apply.finalize.v1',
            resolutionKind: 'non-retry',
          },
        ],
      );

      const choice = grant.challenge.choices[0]!;

      assert.deepEqual(choice.allowedReasonCodes, [
        'approve-exact-protected-task-apply',
      ]);

      assert.equal(choice.reasonRequired, true);

      const facts = grant.challenge.facts as {
        repositoryId: string;
        changeId: string;
        sessionId: string;
        taskId: string;
        mandateBinding: unknown;
        changedPaths: string[];
      };

      assert.equal(facts.repositoryId, 'github:R_fixture');

      assert.equal(facts.changeId, CHANGE_ID);

      assert.equal(facts.sessionId, output.session.sessionId);

      assert.equal(facts.taskId, '1.1');

      assert.deepEqual(facts.mandateBinding, output.session.mandateBinding);

      assert.deepEqual(facts.changedPaths, protectedChangedPaths);

      const parameters = choice.parameters as {
        schemaVersion: number;
        kind: string;
        repositoryId: string;
        changeId: string;
        sessionId: string;
        taskId: string;
        branch: string;
        baseline: { head: string; tree: string };
        mandateBinding: unknown;
        changedPaths: string[];
        commitMessage: string;
        stateBindingDigest: string;
      };

      assert.deepEqual(parameters, {
        schemaVersion: 1,
        kind: 'protected-task-apply-finalization.v1',
        repositoryId: 'github:R_fixture',
        changeId: CHANGE_ID,
        sessionId: output.session.sessionId,
        taskId: '1.1',
        branch: output.session.branch,
        baseline: output.session.baseline,
        mandateBinding: output.session.mandateBinding,
        changedPaths: protectedChangedPaths,
        commitMessage: 'Update protected demo',
        stateBindingDigest: grant.challenge.stateBinding.digest,
      });

      for (const compatibleCommand of ['complete-task']) {
        const bypass = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            cli,
            compatibleCommand,
            output.session.sessionId,
            '--json',
          ],
          { cwd: protectedRepository, encoding: 'utf8' },
        );
        assert.notEqual(bypass.status, 0, bypass.stderr);
        assert.match(
          `${bypass.stdout}\n${bypass.stderr}`,
          /PROTECTED_TASK_APPLY_REQUIRED/,
          compatibleCommand,
        );
      }

      assert.equal(
        git(protectedRepository, ['diff', '--cached', '--name-only']),
        '',
      );

      assert.match(
        fs.readFileSync(
          path.join(
            protectedRepository,
            'openspec/changes/demo-change/tasks.md',
          ),
          'utf8',
        ),
        /- \[ \] 1\.1/u,
      );
    } finally {
      cleanup();
    }
  });

  test('prepares exact apply authority and respects current reviewer independence', async () => {
    const { privateKey, protectedRepository, cleanup, output, protectedGrant } =
      await createPendingProtectedApplyFixture();
    try {
      const repositoryState = discoverRepository(protectedRepository);

      const lifecycleRuntime = runtimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      );

      const coordinator = createGrantCoordinatorKernel({
        paths: grantStorePaths(lifecycleRuntime.root),
        registry: createTransitionRegistry(
          protectedTaskApplyGrantTransitionDefinitions(
            createProductionProtectedTaskApplyGrantPort(protectedRepository),
          ),
        ),
        policy: loadGrantPolicyV2(protectedRepository).policy,
        openApprovalSession(presentation) {
          return {
            async collectDecision() {
              return {
                choiceId: presentation.choices[0]!.choiceId,
                approvalMethod: 'human-presence' as const,
                reasonCode: 'approve-exact-protected-task-apply',
                reason:
                  'Approve only the exact protected task finalization bound by this challenge.',
                sessionNonce: 'nonce-55555555555555555555555555555555',
              };
            },
            async authenticate(subject) {
              return [
                {
                  moduleId: 'human-gate-macos',
                  version: '1',
                  claims: ['fresh-local-device-owner'] as const,
                  approvalSubjectDigest: subject.approvalSubjectDigest,
                  proofDigest: `sha256:${'a'.repeat(64)}` as const,
                  verifiedAt: new Date().toISOString(),
                  identity: null,
                  portableEvidence: null,
                },
              ];
            },
            async close() {},
          };
        },
        async withLifecycleOperation(challengeId, operation) {
          return withRepositoryLifecycleOperationAsync(
            lifecycleRuntime,
            operation,
            { allowGrantChallengeIds: [challengeId] },
          );
        },
      });

      await assert.rejects(
        coordinator.resolveChallenge(protectedGrant.result.grant.challengeId),
        (error) =>
          error instanceof WorkflowError &&
          error.code === 'TASK_DIFF_REVIEW_REQUIRED',
      );

      const prepared = readGrantRecord(
        grantStorePaths(lifecycleRuntime.root),
        protectedGrant.result.grant.challengeId,
      );

      assert.equal(prepared.state, 'prepared');

      const transaction = readFinalizeTransaction(
        lifecycleRuntime.root,
        output.session.sessionId,
      );

      assert.equal(transaction?.phase, 'checked');

      assert.equal(
        transaction?.protectedApply?.challengeId,
        protectedGrant.result.grant.challengeId,
      );

      assert.equal(
        transaction?.protectedApply?.transitionId,
        'task.protected-apply.finalize.v1',
      );

      assert.throws(
        () =>
          assertPreparedProtectedTaskApplyAuthorization(lifecycleRuntime.root, {
            ...transaction!.protectedApply!,
            operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          }),
        (error) =>
          error instanceof WorkflowError &&
          error.code === 'PROTECTED_TASK_APPLY_AUTHORIZATION_INVALID',
      );

      const pausedReview = beginTaskDiffReview(
        protectedRepository,
        output.session.sessionId,
        { explicitActor: 'codex', environment: {} },
      );

      if (pausedReview.state !== 'collaboration-grant-required') {
        assert.equal(pausedReview.state, 'waiting-for-provider');
        assert.equal(
          pausedReview.assignment.requiredIndependence,
          'session-independent',
        );
        assert.equal(
          pausedReview.assignment.achievedIndependence,
          'session-independent',
        );
        assert.equal(
          readProviderInvocation(
            investigationRuntimePaths(
              repositoryState.gitCommonDirectory,
              'workflow-engine',
            ),
            pausedReview.invocationId,
          ).state,
          'prepared',
        );
        return;
      }

      if (pausedReview.inputSchema.grantRequest === null) {
        assert.fail(
          'expected the exact protected TaskDiffReview Grant request',
        );
      }

      const collaborationNow = new Date();

      assert.throws(
        () =>
          issueProductionCollaborationGrant(
            protectedRepository,
            {
              ...pausedReview.inputSchema.grantRequest!,
              reason: 'A caller cannot substitute the exact engine reason.',
            },
            {
              grantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              now: collaborationNow,
              signer: realSigningProvider(privateKey),
            },
          ),
        (error) =>
          error instanceof WorkflowError &&
          error.code === 'PROTECTED_TASK_APPLY_REVIEW_AUTHORIZATION_INVALID',
      );

      const collaborationGrant = issueProductionCollaborationGrant(
        protectedRepository,
        pausedReview.inputSchema.grantRequest,
        {
          grantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          now: collaborationNow,
          signer: realSigningProvider(privateKey),
        },
      );

      assert.equal(
        fs.existsSync(collaborationGrant.availableEnvelopePath),
        true,
      );

      const review = beginTaskDiffReview(
        protectedRepository,
        output.session.sessionId,
        {
          explicitActor: 'codex',
          environment: {},
          collaborationGrant: {
            grantId: collaborationGrant.grantId,
            now: new Date(collaborationNow.getTime() + 1_000),
            verifier: authoritativeCollaborationGrantVerifierForTest(
              realSigningProvider(privateKey),
            ),
          },
        },
      );

      assert.equal(review.state, 'waiting-for-provider');

      if (review.state !== 'waiting-for-provider') {
        assert.fail('expected the exact protected TaskDiffReview invocation');
      }
    } finally {
      cleanup();
    }
  });
});
