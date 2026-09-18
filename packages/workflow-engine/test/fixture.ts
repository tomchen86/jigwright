import { planningAssuranceDependencies } from '../src/composition-root/planning-assurance-production.ts';
import { readCurrentPlanningRoleOverridePolicy } from '../src/runtime/repository-transaction/planning-role-provider-policy-reader.ts';
import { installFakeOpenSpec } from './fake-openspec-fixture.ts';
export { installFakeOpenSpec } from './fake-openspec-fixture.ts';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderDefinitionSnapshot } from '@jigwright/core/provider-definition-snapshot';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import { type ExecutionTask } from '../src/modules/planning-provider/planning-artifact-types.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
} from '../src/foundation/evidence-node/evidence-node.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { sealInvestigationManifestDraft } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import {
  buildInvestigationManifestDraft,
  validateForAuthority,
} from '../src/composition-root/investigation-production.ts';
import { type InvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import { investigationManifestPublicationNamespace } from '../src/modules/investigation/manifest/investigation-publication-contracts.ts';
import { OPENSPEC_REPOSITORY_REVIEWED_SOURCES } from '../src/adapters/planning/openspec/documents/openspec-planning-asset-contract.ts';
import { generateOpenSpecPlanningAssets as generateOpenSpecPlanningAssetsWithRunner } from '../src/adapters/planning/openspec/documents/openspec-planning-assets.ts';
import { resolveCheckRunner } from '../src/adapters/consumer/repository/work-registry/runner-resolution.ts';
const generateOpenSpecPlanningAssets =
  generateOpenSpecPlanningAssetsWithRunner.bind(undefined, resolveCheckRunner);
import {
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  createPlanReviewTargetSnapshotNode,
  canonicalizePlanReviewSubmission,
  planReviewProviderSubmission,
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
} from '../src/modules/assurance/plan-review.ts';
import { type PlanReviewSubmission } from '../src/modules/assurance/plan-review-report.ts';
import type { PlanReviewSubject } from '../src/modules/assurance/plan-review-subject.ts';
import {
  deriveInvestigationFirstPlanningSubject,
  validateInvestigationFirstPlanningReadiness,
} from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  sealAuthoritativeCollaborationGrantVerifier,
  sealConsumedCollaborationGrantReplayVerifier,
  type AuthoritativeCollaborationGrantVerifier,
  type ConsumedCollaborationGrantReplayVerifier,
  type GrantVerifierPort,
} from '../src/modules/authority/grant-verifier-port.ts';
import { admitRoleResult } from '../src/composition-root/role-admission-production.ts';
import type { ProviderRoleAssignment } from '../src/modules/provider-orchestration/role-assignment.ts';
import type { ProviderId } from '../src/modules/provider-orchestration/provider-registry.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderProcessResult,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  providerDefinitionDigest,
  providerDefinitionExecutableBindingDigest,
  PROVIDER_RUNNER_RESIDUALS,
} from '../src/modules/provider-orchestration/provider-runtime-evidence.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import type { ConsumedRoleReplayPort } from '../src/modules/provider-orchestration/role-admission-contracts.ts';

export const sourceRepositoryRoot = path.resolve(
  import.meta.dirname,
  '../../..',
);

let openSpecAssetTemplateRoot: string | undefined;

const TEST_COLLABORATION_GRANT_COMPOSITION_DIGEST = `sha256:${'0'.repeat(64)}`;
export const ordinaryPlanReviewReplayPortForTest: ConsumedRoleReplayPort =
  Object.freeze({
    verify(): never {
      throw new Error(
        'Ordinary PlanReview replay must not invoke the consumed-grant port.',
      );
    },
    verifyRoleContextSharing(): never {
      throw new Error(
        'Ordinary PlanReview replay must not invoke the role-context-sharing port.',
      );
    },
  });

export function authoritativeCollaborationGrantVerifierForTest(
  verifier: GrantVerifierPort,
): AuthoritativeCollaborationGrantVerifier {
  return sealAuthoritativeCollaborationGrantVerifier(
    {
      assertCurrent() {},
      verify: verifier.verify.bind(verifier),
    },
    TEST_COLLABORATION_GRANT_COMPOSITION_DIGEST,
  );
}

