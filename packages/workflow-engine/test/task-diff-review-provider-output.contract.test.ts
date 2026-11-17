import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  parseTaskDiffReviewContinuationSubmission,
  parseTaskDiffReviewSubmission,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
  taskDiffReviewProviderSubmission,
  parseTaskDiffReviewProviderSubmission,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import type { TaskDiffReviewSubmission } from '../src/modules/assurance/task-diff-review-artifact-record.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';

test('TaskDiffReview provider output schema and validator bind the complete semantic grammar', () => {
  const submission = validSubmission();
  const authored = taskDiffReviewProviderSubmission(submission);
  assert.equal(TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate(authored), true);
  // Coverage is engine-filled, so its order can no longer be authored wrong.
  assert.deepEqual(
    parseTaskDiffReviewProviderSubmission(authored).coverage,
    submission.coverage,
  );
  assert.deepEqual(TASK_DIFF_REVIEW_OUTPUT_SCHEMA, {
    id: 'workflow.task-diff-review-output.v1',
    version: 1,
    digest: crypto
      .createHash('sha256')
      .update(canonicalJson(TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA))
      .digest('hex'),
  });
  assert.deepEqual(TASK_DIFF_REVIEW_OUTPUT_VALIDATOR, {
    ...TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    validate: TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate,
    explain: TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.explain,
  });
});

test('TaskDiffReview provider schema requires every property and uses null for an inapplicable documentation assessment', () => {
  assert.deepEqual(
    [...TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA.required].sort(),
    Object.keys(TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA.properties).sort(),
  );
  assert.ok(
    TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA.properties.documentationAssessment.anyOf.some(
      (branch) => (branch.type as string) === 'null',
    ),
  );
  const canonical = validSubmission();
  const authored = taskDiffReviewProviderSubmission(canonical);
  assert.equal(authored.documentationAssessment, null);
  assert.deepEqual(parseTaskDiffReviewProviderSubmission(authored), canonical);
  const { documentationAssessment: _assessment, ...omitted } = authored;
  assert.deepEqual(parseTaskDiffReviewProviderSubmission(omitted), canonical);
  assert.equal(
    TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate({
      ...authored,
      documentationAssessment: {},
    }),
    false,
  );
  assert.throws(() =>
    parseTaskDiffReviewSubmission({
      ...canonical,
      documentationAssessment: null,
    }),
  );
});

test('TaskDiffReview provider output rejects incomplete, duplicate, and evidence-free conclusions', () => {
  const canonical = validSubmission();
  const submission = taskDiffReviewProviderSubmission(canonical) as Record<
    string,
    unknown
  > & { suggestions: TaskDiffReviewSubmission['suggestions'] };
  const invalid: unknown[] = [
    (({ riskPathDispositions: _riskPathDispositions, ...rest }) => rest)(
      submission,
    ),
    { ...submission, scopeEvidence: [] },
    {
      ...submission,
      unexpectedSemanticAction: 'approve-and-commit',
    },
    {
      ...submission,
      suggestions: [submission.suggestions[0], submission.suggestions[0]],
    },
    {
      ...submission,
      riskPathDispositions: [
        { path: 'src/a.ts', role: 'ordinary', outcome: 'no-challenge' },
      ],
    },
    {
      ...submission,
      riskPathDispositions: [
        { path: 'src/a.ts', role: 'lifecycle', outcome: 'no-challenge' },
        { path: 'src/a.ts', role: 'lifecycle', outcome: 'challenge-raised' },
      ],
    },
    {
      ...submission,
      riskPathDispositions: [
        {
          path: 'src/a.ts',
          role: 'lifecycle',
          outcome: 'accepted',
        },
      ],
    },
    {
      ...submission,
      riskPathDispositions: [
        {
          path: 'src/a.ts',
          role: 'lifecycle',
          outcome: 'no-challenge',
          closedBy: 'provider-a:reviewer',
        },
      ],
    },
  ];

  for (const candidate of invalid) {
    assert.equal(TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate(candidate), false);
    assert.throws(() => parseTaskDiffReviewSubmission(candidate));
  }
});

