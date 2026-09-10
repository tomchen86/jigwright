/**
 * Derives Why requirements and maps investigation authoring to exact source
 * anchors.
 *
 * Invariants:
 * - One source key must resolve to consistent Git object facts.
 */
import crypto from 'node:crypto';
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../../foundation/errors/errors.js";
const DIGEST = /^[0-9a-f]{64}$/;
const PREFIXED_DIGEST = /^sha256:([0-9a-f]{64})$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SEMANTIC_ASSURANCE = 'actor-attested-not-engine-verified';
/**
 * Derive the exact load-bearing source obligations from the process-local v3
 * view. Full blob bytes and generic evidence envelopes are deliberately absent:
 * Git remains the source authority and byte ranges bind only current hits.
 */
export function deriveInvestigationV3WhyRequirements(view) {
    const hits = new Map(view.grouping.hits.map((hit) => [hit.hitKey, hit]));
    const requirements = new Map();
    for (const disposition of view.dispositions) {
        if (disposition.classification !== 'load-bearing')
            continue;
        for (const hitKey of disposition.coveredHitKeys) {
            const hit = hits.get(hitKey);
            if (hit === undefined ||
                hit.sourceObject.contentSha256 === null ||
                !GIT_OBJECT_ID.test(hit.sourceObject.objectId)) {
                throw whyFailure('SOURCE_ANCHOR_UNRESOLVED', 'A load-bearing hit has no replayable Git blob source.');
            }
            const sourceKey = investigationV3SourceKey(hit.path, hit.sourceObject.objectId);
            let requirement = requirements.get(sourceKey);
            if (requirement === undefined) {
                requirement = {
                    pathIdentity: structuredClone(hit.path),
                    blobOid: hit.sourceObject.objectId,
                    contentSha256: hit.sourceObject.contentSha256,
                    groupRefs: new Map(),
                    hits: new Map(),
                };
                requirements.set(sourceKey, requirement);
            }
            if (canonicalJson(requirement.pathIdentity) !== canonicalJson(hit.path) ||
                requirement.blobOid !== hit.sourceObject.objectId ||
                requirement.contentSha256 !== hit.sourceObject.contentSha256) {
                throw whyFailure('SOURCE_ANCHOR_UNRESOLVED', 'One source key resolved to inconsistent Git object facts.');
            }
            requirement.groupRefs.set(disposition.groupRef.key, structuredClone(disposition.groupRef));
            requirement.hits.set(hitKey, {
                hitKey,
                termId: hit.termId,
                byteRange: {
                    start: hit.byteOffset,
                    end: hit.byteOffset + hit.byteLength,
                },
            });
        }
    }
    return [...requirements.entries()]
        .map(([sourceKey, requirement]) => ({
        sourceKey,
        pathIdentity: requirement.pathIdentity,
        blobOid: requirement.blobOid,
        contentSha256: requirement.contentSha256,
        groupRefs: [...requirement.groupRefs.values()].sort((left, right) => left.index - right.index),
        hits: [...requirement.hits.values()].sort((left, right) => left.hitKey.localeCompare(right.hitKey)),
    }))
        .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}
/** Bind exactly one fresh WHY or reusable-knowledge decision to every source. */
export function buildInvestigationV3WhyAuthoring(input) {
    const requirements = deriveInvestigationV3WhyRequirements(input.view);
    const bySource = new Map(requirements.map((entry) => [entry.sourceKey, entry]));
    const answers = uniqueBySource(input.answers, 'WHY answers');
    const reuse = uniqueBySource(input.knowledgeReuse, 'knowledge reuse');
    const covered = new Set();
    const whyOverlays = [];
    const knowledgeReuseDecisions = [];
    for (const [sourceKey, answer] of answers) {
        const requirement = bySource.get(sourceKey);
        if (requirement === undefined ||
            reuse.has(sourceKey) ||
            answer.readComplete !== true) {
            throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', 'WHY answers must map one-to-one to current load-bearing sources.');
        }
        covered.add(sourceKey);
        whyOverlays.push({
            overlayId: digest({ schema: 'investigation.why-overlay.v3', sourceKey }),
            pathIdentity: structuredClone(requirement.pathIdentity),
            blobOid: requirement.blobOid,
            contentSha256: requirement.contentSha256,
            groupRefs: structuredClone(requirement.groupRefs),
            anchors: requirement.hits.map((hit) => ({
                pathIdentity: structuredClone(requirement.pathIdentity),
                blobOid: requirement.blobOid,
                byteRange: structuredClone(hit.byteRange),
                termId: hit.termId,
            })),
            why: answer.why,
            protectedInvariant: answer.protectedInvariant,
            reviewerQuestion: answer.reviewerQuestion,
            answer: answer.answer,
            semanticAuthor: structuredClone(answer.semanticAuthor),
            readComplete: true,
            semanticAssurance: SEMANTIC_ASSURANCE,
        });
    }
    for (const [sourceKey, decision] of reuse) {
        const requirement = bySource.get(sourceKey);
        if (requirement === undefined || answers.has(sourceKey)) {
            throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', 'Knowledge reuse must map one-to-one to current load-bearing sources.');
        }
        covered.add(sourceKey);
        knowledgeReuseDecisions.push({
            decisionId: digest({
                schema: 'investigation.knowledge-reuse-decision.v3',
                sourceKey,
                knowledgeRef: decision.knowledgeRef,
            }),
            pathIdentity: structuredClone(requirement.pathIdentity),
            blobOid: requirement.blobOid,
            knowledgeRef: {
                subjectId: decision.knowledgeRef.subjectId,
                versionDigest: bareDigest(decision.knowledgeRef.versionDigest),
            },
            freshness: {
                decision: 'fresh',
                rationale: decision.freshness.rationale,
                semanticAuthor: structuredClone(decision.freshness.semanticAuthor),
                provenanceDigest: bareDigest(decision.freshness.provenanceDigest),
            },
        });
    }
    if (covered.size !== requirements.length) {
        throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', 'Every load-bearing source requires exactly one WHY or fresh reuse decision.');
    }
    return {
        whyOverlays: whyOverlays.sort((left, right) => left.overlayId.localeCompare(right.overlayId)),
        knowledgeReuseDecisions: knowledgeReuseDecisions.sort((left, right) => left.decisionId.localeCompare(right.decisionId)),
    };
}
/**
 * Resolve session-checkpoint row keys to v3 source tuples, then drop the
 * process-local row identity before the direct Manifest writer is called.
 */
