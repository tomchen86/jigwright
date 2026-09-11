/**
 * Normalizes structured review coverage and implementation reconciliation
 * requirements.
 *
 * Invariants:
 * - Ordinary manifests require exactly one PlanReview coverage requirement.
 */
import type { InvestigationSemanticAuthor } from '../domain/investigation-applicability.ts';
import type { InvestigationV3Baseline } from './investigation-materializer.ts';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import {
  digest,
  unrepresentable,
  assertUnique,
  assertRecord,
  normalizeSemanticAuthor,
  assertDigest,
  assertExactKeys,
  rawSha256,
  assertGitObjectId,
  MAX_TEXT_BYTES,
} from './investigation-manifest-values.ts';

const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/;

const SEMANTIC_SUBJECT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

const MAX_STRUCTURED_REQUIREMENTS = 4_096;

const GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST_V3 = digest({
  schemaVersion: 2,
  kind: 'plan-review-coverage-policy',
  activation: 'global',
  sampling: 'review-coverage.v1',
  evidence: 'namespace-correct-exact-location',
  targetFields: [
    'invariants',
    'risk-factors',
    'freshness',
    'evidence-mode',
    'degraded-extraction',
    'cost-profile',
  ],
});

const IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST_V3 = digest({
  schemaVersion: 1,
  kind: 'implementation-reconciliation-policy',
  plannedIdentity: 'semantic-ledger-file-subject.v1',
  changedRanges: 'git-unified-zero-no-renames.v1',
  productionPaths: 'path-role-registry-fail-deep.v1',
  finalizationTermFloor: 'implementation-hunk-term-floor.v1',
  unplannedSubject: 'delta-review-required',
});

type InvestigationRequirementMetadataV3 = {
  requirementId: string;
  semanticAuthor: InvestigationSemanticAuthor;
  provenanceDigest: string;
};

export type InvestigationGenericRequirementV3 =
  InvestigationRequirementMetadataV3 & {
    /** Optional only while existing generic authoring callers move to tags. */
    kind?: 'investigation-requirement';
    text: string;
  };

export type InvestigationPlanReviewCoverageTargetV3 = {
  targetId: string;
  stratum:
    | 'planned-mutation'
    | 'hard-risk'
    | 'largest-blast-radius'
    | 'degraded-extraction'
    | 'unresolved-uncertainty'
    | 'production-consumer'
    | 'test-or-mirror'
    | 'contract-or-schema'
    | 'cli-or-integration'
    | 'cross-module';
  reusedFromLedger: boolean;
};

export type InvestigationPlanReviewCoverageTargetBindingV3 =
  InvestigationPlanReviewCoverageTargetV3 & {
    source:
      'planned-mutation' | 'investigation-target' | 'carried-ledger-subject';
    path: string;
    targetDigest: string;
    evidenceKind: 'planning-or-repository-location';
    subjectId: string | null;
    ledgerEntryId: string | null;
    invariants: readonly string[];
    riskFactors: readonly string[];
    freshness: string;
    evidenceMode: 'bounded-context' | 'full-blob';
    degradedExtraction: boolean;
    cost: { rawBytes: number; reviewUnits: number };
  };

export type InvestigationSemanticReuseCoverageV3 = {
  schemaVersion: 1;
  kind: 'semantic-reuse-coverage';
  owedCount: number;
  carriedCount: number;
  carried: readonly {
    manifestEntryId: string;
    subjectId: string;
    ledgerEntryId: string;
  }[];
  resolutions: readonly {
    subjectId: string;
    resolution: string;
    state: string;
  }[];
  reviewTargets: readonly InvestigationPlanReviewCoverageTargetV3[];
};

