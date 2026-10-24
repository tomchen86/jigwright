/** Selects the current host assignment for dispatch and worker admission. */
import type { CurrentAgentRuntimeAssignmentV1 } from '../modules/provider-orchestration/agent-runtime-port.ts';
import type { ProviderWorkerAssignmentOptions } from '../modules/provider-orchestration/provider-dispatch.ts';
import {
  createCurrentAgentRuntimeAssignmentV1,
  type CurrentAgentRuntimeAssignmentInputV1,
} from './change-role-assignment-production.ts';

/** Select current host assignment at each dispatch or worker admission point. */
export function resolveCurrentProviderWorkerAssignment(
  input: Omit<
    CurrentAgentRuntimeAssignmentInputV1,
    'configFilePath' | 'platform'
  >,
  options: ProviderWorkerAssignmentOptions,
): CurrentAgentRuntimeAssignmentV1 | null {
  const environment = options.environment ?? process.env;
  const configFilePath =
    options.agentProviderConfigPath ??
    environment.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  if (configFilePath === undefined) return null;
  // Blind survey creates the Manifest; it cannot consume current Manifest
  // authority. Every post-Manifest provider purpose uses the durable path.
  if (input.request.purpose === 'survey') return null;
  return createCurrentAgentRuntimeAssignmentV1({
    ...input,
    configFilePath,
    platform: options.platform ?? process.platform,
  });
}

export type { ProviderWorkerAssignmentOptions };
