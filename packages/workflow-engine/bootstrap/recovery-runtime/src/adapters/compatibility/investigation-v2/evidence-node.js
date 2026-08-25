import { CanonicalJsonError } from '@jigwright/core/canonical-json';
import { assertStoredEvidenceNode as assertCoreStoredEvidenceNode, canonicalEvidenceNodeEnvelope as canonicalCoreEvidenceNodeEnvelope, createEvidenceNode as createCoreEvidenceNode, } from '@jigwright/core/evidence-node';
import { ExitCode, workflowError, } from "../../../foundation/errors/errors.js";
/**
 * Stable workflow compatibility facade for the mechanically extracted neutral
 * evidence envelope codec. WorkflowError remains local to this package.
 */
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