/** Exact v3-carried form of the current global PlanReview coverage facts. */
export type InvestigationPlanReviewCoveragePayloadV3 = {
  schemaVersion: 2;
  kind: 'plan-review-coverage-requirement';
  activation: 'global';
  investigationId: string;
  changeId: string;
  baselineCommit: string;
  baselineTree: string;
  coverageTier: 'standard' | 'elevated' | 'critical';
  sealedSamplingSeed: string;
  coveragePolicyDigest: string;
  manifest: {
    schemaVersion: 1;
    kind: 'review-coverage-manifest';
    tier: 'standard' | 'elevated' | 'critical';
    targets: readonly InvestigationPlanReviewCoverageTargetV3[];
    populationDigest: string;
  };
  requiredTargetIds: readonly string[];
  targetBindings: readonly InvestigationPlanReviewCoverageTargetBindingV3[];
  semanticReuse: InvestigationSemanticReuseCoverageV3;
  costProfile: {
    targetCount: number;
    rawBytes: number;
    reviewUnits: number;
  };
};

export type InvestigationPlanReviewCoverageRequirementV3 =
  InvestigationRequirementMetadataV3 & {
    kind: 'plan-review-coverage-requirement';
    coverage: InvestigationPlanReviewCoveragePayloadV3;
  };

export type InvestigationImplementationPlannedMutationV3 = {
  subjectId: string;
  path: string;
  intendedChange: string;
  invariantsToPreserve: readonly string[];
};

/** Exact v3-carried form of the current implementation reconciliation facts. */
export type InvestigationImplementationReconciliationPayloadV3 = {
  schemaVersion: 1;
  kind: 'implementation-reconciliation-requirement';
  changeId: string;
  baseline: { head: string; tree: string };
  policyDigest: string;
  plannedMutations: readonly InvestigationImplementationPlannedMutationV3[];
};

export type InvestigationImplementationReconciliationRequirementV3 =
  InvestigationRequirementMetadataV3 & {
    kind: 'implementation-reconciliation-requirement';
    reconciliation: InvestigationImplementationReconciliationPayloadV3;
  };

export type InvestigationRequirementV3 =
  | InvestigationGenericRequirementV3
  | InvestigationPlanReviewCoverageRequirementV3
  | InvestigationImplementationReconciliationRequirementV3;

export function normalizeRequirements(
  values: InvestigationRequirementV3[],
): InvestigationRequirementV3[] {
  return normalizeInvestigationRequirementsV3(values);
}

export function assertOrdinaryPlanReviewCoverageBinding(input: {
  requirements: readonly InvestigationRequirementV3[];
  expected: {
    changeId: string;
    investigationId: string;
    baseline: InvestigationV3Baseline;
  };
}): void {
  const coverageRequirements = input.requirements.filter(
    (
      requirement,
    ): requirement is InvestigationPlanReviewCoverageRequirementV3 =>
      requirement.kind === 'plan-review-coverage-requirement',
  );
  if (coverageRequirements.length !== 1) {
    throw unrepresentable(
      'Ordinary Investigation Manifest requires exactly one PlanReview coverage requirement.',
    );
  }
  const coverage = coverageRequirements[0]!.coverage;
  if (
    coverage.changeId !== input.expected.changeId ||
    coverage.investigationId !== input.expected.investigationId ||
    coverage.baselineCommit !== input.expected.baseline.commitOid ||
    coverage.baselineTree !== input.expected.baseline.treeOid
  ) {
    throw unrepresentable(
      'PlanReview coverage requirement does not match its parent Manifest identity and replay baseline.',
    );
  }
}

/** Shared strict parser for serialized v3 requirement arrays. */
export function normalizeInvestigationRequirementsV3(
  value: unknown,
): InvestigationRequirementV3[] {
  if (!Array.isArray(value) || value.length > MAX_STRUCTURED_REQUIREMENTS) {
    throw unrepresentable('Investigation requirements are malformed.');
  }
  const requirements = value.map(assertInvestigationRequirementV3);
  const sorted = requirements.sort((left, right) =>
    left.requirementId.localeCompare(right.requirementId),
  );
  assertUnique(
    sorted.map(({ requirementId }) => requirementId),
    'requirement IDs',
  );
  return sorted;
}

