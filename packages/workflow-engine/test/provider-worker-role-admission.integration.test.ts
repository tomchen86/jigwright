import { createProviderWorkerDispatcherForTesting } from '../src/composition-root/provider-worker-dispatch-production.ts';
import { planningAssuranceDependencies } from '../src/composition-root/planning-assurance-production.ts';
import { readCurrentPlanningRoleOverridePolicy } from '../src/runtime/repository-transaction/planning-role-provider-policy-reader.ts';
import test from 'node:test';
import {
  createFixtureRepository,
  git,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  type AgentRolePlanBodyV2,
  renderAgentRolePlanV2,
  agentRolePlanV2Digest,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import { agentRolePlanV2Path } from '../src/modules/source/planning-role-policy-paths.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import assert from 'node:assert/strict';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import {
  createPlanReviewTargetSnapshotNode,
  readPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_OUTPUT_SCHEMA,
} from '../src/modules/assurance/plan-review.ts';
import {
  writeEvidenceNode,
  resolvePlanReviewInvocationOwner,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import { createEvidenceNode } from '../src/foundation/evidence-node/evidence-node.ts';
import {
  PROPOSE_POLICY_DIGEST,
  createProviderInvocationRequest,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { providerInvocationManifestDigest } from '../src/runtime/storage-journal/provider-invocation-manifest-validation.ts';
import { storeProviderExecutionPolicySnapshot } from '../src/runtime/storage-journal/provider-invocation-policy.ts';
import {
  createProviderInvocation,
  readProviderInvocation,
} from '../src/runtime/storage-journal/provider-invocation-state.ts';
import type { PlanReviewManifest } from '../src/modules/assurance/provider-review-manifests.ts';
import { loadAiAdapterPolicy } from '../src/runtime/provider-policy/ai-adapter-policy.ts';
import { createCurrentAgentRuntimeAssignmentV1 } from '../src/composition-root/change-role-assignment-production.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import {
  createProductionChangeRoleAssignmentGrantPort,
  observeCurrentChangeRoleAssignmentGrantForInvocation,
} from '../src/composition-root/change-role-assignment-grant-production.ts';
import {
  createChangeRoleAssignmentGrantRequest,
  assertChangeRoleAssignmentGrantParameters,
  changeRoleAssignmentGrantTransitionDefinitions,
} from '../src/modules/provider-orchestration/change-role-assignment-grant.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../src/runtime/lifecycle-ledgers/grant-store.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  parseGrantPolicyV2,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  codeOwnedApprovalModuleRegistry,
} from '../src/modules/authority/grant-policy.ts';
import { type VerifiedApprovalProof } from '../src/modules/authority/grant-approval.ts';
import { approvalSubjectDigest } from '../src/modules/authority/grant-core.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import {
  agentProviderConfigToml,
  writeCurrentPlanningMaterialization,
  sha256,
  successfulWorkerReport,
  executableIdentity,
} from './support/provider-worker-fixture.ts';

