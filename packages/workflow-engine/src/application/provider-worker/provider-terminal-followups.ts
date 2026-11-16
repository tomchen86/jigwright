/** Runs ordered maintenance after a provider invocation is durably terminal. */
import type { processProviderFailureRetry as processFailure } from '../provider-retry/provider-failure-retry.ts';
import type { runEvidenceRetentionMaintenance as maintainEvidence } from '../control-plane/evidence-retention.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import type { ProviderWorkerRuntimePort } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import type { ProviderWorkerMaintenanceWarning } from '../../modules/provider-orchestration/provider-worker-maintenance.ts';
import type {
  ProcessProviderFailureRetryOptions,
  ProviderRetryScheduleOperations,
  ProviderRetrySchedulePumpOptions,
} from '../../modules/provider-orchestration/provider-retry-service-port.ts';

type BoundOperation<Operation> = Operation extends (
  dependency: infer _Dependency,
  ...args: infer Args
) => infer Result
  ? (...args: Args) => Result
  : never;

export type ProviderWorkerTerminalOptions = {
  agentRuntime?: ProviderWorkerRuntimePort;
  /** @deprecated Use the complete `agentRuntime` port injection seam. */
  runner?: ProviderWorkerRuntimePort['runSingleShot'];
  automaticRetry?: {
    enabled?: boolean;
    now?: string;
    dispatcher?: (cwd: string, invocationId: string) => unknown;
  };
  schedulePump?: Omit<ProviderRetrySchedulePumpOptions, 'limit'> & {
    enabled?: boolean;
    limit?: number;
  };
  retentionNow?: string;
  retentionMaintenance?: BoundOperation<typeof maintainEvidence>;
};

export type ProviderWorkerTerminalEffects = Readonly<{
  processProviderFailureRetry: (
    cwd: string,
    ...args: Parameters<BoundOperation<typeof processFailure>>
  ) => ReturnType<BoundOperation<typeof processFailure>>;
  pumpProviderRetrySchedules: ProviderRetryScheduleOperations['pumpProviderRetrySchedules'];
  runEvidenceRetentionMaintenance: BoundOperation<typeof maintainEvidence>;
  recordTerminalWarning: (
    cwd: string,
    terminal: ProviderInvocationRecord,
    operation: ProviderWorkerMaintenanceWarning['operation'],
    error: unknown,
  ) => void;
  dispatchProviderWorker: NonNullable<
    ProcessProviderFailureRetryOptions['dispatcher']
  >;
  consumedPlanReviewReplay: NonNullable<
    ProcessProviderFailureRetryOptions['consumedRoleResultReplay']
  >;
}>;

export function runProviderWorkerTerminalFollowups(
  {
    processProviderFailureRetry,
    pumpProviderRetrySchedules,
    runEvidenceRetentionMaintenance,
    recordTerminalWarning,
    dispatchProviderWorker,
    consumedPlanReviewReplay,
  }: ProviderWorkerTerminalEffects,
  cwd: string,
  terminal: ProviderInvocationRecord,
  options: ProviderWorkerTerminalOptions,
): void {
  const retryEnabled =
    terminal.state === 'failed' &&
    (options.automaticRetry?.enabled ??
      (options.agentRuntime === undefined && options.runner === undefined));
  if (retryEnabled) {
    try {
      processProviderFailureRetry(cwd, terminal.invocationId, {
        ...(options.automaticRetry?.now === undefined
          ? {}
          : { now: options.automaticRetry.now }),
        dispatcher:
          options.automaticRetry?.dispatcher ?? dispatchProviderWorker,
        consumedRoleResultReplay: consumedPlanReviewReplay,
      });
    } catch (error) {
      if (isRoleAssignmentGrantRequired(error)) throw error;
      recordTerminalWarning(cwd, terminal, 'automatic-retry', error);
    }
  }
  const pumpEnabled =
    options.schedulePump?.enabled ??
    (options.agentRuntime === undefined && options.runner === undefined);
  if (pumpEnabled) {
    try {
      pumpProviderRetrySchedules(cwd, {
        limit: options.schedulePump?.limit ?? 10,
        ...(options.schedulePump?.now === undefined
          ? {}
          : { now: options.schedulePump.now }),
        dispatcher: options.schedulePump?.dispatcher ?? dispatchProviderWorker,
        ...(options.schedulePump?.probeExecutor === undefined
          ? {}
          : { probeExecutor: options.schedulePump.probeExecutor }),
        ...(options.schedulePump?.faultInjector === undefined
          ? {}
          : { faultInjector: options.schedulePump.faultInjector }),
      });
    } catch (error) {
      if (isRoleAssignmentGrantRequired(error)) throw error;
      recordTerminalWarning(cwd, terminal, 'retry-schedule-pump', error);
    }
  }
  try {
    const maintain =
      options.retentionMaintenance ?? runEvidenceRetentionMaintenance;
    maintain(cwd, {
      limit: 10,
      ...(options.retentionNow === undefined
        ? {}
        : { now: options.retentionNow }),
    });
  } catch (error) {
    recordTerminalWarning(cwd, terminal, 'retention-maintenance', error);
  }
}

export function isRoleAssignmentGrantRequired(error: unknown): boolean {
  return (
    error instanceof WorkflowError &&
    error.code === 'AGENT_RUNTIME_GRANT_REQUIRED'
  );
}
