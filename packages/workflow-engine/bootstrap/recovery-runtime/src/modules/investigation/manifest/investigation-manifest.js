import crypto from 'node:crypto';
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { WorkflowError } from "../../../foundation/errors/errors.js";
import { createInvestigationApplicability, } from "../domain/investigation-applicability.js";
import { INVESTIGATION_ROOT_CANONICALIZATION_VERSION, INVESTIGATION_TERM_NORMALIZATION_VERSION, } from "../domain/investigation-roots.js";
import { materializeInvestigationEvidenceView, } from "./investigation-materializer.js";
import { normalizeInvestigationTerm, } from "../domain/investigation-terms.js";
const DIGEST = /^[0-9a-f]{64}$/;
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMANTIC_SUBJECT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ASSURANCE_FACT_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_STRUCTURED_REQUIREMENTS = 4_096;
const SEMANTIC_ASSURANCE = 'actor-attested-not-engine-verified';
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
export const INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION = 3;
export const INVESTIGATION_MANIFEST_V3_KIND = 'manifest-first-investigation';
export const INVESTIGATION_V3_KNOWN_FAILURE_CODES = [
    'SCHEMA_V1_FORBIDDEN',
    'TERM_INTEGRITY_MISMATCH',
    'REPLAY_INPUT_MISSING',
    'REPLAY_CLOSURE_UNSUPPORTED',
    'MANIFEST_UNREPRESENTABLE',
    'RECONSTRUCTION_MISMATCH',
    'SEMANTIC_COMPLETENESS_FAILURE',
    'SOURCE_ANCHOR_UNRESOLVED',
    'REVIEW_TARGET_STALE',
    'PROJECTION_PIPELINE_FORBIDDEN',
    'PUBLICATION_RECOVERY_REQUIRED',
];
export const INVESTIGATION_V3_ATTEMPTED_TRANSITIONS = [
    'build-draft',
    'draft-seal',
    'authority-validation',
    'publication',
];
/**
 * Structured v3 failure emitter. This is deliberately only a failure contract:
 * it issues, stores, consumes, or binds no continuation grant.
 */
export function createInvestigationV3Blocker(input) {
    return blockedWithCode(input.attemptedTransition, input.candidate, input.failureCode, input.message, input.details).blocker;
}
/**
 * Converts an engine exception through the same normalization path used by the
 * built-in v3 transition emitters.
 */
