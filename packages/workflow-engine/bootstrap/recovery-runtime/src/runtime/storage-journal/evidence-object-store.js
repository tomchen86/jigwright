/**
 * Exposes canonical evidence object, ref, ownership, and ambiguity inspection APIs.
 *
 * Invariants:
 * - Existing import paths preserve the same functions, types, errors, and canonical identities.
 * - Object publication and ref updates retain their separate durability protocols.
 */
export { readEvidenceNode, writeEvidenceNode } from "./evidence-node-store.js";
export { resolvePlanReviewInvocationOwner } from "./evidence-plan-review-ownership.js";
export { computeInvestigationEvidenceRefsClosure, investigationEvidenceRefsClosureDigest, observeInvestigationEvidenceRefsAmbiguities, readInvestigationEvidenceRefsClosure, } from "./evidence-ref-closure.js";
export { compareAndSwapEvidenceRef, compareAndSwapEvidenceRefsDocument, quarantineUnsafeEvidenceRefsDocument, readEvidenceRefs, readEvidenceRefsSnapshot, } from "./evidence-ref-store.js";
export { resolveTaskDiffReviewInvocationOwner, resolveTaskStrategyImplementationInvocationOwner, } from "./evidence-task-invocation-ownership.js";
export { exactUnsafePathObservationDigest } from "./evidence-unsafe-observation.js";