export function consumedCollaborationGrantReplayVerifierForTest(
  repository: string,
  verifier: GrantVerifierPort,
): ConsumedCollaborationGrantReplayVerifier {
  const policy = JSON.parse(
    git(repository, ['show', 'HEAD:workflow/maintainer-policy.json']),
  ) as { trustedSigners: unknown };
  return sealConsumedCollaborationGrantReplayVerifier(
    verifier,
    crypto
      .createHash('sha256')
      .update(canonicalJson(policy.trustedSigners))
      .digest('hex'),
  );
}

export function builtInProviderDefinitionSnapshotForTest(
  providerId: ProviderId,
): ProviderDefinitionSnapshot {
  const snapshot = resolveBuiltInProviderDefinitionSnapshot(
    providerId,
    'darwin',
  );
  if (snapshot === null) {
    throw new TypeError('Fixture built-in provider definition is unavailable.');
  }
  return snapshot;
}

export function builtInProviderExecutableIdentityForTest(
  providerId: ProviderId,
) {
  const executable =
    providerId === 'codex'
      ? '/opt/homebrew/bin/codex'
      : '/opt/homebrew/bin/claude';
  return {
    candidatePath: executable,
    realPath: executable,
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

export function createCurrentPlanReviewProviderEvidenceForTest(input: {
  subject: PlanReviewSubject;
  assignment: ProviderRoleAssignment;
  submission: PlanReviewSubmission;
  targetSnapshotNode: EvidenceNode;
  policyDigest: string;
  invocationId?: string;
  repositoryId?: string;
  runtimeObservation?: 'current' | null;
}): {
  request: ProviderInvocationRequest;
  result: ProviderProcessResult;
  providerInvocation: {
    invocationId: string;
    requestDigest: string;
    outputDigest: string;
    providerId: ProviderId;
    sessionId: string;
    targetDigest: string;
    engineSpawned: true;
  };
} {
  const invocationId = input.invocationId ?? 'fixture-plan-review-invocation';
  const request = createProviderInvocationRequest({
    invocationId,
    nonce: `fixture-plan-review-${invocationId}`,
    purpose: 'plan-review',
    providerId: input.assignment.providerId,
    roleAssignment: input.assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: input.repositoryId ?? 'fixture',
    baseCommit: input.subject.investigationBaseline.head,
    baseTree: input.subject.investigationBaseline.tree,
    targetDigest: input.assignment.targetDigest,
    inputManifestDigest: crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          schema: 'fixture.plan-review-input.v1',
          subject: input.subject.subjectDigest,
          targetSnapshot: input.targetSnapshotNode.nodeId,
        }),
      )
      .digest('hex'),
    authorizationNodeId: crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          schema: 'fixture.plan-review-authorization.v1',
          assignment: input.assignment,
        }),
      )
      .digest('hex'),
    writeAllowedPaths: [],
    outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
    evaluatorVersion: 'plan-review.v2',
    policyDigest: input.policyDigest,
    limits: { timeoutMs: 60_000, aggregateOutputBytes: 1_048_576 },
  });
  // The stored provider result holds exactly the bytes a provider would have
  // written, which is the authored wire form rather than the canonical one.
  const output = planReviewProviderSubmission(
    canonicalizePlanReviewSubmission(input.submission),
  );
  const outputDigest = crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        id: request.outputSchema.id,
        version: request.outputSchema.version,
        output,
      }),
    )
    .digest('hex');
  const runtimeObservation =
    input.runtimeObservation === 'current'
      ? (() => {
          const executable = builtInProviderExecutableIdentityForTest(
            request.providerId,
          );
          const providerDefinitionSnapshot =
            builtInProviderDefinitionSnapshotForTest(request.providerId);
          const projectionDigest = crypto
            .createHash('sha256')
            .update(`fixture-plan-review-projection:${invocationId}`)
            .digest('hex');
          return {
            assurance: 'unchanged-governed-projection' as const,
            projection: {
              unchanged: true as const,
              changedCategories: [] as [],
              beforeDigest: projectionDigest,
              afterDigest: projectionDigest,
            },
            sameUserProcessConfined: false as const,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable,
            elapsedMs: 1,
            providerDefinitionSnapshot,
            providerDefinitionBindingDigest:
              providerDefinitionExecutableBindingDigest(
                providerDefinitionDigest(providerDefinitionSnapshot),
                executable,
              ),
          };
        })()
      : null;
  return {
    request,
    result: {
      requestDigest: request.requestDigest,
      invocationId: request.invocationId,
      purpose: request.purpose,
      providerId: request.providerId,
      output,
      outputDigest,
      runtimeObservation,
    },
    providerInvocation: {
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      outputDigest,
      providerId: request.providerId,
      sessionId: input.assignment.sessionId,
      targetDigest: request.targetDigest,
      engineSpawned: true,
    },
  };
}