export function createInvestigationV3BlockerFromError(input) {
    return blocked(input.attemptedTransition, input.candidate, input.error)
        .blocker;
}
export function parseInvestigationV3Blocker(value) {
    const record = assertRecord(value);
    assertExactKeys(record, [
        'schemaVersion',
        'kind',
        'failureIdentity',
        'attemptedTransition',
        'candidateDigest',
        'failureCode',
        'detailsDigest',
        'missingAssuranceFacts',
    ]);
    if (record.schemaVersion !== 1 ||
        record.kind !== 'investigation-v3-failure' ||
        typeof record.failureIdentity !== 'string' ||
        !DIGEST.test(record.failureIdentity) ||
        !INVESTIGATION_V3_ATTEMPTED_TRANSITIONS.includes(record.attemptedTransition) ||
        typeof record.candidateDigest !== 'string' ||
        !DIGEST.test(record.candidateDigest) ||
        !isSafeInvestigationV3FailureCode(record.failureCode) ||
        typeof record.detailsDigest !== 'string' ||
        !DIGEST.test(record.detailsDigest) ||
        !Array.isArray(record.missingAssuranceFacts) ||
        !record.missingAssuranceFacts.every((fact) => typeof fact === 'string' && ASSURANCE_FACT_ID.test(fact)) ||
        new Set(record.missingAssuranceFacts).size !==
            record.missingAssuranceFacts.length ||
        canonicalJson(record.missingAssuranceFacts) !==
            canonicalJson([...record.missingAssuranceFacts].sort())) {
        throw unrepresentable('Investigation v3 blocker is malformed.');
    }
    const blocker = {
        schemaVersion: 1,
        kind: 'investigation-v3-failure',
        failureIdentity: record.failureIdentity,
        attemptedTransition: record.attemptedTransition,
        candidateDigest: record.candidateDigest,
        failureCode: record.failureCode,
        detailsDigest: record.detailsDigest,
        missingAssuranceFacts: [...record.missingAssuranceFacts],
    };
    const expectedIdentity = digestWithDomain('investigation-v3-failure/v1', {
        attemptedTransition: blocker.attemptedTransition,
        candidateDigest: blocker.candidateDigest,
        failureCode: blocker.failureCode,
        detailsDigest: blocker.detailsDigest,
        missingAssuranceFacts: blocker.missingAssuranceFacts,
    });
    if (blocker.failureIdentity !== expectedIdentity) {
        throw unrepresentable('Investigation v3 blocker identity does not match its facts.');
    }
    return deepFreeze(blocker);
}
export function buildInvestigationManifestDraft(input) {
    try {
        const identity = normalizeAuthoringIdentity(input.state);
        const intentDigest = digest(identity.normalizedIntent);
        const applicability = input.state.applicabilityKind === 'ordinary'
            ? buildOrdinaryApplicability(input.repositoryRoot, input.state, identity)
            : buildExemptionApplicability(input.state, intentDigest);
        return {
            outcome: 'built',
            draft: deepFreeze({
                schemaVersion: INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
                kind: INVESTIGATION_MANIFEST_V3_KIND,
                repositoryId: identity.repositoryId,
                changeId: identity.changeId,
                investigationId: identity.investigationId,
                normalizedIntent: identity.normalizedIntent,
                intentDigest,
                authoring: identity.authoring,
                applicability,
                investigationApproval: null,
                manifestDigest: null,
            }),
        };
    }
    catch (error) {
        return blocked('build-draft', input.state, error);
    }
}
export function validateDraftForSeal(input) {
    try {
        const draft = parseDraft(input.repositoryRoot, input.draft);
        const applicabilityContentDigest = digestWithDomain('investigation-applicability-content/v3', draft.applicability);
        return {
            outcome: 'verified',
            draft,
            applicabilityContentDigest,
            investigationTargetDigest: investigationTargetDigest(draft, applicabilityContentDigest),
        };
    }
    catch (error) {
        return blocked('draft-seal', input.draft, error);
    }
}
export function sealInvestigationManifestDraft(input) {
    try {
        assertDraftShape(input.draft);
        const semanticAuthor = normalizeSemanticAuthor(input.approval.semanticAuthor);
        assertDigest(input.approval.approvalProvenanceDigest);
        const applicabilityContentDigest = digestWithDomain('investigation-applicability-content/v3', input.draft.applicability);
        const targetDigest = investigationTargetDigest(input.draft, applicabilityContentDigest);
        const approvalWithoutSeal = {
            schemaVersion: 1,
            kind: 'investigation-approval',
            investigationTargetDigest: targetDigest,
            semanticAuthor,
            approvalProvenanceDigest: input.approval.approvalProvenanceDigest,
            semanticAssurance: SEMANTIC_ASSURANCE,
        };
        const investigationApproval = {
            ...approvalWithoutSeal,
            sealDigest: digestWithDomain('investigation-approval-seal/v3', approvalWithoutSeal),
        };
        const withoutManifestDigest = {
            ...input.draft,
            investigationApproval,
            manifestDigest: undefined,
        };
        delete withoutManifestDigest
            .manifestDigest;
        const manifestDigest = digestWithDomain('investigation-manifest/v3', withoutManifestDigest);
        return {
            outcome: 'sealed',
            manifest: deepFreeze({
                ...input.draft,
                investigationApproval,
                manifestDigest,
            }),
        };
    }
    catch (error) {
        return blocked('draft-seal', input.draft, error);
    }
}
export function validateForAuthority(input) {
    if (isRecord(input.manifest) && input.manifest.schemaVersion === 1) {
        return blockedWithCode('authority-validation', input.manifest, 'SCHEMA_V1_FORBIDDEN', 'Schema v1 cannot satisfy the v3 authority boundary.');
    }
    try {
        const manifest = parseFinalManifest(input.repositoryRoot, input.manifest);
        if (manifest.repositoryId !== input.expected.repositoryId ||
            manifest.changeId !== input.expected.changeId ||
            manifest.investigationId !== input.expected.investigationId ||
            manifest.authoring.sessionRevision !== input.expected.sessionRevision ||
            manifest.authoring.sessionSnapshotDigest !==
                input.expected.sessionSnapshotDigest) {
            throw new ManifestValidationError('REVIEW_TARGET_STALE', 'Manifest identity no longer matches the lifecycle authority snapshot.');
        }
        return {
            outcome: 'verified',
            manifest,
            manifestDigest: manifest.manifestDigest,
            investigationTargetDigest: manifest.investigationApproval.investigationTargetDigest,
        };
    }
    catch (error) {
        return blocked('authority-validation', input.manifest, error);
    }
}
function buildOrdinaryApplicability(repositoryRoot, state, parentIdentity) {
    const termContributions = [...state.ordinary.termContributions]
        .map((value) => structuredClone(value))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const semanticGroupDecisions = normalizeSemanticGroupDecisions(state.ordinary.semanticGroupDecisions);
    const dispositionDecisions = normalizeDispositionDecisions(state.ordinary.dispositionDecisions);
    const replayAuthoring = {
        baseline: normalizeBaseline(state.ordinary.baseline),
        termContributions,
        canonicalTerms: structuredClone(state.ordinary.canonicalTerms),
        scanner: {
            ...(state.ordinary.scanner.limits === undefined
                ? {}
                : { limits: structuredClone(state.ordinary.scanner.limits) }),
            allowSaturatedTerms: state.ordinary.scanner.allowSaturatedTerms === true,
            saturationDecision: normalizeSaturationDecision(state.ordinary.scanner.saturationDecision),
        },
        grouping: {
            mutationPolicy: structuredClone(state.ordinary.grouping.mutationPolicy),
            declaredRoots: [...state.ordinary.grouping.declaredRoots]
                .map((value) => structuredClone(value))
                .sort((left, right) => left.rootId.localeCompare(right.rootId)),
            reviewedRelationships: [...state.ordinary.grouping.reviewedRelationships]
                .map((value) => structuredClone(value))
                .sort((left, right) => left.relationshipId.localeCompare(right.relationshipId)),
        },
        semanticGroupDecisions,
        dispositionDecisions,
    };
    assertIntentFloor(state.normalizedIntent, replayAuthoring.canonicalTerms);
    const view = materializeInvestigationEvidenceView({
        repositoryRoot,
        authoring: replayAuthoring,
    });
    const investigationRoleResults = normalizeRoleResults(state.ordinary.investigationRoleResults);
    if (!investigationRoleResults.some(({ role }) => role === 'blind-surveyor')) {
        throw new ManifestValidationError('SEMANTIC_COMPLETENESS_FAILURE', 'Ordinary investigation requires an admitted blind-surveyor result.');
    }
    const whyOverlays = normalizeWhyOverlays(state.ordinary.whyOverlays);
    const knowledgeReuseDecisions = normalizeKnowledgeReuseDecisions(state.ordinary.knowledgeReuseDecisions);
    validateWhyCoverage(view, whyOverlays, knowledgeReuseDecisions);
    const exceptions = normalizeExceptions(state.ordinary.exceptions);
    const investigationRequirements = normalizeRequirements(state.ordinary.investigationRequirements);
    assertOrdinaryPlanReviewCoverageBinding({
        requirements: investigationRequirements,
        expected: {
            changeId: parentIdentity.changeId,
            investigationId: parentIdentity.investigationId,
            baseline: replayAuthoring.baseline,
        },
    });
    const assuranceFacts = normalizeAssuranceFacts(state.ordinary.assuranceFacts);
    const floorOverflowDecision = normalizeFloorOverflowDecision(state.ordinary.floorOverflowDecision);
    const persistedDispositions = persistedDispositionsFrom(view.dispositions);
    return deepFreeze({
        kind: 'ordinary',
        replayContract: {
            baseline: replayAuthoring.baseline,
            termContributions,
            canonicalTerms: view.canonicalTerms,
            termNormalizationVersion: INVESTIGATION_TERM_NORMALIZATION_VERSION,
            termSetDigest: view.termSetDigest,
            scanner: {
                evaluatorId: 'investigation-scanner.v1',
                policyDigest: view.scanFacts.policyDigest,
                canonicalizationVersion: 'investigation-scan-canonicalization.v1',
                limits: view.limits,
                allowSaturatedTerms: replayAuthoring.scanner.allowSaturatedTerms,
            },
            grouping: {
                evaluatorId: 'investigation-groups.v1',
                policyDigest: view.grouping.groupingPolicyDigest,
                canonicalizationVersion: 'investigation-mechanical-groups.v3',
                mutationPolicy: replayAuthoring.grouping.mutationPolicy,
                declaredRoots: replayAuthoring.grouping.declaredRoots,
                reviewedRelationships: replayAuthoring.grouping.reviewedRelationships,
            },
            coverage: {
                evaluatorId: 'investigation-coverage.v3',
                canonicalizationVersion: INVESTIGATION_ROOT_CANONICALIZATION_VERSION,
            },
            inventoryRoot: view.commitments.inventoryRoot,
            hitRoot: view.commitments.hitRoot,
            mechanicalGroupRoot: view.commitments.mechanicalGroupRoot,
            counts: {
                terms: view.canonicalTerms.length,
                hits: view.commitments.hitCount,
                mechanicalGroups: view.commitments.mechanicalGroupCount,
            },
        },
        semanticDelta: {
            investigationRoleResults,
            scanSaturationDecision: replayAuthoring.scanner.saturationDecision,
            floorOverflowDecision,
            semanticGroupDecisions,
            finalGroupRoot: view.commitments.finalGroupRoot,
            dispositions: persistedDispositions,
            whyOverlays,
            knowledgeReuseDecisions,
            exceptions,
            investigationRequirements,
            assuranceFacts,
        },
        derivedCommitments: {
            coverageRoot: view.commitments.coverageRoot,
            zeroHitTermIds: view.commitments.zeroHitTermIds,
            finalGroupCount: view.commitments.finalGroupCount,
        },
    });
}
function buildExemptionApplicability(state, intentDigest) {
    const baseline = normalizeBaseline(state.exemption.baseline);
    const applicability = createInvestigationApplicability({
        kind: 'investigation-exemption',
        category: state.exemption.category,
        baseline: { head: baseline.commitOid, tree: baseline.treeOid },
        intentDigest,
        declaredPaths: structuredClone(state.exemption.declaredPaths),
        declaredChangeClasses: structuredClone(state.exemption.declaredChangeClasses),
        rationale: state.exemption.rationale,
        semanticAuthor: structuredClone(state.exemption.semanticAuthor),
        nonTrivialBehaviorReliance: state.exemption.nonTrivialBehaviorReliance,
        researchBudgetMinutes: state.exemption.researchBudgetMinutes,
    });
    if (applicability.kind !== 'investigation-exemption') {
        throw new ManifestValidationError('MANIFEST_UNREPRESENTABLE', 'Exemption applicability normalization selected the wrong branch.');
    }
    return deepFreeze({
        kind: 'exemption',
        category: applicability.category,
        baseline,
        declaredPaths: [...applicability.declaredPaths],
        declaredChangeClasses: [...applicability.declaredChangeClasses],
        rationale: applicability.rationale,
        semanticAuthor: applicability.semanticAuthor,
        nonTrivialBehaviorReliance: applicability.nonTrivialBehaviorReliance,
        researchBudgetMinutes: applicability.researchBudgetMinutes,
        policyDigest: applicability.policyDigest,
        applicabilityDigest: applicability.applicabilityDigest,
    });
}
function parseDraft(repositoryRoot, value) {
    const record = assertManifestTop(value);
    if (record.investigationApproval !== null || record.manifestDigest !== null) {
        throw unrepresentable('Draft contains final approval state.');
    }
    const identity = parseManifestIdentity(record);
    const applicability = parseApplicability(repositoryRoot, identity, record.applicability);
    return deepFreeze({
        ...identity,
        applicability,
        investigationApproval: null,
        manifestDigest: null,
    });
}
function parseFinalManifest(repositoryRoot, value) {
    const record = assertManifestTop(value);
    const identity = parseManifestIdentity(record);
    const applicability = parseApplicability(repositoryRoot, identity, record.applicability);
    const draft = {
        ...identity,
        applicability,
        investigationApproval: null,
        manifestDigest: null,
    };
    const approval = parseApproval(record.investigationApproval);
    const applicabilityContentDigest = digestWithDomain('investigation-applicability-content/v3', applicability);
    const targetDigest = investigationTargetDigest(draft, applicabilityContentDigest);
    if (approval.investigationTargetDigest !== targetDigest) {
        throw new ManifestValidationError('REVIEW_TARGET_STALE', 'Investigation approval targets different Manifest content.');
    }
    const approvalWithoutSeal = { ...approval };
    delete approvalWithoutSeal.sealDigest;
    if (approval.sealDigest !==
        digestWithDomain('investigation-approval-seal/v3', approvalWithoutSeal)) {
        throw new ManifestValidationError('RECONSTRUCTION_MISMATCH', 'Investigation approval seal does not match recomputation.');
    }
    if (typeof record.manifestDigest !== 'string') {
        throw unrepresentable('Final Manifest digest is absent.');
    }
    assertDigest(record.manifestDigest);
    const withoutManifestDigest = {
        ...identity,
        applicability,
        investigationApproval: approval,
    };
    const expectedManifestDigest = digestWithDomain('investigation-manifest/v3', withoutManifestDigest);
    if (record.manifestDigest !== expectedManifestDigest) {
        throw new ManifestValidationError('RECONSTRUCTION_MISMATCH', 'Manifest digest does not match the exact final Manifest.');
    }
    return deepFreeze({
        ...withoutManifestDigest,
        manifestDigest: expectedManifestDigest,
    });
}
function parseApplicability(repositoryRoot, identity, value) {
    if (!isRecord(value) || typeof value.kind !== 'string') {
        throw unrepresentable('Manifest applicability branch is malformed.');
    }
    if (value.kind === 'exemption') {
        assertExactKeys(value, [
            'kind',
            'category',
            'baseline',
            'declaredPaths',
            'declaredChangeClasses',
            'rationale',
            'semanticAuthor',
            'nonTrivialBehaviorReliance',
            'researchBudgetMinutes',
            'policyDigest',
            'applicabilityDigest',
        ]);
        const state = {
            schemaVersion: 1,
            applicabilityKind: 'exemption',
            repositoryId: identity.repositoryId,
            changeId: identity.changeId,
            investigationId: identity.investigationId,
            normalizedIntent: identity.normalizedIntent,
            authoring: identity.authoring,
            exemption: {
                category: value.category,
                baseline: value.baseline,
                declaredPaths: value.declaredPaths,
                declaredChangeClasses: value.declaredChangeClasses,
                rationale: value.rationale,
                semanticAuthor: value.semanticAuthor,
                nonTrivialBehaviorReliance: value.nonTrivialBehaviorReliance,
                researchBudgetMinutes: value.researchBudgetMinutes,
            },
        };
        const rebuilt = buildExemptionApplicability(state, identity.intentDigest);
        if (canonicalJson(rebuilt) !== canonicalJson(value)) {
            throw new ManifestValidationError('RECONSTRUCTION_MISMATCH', 'Exemption applicability does not match recomputation.');
        }
        return rebuilt;
    }
    if (value.kind !== 'ordinary') {
        throw unrepresentable('Unknown Manifest applicability branch.');
    }
    assertExactKeys(value, [
        'kind',
        'replayContract',
        'semanticDelta',
        'derivedCommitments',
    ]);
    const replay = assertOrdinaryReplayShape(value.replayContract);
    const semantic = assertSemanticDeltaShape(value.semanticDelta);
    assertDerivedCommitmentsShape(value.derivedCommitments);
    const state = {
        schemaVersion: 1,
        applicabilityKind: 'ordinary',
        repositoryId: identity.repositoryId,
        changeId: identity.changeId,
        investigationId: identity.investigationId,
        normalizedIntent: identity.normalizedIntent,
        authoring: identity.authoring,
        ordinary: {
            baseline: replay.baseline,
            termContributions: replay.termContributions,
            canonicalTerms: replay.canonicalTerms,
            scanner: {
                limits: replay.scanner.limits,
                allowSaturatedTerms: replay.scanner.allowSaturatedTerms,
                saturationDecision: semantic.scanSaturationDecision,
            },
            grouping: {
                mutationPolicy: replay.grouping.mutationPolicy,
                declaredRoots: replay.grouping
                    .declaredRoots,
                reviewedRelationships: replay.grouping
                    .reviewedRelationships,
            },
            semanticGroupDecisions: semantic.semanticGroupDecisions,
            dispositionDecisions: persistedToDispositionDecisions(semantic.dispositions),
            whyOverlays: semantic.whyOverlays,
            knowledgeReuseDecisions: semantic.knowledgeReuseDecisions,
            investigationRoleResults: semantic.investigationRoleResults,
            floorOverflowDecision: semantic.floorOverflowDecision,
            exceptions: semantic.exceptions,
            investigationRequirements: semantic.investigationRequirements,
            assuranceFacts: semantic.assuranceFacts,
        },
    };
    const rebuilt = buildOrdinaryApplicability(repositoryRoot, state, identity);
    if (canonicalJson(rebuilt) !== canonicalJson(value)) {
        throw new ManifestValidationError('RECONSTRUCTION_MISMATCH', 'Ordinary Manifest does not match exact Git-backed replay.');
    }
    return rebuilt;
}
function assertOrdinaryReplayShape(value) {
    const replay = assertRecord(value);
    assertExactKeys(replay, [
        'baseline',
        'termContributions',
        'canonicalTerms',
        'termNormalizationVersion',
        'termSetDigest',
        'scanner',
        'grouping',
        'coverage',
        'inventoryRoot',
        'hitRoot',
        'mechanicalGroupRoot',
        'counts',
    ]);
    const scanner = assertRecord(replay.scanner);
    assertExactKeys(scanner, [
        'evaluatorId',
        'policyDigest',
        'canonicalizationVersion',
        'limits',
        'allowSaturatedTerms',
    ]);
    const grouping = assertRecord(replay.grouping);
    assertExactKeys(grouping, [
        'evaluatorId',
        'policyDigest',
        'canonicalizationVersion',
        'mutationPolicy',
        'declaredRoots',
        'reviewedRelationships',
    ]);
    const coverage = assertRecord(replay.coverage);
    assertExactKeys(coverage, ['evaluatorId', 'canonicalizationVersion']);
    const counts = assertRecord(replay.counts);
    assertExactKeys(counts, ['terms', 'hits', 'mechanicalGroups']);
    return { ...replay, scanner, grouping };
}
function assertSemanticDeltaShape(value) {
    const semantic = assertRecord(value);
    assertExactKeys(semantic, [
        'investigationRoleResults',
        'scanSaturationDecision',
        'floorOverflowDecision',
        'semanticGroupDecisions',
        'finalGroupRoot',
        'dispositions',
        'whyOverlays',
        'knowledgeReuseDecisions',
        'exceptions',
        'investigationRequirements',
        'assuranceFacts',
    ]);
    return semantic;
}
function assertDerivedCommitmentsShape(value) {
    const derived = assertRecord(value);
    assertExactKeys(derived, [
        'coverageRoot',
        'zeroHitTermIds',
        'finalGroupCount',
    ]);
}
function persistedDispositionsFrom(dispositions) {
    return dispositions.map(({ coveredHitKeys: _coveredHitKeys, ...disposition }) => disposition);
}
function persistedToDispositionDecisions(value) {
    if (!Array.isArray(value)) {
        throw unrepresentable('Persisted dispositions are malformed.');
    }
    return value.map((entry) => {
        const record = assertRecord(entry);
        assertExactKeys(record, [
            'groupRef',
            'classification',
            'rationale',
            'semanticAuthor',
            'dispositionDigest',
        ]);
        const groupRef = normalizeGroupRef(record.groupRef);
        assertDigest(record.dispositionDigest);
        return {
            groupKey: groupRef.key,
            classification: record.classification,
            rationale: record.rationale,
            semanticAuthor: record.semanticAuthor,
        };
    });
}
function normalizeSemanticGroupDecisions(values) {
    if (!Array.isArray(values)) {
        throw unrepresentable('Semantic Group decisions are malformed.');
    }
    return values
        .map((value) => {
        const record = assertRecord(value);
        assertExactKeys(record, [
            'decisionId',
            'key',
            'title',
            'sourceMechanicalGroupKeys',
            'hitKeys',
            'rationale',
            'semanticAuthor',
        ]);
        return {
            decisionId: boundedText(record.decisionId, 'semantic decision ID'),
            key: boundedText(record.key, 'semantic Group key'),
            title: boundedText(record.title, 'semantic Group title'),
            sourceMechanicalGroupKeys: normalizeDigestArray(record.sourceMechanicalGroupKeys, false),
            hitKeys: normalizeDigestArray(record.hitKeys, false),
            rationale: boundedText(record.rationale, 'semantic Group rationale'),
            semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
        };
    })
        .sort((left, right) => left.decisionId.localeCompare(right.decisionId));
}
function normalizeDispositionDecisions(values) {
    if (!Array.isArray(values)) {
        throw unrepresentable('Disposition decisions are malformed.');
    }
    return values
        .map((value) => {
        const record = assertRecord(value);
        assertExactKeys(record, [
            'groupKey',
            'classification',
            'rationale',
            'semanticAuthor',
        ]);
        return {
            groupKey: boundedText(record.groupKey, 'Disposition Group key'),
            classification: boundedText(record.classification, 'Disposition classification'),
            rationale: boundedText(record.rationale, 'Disposition rationale'),
            semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
        };
    })
        .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}
