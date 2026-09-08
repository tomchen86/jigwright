import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { projectPlanReviewTerms } from '../src/modules/projection/investigation-term-projection.ts';
import {
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  canonicalizePlanReviewProviderSubmission,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  readPlanReviewTargetSnapshotNode,
  readPlanReviewNode,
  type PlanReviewReport,
  type PlanReviewSubmission,
} from '../src/modules/assurance/plan-review.ts';
import { validatePlanReview } from '../src/modules/assurance/plan-review-validation.ts';
import {
  assertInvestigationPlanReviewCoverageRequirementSatisfied,
  buildGlobalPlanReviewCoverageRequirement,
  GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
} from '../src/modules/assurance/plan-review-coverage.ts';
import { createCurrentPlanReviewProviderEvidenceForTest } from './fixture.ts';
import {
  DIGESTS,
  reviewContext,
  providerResultFor,
  rememberProviderResult,
  challengeSubmission,
  providerSubmission,
  currentValidationInput,
  admittedRoleAuthorization,
  isWorkflowError,
} from './plan-review-contract-fixture.ts';

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
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(providerSubmission()),
    true,
  );

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
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(
      providerSubmission({ scopeEvidence: [] }),
    ),
    false,
  );
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
  assert.equal(
    PLAN_REVIEW_OUTPUT_VALIDATOR.validate(providerSubmission()),
    true,
  );
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