export function assertInvestigationRequirementV3(
  value: unknown,
): InvestigationRequirementV3 {
  const record = assertRecord(value);
  const requirementId = canonicalStructuredText(
    record.requirementId,
    'requirement ID',
  );
  const semanticAuthor = normalizeSemanticAuthor(record.semanticAuthor);
  assertDigest(record.provenanceDigest);
  const metadata = {
    requirementId,
    semanticAuthor,
    provenanceDigest: record.provenanceDigest as string,
  };
  if (record.kind === 'plan-review-coverage-requirement') {
    assertExactKeys(record, [
      'kind',
      'requirementId',
      'coverage',
      'semanticAuthor',
      'provenanceDigest',
    ]);
    return {
      kind: 'plan-review-coverage-requirement',
      ...metadata,
      coverage: normalizePlanReviewCoveragePayload(record.coverage),
    };
  }
  if (record.kind === 'implementation-reconciliation-requirement') {
    assertExactKeys(record, [
      'kind',
      'requirementId',
      'reconciliation',
      'semanticAuthor',
      'provenanceDigest',
    ]);
    return {
      kind: 'implementation-reconciliation-requirement',
      ...metadata,
      reconciliation: normalizeImplementationReconciliationPayload(
        record.reconciliation,
      ),
    };
  }
  if (
    record.kind !== undefined &&
    record.kind !== 'investigation-requirement'
  ) {
    throw unrepresentable('Investigation requirement kind is malformed.');
  }
  assertExactKeys(
    record,
    record.kind === undefined
      ? ['requirementId', 'text', 'semanticAuthor', 'provenanceDigest']
      : ['kind', 'requirementId', 'text', 'semanticAuthor', 'provenanceDigest'],
  );
  return {
    ...(record.kind === undefined
      ? {}
      : { kind: 'investigation-requirement' as const }),
    ...metadata,
    text: canonicalStructuredText(record.text, 'investigation requirement'),
  };
}

function normalizePlanReviewCoveragePayload(
  value: unknown,
): InvestigationPlanReviewCoveragePayloadV3 {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'activation',
    'investigationId',
    'changeId',
    'baselineCommit',
    'baselineTree',
    'coverageTier',
    'sealedSamplingSeed',
    'coveragePolicyDigest',
    'manifest',
    'requiredTargetIds',
    'targetBindings',
    'semanticReuse',
    'costProfile',
  ]);
  if (
    record.schemaVersion !== 2 ||
    record.kind !== 'plan-review-coverage-requirement' ||
    record.activation !== 'global'
  ) {
    throw unrepresentable('PlanReview coverage requirement is malformed.');
  }
  const investigationId = canonicalStructuredText(
    record.investigationId,
    'coverage investigation ID',
  );
  const changeId = canonicalStructuredText(
    record.changeId,
    'coverage change ID',
  );
  const baseline = normalizeRequirementBaseline({
    head: record.baselineCommit,
    tree: record.baselineTree,
  });
  const coverageTier = normalizeCoverageTier(record.coverageTier);
  assertDigest(record.sealedSamplingSeed);
  if (
    record.coveragePolicyDigest !== GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST_V3
  ) {
    throw unrepresentable('PlanReview coverage policy digest is stale.');
  }
  const targetBindings = normalizeCoverageTargetBindings(record.targetBindings);
  const semanticReuse = normalizeSemanticReuseCoverage(record.semanticReuse);
  assertSemanticReuseMatchesBindings(semanticReuse, targetBindings);
  const manifest = coverageManifestFromBindings(coverageTier, targetBindings);
  const requiredTargetIds = requiredCoverageTargetIds(
    manifest,
    record.sealedSamplingSeed as string,
    GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST_V3,
  );
  const costProfile = coverageCostProfile(targetBindings);
  if (
    canonicalJson(record.manifest) !== canonicalJson(manifest) ||
    canonicalJson(record.requiredTargetIds) !==
      canonicalJson(requiredTargetIds) ||
    canonicalJson(record.costProfile) !== canonicalJson(costProfile)
  ) {
    throw unrepresentable(
      'PlanReview coverage derived commitments do not match their targets.',
    );
  }
  return {
    schemaVersion: 2,
    kind: 'plan-review-coverage-requirement',
    activation: 'global',
    investigationId,
    changeId,
    baselineCommit: baseline.head,
    baselineTree: baseline.tree,
    coverageTier,
    sealedSamplingSeed: record.sealedSamplingSeed as string,
    coveragePolicyDigest: GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST_V3,
    manifest,
    requiredTargetIds,
    targetBindings,
    semanticReuse,
    costProfile,
  };
}

