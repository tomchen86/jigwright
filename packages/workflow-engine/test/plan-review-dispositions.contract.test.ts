import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import {
  createPlanReviewDispositionNode,
  createPlanReviewNode,
  createPlanReviewSubject,
  readPlanReviewDispositionNode,
  readPlanReviewNode,
} from '../src/modules/assurance/plan-review.ts';
import { validatePlanReview } from '../src/modules/assurance/plan-review-validation.ts';
import { createPlanTarget } from '../src/modules/assurance/plan-target.ts';
import { createPlanningGeneration } from '../src/modules/lifecycle/planning-generation.ts';
import {
  DIGESTS,
  planTargetInput,
  generationInput,
  reviewContext,
  providerResultFor,
  challengeSubmission,
  suggestion,
  currentValidationInput,
  authoredComponent,
  isWorkflowError,
} from './plan-review-contract-fixture.ts';

test('advisory verdict never replaces hard currentness and disposition gates', () => {
  const context = reviewContext();
  const submission = challengeSubmission({
    suggestions: [
      suggestion('Document a later migration'),
      suggestion('Document a later migration'),
      suggestion('Add a future dashboard'),
    ],
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, submission),
    submission,
  });
  const review = readPlanReviewNode(reviewNode);
  const challengeId = review.findings.find(
    ({ kind }) => kind === 'challenge',
  )!.findingId;
  const dispositionNode = createPlanReviewDispositionNode({
    reviewNode,
    policyDigest: DIGESTS.reviewPolicy,
    dispositions: [
      {
        challengeId,
        decision: 'rejected',
        rationale: 'The cited consumer is intentionally outside this change.',
        author: 'main-agent',
      },
    ],
  });

  const result = validatePlanReview({
    ...currentValidationInput(context, reviewNode),
    dispositionNode,
  });
  assert.equal(result.current, true);
  assert.equal(result.eligible, true);
  assert.equal(result.advisoryVerdict, 'advisory-reject');
  assert.equal(result.undispositionedChallengeIds.length, 0);
  assert.deepEqual(
    result.intakeCandidates.map(({ summary }) => summary),
    ['Add a future dashboard', 'Document a later migration'],
  );
  assert.equal(JSON.stringify(result).includes('issueId'), false);

  const missing = validatePlanReview({
    ...currentValidationInput(context, reviewNode),
    dispositionNode: null,
  });
  assert.equal(missing.current, true);
  assert.equal(missing.eligible, false);
  assert.deepEqual(missing.undispositionedChallengeIds, [challengeId]);

  const changedTargetInput = planTargetInput();
  authoredComponent(changedTargetInput, 'proposal').content +=
    '\nThe governing plan changed.\n';
  const changedTarget = createPlanTarget(changedTargetInput);
  const changedGeneration = createPlanningGeneration(
    generationInput(changedTarget),
  );
  const staleSubject = createPlanReviewSubject({
    generation: changedGeneration,
    reviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'session-independent',
  });
  const staleContext = {
    target: changedTarget,
    generation: changedGeneration,
    subject: staleSubject,
  };
  const stale = validatePlanReview({
    ...currentValidationInput(staleContext, reviewNode),
    dispositionNode,
  });
  assert.equal(stale.current, false);
  assert.equal(stale.eligible, false);
  assert.ok(stale.staleReasons.includes('PLAN_TARGET_MISMATCH'));
  assert.deepEqual(stale.intakeCandidates, []);

  const changedManifestGeneration = createPlanningGeneration({
    ...generationInput(context.target),
    manifestDigest: 'f'.repeat(64),
  });
  const staleManifest = validatePlanReview({
    ...currentValidationInput(
      {
        target: context.target,
        generation: changedManifestGeneration,
        subject: context.subject,
      },
      reviewNode,
    ),
    dispositionNode,
  });
  assert.equal(staleManifest.current, false);
  assert.equal(staleManifest.eligible, false);
  assert.ok(
    staleManifest.staleReasons.includes('PLANNING_GENERATION_MISMATCH'),
  );
  assert.ok(
    staleManifest.staleReasons.includes('INVESTIGATION_DEPENDENCY_MISMATCH'),
  );
});

test('stored PlanReview and dispositions replay their exact evaluator bindings', () => {
  const context = reviewContext();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: challengeSubmission(),
  });
  const forgedReviewNode = createEvidenceNode({
    type: reviewNode.type,
    nodeSchema: reviewNode.nodeSchema,
    evaluator: reviewNode.evaluator,
    policyDigest: reviewNode.policyDigest,
    exactInputDigests: { subject: context.subject.subjectDigest },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: reviewNode.outputSchema,
    output: reviewNode.output,
    runtimeMetadata: {},
  });
  assert.throws(
    () => readPlanReviewNode(forgedReviewNode),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: context.subject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: challengeSubmission({
          proposedTerms: [{ kind: 'symbol', value: 'UnobservedTerm' }],
        }),
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const challengeId = readPlanReviewNode(reviewNode).findings[0]!.findingId;
  const dispositionNode = createPlanReviewDispositionNode({
    reviewNode,
    policyDigest: DIGESTS.reviewPolicy,
    dispositions: [
      {
        challengeId,
        decision: 'mitigated',
        rationale: 'The plan now covers the cited consumer.',
        author: 'main-agent',
      },
    ],
  });
  const forgedDispositionNode = createEvidenceNode({
    type: dispositionNode.type,
    nodeSchema: dispositionNode.nodeSchema,
    evaluator: dispositionNode.evaluator,
    policyDigest: dispositionNode.policyDigest,
    exactInputDigests: { dispositions: 'f'.repeat(64) },
    semanticParentResultDigests: dispositionNode.semanticParentResultDigests,
    provenanceParentNodeIds: dispositionNode.provenanceParentNodeIds,
    outputSchema: dispositionNode.outputSchema,
    output: dispositionNode.output,
    runtimeMetadata: {},
  });
  assert.throws(
    () => readPlanReviewDispositionNode(forgedDispositionNode),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
});

