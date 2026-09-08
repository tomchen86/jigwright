/**
 * Publishes resolution nodes and compare-and-swaps each investigation resolution head.
 *
 * Invariants:
 * - Head refs point only to validated nodes belonging to the exact investigation.
 * - Node creation and head replacement preserve canonical bytes and lock ordering.
 *
 * Depends on: resolution contracts, private files, and resolution object and ref paths.
 * Failure modes: a head advances to unrelated evidence or concurrent resolution state is overwritten.
 */
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertInvestigationId, } from "../session-workspace/paths.js";
import { assertHumanResolutionNode, } from "./human-resolution-contract.js";
import { createPrivateCanonicalJson, privatePathExists, readPrivateCanonicalJson, withPrivateRuntimeLock, writePrivateCanonicalJsonAtomic, } from "./investigation-private-files.js";
import { humanResolutionNodePath, humanResolutionObjectUnsafe, humanResolutionPaths, humanResolutionRefPath, humanResolutionRefUnsafe, } from "./investigation-resolution-values.js";
import { hasExactKeys, isDigest, isRecord, } from "./investigation-store-values.js";
export function writeHumanResolutionNode(paths, node) {
    const validated = assertHumanResolutionNode(node);
    createPrivateCanonicalJson(paths, humanResolutionNodePath(paths, validated.nodeId), validated, humanResolutionObjectUnsafe, 'HUMAN_RESOLUTION_NODE_COLLISION');
    return validated.nodeId;
}
export function readHumanResolutionNode(paths, requestedNodeId) {
    if (!isDigest(requestedNodeId)) {
        throw humanResolutionObjectUnsafe();
    }
    const value = readPrivateCanonicalJson(paths, humanResolutionNodePath(paths, requestedNodeId), humanResolutionObjectUnsafe);
    const node = assertHumanResolutionNode(value);
    if (node.nodeId !== requestedNodeId) {
        throw humanResolutionObjectUnsafe();
    }
    return node;
}
export function readHumanResolutionHead(paths, requestedInvestigationId) {
    const nodeId = readHumanResolutionHeadReference(paths, requestedInvestigationId);
    if (nodeId !== null) {
        readHumanResolutionNode(paths, nodeId);
    }
    return nodeId;
}
export function readHumanResolutionHeadReference(paths, requestedInvestigationId) {
    const investigationId = assertInvestigationId(requestedInvestigationId);
    const refPath = humanResolutionRefPath(paths, investigationId);
    if (!privatePathExists(paths, refPath, humanResolutionRefUnsafe)) {
        return null;
    }
    const value = readPrivateCanonicalJson(paths, refPath, humanResolutionRefUnsafe);
    if (!isRecord(value) ||
        !hasExactKeys(value, ['schemaVersion', 'investigationId', 'nodeId']) ||
        value.schemaVersion !== 1 ||
        value.investigationId !== investigationId ||
        !isDigest(value.nodeId)) {
        throw humanResolutionRefUnsafe();
    }
    return value.nodeId;
}
export function compareAndSwapHumanResolutionHead(paths, requestedInvestigationId, expectedNodeId, nextNodeId) {
    const investigationId = assertInvestigationId(requestedInvestigationId);
    if (expectedNodeId !== null && !isDigest(expectedNodeId)) {
        throw humanResolutionRefUnsafe();
    }
    const next = readHumanResolutionNode(paths, nextNodeId);
    if (next.target.workflowId !== investigationId) {
        throw humanResolutionRefUnsafe();
    }
    withPrivateRuntimeLock(paths, path.join(humanResolutionPaths(paths).locks, `${investigationId}.resolution.lock`), () => {
        const observed = readHumanResolutionHead(paths, investigationId);
        if (observed !== expectedNodeId) {
            throw workflowError('HUMAN_RESOLUTION_REF_STALE', 'The human-resolution overlay changed after grant issuance.', ExitCode.staleState);
        }
        writePrivateCanonicalJsonAtomic(paths, humanResolutionRefPath(paths, investigationId), {
            schemaVersion: 1,
            investigationId,
            nodeId: nextNodeId,
        }, humanResolutionRefUnsafe);
    }, 'HUMAN_RESOLUTION_OPERATION_CONFLICT', humanResolutionRefUnsafe);
}