export function createFixtureRepository(
  options: {
    objectFormat?: 'sha1' | 'sha256';
    initializeRemoteTrackingBase?: boolean;
  } = {},
): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-session-repo-'),
  );
  git(repository, [
    'init',
    '-b',
    'main',
    `--object-format=${options.objectFormat ?? 'sha1'}`,
  ]);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);

  writeJson(path.join(repository, 'workflow/config.json'), {
    schemaVersion: 1,
    repositoryName: 'fixture',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
    taskAuthorization: {
      pathRoleRegistry: 'workflow/path-roles.json',
      mandateRequiredRoles: ['control-plane'],
    },
  });
  const repositoryConsumer = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/repository-consumer.json'),
      'utf8',
    ),
  ) as { consumerId: string };
  repositoryConsumer.consumerId = 'fixture';
  writeJson(
    path.join(repository, 'workflow/repository-consumer.json'),
    repositoryConsumer,
  );
  writeJson(path.join(repository, 'workflow/path-roles.json'), {
    schemaVersion: 1,
    kind: 'path-role-registry',
    roles: {
      ordinary: [
        'additional/**',
        'alias/**',
        'apps/**',
        'broken/**',
        'docs/**',
        'escape/**',
        'feature/**',
        'openspec/**',
        'outside.txt',
        'package.json',
        'packages/**',
        'sample/**',
        'scripts/**',
        'src/**',
        'test/**',
        'workflow/**',
      ],
    },
  });
  writeJson(path.join(repository, 'package.json'), {
    name: 'workflow-fixture',
    private: true,
    devDependencies: {
      'fixture-tool': '1.0.0',
    },
  });
  fs.writeFileSync(path.join(repository, '.gitignore'), 'node_modules/\n');
  writeJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks: {
      fixture: {
        command: ['node', 'scripts/pass.mjs'],
        destructiveDatabase: false,
      },
    },
  });
  writeJson(
    path.join(repository, 'workflow/change-providers/demo-change.json'),
    {
      schemaVersion: 1,
      changeId: 'demo-change',
      providerId: 'openspec',
      adapterContractVersion: 1,
      providerRequirement: {
        package: '@fission-ai/openspec',
        version: '1.6.0',
      },
      planningRoot: 'openspec/changes/demo-change',
    },
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/ai-adapter-policy.json'),
    path.join(repository, 'workflow/ai-adapter-policy.json'),
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  writeJson(path.join(repository, 'workflow/document-policy.json'), {
    schemaVersion: 1,
    enforcementMode: 'enforced',
    documents: {
      'docs/architecture/**': {
        mode: 'curated',
        refresh: 'reviewed-section',
      },
      'docs/features/**': {
        mode: 'curated',
        refresh: 'reviewed-section',
      },
    },
  });
  fs.mkdirSync(path.join(repository, 'workflow/schemas'), {
    recursive: true,
  });
  for (const schemaName of [
    'guard.schema.json',
    'execution-artifact.schema.json',
    'investigation-manifest-v3.schema.json',
    'plan-review-artifact.schema.json',
  ]) {
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/schemas', schemaName),
      path.join(repository, 'workflow/schemas', schemaName),
    );
  }

  const changeDirectory = path.join(repository, 'openspec/changes/demo-change');
  fs.mkdirSync(path.join(changeDirectory, 'specs/demo'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  addFixtureScripts(repository);
  fs.writeFileSync(
    path.join(changeDirectory, '.openspec.yaml'),
    'schema: spec-driven\n',
  );
  fs.writeFileSync(path.join(changeDirectory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(changeDirectory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(changeDirectory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Demo task\n',
  );
  fs.writeFileSync(
    path.join(changeDirectory, 'specs/demo/spec.md'),
    [
      '# Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Demo behavior',
      '',
      'The system SHALL provide the demo behavior.',
      '',
      '#### Scenario: Demo succeeds',
      '',
      '- **WHEN** the demo is exercised',
      '- **THEN** the behavior succeeds',
      '',
    ].join('\n'),
  );
  writeJson(path.join(changeDirectory, 'guard.json'), {
    schemaVersion: 1,
    changeId: 'demo-change',
    tasks: {
      '1.1': {
        allowedPaths: ['src/**'],
        requiredChecks: ['fixture'],
      },
    },
  });
  fs.writeFileSync(path.join(repository, 'src/.gitkeep'), '');
  installFakeOpenSpec(repository);
  installOpenSpecAssetFixture(repository);

  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Create fixture']);
  if (options.initializeRemoteTrackingBase !== false)
    syncOriginMain(repository);
  return repository;
}

export function writeManagedChangeArtifacts(
  repository: string,
  changeId = 'demo-change',
) {
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  const currentSchemaName = (
    JSON.parse(
      fs.readFileSync(
        path.join(repository, 'workflow/repository-consumer.json'),
        'utf8',
      ),
    ) as { planning: { currentSchemaName: string } }
  ).planning.currentSchemaName;
  fs.writeFileSync(
    path.join(changeDirectory, '.openspec.yaml'),
    `schema: ${currentSchemaName}\ncreated: 2026-07-15\n`,
  );
  const investigation = buildManagedFixtureInvestigation(repository, changeId);
  const reviewNode = createEvidenceNode({
    type: 'fixture-plan-review',
    nodeSchema: 'fixture.plan-review.v1',
    evaluator: 'fixture.plan-review.v1',
    policyDigest: '3'.repeat(64),
    exactInputDigests: { target: '4'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.plan-review-output.v1',
    output: { verdict: 'advisory-approve' },
    runtimeMetadata: {},
  });
  const execution = {
    schemaVersion: 1 as const,
    kind: 'execution-artifact' as const,
    changeId,
    tasks: {
      '1.1': {
        strategy: 'direct-reviewed' as const,
        enforcement: 'available' as const,
        allowedPaths: ['src/**'],
        requiredChecks: ['fixture'],
        diffReview: 'policy-required' as const,
        exemptionKind: 'documentation-only' as const,
        exemptionReason: 'documentation-only',
      },
    },
  };
  const planReview = {
    schemaVersion: 1 as const,
    kind: 'plan-review-artifact' as const,
    changeId,
    nodes: [reviewNode],
    currentRefs: { planReview: reviewNode.nodeId },
  };
  for (const [name, artifact] of Object.entries({
    'investigation.json': investigation,
    'execution.json': execution,
    'plan-review.json': planReview,
  })) {
    fs.writeFileSync(
      path.join(changeDirectory, name),
      `${canonicalJson(artifact)}\n`,
    );
  }
  for (const schemaName of [
    'investigation-manifest-v3.schema.json',
    'execution-artifact.schema.json',
    'plan-review-artifact.schema.json',
  ]) {
    const target = path.join(repository, 'workflow/schemas', schemaName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/schemas', schemaName),
      target,
    );
  }
  return { investigation, execution, planReview };
}

export function fixtureCurrentSchemaName(repository: string): string {
  return (
    JSON.parse(
      fs.readFileSync(
        path.join(repository, 'workflow/repository-consumer.json'),
        'utf8',
      ),
    ) as { planning: { currentSchemaName: string } }
  ).planning.currentSchemaName;
}

function buildManagedFixtureInvestigation(
  repository: string,
  changeId: string,
): InvestigationManifestV3 {
  const config = JSON.parse(
    fs.readFileSync(path.join(repository, 'workflow/config.json'), 'utf8'),
  ) as { repositoryName: string };
  const baseline = {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
  const investigationId = `investigation-${changeId}-managed-fixture`;
  const sessionRevision = 1;
  const sessionSnapshotDigest = crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        schema: 'fixture-managed-investigation-session.v1',
        repositoryId: config.repositoryName,
        changeId,
        investigationId,
        baseline,
      }),
    )
    .digest('hex');
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state: {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: config.repositoryName,
      changeId,
      investigationId,
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Prepare one current v3 managed-change fixture.',
        sourceRefs: [],
        explicitPaths: ['docs/example.md'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: { sessionRevision, sessionSnapshotDigest },
      exemption: {
        category: 'documentation-only',
        baseline,
        declaredPaths: ['docs/example.md'],
        declaredChangeClasses: ['documentation-only'],
        rationale: 'The managed-change fixture is documentation-only.',
        semanticAuthor: {
          id: 'fixture-owner',
          provenance: 'fixture-managed-investigation-author',
        },
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      },
    },
  });
  if (built.outcome !== 'built') {
    throw new Error(
      `Managed fixture v3 Manifest build failed: ${built.blocker.failureCode}`,
    );
  }
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'fixture-owner',
        provenance: 'fixture-managed-investigation-approval',
      },
      approvalProvenanceDigest: crypto
        .createHash('sha256')
        .update(`fixture-managed-investigation-approval\0${changeId}`)
        .digest('hex'),
    },
  });
  if (sealed.outcome !== 'sealed') {
    throw new Error(
      `Managed fixture v3 Manifest seal failed: ${sealed.blocker.failureCode}`,
    );
  }
  const verified = validateForAuthority({
    repositoryRoot: repository,
    manifest: sealed.manifest,
    expected: {
      repositoryId: config.repositoryName,
      changeId,
      investigationId,
      sessionRevision,
      sessionSnapshotDigest,
    },
  });
  if (verified.outcome !== 'verified') {
    throw new Error(
      `Managed fixture v3 Manifest validation failed: ${verified.blocker.failureCode}`,
    );
  }
  return verified.manifest;
}

