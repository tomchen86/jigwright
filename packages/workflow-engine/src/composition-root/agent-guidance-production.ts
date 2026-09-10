/**
 * Exposes agent guidance installation and maintenance operations to
 * production entrypoints.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export {
  installAgentGuidance,
  refreshAgentGuidance,
  removeAgentGuidance,
  statusAgentGuidance,
  type AgentGuidanceOptions,
} from '../modules/adoption/agent-guidance.ts';