function normalizeCoverageTargetBindings(
  value: unknown,
): InvestigationPlanReviewCoverageTargetBindingV3[] {
  if (!Array.isArray(value) || value.length > MAX_STRUCTURED_REQUIREMENTS) {
    throw unrepresentable('PlanReview coverage targets are malformed.');
  }
  const bindings = value.map(normalizeCoverageTargetBinding);
  const sorted = bindings.sort((left, right) =>
    left.targetId.localeCompare(right.targetId),
  );
  assertUnique(
    sorted.map(({ targetId }) => targetId),
    'PlanReview coverage target IDs',
  );
  assertUnique(
    sorted.map(({ path }) => path),
    'PlanReview coverage target paths',
  );
  return sorted;
}

function normalizeCoverageTargetBinding(
  value: unknown,
): InvestigationPlanReviewCoverageTargetBindingV3 {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'targetId',
    'source',
    'path',
    'targetDigest',
    'evidenceKind',
    'stratum',
    'reusedFromLedger',
    'subjectId',
    'ledgerEntryId',
    'invariants',
    'riskFactors',
    'freshness',
    'evidenceMode',
    'degradedExtraction',
    'cost',
  ]);
  const source = normalizeCoverageSource(record.source);
  const path = canonicalRequirementPath(record.path);
  const targetDigest = prefixedDigest(
    record.targetDigest,
    'coverage target digest',
  );
  const stratum = normalizeReviewStratum(record.stratum);
  if (
    typeof record.reusedFromLedger !== 'boolean' ||
    record.evidenceKind !== 'planning-or-repository-location' ||
    (record.evidenceMode !== 'bounded-context' &&
      record.evidenceMode !== 'full-blob') ||
    typeof record.degradedExtraction !== 'boolean'
  ) {
    throw unrepresentable('PlanReview coverage target is malformed.');
  }
  const reusedFromLedger = record.reusedFromLedger;
  const subjectId =
    record.subjectId === null
      ? null
      : canonicalSemanticSubjectId(record.subjectId);
  const ledgerEntryId =
    record.ledgerEntryId === null
      ? null
      : prefixedDigest(record.ledgerEntryId, 'semantic ledger entry ID');
  if (
    (reusedFromLedger && (subjectId === null || ledgerEntryId === null)) ||
    (!reusedFromLedger && (subjectId !== null || ledgerEntryId !== null)) ||
    (reusedFromLedger && record.evidenceMode !== 'bounded-context') ||
    (!reusedFromLedger && source === 'carried-ledger-subject')
  ) {
    throw unrepresentable('PlanReview coverage reuse binding is inconsistent.');
  }
  const invariants = canonicalStructuredTextArray(
    record.invariants,
    'coverage invariants',
    false,
  );
  const riskFactors = canonicalStructuredTextArray(
    record.riskFactors,
    'coverage risk factors',
    false,
  );
  const freshness = canonicalStructuredText(
    record.freshness,
    'coverage freshness',
    256,
  );
  const costRecord = assertRecord(record.cost);
  assertExactKeys(costRecord, ['rawBytes', 'reviewUnits']);
  const rawBytes = nonNegativeSafeInteger(
    costRecord.rawBytes,
    'coverage raw bytes',
  );
  const reviewUnits = positiveSafeInteger(
    costRecord.reviewUnits,
    'coverage review units',
  );
  const normalized = {
    source,
    path,
    targetDigest,
    stratum,
    reusedFromLedger,
    subjectId,
    ledgerEntryId,
    invariants,
    riskFactors,
    freshness,
    evidenceMode: record.evidenceMode,
    degradedExtraction: record.degradedExtraction,
    cost: { rawBytes, reviewUnits },
  } as const;
  const targetId = `review-target:${rawSha256(
    canonicalJson({ schema: 'plan-review-target-binding.v2', ...normalized }),
  )}`;
  if (record.targetId !== targetId) {
    throw unrepresentable('PlanReview coverage target identity is stale.');
  }
  return {
    targetId,
    ...normalized,
    evidenceKind: 'planning-or-repository-location',
  };
}

