import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEvidenceNode,
  type EvidenceNode,
} from '../src/adapters/planning/investigation/evidence-node.ts';
import { parsePlanReviewArtifact } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  projectPlanReviewTerms,
  type PlanReviewTermProjection,
} from '../src/modules/projection/investigation-term-projection.ts';
import {
  assertCurrentPlanReviewProviderResultNode,
  createPlanReviewDispositionNode,
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  createPlanReviewTargetSnapshotNode,
  createPlanReviewSubject,
  assertPlanReviewSubject,
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  canonicalizePlanReviewProviderSubmission,
  planReviewProviderSubmission,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  planReviewSubmissionDigest,
  planReviewSubjectDigest,
  readPlanReviewTargetSnapshotNode,
  readPlanReviewDispositionNode,
  readPlanReviewNode,
  type PlanReviewReport,
  type PlanReviewSubmission,
} from '../src/modules/assurance/plan-review.ts';
import { validatePlanReview } from '../src/modules/assurance/plan-review-validation.ts';
import {
  resolvePlanReviewPlanningEvidence,
  resolvePlanReviewRepositoryEvidence,
} from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  assertInvestigationPlanReviewCoverageRequirementSatisfied,
  buildGlobalPlanReviewCoverageRequirement,
  GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
} from '../src/modules/assurance/plan-review-coverage.ts';
import {
  createPlanTarget,
  type PlanTarget,
  type PlanTargetInput,
} from '../src/modules/assurance/plan-target.ts';
import {
  createPlanningGeneration,
  type PlanningGeneration,
} from '../src/modules/lifecycle/planning-generation.ts';
import {
  admitRoleResult,
  type RoleAssignment,
} from '../src/modules/provider-orchestration/role-scheduler.ts';
import type {
  ProviderInvocationRequest,
  ProviderProcessResult,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  createCurrentPlanReviewProviderEvidenceForTest,
  createFixtureRepository,
  git,
} from './fixture.ts';

const DIGESTS = {
  schema: '1'.repeat(64),
  structured: '2'.repeat(64),
  ledgerRenderer: '3'.repeat(64),
  whyNode: '4'.repeat(64),
  whyResult: '5'.repeat(64),
  workflowPolicy: '6'.repeat(64),
  canonicalizerPolicy: '7'.repeat(64),
  rendererPolicy: '8'.repeat(64),
  reviewPolicy: '9'.repeat(64),
  investigationNode: 'a'.repeat(64),
  investigationResult: 'b'.repeat(64),
} as const;

const providerResultsById = new Map<string, EvidenceNode>();
const targetSnapshotsById = new Map<string, EvidenceNode>();

test('PlanReview challenge authority uses the Jigwright product identity', () => {
  assert.equal(
    PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
    'jigwright.plan-review-challenge-closure.v1',
  );
});

test('v3 authoring builds global PlanReview coverage as a direct payload', () => {
  const requirement = buildGlobalPlanReviewCoverageRequirement({
    investigationId: 'investigation-v3',
    changeId: 'change-v3',
    baseline: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
    coverageTier: 'standard',
    sealedSamplingSeed: 'c'.repeat(64),
    targets: [
      {
        source: 'planned-mutation',
        path: 'src/a.ts',
        targetDigest: `sha256:${'d'.repeat(64)}`,
        stratum: 'planned-mutation',
        reusedFromLedger: false,
        subjectId: null,
        ledgerEntryId: null,
        invariants: ['Preserve A.'],
        riskFactors: ['planned-mutation'],
        freshness: 'missing-ledger-entry',
        evidenceMode: 'full-blob',
        degradedExtraction: false,
        cost: { rawBytes: 128, reviewUnits: 1 },
      },
    ],
    semanticReuse: {
      schemaVersion: 1,
      kind: 'semantic-reuse-coverage',
      owedCount: 1,
      carriedCount: 0,
      carried: [],
      resolutions: [],
      reviewTargets: [
        {
          targetId: 'domain-test-target',
          stratum: 'planned-mutation',
          reusedFromLedger: false,
        },
      ],
    },
  });

  assert.equal(requirement.schemaVersion, 2);
  assert.equal(requirement.activation, 'global');
  assert.equal(
    requirement.coveragePolicyDigest,
    GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
  );
  assert.deepEqual(requirement.costProfile, {
    targetCount: 1,
    rawBytes: 128,
    reviewUnits: 1,
  });
  assert.equal(requirement.targetBindings[0]?.path, 'src/a.ts');

  assert.throws(
    () =>
      assertInvestigationPlanReviewCoverageRequirementSatisfied({
        repositoryRoot: process.cwd(),
        requirement: {
          kind: 'plan-review-coverage-requirement',
          requirementId: 'plan-review-coverage',
          coverage: requirement,
          semanticAuthor: {
            id: 'investigation-reviewer',
            provenance: 'checkpoint:plan-review-coverage',
          },
          provenanceDigest: 'e'.repeat(64),
        },
        review: {} as PlanReviewReport,
        expectedInvestigationId: 'another-investigation',
        expectedChangeId: 'change-v3',
        expectedBaseline: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
      }),
    (error) => isWorkflowError(error, 'REVIEW_COVERAGE_REQUIREMENT_INVALID'),
  );
});

test('plan review v2 requires finding severity, residual risk, and explicit uncertainty', () => {
  assert.equal(PLAN_REVIEW_OUTPUT_SCHEMA.version, 3);
  assert.equal(PLAN_REVIEW_OUTPUT_VALIDATOR.version, 3);

  const missingResidualRisk = providerSubmission();
  delete missingResidualRisk.residualRisk;
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(missingResidualRisk),
    false,
  );

  const invalidSeverity = providerSubmission() as unknown as {
    findings: Array<Record<string, unknown>>;
  };
  invalidSeverity.findings[0]!.severity = 'urgent';
  assert.equal(PLAN_REVIEW_OUTPUT_VALIDATOR.validate(invalidSeverity), false);
  assert.equal(PLAN_REVIEW_OUTPUT_VALIDATOR.validate(providerSubmission()), true);

  // A canonical submission is not a provider submission: the fields it carries
  // beyond the authored ones are exactly the ones a provider must not restate.
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(challengeSubmission()),
    false,
  );
});

