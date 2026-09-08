import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import { parsePlanReviewArtifact } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  assertCurrentPlanReviewProviderResultNode,
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  planReviewSubmissionDigest,
  readPlanReviewTargetSnapshotNode,
} from '../src/modules/assurance/plan-review.ts';
import type { ProviderProcessResult } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { createCurrentPlanReviewProviderEvidenceForTest } from './fixture.ts';
import {
  DIGESTS,
  reviewContext,
  challengeSubmission,
  admittedRoleAuthorization,
  isWorkflowError,
} from './plan-review-contract-fixture.ts';

test('provider results require an immutable target snapshot binding', () => {
  const context = reviewContext();
  const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
    subject: context.subject,
    assignment: context.assignment,
    submission: challengeSubmission(),
    targetSnapshotNode: context.targetSnapshotNode,
    policyDigest: DIGESTS.reviewPolicy,
    runtimeObservation: 'current',
  });
  assert.throws(
    () =>
      createPlanReviewProviderResultNode({
        subject: context.subject,
        assignment: context.assignment,
        request: providerEvidence.request,
        result: providerEvidence.result,
      } as Parameters<typeof createPlanReviewProviderResultNode>[0]),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const fakeSnapshotNode = createEvidenceNode({
    type: 'plan-review-target-snapshot',
    nodeSchema: 'test.fake-target-snapshot.v1',
    evaluator: 'test.fake-target-snapshot.v1',
    policyDigest: DIGESTS.reviewPolicy,
    exactInputDigests: { subject: context.subject.subjectDigest },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'test.fake-target-snapshot-output.v1',
    output: { noArtifacts: true },
    runtimeMetadata: {},
  });
  const fakeTargetEvidence = createCurrentPlanReviewProviderEvidenceForTest({
    subject: context.subject,
    assignment: context.assignment,
    submission: challengeSubmission(),
    targetSnapshotNode: fakeSnapshotNode,
    policyDigest: DIGESTS.reviewPolicy,
    runtimeObservation: 'current',
  });
  assert.throws(
    () =>
      createPlanReviewProviderResultNode({
        subject: context.subject,
        assignment: context.assignment,
        request: fakeTargetEvidence.request,
        result: fakeTargetEvidence.result,
        targetSnapshotNode: fakeSnapshotNode,
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
});

test('current provider results bind the exact request, invocation, and admitted content', () => {
  const context = reviewContext();
  const roleResult = admittedRoleAuthorization(
    context.providerResult,
  ).roleResult;
  assert.equal(
    assertCurrentPlanReviewProviderResultNode(
      context.providerResult,
      roleResult.providerInvocation,
      roleResult.content,
      planReviewSubmissionDigest(challengeSubmission()),
    ).nodeId,
    context.providerResult.nodeId,
  );

  assert.throws(
    () =>
      assertCurrentPlanReviewProviderResultNode(
        context.providerResult,
        {
          ...roleResult.providerInvocation,
          outputDigest: 'f'.repeat(64),
        },
        roleResult.content,
        planReviewSubmissionDigest(challengeSubmission()),
      ),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
  assert.throws(
    () =>
      assertCurrentPlanReviewProviderResultNode(
        context.providerResult,
        roleResult.providerInvocation,
        {
          ...roleResult.content,
          nodeId: 'f'.repeat(64),
        },
        planReviewSubmissionDigest(challengeSubmission()),
      ),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const currentProviderOutput = context.providerResult.output as Record<
    string,
    unknown
  > & { result: ProviderProcessResult };
  const nullRuntimeProviderResult = createEvidenceNode({
    type: context.providerResult.type,
    nodeSchema: context.providerResult.nodeSchema,
    evaluator: context.providerResult.evaluator,
    policyDigest: context.providerResult.policyDigest,
    exactInputDigests: {
      ...context.providerResult.exactInputDigests,
      runtimeObservation: crypto
        .createHash('sha256')
        .update(canonicalJson(null))
        .digest('hex'),
    },
    semanticParentResultDigests:
      context.providerResult.semanticParentResultDigests,
    provenanceParentNodeIds: context.providerResult.provenanceParentNodeIds,
    outputSchema: context.providerResult.outputSchema,
    output: {
      ...currentProviderOutput,
      result: {
        ...currentProviderOutput.result,
        runtimeObservation: null,
      },
    },
    runtimeMetadata: context.providerResult.runtimeMetadata,
  });
  assert.throws(
    () =>
      assertCurrentPlanReviewProviderResultNode(
        nullRuntimeProviderResult,
        null,
        {
          ...roleResult.content,
          nodeId: nullRuntimeProviderResult.nodeId,
          resultDigest: nullRuntimeProviderResult.resultDigest,
          contentDigest: nullRuntimeProviderResult.resultDigest,
        },
        planReviewSubmissionDigest(challengeSubmission()),
      ),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const alternatePolicyNode = createEvidenceNode({
    type: context.providerResult.type,
    nodeSchema: context.providerResult.nodeSchema,
    evaluator: context.providerResult.evaluator,
    policyDigest: 'f'.repeat(64),
    exactInputDigests: context.providerResult.exactInputDigests,
    semanticParentResultDigests:
      context.providerResult.semanticParentResultDigests,
    provenanceParentNodeIds: context.providerResult.provenanceParentNodeIds,
    outputSchema: context.providerResult.outputSchema,
    output: context.providerResult.output,
    runtimeMetadata: context.providerResult.runtimeMetadata,
  });
  assert.throws(
    () =>
      assertCurrentPlanReviewProviderResultNode(
        alternatePolicyNode,
        roleResult.providerInvocation,
        {
          ...roleResult.content,
          nodeId: alternatePolicyNode.nodeId,
          resultDigest: alternatePolicyNode.resultDigest,
          contentDigest: alternatePolicyNode.resultDigest,
          policyDigest: alternatePolicyNode.policyDigest,
        },
        planReviewSubmissionDigest(challengeSubmission()),
      ),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
});

test('tracked PlanReview rejects a recomputed alternate-policy target snapshot', () => {
  const context = reviewContext();
  const alternateTargetSnapshot = createEvidenceNode({
    type: context.targetSnapshotNode.type,
    nodeSchema: context.targetSnapshotNode.nodeSchema,
    evaluator: context.targetSnapshotNode.evaluator,
    policyDigest: 'f'.repeat(64),
    exactInputDigests: context.targetSnapshotNode.exactInputDigests,
    semanticParentResultDigests:
      context.targetSnapshotNode.semanticParentResultDigests,
    provenanceParentNodeIds: context.targetSnapshotNode.provenanceParentNodeIds,
    outputSchema: context.targetSnapshotNode.outputSchema,
    output: context.targetSnapshotNode.output,
    runtimeMetadata: context.targetSnapshotNode.runtimeMetadata,
  });
  const alternateProviderResult = createEvidenceNode({
    type: context.providerResult.type,
    nodeSchema: context.providerResult.nodeSchema,
    evaluator: context.providerResult.evaluator,
    policyDigest: context.providerResult.policyDigest,
    exactInputDigests: {
      ...context.providerResult.exactInputDigests,
      targetSnapshot: alternateTargetSnapshot.nodeId,
    },
    semanticParentResultDigests: {
      targetSnapshot: alternateTargetSnapshot.resultDigest,
    },
    provenanceParentNodeIds: {
      targetSnapshot: alternateTargetSnapshot.nodeId,
    },
    outputSchema: context.providerResult.outputSchema,
    output: context.providerResult.output,
    runtimeMetadata: context.providerResult.runtimeMetadata,
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: alternateProviderResult,
    submission: challengeSubmission(),
  });
  const roleResult = admittedRoleAuthorization(
    alternateProviderResult,
  ).roleResult;
  assert.throws(
    () =>
      parsePlanReviewArtifact(
        {
          schemaVersion: 1,
          kind: 'plan-review-artifact',
          changeId: 'demo-change',
          nodes: [
            alternateTargetSnapshot,
            alternateProviderResult,
            reviewNode,
          ].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
          currentRefs: { planReview: reviewNode.nodeId },
          roleResults: [roleResult],
        },
        'demo-change',
      ),
    (error) => isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
  );
});

test('PlanReview target snapshots reject the retired legacy-migration mode', () => {
  const currentNode = reviewContext().targetSnapshotNode;
  const currentSnapshot = readPlanReviewTargetSnapshotNode(currentNode);
  assert.equal(currentSnapshot.migration.legacyMigration, false);
  assert.equal(currentSnapshot.migration.guardSemanticDigest, null);

  const legacySnapshot = structuredClone(currentSnapshot);
  (
    legacySnapshot.migration as unknown as {
      legacyMigration: boolean;
    }
  ).legacyMigration = true;
  const {
    schemaVersion: _schemaVersion,
    snapshotDigest: _snapshotDigest,
    ...legacyFields
  } = legacySnapshot;
  legacySnapshot.snapshotDigest = crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        schema: 'workflow.plan-review-target-snapshot.v1',
        ...legacyFields,
      }),
    )
    .digest('hex');
  const legacyNode = createEvidenceNode({
    type: currentNode.type,
    nodeSchema: currentNode.nodeSchema,
    evaluator: currentNode.evaluator,
    policyDigest: currentNode.policyDigest,
    exactInputDigests: {
      ...currentNode.exactInputDigests,
      migration: crypto
        .createHash('sha256')
        .update(canonicalJson(legacySnapshot.migration))
        .digest('hex'),
    },
    semanticParentResultDigests: currentNode.semanticParentResultDigests,
    provenanceParentNodeIds: currentNode.provenanceParentNodeIds,
    outputSchema: currentNode.outputSchema,
    output: legacySnapshot,
    runtimeMetadata: currentNode.runtimeMetadata,
  });

  assert.throws(
    () => readPlanReviewTargetSnapshotNode(legacyNode),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID'),
  );
});
