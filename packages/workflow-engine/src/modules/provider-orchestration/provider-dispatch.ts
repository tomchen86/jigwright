/** Contracts for observing dispatch admission and launching one exact worker. */
import type { ProviderInvocationRecord } from './provider-invocation-record.ts';
import type { CurrentAgentRuntimeAssignmentV1 } from './agent-runtime-port.ts';

/** Host-owned selection inputs shared by worker execution and dispatch preflight. */
export type ProviderWorkerAssignmentOptions = {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  /** Explicit host-owned config path; production may supply the same path by env. */
  agentProviderConfigPath?: string;
};

export type ProviderDispatchResult = {
  schemaVersion: 1;
  kind: 'provider-worker-dispatch';
  invocationId: string;
  pid: number;
};

export type ProviderWorkerDispatcher = (
  cwd: string,
  invocationId: string,
) => ProviderDispatchResult;

/** Returns a positive safe-integer PID after detached launch and unref. */
export type ProviderWorkerLauncher = (
  input: Readonly<{
    repositoryRoot: string;
    invocationId: string;
  }>,
) => number;

export type ProviderDispatchObserver = (
  cwd: string,
  invocationId: string,
) => Readonly<{
  repositoryRoot: string;
  invocation: ProviderInvocationRecord;
  /**
   * After the prepared guard, perform the original extra explicit request read
   * and current assignment admission using this observation's context.
   * The strict invocation reader has already validated request and bindings.
   */
  resolveAssignment(
    options: ProviderWorkerAssignmentOptions,
  ): CurrentAgentRuntimeAssignmentV1 | null;
}>;
