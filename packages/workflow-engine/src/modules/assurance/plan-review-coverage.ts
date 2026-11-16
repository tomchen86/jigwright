/**
 * Builds and verifies PlanReview coverage requirements and reuse bindings.
 *
 * Invariants:
 * - Coverage requirements must match the expected change and baseline
 *   commit and tree.
 */
import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { PlanReviewReport } from './plan-review-report.ts';
import { normalizeExactRepositoryPath } from '../../foundation/repository-path/repository-path.ts';
import {
  assertReviewSetHonoured,
  buildCoverageManifest,
  requiredReviewSet,
  type CoverageManifest,
  type ReviewTarget,
} from './review-coverage.ts';
import { deltaReviewRequired } from './review-challenge.ts';
import type { ReuseCoverageRecord } from './review-coverage.ts';
import type { CoverageTier } from './assurance-assessment-chain.ts';
import { assertInvestigationRequirementV3 } from '../investigation/manifest/investigation-manifest.ts';
import type {
  InvestigationPlanReviewCoveragePayloadV3,
  InvestigationPlanReviewCoverageRequirementV3,
  InvestigationPlanReviewCoverageTargetBindingV3,
} from '../investigation/manifest/investigation-requirement-types.ts';
import { GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST } from '../investigation/manifest/plan-review-coverage-policy.ts';

/** Observe each reviewed target when the coverage rule reaches its currentness check. */
export type PlanReviewCoverageTargetReader = (
  repositoryRoot: string,
  requirement: InvestigationPlanReviewCoveragePayloadV3,
  binding: InvestigationPlanReviewCoverageTargetBindingV3,
) => string;

const HEX64 = /^[0-9a-f]{64}$/;
const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type GlobalPlanReviewCoverageTargetInput = Readonly<{
  source:
    'planned-mutation' | 'investigation-target' | 'carried-ledger-subject';
  path: string;
  targetDigest: string;
  stratum: ReviewTarget['stratum'];
  reusedFromLedger: boolean;
  subjectId: string | null;
  ledgerEntryId: string | null;
  invariants: readonly string[];
  riskFactors: readonly string[];
  freshness: string;
  evidenceMode: 'bounded-context' | 'full-blob';
  degradedExtraction: boolean;
  cost: Readonly<{ rawBytes: number; reviewUnits: number }>;
}>;

export type GlobalPlanReviewCoverageTargetBinding =
  GlobalPlanReviewCoverageTargetInput &
    Readonly<{
      targetId: string;
      evidenceKind: 'planning-or-repository-location';
    }>;

export type GlobalPlanReviewCoverageRequirement = Readonly<{
  schemaVersion: 2;
  kind: 'plan-review-coverage-requirement';
  activation: 'global';
  investigationId: string;
  changeId: string;
  baselineCommit: string;
  baselineTree: string;
  coverageTier: CoverageTier;
  sealedSamplingSeed: string;
  coveragePolicyDigest: string;
  manifest: CoverageManifest;
  requiredTargetIds: readonly string[];
  targetBindings: readonly GlobalPlanReviewCoverageTargetBinding[];
  semanticReuse: ReuseCoverageRecord;
  costProfile: Readonly<{
    targetCount: number;
    rawBytes: number;
    reviewUnits: number;
  }>;
}>;

/**
 * Build the current global v3 requirement as a strict domain payload.
 */
