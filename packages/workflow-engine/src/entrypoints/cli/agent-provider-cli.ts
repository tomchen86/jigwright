/**
 * Parses provider probe and live-test commands and maps configuration
 * errors to workflow failures.
 *
 * Invariants:
 * - Provider tests require an explicit --live argument and an explicit
 *   configuration path.
 */
import { AgentProviderConfigError } from '@jigwright/agent-runtime';
import { ProviderExecutableObservationError } from '@jigwright/agent-runtime/provider-executable-identity';

import {
  AgentProviderConfigFileError,
  probeAgentProviderProfile,
} from '../../composition-root/agent-provider-probe-production.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export async function dispatchAgentProviderCommand(
  args: string[],
  repositoryRoot: string,
): Promise<Record<string, unknown>> {
  const parsed = parseAgentProviderCommand(args);
  try {
    return await probeAgentProviderProfile(
      repositoryRoot,
      parsed.configPath,
      parsed.profileId,
      parsed.operation,
    );
  } catch (error) {
    if (error instanceof AgentProviderConfigFileError) {
      throw workflowError(
        error.code,
        error.message,
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_STALE'
          ? ExitCode.staleState
          : ExitCode.unsafeEnvironment,
      );
    }
    if (error instanceof AgentProviderConfigError) {
      throw workflowError(error.code, error.message, ExitCode.verification);
    }
    if (error instanceof ProviderExecutableObservationError) {
      throw workflowError(error.code, error.message, ExitCode.staleState);
    }
    throw error;
  }
}

function parseAgentProviderCommand(args: string[]): Readonly<{
  operation: 'probe' | 'test';
  profileId: string;
  configPath: string;
}> {
  const [noun, operation, profileId, configOption, configPath, ...remaining] =
    args;
  const probe =
    noun === 'provider' &&
    operation === 'probe' &&
    typeof profileId === 'string' &&
    configOption === '--config' &&
    typeof configPath === 'string' &&
    remaining.length === 0;
  const liveTest =
    noun === 'provider' &&
    operation === 'test' &&
    typeof profileId === 'string' &&
    configOption === '--config' &&
    typeof configPath === 'string' &&
    remaining.length === 1 &&
    remaining[0] === '--live';
  if (!probe && !liveTest) throw agentProviderUsage();
  return Object.freeze({
    operation,
    profileId,
    configPath,
  });
}

function agentProviderUsage() {
  return workflowError(
    'INVALID_AGENT_PROVIDER_USAGE',
    'Usage: jigwright agent provider <probe <profile-id> --config <absolute-host-path>|test <profile-id> --config <absolute-host-path> --live> [--json]',
    ExitCode.usage,
  );
}
