/**
 * Exposes canonical evidence object, ref, ownership, and ambiguity inspection APIs.
 *
 * Invariants:
 * - Existing import paths preserve the same functions, types, errors, and canonical identities.
 * - Object publication and ref updates retain their separate durability protocols.
 */

export { readEvidenceNode, writeEvidenceNode } from './evidence-node-store.ts';
export { resolvePlanReviewInvocationOwner } from './evidence-plan-review-ownership.ts';
export {
  computeInvestigationEvidenceRefsClosure,
  investigationEvidenceRefsClosureDigest,
  observeInvestigationEvidenceRefsAmbiguities,
  readInvestigationEvidenceRefsClosure,
} from './evidence-ref-closure.ts';
export type {
  InvestigationEvidenceDependencyClosureEntry,
  InvestigationEvidenceRefClosureEntry,
  InvestigationEvidenceRefsClosure,
} from './evidence-ref-closure.ts';
export {
  compareAndSwapEvidenceRef,
  compareAndSwapEvidenceRefsDocument,
  quarantineUnsafeEvidenceRefsDocument,
  readEvidenceRefs,
  readEvidenceRefsSnapshot,
} from './evidence-ref-store.ts';
export type {
  CompareAndSwapEvidenceRefParams,
  CompareAndSwapEvidenceRefsDocumentParams,
  EvidenceRefsSnapshot,
} from './evidence-ref-store.ts';
export {
  resolveTaskDiffReviewInvocationOwner,
  resolveTaskStrategyImplementationInvocationOwner,
} from './evidence-task-invocation-ownership.ts';
export { exactUnsafePathObservationDigest } from './evidence-unsafe-observation.ts';
