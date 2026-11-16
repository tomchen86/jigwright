import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
} from '../src/foundation/evidence-node/evidence-node.ts';
import {
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
} from '../src/composition-root/propose-production.ts';
import { readPlanReviewNode } from '../src/modules/assurance/plan-review.ts';
import { admitRoleResult } from '../src/composition-root/role-admission-production.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderRunnerReport,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { git, isWorkflowError } from './fixture.ts';
import {
  planReviewCoverageEvidence,
  fakeRunnerReport,
  snapshotFileTree,
  sha256,
} from './investigation-session-fixture.ts';
import { createSecondReplannedProposeFixture } from './investigation-propose-flow-fixture.ts';

test('requires current review evidence and authorized dispositions before commit', async (t) => {
  let {
    repository,
    reviewAuthority,
    changeId,
    adapterPolicyPath,
    adapterPolicyBytes,
    changeDirectory,
    reviewerRuntime,
    twiceReplanned,
    twiceRevisedInvestigation,
  } = createSecondReplannedProposeFixture();
  try {
    const requiredCoverageEvidence = planReviewCoverageEvidence(
      twiceRevisedInvestigation,
    );

    runProviderWorker(repository, twiceReplanned.planReview!.invocationId, {
      runner(input): ProviderRunnerReport {
        return fakeRunnerReport(
          input.request,
          {
            verdict: 'advisory-approve' as const,
            scopeEvidence: [
              {
                kind: 'repository-location' as const,
                path: 'src/investigation-target.ts',
                line: 4,
                observation:
                  'The reviewer-only term is now represented in the tracked target.',
              },
              ...requiredCoverageEvidence.filter(
                ({ path: targetPath }) =>
                  targetPath !== 'src/investigation-target.ts',
              ),
            ],
            findings: [
              {
                severity: 'medium' as const,
                category: 'missing-scope',
                summary:
                  'Confirm the adjacent provider worker remains covered.',
                evidence: [
                  {
                    kind: 'repository-location' as const,
                    path: 'src/investigation-target.ts',
                    line: 4,
                    observation:
                      'The reviewer-only term is now represented in the tracked target.',
                  },
                  ...requiredCoverageEvidence.filter(
                    ({ path: targetPath }) =>
                      targetPath !== 'src/investigation-target.ts',
                  ),
                ],
              },
            ],
            proposedTerms: [],
            suggestions: [],
            residualRisk:
              'The exact review cannot prove semantic breadth completeness.',
            uncertainty:
              'The provider is observed read-only but not same-user confined.',
          },
          input.invocationDirectory,
        );
      },
    });

    const awaitingDisposition = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(
          repository,
          twiceReplanned.investigation!.investigationId,
        ),
      ),
    );

    assert.equal(awaitingDisposition.state, 'awaiting-challenge-dispositions');

    const planReviewPath = path.join(changeDirectory, 'plan-review.json');

    const trackedPlanReviewBytes = fs.readFileSync(planReviewPath);

    const trackedPlanReview = JSON.parse(trackedPlanReviewBytes.toString());

    const trackedReviewProviderResult = trackedPlanReview.nodes.find(
      (node: { type: string }) => node.type === 'plan-review-provider-result',
    );

    assert.equal(
      trackedReviewProviderResult.output.result.runtimeObservation.assurance,
      'unchanged-governed-projection',
    );

    assert.equal(
      trackedReviewProviderResult.output.result.runtimeObservation
        .sameUserProcessConfined,
      false,
    );

    assert.match(
      trackedReviewProviderResult.output.result.runtimeObservation.executable
        .sha256,
      /^[0-9a-f]{64}$/,
    );

    assert.deepEqual(
      trackedReviewProviderResult.output.result.runtimeObservation.residuals,
      PROVIDER_RUNNER_RESIDUALS,
    );

    const reviewNode = trackedPlanReview.nodes.find(
      (node: { type: string }) => node.type === 'plan-review',
    );

    const trackedRoleResult = trackedPlanReview.roleResults[0];

    assert.equal(trackedRoleResult.form, 'ordinary-provider');

    const relabeledProviderResult = createEvidenceNode({
      type: 'retired-plan-review-provider-result',
      nodeSchema: trackedReviewProviderResult.nodeSchema,
      evaluator: trackedReviewProviderResult.evaluator,
      policyDigest: trackedReviewProviderResult.policyDigest,
      exactInputDigests: trackedReviewProviderResult.exactInputDigests,
      semanticParentResultDigests:
        trackedReviewProviderResult.semanticParentResultDigests,
      provenanceParentNodeIds:
        trackedReviewProviderResult.provenanceParentNodeIds,
      outputSchema: trackedReviewProviderResult.outputSchema,
      output: trackedReviewProviderResult.output,
      runtimeMetadata: trackedReviewProviderResult.runtimeMetadata,
    });

    const relabeledReviewNode = createEvidenceNode({
      type: reviewNode.type,
      nodeSchema: reviewNode.nodeSchema,
      evaluator: reviewNode.evaluator,
      policyDigest: reviewNode.policyDigest,
      exactInputDigests: reviewNode.exactInputDigests,
      semanticParentResultDigests: {
        ...reviewNode.semanticParentResultDigests,
        providerResult: relabeledProviderResult.resultDigest,
      },
      provenanceParentNodeIds: {
        ...reviewNode.provenanceParentNodeIds,
        providerResult: relabeledProviderResult.nodeId,
      },
      outputSchema: reviewNode.outputSchema,
      output: reviewNode.output,
      runtimeMetadata: reviewNode.runtimeMetadata,
    });

    const relabeledRoleResult = admitRoleResult({
      assignment: trackedRoleResult.assignment,
      author: trackedRoleResult.author,
      participant: trackedRoleResult.participant,
      content: {
        ...trackedRoleResult.content,
        nodeId: relabeledProviderResult.nodeId,
        resultDigest: relabeledProviderResult.resultDigest,
        contentDigest: relabeledProviderResult.resultDigest,
      },
      providerInvocation: trackedRoleResult.providerInvocation,
      grantUse: null,
      grantValidation: null,
    });

    const relabeledArtifact = {
      ...trackedPlanReview,
      nodes: trackedPlanReview.nodes
        .map((node: EvidenceNode) =>
          node.nodeId === trackedReviewProviderResult.nodeId
            ? relabeledProviderResult
            : node.nodeId === reviewNode.nodeId
              ? relabeledReviewNode
              : node,
        )
        .sort((left: EvidenceNode, right: EvidenceNode) =>
          left.nodeId.localeCompare(right.nodeId),
        ),
      currentRefs: {
        ...trackedPlanReview.currentRefs,
        planReview: relabeledReviewNode.nodeId,
      },
      roleResults: [relabeledRoleResult],
    };

    fs.writeFileSync(
      planReviewPath,
      `${canonicalJson(relabeledArtifact)}\n`,
      'utf8',
    );

    const relabeledArtifactBytes = fs.readFileSync(planReviewPath);

    const relabeledGitState = {
      head: git(repository, ['rev-parse', 'HEAD']),
      tree: git(repository, ['rev-parse', 'HEAD^{tree}']),
      status: git(repository, ['status', '--porcelain=v2', '-z']),
    };

    const relabeledRuntimeState = snapshotFileTree(reviewerRuntime.root);

    try {
      await t.test(
        'tracked PlanReview follows the authoritative review edge and rejects a digest-consistent relabeled provider result without mutation',
        () => {
          assert.throws(
            () =>
              getProposeStatus(
                repository,
                twiceReplanned.investigation!.investigationId,
              ),
            (error: unknown) =>
              isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
          );
          assert.deepEqual(
            fs.readFileSync(planReviewPath),
            relabeledArtifactBytes,
          );
          assert.deepEqual(
            {
              head: git(repository, ['rev-parse', 'HEAD']),
              tree: git(repository, ['rev-parse', 'HEAD^{tree}']),
              status: git(repository, ['status', '--porcelain=v2', '-z']),
            },
            relabeledGitState,
          );
          assert.deepEqual(
            snapshotFileTree(reviewerRuntime.root),
            relabeledRuntimeState,
          );
        },
      );
    } finally {
      fs.writeFileSync(planReviewPath, trackedPlanReviewBytes);
    }

    const retiredProviderResult = createEvidenceNode({
      type: trackedReviewProviderResult.type,
      nodeSchema: trackedReviewProviderResult.nodeSchema,
      evaluator: trackedReviewProviderResult.evaluator,
      policyDigest: trackedReviewProviderResult.policyDigest,
      semanticParentResultDigests:
        trackedReviewProviderResult.semanticParentResultDigests,
      provenanceParentNodeIds:
        trackedReviewProviderResult.provenanceParentNodeIds,
      outputSchema: trackedReviewProviderResult.outputSchema,
      output: {
        ...trackedReviewProviderResult.output,
        result: {
          ...trackedReviewProviderResult.output.result,
          runtimeObservation: null,
        },
      },
      runtimeMetadata: trackedReviewProviderResult.runtimeMetadata,
      exactInputDigests: {
        ...trackedReviewProviderResult.exactInputDigests,
        runtimeObservation: crypto
          .createHash('sha256')
          .update(canonicalJson(null))
          .digest('hex'),
      },
    });

    const retiredReviewNode = createEvidenceNode({
      type: reviewNode.type,
      nodeSchema: reviewNode.nodeSchema,
      evaluator: reviewNode.evaluator,
      policyDigest: reviewNode.policyDigest,
      exactInputDigests: reviewNode.exactInputDigests,
      semanticParentResultDigests: {
        ...reviewNode.semanticParentResultDigests,
        providerResult: retiredProviderResult.resultDigest,
      },
      provenanceParentNodeIds: {
        ...reviewNode.provenanceParentNodeIds,
        providerResult: retiredProviderResult.nodeId,
      },
      outputSchema: reviewNode.outputSchema,
      output: reviewNode.output,
      runtimeMetadata: reviewNode.runtimeMetadata,
    });

    const retiredRoleResult = admitRoleResult({
      assignment: trackedRoleResult.assignment,
      author: trackedRoleResult.author,
      participant: trackedRoleResult.participant,
      content: {
        ...trackedRoleResult.content,
        nodeId: retiredProviderResult.nodeId,
        resultDigest: retiredProviderResult.resultDigest,
        contentDigest: retiredProviderResult.resultDigest,
      },
      providerInvocation: trackedRoleResult.providerInvocation,
      grantUse: null,
      grantValidation: null,
    });

    const retiredArtifact = {
      ...trackedPlanReview,
      nodes: trackedPlanReview.nodes
        .map((node: EvidenceNode) =>
          node.nodeId === trackedReviewProviderResult.nodeId
            ? retiredProviderResult
            : node.nodeId === reviewNode.nodeId
              ? retiredReviewNode
              : node,
        )
        .sort((left: EvidenceNode, right: EvidenceNode) =>
          left.nodeId.localeCompare(right.nodeId),
        ),
      currentRefs: {
        ...trackedPlanReview.currentRefs,
        planReview: retiredReviewNode.nodeId,
      },
      roleResults: [retiredRoleResult],
    };

    fs.writeFileSync(
      planReviewPath,
      `${canonicalJson(retiredArtifact)}\n`,
      'utf8',
    );

    const rejectedArtifactBytes = fs.readFileSync(planReviewPath);

    const rejectedGitState = {
      head: git(repository, ['rev-parse', 'HEAD']),
      tree: git(repository, ['rev-parse', 'HEAD^{tree}']),
      status: git(repository, ['status', '--porcelain=v2', '-z']),
    };

    const rejectedRuntimeState = snapshotFileTree(reviewerRuntime.root);

    try {
      await t.test(
        'tracked PlanReview rejects a digest-consistent provider result with retired null runtime observation without mutation',
        () => {
          assert.throws(
            () =>
              getProposeStatus(
                repository,
                twiceReplanned.investigation!.investigationId,
              ),
            (error: unknown) =>
              isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
          );
          assert.deepEqual(
            fs.readFileSync(planReviewPath),
            rejectedArtifactBytes,
          );
          assert.deepEqual(
            {
              head: git(repository, ['rev-parse', 'HEAD']),
              tree: git(repository, ['rev-parse', 'HEAD^{tree}']),
              status: git(repository, ['status', '--porcelain=v2', '-z']),
            },
            rejectedGitState,
          );
          assert.deepEqual(
            snapshotFileTree(reviewerRuntime.root),
            rejectedRuntimeState,
          );
        },
      );
    } finally {
      fs.writeFileSync(planReviewPath, trackedPlanReviewBytes);
    }

    const challengeId = readPlanReviewNode(reviewNode).findings[0]!.findingId;

    const dispositions = [
      {
        challengeId,
        decision: 'rebutted' as const,
        rationale:
          'The exact provider worker path and its registered test are in the plan.',
        author: reviewAuthority.identity,
        supersededBy: null,
      },
    ];

    const reauthoredRoleResult = admitRoleResult({
      assignment: trackedRoleResult.assignment,
      author: {
        ...trackedRoleResult.author,
        principalId: 're-authored-plan-review',
      },
      participant: trackedRoleResult.participant,
      content: trackedRoleResult.content,
      providerInvocation: trackedRoleResult.providerInvocation,
      grantUse: null,
      grantValidation: null,
    });

    const reauthoredArtifact = {
      ...trackedPlanReview,
      roleResults: [reauthoredRoleResult],
    };

    fs.writeFileSync(
      planReviewPath,
      `${canonicalJson(reauthoredArtifact)}\n`,
      'utf8',
    );

    const reauthoredArtifactBytes = fs.readFileSync(planReviewPath);

    const reauthoredGitState = {
      head: git(repository, ['rev-parse', 'HEAD']),
      tree: git(repository, ['rev-parse', 'HEAD^{tree}']),
      status: git(repository, ['status', '--porcelain=v2', '-z']),
    };

    const reauthoredRuntimeState = snapshotFileTree(reviewerRuntime.root);

    let dispositionSignatureCalls = 0;

    try {
      await t.test(
        'challenge closure rejects a digest-consistent re-authored role result before signing or mutation',
        () => {
          assert.throws(
            () =>
              resumePropose(
                repository,
                changeId,
                createPlanReviewDispositionsEnvelope(
                  awaitingDisposition,
                  dispositions,
                ),
                {
                  challengeDispositionAuthority: {
                    now: new Date('2026-08-10T00:00:00.000Z'),
                    role: 'reviewer',
                    signer: {
                      ...reviewAuthority.signer,
                      sign(payload, namespace) {
                        dispositionSignatureCalls += 1;
                        return reviewAuthority.signer.sign(payload, namespace);
                      },
                    },
                  },
                },
              ),
            (error: unknown) => isWorkflowError(error, 'PROPOSE_INPUT_STALE'),
          );
          assert.equal(dispositionSignatureCalls, 0);
          assert.deepEqual(
            fs.readFileSync(planReviewPath),
            reauthoredArtifactBytes,
          );
          assert.deepEqual(
            {
              head: git(repository, ['rev-parse', 'HEAD']),
              tree: git(repository, ['rev-parse', 'HEAD^{tree}']),
              status: git(repository, ['status', '--porcelain=v2', '-z']),
            },
            reauthoredGitState,
          );
          assert.deepEqual(
            snapshotFileTree(reviewerRuntime.root),
            reauthoredRuntimeState,
          );
        },
      );
    } finally {
      fs.writeFileSync(planReviewPath, trackedPlanReviewBytes);
    }

    fs.writeFileSync(adapterPolicyPath, adapterPolicyBytes);

    const completedPlanning = resumePropose(
      repository,
      changeId,
      createPlanReviewDispositionsEnvelope(awaitingDisposition, dispositions),
      {
        challengeDispositionAuthority: {
          now: new Date('2026-08-10T00:00:00.000Z'),
          role: 'reviewer',
          signer: reviewAuthority.signer,
        },
      },
    );

    assert.equal(completedPlanning.state, 'planning-complete');

    assert.equal(completedPlanning.planningTransition?.changeId, changeId);

    const committedTrackedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    );

    assert.equal(committedTrackedInvestigation.schemaVersion, 3);

    const committedContract = loadChangeContract(repository, changeId);

    assert.equal(committedContract.investigation?.manifest.schemaVersion, 3);

    assert.equal(
      committedContract.investigation?.validation.manifestDigest,
      committedTrackedInvestigation.manifestDigest,
    );

    assert.equal(
      committedContract.investigation?.validation.investigationTargetDigest,
      committedTrackedInvestigation.investigationApproval
        .investigationTargetDigest,
    );

    assert.equal(
      git(repository, [
        'log',
        '-1',
        '--format=%(trailers:key=Transition,valueonly)',
      ]).trim(),
      'plan',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
