/**
 * Builds exact investigation evidence ref closures and ambiguity observations.
 *
 * Invariants:
 * - Every ref and dependency retains validated ownership and canonical digest identity.
 * - Unsafe observations remain explicit and closure entries keep their original ordering.
 *
 * Depends on: ref snapshots, evidence readers, and planning and review ownership validators.
 * Failure modes: a closure silently omits unsafe evidence or assigns refs to the wrong investigation.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { canonicalEvidenceNodeEnvelope, } from "../../foundation/evidence-node/evidence-node.js";
import { assertChangeId, assertInvestigationId, } from "../session-workspace/paths.js";
import { readEvidenceNode } from "./evidence-node-store.js";
import { assertPlanReviewGrantRequirementOwnership } from "./evidence-plan-review-grants.js";
import { assertPlanReviewRequestOwnership } from "./evidence-plan-review-ownership.js";
import { assertExemptionSessionOwnership, assertPlanningMaterializationOwnership, } from "./evidence-planning-ownership.js";
import { readEvidenceRefsSnapshot, } from "./evidence-ref-store.js";
import { DIGEST_PATTERN, REF_NAME_PATTERN, evidenceObjectPath, evidenceRefPath, refInvalid, refUnsafe, sha256, } from "./evidence-store-values.js";
import { exactUnsafePathObservationDigest } from "./evidence-unsafe-observation.js";
export function readInvestigationEvidenceRefsClosure(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const snapshot = readEvidenceRefsSnapshot(paths, changeId);
    if (snapshot.refs === null) {
        return Object.freeze({
            snapshot,
            closureDigest: null,
            owners: Object.freeze({}),
            entries: Object.freeze([]),
        });
    }
    const closure = computeInvestigationEvidenceRefsClosure(paths, changeId, snapshot.refs);
    return Object.freeze({
        snapshot,
        ...closure,
    });
}
export function observeInvestigationEvidenceRefsAmbiguities(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const observations = new Map();
    const observe = (object, filePath) => {
        observations.set(object, exactUnsafePathObservationDigest(filePath, object));
    };
    const refPath = evidenceRefPath(paths, changeId);
    observe('evidence-refs', refPath);
    let snapshot;
    try {
        snapshot = readEvidenceRefsSnapshot(paths, changeId);
    }
    catch {
        return sortedAmbiguityObservations(observations);
    }
    if (snapshot.refs === null) {
        return sortedAmbiguityObservations(observations);
    }
    const pending = Object.values(snapshot.refs).sort();
    const visited = new Set();
    while (pending.length > 0) {
        const nodeId = pending.shift();
        if (!nodeId || visited.has(nodeId)) {
            continue;
        }
        if (visited.size >= 4096) {
            throw refUnsafe();
        }
        visited.add(nodeId);
        observe(`evidence-node:${nodeId}`, evidenceObjectPath(paths, nodeId));
        try {
            const node = readEvidenceNode(paths, nodeId);
            pending.push(...Object.values(node.provenanceParentNodeIds)
                .filter((parentId) => !visited.has(parentId))
                .sort());
        }
        catch {
            // The exact missing or malformed causal object is already observed.
        }
    }
    return sortedAmbiguityObservations(observations);
}
function sortedAmbiguityObservations(observations) {
    return [...observations]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([object, observationDigest]) => ({ object, observationDigest }));
}
export function computeInvestigationEvidenceRefsClosure(paths, requestedChangeId, refs) {
    const changeId = assertChangeId(requestedChangeId);
    const owners = {};
    const entries = Object.entries(refs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([refName, nodeId]) => {
        const node = readEvidenceNode(paths, nodeId);
        const ownership = assertInvestigationEvidenceRefOwner(paths, refs, refName, node, changeId);
        owners[refName] = ownership.ownerInvestigationId;
        return Object.freeze({
            refName,
            nodeId,
            resultDigest: node.resultDigest,
            envelopeDigest: sha256(canonicalEvidenceNodeEnvelope(node)),
            ownerInvestigationId: ownership.ownerInvestigationId,
            dependencies: ownership.dependencies,
        });
    });
    return Object.freeze({
        closureDigest: investigationEvidenceRefsClosureDigest(changeId, entries),
        owners: Object.freeze(owners),
        entries: Object.freeze(entries),
    });
}
export function investigationEvidenceRefsClosureDigest(requestedChangeId, entries) {
    const changeId = assertChangeId(requestedChangeId);
    const sorted = [...entries].sort((left, right) => left.refName.localeCompare(right.refName));
    if (sorted.some((entry, index) => entry.refName !== entries[index]?.refName ||
        !REF_NAME_PATTERN.test(entry.refName) ||
        !DIGEST_PATTERN.test(entry.nodeId) ||
        !DIGEST_PATTERN.test(entry.resultDigest) ||
        !DIGEST_PATTERN.test(entry.envelopeDigest) ||
        assertInvestigationId(entry.ownerInvestigationId) !==
            entry.ownerInvestigationId ||
        !Array.isArray(entry.dependencies) ||
        entry.dependencies.some((dependency, dependencyIndex) => dependency.role.length === 0 ||
            dependency.role !==
                [...entry.dependencies].sort((left, right) => left.role.localeCompare(right.role))[dependencyIndex]?.role ||
            !DIGEST_PATTERN.test(dependency.nodeId) ||
            !DIGEST_PATTERN.test(dependency.resultDigest) ||
            !DIGEST_PATTERN.test(dependency.envelopeDigest)))) {
        throw refInvalid();
    }
    return sha256(canonicalJson({
        schemaVersion: 1,
        changeId,
        entries,
    }));
}
function assertInvestigationEvidenceRefOwner(paths, refs, refName, node, expectedChangeId) {
    try {
        switch (refName) {
            case 'propose/planning-materialization':
                return assertPlanningMaterializationOwnership(paths, node, expectedChangeId);
            case 'propose/plan-review-request':
                return assertPlanReviewRequestOwnership(paths, refs, node, expectedChangeId);
            case 'propose/plan-review-grant-requirement':
                return assertPlanReviewGrantRequirementOwnership(node, expectedChangeId);
            case 'propose/exemption-session':
                return assertExemptionSessionOwnership(paths, node, expectedChangeId);
            default:
                throw refInvalid();
        }
    }
    catch {
        throw refInvalid();
    }
}