function normalizeSaturationDecision(value) {
    if (value === null)
        return null;
    const record = assertRecord(value);
    assertExactKeys(record, [
        'saturatedTermIds',
        'acknowledgeIncompleteScan',
        'rationale',
        'semanticAuthor',
        'provenanceDigest',
    ]);
    if (record.acknowledgeIncompleteScan !== true) {
        throw unrepresentable('Scan saturation acknowledgement is malformed.');
    }
    assertDigest(record.provenanceDigest);
    return {
        saturatedTermIds: normalizeDigestArray(record.saturatedTermIds, false),
        acknowledgeIncompleteScan: true,
        rationale: boundedText(record.rationale, 'saturation rationale'),
        semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
        provenanceDigest: record.provenanceDigest,
    };
}
function normalizeRoleResults(values) {
    if (!Array.isArray(values)) {
        throw unrepresentable('Investigation role results are malformed.');
    }
    const results = values.map((value) => {
        const record = assertRecord(value);
        assertExactKeys(record, [
            'role',
            'targetDigest',
            'providerId',
            'sessionId',
            'principalId',
            'requiredIndependence',
            'achievedIndependence',
            'requestDigest',
            'outputDigest',
            'contentDigest',
            'policyDigest',
            'provenanceDigest',
            'grantUse',
            'roleContextSharingUse',
        ]);
        if (record.role !== 'blind-surveyor' &&
            record.role !== 'investigation-reviewer') {
            throw unrepresentable('Investigation role is not investigation-owned.');
        }
        for (const key of [
            'targetDigest',
            'requestDigest',
            'outputDigest',
            'contentDigest',
            'policyDigest',
            'provenanceDigest',
        ]) {
            assertDigest(record[key]);
        }
        const grantUse = normalizeInvestigationGrantUse(record.grantUse);
        const roleContextSharingUse = normalizeInvestigationRoleContextSharingUse(record.roleContextSharingUse);
        if (grantUse !== null && roleContextSharingUse !== null) {
            throw unrepresentable('One investigation role result cannot claim two grant uses.');
        }
        return {
            role: record.role,
            targetDigest: record.targetDigest,
            providerId: nullableText(record.providerId, 'provider ID'),
            sessionId: nullableText(record.sessionId, 'provider session ID'),
            principalId: nullableText(record.principalId, 'provider principal ID'),
            requiredIndependence: boundedText(record.requiredIndependence, 'required independence'),
            achievedIndependence: boundedText(record.achievedIndependence, 'achieved independence'),
            requestDigest: record.requestDigest,
            outputDigest: record.outputDigest,
            contentDigest: record.contentDigest,
            policyDigest: record.policyDigest,
            provenanceDigest: record.provenanceDigest,
            grantUse,
            roleContextSharingUse,
        };
    });
    const sorted = results.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    if (new Set(sorted.map((result) => canonicalJson(result))).size !==
        sorted.length) {
        throw unrepresentable('Investigation role results contain duplicates.');
    }
    return sorted;
}
function normalizeInvestigationGrantUse(value) {
    if (value === null)
        return null;
    const record = assertRecord(value);
    assertExactKeys(record, [
        'kind',
        'grantId',
        'signedEnvelopeDigest',
        'transitionDigest',
    ]);
    if (record.kind !== 'collaboration-grant-use-identity.v1' ||
        typeof record.grantId !== 'string' ||
        !GRANT_ID.test(record.grantId)) {
        throw unrepresentable('Investigation collaboration grant use is malformed.');
    }
    assertDigest(record.signedEnvelopeDigest);
    assertDigest(record.transitionDigest);
    return {
        kind: 'collaboration-grant-use-identity.v1',
        grantId: record.grantId,
        signedEnvelopeDigest: record.signedEnvelopeDigest,
        transitionDigest: record.transitionDigest,
    };
}
function normalizeInvestigationRoleContextSharingUse(value) {
    if (value === null)
        return null;
    const record = assertRecord(value);
    assertExactKeys(record, [
        'kind',
        'grantId',
        'signedEnvelopeDigest',
        'transitionDigest',
        'useProjectionDigest',
        'admissionDigest',
    ]);
    if (record.kind !== 'role-context-sharing-use-identity.v1' ||
        typeof record.grantId !== 'string' ||
        !GRANT_ID.test(record.grantId)) {
        throw unrepresentable('Investigation role-context-sharing grant use is malformed.');
    }
    for (const key of [
        'signedEnvelopeDigest',
        'transitionDigest',
        'useProjectionDigest',
        'admissionDigest',
    ]) {
        assertDigest(record[key]);
    }
    return {
        kind: 'role-context-sharing-use-identity.v1',
        grantId: record.grantId,
        signedEnvelopeDigest: record.signedEnvelopeDigest,
        transitionDigest: record.transitionDigest,
        useProjectionDigest: record.useProjectionDigest,
        admissionDigest: record.admissionDigest,
    };
}
function normalizeAssuranceFacts(value) {
    const record = assertRecord(value);
    assertExactKeys(record, [
        'assessmentDigest',
        'coverageTier',
        'escalated',
        'reasons',
        'provenanceDigest',
    ]);
    assertDigest(record.assessmentDigest);
    assertDigest(record.provenanceDigest);
    if (record.coverageTier !== 'standard' &&
        record.coverageTier !== 'elevated' &&
        record.coverageTier !== 'critical') {
        throw unrepresentable('Assurance coverage tier is malformed.');
    }
    if (typeof record.escalated !== 'boolean') {
        throw unrepresentable('Assurance escalation is malformed.');
    }
    return {
        assessmentDigest: record.assessmentDigest,
        coverageTier: record.coverageTier,
        escalated: record.escalated,
        reasons: normalizeTextArray(record.reasons),
        provenanceDigest: record.provenanceDigest,
    };
}
function normalizeFloorOverflowDecision(value) {
    if (value === null)
        return null;
    const record = assertRecord(value);
    assertExactKeys(record, [
        'schemaVersion',
        'kind',
        'limit',
        'retainedLimit',
        'reservedNonFloorTerms',
        'observed',
        'escalated',
        'reasons',
        'dropped',
    ]);
    if (record.schemaVersion !== 1 ||
        record.kind !== 'floor-overflow-decision' ||
        !Number.isSafeInteger(record.limit) ||
        !Number.isSafeInteger(record.retainedLimit) ||
        !Number.isSafeInteger(record.reservedNonFloorTerms) ||
        !Number.isSafeInteger(record.observed) ||
        record.escalated !== true ||
        !Array.isArray(record.dropped)) {
        throw unrepresentable('Floor-overflow decision is malformed.');
    }
    for (const dropped of record.dropped) {
        const entry = assertRecord(dropped);
        assertExactKeys(entry, ['termId', 'kind', 'value', 'reason']);
        assertDigest(entry.termId);
        boundedText(entry.kind, 'floor term kind');
        boundedText(entry.value, 'floor term value');
        boundedText(entry.reason, 'floor drop reason');
    }
    normalizeTextArray(record.reasons);
    return structuredClone(value);
}
function normalizeWhyOverlays(values) {
    if (!Array.isArray(values)) {
        throw unrepresentable('WHY overlays are malformed.');
    }
    const overlays = values.map((value) => {
        const record = assertRecord(value);
        assertExactKeys(record, [
            'overlayId',
            'pathIdentity',
            'blobOid',
            'contentSha256',
            'groupRefs',
            'anchors',
            'why',
            'protectedInvariant',
            'reviewerQuestion',
            'answer',
            'semanticAuthor',
            'readComplete',
            'semanticAssurance',
        ]);
        if (record.readComplete !== true ||
            record.semanticAssurance !== SEMANTIC_ASSURANCE ||
            !Array.isArray(record.groupRefs) ||
            !Array.isArray(record.anchors) ||
            record.anchors.length === 0) {
            throw unrepresentable('WHY overlay attestation is malformed.');
        }
        assertGitObjectId(record.blobOid);
        assertDigest(record.contentSha256);
        return {
            overlayId: boundedText(record.overlayId, 'WHY overlay ID'),
            pathIdentity: normalizePathIdentity(record.pathIdentity),
            blobOid: record.blobOid,
            contentSha256: record.contentSha256,
            groupRefs: record.groupRefs
                .map(normalizeGroupRef)
                .sort((left, right) => left.index - right.index),
            anchors: record.anchors
                .map(normalizeSourceAnchor)
                .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
            why: boundedText(record.why, 'WHY explanation'),
            protectedInvariant: boundedText(record.protectedInvariant, 'protected invariant'),
            reviewerQuestion: boundedText(record.reviewerQuestion, 'reviewer question'),
            answer: boundedText(record.answer, 'reviewer answer'),
            semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
            readComplete: true,
            semanticAssurance: SEMANTIC_ASSURANCE,
        };
    });
    const sorted = overlays.sort((left, right) => left.overlayId.localeCompare(right.overlayId));
    assertUnique(sorted.map(({ overlayId }) => overlayId), 'WHY overlay IDs');
    return sorted;
}
function normalizeKnowledgeReuseDecisions(values) {
    if (!Array.isArray(values)) {
        throw unrepresentable('Knowledge-reuse decisions are malformed.');
    }
    const decisions = values.map((value) => {
        const record = assertRecord(value);
        assertExactKeys(record, [
            'decisionId',
            'pathIdentity',
            'blobOid',
            'knowledgeRef',
            'freshness',
        ]);
        const knowledgeRef = assertRecord(record.knowledgeRef);
        assertExactKeys(knowledgeRef, ['subjectId', 'versionDigest']);
        assertDigest(knowledgeRef.versionDigest);
        const freshness = assertRecord(record.freshness);
        assertExactKeys(freshness, [
            'decision',
            'rationale',
            'semanticAuthor',
            'provenanceDigest',
        ]);
        if (freshness.decision !== 'fresh') {
            throw unrepresentable('Knowledge reuse is not explicitly fresh.');
        }
        assertGitObjectId(record.blobOid);
        assertDigest(freshness.provenanceDigest);
        return {
            decisionId: boundedText(record.decisionId, 'knowledge decision ID'),
            pathIdentity: normalizePathIdentity(record.pathIdentity),
            blobOid: record.blobOid,
            knowledgeRef: {
                subjectId: boundedText(knowledgeRef.subjectId, 'knowledge subject ID'),
                versionDigest: knowledgeRef.versionDigest,
            },
            freshness: {
                decision: 'fresh',
                rationale: boundedText(freshness.rationale, 'knowledge freshness rationale'),
                semanticAuthor: normalizeSemanticAuthor(freshness.semanticAuthor),
                provenanceDigest: freshness.provenanceDigest,
            },
        };
    });
    const sorted = decisions.sort((left, right) => left.decisionId.localeCompare(right.decisionId));
    assertUnique(sorted.map(({ decisionId }) => decisionId), 'knowledge decision IDs');
    return sorted;
}
function normalizeExceptions(values) {
    if (!Array.isArray(values)) {
        throw unrepresentable('Investigation exceptions are malformed.');
    }
    const exceptions = values.map((value) => {
        const record = assertRecord(value);
        assertExactKeys(record, [
            'exceptionId',
            'kind',
            'subjectKey',
            'rationale',
            'semanticAuthor',
            'provenanceDigest',
        ]);
        if (record.kind !== 'semantic-group' &&
            record.kind !== 'disposition' &&
            record.kind !== 'why' &&
            record.kind !== 'knowledge-reuse') {
            throw unrepresentable('Investigation exception kind is malformed.');
        }
        const kind = record.kind;
        assertDigest(record.provenanceDigest);
        return {
            exceptionId: boundedText(record.exceptionId, 'exception ID'),
            kind,
            subjectKey: boundedText(record.subjectKey, 'exception subject'),
            rationale: boundedText(record.rationale, 'exception rationale'),
            semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
            provenanceDigest: record.provenanceDigest,
        };
    });
    const sorted = exceptions.sort((left, right) => left.exceptionId.localeCompare(right.exceptionId));
    assertUnique(sorted.map(({ exceptionId }) => exceptionId), 'exception IDs');
    return sorted;
}
function normalizeRequirements(values) {
    return normalizeInvestigationRequirementsV3(values);
}
function assertOrdinaryPlanReviewCoverageBinding(input) {
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
function validateWhyCoverage(view, overlays, knowledgeReuse) {
    const hitsByKey = new Map(view.grouping.hits.map((hit) => [hit.hitKey, hit]));
    const required = new Map();
    for (const disposition of view.dispositions) {
        if (disposition.classification !== 'load-bearing')
            continue;
        for (const hitKey of disposition.coveredHitKeys) {
            const hit = hitsByKey.get(hitKey);
            if (hit.sourceObject.contentSha256 === null) {
                throw new ManifestValidationError('SOURCE_ANCHOR_UNRESOLVED', 'Load-bearing source has no replayable blob content.');
            }
            const key = sourceTupleKey(hit.path.rawBase64, hit.sourceObject.objectId);
            let row = required.get(key);
            if (row === undefined) {
                row = {
                    pathIdentity: hit.path,
                    blobOid: hit.sourceObject.objectId,
                    contentSha256: hit.sourceObject.contentSha256,
                    hitKeys: new Set(),
                    groupRefs: new Map(),
                };
                required.set(key, row);
            }
            row.hitKeys.add(hitKey);
            row.groupRefs.set(disposition.groupRef.key, disposition.groupRef);
        }
    }
    const covered = new Set();
    for (const overlay of overlays) {
        const key = sourceTupleKey(overlay.pathIdentity.rawBase64, overlay.blobOid);
        const row = required.get(key);
        if (row === undefined ||
            covered.has(key) ||
            canonicalJson(row.pathIdentity) !== canonicalJson(overlay.pathIdentity) ||
            row.contentSha256 !== overlay.contentSha256) {
            throw new ManifestValidationError('SOURCE_ANCHOR_UNRESOLVED', 'WHY overlay does not map one-to-one to current load-bearing source.');
        }
        const expectedRefs = [...row.groupRefs.values()].sort((left, right) => left.index - right.index);
        if (canonicalJson(expectedRefs) !== canonicalJson(overlay.groupRefs)) {
            throw new ManifestValidationError('SOURCE_ANCHOR_UNRESOLVED', 'WHY overlay Group references are stale.');
        }
        const hitKeysCovered = new Set();
        for (const anchor of overlay.anchors) {
            if (anchor.pathIdentity.rawBase64 !== row.pathIdentity.rawBase64 ||
                anchor.blobOid !== row.blobOid) {
                throw new ManifestValidationError('SOURCE_ANCHOR_UNRESOLVED', 'WHY source anchor targets a different Git object.');
            }
            const match = view.grouping.hits.find((hit) => row.hitKeys.has(hit.hitKey) &&
                hit.termId === anchor.termId &&
                hit.byteOffset === anchor.byteRange.start &&
                hit.byteOffset + hit.byteLength === anchor.byteRange.end);
            if (match === undefined) {
                throw new ManifestValidationError('SOURCE_ANCHOR_UNRESOLVED', 'WHY source anchor does not resolve to a current hit.');
            }
            hitKeysCovered.add(match.hitKey);
        }
        if (hitKeysCovered.size !== row.hitKeys.size) {
            throw new ManifestValidationError('SOURCE_ANCHOR_UNRESOLVED', 'WHY overlay does not anchor every current load-bearing hit.');
        }
        covered.add(key);
    }
    for (const decision of knowledgeReuse) {
        const key = sourceTupleKey(decision.pathIdentity.rawBase64, decision.blobOid);
        const row = required.get(key);
        if (row === undefined ||
            covered.has(key) ||
            canonicalJson(row.pathIdentity) !== canonicalJson(decision.pathIdentity)) {
            throw new ManifestValidationError('SEMANTIC_COMPLETENESS_FAILURE', 'Knowledge reuse does not map one-to-one to current load-bearing source.');
        }
        covered.add(key);
    }
    if (covered.size !== required.size) {
        throw new ManifestValidationError('SEMANTIC_COMPLETENESS_FAILURE', 'Every load-bearing Git path/blob requires one WHY overlay or fresh knowledge reuse.');
    }
}
function normalizeSourceAnchor(value) {
    const record = assertRecord(value);
    assertExactKeys(record, ['pathIdentity', 'blobOid', 'byteRange', 'termId']);
    assertGitObjectId(record.blobOid);
    assertDigest(record.termId);
    const byteRange = assertRecord(record.byteRange);
    assertExactKeys(byteRange, ['start', 'end']);
    if (!Number.isSafeInteger(byteRange.start) ||
        !Number.isSafeInteger(byteRange.end) ||
        byteRange.start < 0 ||
        byteRange.end <= byteRange.start) {
        throw unrepresentable('Source anchor byte range is malformed.');
    }
    return {
        pathIdentity: normalizePathIdentity(record.pathIdentity),
        blobOid: record.blobOid,
        byteRange: {
            start: byteRange.start,
            end: byteRange.end,
        },
        termId: record.termId,
    };
}
function normalizeGroupRef(value) {
    const record = assertRecord(value);
    assertExactKeys(record, ['index', 'key', 'leafDigest']);
    if (!Number.isSafeInteger(record.index) || record.index < 0) {
        throw unrepresentable('Compact Group reference index is malformed.');
    }
    assertDigest(record.leafDigest);
    return {
        index: record.index,
        key: boundedText(record.key, 'compact Group key'),
        leafDigest: record.leafDigest,
    };
}
function normalizePathIdentity(value) {
    const record = assertRecord(value);
    assertExactKeys(record, ['rawBase64', 'utf8']);
    if (typeof record.rawBase64 !== 'string' ||
        (record.utf8 !== null && typeof record.utf8 !== 'string')) {
        throw unrepresentable('Raw Git path identity is malformed.');
    }
    const raw = Buffer.from(record.rawBase64, 'base64');
    if (raw.length === 0 ||
        raw.toString('base64') !== record.rawBase64 ||
        raw.includes(0) ||
        raw[0] === 0x2f ||
        raw.at(-1) === 0x2f) {
        throw unrepresentable('Raw Git path identity is malformed.');
    }
    if (record.utf8 !== null) {
        const utf8 = raw.toString('utf8');
        if (utf8 !== record.utf8 ||
            Buffer.compare(Buffer.from(utf8, 'utf8'), raw) !== 0) {
            throw unrepresentable('Display path does not match raw Git bytes.');
        }
    }
    return { rawBase64: record.rawBase64, utf8: record.utf8 };
}
function normalizeAuthoringIdentity(state) {
    const record = assertRecord(state);
    assertExactKeys(record, state.applicabilityKind === 'ordinary'
        ? [
            'schemaVersion',
            'applicabilityKind',
            'repositoryId',
            'changeId',
            'investigationId',
            'normalizedIntent',
            'authoring',
            'ordinary',
        ]
        : [
            'schemaVersion',
            'applicabilityKind',
            'repositoryId',
            'changeId',
            'investigationId',
            'normalizedIntent',
            'authoring',
            'exemption',
        ]);
    if (record.schemaVersion !== 1) {
        throw unrepresentable('Authoring-state schema is malformed.');
    }
    const normalizedIntent = normalizeIntent(record.normalizedIntent);
    return {
        schemaVersion: INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
        kind: INVESTIGATION_MANIFEST_V3_KIND,
        repositoryId: boundedText(record.repositoryId, 'repository ID'),
        changeId: boundedText(record.changeId, 'change ID'),
        investigationId: boundedText(record.investigationId, 'investigation ID'),
        normalizedIntent,
        intentDigest: digest(normalizedIntent),
        authoring: normalizeAuthoring(record.authoring),
    };
}
function parseManifestIdentity(record) {
    if (record.schemaVersion !== INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION ||
        record.kind !== INVESTIGATION_MANIFEST_V3_KIND) {
        throw unrepresentable('Manifest v3 identity is malformed.');
    }
    const normalizedIntent = normalizeIntent(record.normalizedIntent);
    assertDigest(record.intentDigest);
    if (record.intentDigest !== digest(normalizedIntent)) {
        throw new ManifestValidationError('TERM_INTEGRITY_MISMATCH', 'Tracked normalized intent does not match intentDigest.');
    }
    return {
        schemaVersion: INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
        kind: INVESTIGATION_MANIFEST_V3_KIND,
        repositoryId: boundedText(record.repositoryId, 'repository ID'),
        changeId: boundedText(record.changeId, 'change ID'),
        investigationId: boundedText(record.investigationId, 'investigation ID'),
        normalizedIntent,
        intentDigest: record.intentDigest,
        authoring: normalizeAuthoring(record.authoring),
    };
}
function normalizeIntent(value) {
    const record = assertRecord(value);
    assertExactKeys(record, [
        'schemaVersion',
        'summary',
        'sourceRefs',
        'explicitPaths',
        'explicitSymbols',
        'explicitConfigKeys',
        'renamePairs',
    ]);
    if (record.schemaVersion !== 1) {
        throw unrepresentable('Normalized intent schema is malformed.');
    }
    const sourceRefs = normalizeSourceReferences(record.sourceRefs);
    const explicitPaths = normalizeTextArray(record.explicitPaths);
    const explicitSymbols = normalizeTextArray(record.explicitSymbols);
    const explicitConfigKeys = normalizeTextArray(record.explicitConfigKeys);
    if (!Array.isArray(record.renamePairs)) {
        throw unrepresentable('Normalized intent rename pairs are malformed.');
    }
    const renamePairs = record.renamePairs.map((value) => {
        const pair = assertRecord(value);
        assertExactKeys(pair, ['from', 'to']);
        const from = boundedText(pair.from, 'rename source');
        const to = boundedText(pair.to, 'rename target');
        if (from === to) {
            throw unrepresentable('Normalized intent rename is a no-op.');
        }
        return { from, to };
    });
    assertUnique(renamePairs.map((pair) => canonicalJson(pair)), 'rename pairs');
    return {
        schemaVersion: 1,
        summary: boundedText(record.summary, 'intent summary'),
        sourceRefs,
        explicitPaths,
        explicitSymbols,
        explicitConfigKeys,
        renamePairs,
    };
}
function normalizeSourceReferences(value) {
    if (!Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string' || !/^SRC-[0-9a-f]{64}$/.test(entry))) {
        throw unrepresentable('Governance Source reference array is malformed.');
    }
    const sourceRefs = value;
    const sorted = [...sourceRefs].sort((left, right) => left.localeCompare(right));
    if (canonicalJson(sourceRefs) !== canonicalJson(sorted)) {
        throw unrepresentable('Governance Source references are not canonical.');
    }
    assertUnique(sourceRefs, 'Governance Source references');
    return [...sourceRefs];
}
function normalizeAuthoring(value) {
    const record = assertRecord(value);
    assertExactKeys(record, ['sessionRevision', 'sessionSnapshotDigest']);
    if (!Number.isSafeInteger(record.sessionRevision) ||
        record.sessionRevision < 0) {
        throw unrepresentable('Authoring session revision is malformed.');
    }
    assertDigest(record.sessionSnapshotDigest);
    return {
        sessionRevision: record.sessionRevision,
        sessionSnapshotDigest: record.sessionSnapshotDigest,
    };
}
function normalizeBaseline(value) {
    const record = assertRecord(value);
    assertExactKeys(record, ['commitOid', 'treeOid']);
    assertGitObjectId(record.commitOid);
    assertGitObjectId(record.treeOid);
    if (record.commitOid.length !== record.treeOid.length) {
        throw unrepresentable('Baseline object formats disagree.');
    }
    return {
        commitOid: record.commitOid,
        treeOid: record.treeOid,
    };
}
function assertIntentFloor(intent, canonicalTerms) {
    const terms = new Map(canonicalTerms.map((term) => [term.termId, term]));
    const required = [
        ...intent.explicitPaths.map((value) => ({
            kind: 'literal-path',
            value,
        })),
        ...intent.explicitSymbols.map((value) => ({
            kind: 'symbol',
            value,
        })),
        ...intent.explicitConfigKeys.map((value) => ({
            kind: 'config-key',
            value,
        })),
        ...intent.renamePairs.flatMap(({ from, to }) => [
            { kind: 'literal-content', value: from },
            { kind: 'literal-content', value: to },
        ]),
    ];
    for (const input of required) {
        const expected = normalizeInvestigationTerm(input);
        const actual = terms.get(expected.termId);
        if (actual === undefined ||
            !actual.provenance.some(({ source }) => source === 'engine')) {
            throw new ManifestValidationError('TERM_INTEGRITY_MISMATCH', `Normalized intent floor term is missing: ${input.kind}.`);
        }
    }
}
function parseApproval(value) {
    const record = assertRecord(value);
    assertExactKeys(record, [
        'schemaVersion',
        'kind',
        'investigationTargetDigest',
        'semanticAuthor',
        'approvalProvenanceDigest',
        'semanticAssurance',
        'sealDigest',
    ]);
    if (record.schemaVersion !== 1 ||
        record.kind !== 'investigation-approval' ||
        record.semanticAssurance !== SEMANTIC_ASSURANCE) {
        throw unrepresentable('Investigation approval identity is malformed.');
    }
    assertDigest(record.investigationTargetDigest);
    assertDigest(record.approvalProvenanceDigest);
    assertDigest(record.sealDigest);
    return {
        schemaVersion: 1,
        kind: 'investigation-approval',
        investigationTargetDigest: record.investigationTargetDigest,
        semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
        approvalProvenanceDigest: record.approvalProvenanceDigest,
        semanticAssurance: SEMANTIC_ASSURANCE,
        sealDigest: record.sealDigest,
    };
}
function normalizeSemanticAuthor(value) {
    const record = assertRecord(value);
    assertExactKeys(record, ['id', 'provenance']);
    return {
        id: boundedText(record.id, 'semantic author ID'),
        provenance: boundedText(record.provenance, 'semantic author provenance'),
    };
}
function assertManifestTop(value) {
    const record = assertRecord(value);
    assertExactKeys(record, [
        'schemaVersion',
        'kind',
        'repositoryId',
        'changeId',
        'investigationId',
        'normalizedIntent',
        'intentDigest',
        'authoring',
        'applicability',
        'investigationApproval',
        'manifestDigest',
    ]);
    return record;
}
function assertDraftShape(value) {
    const record = assertManifestTop(value);
    if (record.schemaVersion !== INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION ||
        record.kind !== INVESTIGATION_MANIFEST_V3_KIND ||
        record.investigationApproval !== null ||
        record.manifestDigest !== null) {
        throw unrepresentable('Investigation draft identity is malformed.');
    }
    parseManifestIdentity(record);
}
function investigationTargetDigest(manifest, applicabilityContentDigest) {
    return digestWithDomain('investigation-target/v3', {
        schemaVersion: manifest.schemaVersion,
        repositoryId: manifest.repositoryId,
        changeId: manifest.changeId,
        investigationId: manifest.investigationId,
        intentDigest: manifest.intentDigest,
        sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
        applicabilityContentDigest,
    });
}
function normalizeDigestArray(value, allowEmpty) {
    if (!Array.isArray(value) ||
        (!allowEmpty && value.length === 0) ||
        value.some((entry) => typeof entry !== 'string' || !DIGEST.test(entry))) {
        throw unrepresentable('Digest reference array is malformed.');
    }
    const sorted = [...value].sort();
    assertUnique(sorted, 'digest references');
    return sorted;
}
function normalizeTextArray(value) {
    if (!Array.isArray(value)) {
        throw unrepresentable('Text array is malformed.');
    }
    const values = value.map((entry) => boundedText(entry, 'text value'));
    assertUnique(values, 'text values');
    return values;
}
function nullableText(value, label) {
    return value === null ? null : boundedText(value, label);
}
function boundedText(value, label) {
    if (typeof value !== 'string' ||
        value.trim().length === 0 ||
        Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
        throw unrepresentable(`${label} is malformed.`);
    }
    return value;
}
function assertDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw unrepresentable('Digest is malformed.');
    }
}
function assertGitObjectId(value) {
    if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
        throw unrepresentable('Git object identity is malformed.');
    }
}
function assertUnique(values, label) {
    if (new Set(values).size !== values.length) {
        throw unrepresentable(`${label} contain duplicates.`);
    }
}
function assertRecord(value) {
    if (!isRecord(value)) {
        throw unrepresentable('Manifest object is malformed.');
    }
    return value;
}
function assertExactKeys(value, expected) {
    const keys = Object.keys(value);
    if (keys.length !== expected.length ||
        !keys.every((key) => expected.includes(key))) {
        throw unrepresentable('Manifest object has unknown or missing properties.');
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sourceTupleKey(pathRawBase64, blobOid) {
    return canonicalJson([pathRawBase64, blobOid]);
}
function digest(value) {
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function rawSha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function digestWithDomain(domain, value) {
    return digest({ domain, value });
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}
class ManifestValidationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ManifestValidationError';
        this.code = code;
    }
}
function unrepresentable(message) {
    return new ManifestValidationError('MANIFEST_UNREPRESENTABLE', message);
}
function failureCode(error) {
    if (error instanceof ManifestValidationError)
        return error.code;
    if (error instanceof WorkflowError &&
        isSafeInvestigationV3FailureCode(error.code)) {
        return error.code;
    }
    return 'RECONSTRUCTION_MISMATCH';
}
function isSafeInvestigationV3FailureCode(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.trim() === value &&
        Buffer.byteLength(value) <= 256 &&
        !/[\0\r\n]/.test(value));
}
function blocked(attemptedTransition, candidate, error) {
    return blockedWithCode(attemptedTransition, candidate, failureCode(error), error instanceof Error
        ? error.message
        : 'Unknown v3 investigation failure.', error instanceof WorkflowError ? error.details : undefined);
}
function blockedWithCode(attemptedTransition, candidate, code, message, details) {
    const candidateDigest = safeCandidateDigest(candidate);
    const detailsDigest = digest({ code, message, details: details ?? null });
    const missingAssuranceFacts = missingAssuranceFactsFor(code);
    const identityInput = {
        attemptedTransition,
        candidateDigest,
        failureCode: code,
        detailsDigest,
        missingAssuranceFacts,
    };
    return {
        outcome: 'blocked',
        blocker: {
            schemaVersion: 1,
            kind: 'investigation-v3-failure',
            failureIdentity: digestWithDomain('investigation-v3-failure/v1', identityInput),
            ...identityInput,
        },
    };
}
function safeCandidateDigest(value) {
    try {
        return digestWithDomain('investigation-v3-candidate/v1', value);
    }
    catch {
        return digestWithDomain('investigation-v3-candidate/v1', 'unrepresentable');
    }
}
function missingAssuranceFactsFor(code) {
    switch (code) {
        case 'TERM_INTEGRITY_MISMATCH':
            return ['canonical-term-composition'];
        case 'REPLAY_INPUT_MISSING':
        case 'REPLAY_CLOSURE_UNSUPPORTED':
            return ['pinned-git-replay'];
        case 'SEMANTIC_COMPLETENESS_FAILURE':
            return ['complete-semantic-decisions'];
        case 'SOURCE_ANCHOR_UNRESOLVED':
            return ['resolvable-source-anchors'];
        case 'REVIEW_TARGET_STALE':
            return ['current-authority-snapshot'];
        default:
            return [];
    }
}
