/** Canonical shared task-diff review schema values. */
export const TASK_DIFF_REVIEW_COVERAGE = Object.freeze([
  'correctness-and-invariants',
  'spec-and-design-conformance',
  'test-adequacy',
  'scope-and-unaccounted-bytes',
  'trust-boundaries-and-security',
  'consumers-generated-and-mirrored-artifacts',
  'residual-risk-and-uncertainty',
] as const);

export const RISK_PATH_OUTCOMES = Object.freeze([
  'no-challenge',
  'challenge-raised',
] as const);
