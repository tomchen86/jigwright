/**
 * Exposes the public bounded process runner to provider execution.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export * from '@jigwright/agent-runtime/bounded-provider-process';
