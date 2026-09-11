/** Scanner input/output values and the maximum stored hit-context size. */
import type {
  TrackedTreePathIdentity,
  TrackedTreeSkipReason,
} from '../../source/tracked-path.ts';
import type {
  InvestigationTermProvenance,
  NormalizedInvestigationTerm,
} from './investigation-terms.ts';
export type ScanInvestigationTerm = NormalizedInvestigationTerm & {
  provenance: InvestigationTermProvenance[];
};

export type ScanHitSourceObject = {
  objectId: string;
  objectType: string;
  mode: string;
  byteSize: number | null;
  contentSha256: string | null;
  skipReason: TrackedTreeSkipReason | null;
};

export type ScanHitContextWindow = {
  rawBase64: string;
  utf8: string | null;
  byteOffset: number;
  byteLength: number;
  truncated: boolean;
};

export type ScanHit = {
  path: TrackedTreePathIdentity;
  sourceObject: ScanHitSourceObject;
  surface: 'path' | 'content';
  byteOffset: number;
  byteLength: number;
  /**
   * Present for content hits only. A path-surface hit has no content to quote,
   * so it can never satisfy a predicate and can never join a class.
   */
  contextWindow?: ScanHitContextWindow;
};

export const SCAN_HIT_MAX_CONTEXT_BYTES = 512;

export type ScanSkippedObject = {
  path: { rawBase64: string; utf8: string | null };
  objectId: string;
  objectType: string;
  mode: string;
  byteSize: number | null;
  reason: TrackedTreeSkipReason | 'generated-artifact';
};

export type ScanInventoryFacts = {
  treeDigest: string;
  skippedObjects: readonly ScanSkippedObject[];
};

export type InvestigationScanTermFacts = {
  term: ScanInvestigationTerm;
  hits: ScanHit[];
};

export type InvestigationScanFacts = {
  schemaVersion: 1;
  kind: 'investigation-scan-facts';
  treeDigest: string;
  policyDigest: string;
  inventory: ScanInventoryFacts;
  terms: InvestigationScanTermFacts[];
};

export type ScanViolation = {
  code:
    | 'TERM_HIT_LIMIT_EXCEEDED'
    | 'TOTAL_HIT_LIMIT_EXCEEDED'
    | 'HIT_DISPOSITION_WORK_LIMIT_EXCEEDED'
    | 'SCANNED_BYTE_LIMIT_EXCEEDED'
    | 'SCAN_WORK_LIMIT_EXCEEDED';
  termId?: string;
};

export type ReadyScanFactsResult = {
  outcome: 'ready';
  facts: InvestigationScanFacts;
  saturatedTermIds?: string[];
};

export type NarrowingScanFactsResult = {
  outcome: 'requires-narrowing';
  policyDigest: string;
  inventory: ScanInventoryFacts;
  violations: ScanViolation[];
  terms: ScanInvestigationTerm[];
};

export type InvestigationScanFactsResult =
  ReadyScanFactsResult | NarrowingScanFactsResult;
