/**
 * Preserves workflow evidence identities and errors around the neutral core codec.
 *
 * Invariants:
 * - Canonical envelopes and node identities match the core evidence codec.
 * - Invalid inputs retain WorkflowError codes and exit statuses.
 *
 * Depends on: the core evidence codec, canonical JSON, and workflow errors.
 * Failure modes: changed evidence identities or incompatible malformed-input errors.
 */
import { CanonicalJsonError } from '@jigwright/core/canonical-json';
import { assertStoredEvidenceNode as assertCoreStoredEvidenceNode, canonicalEvidenceNodeEnvelope as canonicalCoreEvidenceNodeEnvelope, createEvidenceNode as createCoreEvidenceNode, } from '@jigwright/core/evidence-node';
import { ExitCode, workflowError, } from "../errors/errors.js";
export function createEvidenceNode(input) {
    return createCoreEvidenceNode(input, nodeInvalid);
}
export function canonicalEvidenceNodeEnvelope(node) {
    try {
        return canonicalCoreEvidenceNodeEnvelope(node);
    }
    catch (error) {
        if (error instanceof CanonicalJsonError) {
            throw workflowError('CANONICAL_JSON_INVALID', 'Value cannot be encoded as canonical JSON data.', ExitCode.usage);
        }
        throw error;
    }
}
export function assertStoredEvidenceNode(value, invalid) {
    return assertCoreStoredEvidenceNode(value, invalid);
}
function nodeInvalid() {
    return workflowError('EVIDENCE_NODE_INVALID', 'Evidence node input is malformed.', ExitCode.usage);
}