export function prepareCurrentV3IntroductionFixture(
  repository: string,
  changeId = 'demo-change',
): void {
  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-current-v3-introduction-'),
  );
  const changePath = path.join(repository, 'openspec/changes', changeId);
  const providerBindingPath = path.join(
    repository,
    'workflow/change-providers',
    `${changeId}.json`,
  );
  const backupChangePath = path.join(backupRoot, changeId);
  const backupProviderBindingPath = path.join(
    backupRoot,
    'change-provider.json',
  );
  const hasProviderBinding = fs.existsSync(providerBindingPath);
  try {
    fs.cpSync(changePath, backupChangePath, { recursive: true });
    if (hasProviderBinding) {
      fs.copyFileSync(providerBindingPath, backupProviderBindingPath);
    }
    fs.rmSync(changePath, { recursive: true, force: true });
    fs.rmSync(providerBindingPath, { force: true });
    fs.writeFileSync(path.join(repository, 'openspec/changes/.gitkeep'), '');
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Prepare absent current change']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    fs.cpSync(backupChangePath, changePath, { recursive: true });
    if (hasProviderBinding) {
      fs.mkdirSync(path.dirname(providerBindingPath), { recursive: true });
      fs.copyFileSync(backupProviderBindingPath, providerBindingPath);
    }
  } finally {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

export function writeReadyV3ExemptChange(
  repository: string,
  changeId = 'demo-change',
  options: {
    diffReview?: 'required' | 'policy-required';
    executionTask?: (input: {
      taskId: string;
      policy: { allowedPaths: string[]; requiredChecks: string[] };
    }) => ExecutionTask;
  } = {},
) {
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  const currentSchemaName = fixtureCurrentSchemaName(repository);
  const baseline = {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
  fs.writeFileSync(
    path.join(changeDirectory, '.openspec.yaml'),
    `schema: ${currentSchemaName}\ncreated: 2026-07-15\n`,
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(repository, 'workflow/config.json'), 'utf8'),
  ) as { repositoryName: string; runtimeDirectory: string };
  const investigationId = `investigation-${changeId}-fixture`;
  const sessionSnapshotDigest = crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        schema: 'fixture-ready-v3-exemption-session.v1',
        repositoryId: config.repositoryName,
        changeId,
        investigationId,
        baseline,
      }),
    )
    .digest('hex');
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state: {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: config.repositoryName,
      changeId,
      investigationId,
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Prepare one current v3 documentation-only fixture change.',
        sourceRefs: [],
        explicitPaths: ['src/documentation.md'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: { sessionRevision: 3, sessionSnapshotDigest },
      exemption: {
        category: 'documentation-only',
        baseline,
        declaredPaths: ['src/documentation.md'],
        declaredChangeClasses: ['documentation-only'],
        rationale: 'The fixture change is documentation-only.',
        semanticAuthor: { id: 'codex', provenance: 'fixture-main-agent' },
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      },
    },
  });
  if (built.outcome !== 'built') {
    throw new Error(
      `Fixture v3 Manifest build failed: ${built.blocker.failureCode}`,
    );
  }
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'fixture-owner',
        provenance: 'fixture-v3-exemption-approval',
      },
      approvalProvenanceDigest: crypto
        .createHash('sha256')
        .update(`fixture-v3-exemption-approval\0${changeId}`)
        .digest('hex'),
    },
  });
  if (sealed.outcome !== 'sealed') {
    throw new Error(
      `Fixture v3 Manifest seal failed: ${sealed.blocker.failureCode}`,
    );
  }
  const verified = validateForAuthority({
    repositoryRoot: repository,
    manifest: sealed.manifest,
    expected: {
      repositoryId: config.repositoryName,
      changeId,
      investigationId,
      sessionRevision: 3,
      sessionSnapshotDigest,
    },
  });
  if (verified.outcome !== 'verified') {
    throw new Error(
      `Fixture v3 Manifest validation failed: ${verified.blocker.failureCode}`,
    );
  }
  const investigation = verified.manifest;
  const guard = JSON.parse(
    fs.readFileSync(path.join(changeDirectory, 'guard.json'), 'utf8'),
  ) as {
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  const execution = {
    schemaVersion: 1 as const,
    kind: 'execution-artifact' as const,
    changeId,
    tasks: Object.fromEntries(
      Object.entries(guard.tasks).map(([taskId, policy]) => [
        taskId,
        options.executionTask?.({ taskId, policy }) ?? {
          strategy: 'direct-reviewed' as const,
          enforcement: 'available' as const,
          allowedPaths: policy.allowedPaths,
          requiredChecks: policy.requiredChecks,
          diffReview: options.diffReview ?? ('policy-required' as const),
          exemptionKind: 'documentation-only' as const,
          exemptionReason: 'Fixture documentation-only task.',
        },
      ]),
    ),
  };
  const placeholder = createEvidenceNode({
    type: 'pending-plan-review',
    nodeSchema: 'fixture.pending-plan-review.v1',
    evaluator: 'fixture.pending-plan-review.v1',
    policyDigest: '3'.repeat(64),
    exactInputDigests: {
      manifest: investigation.manifestDigest,
      investigationTarget:
        investigation.investigationApproval.investigationTargetDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.pending-plan-review-output.v1',
    output: { pending: true },
    runtimeMetadata: {},
  });
  writeCanonicalJson(
    path.join(changeDirectory, 'investigation.json'),
    investigation,
  );
  writeCurrentV3ManifestRef(repository, config.runtimeDirectory, investigation);
  writeCanonicalJson(path.join(changeDirectory, 'execution.json'), execution);
  writeCanonicalJson(path.join(changeDirectory, 'plan-review.json'), {
    schemaVersion: 1,
    kind: 'plan-review-artifact',
    changeId,
    nodes: [placeholder],
    currentRefs: { planReview: placeholder.nodeId },
  });

  const subjectContext = deriveInvestigationFirstPlanningSubject(
    planningAssuranceDependencies,
    repository,
    loadChangeContract(repository, changeId),
    readCurrentPlanningRoleOverridePolicy(repository, changeId),
  );
  const assignment = {
    role: 'plan-reviewer' as const,
    providerId: 'claude' as const,
    sessionId: 'fixture-plan-review-session',
    targetDigest: subjectContext.subject.subjectDigest,
    requiredIndependence: 'session-independent' as const,
    achievedIndependence: 'provider-independent' as const,
  };
  const snapshotRelativePaths = [
    '.openspec.yaml',
    'design.md',
    'execution.json',
    'guard.json',
    'investigation.json',
    'proposal.md',
    'specs/demo/spec.md',
    'tasks.md',
  ];
  const snapshotContents = new Map(
    snapshotRelativePaths.map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(changeDirectory, relativePath)),
    ]),
  );
  const materializationNode = createEvidenceNode({
    type: 'propose-exemption-planning-materialization',
    nodeSchema: 'fixture.propose-exemption-planning-materialization.v1',
    evaluator: 'fixture.propose-exemption-planning-materialization.v1',
    policyDigest: subjectContext.policies.reviewPolicyDigest,
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema:
      'fixture.propose-exemption-planning-materialization-output.v1',
    output: {
      artifacts: Object.fromEntries(
        [...snapshotContents].map(([relativePath, content]) => [
          relativePath,
          crypto.createHash('sha256').update(content).digest('hex'),
        ]),
      ),
    },
    runtimeMetadata: {},
  });
  const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
    changeId,
    changePrefix: `openspec/changes/${changeId}`,
    subject: subjectContext.subject,
    materializationNode,
    artifacts: snapshotContents,
  });
  const submission = {
    schemaVersion: 2 as const,
    verdict: 'advisory-approve' as const,
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge' as const,
      evidence: [
        {
          kind: 'investigation-node' as const,
          nodeId: subjectContext.applicabilityNode.nodeId,
          resultDigest: subjectContext.applicabilityNode.resultDigest,
        },
      ],
    },
    findings: [],
    proposedTerms: [],
    suggestions: [],
    residualRisk:
      'The structured exemption does not prove semantic completeness.',
    uncertainty: 'The fixture relies only on the declared low-risk exemption.',
  };
  const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
    subject: subjectContext.subject,
    assignment,
    submission,
    targetSnapshotNode,
    policyDigest: subjectContext.policies.reviewPolicyDigest,
    invocationId: 'fixture-plan-review-invocation',
    runtimeObservation: 'current',
  });
  const providerResultNode = createPlanReviewProviderResultNode({
    subject: subjectContext.subject,
    assignment,
    request: providerEvidence.request,
    result: providerEvidence.result,
    targetSnapshotNode,
  });
  const reviewNode = createPlanReviewNode({
    subject: subjectContext.subject,
    assignment,
    providerResultNode,
    submission,
  });
  const roleResult = admitRoleResult({
    assignment,
    author: {
      providerId: 'codex',
      sessionId: 'fixture-plan-author-session',
      principalId: undefined,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    participant: {
      providerId: 'claude',
      sessionId: assignment.sessionId,
      principalId: undefined,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    },
    content: {
      kind: 'plan-review',
      nodeId: providerResultNode.nodeId,
      resultDigest: providerResultNode.resultDigest,
      outputSchema: providerEvidence.request.outputSchema,
      evaluator: providerEvidence.request.evaluatorVersion,
      policyDigest: providerEvidence.request.policyDigest,
      contentDigest: providerResultNode.resultDigest,
      current: true,
    },
    providerInvocation: providerEvidence.providerInvocation,
    grantUse: null,
    grantValidation: null,
  });
  writeCanonicalJson(path.join(changeDirectory, 'plan-review.json'), {
    schemaVersion: 1,
    kind: 'plan-review-artifact',
    changeId,
    nodes: [targetSnapshotNode, providerResultNode, reviewNode].sort(
      (left, right) => left.nodeId.localeCompare(right.nodeId),
    ),
    currentRefs: { planReview: reviewNode.nodeId },
    roleResults: [roleResult],
  });

  const planningAssurance = validateInvestigationFirstPlanningReadiness(
    planningAssuranceDependencies,
    repository,
    loadChangeContract(repository, changeId),
    ordinaryPlanReviewReplayPortForTest,
    readCurrentPlanningRoleOverridePolicy(repository, changeId),
  ).summary;
  return {
    applicability: subjectContext.applicability,
    applicabilityNode: subjectContext.applicabilityNode,
    planningAssurance,
  };
}

