/**
 * The code-owned positive maxima for a single provider invocation. Repository
 * policy may lower these but never raise them, and a request may only bind
 * limits within these bounds.
 */
export const MAX_PROVIDER_LIMITS = Object.freeze({
  timeoutMs: 3_600_000,
  aggregateOutputBytes: 1_048_576,
});