test('review validation rejects policy substitution, unknown dispositions, and uncited graph identities', () => {
  const context = reviewContext();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: challengeSubmission(),
  });
  const challengeId = readPlanReviewNode(reviewNode).findings[0]!.findingId;
  const dispositionNode = createPlanReviewDispositionNode({
    reviewNode,
    policyDigest: DIGESTS.reviewPolicy,
    dispositions: [
      {
        challengeId,
        decision: 'mitigated',
        rationale: 'The exact subject now accounts for the challenge.',
        author: 'main-agent',
      },
    ],
  });
  const substitutedPolicyReview = createEvidenceNode({
    type: reviewNode.type,
    nodeSchema: reviewNode.nodeSchema,
    evaluator: reviewNode.evaluator,
    policyDigest: 'f'.repeat(64),
    exactInputDigests: reviewNode.exactInputDigests,
    semanticParentResultDigests: reviewNode.semanticParentResultDigests,
    provenanceParentNodeIds: reviewNode.provenanceParentNodeIds,
    outputSchema: reviewNode.outputSchema,
    output: reviewNode.output,
    runtimeMetadata: {},
  });
  const substituted = validatePlanReview({
    ...currentValidationInput(context, substitutedPolicyReview),
    dispositionNode: null,
  });
  assert.equal(substituted.current, false);
  assert.ok(substituted.staleReasons.includes('REVIEW_NODE_POLICY_MISMATCH'));

  const unknownDispositionNode = createEvidenceNode({
    type: 'plan-review-disposition',
    nodeSchema: 'plan-review-disposition.v1',
    evaluator: 'plan-review-disposition.v1',
    policyDigest: DIGESTS.reviewPolicy,
    exactInputDigests: { dispositions: '1'.repeat(64) },
    semanticParentResultDigests: { review: reviewNode.resultDigest },
    provenanceParentNodeIds: { review: reviewNode.nodeId },
    outputSchema: 'plan-review-disposition-output.v1',
    output: {
      schemaVersion: 1,
      dispositions: [
        {
          challengeId,
          decision: 'mitigated',
          rationale: 'Known challenge.',
          author: 'main-agent',
        },
        {
          challengeId: 'e'.repeat(64),
          decision: 'accepted',
          rationale: 'Unknown challenge must not be ignored.',
          author: 'main-agent',
        },
      ].sort((left, right) => (left.challengeId < right.challengeId ? -1 : 1)),
    },
    runtimeMetadata: {},
  });
  assert.throws(
    () =>
      validatePlanReview({
        ...currentValidationInput(context, reviewNode),
        dispositionNode: unknownDispositionNode,
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const uncited = challengeSubmission();
  uncited.findings[0]!.evidence = [
    {
      kind: 'investigation-node',
      nodeId: 'e'.repeat(64),
      resultDigest: 'f'.repeat(64),
    },
  ];
  assert.throws(
    () => providerResultFor(context, uncited),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  assert.equal(dispositionNode.type, 'plan-review-disposition');
});

test('review eligibility uses admitted role assurance and resolves repository citations', () => {
  const context = reviewContext();
  const submission = challengeSubmission();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission,
  });
  const admitted = validatePlanReview(
    currentValidationInput(context, reviewNode),
  );
  assert.equal(admitted.current, true);
  assert.equal(admitted.eligible, true);
  assert.equal(admitted.achievedIndependence, 'provider-independent');
  assert.equal(admitted.roleResultForm, 'ordinary-provider');
  assert.equal(admitted.orchestration, 'engine-spawned-provider');
  assert.equal(admitted.degradationAuthorized, false);

  const missingLocation = validatePlanReview({
    ...currentValidationInput(context, reviewNode),
    repositoryEvidence: {
      tree: context.subject.investigationBaseline.tree,
      locations: [],
    },
  });
  assert.equal(missingLocation.current, false);
  assert.equal(missingLocation.eligible, false);
  assert.ok(
    missingLocation.staleReasons.includes('REPOSITORY_EVIDENCE_MISMATCH'),
  );

  const outOfRange = validatePlanReview({
    ...currentValidationInput(context, reviewNode),
    repositoryEvidence: {
      tree: context.subject.investigationBaseline.tree,
      locations: [
        {
          path: 'src/consumer.ts',
          blobOid: 'c'.repeat(
            context.subject.investigationBaseline.tree.length,
          ),
          lineCount: 11,
        },
      ],
    },
  });
  assert.equal(outOfRange.current, false);
  assert.equal(outOfRange.eligible, false);
  assert.ok(outOfRange.staleReasons.includes('REPOSITORY_EVIDENCE_MISMATCH'));
});
