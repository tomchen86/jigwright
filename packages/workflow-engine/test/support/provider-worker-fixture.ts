import { planningAssuranceDependencies } from '../../src/composition-root/planning-assurance-production.ts';
import { readCurrentPlanningRoleOverridePolicy } from '../../src/runtime/repository-transaction/planning-role-provider-policy-reader.ts';
import { discoverRepository } from '../../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../../src/runtime/paths/runtime-paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperationAsync,
} from '../../src/runtime/session-workspace/session-store.ts';
import {
  createProductionProviderInvocationCancellationGrantPort,
  observeCurrentProviderInvocationCancellationRequest,
} from '../../src/composition-root/provider-invocation-cancellation-grant-production.ts';
import {
  createProviderInvocationCancellationGrantRequest,
  providerInvocationCancellationTransitionDefinitions,
} from '../../src/modules/authority/provider-invocation-cancellation-grant.ts';
import { createGrantCoordinatorKernel } from '../../src/modules/authority/grant-coordinator.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../../src/runtime/storage-journal/grant-store.ts';
import path from 'node:path';
import { createTransitionRegistry } from '../../src/modules/authority/grant-transition-registry.ts';
import {
  parseGrantPolicyV2,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  codeOwnedApprovalModuleRegistry,
} from '../../src/modules/authority/grant-policy.ts';
import crypto from 'node:crypto';
import { type VerifiedApprovalProof } from '../../src/modules/authority/grant-approval.ts';
import {
  createFixtureRepository,
  git,
  writeReadyV3ExemptChange,
} from '../fixture.ts';
import fs from 'node:fs';
import os from 'node:os';
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
} from '../../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  type AgentRolePlanBodyV2,
  renderAgentRolePlanV2,
  agentRolePlanV2Digest,
} from '../../src/modules/provider-orchestration/agent-role-plan.ts';
import { agentRolePlanV2Path } from '../../src/modules/source/planning-role-policy-paths.ts';
import { loadChangeContract } from '../../src/composition-root/consumer-contract-production.ts';
import assert from 'node:assert/strict';
import { deriveInvestigationFirstPlanningSubject } from '../../src/modules/assurance/planning-assurance-validator.ts';
import {
  createPlanReviewTargetSnapshotNode,
  readPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_OUTPUT_SCHEMA,
} from '../../src/modules/assurance/plan-review.ts';
import type { PlanReviewSubject } from '../../src/modules/assurance/plan-review-subject.ts';
import { writeEvidenceNode } from '../../src/runtime/storage-journal/evidence-object-store.ts';
import { createEvidenceNode } from '../../src/foundation/evidence-node/evidence-node.ts';
import {
  PROPOSE_POLICY_DIGEST,
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../../src/modules/provider-orchestration/provider-contracts.ts';
import { canonicalJson } from '../../src/foundation/canonical-json/canonical-json.ts';
import {
  providerInvocationManifestDigest,
  storeProviderExecutionPolicySnapshot,
  createProviderInvocation,
} from '../../src/runtime/storage-journal/provider-invocation-store.ts';
import type { PlanReviewManifest } from '../../src/modules/assurance/provider-review-manifests.ts';
import { loadAiAdapterPolicy } from '../../src/runtime/provider-policy/ai-adapter-policy.ts';
import { type InvestigationManifestV3 } from '../../src/modules/investigation/manifest/investigation-manifest-types.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import { PROVIDER_RUNNER_RESIDUALS } from '../../src/runtime/provider-execution/provider-runner.ts';

export async function beginExactProviderCancellationGrant(
  repository: string,
  invocationId: string,
  reason: string,
) {
  const locator = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    locator.gitCommonDirectory,
    'workflow-engine',
  );
  const lifecycleRuntime = runtimePaths(
    locator.gitCommonDirectory,
    'workflow-engine',
  );
  const port =
    createProductionProviderInvocationCancellationGrantPort(repository);
  const observation = observeCurrentProviderInvocationCancellationRequest(
    repository,
    invocationId,
    reason,
  );
  const request = createProviderInvocationCancellationGrantRequest(
    observation,
    'Approve cancellation of this one exact claimed provider invocation.',
  );
  const grantNow = new Date('2030-08-30T01:00:00.000Z');
  const coordinator = createGrantCoordinatorKernel({
    store: createFileGrantRecordStore(
      grantStorePaths(path.dirname(runtime.root)),
    ),
    registry: createTransitionRegistry(
      providerInvocationCancellationTransitionDefinitions(port),
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
    randomUUID: () => crypto.randomUUID(),
    challengeTtlMs: 10 * 60_000,
    openApprovalSession(presentation) {
      return {
        async collectDecision() {
          return {
            choiceId: presentation.choices[0]!.choiceId,
            reasonCode: 'cancel-exact-provider-invocation',
            reason: 'Approve only this exact provider cancellation.',
            approvalMethod: 'human-presence' as const,
            sessionNonce: 'nonce-provider-cancellation-grant-000000000001',
          };
        },
        async authenticate({ approvalSubjectDigest }) {
          const proof: VerifiedApprovalProof = {
            moduleId: 'human-gate-macos',
            version: '1',
            claims: ['fresh-local-device-owner'],
            approvalSubjectDigest,
            proofDigest: `sha256:${sha256(
              `provider-cancellation-proof:${invocationId}`,
            )}`,
            verifiedAt: grantNow.toISOString(),
            identity: null,
            portableEvidence: null,
          };
          return [proof];
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
  const challenge = await coordinator.requestGrant(request);
  return {
    challengeId: challenge.challengeId,
    resolution: coordinator.resolveChallenge(challenge.challengeId),
  };
}

export function createCurrentPlanReviewNativeWorkerFixture() {
  const repository = createFixtureRepository();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-native-reject-')),
  );
  const wrapperPath = path.join(hostDirectory, 'provider-wrapper-fixture.mjs');
  const agentProviderConfigPath = path.join(
    hostDirectory,
    'agent-providers.toml',
  );
  const changeId = 'demo-change';
  const invocationId = 'invocation-plan-review-native-rejected-result';
  try {
    fs.writeFileSync(wrapperPath, '#!/usr/bin/env node\n', { mode: 0o700 });
    fs.writeFileSync(
      agentProviderConfigPath,
      hostWrapperAgentProviderConfigToml(wrapperPath),
    );
    const central = createCentralRoleProviderDefault({
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
      customWrapperPolicy: 'allowed',
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
    git(repository, [
      'add',
      'workflow/role-provider-default.json',
      overridePath,
    ]);
    git(repository, ['commit', '-m', 'Select current provider roles']);
    writeReadyV3ExemptChange(repository, changeId);
    const contract = loadChangeContract(repository, changeId);
    assert.ok(contract.investigation);
    const investigationManifest = contract.investigation.manifest;
    const planning = deriveInvestigationFirstPlanningSubject(
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
    const assignment = {
      role: 'plan-reviewer' as const,
      providerId: 'claude' as const,
      sessionId: 'provider-session-plan-review-native-rejected-result',
      targetDigest: planning.subject.subjectDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    };
    const proposalPath = path.join(
      repository,
      'openspec/changes',
      changeId,
      'proposal.md',
    );
    const materialization = writeCurrentPlanningMaterialization(
      runtime,
      investigationManifest,
      planning.subject.investigationBaseline,
      { 'proposal.md': sha256(fs.readFileSync(proposalPath, 'utf8')) },
    );
    const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
      changeId,
      changePrefix: `openspec/changes/${changeId}`,
      subject: planning.subject,
      materializationNode: materialization,
      artifacts: new Map([['proposal.md', fs.readFileSync(proposalPath)]]),
    });
    writeEvidenceNode(runtime, targetSnapshotNode);
    const authorization = createEvidenceNode({
      type: 'plan-review-authorization',
      nodeSchema: 'workflow.plan-review-authorization.v3',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        assignment: sha256(canonicalJson(assignment)),
        generation: planning.subject.planningGenerationId,
        grantAuthorization: sha256(canonicalJson(null)),
        roleTopology: sha256(canonicalJson(null)),
        subject: planning.subject.subjectDigest,
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
        subject: planning.subject,
        assignment,
        author: {
          providerId: 'codex',
          sessionId: 'fixture-native-rejection-author-session',
          principalId: 'fixture-native-rejection-author',
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
      changeId,
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      subject: planning.subject,
      capabilityProfile: 'repository-read-only',
      planningTarget: readPlanReviewTargetSnapshotNode(targetSnapshotNode),
    };
    const request = createProviderInvocationRequest({
      invocationId,
      nonce: 'plan-review-native-rejected-result-nonce-000001',
      purpose: 'plan-review',
      providerId: 'claude',
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: 'fixture',
      baseCommit: locator.head,
      baseTree: locator.tree,
      targetDigest: planning.subject.subjectDigest,
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
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId: investigationManifest.investigationId,
      changeId,
      attempt: 1,
      manifest,
      request,
      planReviewSnapshotFiles: [
        {
          snapshotFile: '0000.artifact',
          content: fs.readFileSync(proposalPath),
        },
      ],
    });
    return {
      repository,
      hostDirectory,
      agentProviderConfigPath,
      runtime,
      request,
      invocationId,
      cleanup() {
        fs.rmSync(repository, { recursive: true, force: true });
        fs.rmSync(hostDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(hostDirectory, { recursive: true, force: true });
    throw error;
  }
}

function hostWrapperAgentProviderConfigToml(wrapperPath: string): string {
  const executable = JSON.stringify(wrapperPath);
  return `schema_version = 2
global_ranking = ["host-claude", "host-codex"]

[[providers]]
id = "host-claude"
logical_provider_id = "claude"
family = "claude"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = ${executable}
start_args = ["host-start", "{request_file}"]
resume_args = []
prompt_input = "stdin"
cancel = "process-group"

[[providers]]
id = "host-codex"
logical_provider_id = "codex"
family = "codex"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = ${executable}
start_args = ["host-start", "{request_file}"]
resume_args = []
prompt_input = "stdin"
cancel = "process-group"

[provider_preferences]
author = ["host-codex", "host-claude"]
builder = ["host-claude", "host-codex"]
reviewer = ["host-claude", "host-codex"]
`;
}

export function executableIdentityFor(candidatePath: string) {
  const realPath = fs.realpathSync(candidatePath);
  const stats = fs.statSync(realPath, { bigint: true });
  return {
    candidatePath,
    realPath,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
    sha256: sha256Buffer(fs.readFileSync(realPath)),
  };
}

export function writePrivateCanonicalJson(
  filePath: string,
  value: unknown,
): Buffer {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: 'wx' });
  return bytes;
}

export function sha256Buffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function intent() {
  return {
    schemaVersion: 1 as const,
    summary: 'Exercise lifecycle-owned provider work.',
    sourceRefs: [],
    explicitPaths: ['src/.gitkeep'],
    explicitSymbols: [],
    explicitConfigKeys: [],
    renamePairs: [],
  };
}

export function writeCurrentPlanningMaterialization(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  manifest: InvestigationManifestV3,
  baseline: PlanReviewSubject['investigationBaseline'],
  artifacts: Record<string, string>,
) {
  const investigationTargetDigest =
    manifest.investigationApproval.investigationTargetDigest;
  const sessionSnapshotDigest = manifest.authoring.sessionSnapshotDigest;
  const authority = createEvidenceNode({
    type: 'investigation-manifest-authority',
    nodeSchema: 'investigation.manifest-authority.v1',
    evaluator: 'workflow-propose.manifest-authority.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      manifest: manifest.manifestDigest,
      investigationTarget: investigationTargetDigest,
      sessionSnapshot: sessionSnapshotDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.manifest-authority-output.v1',
    output: {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest,
    },
    runtimeMetadata: {},
  });
  const materialization = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'workflow.propose-planning-materialization.v3',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      artifacts: sha256(canonicalJson(artifacts)),
      baseline: sha256(canonicalJson(baseline)),
      manifestAuthority: authority.nodeId,
      manifest: manifest.manifestDigest,
      investigationTarget: investigationTargetDigest,
      sessionSnapshot: sessionSnapshotDigest,
    },
    semanticParentResultDigests: {
      manifestAuthority: authority.resultDigest,
    },
    provenanceParentNodeIds: { manifestAuthority: authority.nodeId },
    outputSchema: 'workflow.propose-planning-materialization-output.v3',
    output: {
      investigationId: manifest.investigationId,
      changeId: manifest.changeId,
      semanticRevision: manifest.authoring.sessionRevision,
      baseline,
      artifacts,
      manifestAuthorityNodeId: authority.nodeId,
      manifestAuthorityResultDigest: authority.resultDigest,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest,
      sessionSnapshotDigest,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authority);
  writeEvidenceNode(runtime, materialization);
  return materialization;
}

export function lowerAdapterLimits(repository: string): void {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.limits.timeoutMs = 12_345;
  policy.limits.aggregateOutputBytes = 54_321;
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
}

export function writeHostWrapperFailureArtifacts(
  invocationDirectory: string,
  request: ProviderInvocationRequest,
): void {
  const probeDirectory = path.join(
    invocationDirectory,
    'host-wrapper-probe-runtime',
  );
  const turnDirectory = path.join(invocationDirectory, 'host-wrapper-runtime');
  fs.mkdirSync(probeDirectory, { mode: 0o700 });
  fs.mkdirSync(turnDirectory, { mode: 0o700 });
  const probeOutputPath = path.join(probeDirectory, 'probe-result.json');
  const semanticOutputPath = path.join(turnDirectory, 'semantic-output.json');
  for (const [filePath, value] of [
    [
      path.join(probeDirectory, 'request.json'),
      {
        schemaVersion: 1,
        kind: 'agent-runtime-host-wrapper-probe-request.v1',
        providerFamily: request.providerId,
        profileDigest: 'c'.repeat(64),
        outputFile: probeOutputPath,
      },
    ],
    [
      probeOutputPath,
      {
        schemaVersion: 1,
        kind: 'agent-runtime-host-wrapper-probe-result.v1',
        providerVersion: 'worker-host-error-fixture-v1',
        authentication: 'authenticated',
      },
    ],
    [
      path.join(turnDirectory, 'request.json'),
      {
        schemaVersion: 1,
        kind: 'agent-runtime-host-wrapper-turn-request.v1',
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        action: 'start',
        prompt: canonicalJson({
          schemaVersion: 1,
          kind: 'agent-runtime-host-wrapper-request.v1',
          request,
        }),
        outputFile: semanticOutputPath,
      },
    ],
    [semanticOutputPath, { failure: 'fixture-terminal-error' }],
  ] as const) {
    fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  }
}

export function agentProviderConfigToml(): string {
  const claude = resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin')!;
  const codex = resolveBuiltInProviderDefinitionSnapshot('codex', 'darwin')!;
  return `schema_version = 2
global_ranking = ["claude-main", "codex-main"]

[[providers]]
id = "claude-main"
logical_provider_id = "claude"
family = "claude"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "${claude.protocol}"
executable = "${claude.executableCandidates[0]}"

[[providers]]
id = "codex-main"
logical_provider_id = "codex"
family = "codex"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "${codex.protocol}"
executable = "${codex.executableCandidates[0]}"

[provider_preferences]
author = ["claude-main", "codex-main"]
builder = ["claude-main", "codex-main"]
reviewer = ["claude-main", "codex-main"]
`;
}

export function successfulWorkerReport(
  request: ProviderInvocationRequest,
  invocationId: string,
) {
  const semanticOutput = {
    reference: invocationId,
    terms: [{ kind: 'symbol', value: 'ProviderWorker' }],
  };
  return {
    invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
    assurance: 'unchanged-governed-projection' as const,
    projection: {
      unchanged: true as const,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false as const,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: executableIdentity(request.providerId),
    elapsedMs: 7,
    providerDefinitionSnapshot: resolveBuiltInProviderDefinitionSnapshot(
      request.providerId,
      'darwin',
    )!,
  };
}

export function executableIdentity(providerId: 'codex' | 'claude' = 'claude') {
  const candidatePath = resolveBuiltInProviderDefinitionSnapshot(
    providerId,
    'darwin',
  )!.executableCandidates[0]!;
  return {
    candidatePath,
    realPath: candidatePath,
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '123456789',
    sha256: 'b'.repeat(64),
  };
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
