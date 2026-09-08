import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { digest, unrepresentable, assertUnique, assertRecord, normalizeSemanticAuthor, assertDigest, assertExactKeys, rawSha256, assertGitObjectId, MAX_TEXT_BYTES, } from "./investigation-manifest-values.js";
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
export function normalizeRequirements(values) {
    return normalizeInvestigationRequirementsV3(values);
}
export function assertOrdinaryPlanReviewCoverageBinding(input) {
    const coverageRequirements = input.requirements.filter((requirement) => requirement.kind === 'plan-review-coverage-requirement');
    if (coverageRequirements.length !== 1) {
        throw unrepresentable('Ordinary Investigation Manifest requires exactly one PlanReview coverage requirement.');
    }
    const coverage = coverageRequirements[0].coverage;
    if (coverage.changeId !== input.expected.changeId ||
        coverage.investigationId !== input.expected.investigationId ||
        coverage.baselineCommit !== input.expected.baseline.commitOid ||
        coverage.baselineTree !== input.expected.baseline.treeOid) {
        throw unrepresentable('PlanReview coverage requirement does not match its parent Manifest identity and replay baseline.');
    }
}
/** Shared strict parser for serialized v3 requirement arrays. */
export function normalizeInvestigationRequirementsV3(value) {
    if (!Array.isArray(value) || value.length > MAX_STRUCTURED_REQUIREMENTS) {
        throw unrepresentable('Investigation requirements are malformed.');
    }
    const requirements = value.map(assertInvestigationRequirementV3);
    const sorted = requirements.sort((left, right) => left.requirementId.localeCompare(right.requirementId));
    assertUnique(sorted.map(({ requirementId }) => requirementId), 'requirement IDs');
    return sorted;
}
export function assertInvestigationRequirementV3(value) {
    const record = assertRecord(value);
    const requirementId = canonicalStructuredText(record.requirementId, 'requirement ID');
    const semanticAuthor = normalizeSemanticAuthor(record.semanticAuthor);
    assertDigest(record.provenanceDigest);
    const metadata = {
        requirementId,
        semanticAuthor,
        provenanceDigest: record.provenanceDigest,
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
            reconciliation: normalizeImplementationReconciliationPayload(record.reconciliation),
        };
    }
    if (record.kind !== undefined &&
        record.kind !== 'investigation-requirement') {
        throw unrepresentable('Investigation requirement kind is malformed.');
    }
    assertExactKeys(record, record.kind === undefined
        ? ['requirementId', 'text', 'semanticAuthor', 'provenanceDigest']
        : ['kind', 'requirementId', 'text', 'semanticAuthor', 'provenanceDigest']);
    return {
        ...(record.kind === undefined
            ? {}
            : { kind: 'investigation-requirement' }),
        ...metadata,
        text: canonicalStructuredText(record.text, 'investigation requirement'),
    };
}
function normalizePlanReviewCoveragePayload(value) {
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
    if (record.schemaVersion !== 2 ||
        record.kind !== 'plan-review-coverage-requirement' ||
        record.activation !== 'global') {
        throw unrepresentable('PlanReview coverage requirement is malformed.');
    }
    const investigationId = canonicalStructuredText(record.investigationId, 'coverage investigation ID');
    const changeId = canonicalStructuredText(record.changeId, 'coverage change ID');
    const baseline = normalizeRequirementBaseline({
        head: record.baselineCommit,
        tree: record.baselineTree,
    });
    const coverageTier = normalizeCoverageTier(record.coverageTier);
    assertDigest(record.sealedSamplingSeed);
    if (record.coveragePolicyDigest !== GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST_V3) {
        throw unrepresentable('PlanReview coverage policy digest is stale.');
    }
    const targetBindings = normalizeCoverageTargetBindings(record.targetBindings);
    const semanticReuse = normalizeSemanticReuseCoverage(record.semanticReuse);
    assertSemanticReuseMatchesBindings(semanticReuse, targetBindings);
    const manifest = coverageManifestFromBindings(coverageTier, targetBindings);
    const requiredTargetIds = requiredCoverageTargetIds(manifest, record.sealedSamplingSeed, GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST_V3);
    const costProfile = coverageCostProfile(targetBindings);
    if (canonicalJson(record.manifest) !== canonicalJson(manifest) ||
        canonicalJson(record.requiredTargetIds) !==
            canonicalJson(requiredTargetIds) ||
        canonicalJson(record.costProfile) !== canonicalJson(costProfile)) {
        throw unrepresentable('PlanReview coverage derived commitments do not match their targets.');
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
        sealedSamplingSeed: record.sealedSamplingSeed,
        coveragePolicyDigest: GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST_V3,
        manifest,
        requiredTargetIds,
        targetBindings,
        semanticReuse,
        costProfile,
    };
}
function normalizeCoverageTargetBindings(value) {
    if (!Array.isArray(value) || value.length > MAX_STRUCTURED_REQUIREMENTS) {
        throw unrepresentable('PlanReview coverage targets are malformed.');
    }
    const bindings = value.map(normalizeCoverageTargetBinding);
    const sorted = bindings.sort((left, right) => left.targetId.localeCompare(right.targetId));
    assertUnique(sorted.map(({ targetId }) => targetId), 'PlanReview coverage target IDs');
    assertUnique(sorted.map(({ path }) => path), 'PlanReview coverage target paths');
    return sorted;
}
function normalizeCoverageTargetBinding(value) {
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
    const targetDigest = prefixedDigest(record.targetDigest, 'coverage target digest');
    const stratum = normalizeReviewStratum(record.stratum);
    if (typeof record.reusedFromLedger !== 'boolean' ||
        record.evidenceKind !== 'planning-or-repository-location' ||
        (record.evidenceMode !== 'bounded-context' &&
            record.evidenceMode !== 'full-blob') ||
        typeof record.degradedExtraction !== 'boolean') {
        throw unrepresentable('PlanReview coverage target is malformed.');
    }
    const reusedFromLedger = record.reusedFromLedger;
    const subjectId = record.subjectId === null
        ? null
        : canonicalSemanticSubjectId(record.subjectId);
    const ledgerEntryId = record.ledgerEntryId === null
        ? null
        : prefixedDigest(record.ledgerEntryId, 'semantic ledger entry ID');
    if ((reusedFromLedger && (subjectId === null || ledgerEntryId === null)) ||
        (!reusedFromLedger && (subjectId !== null || ledgerEntryId !== null)) ||
        (reusedFromLedger && record.evidenceMode !== 'bounded-context') ||
        (!reusedFromLedger && source === 'carried-ledger-subject')) {
        throw unrepresentable('PlanReview coverage reuse binding is inconsistent.');
    }
    const invariants = canonicalStructuredTextArray(record.invariants, 'coverage invariants', false);
    const riskFactors = canonicalStructuredTextArray(record.riskFactors, 'coverage risk factors', false);
    const freshness = canonicalStructuredText(record.freshness, 'coverage freshness', 256);
    const costRecord = assertRecord(record.cost);
    assertExactKeys(costRecord, ['rawBytes', 'reviewUnits']);
    const rawBytes = nonNegativeSafeInteger(costRecord.rawBytes, 'coverage raw bytes');
    const reviewUnits = positiveSafeInteger(costRecord.reviewUnits, 'coverage review units');
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
    };
    const targetId = `review-target:${rawSha256(canonicalJson({ schema: 'plan-review-target-binding.v2', ...normalized }))}`;
    if (record.targetId !== targetId) {
        throw unrepresentable('PlanReview coverage target identity is stale.');
    }
    return {
        targetId,
        ...normalized,
        evidenceKind: 'planning-or-repository-location',
    };
}
function normalizeSemanticReuseCoverage(value) {
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
    if (record.schemaVersion !== 1 ||
        record.kind !== 'semantic-reuse-coverage' ||
        !Array.isArray(record.carried) ||
        !Array.isArray(record.resolutions) ||
        !Array.isArray(record.reviewTargets)) {
        throw unrepresentable('Semantic reuse coverage is malformed.');
    }
    const owedCount = nonNegativeSafeInteger(record.owedCount, 'semantic reuse owed count');
    const carriedCount = nonNegativeSafeInteger(record.carriedCount, 'semantic reuse carried count');
    const carried = record.carried.map((entry) => {
        const carriedRecord = assertRecord(entry);
        assertExactKeys(carriedRecord, [
            'manifestEntryId',
            'subjectId',
            'ledgerEntryId',
        ]);
        return {
            manifestEntryId: canonicalStructuredText(carriedRecord.manifestEntryId, 'reuse manifest entry ID'),
            subjectId: canonicalSemanticSubjectId(carriedRecord.subjectId),
            ledgerEntryId: prefixedDigest(carriedRecord.ledgerEntryId, 'reuse ledger entry ID'),
        };
    });
    const resolutions = record.resolutions.map((entry) => {
        const resolutionRecord = assertRecord(entry);
        assertExactKeys(resolutionRecord, ['subjectId', 'resolution', 'state']);
        return {
            subjectId: canonicalSemanticSubjectId(resolutionRecord.subjectId),
            resolution: canonicalStructuredText(resolutionRecord.resolution, 'semantic reuse resolution'),
            state: canonicalStructuredText(resolutionRecord.state, 'semantic reuse state'),
        };
    });
    const reviewTargets = record.reviewTargets.map(normalizeCoverageReviewTarget);
    if (carried.length !== carriedCount ||
        reviewTargets.length !== owedCount + carriedCount) {
        throw unrepresentable('Semantic reuse counts are inconsistent.');
    }
    assertUnique(carried.map(({ manifestEntryId }) => manifestEntryId), 'reuse manifest entry IDs');
    assertUnique(reviewTargets.map(({ targetId }) => targetId), 'reuse review target IDs');
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
function normalizeCoverageReviewTarget(value) {
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
function assertSemanticReuseMatchesBindings(reuse, bindings) {
    const carriedBindings = bindings.filter(({ reusedFromLedger }) => reusedFromLedger);
    if (reuse.carriedCount !== carriedBindings.length ||
        reuse.carried.some(({ subjectId, ledgerEntryId }) => !carriedBindings.some((binding) => binding.subjectId === subjectId &&
            binding.ledgerEntryId === ledgerEntryId))) {
        throw unrepresentable('Semantic reuse coverage does not match PlanReview targets.');
    }
}
function coverageManifestFromBindings(tier, bindings) {
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
        populationDigest: rawSha256(targets
            .map(({ targetId, stratum }) => `${targetId} ${stratum}`)
            .join('\n')),
    };
}
function requiredCoverageTargetIds(manifest, seed, policyDigest) {
    if (manifest.tier === 'critical') {
        return manifest.targets.map(({ targetId }) => targetId);
    }
    const mandatoryStrata = new Set([
        'planned-mutation',
        'hard-risk',
        'largest-blast-radius',
        'degraded-extraction',
        'unresolved-uncertainty',
    ]);
    const mandatory = manifest.targets.filter(({ stratum }) => mandatoryStrata.has(stratum));
    const remainder = manifest.targets.filter(({ stratum }) => !mandatoryStrata.has(stratum));
    const proportion = manifest.tier === 'elevated' ? 0.5 : 0.2;
    const sampleSize = Math.min(remainder.length, Math.max(remainder.length === 0 ? 0 : 1, Math.ceil(remainder.length * proportion)));
    const sampled = [...remainder]
        .sort((left, right) => rawSha256(`${seed} ${manifest.populationDigest} ${policyDigest} ${left.targetId}`).localeCompare(rawSha256(`${seed} ${manifest.populationDigest} ${policyDigest} ${right.targetId}`)))
        .slice(0, sampleSize);
    return [...mandatory, ...sampled].map(({ targetId }) => targetId).sort();
}
function coverageCostProfile(bindings) {
    const rawBytes = bindings.reduce((sum, { cost }) => safeIntegerSum(sum, cost.rawBytes), 0);
    const reviewUnits = bindings.reduce((sum, { cost }) => safeIntegerSum(sum, cost.reviewUnits), 0);
    return { targetCount: bindings.length, rawBytes, reviewUnits };
}
function normalizeImplementationReconciliationPayload(value) {
    const record = assertRecord(value);
    assertExactKeys(record, [
        'schemaVersion',
        'kind',
        'changeId',
        'baseline',
        'policyDigest',
        'plannedMutations',
    ]);
    if (record.schemaVersion !== 1 ||
        record.kind !== 'implementation-reconciliation-requirement' ||
        record.policyDigest !== IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST_V3 ||
        !Array.isArray(record.plannedMutations) ||
        record.plannedMutations.length > MAX_STRUCTURED_REQUIREMENTS) {
        throw unrepresentable('Implementation reconciliation requirement is malformed.');
    }
    const plannedMutations = record.plannedMutations
        .map(normalizeImplementationPlannedMutation)
        .sort((left, right) => left.subjectId.localeCompare(right.subjectId));
    assertUnique(plannedMutations.map(({ subjectId }) => subjectId), 'implementation planned mutation IDs');
    return {
        schemaVersion: 1,
        kind: 'implementation-reconciliation-requirement',
        changeId: canonicalStructuredText(record.changeId, 'implementation reconciliation change ID'),
        baseline: normalizeRequirementBaseline(record.baseline),
        policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST_V3,
        plannedMutations,
    };
}
function normalizeImplementationPlannedMutation(value) {
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
        throw unrepresentable('Implementation planned mutation subject identity is stale.');
    }
    return {
        subjectId,
        path,
        intendedChange: canonicalStructuredText(record.intendedChange, 'implementation intended change'),
        invariantsToPreserve: canonicalStructuredTextArray(record.invariantsToPreserve, 'implementation invariants', true),
    };
}
function normalizeRequirementBaseline(value) {
    const record = assertRecord(value);
    assertExactKeys(record, ['head', 'tree']);
    assertGitObjectId(record.head);
    assertGitObjectId(record.tree);
    if (record.head.length !== record.tree.length) {
        throw unrepresentable('Requirement baseline object formats disagree.');
    }
    return { head: record.head, tree: record.tree };
}
function normalizeCoverageTier(value) {
    if (value !== 'standard' && value !== 'elevated' && value !== 'critical') {
        throw unrepresentable('PlanReview coverage tier is malformed.');
    }
    return value;
}
function normalizeCoverageSource(value) {
    if (value !== 'planned-mutation' &&
        value !== 'investigation-target' &&
        value !== 'carried-ledger-subject') {
        throw unrepresentable('PlanReview coverage source is malformed.');
    }
    return value;
}
function normalizeReviewStratum(value) {
    if (value !== 'planned-mutation' &&
        value !== 'hard-risk' &&
        value !== 'largest-blast-radius' &&
        value !== 'degraded-extraction' &&
        value !== 'unresolved-uncertainty' &&
        value !== 'production-consumer' &&
        value !== 'test-or-mirror' &&
        value !== 'contract-or-schema' &&
        value !== 'cli-or-integration' &&
        value !== 'cross-module') {
        throw unrepresentable('PlanReview coverage stratum is malformed.');
    }
    return value;
}
function canonicalStructuredTextArray(value, label, allowEmpty) {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
        throw unrepresentable(`${label} are malformed.`);
    }
    const normalized = value
        .map((entry) => canonicalStructuredText(entry, label))
        .sort();
    assertUnique(normalized, label);
    return normalized;
}
function canonicalStructuredText(value, label, maxBytes = MAX_TEXT_BYTES) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.trim() !== value ||
        Buffer.byteLength(value, 'utf8') > maxBytes ||
        /\p{Cc}/u.test(value)) {
        throw unrepresentable(`${label} is malformed.`);
    }
    return value;
}
function canonicalRequirementPath(value) {
    const path = canonicalStructuredText(value, 'requirement repository path');
    if (path.startsWith('/') ||
        path.endsWith('/') ||
        path.includes('\\') ||
        path
            .split('/')
            .some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw unrepresentable('Requirement repository path is malformed.');
    }
    return path;
}
function canonicalSemanticSubjectId(value) {
    if (typeof value !== 'string' || !SEMANTIC_SUBJECT_ID.test(value)) {
        throw unrepresentable('Semantic subject identity is malformed.');
    }
    return value;
}
function prefixedDigest(value, label) {
    if (typeof value !== 'string' || !PREFIXED_DIGEST.test(value)) {
        throw unrepresentable(`${label} is malformed.`);
    }
    return value;
}
function nonNegativeSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw unrepresentable(`${label} is malformed.`);
    }
    return value;
}
function positiveSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw unrepresentable(`${label} is malformed.`);
    }
    return value;
}
function safeIntegerSum(left, right) {
    const sum = left + right;
    if (!Number.isSafeInteger(sum)) {
        throw unrepresentable('Requirement cost total exceeds safe integer range.');
    }
    return sum;
}
