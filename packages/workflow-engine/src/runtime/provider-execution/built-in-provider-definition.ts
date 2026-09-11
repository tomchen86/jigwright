/**
 * Exposes built-in provider identity and executable candidates to runtime
 * composition.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export {
  CLAUDE_EXECUTABLE_CANDIDATES,
  CODEX_EXECUTABLE_CANDIDATES,
  assertKnownBuiltInProviderDefinitionSnapshot,
  resolveBuiltInProviderDefinitionSnapshot,
} from '@jigwright/agent-runtime';
export type { KnownProviderDefinitionExpectation } from '@jigwright/agent-runtime';