function normalizeSemanticReuseCoverage(
  value: unknown,
): InvestigationSemanticReuseCoverageV3 {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'owedCount',
    'carriedCount',
    'carried',
    'resolutions',
    'reviewTargets',
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'semantic-reuse-coverage' ||
    !Array.isArray(record.carried) ||
    !Array.isArray(record.resolutions) ||
    !Array.isArray(record.reviewTargets)
  ) {
    throw unrepresentable('Semantic reuse coverage is malformed.');
  }
  const owedCount = nonNegativeSafeInteger(
    record.owedCount,
    'semantic reuse owed count',
  );
  const carriedCount = nonNegativeSafeInteger(
    record.carriedCount,
    'semantic reuse carried count',
  );
  const carried = record.carried.map((entry) => {
    const carriedRecord = assertRecord(entry);
    assertExactKeys(carriedRecord, [
      'manifestEntryId',
      'subjectId',
      'ledgerEntryId',
    ]);
    return {
      manifestEntryId: canonicalStructuredText(
        carriedRecord.manifestEntryId,
        'reuse manifest entry ID',
      ),
      subjectId: canonicalSemanticSubjectId(carriedRecord.subjectId),
      ledgerEntryId: prefixedDigest(
        carriedRecord.ledgerEntryId,
        'reuse ledger entry ID',
      ),
    };
  });
  const resolutions = record.resolutions.map((entry) => {
    const resolutionRecord = assertRecord(entry);
    assertExactKeys(resolutionRecord, ['subjectId', 'resolution', 'state']);
    return {
      subjectId: canonicalSemanticSubjectId(resolutionRecord.subjectId),
      resolution: canonicalStructuredText(
        resolutionRecord.resolution,
        'semantic reuse resolution',
      ),
      state: canonicalStructuredText(
        resolutionRecord.state,
        'semantic reuse state',
      ),
    };
  });
  const reviewTargets = record.reviewTargets.map(normalizeCoverageReviewTarget);
  if (
    carried.length !== carriedCount ||
    reviewTargets.length !== owedCount + carriedCount
  ) {
    throw unrepresentable('Semantic reuse counts are inconsistent.');
  }
  assertUnique(
    carried.map(({ manifestEntryId }) => manifestEntryId),
    'reuse manifest entry IDs',
  );
  assertUnique(
    reviewTargets.map(({ targetId }) => targetId),
    'reuse review target IDs',
  );
  return {
    schemaVersion: 1,
    kind: 'semantic-reuse-coverage',
    owedCount,
    carriedCount,
    carried,
    resolutions,
    reviewTargets,
  };
}

function normalizeCoverageReviewTarget(
  value: unknown,
): InvestigationPlanReviewCoverageTargetV3 {
  const record = assertRecord(value);
  assertExactKeys(record, ['targetId', 'stratum', 'reusedFromLedger']);
  if (typeof record.reusedFromLedger !== 'boolean') {
    throw unrepresentable('Review target reuse state is malformed.');
  }
  return {
    targetId: canonicalStructuredText(record.targetId, 'review target ID'),
    stratum: normalizeReviewStratum(record.stratum),
    reusedFromLedger: record.reusedFromLedger,
  };
}

function assertSemanticReuseMatchesBindings(
  reuse: InvestigationSemanticReuseCoverageV3,
  bindings: InvestigationPlanReviewCoverageTargetBindingV3[],
): void {
  const carriedBindings = bindings.filter(
    ({ reusedFromLedger }) => reusedFromLedger,
  );
  if (
    reuse.carriedCount !== carriedBindings.length ||
    reuse.carried.some(
      ({ subjectId, ledgerEntryId }) =>
        !carriedBindings.some(
          (binding) =>
            binding.subjectId === subjectId &&
            binding.ledgerEntryId === ledgerEntryId,
        ),
    )
  ) {
    throw unrepresentable(
      'Semantic reuse coverage does not match PlanReview targets.',
    );
  }
}

