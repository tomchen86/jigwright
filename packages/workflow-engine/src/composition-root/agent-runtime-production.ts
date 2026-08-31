import type { AgentRuntimePort } from '../modules/provider-orchestration/agent-runtime-port.ts';
import { runBuiltInProvider } from '../runtime/provider-execution/provider-runner.ts';
import { runBuiltInProviderThroughAgentRuntimeV1 } from './agent-runtime-v1-production.ts';
import { runHostWrapperProviderThroughAgentRuntimeV1 } from './agent-runtime-host-wrapper-production.ts';

/** Production adapter retaining sync compatibility while exposing async launch. */
const builtInAgentRuntime: AgentRuntimePort = {
  runSingleShot(input, options) {
    if (input.nativeSessionTurn !== undefined) {
      throw new TypeError(
        'Host-wrapper AgentRuntime execution requires the asynchronous production path.',
      );
    }
    return runBuiltInProvider(input, options);
  },
  runSingleShotAsync(input, options) {
    return input.nativeSessionTurn === undefined
      ? runBuiltInProviderThroughAgentRuntimeV1(input, options)
      : runHostWrapperProviderThroughAgentRuntimeV1(input, options);
  },
};

export const productionAgentRuntime = Object.freeze(builtInAgentRuntime);

export type {
  AgentRuntimeAssignmentBindingV1,
  AgentRuntimeCompletionReceipt,
  AgentRuntimeHostExecutionBindingV1,
  AgentRuntimeHostProbeEvidenceV1,
  AgentRuntimeNativeSessionTurnControllerV1,
  AgentRuntimePort,
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