test('plan review rejects structurally incomplete or invented admitted-result assurance', () => {
  const context = reviewContext();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: challengeSubmission(),
  });
  const admitted = admittedRoleAuthorization(context.providerResult).roleResult;

  for (const mutate of [
    (value: Record<string, unknown>) => delete value.achievedIndependence,
    (value: Record<string, unknown>) => {
      value.orchestration = 'model-claimed';
      return true;
    },
  ]) {
    const malformed = structuredClone(admitted) as unknown as Record<
      string,
      unknown
    >;
    mutate(malformed);
    const input = currentValidationInput(context, reviewNode) as unknown as {
      independenceAuthorization: unknown;
    };
    input.independenceAuthorization = {
      kind: 'admitted-role-result',
      roleResult: malformed,
    };
    assert.throws(
      () => validatePlanReview(input as never),
      (error) =>
        error instanceof WorkflowError && error.code === 'PLAN_REVIEW_INVALID',
    );
  }
});

test('plan review rejects retired caller-authored provider independence', () => {
  const context = reviewContext();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: challengeSubmission(),
  });

  assert.throws(
    () =>
      validatePlanReview({
        ...currentValidationInput(context, reviewNode),
        independenceAuthorization: {
          kind: 'ordinary-provider-independent',
          planAuthorProviderId: 'codex',
        },
      } as never),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
});

test('plan review validation requires the current immutable planning target and evidence pair', () => {
  const context = reviewContext();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: challengeSubmission(),
  });
  const planningTarget = readPlanReviewTargetSnapshotNode(
    context.targetSnapshotNode,
  );
  const current = {
    ...currentValidationInput(context, reviewNode),
    planningTarget,
    planningEvidence: {
      snapshotDigest: planningTarget.snapshotDigest,
      locations: [],
    },
  };

  for (const missingKey of ['planningTarget', 'planningEvidence'] as const) {
    const incomplete = structuredClone(current);
    delete incomplete[missingKey];
    assert.throws(
      () => validatePlanReview(incomplete as never),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
    );
  }
});

test('plan target canonicalizes only enumerated component semantics', () => {
  const original = createPlanTarget(planTargetInput());

  const reorderedStructured = planTargetInput();
  structuredComponent(reorderedStructured, 'guard').value = {
    tasks: { '1.1': { requiredChecks: ['fixture'], allowedPaths: ['src/**'] } },
    changeId: 'demo-change',
    schemaVersion: 1,
  };
  assert.equal(
    createPlanTarget(reorderedStructured).targetDigest,
    original.targetDigest,
  );

  const crlf = planTargetInput();
  authoredComponent(crlf, 'proposal').content = authoredComponent(
    crlf,
    'proposal',
  ).content.replaceAll('\n', '\r\n');
  assert.equal(createPlanTarget(crlf).targetDigest, original.targetDigest);

  const checked = planTargetInput();
  tasksComponent(checked).content = tasksComponent(checked).content.replace(
    '- [ ] 1.1',
    '- [x] 1.1',
  );
  assert.equal(createPlanTarget(checked).targetDigest, original.targetDigest);

  for (const mutate of [
    (input: PlanTargetInput) => {
      authoredComponent(input, 'proposal').content =
        '# Proposal\n\nDo not preserve the behavior.\n';
    },
    (input: PlanTargetInput) => {
      tasksComponent(input).content =
        '# Tasks changed\n\n## Work\n\n- [ ] 1.1 Implement behavior\n';
    },
    (input: PlanTargetInput) => {
      mixedComponent(input).authoredRegions[0] = '# Design changed\n\n';
    },
    (input: PlanTargetInput) => {
      mixedComponent(input).managedProjection.sourceNodes[0]!.resultDigest =
        'c'.repeat(64);
    },
    (input: PlanTargetInput) => {
      mixedComponent(input).managedProjection.rendererDigest = 'd'.repeat(64);
    },
    (input: PlanTargetInput) => {
      policyComponent(input, 'review-policy').digest = 'e'.repeat(64);
    },
  ]) {
    const changed = planTargetInput();
    mutate(changed);
    assert.notEqual(
      createPlanTarget(changed).targetDigest,
      original.targetDigest,
    );
  }
});

test('plan target normalizes only managed task checkboxes and supports complete multi-clause specs', () => {
  const unchecked = planTargetInput();
  tasksComponent(unchecked).content +=
    '\n## Notes\n\n- [ ] Ordinary authored checklist\n';
  const checkedAuthoredChecklist = structuredClone(unchecked);
  tasksComponent(checkedAuthoredChecklist).content = tasksComponent(
    checkedAuthoredChecklist,
  ).content.replace(
    '- [ ] Ordinary authored checklist',
    '- [x] Ordinary authored checklist',
  );
  assert.notEqual(
    createPlanTarget(unchecked).targetDigest,
    createPlanTarget(checkedAuthoredChecklist).targetDigest,
  );

  const multipleClauses = planTargetInput();
  multipleClauses.components.push({
    kind: 'requirement-clause',
    role: 'requirement-clause',
    path: 'openspec/changes/demo-change/specs/demo/spec.md',
    requirement: 'Demo',
    scenario: 'Also works',
    content:
      '#### Scenario: Also works\n\n- **WHEN** another path runs\n- **THEN** it works\n',
  });
  const target = createPlanTarget(multipleClauses);
  assert.equal(
    target.components.filter(
      ({ role, path }) =>
        role === 'requirement-clause' &&
        path === 'openspec/changes/demo-change/specs/demo/spec.md',
    ).length,
    2,
  );

  const traversal = planTargetInput();
  authoredComponent(traversal, 'proposal').path = '../outside.md';
  assert.throws(
    () => createPlanTarget(traversal),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );
});

test('mixed target dependencies are order-insensitive and reject duplicate identities', () => {
  const first = planTargetInput();
  mixedComponent(first).managedProjection.sourceNodes.push({
    nodeId: 'c'.repeat(64),
    resultDigest: 'd'.repeat(64),
  });
  const reversed = structuredClone(first);
  mixedComponent(reversed).managedProjection.sourceNodes.reverse();
  assert.equal(
    createPlanTarget(first).targetDigest,
    createPlanTarget(reversed).targetDigest,
  );

  const duplicate = structuredClone(first);
  mixedComponent(duplicate).managedProjection.sourceNodes.push(
    structuredClone(
      mixedComponent(duplicate).managedProjection.sourceNodes[0]!,
    ),
  );
  assert.throws(
    () => createPlanTarget(duplicate),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );

  const unicodePaths = planTargetInput();
  unicodePaths.components.push(
    {
      kind: 'policy',
      role: 'policy',
      path: 'workflow/\u00e9-policy',
      name: 'composed-policy',
      version: 1,
      digest: 'c'.repeat(64),
    },
    {
      kind: 'policy',
      role: 'policy',
      path: 'workflow/e\u0301-policy',
      name: 'decomposed-policy',
      version: 1,
      digest: 'd'.repeat(64),
    },
  );
  const reversedUnicodePaths = structuredClone(unicodePaths);
  reversedUnicodePaths.components.reverse();
  assert.equal(
    createPlanTarget(unicodePaths).targetDigest,
    createPlanTarget(reversedUnicodePaths).targetDigest,
  );
});