function coverageManifestFromBindings(
  tier: InvestigationPlanReviewCoveragePayloadV3['coverageTier'],
  bindings: InvestigationPlanReviewCoverageTargetBindingV3[],
): InvestigationPlanReviewCoveragePayloadV3['manifest'] {
  const targets = bindings.map(({ targetId, stratum, reusedFromLedger }) => ({
    targetId,
    stratum,
    reusedFromLedger,
  }));
  return {
    schemaVersion: 1,
    kind: 'review-coverage-manifest',
    tier,
    targets,
    populationDigest: rawSha256(
      targets
        .map(({ targetId, stratum }) => `${targetId} ${stratum}`)
        .join('\n'),
    ),
  };
}

function requiredCoverageTargetIds(
  manifest: InvestigationPlanReviewCoveragePayloadV3['manifest'],
  seed: string,
  policyDigest: string,
): string[] {
  if (manifest.tier === 'critical') {
    return manifest.targets.map(({ targetId }) => targetId);
  }
  const mandatoryStrata = new Set<
    InvestigationPlanReviewCoverageTargetV3['stratum']
  >([
    'planned-mutation',
    'hard-risk',
    'largest-blast-radius',
    'degraded-extraction',
    'unresolved-uncertainty',
  ]);
  const mandatory = manifest.targets.filter(({ stratum }) =>
    mandatoryStrata.has(stratum),
  );
  const remainder = manifest.targets.filter(
    ({ stratum }) => !mandatoryStrata.has(stratum),
  );
  const proportion = manifest.tier === 'elevated' ? 0.5 : 0.2;
  const sampleSize = Math.min(
    remainder.length,
    Math.max(
      remainder.length === 0 ? 0 : 1,
      Math.ceil(remainder.length * proportion),
    ),
  );
  const sampled = [...remainder]
    .sort((left, right) =>
      rawSha256(
        `${seed} ${manifest.populationDigest} ${policyDigest} ${left.targetId}`,
      ).localeCompare(
        rawSha256(
          `${seed} ${manifest.populationDigest} ${policyDigest} ${right.targetId}`,
        ),
      ),
    )
    .slice(0, sampleSize);
  return [...mandatory, ...sampled].map(({ targetId }) => targetId).sort();
}

function coverageCostProfile(
  bindings: InvestigationPlanReviewCoverageTargetBindingV3[],
): InvestigationPlanReviewCoveragePayloadV3['costProfile'] {
  const rawBytes = bindings.reduce(
    (sum, { cost }) => safeIntegerSum(sum, cost.rawBytes),
    0,
  );
  const reviewUnits = bindings.reduce(
    (sum, { cost }) => safeIntegerSum(sum, cost.reviewUnits),
    0,
  );
  return { targetCount: bindings.length, rawBytes, reviewUnits };
}

function normalizeImplementationReconciliationPayload(
  value: unknown,
): InvestigationImplementationReconciliationPayloadV3 {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'changeId',
    'baseline',
    'policyDigest',
    'plannedMutations',
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'implementation-reconciliation-requirement' ||
    record.policyDigest !== IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST_V3 ||
    !Array.isArray(record.plannedMutations) ||
    record.plannedMutations.length > MAX_STRUCTURED_REQUIREMENTS
  ) {
    throw unrepresentable(
      'Implementation reconciliation requirement is malformed.',
    );
  }
  const plannedMutations = record.plannedMutations
    .map(normalizeImplementationPlannedMutation)
    .sort((left, right) => left.subjectId.localeCompare(right.subjectId));
  assertUnique(
    plannedMutations.map(({ subjectId }) => subjectId),
    'implementation planned mutation IDs',
  );
  return {
    schemaVersion: 1,
    kind: 'implementation-reconciliation-requirement',
    changeId: canonicalStructuredText(
      record.changeId,
      'implementation reconciliation change ID',
    ),
    baseline: normalizeRequirementBaseline(record.baseline),
    policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST_V3,
    plannedMutations,
  };
}

