/** Owns the two fresh prepared-state guards before exact worker dispatch. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  ProviderDispatchObserver,
  ProviderWorkerAssignmentOptions,
  ProviderDispatchResult,
  ProviderWorkerLauncher,
} from '../../modules/provider-orchestration/provider-dispatch.ts';
import type { CurrentAgentRuntimeAssignmentV1 } from '../../modules/provider-orchestration/agent-runtime-port.ts';

export function createProviderDispatchService({
  observe,
  launch,
}: Readonly<{
  observe: ProviderDispatchObserver;
  launch: ProviderWorkerLauncher;
}>) {
  function preflightProviderWorkerAssignment(
    cwd: string,
    requestedInvocationId: string,
    options: ProviderWorkerAssignmentOptions = {},
  ): CurrentAgentRuntimeAssignmentV1 | null {
    const observation = observe(cwd, requestedInvocationId);
    if (observation.invocation.state !== 'prepared') {
      throw workflowError(
        'PROVIDER_INVOCATION_DISPATCH_CONFLICT',
        'Only the exact prepared provider invocation can enter AgentRuntime Grant preflight.',
        ExitCode.conflict,
      );
    }
    return observation.resolveAssignment(options);
  }

  function dispatch(
    cwd: string,
    requestedInvocationId: string,
    preflightOptions: ProviderWorkerAssignmentOptions = {},
  ): ProviderDispatchResult {
    const observation = observe(cwd, requestedInvocationId);
    if (observation.invocation.state !== 'prepared') {
      throw workflowError(
        'PROVIDER_INVOCATION_DISPATCH_CONFLICT',
        'Only the exact prepared provider invocation can be dispatched.',
        ExitCode.conflict,
      );
    }
    preflightProviderWorkerAssignment(
      cwd,
      requestedInvocationId,
      preflightOptions,
    );
    const pid = launch({
      repositoryRoot: observation.repositoryRoot,
      invocationId: observation.invocation.invocationId,
    });
    return {
      schemaVersion: 1,
      kind: 'provider-worker-dispatch',
      invocationId: observation.invocation.invocationId,
      pid,
    };
  }

  return Object.freeze({ dispatch, preflightProviderWorkerAssignment });
}
