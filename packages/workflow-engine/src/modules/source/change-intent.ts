/** Canonical change intent DTOs; field and wire semantics are unchanged. */

export type NormalizedChangeIntent = {
  schemaVersion: 1;
  summary: string;
  sourceRefs: `SRC-${string}`[];
  explicitPaths: string[];
  explicitSymbols: string[];
  explicitConfigKeys: string[];
  renamePairs: Array<{
    from: string;
    to: string;
  }>;
};