function normalizeImplementationPlannedMutation(
  value: unknown,
): InvestigationImplementationPlannedMutationV3 {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'subjectId',
    'path',
    'intendedChange',
    'invariantsToPreserve',
  ]);
  const path = canonicalRequirementPath(record.path);
  const subjectId = `file.${rawSha256(path)}`;
  if (record.subjectId !== subjectId) {
    throw unrepresentable(
      'Implementation planned mutation subject identity is stale.',
    );
  }
  return {
    subjectId,
    path,
    intendedChange: canonicalStructuredText(
      record.intendedChange,
      'implementation intended change',
    ),
    invariantsToPreserve: canonicalStructuredTextArray(
      record.invariantsToPreserve,
      'implementation invariants',
      true,
    ),
  };
}

function normalizeRequirementBaseline(value: unknown): {
  head: string;
  tree: string;
} {
  const record = assertRecord(value);
  assertExactKeys(record, ['head', 'tree']);
  assertGitObjectId(record.head);
  assertGitObjectId(record.tree);
  if (record.head.length !== record.tree.length) {
    throw unrepresentable('Requirement baseline object formats disagree.');
  }
  return { head: record.head, tree: record.tree };
}

function normalizeCoverageTier(
  value: unknown,
): InvestigationPlanReviewCoveragePayloadV3['coverageTier'] {
  if (value !== 'standard' && value !== 'elevated' && value !== 'critical') {
    throw unrepresentable('PlanReview coverage tier is malformed.');
  }
  return value;
}

function normalizeCoverageSource(
  value: unknown,
): InvestigationPlanReviewCoverageTargetBindingV3['source'] {
  if (
    value !== 'planned-mutation' &&
    value !== 'investigation-target' &&
    value !== 'carried-ledger-subject'
  ) {
    throw unrepresentable('PlanReview coverage source is malformed.');
  }
  return value;
}

function normalizeReviewStratum(
  value: unknown,
): InvestigationPlanReviewCoverageTargetV3['stratum'] {
  if (
    value !== 'planned-mutation' &&
    value !== 'hard-risk' &&
    value !== 'largest-blast-radius' &&
    value !== 'degraded-extraction' &&
    value !== 'unresolved-uncertainty' &&
    value !== 'production-consumer' &&
    value !== 'test-or-mirror' &&
    value !== 'contract-or-schema' &&
    value !== 'cli-or-integration' &&
    value !== 'cross-module'
  ) {
    throw unrepresentable('PlanReview coverage stratum is malformed.');
  }
  return value;
}

function canonicalStructuredTextArray(
  value: unknown,
  label: string,
  allowEmpty: boolean,
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw unrepresentable(`${label} are malformed.`);
  }
  const normalized = value
    .map((entry) => canonicalStructuredText(entry, label))
    .sort();
  assertUnique(normalized, label);
  return normalized;
}

function canonicalStructuredText(
  value: unknown,
  label: string,
  maxBytes = MAX_TEXT_BYTES,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /\p{Cc}/u.test(value)
  ) {
    throw unrepresentable(`${label} is malformed.`);
  }
  return value;
}

function canonicalRequirementPath(value: unknown): string {
  const path = canonicalStructuredText(value, 'requirement repository path');
  if (
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw unrepresentable('Requirement repository path is malformed.');
  }
  return path;
}

function canonicalSemanticSubjectId(value: unknown): string {
  if (typeof value !== 'string' || !SEMANTIC_SUBJECT_ID.test(value)) {
    throw unrepresentable('Semantic subject identity is malformed.');
  }
  return value;
}

function prefixedDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !PREFIXED_DIGEST.test(value)) {
    throw unrepresentable(`${label} is malformed.`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unrepresentable(`${label} is malformed.`);
  }
  return value as number;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw unrepresentable(`${label} is malformed.`);
  }
  return value as number;
}

function safeIntegerSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw unrepresentable('Requirement cost total exceeds safe integer range.');
  }
  return sum;
}