test('structured target semantics exclude only code-owned runtime metadata', () => {
  const first = planTargetInput();
  structuredComponent(first, 'investigation').value = {
    schemaVersion: 1,
    kind: 'investigation-artifact',
    currentRefs: { sealedInvestigation: DIGESTS.investigationNode },
    nodes: [
      {
        nodeId: DIGESTS.investigationNode,
        resultDigest: DIGESTS.investigationResult,
        runtimeMetadata: {
          elapsedMs: 10,
          pid: 123,
          displayOrder: 1,
        },
      },
    ],
  };
  const runtimeChanged = structuredClone(first);
  const runtimeNode = (
    structuredComponent(runtimeChanged, 'investigation').value as {
      nodes: Array<{ runtimeMetadata: Record<string, number> }>;
    }
  ).nodes[0]!;
  runtimeNode.runtimeMetadata = {
    elapsedMs: 999,
    pid: 456,
    displayOrder: 2,
  };
  assert.equal(
    createPlanTarget(first).targetDigest,
    createPlanTarget(runtimeChanged).targetDigest,
  );

  const semanticChanged = structuredClone(first);
  (
    structuredComponent(semanticChanged, 'investigation').value as {
      currentRefs: { sealedInvestigation: string };
    }
  ).currentRefs.sealedInvestigation = 'f'.repeat(64);
  assert.notEqual(
    createPlanTarget(first).targetDigest,
    createPlanTarget(semanticChanged).targetDigest,
  );
});

test('plan target enforces exact typed closure, ordering, and review exclusion', () => {
  const input = planTargetInput();
  input.components.reverse();
  const target = createPlanTarget(input);

  assert.deepEqual(
    target.components.map(({ role, path }) => [role, path]),
    [...target.components]
      .sort((left, right) =>
        `${left.role}\0${left.path}`.localeCompare(
          `${right.role}\0${right.path}`,
        ),
      )
      .map(({ role, path }) => [role, path]),
  );
  assert.equal(
    target.components.some(({ path }) => path.endsWith('plan-review.json')),
    false,
  );
  assert.equal(JSON.stringify(target).includes('runtimeMetadata'), false);
  assert.equal(Object.isFrozen(target), true);
  assert.equal(Object.isFrozen(target.components), true);

  const missing = planTargetInput();
  missing.components = missing.components.filter(
    (component) => component.role !== 'design',
  );
  assert.throws(
    () => createPlanTarget(missing),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );

  const duplicate = planTargetInput();
  duplicate.components.push(
    structuredClone(authoredComponent(duplicate, 'proposal')),
  );
  assert.throws(
    () => createPlanTarget(duplicate),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );

  const review = planTargetInput();
  review.components.push({
    kind: 'structured-json',
    role: 'plan-review',
    path: 'openspec/changes/demo-change/plan-review.json',
    schemaDigest: DIGESTS.structured,
    value: {},
  } as never);
  assert.throws(
    () => createPlanTarget(review),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );
});

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

test('PlanReview requires complete coverage and evidence-bound challenge or no-challenge', () => {
  const context = reviewContext();
  const challengeNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: challengeSubmission(),
  });
  const challenge = readPlanReviewNode(challengeNode);
  assert.equal(challenge.findings.length, 1);
  assert.match(challenge.findings[0]!.findingId, /^[0-9a-f]{64}$/);
  assert.deepEqual(challenge.coverage, PLAN_REVIEW_COVERAGE);
  assert.equal(Object.isFrozen(challenge), true);

  const noChallenge = challengeSubmission();
  noChallenge.verdict = 'advisory-approve';
  noChallenge.scopeAssessment = {
    kind: 'no-challenge',
    evidence: [
      {
        kind: 'investigation-role-result',
        role: 'reviewer-pre-anchor',
        requestDigest: DIGESTS.investigationNode,
        resultDigest: DIGESTS.investigationResult,
      } as never,
    ],
  };
  noChallenge.findings = [];
  assert.equal(
    readPlanReviewNode(
      createPlanReviewNode({
        subject: context.subject,
        assignment: context.assignment,
        providerResultNode: providerResultFor(context, noChallenge),
        submission: noChallenge,
      }),
    ).scopeAssessment.kind,
    'no-challenge',
  );

  const scopeChallengeMissing = challengeSubmission();
  scopeChallengeMissing.findings[0] = {
    ...scopeChallengeMissing.findings[0]!,
    category: 'weak-why',
  };
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: context.subject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: scopeChallengeMissing,
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );

  for (const mutate of [
    (submission: PlanReviewSubmission) => {
      submission.coverage = submission.coverage.slice(1);
    },
    (submission: PlanReviewSubmission) => {
      submission.scopeAssessment = { kind: 'no-challenge', evidence: [] };
      submission.findings = [];
    },
    (submission: PlanReviewSubmission) => {
      submission.findings[0]!.evidence = [];
    },
    (submission: PlanReviewSubmission) => {
      submission.findings[0]!.evidence = [
        {
          kind: 'repository-location',
          path: 'src/consumer.ts',
          line: 0,
          observation: 'invalid line',
        },
      ];
    },
    (submission: PlanReviewSubmission) => {
      submission.findings[0]!.evidence = [
        {
          kind: 'repository-location',
          path: '../outside.ts',
          line: 1,
          observation: 'Traversal is not repository evidence.',
        },
      ];
    },
  ]) {
    const invalid = challengeSubmission();
    mutate(invalid);
    assert.throws(
      () =>
        createPlanReviewNode({
          subject: context.subject,
          assignment: context.assignment,
          providerResultNode: context.providerResult,
          submission: invalid,
        }),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
    );
  }
});

