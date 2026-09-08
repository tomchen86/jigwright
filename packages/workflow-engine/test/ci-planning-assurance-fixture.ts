/** Current Manifest and PlanReview assurance setup for CI planning histories. */
import {
  createFixtureRepository,
  git,
  createCurrentPlanReviewProviderEvidenceForTest,
} from './fixture.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  buildInvestigationManifestDraft,
  sealInvestigationManifestDraft,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import type { InvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import { investigationManifestPublicationNamespace } from '../src/runtime/managed-documents/transaction/investigation-publication.ts';
import { loadChangeContract } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  createPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_COVERAGE,
  createPlanReviewProviderResultNode,
  createPlanReviewNode,
} from '../src/modules/assurance/plan-review.ts';
import { admitRoleResult } from '../src/modules/provider-orchestration/role-scheduler.ts';
import {
  CHANGE_ID,
  write,
  configureFixtureCurrentSchema,
  commit,
  writeCurrentTasksAndGuard,
  writePlanningProviderBindingForChange,
} from './ci-planning-fixture.ts';

export function prepareCurrentV3IntroductionRepository(
  options: {
    currentSchemaName?: string;
    includeProviderBinding?: boolean;
    tasks?: string;
  } = {},
): string {
  const repository = createFixtureRepository();
  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ci-current-v3-introduction-'),
  );
  const changePath = path.join(repository, 'openspec/changes', CHANGE_ID);
  const backupPath = path.join(backupRoot, CHANGE_ID);
  try {
    fs.cpSync(changePath, backupPath, { recursive: true });
    fs.rmSync(changePath, { recursive: true, force: true });
    fs.rmSync(
      path.join(repository, `workflow/change-providers/${CHANGE_ID}.json`),
      { force: true },
    );
    write(
      repository,
      'openspec/changes/other-change/keep.md',
      'Unrelated baseline change container.\n',
    );
    if (options.currentSchemaName !== undefined) {
      configureFixtureCurrentSchema(repository, options.currentSchemaName);
    }
    commit(repository, 'Prepare absent current change');

    git(repository, ['checkout', '-b', `work/${CHANGE_ID}`]);
    fs.cpSync(backupPath, changePath, { recursive: true });
    if (options.tasks !== undefined) {
      writeCurrentTasksAndGuard(repository, options.tasks);
    }
    writeReadyV3ExemptChange(repository, CHANGE_ID, options.currentSchemaName);
    writePlanningProviderBindingForChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    if (options.includeProviderBinding === false) {
      fs.rmSync(
        path.join(repository, `workflow/change-providers/${CHANGE_ID}.json`),
      );
    }
    return repository;
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

export function writeReadyV3ExemptChange(
  repository: string,
  changeId = 'demo-change',
  schemaName = (
    JSON.parse(
      fs.readFileSync(
        path.join(repository, 'workflow/repository-consumer.json'),
        'utf8',
      ),
    ) as { planning: { currentSchemaName: string } }
  ).planning.currentSchemaName,
): void {
  const changeRoot = path.join(repository, 'openspec/changes', changeId);
  const baseline = {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
  const sessionSnapshotDigest = crypto
    .createHash('sha256')
    .update(`ci-current-v3-session\0${changeId}`)
    .digest('hex');
  const repositoryConfig = JSON.parse(
    fs.readFileSync(path.join(repository, 'workflow/config.json'), 'utf8'),
  ) as { repositoryName: string };
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state: {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: repositoryConfig.repositoryName,
      changeId,
      investigationId: `${changeId}-investigation`,
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Exercise immutable CI replay with a current v3 Manifest.',
        sourceRefs: [],
        explicitPaths: [`openspec/changes/${changeId}/proposal.md`],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: { sessionRevision: 3, sessionSnapshotDigest },
      exemption: {
        category: 'documentation-only',
        baseline,
        declaredPaths: [`openspec/changes/${changeId}/proposal.md`],
        declaredChangeClasses: ['documentation-only'],
        rationale: 'The fixture change is documentation-only.',
        semanticAuthor: {
          id: 'codex',
          provenance: 'checkpoint:ci-current-v3',
        },
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      },
    },
  });
  if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:ci-current-v3-approval',
      },
      approvalProvenanceDigest: crypto
        .createHash('sha256')
        .update(`ci-current-v3-approval\0${changeId}`)
        .digest('hex'),
    },
  });
  if (sealed.outcome !== 'sealed') assert.fail(sealed.blocker.failureCode);

  fs.writeFileSync(
    path.join(changeRoot, '.openspec.yaml'),
    `schema: ${schemaName}\ncreated: 2026-07-15\n`,
  );
  fs.writeFileSync(
    path.join(changeRoot, 'investigation.json'),
    `${canonicalJson(sealed.manifest)}\n`,
  );
  writeCurrentV3Ref(repository, sealed.manifest);
  const guard = JSON.parse(
    fs.readFileSync(path.join(changeRoot, 'guard.json'), 'utf8'),
  ) as {
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  fs.writeFileSync(
    path.join(changeRoot, 'execution.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'execution-artifact',
      changeId,
      tasks: Object.fromEntries(
        Object.entries(guard.tasks).map(([taskId, policy]) => [
          taskId,
          {
            strategy: 'direct-reviewed',
            enforcement: 'available',
            allowedPaths: policy.allowedPaths,
            requiredChecks: policy.requiredChecks,
            diffReview: 'policy-required',
            exemptionKind: 'documentation-only',
            exemptionReason: 'Fixture documentation-only task.',
          },
        ]),
      ),
    })}\n`,
  );
  const placeholder = createEvidenceNode({
    type: 'pending-plan-review',
    nodeSchema: 'fixture.pending-plan-review.v1',
    evaluator: 'fixture.pending-plan-review.v1',
    policyDigest: '3'.repeat(64),
    exactInputDigests: {
      manifest: sealed.manifest.manifestDigest,
      investigationTarget:
        sealed.manifest.investigationApproval.investigationTargetDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.pending-plan-review-output.v1',
    output: { pending: true },
    runtimeMetadata: {},
  });
  fs.writeFileSync(
    path.join(changeRoot, 'plan-review.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'plan-review-artifact',
      changeId,
      nodes: [placeholder],
      currentRefs: { planReview: placeholder.nodeId },
    })}\n`,
  );
}

