/**
 * Exposes execution Job inspection and watching through the public engine
 * boundary.
 *
 * Invariants:
 * - Public wrappers forward identifiers and watch options directly to the
 *   runtime implementation.
 */
import {
  inspectExecutionJob as inspectExecutionJobInternal,
  watchExecutionJob as watchExecutionJobInternal,
  type ExecutionJobInspection,
  type ExecutionJobWatchOptions,
} from '../../runtime/provider-execution/execution-runtime.ts';

export type { ExecutionJobInspection, ExecutionJobWatchOptions };

/** Read the current durable projection of one provider execution Job. */
export function inspectExecutionJob(
  cwd: string,
  jobId: string,
): ExecutionJobInspection {
  return inspectExecutionJobInternal(cwd, jobId);
}

/**
 * Observe durable Job changes through its terminal state without acquiring
 * lifecycle authority or exposing the runtime's test-only dependencies.
 */
export function watchExecutionJob(
  cwd: string,
  jobId: string,
  options: ExecutionJobWatchOptions = {},
): AsyncGenerator<ExecutionJobInspection, void, void> {
  return watchExecutionJobInternal(cwd, jobId, options);
}
