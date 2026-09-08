/**
 * Keeps the planning adapter import path compatible with the workflow evidence codec.
 *
 * Invariants:
 * - Existing callers receive the same evidence identities and WorkflowError values.
 * - The foundation codec remains the single implementation of this API.
 */
export { assertStoredEvidenceNode, canonicalEvidenceNodeEnvelope, createEvidenceNode, } from "../../../foundation/evidence-node/evidence-node.js";