function writeCurrentV3ManifestRef(
  repository: string,
  runtimeDirectory: string,
  manifest: InvestigationManifestV3,
): void {
  const lifecycle = {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
  };
  const commonValue = git(repository, ['rev-parse', '--git-common-dir']).trim();
  const gitCommonDirectory = fs.realpathSync(
    path.isAbsolute(commonValue)
      ? commonValue
      : path.resolve(repository, commonValue),
  );
  const privateRuntimeRoot = path.join(gitCommonDirectory, runtimeDirectory);
  fs.mkdirSync(privateRuntimeRoot, { recursive: true, mode: 0o700 });
  writeCanonicalJson(
    path.join(
      privateRuntimeRoot,
      investigationManifestPublicationNamespace(lifecycle),
      'current.json',
    ),
    {
      schemaVersion: 1,
      kind: 'investigation-manifest-current',
      ...lifecycle,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest:
        manifest.investigationApproval.investigationTargetDigest,
      manifestPath: `openspec/changes/${manifest.changeId}/investigation.json`,
    },
  );
}

/**
 * Mirror the local protected branch tip into its remote-tracking ref, which is
 * the base archive eligibility resolves. Fixtures call this whenever `main`
 * advances to a new intended integration base, reproducing the ref a real
 * clone would track.
 */