test('TaskDiffReview provider schema excludes task artifacts from documentation paths', () => {
  const branches =
    TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA.properties.documentationAssessment
      .anyOf;
  for (const [decision, field] of [
    ['updated', 'paths'],
    ['generated-verified', 'generated'],
    ['needs-changes', 'requiredPaths'],
  ] as const) {
    const branch = branches.find(
      (value) =>
        'properties' in value && value.properties?.decision.const === decision,
    ) as unknown as {
      properties: Record<string, { items: { pattern?: string } }>;
    };
    const pattern = branch.properties[field]!.items.pattern;
    assert.ok(
      pattern,
      `${decision} must publish the canonical documentation path restriction`,
    );
    for (const candidate of [
      'README.md',
      'docs/WORKFLOW.md',
      'packages/core/README.md',
    ]) {
      assert.match(candidate, new RegExp(pattern));
    }
    assert.doesNotMatch(
      'openspec/changes/example/tasks.md',
      new RegExp(pattern),
    );
    assert.doesNotMatch('src/implementation.ts', new RegExp(pattern));
  }
  const authored = taskDiffReviewProviderSubmission(validSubmission());
  assert.throws(() =>
    parseTaskDiffReviewProviderSubmission({
      ...authored,
      documentationAssessment: {
        decision: 'updated',
        paths: ['README.md', 'openspec/changes/example/tasks.md'],
        notes:
          'The task checkbox is a lifecycle projection, not a documentation path.',
      },
    }),
  );
});

test('TaskDiffReview derives the scope assessment from its findings', () => {
  const submission = validSubmission();
  const authored = taskDiffReviewProviderSubmission(submission);
  const challenge = {
    severity: 'high' as const,
    category: 'correctness-and-invariants' as const,
    summary: 'The changed branch may violate the task invariant.',
    evidence: authored.scopeEvidence,
  };

  // The scope assessment is read off the findings, so a provider has no field
  // in which to contradict it and every combination is submittable.
  assert.equal(TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate(authored), true);
  assert.equal(
    TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate({
      ...authored,
      verdict: 'advisory-reject',
      findings: [challenge],
      riskPathDispositions: (
        authored.riskPathDispositions as TaskDiffReviewSubmission['riskPathDispositions']
      ).map((entry) => ({ ...entry, outcome: 'challenge-raised' as const })),
    }),
    true,
  );

  // A canonical submission is not a provider submission.
  assert.equal(TASK_DIFF_REVIEW_OUTPUT_VALIDATOR.validate(submission), false);
});

test('TaskDiffReview continuation output is advisory structured evidence, not a closure credential', () => {
  const submission = {
    schemaVersion: 1 as const,
    reviewRecordDigest: 'a'.repeat(64),
    responseDigest: 'b'.repeat(64),
    proposedDispositions: [
      {
        challengeId: 'c'.repeat(64),
        decision: 'rebutted' as const,
        rationale: 'The exact response rebuts the challenge.',
        supersededBy: null,
      },
    ],
  };
  assert.equal(
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR.validate(submission),
    true,
  );
  assert.deepEqual(
    parseTaskDiffReviewContinuationSubmission(submission),
    submission,
  );
  assert.deepEqual(TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA, {
    id: 'workflow.task-diff-review-continuation-output.v1',
    version: 1,
    digest: crypto
      .createHash('sha256')
      .update(
        canonicalJson(TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA),
      )
      .digest('hex'),
  });
  for (const invalid of [
    { ...submission, reviewRecordDigest: 'not-a-digest' },
    { ...submission, proposedDispositions: [] },
    {
      ...submission,
      proposedDispositions: [
        submission.proposedDispositions[0],
        submission.proposedDispositions[0],
      ],
    },
    {
      ...submission,
      proposedDispositions: [
        {
          ...submission.proposedDispositions[0],
          decision: 'closed',
        },
      ],
    },
  ]) {
    assert.equal(
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR.validate(invalid),
      false,
    );
    assert.throws(() => parseTaskDiffReviewContinuationSubmission(invalid));
  }
});

function validSubmission(): TaskDiffReviewSubmission {
  const repositoryEvidence = {
    kind: 'repository-location' as const,
    path: 'src/a.ts',
    line: 1,
    blobObjectId: 'a'.repeat(40),
    observation: 'The exact candidate branch preserves the task invariant.',
  };
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [repositoryEvidence],
    },
    findings: [],
    suggestions: [
      {
        kind: 'suggestion',
        severity: 'informational',
        category: 'test-adequacy',
        currentChangeImpact: 'independent-follow-up',
        summary: 'A follow-up property test could improve diagnostics.',
        evidence: [repositoryEvidence],
      },
    ],
    riskPathDispositions: [],
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
  };
}
