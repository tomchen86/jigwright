import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
/** Fresh milestone fixtures for protected finalization, descendant settlement and recovery. No test registrations. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../src/runtime/lifecycle-ledgers/grant-store.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import { loadGrantPolicyV2 } from '../src/runtime/repository-observation/grant-policy-reader.ts';
import { protectedTaskApplyGrantTransitionDefinitions } from '../src/modules/authority/protected-task-apply-grant.ts';
import { createProductionProtectedTaskApplyGrantPort } from './support/local-engine-selection-host.ts';
import { requestChangeRoleAssignmentGrant } from '../bootstrap/session-lifecycle-production.ts';
import { withProductionGrantLifecycleOperation } from '../src/composition-root/grant-production.ts';
import { createProductionChangeRoleAssignmentGrantPort } from '../src/composition-root/change-role-assignment-grant-production.ts';
import { changeRoleAssignmentGrantTransitionDefinitions } from '../src/modules/provider-orchestration/change-role-assignment-grant.ts';
import {
  agentRolePlanV2Digest,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import { agentRolePlanV2Path } from '../src/modules/source/planning-role-policy-paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperationAsync,
} from '../src/runtime/session-workspace/session-store.ts';
import { beginTaskDiffReview } from '../src/composition-root/task-diff-review-production.ts';
import { preflightProviderWorkerAssignment } from '../src/entrypoints/worker/provider-worker.ts';
import { getSession } from '../src/runtime/repository-observation/workflow-session-context.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';

import {
  git,
  prepareCurrentV3IntroductionFixture,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import {
  TASK_ID,
  CHANGE_ID,
  MANDATE_ID,
  externalAuditRoot,
  cleanupRepository,
  prepareRepository,
  enableConditionalTaskAuthorization,
  agentProviderConfigToml,
  request,
  generateSigningKey,
  realSigningProvider,
} from './task-mandate-fixture.ts';

export async function createProtectedPlanningFixture() {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-cli-key-'),
  );
  const providerDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'task-diff-role-grant-')),
  );
  const agentProviderConfigPath = path.join(
    providerDirectory,
    'agent-providers.toml',
  );
  fs.writeFileSync(agentProviderConfigPath, agentProviderConfigToml());
  const { privateKey, trustedSigner } = generateSigningKey(keyDirectory);
  const protectedRepository = prepareRepository(trustedSigner);
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
  );
  const cleanup = () => {
    cleanupRepository(protectedRepository);
    fs.rmSync(keyDirectory, { recursive: true, force: true });
    fs.rmSync(providerDirectory, { recursive: true, force: true });
  };
  try {
    enableConditionalTaskAuthorization(protectedRepository, 'control-plane');

    const adapterPolicyPath = path.join(
      protectedRepository,
      'workflow/ai-adapter-policy.json',
    );

    const adapterPolicy = JSON.parse(
      fs.readFileSync(adapterPolicyPath, 'utf8'),
    ) as { providers: { claude: { enabled: boolean } } };

    adapterPolicy.providers.claude.enabled = false;

    fs.writeFileSync(
      adapterPolicyPath,
      `${JSON.stringify(adapterPolicy, null, 2)}\n`,
      'utf8',
    );

    git(protectedRepository, ['add', adapterPolicyPath]);

    git(protectedRepository, [
      'commit',
      '-m',
      'Limit the protected review provider fixture',
    ]);

    const centralRolePolicyPath = path.join(
      protectedRepository,
      'workflow/role-provider-default.json',
    );

    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/role-provider-default.json'),
      centralRolePolicyPath,
    );

    const centralRolePolicy = JSON.parse(
      fs.readFileSync(centralRolePolicyPath, 'utf8'),
    ) as { configurationDigest: string };

    const roleOverrideBody: AgentRolePlanBodyV2 = {
      schemaVersion: 2,
      changeId: CHANGE_ID,
      baseCentralConfigurationDigest: centralRolePolicy.configurationDigest,
      roleLanes: [],
      pairwiseRequirements: [
        { pair: 'author-builder', required: 'session-independent' },
        { pair: 'author-reviewer', required: 'session-independent' },
        { pair: 'builder-reviewer', required: 'session-independent' },
      ],
      customWrapperPolicy: 'forbidden',
      grantReferences: [],
    };

    const roleOverridePath = agentRolePlanV2Path(CHANGE_ID);

    const roleOverride = renderAgentRolePlanV2({
      ...roleOverrideBody,
      planDigest: agentRolePlanV2Digest(roleOverrideBody),
    });

    fs.mkdirSync(
      path.dirname(path.join(protectedRepository, roleOverridePath)),
      { recursive: true },
    );

    fs.writeFileSync(
      path.join(protectedRepository, roleOverridePath),
      roleOverride,
    );

    git(protectedRepository, [
      'add',
      'workflow/role-provider-default.json',
      roleOverridePath,
    ]);

    git(protectedRepository, [
      'commit',
      '-m',
      'Add below-floor protected review role policy',
    ]);

    const guardPath = path.join(
      protectedRepository,
      'openspec/changes/demo-change/guard.json',
    );

    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
      tasks: Record<string, { allowedPaths: string[] }>;
    };

    guard.tasks['1.1']!.allowedPaths = [
      'packages/workflow-engine/src/**',
      'workflow/config.json',
    ];

    const protectedPath = path.join(
      protectedRepository,
      'packages/workflow-engine/src/protected-demo.ts',
    );

    fs.mkdirSync(path.dirname(protectedPath), { recursive: true });

    fs.writeFileSync(protectedPath, 'export const protectedDemo = 1;\n');

    fs.writeFileSync(guardPath, `${canonicalJson(guard)}\n`, 'utf8');

    git(protectedRepository, ['add', guardPath, protectedPath]);

    git(protectedRepository, ['commit', '-m', 'Protect the task scope']);

    authorizeTaskMandate(protectedRepository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(protectedRepository),
      now: new Date(),
      signer: realSigningProvider(privateKey),
    });

    fs.rmSync(path.join(protectedRepository, roleOverridePath));

    prepareCurrentV3IntroductionFixture(protectedRepository, CHANGE_ID);

    fs.mkdirSync(
      path.dirname(path.join(protectedRepository, roleOverridePath)),
      { recursive: true },
    );

    fs.writeFileSync(
      path.join(protectedRepository, roleOverridePath),
      roleOverride,
    );

    writeReadyV3ExemptChange(protectedRepository);

    commitPlanningTransition(protectedRepository, CHANGE_ID);
    return {
      keyDirectory,
      providerDirectory,
      agentProviderConfigPath,
      privateKey,
      trustedSigner,
      protectedRepository,
      cli,
      adapterPolicyPath,
      adapterPolicy,
      centralRolePolicyPath,
      centralRolePolicy,
      roleOverrideBody,
      roleOverridePath,
      roleOverride,
      guardPath,
      guard,
      protectedPath,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function createPendingProtectedApplyFixture() {
  const fixture = await createProtectedPlanningFixture();
  const { protectedRepository, cli, protectedPath } = fixture;
  try {
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

    const opened = JSON.parse(started.stdout) as {
      result: { sessionId: string };
    };

    const output = {
      session: getSession(protectedRepository, opened.result.sessionId),
    };

    const liveConfigPath = path.join(
      protectedRepository,
      'workflow/config.json',
    );

    const liveConfig = JSON.parse(
      fs.readFileSync(liveConfigPath, 'utf8'),
    ) as Record<string, unknown>;

    delete liveConfig.taskAuthorization;

    fs.writeFileSync(liveConfigPath, `${canonicalJson(liveConfig)}\n`, 'utf8');

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
    return {
      ...fixture,
      started,
      opened,
      output,
      liveConfigPath,
      liveConfig,
      protectedChangedPaths,
      finalized,
      protectedGrant,
    };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

export async function createProtectedReviewFixture() {
  const fixture = await createPendingProtectedApplyFixture();
  const { protectedRepository, output, protectedGrant } = fixture;
  try {
    const repositoryState = discoverRepository(protectedRepository);

    const lifecycleRuntime = runtimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );

    const coordinator = createGrantCoordinatorKernel({
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      store: createFileGrantRecordStore(grantStorePaths(lifecycleRuntime.root)),
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
    let blockedByReview = false;
    try {
      await coordinator.resolveChallenge(
        protectedGrant.result.grant.challengeId,
      );
    } catch (error) {
      if (
        !(error instanceof WorkflowError) ||
        error.code !== 'TASK_DIFF_REVIEW_REQUIRED'
      )
        throw error;
      blockedByReview = true;
    }
    if (!blockedByReview)
      throw new Error(
        'Expected the protected apply fixture to pause at its required review.',
      );
    const review = beginTaskDiffReview(
      protectedRepository,
      output.session.sessionId,
      { explicitActor: 'codex', environment: {} },
    );
    if (review.state !== 'waiting-for-provider')
      throw new Error(
        'Expected a fresh same-provider review for the protected recovery fixture.',
      );

    return {
      ...fixture,
      repositoryState,
      lifecycleRuntime,
      coordinator,
      blockedByReview,
      review,
    };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

export async function createPreparedRoleGrantFixture() {
  const fixture = await createProtectedReviewFixture();
  const {
    agentProviderConfigPath,
    protectedRepository,
    lifecycleRuntime,
    review,
  } = fixture;
  try {
    // Preflight records the exact below-floor assignment before a Grant can
    // prepare its interrupted child transition.
    let pausedAtRoleGrant = false;
    try {
      preflightProviderWorkerAssignment(
        protectedRepository,
        review.invocationId,
        {
          agentProviderConfigPath,
          platform: 'darwin',
        },
      );
    } catch (error) {
      if (
        !(error instanceof WorkflowError) ||
        error.code !== 'AGENT_RUNTIME_GRANT_REQUIRED'
      ) {
        throw error;
      }
      pausedAtRoleGrant = true;
    }
    if (!pausedAtRoleGrant) {
      throw new Error(
        'Expected the protected review to pause at its role Grant.',
      );
    }
    const roleAssignmentOptions = {
      configFilePath: agentProviderConfigPath,
      platform: 'darwin' as const,
    };

    const roleAssignmentPort = createProductionChangeRoleAssignmentGrantPort(
      protectedRepository,
      roleAssignmentOptions,
    );

    const roleAssignmentCoordinator = createGrantCoordinatorKernel({
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      store: createFileGrantRecordStore(grantStorePaths(lifecycleRuntime.root)),
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
    let interrupted = false;
    try {
      await roleAssignmentCoordinator.resolveChallenge(
        roleAssignmentGrant.challengeId,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !==
          'Simulated role-assignment interruption after Grant preparation.'
      )
        throw error;
      interrupted = true;
    }
    if (!interrupted)
      throw new Error(
        'Expected the role assignment fixture interruption after Grant preparation.',
      );

    return {
      ...fixture,
      roleAssignmentOptions,
      roleAssignmentPort,
      roleAssignmentCoordinator,
      previousProviderConfig,
      roleAssignmentGrant,
      interrupted,
    };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

import { taskMandateOperations } from '../src/composition-root/task-mandate-production.ts';
const { authorizeTaskMandate } = taskMandateOperations;
