/** Bind the claim use case to the existing assignment, owner, and journal services. */
import {
  claimProviderWorker as claim,
  type ProviderWorkerClaimObservation,
  type ProviderWorkerClaimOptions,
  type ProviderWorkerClaimTaskMandate,
} from '../application/provider-worker/provider-worker-claim.ts';
import { readInvestigationSession } from '../runtime/storage-journal/investigation-session-records.ts';
import {
  claimProviderInvocationForWorker,
  claimProviderInvocationForWorkerUnderLifecycleLock,
} from '../runtime/storage-journal/provider-invocation-workers.ts';
import { readProposeExemptionSession } from '../runtime/storage-journal/propose-exemption-store.ts';
import { productionConsumedRoleResultReplayPort } from './grant-verifier-composition.ts';
import type { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { resolveCurrentProviderWorkerAssignment } from './provider-worker-assignment-production.ts';
import {
  assertTaskDiffReviewProviderOwnerCurrent,
  withTaskDiffReviewProviderLifecycleOperation,
} from './task-diff-review-production.ts';
import { assertTaskStrategyImplementationProviderOwnerCurrent } from './task-strategy-production.ts';

export function claimProviderWorker(
  taskMandate: ProviderWorkerClaimTaskMandate,
  cwd: string,
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  observation: ProviderWorkerClaimObservation,
  options: ProviderWorkerClaimOptions,
) {
  const { initial, request } = observation;
  return claim(
    {
      taskMandate,
      resolveAssignment(options) {
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
      assertTaskDiffReviewProviderOwnerCurrent,
      withTaskDiffReviewProviderLifecycleOperation,
      assertTaskStrategyImplementationProviderOwnerCurrent,
      consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
      readProposeExemptionOwner: () =>
        readProposeExemptionSession(context.runtime, initial.investigationId),
      readInvestigationOwner: () =>
        readInvestigationSession(context.runtime, initial.investigationId),
      claim: (input) =>
        claimProviderInvocationForWorker(
          context.runtime,
          initial.invocationId,
          input,
        ),
      claimUnderLifecycleLock: (input, assertOwned) =>
        claimProviderInvocationForWorkerUnderLifecycleLock(
          context.runtime,
          initial.invocationId,
          input,
          assertOwned,
        ),
    },
    cwd,
    observation,
    options,
  );
}

export type { ProviderWorkerClaimOptions, ProviderWorkerClaimTaskMandate };
