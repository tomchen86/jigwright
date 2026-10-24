/** Binds strict invocation observations, current assignment and the detached launcher. */
import { createProviderDispatchService } from '../application/provider-worker/provider-dispatch.ts';
import type {
  ProviderDispatchObserver,
  ProviderWorkerAssignmentOptions,
  ProviderWorkerDispatcher,
} from '../modules/provider-orchestration/provider-dispatch.ts';
import {
  createProviderWorkerLauncher,
  launchProviderWorker,
  type ProviderDispatcherHost,
} from '../runtime/provider-execution/provider-worker-launcher.ts';
import { readProviderInvocation } from '../runtime/storage-journal/provider-invocation-state.ts';
import { readProviderInvocationRequest } from '../runtime/storage-journal/provider-invocation-artifacts.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { resolveCurrentProviderWorkerAssignment } from './provider-worker-assignment-production.ts';

const observe: ProviderDispatchObserver = (cwd, requestedInvocationId) => {
  const context = loadInvestigationRuntimeContext(cwd);
  const record = readProviderInvocation(context.runtime, requestedInvocationId);
  return {
    repositoryRoot: context.git.repositoryRoot,
    invocation: record,
    resolveAssignment(options) {
      const request = readProviderInvocationRequest(
        context.runtime,
        requestedInvocationId,
      );
      return resolveCurrentProviderWorkerAssignment(
        {
          repositoryRoot: context.git.repositoryRoot,
          runtime: context.runtime,
          grantRuntimeRoot: context.lifecycleRuntime.root,
          changeId: record.changeId,
          request,
        },
        options,
      );
    },
  };
};

const productionDispatch = createProviderDispatchService({
  observe,
  launch: launchProviderWorker,
});
export const dispatchProviderWorker: ProviderWorkerDispatcher =
  productionDispatch.dispatch;
export const preflightProviderWorkerAssignment =
  productionDispatch.preflightProviderWorkerAssignment;

/** Retains real strict reads and Grant admission while substituting only the host. */
export function createProviderWorkerDispatcherForTesting(
  host: ProviderDispatcherHost,
  preflightOptions: ProviderWorkerAssignmentOptions = {},
): ProviderWorkerDispatcher {
  const service = createProviderDispatchService({
    observe,
    launch: createProviderWorkerLauncher(host),
  });
  return (cwd, invocationId) =>
    service.dispatch(cwd, invocationId, preflightOptions);
}

export type { ProviderWorkerDispatcher };