test('PlanReview preserves strengthened and exact-Grant independence labels', () => {
  const context = reviewContext();
  const submission = challengeSubmission();
  const assignments = [
    {
      ...context.assignment,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    },
    {
      role: 'plan-reviewer' as const,
      providerId: 'codex' as const,
      sessionId: 'review-session-r007',
      targetDigest: context.subject.subjectDigest,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: 'session-independent' as const,
      authorityKind: 'role-context-sharing-grant.v1' as const,
      roleContextSharingGrantId: '12345678-1234-4123-8123-123456789abc',
      authorizedEffect: 'role-context-sharing-degradation' as const,
      exactRolePairs: ['author-reviewer'] as const,
      contextGeneration: 1,
      sessionGeneration: 1,
      sharedEngineSessionId: 'investigation-r007',
      providerDefinitionDigest: 'a'.repeat(64),
      reservationReceiptDigest: 'b'.repeat(64),
    },
  ];

  for (const [index, assignment] of assignments.entries()) {
    const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
      subject: context.subject,
      assignment,
      submission,
      targetSnapshotNode: context.targetSnapshotNode,
      policyDigest: DIGESTS.reviewPolicy,
      invocationId: `plan-review-strengthened-${index}`,
      runtimeObservation: 'current',
    });
    const providerResultNode = rememberProviderResult(
      createPlanReviewProviderResultNode({
        subject: context.subject,
        assignment,
        request: providerEvidence.request,
        result: providerEvidence.result,
        targetSnapshotNode: context.targetSnapshotNode,
      }),
      context.targetSnapshotNode,
    );
    const reviewNode = createPlanReviewNode({
      subject: context.subject,
      assignment,
      providerResultNode,
      submission,
    });
    const review = readPlanReviewNode(reviewNode);
    assert.equal(review.requiredIndependence, 'provider-independent');
    assert.equal(review.achievedIndependence, assignment.achievedIndependence);
    if (index === 0) {
      const validation = validatePlanReview({
        ...currentValidationInput(context, reviewNode),
        requiredIndependence: 'provider-independent',
      });
      assert.equal(validation.current, true);
      assert.equal(validation.eligible, true);
      assert.equal(validation.degradationAuthorized, false);
    }
  }
});

test('PlanReview scope assessment tracks only scope-category findings', () => {
  const scopeEvidence = [
    {
      kind: 'investigation-node' as const,
      nodeId: DIGESTS.investigationNode,
      resultDigest: DIGESTS.investigationResult,
    },
  ];

  // The scope assessment is read off the finding categories, so a provider has
  // no field in which to contradict it and every combination is submittable.
  const scoped = canonicalizePlanReviewProviderSubmission(
    providerSubmission({ scopeEvidence }),
  );
  assert.equal(scoped.scopeAssessment.kind, 'challenges');

  const contradictoryOnly = challengeSubmission();
  contradictoryOnly.findings[0] = {
    ...contradictoryOnly.findings[0]!,
    category: 'contradictory-artifacts',
    summary: 'Two planning artifacts assign incompatible completion work.',
  };
  const unscoped = canonicalizePlanReviewProviderSubmission(
    providerSubmission({ scopeEvidence }, contradictoryOnly),
  );
  assert.deepEqual(unscoped.scopeAssessment, {
    kind: 'no-challenge',
    evidence: scopeEvidence,
  });

  const missingConsumer = challengeSubmission();
  missingConsumer.findings[0] = {
    ...missingConsumer.findings[0]!,
    category: 'missing-consumers',
  };
  assert.equal(
    canonicalizePlanReviewProviderSubmission(
      providerSubmission({ scopeEvidence }, missingConsumer),
    ).scopeAssessment.kind,
    'challenges',
  );

  const mixed = challengeSubmission();
  mixed.findings.push(contradictoryOnly.findings[0]!);
  assert.equal(
    canonicalizePlanReviewProviderSubmission(
      providerSubmission({ scopeEvidence }, mixed),
    ).scopeAssessment.kind,
    'challenges',
  );

  // Scope evidence is always authored, so there is no cross-field rule to break.
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(providerSubmission({ scopeEvidence: [] })),
    false,
  );
});

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

test('reviewer terms enter only the fixed bounded projector with node provenance', () => {
  const context = reviewContext();
  const submission = challengeSubmission({
    proposedTerms: [
      { kind: 'symbol', value: 'SharedConsumer' },
      { kind: 'literal-path', value: 'src/shared.ts' },
    ],
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, submission),
    submission,
  });
  const validationInput = currentValidationInput(context, reviewNode);
  const projected = projectPlanReviewTerms({
    validationInput,
    existingContributions: [
      {
        source: 'main',
        reference: 'main-input',
        terms: [
          {
            kind: 'symbol',
            value: 'SharedConsumer',
            rationale: 'The main investigation identified the shared symbol.',
            expectedRelationship: 'Existing consumers import this symbol.',
          },
        ],
      },
    ],
  });
  assert.equal(projected.preview.outcome, 'ready');
  const shared = projected.preview.terms.find(
    ({ value }) => value === 'SharedConsumer',
  );
  assert.deepEqual(shared?.provenance, [
    {
      source: 'main',
      reference: 'main-input',
      rationale: 'The main investigation identified the shared symbol.',
      expectedRelationship: 'Existing consumers import this symbol.',
    },
    {
      source: 'reviewer',
      reference: reviewNode.nodeId,
      rationale: null,
      expectedRelationship: null,
    },
  ]);

  const broadSubmission = challengeSubmission({
    proposedTerms: Array.from({ length: 129 }, (_, index) => ({
      kind: 'symbol' as const,
      value: `review-term-${index}`,
    })),
  });
  const broadNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, broadSubmission),
    submission: broadSubmission,
  });
  const broad = projectPlanReviewTerms({
    validationInput: currentValidationInput(context, broadNode),
    existingContributions: [],
  });
  assert.equal(broad.preview.outcome, 'requires-narrowing');
  if (broad.preview.outcome === 'requires-narrowing') {
    assert.ok(
      broad.preview.violations.some(
        ({ code }) => code === 'REVIEWER_TERM_LIMIT_EXCEEDED',
      ),
    );
  }

  assert.throws(
    () =>
      projectPlanReviewTerms({
        validationInput,
        existingContributions: [
          {
            source: 'reviewer',
            reference: 'caller-injected',
            terms: [{ kind: 'symbol', value: 'Bypass' }],
          },
        ],
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_TERM_PROJECTION_INVALID'),
  );
  assert.deepEqual(
    Object.keys(projected).sort(),
    [
      'planTargetDigest',
      'planningGenerationId',
      'preview',
      'reviewNodeId',
      'reviewPolicyDigest',
      'reviewResultDigest',
      'subjectDigest',
    ].sort(),
  );

  const forgedGeneration = structuredClone(context.generation);
  forgedGeneration.planningGenerationId = 'f'.repeat(64);
  assert.throws(
    () =>
      projectPlanReviewTerms({
        validationInput: {
          ...validationInput,
          generation: forgedGeneration,
        },
        existingContributions: [],
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_TERM_PROJECTION_INVALID'),
  );
});

test('PlanReview output schema is code-owned and rejects generic semantic actions', () => {
  const context = reviewContext();
  const valid = challengeSubmission();
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: context.providerResult,
    submission: valid,
  });
  assert.match(PLAN_REVIEW_OUTPUT_SCHEMA.digest, /^[0-9a-f]{64}$/);
  assert.equal(PLAN_REVIEW_OUTPUT_VALIDATOR.id, PLAN_REVIEW_OUTPUT_SCHEMA.id);
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.version,
    PLAN_REVIEW_OUTPUT_SCHEMA.version,
  );
  assert.notEqual(reviewNode.outputSchema, PLAN_REVIEW_OUTPUT_SCHEMA.id);
  assert.equal(PLAN_REVIEW_OUTPUT_VALIDATOR.validate(providerSubmission()), true);
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(
      providerSubmission({
        proposals: [{ action: 'create-issue', title: 'Bypass' }],
      }),
    ),
    false,
  );
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(
      providerSubmission({
        verdict: 'advisory-approve',
        scopeEvidence: [
          {
            kind: 'repository-location',
            path: ' ',
            line: 1,
            observation: ' ',
          },
        ],
        findings: [],
      }),
    ),
    false,
  );
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(
      providerSubmission({
        proposedTerms: [{ kind: 'symbol', value: 'invalid\nterm' }],
      }),
    ),
    false,
  );
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate({
      ...valid,
      proposedTerms: Array.from({ length: 257 }, (_, index) => ({
        kind: 'symbol',
        value: `review-term-${index}`,
      })),
    }),
    false,
  );

  const requiredSuggestion = challengeSubmission();
  requiredSuggestion.findings[0] = {
    ...requiredSuggestion.findings[0]!,
    kind: 'suggestion',
    currentChangeImpact: 'required',
  };
  assert.throws(
    () =>
      createPlanReviewNode({
        subject: context.subject,
        assignment: context.assignment,
        providerResultNode: context.providerResult,
        submission: requiredSuggestion,
      }),
    (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
  );
});

