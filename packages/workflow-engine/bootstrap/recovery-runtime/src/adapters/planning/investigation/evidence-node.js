/**
 * Keeps the planning adapter import path compatible with the workflow evidence codec.
 *
 * Invariants:
 * - Existing callers receive the same evidence identities and WorkflowError values.
 * - The foundation codec remains the single implementation of this API.
 *
 * Depends on: the foundation evidence-node facade and its core codec.
 * Failure modes: missing exports or divergent evidence validation across callers.
 */
export { assertStoredEvidenceNode, canonicalEvidenceNodeEnvelope, createEvidenceNode, } from "../../../foundation/evidence-node/evidence-node.js";
