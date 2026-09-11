/**
 * Exposes shared record and string-array predicates to engine foundation
 * code.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export { isRecord, isStringArray } from '@jigwright/core/contract-values';
