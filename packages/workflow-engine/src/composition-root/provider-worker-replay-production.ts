/** Bind replay admission to the existing journal and owner-aware lifecycle services. */
import {
  admitProviderWorkerReplay as admitReplay,
  type ProviderWorkerReplayTaskMandate,
} from '../application/provider-worker/provider-worker-replay.ts';
import type { ProviderWorkerTerminalOptions } from '../application/provider-worker/provider-terminal-followups.ts';
import { readProviderInvocationRequest } from '../runtime/storage-journal/provider-invocation-artifacts.ts';
import {
  providerCompletionCandidateExists,
  recoverProviderInvocationCompletion,
  recoverProviderInvocationCompletionForWorkerUnderLifecycleLock,
  recoverProviderInvocationNativeContinuationForReplay,
} from '../runtime/storage-journal/provider-invocation-completion.ts';
import { readProviderInvocation } from '../runtime/storage-journal/provider-invocation-state.ts';
import { productionConsumedRoleResultReplayPort } from './grant-verifier-composition.ts';
import type { ProviderWorkerRepositoryContext } from '../application/provider-worker/provider-worker-execution.ts';
import { runProviderWorkerTerminalFollowups } from './provider-worker-terminal-production.ts';
import {
  assertTaskDiffReviewProviderOwnerCurrent,
  withTaskDiffReviewProviderLifecycleOperation,
} from './task-diff-review-production.ts';

export function admitProviderWorkerReplay(
  taskMandate: ProviderWorkerReplayTaskMandate,
  cwd: string,
  context: ProviderWorkerRepositoryContext,
  requestedInvocationId: string,
  options: ProviderWorkerTerminalOptions,
) {
  return admitReplay(
    {
      recoverNativeContinuation: (invocationId) =>
        recoverProviderInvocationNativeContinuationForReplay(
          context.runtime,
          invocationId,
        ),
      readInvocation: (invocationId) =>
        readProviderInvocation(context.runtime, invocationId),
      readRequest: (record) =>
        readProviderInvocationRequest(context.runtime, record.invocationId),
      completionCandidateExists: (record) =>
        providerCompletionCandidateExists(context.runtime, record.invocationId),
      recoverCompletion: (record) =>
        recoverProviderInvocationCompletion(
          context.runtime,
          record.invocationId,
          { expectedRevision: record.revision },
        ),
      recoverCompletionUnderLifecycleLock: (record, assertOwned) =>
        recoverProviderInvocationCompletionForWorkerUnderLifecycleLock(
          context.runtime,
          record.invocationId,
          { expectedRevision: record.revision },
          assertOwned,
        ),
      assertTaskDiffReviewProviderOwnerCurrent,
      withTaskDiffReviewProviderLifecycleOperation,
      taskMandate,
      consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
      runTerminalFollowups: runProviderWorkerTerminalFollowups,
    },
    cwd,
    requestedInvocationId,
    options,
  );
}