function writeCurrentV3Ref(
  repository: string,
  manifest: InvestigationManifestV3,
): void {
  const lifecycle = {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
  };
  const commonValue = git(repository, ['rev-parse', '--git-common-dir']).trim();
  const privateRoot = fs.realpathSync(
    path.isAbsolute(commonValue)
      ? commonValue
      : path.resolve(repository, commonValue),
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(repository, 'workflow/config.json'), 'utf8'),
  ) as { runtimeDirectory: string };
  const refPath = path.join(
    privateRoot,
    config.runtimeDirectory,
    investigationManifestPublicationNamespace(lifecycle),
    'current.json',
  );
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(
    refPath,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'investigation-manifest-current',
      ...lifecycle,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest:
        manifest.investigationApproval.investigationTargetDigest,
      manifestPath: `openspec/changes/${manifest.changeId}/investigation.json`,
    })}\n`,
  );
}

export function refreshFixturePlanReview(repository: string): void {
  const changeId = 'demo-change';
  const changeRoot = path.join(repository, 'openspec/changes', changeId);
  const contract = loadChangeContract(repository, changeId);
  const context = deriveInvestigationFirstPlanningSubject(repository, contract);
  const applicabilityNode = context.applicabilityNode;
  const assignment = {
    role: 'plan-reviewer' as const,
    providerId: 'claude' as const,
    sessionId: 'fixture-current-plan-review-session',
    targetDigest: context.subject.subjectDigest,
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
      fs.readFileSync(path.join(changeRoot, relativePath)),
    ]),
  );
  const materializationNode = createEvidenceNode({
    type: 'propose-exemption-planning-materialization',
    nodeSchema: 'fixture.propose-exemption-planning-materialization.v1',
    evaluator: 'fixture.propose-exemption-planning-materialization.v1',
    policyDigest: context.policies.reviewPolicyDigest,
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
    subject: context.subject,
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
          nodeId: applicabilityNode.nodeId,
          resultDigest: applicabilityNode.resultDigest,
        },
      ],
    },
    findings: [],
    proposedTerms: [],
    suggestions: [],
    residualRisk: 'The fixture grant claims remain subject to aggregate CI.',
    uncertainty: 'The fixture uses a structured planning exemption.',
  };
  const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
    subject: context.subject,
    assignment,
    submission,
    targetSnapshotNode,
    policyDigest: context.policies.reviewPolicyDigest,
    invocationId: 'fixture-current-plan-review-invocation',
    runtimeObservation: 'current',
  });
  const providerResultNode = createPlanReviewProviderResultNode({
    subject: context.subject,
    assignment,
    request: providerEvidence.request,
    result: providerEvidence.result,
    targetSnapshotNode,
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
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
  fs.writeFileSync(
    path.join(changeRoot, 'plan-review.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'plan-review-artifact',
      changeId,
      nodes: [targetSnapshotNode, providerResultNode, reviewNode].sort(
        (left, right) => left.nodeId.localeCompare(right.nodeId),
      ),
      currentRefs: { planReview: reviewNode.nodeId },
      roleResults: [roleResult],
    })}\n`,
  );
}
