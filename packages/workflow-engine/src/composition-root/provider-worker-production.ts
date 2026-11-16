/** Bind the complete worker use case to the existing journal and process owners. */
import {
  runProviderWorkerWithMandate as runWithMandate,
  runProviderWorkerAsyncWithMandate as runAsyncWithMandate,
  type ProviderWorkerExecutionEffects,
} from '../application/provider-worker/provider-worker-execution.ts';
import { taskMandateOperations } from './task-mandate-production.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { admitProviderWorkerReplay } from './provider-worker-replay-production.ts';
import { claimProviderWorker } from './provider-worker-claim-production.ts';
import { recordProviderWorkerFailure } from './provider-worker-failure-production.ts';
import { runProviderWorkerTerminalFollowups as runTerminalFollowups } from './provider-worker-terminal-production.ts';
import { assertTaskStrategyImplementationProviderOwnerCurrent } from './task-strategy-production.ts';
import { resolveCurrentProviderWorkerAssignment } from './provider-worker-assignment-production.ts';
import { productionAgentRuntime } from './agent-runtime-production.ts';
import {
  providerAcceptanceGovernedRuntimeInputs,
  providerInvocationDurableGovernedRuntimeInputs,
} from '../runtime/provider-execution/provider-runner.ts';
import { createProviderInvocationCancellationWatcher } from '../runtime/provider-execution/provider-worker-cancellation.ts';
import { startProviderInvocationActivityHeartbeat } from '../runtime/storage-journal/provider-invocation-activity.ts';
import { readPlanReviewSnapshotRuntime } from '../runtime/storage-journal/provider-invocation-artifacts.ts';
import {
  readProviderInvocation,
  readProviderInvocationRuntimeReceipt,
  prepareProviderInvocationAcceptanceBinding,
  assertProviderInvocationAcceptanceBindingTerminalCurrent,
} from '../runtime/storage-journal/provider-invocation-state.ts';
import {
  completeProviderInvocationFromRunner,
  completeProviderInvocationFromRunnerForWorkerClaim,
  completeProviderInvocationFromRunnerUnderLifecycleLock,
} from '../runtime/storage-journal/provider-invocation-completion.ts';
import {
  releaseProviderInvocationWorkerFence,
  releaseProviderInvocationWorkerFenceForWorkerClaim,
} from '../runtime/storage-journal/provider-invocation-workers.ts';
import { withRepositoryLifecycleOperation } from '../runtime/session-workspace/repository-lifecycle-lock.ts';

const effects: ProviderWorkerExecutionEffects = {
  loadInvestigationRuntimeContext,
  admitProviderWorkerReplay,
  claimProviderWorker,
  recordProviderWorkerFailure,
  runTerminalFollowups,
  assertTaskStrategyImplementationProviderOwnerCurrent,
  readPlanReviewSnapshotRuntime,
  readProviderInvocation,
  readProviderInvocationRuntimeReceipt,
  prepareProviderInvocationAcceptanceBinding,
  assertProviderInvocationAcceptanceBindingTerminalCurrent,
  completeProviderInvocationFromRunner,
  completeProviderInvocationFromRunnerForWorkerClaim,
  completeProviderInvocationFromRunnerUnderLifecycleLock,
  releaseProviderInvocationWorkerFence,
  releaseProviderInvocationWorkerFenceForWorkerClaim,
  withRepositoryLifecycleOperation,
  resolveAssignment(context, initial, request, options) {
    return resolveCurrentProviderWorkerAssignment(
      {
        repositoryRoot: context.git.repositoryRoot,
        runtime: context.runtime,
        grantRuntimeRoot: context.lifecycleRuntime.root,
        changeId: initial.changeId,
        request,
      },
      options,
    );
  },
  providerAcceptanceGovernedRuntimeInputs,
  providerInvocationDurableGovernedRuntimeInputs,
  productionAgentRuntime,
  createProviderInvocationCancellationWatcher,
  startProviderInvocationActivityHeartbeat,
};

export const runProviderWorkerWithMandate = runWithMandate.bind(
  undefined,
  effects,
);
export const runProviderWorkerAsyncWithMandate = runAsyncWithMandate.bind(
  undefined,
  effects,
);
export const runProviderWorker = runProviderWorkerWithMandate.bind(
  undefined,
  taskMandateOperations,
);
export const runProviderWorkerAsync = runProviderWorkerAsyncWithMandate.bind(
  undefined,
  taskMandateOperations,
);

export type {
  ProviderWorkerResult,
  AsyncProviderWorkerResult,
  ProviderWorkerOptions,
} from '../application/provider-worker/provider-worker-execution.ts';
