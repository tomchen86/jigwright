/**
 * Durable authoring checkpoint payload retained by the current investigation
 * session store. Historical EvidenceNode WHY derivation and replay are retired;
 * current Manifest-v3 authoring turns these answers into direct WHY overlays.
 */
export type InvestigationWhyAnswer = {
  manifestEntryId: string;
  why: string;
  protectedInvariant: string;
  reviewerQuestion: string;
  answer: string;
  semanticAuthor: string;
  readComplete: boolean;
};