export function syncOriginMain(repository: string): void {
  const tip = git(repository, ['rev-parse', 'main']).trim();
  git(repository, ['update-ref', 'refs/remotes/origin/main', tip]);
}

export function addFixtureScripts(repository: string): void {
  const scriptsDirectory = path.join(repository, 'scripts');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDirectory, 'capture-args.mjs'),
    [
      "import fs from 'node:fs';",
      'const [outputPath, ...arguments_] = process.argv.slice(2);',
      'fs.writeFileSync(',
      '  outputPath,',
      '  JSON.stringify({ cwd: process.cwd(), arguments: arguments_ }),',
      ');',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'write-file.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.argv[2], 'ran');",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'pass.mjs'),
    'process.exit(0);\n',
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'fail.mjs'),
    'process.exit(7);\n',
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'remove-file.mjs'),
    ["import fs from 'node:fs';", 'fs.rmSync(process.argv[2]);', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'mutate-self.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.appendFileSync(import.meta.filename, "\\n");',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'overflow.mjs'),
    "process.stdout.write('x'.repeat(11 * 1024 * 1024));\n",
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'replace-file.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.writeFileSync(process.argv[2], process.argv[3]);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'chmod-file.mjs'),
    [
      "import fs from 'node:fs';",
      'fs.chmodSync(process.argv[2], 0o755);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsDirectory, 'replace-preserve-times.mjs'),
    [
      "import fs from 'node:fs';",
      'const targetPath = process.argv[2];',
      'const before = fs.statSync(targetPath);',
      'fs.writeFileSync(targetPath, process.argv[3]);',
      'fs.utimesSync(targetPath, before.atime, before.mtime);',
      '',
    ].join('\n'),
  );
}