function planTargetInput(): PlanTargetInput {
  return {
    schemaVersion: 1,
    changeId: 'demo-change',
    schemaName: 'expense-app-v2',
    components: [
      {
        kind: 'structured-json',
        role: 'schema-metadata',
        path: 'openspec/changes/demo-change/.openspec.yaml',
        schemaDigest: DIGESTS.schema,
        value: { schema: 'expense-app-v2', created: '2026-07-15' },
      },
      {
        kind: 'authored-markdown',
        role: 'proposal',
        path: 'openspec/changes/demo-change/proposal.md',
        content: '# Proposal\n\nPreserve the behavior.\n',
      },
      {
        kind: 'mixed-markdown',
        role: 'design',
        path: 'openspec/changes/demo-change/design.md',
        authoredRegions: [
          '# Design\n\n',
          '\n## Decisions\n\nKeep invariants.\n',
        ],
        managedProjection: {
          renderer: 'investigation-ledger.v1',
          rendererDigest: DIGESTS.ledgerRenderer,
          sourceNodes: [
            { nodeId: DIGESTS.whyNode, resultDigest: DIGESTS.whyResult },
          ],
        },
      },
      {
        kind: 'authored-markdown',
        role: 'delta-spec',
        path: 'openspec/changes/demo-change/specs/demo/spec.md',
        content:
          '### Requirement: Demo\n\nThe system SHALL work.\n\n#### Scenario: Works\n\n- **THEN** it works\n',
      },
      {
        kind: 'tasks-markdown',
        role: 'tasks',
        path: 'openspec/changes/demo-change/tasks.md',
        content: '# Tasks\n\n## Work\n\n- [ ] 1.1 Implement behavior\n',
      },
      {
        kind: 'structured-json',
        role: 'guard',
        path: 'openspec/changes/demo-change/guard.json',
        schemaDigest: DIGESTS.structured,
        value: {
          schemaVersion: 1,
          changeId: 'demo-change',
          tasks: {
            '1.1': {
              allowedPaths: ['src/**'],
              requiredChecks: ['fixture'],
            },
          },
        },
      },
      {
        kind: 'structured-json',
        role: 'execution',
        path: 'openspec/changes/demo-change/execution.json',
        schemaDigest: DIGESTS.structured,
        value: { schemaVersion: 1, kind: 'execution-artifact', tasks: {} },
      },
      {
        kind: 'structured-json',
        role: 'investigation',
        path: 'openspec/changes/demo-change/investigation.json',
        schemaDigest: DIGESTS.structured,
        value: {
          schemaVersion: 1,
          kind: 'investigation-artifact',
          currentRefs: { sealedInvestigation: DIGESTS.investigationNode },
        },
      },
      {
        kind: 'requirement-clause',
        role: 'requirement-clause',
        path: 'openspec/changes/demo-change/specs/demo/spec.md',
        requirement: 'Demo',
        scenario: 'Works',
        content:
          '### Requirement: Demo\n\nThe system SHALL work.\n\n#### Scenario: Works\n\n- **THEN** it works\n',
      },
      {
        kind: 'policy',
        role: 'policy',
        path: 'workflow/review-policy',
        name: 'review-policy',
        version: 1,
        digest: DIGESTS.reviewPolicy,
      },
    ],
  };
}

function generationInput(target: PlanTarget) {
  return {
    schemaVersion: 1 as const,
    target,
    manifestDigest: 'c'.repeat(64),
    investigationTargetDigest: 'd'.repeat(64),
    investigationBaseline: {
      head: '1'.repeat(40),
      tree: '2'.repeat(40),
    },
    investigationDependencies: [
      {
        role: 'reviewer-pre-anchor',
        nodeId: DIGESTS.investigationNode,
        resultDigest: DIGESTS.investigationResult,
      },
      {
        role: 'why-ledger',
        nodeId: DIGESTS.whyNode,
        resultDigest: DIGESTS.whyResult,
      },
    ],
    investigationRequirements: [
      {
        requirementId: 'preserve-demo-contract',
        text: 'Preserve the demo behavior contract.',
        semanticAuthor: {
          id: 'investigation-reviewer',
          provenance: 'review-session',
        },
        provenanceDigest: 'e'.repeat(64),
      },
    ],
    policies: {
      planningPolicyDigest: DIGESTS.workflowPolicy,
      canonicalizerPolicyDigest: DIGESTS.canonicalizerPolicy,
      rendererPolicyDigest: DIGESTS.rendererPolicy,
      reviewPolicyDigest: DIGESTS.reviewPolicy,
    },
  };
}

