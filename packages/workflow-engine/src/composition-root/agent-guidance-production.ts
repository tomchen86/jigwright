/** Binds guidance projections to safe storage and the repository's exact Sources. */
import { createAgentGuidanceService } from '../application/adoption/agent-guidance.ts';
import { createAgentGuidanceStorage } from '../runtime/adoption/agent-guidance-storage.ts';
import { readGovernanceSource } from './governance-sources-production.ts';
import type {
  AgentGuidanceOptions,
  AgentGuidanceTarget,
} from '../modules/adoption/agent-guidance.ts';
export { AGENT_GUIDANCE_CONFIG } from '../modules/adoption/agent-guidance.ts';
export type {
  AgentGuidanceOptions,
  AgentGuidanceTarget,
} from '../modules/adoption/agent-guidance.ts';
function production(repositoryRoot: string) {
  return createAgentGuidanceService(
    createAgentGuidanceStorage(repositoryRoot),
    (ref) => readGovernanceSource(repositoryRoot, ref).text,
    (diff) => process.stderr.write(diff),
  );
}
export const guidanceSuggestions = (repositoryRoot: string) =>
  production(repositoryRoot).guidanceSuggestions();
export const readAgentGuidanceTargets = (repositoryRoot: string) =>
  production(repositoryRoot).readAgentGuidanceTargets();
export const installAgentGuidance = (
  repositoryRoot: string,
  targets: readonly (string | AgentGuidanceTarget)[] = [],
  options: AgentGuidanceOptions = {},
) => production(repositoryRoot).installAgentGuidance(targets, options);
export const refreshAgentGuidance = (
  repositoryRoot: string,
  options: AgentGuidanceOptions = {},
) => production(repositoryRoot).refreshAgentGuidance(options);
export const removeAgentGuidance = (
  repositoryRoot: string,
  options: AgentGuidanceOptions = {},
) => production(repositoryRoot).removeAgentGuidance(options);
export const statusAgentGuidance = (repositoryRoot: string) =>
  production(repositoryRoot).statusAgentGuidance();