export function buildGlobalPlanReviewCoverageRequirement(input: {
  investigationId: string;
  changeId: string;
  baseline: { head: string; tree: string };
  coverageTier: CoverageTier;
  sealedSamplingSeed: string;
  targets: readonly GlobalPlanReviewCoverageTargetInput[];
  semanticReuse: ReuseCoverageRecord;
}): GlobalPlanReviewCoverageRequirement {
  assertGlobalIdentityInputs(input);
  const targetBindings = canonicalGlobalBindings(
    input.targets.map(normalizeGlobalTargetBinding),
  );
  assertGlobalReuseMatchesBindings(input.semanticReuse, targetBindings);
  const manifest = buildCoverageManifest(
    input.coverageTier,
    targetBindings.map(
      ({ targetId, stratum, reusedFromLedger }): ReviewTarget => ({
        targetId,
        stratum,
        reusedFromLedger,
      }),
    ),
  );
  const requiredTargetIds = requiredReviewSet(
    manifest,
    input.sealedSamplingSeed,
    GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
  );
  return Object.freeze({
    schemaVersion: 2,
    kind: 'plan-review-coverage-requirement',
    activation: 'global',
    investigationId: input.investigationId,
    changeId: input.changeId,
    baselineCommit: input.baseline.head,
    baselineTree: input.baseline.tree,
    coverageTier: input.coverageTier,
    sealedSamplingSeed: input.sealedSamplingSeed,
    coveragePolicyDigest: GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
    manifest,
    requiredTargetIds,
    targetBindings: Object.freeze(targetBindings),
    semanticReuse: input.semanticReuse,
    costProfile: globalCostProfile(targetBindings),
  });
}

/**
 * Enforce the current-v3 required-target and delta checks after ordinary
 * PlanReview validation proves every citation against the immutable snapshot.
 */
export function assertInvestigationPlanReviewCoverageRequirementSatisfied(
  readTarget: PlanReviewCoverageTargetReader,
  input: {
    repositoryRoot: string;
    requirement: InvestigationPlanReviewCoverageRequirementV3;
    review: PlanReviewReport;
    expectedInvestigationId: string;
    expectedChangeId: string;
    expectedBaseline: { head: string; tree: string };
  },
): void {
  const requirement = assertInvestigationRequirementV3(input.requirement);
  if (requirement.kind !== 'plan-review-coverage-requirement') {
    throw coverageInvalid();
  }
  if (requirement.coverage.investigationId !== input.expectedInvestigationId) {
    throw coverageInvalid();
  }
  assertCoverageRequirementSatisfied(readTarget, {
    repositoryRoot: input.repositoryRoot,
    requirement: requirement.coverage,
    review: input.review,
    expectedChangeId: input.expectedChangeId,
    expectedBaseline: input.expectedBaseline,
  });
}

function assertCoverageRequirementSatisfied(
  readTarget: PlanReviewCoverageTargetReader,
  input: {
    repositoryRoot: string;
    requirement: InvestigationPlanReviewCoveragePayloadV3;
    review: PlanReviewReport;
    expectedChangeId: string;
    expectedBaseline: { head: string; tree: string };
  },
): void {
  const requirement = input.requirement;
  if (
    requirement.changeId !== input.expectedChangeId ||
    requirement.baselineCommit !== input.expectedBaseline.head ||
    requirement.baselineTree !== input.expectedBaseline.tree
  ) {
    throw coverageInvalid();
  }
  const required = new Set(requirement.requiredTargetIds);
  const evidenceKeys = new Set(
    reviewEvidence(input.review).map(
      ({ kind, path: evidencePath }) => `${kind}\0${evidencePath}`,
    ),
  );
  const disposed = requirement.targetBindings
    .filter(
      ({ targetId, evidenceKind, path: targetPath }) =>
        required.has(targetId) &&
        (evidenceKind === 'planning-or-repository-location'
          ? evidenceKeys.has(`planning-location\0${targetPath}`) ||
            evidenceKeys.has(`repository-location\0${targetPath}`)
          : evidenceKeys.has(`${evidenceKind}\0${targetPath}`)),
    )
    .map(({ targetId }) => targetId);
  assertReviewSetHonoured(requirement.requiredTargetIds, disposed);

  const reviewedDigests = Object.fromEntries(
    requirement.targetBindings.map(({ targetId, targetDigest }) => [
      targetId,
      targetDigest,
    ]),
  );
  const currentDigests = Object.fromEntries(
    requirement.targetBindings.map((binding) => [
      binding.targetId,
      readTarget(input.repositoryRoot, requirement, binding),
    ]),
  );
  const changed = deltaReviewRequired(reviewedDigests, currentDigests);
  if (changed.length > 0) {
    throw workflowError(
      'REVIEW_DELTA_REQUIRED',
      'A required review target no longer has the digest sealed into the reviewed generation.',
      ExitCode.verification,
      { details: { changed } },
    );
  }
}

