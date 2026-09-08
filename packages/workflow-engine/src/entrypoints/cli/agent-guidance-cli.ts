import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  installAgentGuidance,
  refreshAgentGuidance,
  removeAgentGuidance,
  statusAgentGuidance,
  type AgentGuidanceOptions,
} from '../../composition-root/agent-guidance-production.ts';

export function dispatchAgentGuidanceCommand(
  args: string[],
  repositoryRoot: string,
  options: AgentGuidanceOptions = {},
): Record<string, unknown> {
  const [action, ...targets] = args;
  if (
    targets.some((target) => target.startsWith('-')) ||
    (action !== 'install' && targets.length !== 0)
  ) {
    throw usage();
  }
  switch (action) {
    case 'install':
      return installAgentGuidance(repositoryRoot, targets, options);
    case 'refresh':
      return refreshAgentGuidance(repositoryRoot, options);
    case 'remove':
      return removeAgentGuidance(repositoryRoot, options);
    case 'status':
      return statusAgentGuidance(repositoryRoot);
    default:
      throw usage();
  }
}

function usage() {
  return workflowError(
    'INVALID_AGENT_GUIDANCE_USAGE',
    'Usage: jigwright guidance <install [path ...]|refresh|remove|status> [--json]. Install without paths only suggests existing instruction files.',
    ExitCode.usage,
  );
}
