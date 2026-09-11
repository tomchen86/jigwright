import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  assertInvestigationPlanReviewCoverageRequirementSatisfied,
  buildGlobalPlanReviewCoverageRequirement,
} from '../src/modules/assurance/plan-review-coverage.ts';
import type { PlanReviewReport } from '../src/modules/assurance/plan-review-report.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

function fixture() {
  const coverage = buildGlobalPlanReviewCoverageRequirement({
    investigationId: 'investigation-v3',
    changeId: 'change-v3',
    baseline: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
    coverageTier: 'standard',
    sealedSamplingSeed: 'c'.repeat(64),
    targets: ['src/a.ts', 'src/b.ts'].map((targetPath) => ({
      source: 'planned-mutation' as const,
      path: targetPath,
      targetDigest: `sha256:${'d'.repeat(64)}`,
      stratum: 'planned-mutation' as const,
      reusedFromLedger: false,
      subjectId: null,
      ledgerEntryId: null,
      invariants: ['Preserve the target.'],
      riskFactors: ['planned-mutation'],
      freshness: 'missing-ledger-entry',
      evidenceMode: 'full-blob' as const,
      degradedExtraction: false,
      cost: { rawBytes: 128, reviewUnits: 1 },
    })),
    semanticReuse: {
      schemaVersion: 1,
      kind: 'semantic-reuse-coverage',
      owedCount: 2,
      carriedCount: 0,
      carried: [],
      resolutions: [],
      reviewTargets: ['a', 'b'].map((id) => ({
        targetId: 'domain-test-target-' + id,
        stratum: 'planned-mutation' as const,
        reusedFromLedger: false,
      })),
    },
  });
  return {
    repositoryRoot: '/memory-only-repository',
    requirement: {
      kind: 'plan-review-coverage-requirement' as const,
      requirementId: 'plan-review-coverage',
      coverage,
      semanticAuthor: {
        id: 'investigation-reviewer',
        provenance: 'checkpoint:plan-review-coverage',
      },
      provenanceDigest: 'e'.repeat(64),
    },
    review: {
      findings: [],
      suggestions: [],
      scopeAssessment: {
        kind: 'no-challenge',
        evidence: ['src/a.ts', 'src/b.ts'].map((targetPath) => ({
          kind: 'repository-location',
          path: targetPath,
          line: 1,
          observation: 'Reviewed the invariant.',
        })),
      },
    } as unknown as PlanReviewReport,
    expectedInvestigationId: 'investigation-v3',
    expectedChangeId: 'change-v3',
    expectedBaseline: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === code;
}

test('coverage rules and shared review records have no observation dependencies', () => {
  for (const entry of [
    'modules/assurance/plan-review-coverage.ts',
    'modules/assurance/plan-review-report.ts',
    'modules/assurance/review-coverage.ts',
    'modules/authority/maintainer-policy.ts',
  ]) {
    assert.ok(
      assertPureDependencyClosure(
        path.resolve(import.meta.dirname, '../src', entry),
      ).size > 1,
    );
  }
});

test('coverage observes every target in binding order on each validation', () => {
  const input = fixture();
  const calls: string[] = [];
  const observe = (
    root: string,
    coverage: typeof input.requirement.coverage,
    binding: (typeof input.requirement.coverage.targetBindings)[number],
  ) => {
    assert.equal(root, input.repositoryRoot);
    assert.equal(coverage.baselineCommit, input.expectedBaseline.head);
    calls.push(binding.targetId);
    return binding.targetDigest;
  };
  assertInvestigationPlanReviewCoverageRequirementSatisfied(observe, input);
  assertInvestigationPlanReviewCoverageRequirementSatisfied(observe, input);
  assert.deepEqual(
    calls,
    [
      ...input.requirement.coverage.targetBindings,
      ...input.requirement.coverage.targetBindings,
    ].map((binding) => binding.targetId),
  );
});

test('coverage rejects identity and incomplete review evidence before observing targets', () => {
  const input = fixture();
  let reads = 0;
  const observe = () => {
    reads += 1;
    throw new Error('Unexpected observation');
  };
  assert.throws(
    () =>
      assertInvestigationPlanReviewCoverageRequirementSatisfied(observe, {
        ...input,
        expectedChangeId: 'wrong',
      }),
    hasCode('REVIEW_COVERAGE_REQUIREMENT_INVALID'),
  );
  assert.throws(
    () =>
      assertInvestigationPlanReviewCoverageRequirementSatisfied(observe, {
        ...input,
        review: {
          ...input.review,
          scopeAssessment: { kind: 'no-challenge', evidence: [] },
        },
      }),
    hasCode('REVIEW_COVERAGE_INCOMPLETE'),
  );
  assert.equal(reads, 0);
});

test('coverage detects changed targets and propagates observer failures unchanged', () => {
  const input = fixture();
  assert.throws(
    () =>
      assertInvestigationPlanReviewCoverageRequirementSatisfied(
        () => 'missing',
        input,
      ),
    hasCode('REVIEW_DELTA_REQUIRED'),
  );
  const failure = new Error('Observation failed');
  let reads = 0;
  assert.throws(
    () =>
      assertInvestigationPlanReviewCoverageRequirementSatisfied(() => {
        reads += 1;
        throw failure;
      }, input),
    (error) => error === failure,
  );
  assert.equal(reads, 1);
});
