/** Shared source-matching value used by investigation and implementation review.
 * Identity preserves exact kind, value bytes and fixed literal matching.
 */
export type SearchTermKind =
  'literal-content' | 'literal-path' | 'symbol' | 'config-key';
export const SEARCH_TERM_MATCHING = 'case-sensitive-literal-v1' as const;
export type SearchTermMatching = typeof SEARCH_TERM_MATCHING;
export type NormalizedSearchTerm = {
  termId: string;
  kind: SearchTermKind;
  value: string;
  matching: SearchTermMatching;
};