export function mapInvestigationWhyCheckpointToV3Sources(input) {
    const requirementByTuple = new Map(input.requirements.map((requirement) => [
        sourceTuple(requirement.pathIdentity, requirement.blobOid),
        requirement,
    ]));
    if (requirementByTuple.size !== input.requirements.length) {
        throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', 'v3 WHY requirements contain duplicate source tuples.');
    }
    const sourceByLegacyId = new Map();
    for (const row of input.manifestRows) {
        if (!DIGEST.test(row.manifestEntryId) ||
            sourceByLegacyId.has(row.manifestEntryId)) {
            throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', 'WHY authoring rows are malformed or duplicated.');
        }
        const requirement = requirementByTuple.get(sourceTuple(row.path, row.blob.objectId));
        if (requirement === undefined ||
            requirement.contentSha256 !== row.blob.contentSha256 ||
            [...sourceByLegacyId.values()].includes(requirement.sourceKey)) {
            throw whyFailure('RECONSTRUCTION_MISMATCH', 'A WHY authoring row does not map one-to-one to a current v3 source.');
        }
        sourceByLegacyId.set(row.manifestEntryId, requirement.sourceKey);
    }
    if (sourceByLegacyId.size !== input.requirements.length) {
        throw whyFailure('RECONSTRUCTION_MISMATCH', 'WHY authoring rows do not cover the complete current v3 source set.');
    }
    const checkpointDigest = bareDigest(input.checkpointProvenanceDigest);
    return {
        answers: input.answers.map((answer) => {
            const sourceKey = sourceByLegacyId.get(answer.manifestEntryId);
            if (sourceKey === undefined || answer.readComplete !== true) {
                throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', 'A WHY checkpoint answer does not resolve to one current source.');
            }
            return {
                sourceKey,
                why: answer.why,
                protectedInvariant: answer.protectedInvariant,
                reviewerQuestion: answer.reviewerQuestion,
                answer: answer.answer,
                semanticAuthor: {
                    id: answer.semanticAuthor,
                    provenance: `checkpoint:${checkpointDigest}`,
                },
                readComplete: true,
            };
        }),
        knowledgeReuse: input.carried.map((carry) => {
            const sourceKey = sourceByLegacyId.get(carry.manifestEntryId);
            if (sourceKey === undefined) {
                throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', 'A knowledge carry does not resolve to one current source.');
            }
            return {
                sourceKey,
                knowledgeRef: {
                    subjectId: carry.subjectId,
                    versionDigest: bareDigest(carry.versionDigest),
                },
                freshness: {
                    decision: 'fresh',
                    rationale: carry.freshnessRationale,
                    semanticAuthor: structuredClone(carry.semanticAuthor),
                    provenanceDigest: bareDigest(carry.provenanceDigest),
                },
            };
        }),
    };
}
export function investigationV3SourceKey(pathIdentity, blobOid) {
    return digest({
        schema: 'investigation.source-key.v3',
        pathIdentity,
        blobOid,
    });
}
function uniqueBySource(values, label) {
    if (!Array.isArray(values)) {
        throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', `${label} are malformed.`);
    }
    const result = new Map();
    for (const value of values) {
        if (!DIGEST.test(value.sourceKey) || result.has(value.sourceKey)) {
            throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', `${label} contain an invalid or duplicate source key.`);
        }
        result.set(value.sourceKey, value);
    }
    return result;
}
function sourceTuple(pathIdentity, blobOid) {
    return canonicalJson({ pathIdentity, blobOid });
}
function bareDigest(value) {
    if (DIGEST.test(value))
        return value;
    const prefixed = PREFIXED_DIGEST.exec(value);
    if (prefixed !== null)
        return prefixed[1];
    throw whyFailure('SEMANTIC_COMPLETENESS_FAILURE', 'WHY provenance or knowledge version digest is malformed.');
}
function digest(value) {
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function whyFailure(code, message) {
    return workflowError(code, message, ExitCode.guard);
}
