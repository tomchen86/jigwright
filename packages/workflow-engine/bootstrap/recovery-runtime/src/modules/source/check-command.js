/**
 * Exposes shared check-command parsing and registry types to source
 * consumers.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export { parseCheckCommand, parseChecksConfigSource, } from '@jigwright/core/check-command';
