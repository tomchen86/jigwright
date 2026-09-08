import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import {
  createPlanReviewNode,
  createPlanReviewTargetSnapshotNode,
  createPlanReviewSubject,
  assertPlanReviewSubject,
  planReviewSubjectDigest,
} from '../src/modules/assurance/plan-review.ts';
import { createPlanTarget } from '../src/modules/assurance/plan-target.ts';
import {
  createPlanningGeneration,
  type PlanningGeneration,
} from '../src/modules/lifecycle/planning-generation.ts';
import {
  DIGESTS,
  planTargetInput,
  generationInput,
  reviewContext,
  challengeSubmission,
  isWorkflowError,
} from './plan-review-contract-fixture.ts';

test('planning generation is immutable and changes only with governing inputs', () => {
  const firstInput = generationInput(createPlanTarget(planTargetInput()));
  const generation = createPlanningGeneration(firstInput);
  const reordered = generationInput(
    createPlanTarget({
      ...planTargetInput(),
      components: [...planTargetInput().components].reverse(),
    }),
  );
  reordered.investigationDependencies.reverse();
  assert.equal(
    createPlanningGeneration(reordered).planningGenerationId,
    generation.planningGenerationId,
  );

  firstInput.investigationDependencies[0]!.resultDigest = 'f'.repeat(64);
  assert.notEqual(
    firstInput.investigationDependencies[0]!.resultDigest,
    generation.investigationDependencies[0]!.resultDigest,
  );
  assert.equal(Object.isFrozen(generation), true);
  assert.equal(Object.isFrozen(generation.investigationDependencies), true);

  for (const mutate of [
    (input: ReturnType<typeof generationInput>) => {
      input.investigationBaseline.tree = 'c'.repeat(40);
    },
    (input: ReturnType<typeof generationInput>) => {
      input.investigationDependencies[0]!.resultDigest = 'd'.repeat(64);
    },
    (input: ReturnType<typeof generationInput>) => {
      input.policies.reviewPolicyDigest = 'e'.repeat(64);
    },
  ]) {
    const changed = generationInput(createPlanTarget(planTargetInput()));
    mutate(changed);
    assert.notEqual(
      createPlanningGeneration(changed).planningGenerationId,
      generation.planningGenerationId,
    );
  }
});

test('planning generation and review subject bind exact v3 Manifest identities', () => {
  const target = createPlanTarget(planTargetInput());
  const input = {
    ...generationInput(target),
    manifestDigest: 'a'.repeat(64),
    investigationTargetDigest: 'b'.repeat(64),
  };
  const generation = createPlanningGeneration(input);
  assert.equal(generation.manifestDigest, input.manifestDigest);
  assert.equal(
    generation.investigationTargetDigest,
    input.investigationTargetDigest,
  );

  const changedManifest = createPlanningGeneration({
    ...input,
    manifestDigest: 'c'.repeat(64),
  });
  const changedTarget = createPlanningGeneration({
    ...input,
    investigationTargetDigest: 'd'.repeat(64),
  });
  assert.notEqual(
    changedManifest.planningGenerationId,
    generation.planningGenerationId,
  );
  assert.notEqual(
    changedTarget.planningGenerationId,
    generation.planningGenerationId,
  );

  const subject = createPlanReviewSubject({
    generation,
    reviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'session-independent',
  });
  assert.equal(subject.manifestDigest, input.manifestDigest);
  assert.equal(
    subject.investigationTargetDigest,
    input.investigationTargetDigest,
  );

  for (const mutate of [
    (stale: typeof subject) => {
      stale.manifestDigest = 'e'.repeat(64);
    },
    (stale: typeof subject) => {
      stale.investigationTargetDigest = 'f'.repeat(64);
    },
    (stale: typeof subject) => {
      const requirement = stale.investigationRequirements[0]!;
      assert.equal('text' in requirement, true);
      if ('text' in requirement) {
        requirement.text = 'Silently replace the investigation requirement.';
      }
    },
  ]) {
    const stale = structuredClone(subject);
    mutate(stale);
    assert.throws(
      () => assertPlanReviewSubject(stale),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
    );
  }
});