function reviewEvidence(review: PlanReviewReport): Array<{
  kind: 'planning-location' | 'repository-location';
  path: string;
}> {
  const evidence = [
    ...review.findings.flatMap(({ evidence }) => evidence),
    ...review.suggestions.flatMap(({ evidence }) => evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ];
  return evidence.flatMap((entry) =>
    entry.kind === 'planning-location' || entry.kind === 'repository-location'
      ? [{ kind: entry.kind, path: entry.path }]
      : [],
  );
}

function normalizeGlobalTargetBinding(
  input: GlobalPlanReviewCoverageTargetInput,
): GlobalPlanReviewCoverageTargetBinding {
  let targetPath: string;
  try {
    targetPath = normalizeExactRepositoryPath(input.path);
  } catch {
    throw coverageInvalid();
  }
  const invariants = canonicalBoundedStrings(input.invariants);
  const riskFactors = canonicalBoundedStrings(input.riskFactors);
  if (
    targetPath !== input.path ||
    !PREFIXED_DIGEST.test(input.targetDigest) ||
    ![
      'planned-mutation',
      'investigation-target',
      'carried-ledger-subject',
    ].includes(input.source) ||
    !isReviewStratum(input.stratum) ||
    invariants.length === 0 ||
    riskFactors.length === 0 ||
    typeof input.freshness !== 'string' ||
    input.freshness.trim() !== input.freshness ||
    input.freshness.length === 0 ||
    Buffer.byteLength(input.freshness) > 256 ||
    (input.evidenceMode !== 'bounded-context' &&
      input.evidenceMode !== 'full-blob') ||
    typeof input.degradedExtraction !== 'boolean' ||
    !isRecord(input.cost) ||
    !hasExactKeys(input.cost, ['rawBytes', 'reviewUnits']) ||
    !Number.isSafeInteger(input.cost.rawBytes) ||
    (input.cost.rawBytes as number) < 0 ||
    !Number.isSafeInteger(input.cost.reviewUnits) ||
    (input.cost.reviewUnits as number) < 1 ||
    (input.reusedFromLedger
      ? typeof input.subjectId !== 'string' ||
        input.subjectId.length === 0 ||
        typeof input.ledgerEntryId !== 'string' ||
        !PREFIXED_DIGEST.test(input.ledgerEntryId)
      : input.subjectId !== null || input.ledgerEntryId !== null) ||
    (input.reusedFromLedger && input.evidenceMode !== 'bounded-context') ||
    (!input.reusedFromLedger && input.source === 'carried-ledger-subject')
  ) {
    throw coverageInvalid();
  }
  const normalized: GlobalPlanReviewCoverageTargetInput = Object.freeze({
    source: input.source,
    path: targetPath,
    targetDigest: input.targetDigest,
    stratum: input.stratum,
    reusedFromLedger: input.reusedFromLedger,
    subjectId: input.subjectId,
    ledgerEntryId: input.ledgerEntryId,
    invariants: Object.freeze(invariants),
    riskFactors: Object.freeze(riskFactors),
    freshness: input.freshness,
    evidenceMode: input.evidenceMode,
    degradedExtraction: input.degradedExtraction,
    cost: Object.freeze({
      rawBytes: input.cost.rawBytes as number,
      reviewUnits: input.cost.reviewUnits as number,
    }),
  });
  return Object.freeze({
    targetId: `review-target:${sha256(
      canonicalJson({ schema: 'plan-review-target-binding.v2', ...normalized }),
    )}`,
    ...normalized,
    evidenceKind: 'planning-or-repository-location',
  });
}

function canonicalGlobalBindings(
  bindings: readonly GlobalPlanReviewCoverageTargetBinding[],
): GlobalPlanReviewCoverageTargetBinding[] {
  const sorted = [...bindings].sort((left, right) =>
    left.targetId.localeCompare(right.targetId),
  );
  if (
    new Set(sorted.map(({ targetId }) => targetId)).size !== sorted.length ||
    new Set(sorted.map(({ path: targetPath }) => targetPath)).size !==
      sorted.length
  ) {
    throw coverageInvalid();
  }
  return sorted;
}

function globalCostProfile(
  bindings: readonly GlobalPlanReviewCoverageTargetBinding[],
): GlobalPlanReviewCoverageRequirement['costProfile'] {
  return Object.freeze({
    targetCount: bindings.length,
    rawBytes: bindings.reduce((sum, { cost }) => sum + cost.rawBytes, 0),
    reviewUnits: bindings.reduce((sum, { cost }) => sum + cost.reviewUnits, 0),
  });
}

function assertGlobalIdentityInputs(input: {
  investigationId: string;
  changeId: string;
  baseline: { head: string; tree: string };
  coverageTier: CoverageTier;
  sealedSamplingSeed: string;
  targets: readonly GlobalPlanReviewCoverageTargetInput[];
  semanticReuse: ReuseCoverageRecord;
}): void {
  if (
    input.investigationId.length === 0 ||
    input.changeId.length === 0 ||
    !GIT_OBJECT.test(input.baseline.head) ||
    !GIT_OBJECT.test(input.baseline.tree) ||
    !isCoverageTier(input.coverageTier) ||
    !HEX64.test(input.sealedSamplingSeed)
  ) {
    throw coverageInvalid();
  }
  assertReuseCoverage(input.semanticReuse, true);
}

function assertGlobalReuseMatchesBindings(
  value: ReuseCoverageRecord,
  bindings: readonly GlobalPlanReviewCoverageTargetBinding[],
): void {
  const carried = bindings.filter(({ reusedFromLedger }) => reusedFromLedger);
  if (
    value.carriedCount !== carried.length ||
    value.carried.length !== carried.length ||
    value.carried.some(
      ({ subjectId, ledgerEntryId }) =>
        !carried.some(
          (binding) =>
            binding.subjectId === subjectId &&
            binding.ledgerEntryId === ledgerEntryId,
        ),
    )
  ) {
    throw coverageInvalid();
  }
}

function canonicalBoundedStrings(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw coverageInvalid();
  const normalized = [...values];
  if (
    normalized.some(
      (value) =>
        typeof value !== 'string' ||
        value.trim() !== value ||
        value.length === 0 ||
        Buffer.byteLength(value) > 4096,
    )
  ) {
    throw coverageInvalid();
  }
  const sorted = [...new Set(normalized)].sort();
  if (sorted.length !== normalized.length) throw coverageInvalid();
  return sorted;
}

function isReviewStratum(value: unknown): value is ReviewTarget['stratum'] {
  return [
    'planned-mutation',
    'hard-risk',
    'largest-blast-radius',
    'degraded-extraction',
    'unresolved-uncertainty',
    'production-consumer',
    'test-or-mirror',
    'contract-or-schema',
    'cli-or-integration',
    'cross-module',
  ].includes(value as ReviewTarget['stratum']);
}

function assertReuseCoverage(
  value: unknown,
  allowEmpty = false,
): ReuseCoverageRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'owedCount',
      'carriedCount',
      'carried',
      'resolutions',
      'reviewTargets',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'semantic-reuse-coverage' ||
    !Number.isSafeInteger(value.owedCount) ||
    (value.owedCount as number) < 0 ||
    !Number.isSafeInteger(value.carriedCount) ||
    (value.carriedCount as number) < (allowEmpty ? 0 : 1) ||
    !Array.isArray(value.carried) ||
    value.carried.length !== value.carriedCount ||
    !Array.isArray(value.resolutions) ||
    !Array.isArray(value.reviewTargets)
  ) {
    throw coverageInvalid();
  }
  return deepFreeze(structuredClone(value)) as ReuseCoverageRecord;
}

function isCoverageTier(value: unknown): value is CoverageTier {
  return value === 'standard' || value === 'elevated' || value === 'critical';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function coverageInvalid() {
  return workflowError(
    'REVIEW_COVERAGE_REQUIREMENT_INVALID',
    'The engine-owned PlanReview coverage requirement is malformed or stale.',
    ExitCode.guard,
  );
}
