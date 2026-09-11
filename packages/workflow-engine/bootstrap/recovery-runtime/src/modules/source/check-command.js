/**
 * Owns resolved and pinned check-runner facts and exposes canonical check
 * command parsing and registry types.
 *
 * Invariants:
 * - Resolved runner identity retains its executable, arguments and digest;
 *   pinning preserves those facts as readonly values.
 */
export { parseCheckCommand, parseChecksConfigSource, } from '@jigwright/core/check-command';
