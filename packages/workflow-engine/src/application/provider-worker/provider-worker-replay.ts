/** Recover durable provider state and decide replay versus prepared execution. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { TaskMandateActiveBinding } from '../../modules/authority/task-mandate-access-contract.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderCompletionRecovery } from '../../modules/provider-orchestration/provider-invocation-lifecycle.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import type { ConsumedRoleResultReplayPort } from '../../modules/provider-orchestration/role-admission-contracts.ts';
import type { TaskDiffReviewOperations } from '../finalize/task-diff-review-lifecycle.ts';
import type {
  runProviderWorkerTerminalFollowups,
  ProviderWorkerTerminalOptions,
} from './provider-terminal-followups.ts';

export type ProviderWorkerReplayTaskMandate = Pick<
  TaskMandateActiveBinding,
  'assertActiveTaskMandateBindingUnderLifecycleLock'
>;

type TerminalFollowups = typeof runProviderWorkerTerminalFollowups extends (
  effects: infer _Effects,
  ...args: infer Args
) => infer Result
  ? (...args: Args) => Result
  : never;

export type ProviderWorkerReplayEffects = {
  recoverNativeContinuation(
    requestedInvocationId: string,
  ): ProviderInvocationRecord | null;
  readInvocation(requestedInvocationId: string): ProviderInvocationRecord;
  readRequest(record: ProviderInvocationRecord): ProviderInvocationRequest;
  completionCandidateExists(record: ProviderInvocationRecord): boolean;
  recoverCompletion(
    record: ProviderInvocationRecord,
  ): ProviderCompletionRecovery;
  recoverCompletionUnderLifecycleLock(
    record: ProviderInvocationRecord,
    assertOwned: () => void,
  ): ProviderCompletionRecovery;
  assertTaskDiffReviewProviderOwnerCurrent: TaskDiffReviewOperations['assertTaskDiffReviewProviderOwnerCurrent'];
  withTaskDiffReviewProviderLifecycleOperation: TaskDiffReviewOperations['withTaskDiffReviewProviderLifecycleOperation'];
  taskMandate: ProviderWorkerReplayTaskMandate;
  consumedRoleResultReplay: ConsumedRoleResultReplayPort;
  runTerminalFollowups: TerminalFollowups;
};

export type ProviderWorkerReplayDecision =
  | { kind: 'replay'; record: ProviderInvocationRecord }
  | {
      kind: 'prepared';
      initial: ProviderInvocationRecord;
      request: ProviderInvocationRequest;
      taskDiffReviewOwner: ReturnType<
        TaskDiffReviewOperations['assertTaskDiffReviewProviderOwnerCurrent']
      > | null;
    };

export function admitProviderWorkerReplay(
  effects: ProviderWorkerReplayEffects,
  cwd: string,
  requestedInvocationId: string,
  options: ProviderWorkerTerminalOptions,
): ProviderWorkerReplayDecision {
  const {
    recoverNativeContinuation,
    readInvocation,
    readRequest,
    completionCandidateExists,
    recoverCompletion,
    recoverCompletionUnderLifecycleLock,
    assertTaskDiffReviewProviderOwnerCurrent,
    consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
    runTerminalFollowups,
  } = effects;
  let initial =
    recoverNativeContinuation(requestedInvocationId) ??
    readInvocation(requestedInvocationId);
  const request = readRequest(initial);
  const taskDiffReviewOwner =
    request.purpose === 'task-diff-review' &&
    initial.state !== 'succeeded' &&
    initial.state !== 'failed'
      ? assertTaskDiffReviewProviderOwnerCurrent(cwd, initial.invocationId, {
          consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
        })
      : null;
  if (initial.state === 'leased' && completionCandidateExists(initial)) {
    initial =
      taskDiffReviewOwner === null
        ? recoverCompletion(initial).record
        : withCurrentTaskDiffReviewProviderLifecycle(
            effects,
            cwd,
            initial,
            taskDiffReviewOwner.sessionId,
            (assertOwned) =>
              recoverCompletionUnderLifecycleLock(initial, assertOwned).record,
          );
  }
  if (initial.state !== 'prepared') {
    if (initial.state === 'succeeded' || initial.state === 'failed') {
      runTerminalFollowups(cwd, initial, options);
    }
    return { kind: 'replay', record: initial };
  }
  return { kind: 'prepared', initial, request, taskDiffReviewOwner };
}

function withCurrentTaskDiffReviewProviderLifecycle<T>(
  {
    taskMandate,
    assertTaskDiffReviewProviderOwnerCurrent,
    withTaskDiffReviewProviderLifecycleOperation,
    consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
  }: Pick<
    ProviderWorkerReplayEffects,
    | 'taskMandate'
    | 'assertTaskDiffReviewProviderOwnerCurrent'
    | 'withTaskDiffReviewProviderLifecycleOperation'
    | 'consumedRoleResultReplay'
  >,
  cwd: string,
  invocation: ProviderInvocationRecord,
  sessionId: string,
  operation: (assertOwned: () => void) => T,
): T {
  return withTaskDiffReviewProviderLifecycleOperation(
    cwd,
    sessionId,
    (assertOwned) => {
      assertOwned();
      const owner = assertTaskDiffReviewProviderOwnerCurrent(
        cwd,
        invocation.invocationId,
        {
          consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
        },
      );
      if (
        owner.sessionId !== sessionId ||
        owner.changeId !== invocation.changeId ||
        canonicalJson(owner.mandateBinding ?? null) !==
          canonicalJson(invocation.mandateBinding ?? null)
      ) {
        throw workflowError(
          'TASK_MANDATE_BINDING_STALE',
          'TaskDiffReview provider invocation no longer matches its exact durable owner.',
          ExitCode.staleState,
        );
      }
      if (
        invocation.mandateBinding !== undefined &&
        invocation.mandateBinding !== null
      ) {
        taskMandate.assertActiveTaskMandateBindingUnderLifecycleLock(
          cwd,
          invocation.mandateBinding,
          assertOwned,
        );
      }
      assertOwned();
      return operation(assertOwned);
    },
  );
}