function reviewContext(): {
  target: PlanTarget;
  generation: PlanningGeneration;
  subject: ReturnType<typeof createPlanReviewSubject>;
  assignment: RoleAssignment;
  targetSnapshotNode: EvidenceNode;
  providerResult: EvidenceNode;
} {
  const target = createPlanTarget(planTargetInput());
  const generation = createPlanningGeneration(generationInput(target));
  const subject = createPlanReviewSubject({
    generation,
    reviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'session-independent',
  });
  const assignment: RoleAssignment = {
    role: 'plan-reviewer',
    providerId: 'claude',
    sessionId: 'review-session',
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'session-independent',
    achievedIndependence: 'provider-independent',
  };
  const materializationNode = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'test.review-context-materialization.v1',
    evaluator: 'test.review-context-materialization.v1',
    policyDigest: DIGESTS.reviewPolicy,
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'test.review-context-materialization-output.v1',
    output: { testOnly: true },
    runtimeMetadata: {},
  });
  const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
    changeId: 'demo-change',
    changePrefix: 'openspec/changes/demo-change',
    subject,
    materializationNode,
    artifacts: new Map([
      ['proposal.md', Buffer.from('# Proposal\n\nPreserve the behavior.\n')],
    ]),
  });
  const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
    subject,
    assignment,
    submission: challengeSubmission(),
    targetSnapshotNode,
    policyDigest: DIGESTS.reviewPolicy,
    invocationId: 'plan-review-invocation',
    runtimeObservation: 'current',
  });
  const providerResult = rememberProviderResult(
    createPlanReviewProviderResultNode({
      subject,
      assignment,
      request: providerEvidence.request,
      result: providerEvidence.result,
      targetSnapshotNode,
    }),
    targetSnapshotNode,
  );
  return {
    target,
    generation,
    subject,
    assignment,
    targetSnapshotNode,
    providerResult,
  };
}

function providerResultFor(
  context: ReturnType<typeof reviewContext>,
  submission: PlanReviewSubmission,
): EvidenceNode {
  const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
    subject: context.subject,
    assignment: context.assignment,
    submission,
    targetSnapshotNode: context.targetSnapshotNode,
    policyDigest: DIGESTS.reviewPolicy,
    invocationId: `plan-review-${crypto
      .createHash('sha256')
      .update(canonicalJson(submission))
      .digest('hex')
      .slice(0, 16)}`,
    runtimeObservation: 'current',
  });
  return rememberProviderResult(
    createPlanReviewProviderResultNode({
      subject: context.subject,
      assignment: context.assignment,
      request: providerEvidence.request,
      result: providerEvidence.result,
      targetSnapshotNode: context.targetSnapshotNode,
    }),
    context.targetSnapshotNode,
  );
}

function rememberProviderResult(
  node: EvidenceNode,
  targetSnapshotNode: EvidenceNode,
): EvidenceNode {
  providerResultsById.set(node.nodeId, node);
  targetSnapshotsById.set(targetSnapshotNode.nodeId, targetSnapshotNode);
  return node;
}

function providerExecutionFromNode(node: EvidenceNode): {
  request: ProviderInvocationRequest;
  result: ProviderProcessResult;
} {
  return node.output as {
    request: ProviderInvocationRequest;
    result: ProviderProcessResult;
  };
}

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

function challengeSubmission(
  overrides: Partial<PlanReviewSubmission> = {},
): PlanReviewSubmission {
  return {
    schemaVersion: 2,
    verdict: 'advisory-reject',
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'challenges' },
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'missing-scope',
        currentChangeImpact: 'required',
        summary: 'A load-bearing consumer may be missing.',
        evidence: [
          {
            kind: 'repository-location',
            path: 'src/consumer.ts',
            line: 12,
            observation: 'The consumer imports the changed contract.',
          },
        ],
      },
    ],
    proposedTerms: [],
    suggestions: [],
    residualRisk: 'No residual risk beyond the documented challenge.',
    uncertainty: 'No additional uncertainty identified.',
    ...overrides,
  };
}

/**
 * What a provider actually writes: the canonical submission minus every field
 * the engine derives. Overrides land on the wire form so a test can express an
 * invalid provider submission that has no canonical counterpart.
 */
function providerSubmission(
  overrides: Record<string, unknown> = {},
  submission: PlanReviewSubmission = challengeSubmission(),
): Record<string, unknown> {
  return { ...planReviewProviderSubmission(submission), ...overrides };
}

function suggestion(summary: string) {
  return {
    kind: 'suggestion' as const,
    severity: 'low' as const,
    category: 'follow-up' as const,
    currentChangeImpact: 'independent-follow-up' as const,
    summary,
    evidence: [
      {
        kind: 'repository-location' as const,
        path: 'docs/ROADMAP.md',
        line: 1,
        observation: 'The follow-up belongs to later roadmap work.',
      },
    ],
  };
}

function currentValidationInput(
  context: Pick<
    ReturnType<typeof reviewContext>,
    'target' | 'generation' | 'subject'
  >,
  reviewNode: EvidenceNode,
) {
  const review = readPlanReviewNode(reviewNode);
  const providerResultNode = providerResultsById.get(
    review.providerResultNodeId,
  );
  if (
    providerResultNode === undefined ||
    providerResultNode.resultDigest !== review.providerResultResultDigest
  ) {
    throw new TypeError('Fixture PlanReview provider result is unavailable.');
  }
  const targetSnapshotNode = targetSnapshotsById.get(
    providerResultNode.provenanceParentNodeIds.targetSnapshot,
  );
  if (targetSnapshotNode === undefined) {
    throw new TypeError('Fixture PlanReview target snapshot is unavailable.');
  }
  const planningTarget = readPlanReviewTargetSnapshotNode(targetSnapshotNode);
  const challengeIds = review.findings
    .filter(({ kind }) => kind === 'challenge')
    .map(({ findingId }) => findingId);
  const dispositionNode =
    challengeIds.length === 0
      ? null
      : createPlanReviewDispositionNode({
          reviewNode,
          policyDigest: DIGESTS.reviewPolicy,
          dispositions: challengeIds.map((challengeId) => ({
            challengeId,
            decision: 'mitigated' as const,
            rationale: 'The planning subject now accounts for this finding.',
            author: 'main-agent',
          })),
        });
  return {
    reviewNode,
    providerResultNode,
    dispositionNode,
    subject: context.subject,
    generation: context.generation,
    target: context.target,
    expectedReviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'session-independent' as const,
    independenceAuthorization: admittedRoleAuthorization(providerResultNode),
    repositoryEvidence: repositoryEvidenceFor(
      reviewNode,
      context.subject.investigationBaseline.tree,
    ),
    planningTarget,
    planningEvidence: {
      snapshotDigest: planningTarget.snapshotDigest,
      locations: [],
    },
  };
}