test('planning generation and review subjects recompute rather than trust caller digests', () => {
  const target = createPlanTarget(planTargetInput());
  const forgedTarget = structuredClone(target);
  forgedTarget.components[0]!.componentDigest = 'f'.repeat(64);
  assert.throws(
    () => createPlanningGeneration(generationInput(forgedTarget)),
    (error) => isWorkflowError(error, 'PLANNING_GENERATION_INVALID'),
  );

  for (const [headLength, treeLength] of [
    [40, 64],
    [64, 40],
  ] as const) {
    const mixedBaseline = generationInput(target);
    mixedBaseline.investigationBaseline.head = 'a'.repeat(headLength);
    mixedBaseline.investigationBaseline.tree = 'b'.repeat(treeLength);
    assert.throws(
      () => createPlanningGeneration(mixedBaseline),
      (error) => isWorkflowError(error, 'PLANNING_GENERATION_INVALID'),
    );
  }
  const sha256Baseline = generationInput(target);
  sha256Baseline.investigationBaseline.head = 'a'.repeat(64);
  sha256Baseline.investigationBaseline.tree = 'b'.repeat(64);
  assert.equal(
    createPlanningGeneration(sha256Baseline).investigationBaseline.head.length,
    64,
  );

  const generation = createPlanningGeneration(generationInput(target));
  const forgedGeneration = structuredClone(generation);
  forgedGeneration.targetDigest = 'e'.repeat(64);
  assert.throws(
    () =>
      createPlanReviewSubject({
        generation: forgedGeneration,
        reviewPolicyDigest: DIGESTS.reviewPolicy,
        requiredIndependence: 'session-independent',
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
  const context = reviewContext();
  const mixedSubject = structuredClone(context.subject);
  mixedSubject.investigationBaseline.tree = 'f'.repeat(64);
  mixedSubject.subjectDigest = planReviewSubjectDigest(mixedSubject);
  const mixedMaterialization = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'test.mixed-baseline-materialization.v1',
    evaluator: 'test.mixed-baseline-materialization.v1',
    policyDigest: DIGESTS.reviewPolicy,
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'test.mixed-baseline-materialization-output.v1',
    output: { testOnly: true },
    runtimeMetadata: {},
  });
  assert.throws(
    () =>
      createPlanReviewTargetSnapshotNode({
        changeId: 'demo-change',
        changePrefix: 'openspec/changes/demo-change',
        subject: mixedSubject,
        materializationNode: mixedMaterialization,
        artifacts: new Map([['proposal.md', Buffer.from('# Proposal\n')]]),
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
  const reverseMixedSubject = structuredClone(context.subject);
  reverseMixedSubject.investigationBaseline.head = 'e'.repeat(64);
  reverseMixedSubject.subjectDigest =
    planReviewSubjectDigest(reverseMixedSubject);
  assert.throws(
    () =>
      createPlanReviewTargetSnapshotNode({
        changeId: 'demo-change',
        changePrefix: 'openspec/changes/demo-change',
        subject: reverseMixedSubject,
        materializationNode: mixedMaterialization,
        artifacts: new Map([['proposal.md', Buffer.from('# Proposal\n')]]),
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
  const forgedSubject = structuredClone(context.subject);
  forgedSubject.planTargetDigest = 'd'.repeat(64);
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: forgedSubject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: challengeSubmission(),
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const wrongSchemaSubject = structuredClone(context.subject);
  wrongSchemaSubject.schemaVersion = 2 as 1;
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: wrongSchemaSubject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: challengeSubmission(),
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  const accessorInput = {
    reviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'session-independent' as const,
  } as {
    generation: PlanningGeneration;
    reviewPolicyDigest: string;
    requiredIndependence: 'session-independent';
  };
  Object.defineProperty(accessorInput, 'generation', {
    enumerable: true,
    get() {
      throw new Error('caller accessor must not execute');
    },
  });
  assert.throws(
    () => createPlanReviewSubject(accessorInput),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
});
