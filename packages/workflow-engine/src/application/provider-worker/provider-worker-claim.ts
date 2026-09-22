/** Admit the current owner and acquire its exact provider lease and worker fence. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  TaskMandateActiveBinding,
  TaskMandateProviderAdmission,
} from '../../modules/authority/task-mandate-access-contract.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import { isProposeExemptionInvestigationId } from '../../modules/investigation/domain/investigation-store-values.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type {
  ProviderDispatchObserver,
  ProviderWorkerAssignmentOptions,
} from '../../modules/provider-orchestration/provider-dispatch.ts';
import type {
  ProviderWorkerClaimInput,
  ProviderWorkerLeaseClaim,
} from '../../modules/provider-orchestration/provider-invocation-lifecycle.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import type { ConsumedRoleResultReplayPort } from '../../modules/provider-orchestration/role-admission-contracts.ts';
import type { TaskStrategyImplementationLifecycle } from '../execute-task/task-strategy-implementation-lifecycle.ts';
import type { TaskDiffReviewOperations } from '../finalize/task-diff-review-lifecycle.ts';

export type ProviderWorkerClaimTaskMandate = Pick<
  TaskMandateActiveBinding,
  | 'assertActiveTaskMandateBindingUnderLifecycleLock'
  | 'withActiveTaskMandateBinding'
> &
  Pick<
    TaskMandateProviderAdmission,
    'recordTaskMandateProviderInvocationUnderLifecycleLock'
  >;

export type ProviderWorkerClaimOptions = ProviderWorkerAssignmentOptions & {
  workerId?: string;
};

/** Original observations remain live references throughout admission. */
export type ProviderWorkerClaimObservation = {
  initial: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
  taskDiffReviewOwner: ReturnType<
    TaskDiffReviewOperations['assertTaskDiffReviewProviderOwnerCurrent']
  > | null;
  taskStrategyImplementationOwner: ReturnType<
    TaskStrategyImplementationLifecycle['assertTaskStrategyImplementationProviderOwnerCurrent']
  > | null;
};

type OwnerFacts = Pick<ProviderInvocationRecord, 'changeId' | 'mandateBinding'>;

export type ProviderWorkerClaimEffects = {
  taskMandate: ProviderWorkerClaimTaskMandate;
  resolveAssignment: ReturnType<ProviderDispatchObserver>['resolveAssignment'];
  assertTaskDiffReviewProviderOwnerCurrent: TaskDiffReviewOperations['assertTaskDiffReviewProviderOwnerCurrent'];
  withTaskDiffReviewProviderLifecycleOperation: TaskDiffReviewOperations['withTaskDiffReviewProviderLifecycleOperation'];
  assertTaskStrategyImplementationProviderOwnerCurrent: TaskStrategyImplementationLifecycle['assertTaskStrategyImplementationProviderOwnerCurrent'];
  consumedRoleResultReplay: ConsumedRoleResultReplayPort;
  readProposeExemptionOwner(): OwnerFacts;
  readInvestigationOwner(): OwnerFacts;
  claim(input: ProviderWorkerClaimInput): ProviderWorkerLeaseClaim;
  claimUnderLifecycleLock(
    input: ProviderWorkerClaimInput,
    assertOwned: () => void,
  ): ProviderWorkerLeaseClaim;
};

export function claimProviderWorker(
  effects: ProviderWorkerClaimEffects,
  cwd: string,
  observation: ProviderWorkerClaimObservation,
  options: ProviderWorkerClaimOptions,
) {
  const {
    taskMandate,
    resolveAssignment,
    assertTaskDiffReviewProviderOwnerCurrent,
    withTaskDiffReviewProviderLifecycleOperation,
    assertTaskStrategyImplementationProviderOwnerCurrent,
    consumedRoleResultReplay,
    readProposeExemptionOwner,
    readInvestigationOwner,
    claim: claimOrdinary,
    claimUnderLifecycleLock,
  } = effects;
  const {
    initial,
    request,
    taskDiffReviewOwner,
    taskStrategyImplementationOwner,
  } = observation;

  // Grant admission precedes the provider lease. A missing role-assignment
  // activation must leave this exact invocation prepared so Human Gate can
  // authorize it and the same worker command can be retried.
  resolveAssignment(options);
  const claimInput = {
    workerId:
      options.workerId ??
      `provider-worker-${process.pid}-${initial.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    expectedRevision: initial.revision,
  };
  const claimWithActiveMandate = (
    activeBinding: TaskMandateBinding,
    assertOwned: () => void,
  ) => {
    const owner =
      taskDiffReviewOwner !== null
        ? assertTaskDiffReviewProviderOwnerCurrent(cwd, initial.invocationId, {
            consumedRoleResultReplay,
          })
        : taskStrategyImplementationOwner !== null
          ? assertTaskStrategyImplementationProviderOwnerCurrent(
              cwd,
              initial.invocationId,
            )
          : isProposeExemptionInvestigationId(initial.investigationId)
            ? readProposeExemptionOwner()
            : readInvestigationOwner();
    if (
      owner.changeId !== initial.changeId ||
      canonicalJson(owner.mandateBinding ?? null) !==
        canonicalJson(activeBinding) ||
      canonicalJson(initial.mandateBinding) !== canonicalJson(activeBinding)
    ) {
      throw workflowError(
        'TASK_MANDATE_BINDING_STALE',
        'Provider worker invocation no longer matches its durable Task Mandate owner.',
        ExitCode.staleState,
      );
    }
    taskMandate.recordTaskMandateProviderInvocationUnderLifecycleLock(
      cwd,
      activeBinding,
      {
        providerId: request.providerId,
        invocationId: initial.invocationId,
        requestDigest: request.requestDigest,
        occurredAt: initial.createdAt,
      },
      assertOwned,
    );
    return claimUnderLifecycleLock(claimInput, assertOwned);
  };
  const claim = initial.mandateBinding
    ? taskDiffReviewOwner !== null
      ? withTaskDiffReviewProviderLifecycleOperation(
          cwd,
          taskDiffReviewOwner.sessionId,
          (assertOwned) =>
            claimWithActiveMandate(
              taskMandate.assertActiveTaskMandateBindingUnderLifecycleLock(
                cwd,
                initial.mandateBinding!,
                assertOwned,
              ),
              assertOwned,
            ),
        )
      : taskMandate.withActiveTaskMandateBinding(
          cwd,
          initial.mandateBinding.mandateTaskId,
          {},
          claimWithActiveMandate,
        )
    : claimOrdinary(claimInput);
  return { claim, claimInput };
}