function admittedRoleAuthorization(providerResultNode: EvidenceNode) {
  const { request, result } = providerExecutionFromNode(providerResultNode);
  return {
    kind: 'admitted-role-result' as const,
    roleResult: admitRoleResult({
      assignment: request.roleAssignment,
      author: {
        providerId: 'codex',
        sessionId: 'author-session',
        principalId: null,
        identityAssurance: 'runtime-hint',
        engineSpawned: false,
      },
      participant: {
        providerId: request.roleAssignment.providerId,
        sessionId: request.roleAssignment.sessionId,
        principalId: null,
        identityAssurance: 'adapter-assigned',
        engineSpawned: true,
      },
      content: {
        kind: 'plan-review',
        nodeId: providerResultNode.nodeId,
        resultDigest: providerResultNode.resultDigest,
        outputSchema: request.outputSchema,
        evaluator: request.evaluatorVersion,
        policyDigest: request.policyDigest,
        contentDigest: providerResultNode.resultDigest,
        current: true,
      },
      providerInvocation: {
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        outputDigest: result.outputDigest,
        providerId: request.providerId,
        sessionId: request.roleAssignment.sessionId,
        targetDigest: request.targetDigest,
        engineSpawned: true,
      },
      grantUse: null,
      grantValidation: null,
    }),
  };
}

function repositoryEvidenceFor(reviewNode: EvidenceNode, tree: string) {
  const review = readPlanReviewNode(reviewNode);
  const locations = [
    ...review.findings.flatMap(({ evidence }) => evidence),
    ...review.suggestions.flatMap(({ evidence }) => evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ]
    .filter(
      (
        evidence,
      ): evidence is Extract<
        (typeof review.findings)[number]['evidence'][number],
        { kind: 'repository-location' }
      > => evidence.kind === 'repository-location',
    )
    .reduce((entries, evidence) => {
      const current = entries.get(evidence.path);
      entries.set(evidence.path, Math.max(current ?? 0, evidence.line));
      return entries;
    }, new Map<string, number>());

  return {
    tree,
    locations: [...locations]
      .map(([path, lineCount]) => ({
        path,
        blobOid: 'c'.repeat(tree.length),
        lineCount,
      }))
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.path, 'utf8'),
          Buffer.from(right.path, 'utf8'),
        ),
      ),
  };
}

test('planning citation namespace is exact and rejects absent or out-of-range snapshot locations', () => {
  const context = reviewContext();
  const planningPath = 'openspec/changes/demo-change/proposal.md';
  const planningTarget = planningTargetFor(
    context,
    'proposal.md',
    '# Proposal\n\nPreserve the behavior.\n',
  );
  const planningArtifact = planningTarget.artifacts[0]!;
  const submission = challengeSubmission({
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'missing-scope',
        currentChangeImpact: 'required',
        summary: 'The exact planning proposal requires review.',
        evidence: [
          {
            kind: 'planning-location',
            path: planningPath,
            line: planningArtifact.lineCount,
            observation:
              'The immutable planning snapshot carries this requirement.',
          },
        ],
      },
    ],
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, submission),
    submission,
  });
  const input = currentValidationInput(context, reviewNode);
  const valid = validatePlanReview({
    ...input,
    planningTarget,
    planningEvidence: {
      snapshotDigest: planningTarget.snapshotDigest,
      locations: [
        {
          path: planningPath,
          sha256: planningArtifact.sha256,
          byteLength: planningArtifact.byteLength,
          lineCount: planningArtifact.lineCount,
        },
      ],
    },
  });
  assert.equal(valid.current, true);
  assert.equal(valid.eligible, true);

  for (const locations of [
    [],
    [
      {
        path: planningPath,
        sha256: 'f'.repeat(64),
        byteLength: 110,
        lineCount: 11,
      },
    ],
  ]) {
    const rejected = validatePlanReview({
      ...input,
      planningTarget,
      planningEvidence: {
        snapshotDigest: planningTarget.snapshotDigest,
        locations,
      },
    });
    assert.equal(rejected.current, false);
    assert.equal(rejected.eligible, false);
    assert.ok(rejected.staleReasons.includes('REPOSITORY_EVIDENCE_MISMATCH'));
  }
});

function planningTargetFor(
  context: ReturnType<typeof reviewContext>,
  relativePath: string,
  content: string,
) {
  const materializationNode = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'test.materialization.v1',
    evaluator: 'test.materialization.v1',
    policyDigest: DIGESTS.reviewPolicy,
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'test.materialization-output.v1',
    output: { testOnly: true },
    runtimeMetadata: {},
  });
  return readPlanReviewTargetSnapshotNode(
    createPlanReviewTargetSnapshotNode({
      changeId: 'demo-change',
      changePrefix: 'openspec/changes/demo-change',
      subject: context.subject,
      materializationNode,
      artifacts: new Map([[relativePath, Buffer.from(content, 'utf8')]]),
    }),
  );
}

test('repository-location cannot cite a planning snapshot member', () => {
  const context = reviewContext();
  const planningPath = 'openspec/changes/demo-change/proposal.md';
  const submission = challengeSubmission({
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'missing-scope',
        currentChangeImpact: 'required',
        summary: 'The exact planning proposal requires review.',
        evidence: [
          {
            kind: 'repository-location',
            path: planningPath,
            line: 1,
            observation: 'This deliberately uses the wrong namespace.',
          },
        ],
      },
    ],
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, submission),
    submission,
  });
  assert.throws(
    () =>
      resolvePlanReviewRepositoryEvidence(
        '/unused',
        'a'.repeat(40),
        reviewNode,
        {
          artifacts: [{ path: planningPath }],
        } as never,
      ),
    (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'),
  );
});

