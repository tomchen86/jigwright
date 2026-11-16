/**
 * Selects the production provider runtime for synchronous and asynchronous
 * worker calls.
 *
 * Invariants:
 * - Native session turns require the asynchronous host-wrapper path;
 *   synchronous execution rejects them.
 */
import { builtInProviderAdapters } from './built-in-provider-adapter-production.ts';
import type { ProviderWorkerRuntimePort } from '../modules/provider-orchestration/agent-runtime-port.ts';
import { runBuiltInProvider } from '../runtime/provider-execution/provider-runner.ts';
import { runBuiltInProviderThroughAgentRuntimeV1 } from './agent-runtime-v1-production.ts';
import { runHostWrapperProviderThroughAgentRuntimeV1 } from './agent-runtime-host-wrapper-production.ts';

/** Production adapter retaining sync compatibility while exposing async launch. */
const builtInAgentRuntime: ProviderWorkerRuntimePort = {
  runSingleShot(input, options) {
    if (input.nativeSessionTurn !== undefined) {
      throw new TypeError(
        'Host-wrapper AgentRuntime execution requires the asynchronous production path.',
      );
    }
    return runBuiltInProvider(builtInProviderAdapters, input, options);
  },
  runSingleShotAsync(input, options) {
    return input.nativeSessionTurn === undefined
      ? runBuiltInProviderThroughAgentRuntimeV1(input, options)
      : runHostWrapperProviderThroughAgentRuntimeV1(input, options);
  },
};

export const productionAgentRuntime = Object.freeze(builtInAgentRuntime);

export { createAgentRuntimeHostExecutionBindingV1 } from '../modules/provider-orchestration/agent-runtime-host-execution-binding.ts';
export { createAgentRuntimeProgressTracker } from '../modules/provider-orchestration/agent-runtime-progress-tracker.ts';
export {
  providerAcceptanceGovernedRuntimeInputs,
  providerInvocationDurableGovernedRuntimeInputs,
} from '../runtime/provider-execution/provider-runner.ts';

export type {
  AgentRuntimeAssignmentBindingV1,
  AgentRuntimeCompletionReceipt,
  AgentRuntimeHostExecutionBindingV1,
  AgentRuntimeHostProbeEvidenceV1,
  AgentRuntimeNativeSessionTurnControllerV1,
  ProviderWorkerRuntimePort,
  AgentRuntimeProcessActivity,
  AgentRuntimeProcessProgressProjection,
  AgentRuntimeProcessTermination,
  AgentRuntimeSingleShotInput,
  AgentRuntimeSingleShotOptions,
  AgentRuntimeSingleShotReport,
  ProviderInvocationAcceptanceBinding,
  ProviderRuntimeProtocolReceipt,
  ProviderWrapperProtocolReceipt,
} from '../modules/provider-orchestration/agent-runtime-port.ts';