export function addFixturePackage(
  repository: string,
  source = 'process.exit(0);\n',
): void {
  const packageDirectory = path.join(repository, 'node_modules/fixture-tool');
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: 'fixture-tool',
    version: '1.0.0',
    exports: { '.': './index.mjs' },
    bin: './bin/run.mjs',
  });
  fs.writeFileSync(path.join(packageDirectory, 'bin/run.mjs'), source);
}

export function configureChecks(
  repository: string,
  checks: Record<
    string,
    {
      command: string[];
      destructiveDatabase: boolean;
      liveStderr?: boolean;
    }
  >,
  requiredChecks: string[],
): void {
  writeJson(path.join(repository, 'workflow/checks.json'), {
    schemaVersion: 1,
    checks,
  });
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
  guard.tasks['1.1'].requiredChecks = requiredChecks;
  writeJson(guardPath, guard);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure fixture checks']);
}

function installOpenSpecAssetFixture(repository: string): void {
  const templateRoot = openSpecAssetTemplate();
  for (const relativePath of [
    '.codex/skills',
    '.claude/skills',
    '.agents/skills',
    'workflow/openspec-assets',
  ]) {
    const destination = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(templateRoot, relativePath), destination, {
      recursive: true,
    });
  }
}

function openSpecAssetTemplate(): string {
  if (openSpecAssetTemplateRoot) return openSpecAssetTemplateRoot;

  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-openspec-asset-fixture-template-'),
  );
  try {
    writeJson(path.join(repository, 'package.json'), {
      name: 'workflow-openspec-asset-fixture-template',
      private: true,
      devDependencies: {},
    });
    for (const sourcePath of OPENSPEC_REPOSITORY_REVIEWED_SOURCES) {
      const destination = path.join(repository, sourcePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(sourceRepositoryRoot, sourcePath), destination);
    }
    installFakeOpenSpec(repository);
    generateOpenSpecPlanningAssets(repository, {
      installationRepositoryRoot: repository,
      formatterRepositoryRoot: sourceRepositoryRoot,
    });
    openSpecAssetTemplateRoot = repository;
    process.once('exit', () => {
      fs.rmSync(repository, { recursive: true, force: true });
    });
    return repository;
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

export function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runtimeRoot(repository: string): string {
  return path.join(
    fs.realpathSync(path.join(repository, '.git')),
    'workflow-engine',
  );
}

export function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCanonicalJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`);
}