test('below-floor current role assignment blocks worker claim and detached spawn until exact Grant', async () => {
  const repository = createFixtureRepository();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-agent-providers-grant-')),
  );
  const agentProviderConfigPath = path.join(
    hostDirectory,
    'agent-providers.toml',
  );
  const changeId = 'demo-change';
  try {
    const central = createCentralRoleProviderDefault({
      schemaVersion: 1,
      kind: 'central-role-provider-default',
      providerGroups: [
        {
          roles: ['author'],
          sessionGroups: [['author']],
          providerRule: { kind: 'adaptive-author' },
        },
        {
          roles: ['builder'],
          sessionGroups: [['builder']],
          providerRule: {
            kind: 'ranked-fallback',
            preferredLogicalProviderId: null,
          },
        },
        {
          roles: ['reviewer'],
          sessionGroups: [['reviewer']],
          providerRule: {
            kind: 'ranked-fallback',
            preferredLogicalProviderId: null,
          },
        },
      ],
      globalProviderRanking: ['claude', 'codex'],
    });
    fs.writeFileSync(
      path.join(repository, 'workflow/role-provider-default.json'),
      renderCentralRoleProviderDefault(central),
    );
    const overrideBody: AgentRolePlanBodyV2 = {
      schemaVersion: 2,
      changeId,
      baseCentralConfigurationDigest: central.configurationDigest,
      roleLanes: [],
      pairwiseRequirements: [
        { pair: 'author-builder', required: 'session-independent' },
        { pair: 'author-reviewer', required: 'session-independent' },
        { pair: 'builder-reviewer', required: 'session-independent' },
      ],
      customWrapperPolicy: 'forbidden',
      grantReferences: [],
    };
    const overridePath = agentRolePlanV2Path(changeId);
    fs.mkdirSync(path.dirname(path.join(repository, overridePath)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repository, overridePath),
      renderAgentRolePlanV2({
        ...overrideBody,
        planDigest: agentRolePlanV2Digest(overrideBody),
      }),
    );
    fs.writeFileSync(agentProviderConfigPath, agentProviderConfigToml());
    git(repository, [
      'add',
      'workflow/role-provider-default.json',
      overridePath,
    ]);
    git(repository, ['commit', '-m', 'Add below-floor role override']);

    const ready = writeReadyV3ExemptChange(repository, changeId);
    const contract = loadChangeContract(repository, changeId);
    assert.ok(contract.investigation);
    const investigationManifest = contract.investigation.manifest;
    const planningContext = deriveInvestigationFirstPlanningSubject(
      planningAssuranceDependencies,
      repository,
      contract,
      readCurrentPlanningRoleOverridePolicy(repository, contract.changeId),
    );
    const subject = planningContext.subject;
    const investigationId = investigationManifest.investigationId;
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const invocationId = 'invocation-plan-review-below-floor';
    const assignment = {
      role: 'plan-reviewer' as const,
      providerId: 'claude' as const,
      sessionId: 'provider-session-plan-review-below-floor',
      targetDigest: subject.subjectDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    };
    const materialization = writeCurrentPlanningMaterialization(
      runtime,
      investigationManifest,
      subject.investigationBaseline,
      {
        'proposal.md': sha256(
          fs.readFileSync(
            path.join(repository, 'openspec/changes', changeId, 'proposal.md'),
            'utf8',
          ),
        ),
      },
    );
    const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
      changeId,
      changePrefix: `openspec/changes/${changeId}`,
      subject,
      materializationNode: materialization,
      artifacts: new Map([
        [
          'proposal.md',
          fs.readFileSync(
            path.join(repository, 'openspec/changes', changeId, 'proposal.md'),
          ),
        ],
      ]),
    });
    writeEvidenceNode(runtime, targetSnapshotNode);
    const authorization = createEvidenceNode({
      type: 'plan-review-authorization',
      nodeSchema: 'workflow.plan-review-authorization.v3',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        generation: subject.planningGenerationId,
        grantAuthorization: sha256(canonicalJson(null)),
        roleTopology: sha256(canonicalJson(null)),
        subject: subject.subjectDigest,
        targetSnapshot: targetSnapshotNode.nodeId,
      },
      semanticParentResultDigests: {
        materialization: materialization.resultDigest,
        targetSnapshot: targetSnapshotNode.resultDigest,
      },
      provenanceParentNodeIds: {
        materialization: materialization.nodeId,
        targetSnapshot: targetSnapshotNode.nodeId,
      },
      outputSchema: 'workflow.plan-review-authorization-output.v3',
      output: {
        subject,
        assignment,
        author: {
          providerId: 'codex',
          sessionId: 'fixture-author-session',
          principalId: 'fixture-author',
          identityAssurance: 'adapter-assigned',
          engineSpawned: false,
        },
        grantAuthorization: null,
        roleTopology: null,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, authorization);
    for (const retiredVersion of [1, 2] as const) {
      const retiredAuthorization = createEvidenceNode({
        type: authorization.type,
        nodeSchema: `workflow.plan-review-authorization.v${retiredVersion}`,
        evaluator: authorization.evaluator,
        policyDigest: authorization.policyDigest,
        exactInputDigests: { ...authorization.exactInputDigests },
        semanticParentResultDigests: {
          ...authorization.semanticParentResultDigests,
        },
        provenanceParentNodeIds: {
          ...authorization.provenanceParentNodeIds,
        },
        outputSchema: `workflow.plan-review-authorization-output.v${retiredVersion}`,
        output: authorization.output,
        runtimeMetadata: {},
      });
      writeEvidenceNode(runtime, retiredAuthorization);
      assert.throws(
        () =>
          resolvePlanReviewInvocationOwner(runtime, {
            changeId,
            subject,
            assignment,
            authorizationNodeId: retiredAuthorization.nodeId,
          }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'EVIDENCE_REF_INVALID',
      );
    }
    const manifest: PlanReviewManifest = {
      schemaVersion: 1,
      kind: 'plan-review-manifest',
      changeId,
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      subject,
      capabilityProfile: 'repository-read-only',
      planningTarget: readPlanReviewTargetSnapshotNode(targetSnapshotNode),
    };
    const request = createProviderInvocationRequest({
      invocationId,
      nonce: 'plan-review-below-floor-nonce-000001',
      purpose: 'plan-review',
      providerId: 'claude',
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      targetDigest: subject.subjectDigest,
      inputManifestDigest: providerInvocationManifestDigest(manifest),
      authorizationNodeId: authorization.nodeId,
      writeAllowedPaths: [],
      outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
      evaluatorVersion: 'plan-review.v2',
      policyDigest: loadAiAdapterPolicy(repository).digest,
      limits: {
        timeoutMs: 300_000,
        aggregateOutputBytes: 1_048_576,
      },
    });
    assert.throws(
      () =>
        createCurrentAgentRuntimeAssignmentV1({
          repositoryRoot: repository,
          runtime,
          grantRuntimeRoot: path.dirname(runtime.root),
          changeId,
          request,
          configFilePath: agentProviderConfigPath,
          platform: 'darwin',
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_GRANT_REQUIRED',
    );
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId,
      changeId,
      attempt: 1,
      manifest,
      request,
      planReviewSnapshotFiles: [
        {
          snapshotFile: '0000.artifact',
          content: fs.readFileSync(
            path.join(repository, 'openspec/changes', changeId, 'proposal.md'),
          ),
        },
      ],
    });

    let runnerCalls = 0;
    assert.throws(
      () =>
        runProviderWorker(repository, invocationId, {
          agentProviderConfigPath,
          platform: 'darwin',
          runner() {
            runnerCalls += 1;
            return successfulWorkerReport(request, invocationId);
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_GRANT_REQUIRED' &&
        'details' in error &&
        (error.details as { invocationId?: unknown })?.invocationId ===
          invocationId,
    );
    assert.equal(runnerCalls, 0);
    assert.equal(
      readProviderInvocation(runtime, invocationId).state,
      'prepared',
    );

    let spawnCalls = 0;
    const dispatch = createProviderWorkerDispatcherForTesting(
      {
        spawn() {
          spawnCalls += 1;
          return { pid: 1234, unref() {} };
        },
      },
      { agentProviderConfigPath, platform: 'darwin' },
    );
    assert.throws(
      () => dispatch(repository, invocationId),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_GRANT_REQUIRED',
    );
    assert.equal(spawnCalls, 0);
    assert.equal(
      readProviderInvocation(runtime, invocationId).state,
      'prepared',
    );

    const grantPort = createProductionChangeRoleAssignmentGrantPort(
      repository,
      { configFilePath: agentProviderConfigPath, platform: 'darwin' },
    );
    const grantObservation =
      observeCurrentChangeRoleAssignmentGrantForInvocation(
        repository,
        invocationId,
        { configFilePath: agentProviderConfigPath, platform: 'darwin' },
      );
    const grantRequest = createChangeRoleAssignmentGrantRequest(
      grantObservation,
      'Authorize only this exact current below-floor assignment.',
    );
    const grantParameters = assertChangeRoleAssignmentGrantParameters(
      grantRequest.candidates[0]!.parameters,
    );
    assert.throws(
      () =>
        grantPort.observe({
          ...grantParameters,
          repositoryId: 'a-different-immutable-repository',
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_MISMATCH',
    );
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const grantNow = new Date('2030-08-29T02:00:00.000Z');
    const coordinator = createGrantCoordinatorKernel({
      store: createFileGrantRecordStore(
        grantStorePaths(path.dirname(runtime.root)),
      ),
      registry: createTransitionRegistry(
        changeRoleAssignmentGrantTransitionDefinitions(grantPort),
      ),
      policy: parseGrantPolicyV2(
        {
          schemaVersion: 2,
          defaultProfile: 'local-presence',
          profiles: {
            'local-presence': {
              requiredClaims: ['fresh-local-device-owner'],
            },
          },
          approvalModules: [
            {
              moduleId: 'human-gate-macos',
              version: '1',
              allowedClaims: ['fresh-local-device-owner'],
              configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
            },
          ],
        },
        { registry: codeOwnedApprovalModuleRegistry() },
      ),
      now: () => new Date(grantNow),
      randomUUID: () => ids.shift()!,
      challengeTtlMs: 10 * 60_000,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              reasonCode: 'approve-exact-role-independence-exception',
              reason: 'Approve this exact current provider invocation only.',
              approvalMethod: 'human-presence' as const,
              sessionNonce: 'nonce-below-floor-provider-worker-000000001',
            };
          },
          async authenticate({ approvalSubjectDigest }) {
            const proof: VerifiedApprovalProof = {
              moduleId: 'human-gate-macos',
              version: '1',
              claims: ['fresh-local-device-owner'],
              approvalSubjectDigest,
              proofDigest: `sha256:${sha256('below-floor-human-proof')}`,
              verifiedAt: grantNow.toISOString(),
              identity: null,
              portableEvidence: null,
            };
            return [proof];
          },
          async close() {},
        };
      },
      async withLifecycleOperation(_challengeId, operation) {
        return operation(() => undefined);
      },
    });
    const challenge = await coordinator.requestGrant(grantRequest);
    const completed = await coordinator.resolveChallenge(challenge.challengeId);
    assert.equal(completed.outcome, 'completed');

    const completedRecord = createFileGrantRecordStore(
      grantStorePaths(path.dirname(runtime.root)),
    ).readGrantRecord(challenge.challengeId);
    assert.equal(completedRecord.state, 'completed');
    if (completedRecord.state !== 'completed') {
      assert.fail('expected completed role-assignment Grant');
    }
    const hostConfiguration = fs.readFileSync(agentProviderConfigPath);
    fs.unlinkSync(agentProviderConfigPath);
    try {
      const recoveredActivation = grantPort.activate({
        parameters: grantParameters,
        approvalSubject: completedRecord.approvalSubject,
        approvalSubjectDigest: approvalSubjectDigest(
          completedRecord.approvalSubject,
        ),
        challengeId: completedRecord.challenge.challengeId,
        operationId: completedRecord.operationId,
        recovered: true,
        assertLifecycleOwned() {},
      });
      assert.equal(
        recoveredActivation.activation?.challengeId,
        challenge.challengeId,
      );
      assert.throws(
        () =>
          grantPort.activate({
            parameters: grantParameters,
            approvalSubject: completedRecord.approvalSubject,
            approvalSubjectDigest: approvalSubjectDigest(
              completedRecord.approvalSubject,
            ),
            challengeId: completedRecord.challenge.challengeId,
            operationId: '55555555-5555-4555-8555-555555555555',
            recovered: true,
            assertLifecycleOwned() {},
          }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_CONFLICT',
      );
    } finally {
      fs.writeFileSync(agentProviderConfigPath, hostConfiguration);
    }

    const submission = {
      verdict: 'advisory-approve' as const,
      scopeEvidence: [
        {
          kind: 'investigation-node' as const,
          nodeId: ready.applicabilityNode.nodeId,
          resultDigest: ready.applicabilityNode.resultDigest,
        },
      ],
      findings: [],
      proposedTerms: [],
      suggestions: [],
      residualRisk: 'The review cannot prove semantic completeness.',
      uncertainty: 'The provider operates under observed soft containment.',
    };
    const afterGrant = runProviderWorker(repository, invocationId, {
      agentProviderConfigPath,
      platform: 'darwin',
      runner() {
        runnerCalls += 1;
        return {
          invocationId,
          providerId: request.providerId,
          purpose: request.purpose,
          requestDigest: request.requestDigest,
          semanticOutput: submission,
          semanticOutputDigest: sha256(canonicalJson(submission)),
          assurance: 'unchanged-governed-projection' as const,
          projection: {
            unchanged: true as const,
            changedCategories: [],
            beforeDigest: 'd'.repeat(64),
            afterDigest: 'd'.repeat(64),
          },
          sameUserProcessConfined: false as const,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
          providerDefinitionSnapshot: resolveBuiltInProviderDefinitionSnapshot(
            'claude',
            'darwin',
          )!,
        };
      },
    });
    assert.equal(afterGrant.state, 'succeeded', JSON.stringify(afterGrant));
    assert.equal(runnerCalls, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('provider worker selects the code-owned exact PlanReview contract', () => {
  const repository = createFixtureRepository();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-agent-providers-')),
  );
  const agentProviderConfigPath = path.join(
    hostDirectory,
    'agent-providers.toml',
  );
  try {
    fs.writeFileSync(
      path.join(repository, 'workflow/role-provider-default.json'),
      renderCentralRoleProviderDefault(
        createCentralRoleProviderDefault({
          schemaVersion: 1,
          kind: 'central-role-provider-default',
          providerGroups: [
            {
              roles: ['author', 'builder', 'reviewer'],
              sessionGroups: [['author'], ['builder'], ['reviewer']],
              providerRule: { kind: 'adaptive-author' },
            },
          ],
          globalProviderRanking: ['claude', 'codex'],
        }),
      ),
    );
    fs.writeFileSync(agentProviderConfigPath, agentProviderConfigToml());
    git(repository, ['add', 'workflow/role-provider-default.json']);
    git(repository, ['commit', '-m', 'Add ordinary role provider defaults']);
    const ready = writeReadyV3ExemptChange(repository);
    const contract = loadChangeContract(repository, 'demo-change');
    assert.ok(contract.investigation);
    const investigationManifest = contract.investigation.manifest;
    const context = deriveInvestigationFirstPlanningSubject(
      planningAssuranceDependencies,
      repository,
      contract,
      readCurrentPlanningRoleOverridePolicy(repository, contract.changeId),
    );
    const locator = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      locator.gitCommonDirectory,
      'workflow-engine',
    );
    const invocationId = 'invocation-plan-review-worker';
    const investigationId = investigationManifest.investigationId;
    const assignment = {
      role: 'plan-reviewer' as const,
      providerId: 'claude' as const,
      sessionId: 'provider-session-plan-review-worker',
      targetDigest: context.subject.subjectDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    };
    const materialization = writeCurrentPlanningMaterialization(
      runtime,
      investigationManifest,
      context.subject.investigationBaseline,
      {
        'proposal.md': sha256(
          fs.readFileSync(
            path.join(
              repository,
              'openspec/changes',
              'demo-change',
              'proposal.md',
            ),
            'utf8',
          ),
        ),
      },
    );
    const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
      changeId: 'demo-change',
      changePrefix: 'openspec/changes/demo-change',
      subject: context.subject,
      materializationNode: materialization,
      artifacts: new Map([
        [
          'proposal.md',
          fs.readFileSync(
            path.join(
              repository,
              'openspec/changes',
              'demo-change',
              'proposal.md',
            ),
          ),
        ],
      ]),
    });
    writeEvidenceNode(runtime, targetSnapshotNode);
    const authorization = createEvidenceNode({
      type: 'plan-review-authorization',
      nodeSchema: 'workflow.plan-review-authorization.v3',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        generation: context.subject.planningGenerationId,
        grantAuthorization: sha256(canonicalJson(null)),
        roleTopology: sha256(canonicalJson(null)),
        subject: context.subject.subjectDigest,
        targetSnapshot: targetSnapshotNode.nodeId,
      },
      semanticParentResultDigests: {
        materialization: materialization.resultDigest,
        targetSnapshot: targetSnapshotNode.resultDigest,
      },
      provenanceParentNodeIds: {
        materialization: materialization.nodeId,
        targetSnapshot: targetSnapshotNode.nodeId,
      },
      outputSchema: 'workflow.plan-review-authorization-output.v3',
      output: {
        subject: context.subject,
        assignment,
        author: {
          providerId: 'codex',
          sessionId: 'fixture-author-session',
          principalId: 'fixture-author',
          identityAssurance: 'adapter-assigned',
          engineSpawned: false,
        },
        grantAuthorization: null,
        roleTopology: null,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, authorization);
    const manifest: PlanReviewManifest = {
      schemaVersion: 1,
      kind: 'plan-review-manifest',
      changeId: 'demo-change',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      subject: context.subject,
      capabilityProfile: 'repository-read-only',
      planningTarget: readPlanReviewTargetSnapshotNode(targetSnapshotNode),
    };
    const request = createProviderInvocationRequest({
      invocationId,
      nonce: 'plan-review-worker-nonce-000000',
      purpose: 'plan-review',
      providerId: 'claude',
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      targetDigest: context.subject.subjectDigest,
      inputManifestDigest: providerInvocationManifestDigest(manifest),
      authorizationNodeId: authorization.nodeId,
      writeAllowedPaths: [],
      outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
      evaluatorVersion: 'plan-review.v2',
      policyDigest: loadAiAdapterPolicy(repository).digest,
      limits: {
        timeoutMs: 300_000,
        aggregateOutputBytes: 1_048_576,
      },
    });
    const currentAssignment = createCurrentAgentRuntimeAssignmentV1({
      repositoryRoot: repository,
      runtime,
      grantRuntimeRoot: path.dirname(runtime.root),
      changeId: 'demo-change',
      request,
      configFilePath: agentProviderConfigPath,
      platform: 'darwin',
    });
    assert.equal(currentAssignment.binding.role, 'reviewer');
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId,
      changeId: 'demo-change',
      attempt: 1,
      manifest,
      request,
      planReviewSnapshotFiles: [
        {
          snapshotFile: '0000.artifact',
          content: fs.readFileSync(
            path.join(
              repository,
              'openspec/changes',
              'demo-change',
              'proposal.md',
            ),
          ),
        },
      ],
    });
    const submission = {
      verdict: 'advisory-approve' as const,
      scopeEvidence: [
        {
          kind: 'investigation-node' as const,
          nodeId: ready.applicabilityNode.nodeId,
          resultDigest: ready.applicabilityNode.resultDigest,
        },
      ],
      findings: [],
      proposedTerms: [],
      suggestions: [],
      residualRisk: 'The review cannot prove semantic completeness.',
      uncertainty: 'The provider operates under observed soft containment.',
    };
    const result = runProviderWorker(repository, invocationId, {
      agentProviderConfigPath,
      runner(input) {
        assert.ok(input.assignmentBinding);
        assert.equal(input.assignmentBinding.changeId, 'demo-change');
        assert.equal(input.assignmentBinding.role, 'reviewer');
        assert.equal(input.assignmentBinding.providerProfileId, 'claude-main');
        assert.equal(
          input.assignmentBinding.assignmentManifestDigest,
          loadChangeContract(repository, 'demo-change').investigation?.manifest
            .manifestDigest,
        );
        assert.notEqual(
          input.assignmentBinding.assignmentDigest,
          request.roleAssignmentDigest,
        );
        assert.equal(
          canonicalJson(input.assignmentBinding).includes(
            request.roleAssignment.sessionId,
          ),
          false,
        );
        assert.equal(
          sha256(canonicalJson(input.semanticOutputSchema)),
          PLAN_REVIEW_OUTPUT_SCHEMA.digest,
        );
        return {
          invocationId,
          providerId: 'claude',
          purpose: 'plan-review',
          requestDigest: request.requestDigest,
          semanticOutput: submission,
          semanticOutputDigest: sha256(canonicalJson(submission)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: 'd'.repeat(64),
            afterDigest: 'd'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
          providerDefinitionSnapshot: resolveBuiltInProviderDefinitionSnapshot(
            'claude',
            'darwin',
          )!,
        };
      },
    });
    assert.equal(result.state, 'succeeded', JSON.stringify(result));
    assert.equal(
      readProviderInvocation(runtime, invocationId).result?.outputDigest,
      sha256(
        canonicalJson({
          id: PLAN_REVIEW_OUTPUT_SCHEMA.id,
          version: PLAN_REVIEW_OUTPUT_SCHEMA.version,
          output: submission,
        }),
      ),
    );

    const claudeProtocol = resolveBuiltInProviderDefinitionSnapshot(
      'claude',
      'darwin',
    )!.protocol;
    fs.writeFileSync(
      agentProviderConfigPath,
      agentProviderConfigToml().replace(
        `protocol = "${claudeProtocol}"`,
        'protocol = "definition-drift-jsonl-v1"',
      ),
    );
    let blockedLaunches = 0;
    assert.throws(
      () => {
        createCurrentAgentRuntimeAssignmentV1({
          repositoryRoot: repository,
          runtime,
          grantRuntimeRoot: path.dirname(runtime.root),
          changeId: 'demo-change',
          request,
          configFilePath: agentProviderConfigPath,
          platform: 'darwin',
        });
        blockedLaunches += 1;
      },
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_DEFINITION_MISMATCH',
    );
    assert.equal(blockedLaunches, 0);

    fs.writeFileSync(agentProviderConfigPath, agentProviderConfigToml());
    const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
    const deniedPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      providers: { claude: { enabled: boolean } };
    };
    deniedPolicy.providers.claude.enabled = false;
    fs.writeFileSync(policyPath, `${JSON.stringify(deniedPolicy, null, 2)}\n`);
    const deniedRequest = createProviderInvocationRequest({
      invocationId: 'invocation-plan-review-data-denied',
      nonce: 'plan-review-worker-nonce-000002',
      purpose: request.purpose,
      providerId: request.providerId,
      roleAssignment: request.roleAssignment,
      capabilityProfile: request.capabilityProfile,
      repositoryId: request.repositoryId,
      baseCommit: request.baseCommit,
      baseTree: request.baseTree,
      targetDigest: request.targetDigest,
      inputManifestDigest: request.inputManifestDigest,
      authorizationNodeId: request.authorizationNodeId,
      writeAllowedPaths: [],
      outputSchema: request.outputSchema,
      evaluatorVersion: request.evaluatorVersion,
      policyDigest: loadAiAdapterPolicy(repository).digest,
      limits: request.limits,
    });
    let deniedLaunches = 0;
    assert.throws(
      () => {
        createCurrentAgentRuntimeAssignmentV1({
          repositoryRoot: repository,
          runtime,
          grantRuntimeRoot: path.dirname(runtime.root),
          changeId: 'demo-change',
          request: deniedRequest,
          configFilePath: agentProviderConfigPath,
          platform: 'darwin',
        });
        deniedLaunches += 1;
      },
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_DATA_AUTHORIZATION_DENIED',
    );
    assert.equal(deniedLaunches, 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});
