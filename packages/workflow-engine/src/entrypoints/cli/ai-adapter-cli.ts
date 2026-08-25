import { AgentProviderConfigError } from '@jigwright/agent-runtime';
import { ProviderExecutableObservationError } from '@jigwright/agent-runtime/provider-executable-identity';

import {
  AgentProviderConfigFileError,
  evaluateAgentProviderConfig,
} from '../../composition-root/agent-provider-config-dry-run-production.ts';
import { evaluateAiAdapter } from '../../runtime/provider-execution/ai-adapter-evaluation.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  runProviderAvailabilityPilot,
  verifyProviderAvailabilityPilot,
} from '../../runtime/provider-execution/provider-availability-pilot.ts';

export function dispatchAiAdapterCommand(
  args: string[],
  repositoryRoot: string,
): Record<string, unknown> {
  if (args.length === 1 && args[0] === 'evaluate') {
    return {
      action: 'evaluate',
      ...evaluateAiAdapter(repositoryRoot),
    };
  }
  if (args.length === 3 && args[0] === 'evaluate' && args[1] === '--config') {
    try {
      return {
        action: 'evaluate',
        providerConfiguration: evaluateAgentProviderConfig(
          repositoryRoot,
          args[2]!,
        ),
      };
    } catch (error) {
      if (
        error instanceof AgentProviderConfigFileError ||
        error instanceof AgentProviderConfigError ||
        error instanceof ProviderExecutableObservationError
      ) {
        throw workflowError(
          error.code,
          error.message,
          ExitCode.unsafeEnvironment,
        );
      }
      throw error;
    }
  }
  const recordPath = parseRecordPath(args);
  if (args[0] === 'availability-pilot' && recordPath !== null) {
    return {
      action: 'availability-pilot',
      ...runProviderAvailabilityPilot(repositoryRoot, { recordPath }),
    };
  }
  if (args[0] === 'verify-availability-pilot' && recordPath !== null) {
    return {
      action: 'verify-availability-pilot',
      recordPath,
      ...verifyProviderAvailabilityPilot(repositoryRoot, recordPath),
    };
  }
  throw workflowError(
    'INVALID_AI_ADAPTER_USAGE',
    'Usage: pnpm workflow adapter <evaluate [--config <absolute-host-path>]|availability-pilot --record <workflow/provider-availability-pilots/name.json>|verify-availability-pilot --record <workflow/provider-availability-pilots/name.json>> [--json]',
    ExitCode.usage,
  );
}

function parseRecordPath(args: string[]): string | null {
  return args.length === 3 && args[1] === '--record' ? args[2]! : null;
}