test('resolved review evidence uses canonical UTF-8 path ordering', () => {
  const repository = createFixtureRepository();
  const bmpPath = 'docs/\ue000.md';
  const astralPath = 'docs/\u{10000}.md';
  try {
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repository, bmpPath), 'BMP path\n');
    fs.writeFileSync(path.join(repository, astralPath), 'Astral path\n');
    git(repository, ['add', '--', bmpPath, astralPath]);
    git(repository, ['commit', '-m', 'Add Unicode evidence paths']);
    const tree = git(repository, ['rev-parse', 'HEAD^{tree}']).trim();
    const context = reviewContext();
    const submission = challengeSubmission({
      findings: [
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-scope',
          currentChangeImpact: 'required',
          summary: 'The BMP evidence path must remain canonical.',
          evidence: [
            {
              kind: 'repository-location',
              path: bmpPath,
              line: 1,
              observation: 'This path sorts first by UTF-8 bytes.',
            },
          ],
        },
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-consumers',
          currentChangeImpact: 'required',
          summary: 'The astral evidence path must remain canonical.',
          evidence: [
            {
              kind: 'repository-location',
              path: astralPath,
              line: 1,
              observation: 'This path sorts second by UTF-8 bytes.',
            },
          ],
        },
      ],
    });
    const reviewNode = createPlanReviewNode({
      subject: context.subject,
      assignment: context.assignment,
      providerResultNode: providerResultFor(context, submission),
      submission,
    });

    assert.deepEqual(
      resolvePlanReviewRepositoryEvidence(
        repository,
        tree,
        reviewNode,
      ).locations.map(({ path: evidencePath }) => evidencePath),
      [bmpPath, astralPath],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('resolved planning evidence uses canonical UTF-8 path ordering', () => {
  const repository = createFixtureRepository();
  const bmpRelative = '\ue000.md';
  const astralRelative = '\u{10000}.md';
  const changePrefix = 'openspec/changes/demo-change';
  const contents = new Map<string, Buffer>([
    ['.openspec.yaml', Buffer.from('schema: expense-app-v2\n')],
    [bmpRelative, Buffer.from('BMP path\n')],
    [astralRelative, Buffer.from('Astral path\n')],
  ]);
  try {
    const context = reviewContext();
    const materializationNode = createEvidenceNode({
      type: 'propose-planning-materialization',
      nodeSchema: 'test.utf8-materialization.v1',
      evaluator: 'test.utf8-materialization.v1',
      policyDigest: DIGESTS.reviewPolicy,
      exactInputDigests: {},
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'test.utf8-materialization-output.v1',
      output: { testOnly: true },
      runtimeMetadata: {},
    });
    const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
      changeId: 'demo-change',
      changePrefix,
      subject: context.subject,
      materializationNode,
      artifacts: contents,
    });
    const targetSnapshot = readPlanReviewTargetSnapshotNode(targetSnapshotNode);
    for (const [relativePath, content] of contents) {
      const absolutePath = path.join(repository, changePrefix, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content, { mode: 0o644 });
    }
    const bmpPath = `${changePrefix}/${bmpRelative}`;
    const astralPath = `${changePrefix}/${astralRelative}`;
    const submission = challengeSubmission({
      findings: [
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-scope',
          currentChangeImpact: 'required',
          summary: 'The BMP planning path must remain canonical.',
          evidence: [
            {
              kind: 'planning-location',
              path: bmpPath,
              line: 1,
              observation: 'This path sorts first by UTF-8 bytes.',
            },
          ],
        },
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-consumers',
          currentChangeImpact: 'required',
          summary: 'The astral planning path must remain canonical.',
          evidence: [
            {
              kind: 'planning-location',
              path: astralPath,
              line: 1,
              observation: 'This path sorts second by UTF-8 bytes.',
            },
          ],
        },
      ],
    });
    const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
      subject: context.subject,
      assignment: context.assignment,
      submission,
      targetSnapshotNode,
      policyDigest: DIGESTS.reviewPolicy,
      runtimeObservation: 'current',
    });
    const providerResultNode = createPlanReviewProviderResultNode({
      subject: context.subject,
      assignment: context.assignment,
      request: providerEvidence.request,
      result: providerEvidence.result,
      targetSnapshotNode,
    });
    const reviewNode = createPlanReviewNode({
      subject: context.subject,
      assignment: context.assignment,
      providerResultNode,
      submission,
    });

    assert.deepEqual(
      resolvePlanReviewPlanningEvidence(
        repository,
        targetSnapshot,
        reviewNode,
      ).locations.map(({ path: evidencePath }) => evidencePath),
      [bmpPath, astralPath],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('planning-location cannot cite a nonmember repository path', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'plan-review-namespace-'),
  );
  const planningPath = 'openspec/changes/demo-change/proposal.md';
  const planningBytes = Buffer.from('# Proposal\n');
  const absolutePlanningPath = path.join(repositoryRoot, planningPath);
  fs.mkdirSync(path.dirname(absolutePlanningPath), { recursive: true });
  fs.writeFileSync(absolutePlanningPath, planningBytes, { mode: 0o644 });
  try {
    const context = reviewContext();
    const submission = challengeSubmission({
      findings: [
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-scope',
          currentChangeImpact: 'required',
          summary: 'A repository file is mislabeled as planning evidence.',
          evidence: [
            {
              kind: 'planning-location',
              path: 'docs/WORKFLOW.md',
              line: 1,
              observation: 'This deliberately uses the wrong namespace.',
            },
          ],
        },
      ],
    });
    const reviewNode = createPlanReviewNode({
      subject: context.subject,
      assignment: context.assignment,
      providerResultNode: providerResultFor(context, submission),
      submission,
    });
    assert.throws(
      () =>
        resolvePlanReviewPlanningEvidence(
          repositoryRoot,
          {
            artifacts: [
              {
                path: planningPath,
                sha256: crypto
                  .createHash('sha256')
                  .update(planningBytes)
                  .digest('hex'),
                byteLength: planningBytes.byteLength,
                lineCount: 1,
              },
            ],
          } as never,
          reviewNode,
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'),
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

function authoredComponent(
  input: PlanTargetInput,
  role: 'proposal' | 'delta-spec',
) {
  return input.components.find(
    (component) =>
      component.kind === 'authored-markdown' && component.role === role,
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'authored-markdown' }
  >;
}

function mixedComponent(input: PlanTargetInput) {
  return input.components.find(
    (component) => component.kind === 'mixed-markdown',
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'mixed-markdown' }
  >;
}

function tasksComponent(input: PlanTargetInput) {
  return input.components.find(
    (component) => component.kind === 'tasks-markdown',
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'tasks-markdown' }
  >;
}

function structuredComponent(
  input: PlanTargetInput,
  role: 'schema-metadata' | 'guard' | 'execution' | 'investigation',
) {
  return input.components.find(
    (component) =>
      component.kind === 'structured-json' && component.role === role,
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'structured-json' }
  >;
}

function policyComponent(input: PlanTargetInput, name: string) {
  return input.components.find(
    (component) => component.kind === 'policy' && component.name === name,
  ) as Extract<PlanTargetInput['components'][number], { kind: 'policy' }>;
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

void (undefined as unknown as PlanReviewTermProjection);
