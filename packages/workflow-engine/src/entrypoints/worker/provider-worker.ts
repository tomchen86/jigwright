import path from 'node:path';
import { spawn } from 'node:child_process';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  assertReadOnlyProbe,
  type ExecutionFailureKind,
  type ReadOnlyProbeRequest,
} from '../../modules/provider-orchestration/execution-core.ts';
import type {
  AgentRuntimeAssignmentBindingV1,
  AgentRuntimeCompletionReceipt,
  AgentRuntimeHostExecutionBindingV1,
  AgentRuntimeHostProbeEvidenceV1,
  AgentRuntimePort,
  AgentRuntimeProcessProgressProjection,
  AgentRuntimeSingleShotInput,
  AgentRuntimeSingleShotOptions,
  AgentRuntimeSingleShotReport,
  ProviderInvocationAcceptanceBinding,
  ProviderRuntimeProtocolReceipt,
} from '../../composition-root/agent-runtime-production.ts';
import { readInvestigationSession } from '../../runtime/storage-journal/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import {
  createAgentRuntimeHostExecutionBindingV1,
  createAgentRuntimeProgressTracker,
  productionAgentRuntime,
  providerAcceptanceGovernedRuntimeInputs,
  providerInvocationDurableGovernedRuntimeInputs,
} from '../../composition-root/agent-runtime-production.ts';
import {
  createCurrentAgentRuntimeAssignmentV1,
  type CurrentAgentRuntimeAssignmentV1,
} from '../../composition-root/change-role-assignment-production.ts';
import {
  productionConsumedPlanReviewReplayPort,
  productionConsumedRoleResultReplayPort,
} from '../../composition-root/grant-verifier-composition.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from '../../modules/assurance/plan-review.ts';
import {
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import {
  assertTaskDiffReviewProviderOwnerCurrent,
  withTaskDiffReviewProviderLifecycleOperation,
} from '../../application/finalize/task-diff-review-lifecycle.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
  TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA,
  taskStrategyImplementationOutputValidator,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import { assertTaskStrategyImplementationProviderOwnerCurrent } from '../../application/execute-task/task-strategy-implementation-lifecycle.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyOutputValidator,
  assertProviderInvocationAcceptanceBindingTerminalCurrent,
  claimProviderInvocationForWorker,
  claimProviderInvocationForWorkerUnderLifecycleLock,
  completeProviderInvocationFromRunner,
  completeProviderInvocationFromRunnerForWorkerClaim,
  completeProviderInvocationFromRunnerUnderLifecycleLock,
  failProviderInvocation,
  failProviderInvocationForWorkerClaim,
  prepareProviderInvocationAcceptanceBinding,
  providerCompletionCandidateExists,
  recoverProviderInvocationCompletion,
  recoverProviderInvocationCompletionForWorkerUnderLifecycleLock,
  recoverProviderInvocationNativeContinuationForReplay,
  releaseProviderInvocationWorkerFence,
  releaseProviderInvocationWorkerFenceForWorkerClaim,
  readPlanReviewSnapshotRuntime,
  readProviderInvocation,
  readProviderInvocationCancellationRequestForWorkerClaim,
  readProviderInvocationRuntimeReceipt,
  readProviderInvocationRequest,
  type ProviderInvocationFailure,
  type ProviderInvocationRecord,
} from '../../runtime/storage-journal/provider-invocation-store.ts';
import {
  isProposeExemptionInvestigationId,
  readProposeExemptionSession,
} from '../../runtime/storage-journal/propose-exemption-store.ts';
import { extractProviderRepairFailure } from '../../runtime/provider-execution/provider-execution-governance.ts';
import {
  processProviderFailureRetry,
  pumpProviderRetrySchedules,
  type ProviderRetrySchedulePumpOptions,
} from '../../runtime/provider-execution/provider-retry-scheduler.ts';
import { runEvidenceRetentionMaintenance } from '../../runtime/provider-execution/retention-control.ts';
import { withRepositoryLifecycleOperation } from '../../runtime/session-workspace/session-store.ts';
import {
  assertActiveTaskMandateBindingUnderLifecycleLock,
  recordTaskMandateProviderInvocationUnderLifecycleLock,
  withActiveTaskMandateBinding,
  type TaskMandateBinding,
} from '../../modules/authority/task-mandate.ts';
import { recordProviderWorkerMaintenanceWarning } from '../../runtime/storage-journal/provider-worker-maintenance.ts';

const PROVIDER_CANCELLATION_POLL_INTERVAL_MS = 25;

export {
  listProviderWorkerMaintenanceWarnings,
  type ProviderWorkerMaintenanceWarning,
} from '../../runtime/storage-journal/provider-worker-maintenance.ts';

export type ProviderWorkerResult = {
  schemaVersion: 1;
  kind: 'provider-worker-result';
  invocationId: string;
  state: 'leased' | 'succeeded' | 'failed';
  revision: number;
  launched: boolean;
  failure: { kind: string; code: string; message: string } | null;
};

export type AsyncProviderWorkerResult = ProviderWorkerResult &
  Readonly<{
    completionReceipt: AgentRuntimeCompletionReceipt | null;
  }>;

export type ProviderWorkerOptions = {
  workerId?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  agentRuntime?: AgentRuntimePort;
  /** Explicit host-owned config path; production may supply the same path by env. */
  agentProviderConfigPath?: string;
  /** @deprecated Use the core-owned `agentRuntime` port injection seam. */
  runner?: AgentRuntimePort['runSingleShot'];
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
  retentionMaintenance?: typeof runEvidenceRetentionMaintenance;
};

export type ProviderDispatchResult = {
  schemaVersion: 1;
  kind: 'provider-worker-dispatch';
  invocationId: string;
  pid: number;
};

type ProviderDispatcherHost = {
  spawn(
    executable: string,
    args: string[],
    options: {
      cwd: string;
      detached: true;
      stdio: 'ignore';
      env: NodeJS.ProcessEnv;
    },
  ): { pid?: number; unref(): void };
};

/** Production detached dispatch of the hidden lifecycle-owned worker command. */
export function dispatchProviderWorker(
  cwd: string,
  invocationId: string,
): ProviderDispatchResult {
  return createProviderWorkerDispatcher(realDispatcherHost())(
    cwd,
    invocationId,
  );
}

/** The only dispatch injection seam; registered tests never launch a model. */
export function createProviderWorkerDispatcherForTesting(
  host: ProviderDispatcherHost,
  preflightOptions: ProviderWorkerOptions = {},
): (cwd: string, invocationId: string) => ProviderDispatchResult {
  return createProviderWorkerDispatcher(host, preflightOptions);
}

/**
 * Claim and execute one exact durable provider invocation. Replays never
 * manufacture replacement work: an already leased or terminal record is
 * rendered from its durable state, while only `prepared` may acquire a lease.
 */
export function runProviderWorker(
  cwd: string,
  requestedInvocationId: string,
  options: ProviderWorkerOptions = {},
): ProviderWorkerResult {
  const result = runProviderWorkerWithExecution(
    cwd,
    requestedInvocationId,
    options,
    (agentRuntime, input, runtimeOptions) =>
      agentRuntime.runSingleShot(input, runtimeOptions),
    'synchronous-no-activity',
  );
  if (isPromiseLike(result)) {
    throw new TypeError('Synchronous provider worker returned a promise.');
  }
  return result;
}

/** Production worker path: async process execution with a typed completion receipt. */
export async function runProviderWorkerAsync(
  cwd: string,
  requestedInvocationId: string,
  options: ProviderWorkerOptions = {},
): Promise<AsyncProviderWorkerResult> {
  const progress = createAgentRuntimeProgressTracker();
  let failureProtocolReceipt: ProviderRuntimeProtocolReceipt | null = null;
  let failureHostProbeEvidence: AgentRuntimeHostProbeEvidenceV1 | null = null;
  let failureHostExecutionBinding: AgentRuntimeHostExecutionBindingV1 | null =
    null;
  const result = await runProviderWorkerWithExecution(
    cwd,
    requestedInvocationId,
    options,
    (agentRuntime, input, runtimeOptions) => {
      if (agentRuntime.runSingleShotAsync === undefined) {
        throw workflowError(
          'AGENT_RUNTIME_ASYNC_UNAVAILABLE',
          'The selected Agent Runtime does not implement asynchronous execution.',
          ExitCode.verification,
        );
      }
      return agentRuntime
        .runSingleShotAsync(input, {
          ...runtimeOptions,
          onActivity: progress.record,
          onProtocolReceipt(receipt) {
            if (failureProtocolReceipt !== null) {
              throw new TypeError(
                'Agent Runtime emitted more than one terminal failure receipt.',
              );
            }
            failureProtocolReceipt = receipt;
          },
          onHostProbeEvidence(evidence) {
            if (failureHostProbeEvidence !== null) {
              throw new TypeError(
                'Agent Runtime emitted more than one host probe evidence value.',
              );
            }
            failureHostProbeEvidence = evidence;
          },
          onHostExecutionBinding(binding) {
            if (failureHostExecutionBinding !== null) {
              throw new TypeError(
                'Agent Runtime emitted more than one host execution binding.',
              );
            }
            failureHostExecutionBinding = binding;
          },
        })
        .then((report) => {
          progress.assertSuccessfulCompletion();
          return report;
        });
    },
    'schema-v4',
    () => progress.snapshot(),
    () => failureProtocolReceipt,
    () => failureHostProbeEvidence,
    () => failureHostExecutionBinding,
    true,
  );
  const context = loadInvestigationRuntimeContext(cwd);
  return Object.freeze({
    ...result,
    completionReceipt: readProviderInvocationRuntimeReceipt(
      context.runtime,
      result.invocationId,
    ),
  });
}

type ProviderWorkerExecution = (
  agentRuntime: AgentRuntimePort,
  input: AgentRuntimeSingleShotInput,
  options: AgentRuntimeSingleShotOptions,
) => AgentRuntimeSingleShotReport | Promise<AgentRuntimeSingleShotReport>;

function withCurrentTaskDiffReviewProviderLifecycle<T>(
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
        assertActiveTaskMandateBindingUnderLifecycleLock(
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

function runProviderWorkerWithExecution(
  cwd: string,
  requestedInvocationId: string,
  options: ProviderWorkerOptions,
  execute: ProviderWorkerExecution,
  receiptRequirement: 'schema-v4' | 'synchronous-no-activity',
  runtimeProgress?: () => AgentRuntimeProcessProgressProjection,
  runtimeFailureProtocolReceipt?: () => ProviderRuntimeProtocolReceipt | null,
  runtimeFailureHostProbeEvidence?: () => AgentRuntimeHostProbeEvidenceV1 | null,
  runtimeFailureHostExecutionBinding?: () => AgentRuntimeHostExecutionBindingV1 | null,
  watchDurableCancellation = false,
): ProviderWorkerResult | Promise<ProviderWorkerResult> {
  const context = loadInvestigationRuntimeContext(cwd);
  let initial =
    recoverProviderInvocationNativeContinuationForReplay(
      context.runtime,
      requestedInvocationId,
    ) ?? readProviderInvocation(context.runtime, requestedInvocationId);
  const request = readProviderInvocationRequest(
    context.runtime,
    initial.invocationId,
  );
  const taskDiffReviewOwner =
    request.purpose === 'task-diff-review' &&
    initial.state !== 'succeeded' &&
    initial.state !== 'failed'
      ? assertTaskDiffReviewProviderOwnerCurrent(cwd, initial.invocationId, {
          consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
        })
      : null;
  if (
    initial.state === 'leased' &&
    providerCompletionCandidateExists(context.runtime, initial.invocationId)
  ) {
    initial =
      taskDiffReviewOwner === null
        ? recoverProviderInvocationCompletion(
            context.runtime,
            initial.invocationId,
            { expectedRevision: initial.revision },
          ).record
        : withCurrentTaskDiffReviewProviderLifecycle(
            cwd,
            initial,
            taskDiffReviewOwner.sessionId,
            (assertOwned) =>
              recoverProviderInvocationCompletionForWorkerUnderLifecycleLock(
                context.runtime,
                initial.invocationId,
                { expectedRevision: initial.revision },
                assertOwned,
              ).record,
          );
  }
  if (initial.state !== 'prepared') {
    if (initial.state === 'succeeded' || initial.state === 'failed') {
      runTerminalFollowups(cwd, initial, options);
    }
    return renderWorkerResult(initial, false);
  }

  const taskStrategyImplementationOwner =
    request.purpose === 'task-implementation'
      ? assertTaskStrategyImplementationProviderOwnerCurrent(
          cwd,
          initial.invocationId,
        )
      : null;
  const semantic = semanticContract(request);
  const taskStrategyOutputValidator =
    taskStrategyImplementationOwner === null
      ? null
      : taskStrategyImplementationOutputValidator({
          sessionId: taskStrategyImplementationOwner.subject.sessionId,
          sourceTree: taskStrategyImplementationOwner.subject.sourceTree,
        });
  const reviewSnapshot = readPlanReviewSnapshotRuntime(
    context.runtime,
    initial.invocationId,
  );
  // Grant admission precedes the provider lease. A missing role-assignment
  // activation must leave this exact invocation prepared so Human Gate can
  // authorize it and the same worker command can be retried.
  resolveCurrentAssignment(context, initial.changeId, request, options);
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
            consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
          })
        : taskStrategyImplementationOwner !== null
          ? assertTaskStrategyImplementationProviderOwnerCurrent(
              cwd,
              initial.invocationId,
            )
          : isProposeExemptionInvestigationId(initial.investigationId)
            ? readProposeExemptionSession(
                context.runtime,
                initial.investigationId,
              )
            : readInvestigationSession(
                context.runtime,
                initial.investigationId,
              );
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
    recordTaskMandateProviderInvocationUnderLifecycleLock(
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
    return claimProviderInvocationForWorkerUnderLifecycleLock(
      context.runtime,
      initial.invocationId,
      claimInput,
      assertOwned,
    );
  };
  const claim = initial.mandateBinding
    ? taskDiffReviewOwner !== null
      ? withTaskDiffReviewProviderLifecycleOperation(
          cwd,
          taskDiffReviewOwner.sessionId,
          (assertOwned) =>
            claimWithActiveMandate(
              assertActiveTaskMandateBindingUnderLifecycleLock(
                cwd,
                initial.mandateBinding!,
                assertOwned,
              ),
              assertOwned,
            ),
        )
      : withActiveTaskMandateBinding(
          cwd,
          initial.mandateBinding.mandateTaskId,
          {},
          claimWithActiveMandate,
        )
    : claimProviderInvocationForWorker(
        context.runtime,
        initial.invocationId,
        claimInput,
      );
  const cancellationWatcher = watchDurableCancellation
    ? createProviderInvocationCancellationWatcher(
        context.runtime,
        request.invocationId,
        claim,
        options.signal,
      )
    : null;
  const agentRuntime = resolveAgentRuntime(options);
  const runtimeInputBase: Omit<
    AgentRuntimeSingleShotInput,
    'acceptanceBinding'
  > = {
    providerId: request.providerId,
    repositoryRoot: context.git.repositoryRoot,
    invocationDirectory: path.join(
      context.runtime.invocations,
      request.invocationId,
    ),
    request,
    semanticOutputSchema: semantic.schema,
    outputValidator: taskStrategyOutputValidator ?? semantic.validator,
    governedRuntimeInputs:
      reviewSnapshot?.files.map(({ id, path: filePath }) => ({
        id,
        path: filePath,
      })) ?? [],
    reviewSnapshotRoot: reviewSnapshot?.root ?? null,
    sourceEnvironment: options.environment ?? process.env,
  };
  const runtimeOptions: AgentRuntimeSingleShotOptions = {
    platform: options.platform ?? process.platform,
    ...(cancellationWatcher === null
      ? {}
      : { signal: cancellationWatcher.signal }),
  };
  let preparedHostAssignmentBinding: AgentRuntimeAssignmentBindingV1 | null =
    null;
  const completeWithReport = (
    report: AgentRuntimeSingleShotReport,
    acceptanceBinding: ProviderInvocationAcceptanceBinding,
  ): ProviderInvocationRecord => {
    if (
      taskStrategyOutputValidator !== null &&
      taskStrategyOutputValidator.validate(report.semanticOutput) !== true
    ) {
      throw taskStrategyOutputSubjectMismatch();
    }
    assertProviderInvocationAcceptanceBindingTerminalCurrent(
      context.runtime,
      acceptanceBinding,
    );
    const completion = {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      report,
      acceptanceBinding,
      ...(runtimeProgress === undefined
        ? {}
        : { runtimeProgress: runtimeProgress() }),
    };
    if (
      taskDiffReviewOwner !== null ||
      cancellationWatcher?.hasExactCancellation() === true
    ) {
      return completeProviderInvocationFromRunnerForWorkerClaim(
        context.runtime,
        request.invocationId,
        { ...completion, workerFenceToken: claim.workerFenceToken },
      );
    }
    if (taskStrategyImplementationOwner === null) {
      return completeProviderInvocationFromRunner(
        context.runtime,
        request.invocationId,
        completion,
      );
    }
    return withRepositoryLifecycleOperation(
      context.lifecycleRuntime,
      (assertOwned) => {
        assertTaskStrategyImplementationProviderOwnerCurrent(
          cwd,
          request.invocationId,
        );
        assertOwned();
        return completeProviderInvocationFromRunnerUnderLifecycleLock(
          context.runtime,
          request.invocationId,
          completion,
          assertOwned,
        );
      },
    );
  };
  const failWithError = (
    error: unknown,
    acceptanceBinding: ProviderInvocationAcceptanceBinding | null,
  ): ProviderInvocationRecord => {
    const failure = classifyProviderFailure(error);
    const repair = extractProviderRepairFailure(error, semantic.schema);
    const protocolReceipt = runtimeFailureProtocolReceipt?.() ?? null;
    const observedHostBinding = runtimeFailureHostExecutionBinding?.() ?? null;
    const hostExecutionBinding =
      observedHostBinding ??
      (preparedHostAssignmentBinding === null
        ? null
        : createAgentRuntimeHostExecutionBindingV1({
            assignmentBinding: preparedHostAssignmentBinding,
            probe: runtimeFailureHostProbeEvidence?.() ?? null,
            nativeSessionClaim: null,
            nativeSessionCompletionDigest: null,
          }));
    const failureInput = {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      failure,
      ...(runtimeProgress === undefined || acceptanceBinding === null
        ? {}
        : {
            runtimeEvidence: {
              acceptanceBinding,
              progress: runtimeProgress(),
              ...(protocolReceipt === null ? {} : { protocolReceipt }),
              ...(hostExecutionBinding === null
                ? {}
                : { hostExecutionBinding }),
            },
          }),
      ...(repair === null ? {} : { repair }),
    };
    return taskDiffReviewOwner !== null ||
      cancellationWatcher?.hasExactCancellation() === true
      ? failProviderInvocationForWorkerClaim(
          context.runtime,
          request.invocationId,
          { ...failureInput, workerFenceToken: claim.workerFenceToken },
        )
      : failProviderInvocation(
          context.runtime,
          request.invocationId,
          failureInput,
        );
  };
  const renderTerminal = (
    terminal: ProviderInvocationRecord,
  ): ProviderWorkerResult => {
    runTerminalFollowups(cwd, terminal, options);
    return renderWorkerResult(terminal, true);
  };
  const releaseWorkerFence = () => {
    try {
      if (
        taskDiffReviewOwner !== null ||
        cancellationWatcher?.hasExactCancellation() === true
      ) {
        releaseProviderInvocationWorkerFenceForWorkerClaim(
          context.runtime,
          request.invocationId,
          {
            leaseGeneration: claim.record.leaseGeneration,
            leaseToken: claim.leaseToken,
            workerFenceToken: claim.workerFenceToken,
          },
        );
        return;
      }
      releaseProviderInvocationWorkerFence(
        context.runtime,
        request.invocationId,
        claim.workerFenceToken,
      );
    } finally {
      cancellationWatcher?.stop();
    }
  };
  let releaseSynchronously = true;
  let preparedAcceptanceBinding: ProviderInvocationAcceptanceBinding | null =
    null;
  try {
    const assignment = resolveCurrentAssignment(
      context,
      initial.changeId,
      request,
      options,
    );
    preparedHostAssignmentBinding =
      assignment?.nativeSessionTurn === null || assignment === null
        ? null
        : assignment.binding;
    const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
      context.runtime,
      request.invocationId,
      receiptRequirement,
    );
    preparedAcceptanceBinding = acceptanceBinding;
    const runtimeInput = {
      ...runtimeInputBase,
      acceptanceBinding,
      governedRuntimeInputs: [
        ...runtimeInputBase.governedRuntimeInputs,
        ...(assignment?.nativeSessionTurn === undefined ||
        assignment?.nativeSessionTurn === null
          ? []
          : providerAcceptanceGovernedRuntimeInputs(
              context.runtime,
              acceptanceBinding,
            ).concat(
              providerInvocationDurableGovernedRuntimeInputs(
                context.runtime,
                request.invocationId,
              ),
            )),
      ],
      ...(assignment === null
        ? {}
        : {
            assignmentBinding: assignment.binding,
            ...(assignment.nativeSessionTurn === null
              ? {}
              : { nativeSessionTurn: assignment.nativeSessionTurn }),
          }),
    };
    const report = execute(agentRuntime, runtimeInput, runtimeOptions);
    if (isPromiseLike(report)) {
      releaseSynchronously = false;
      return Promise.resolve(report)
        .then((completedReport) =>
          completeWithReport(completedReport, acceptanceBinding),
        )
        .catch((error) => failWithError(error, acceptanceBinding))
        .finally(releaseWorkerFence)
        .then(renderTerminal);
    }
    return renderTerminal(completeWithReport(report, acceptanceBinding));
  } catch (error) {
    if (
      isRoleAssignmentGrantRequired(error) &&
      isTerminalInvocation(
        readProviderInvocation(context.runtime, request.invocationId),
      )
    ) {
      throw error;
    }
    return renderTerminal(failWithError(error, preparedAcceptanceBinding));
  } finally {
    if (releaseSynchronously) releaseWorkerFence();
  }
}

function taskStrategyOutputSubjectMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_NATIVE_OUTPUT_INVALID',
    'Provider native output did not match the exact sealed task implementation subject.',
    ExitCode.verification,
    {
      details: {
        repair: {
          repairKind: 'semantic',
          previousOutput: {
            kind: 'provider-native-output-unavailable',
            reasonCode: 'TASK_STRATEGY_OUTPUT_SUBJECT_MISMATCH',
          },
          validationErrors: [
            {
              path: '/',
              code: 'SEMANTIC_VALIDATION_FAILED',
              message:
                'Task implementation output must bind the exact sealed session and source tree.',
            },
          ],
        },
      },
    },
  );
}

type ProviderInvocationCancellationWatcher = Readonly<{
  signal: AbortSignal;
  hasExactCancellation(): boolean;
  stop(): void;
}>;

function createProviderInvocationCancellationWatcher(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  invocationId: string,
  claim: ReturnType<typeof claimProviderInvocationForWorker>,
  externalSignal: AbortSignal | undefined,
): ProviderInvocationCancellationWatcher {
  const control = new AbortController();
  let stopped = false;
  let exactCancellation = false;
  let timer: NodeJS.Timeout | undefined;
  const inspect = (): boolean => {
    if (exactCancellation) return true;
    try {
      const request = readProviderInvocationCancellationRequestForWorkerClaim(
        runtime,
        invocationId,
        {
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          workerFenceToken: claim.workerFenceToken,
        },
      );
      if (request === null) return false;
      exactCancellation = true;
      control.abort();
      return true;
    } catch {
      // A malformed, forged, stale, or differently claimed request has no
      // cancellation authority. Durable storage validation remains responsible
      // for reporting that state; the provider process must keep its own result.
      return false;
    }
  };
  const poll = () => {
    if (stopped || inspect()) return;
    timer = setTimeout(poll, PROVIDER_CANCELLATION_POLL_INTERVAL_MS);
    timer.unref();
  };
  poll();
  return Object.freeze({
    signal:
      externalSignal === undefined
        ? control.signal
        : AbortSignal.any([externalSignal, control.signal]),
    hasExactCancellation: inspect,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  });
}

function createProviderWorkerDispatcher(
  host: ProviderDispatcherHost,
  preflightOptions: ProviderWorkerOptions = {},
) {
  return (
    cwd: string,
    requestedInvocationId: string,
  ): ProviderDispatchResult => {
    const context = loadInvestigationRuntimeContext(cwd);
    const record = readProviderInvocation(
      context.runtime,
      requestedInvocationId,
    );
    if (record.state !== 'prepared') {
      throw workflowError(
        'PROVIDER_INVOCATION_DISPATCH_CONFLICT',
        'Only the exact prepared provider invocation can be dispatched.',
        ExitCode.conflict,
      );
    }
    preflightProviderWorkerAssignment(
      cwd,
      requestedInvocationId,
      preflightOptions,
    );
    const child = host.spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(import.meta.dirname, '../../cli.ts'),
        'provider-worker',
        record.invocationId,
        '--json',
      ],
      {
        cwd: context.git.repositoryRoot,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    if (!Number.isSafeInteger(child.pid) || child.pid! < 1) {
      throw workflowError(
        'PROVIDER_WORKER_DISPATCH_FAILED',
        'The lifecycle-owned provider worker could not be dispatched.',
        ExitCode.verification,
      );
    }
    child.unref();
    return {
      schemaVersion: 1,
      kind: 'provider-worker-dispatch',
      invocationId: record.invocationId,
      pid: child.pid!,
    };
  };
}

export function preflightProviderWorkerAssignment(
  cwd: string,
  requestedInvocationId: string,
  options: ProviderWorkerOptions = {},
): CurrentAgentRuntimeAssignmentV1 | null {
  const context = loadInvestigationRuntimeContext(cwd);
  const record = readProviderInvocation(context.runtime, requestedInvocationId);
  if (record.state !== 'prepared') {
    throw workflowError(
      'PROVIDER_INVOCATION_DISPATCH_CONFLICT',
      'Only the exact prepared provider invocation can enter AgentRuntime Grant preflight.',
      ExitCode.conflict,
    );
  }
  const request = readProviderInvocationRequest(
    context.runtime,
    requestedInvocationId,
  );
  return resolveCurrentAssignment(context, record.changeId, request, options);
}

function realDispatcherHost(): ProviderDispatcherHost {
  return {
    spawn(executable, args, options) {
      return spawn(executable, args, options);
    },
  };
}

function semanticContract(
  request: ReturnType<typeof readProviderInvocationRequest>,
) {
  if (
    request.purpose === 'survey' &&
    request.outputSchema.id === BLIND_SURVEY_OUTPUT_SCHEMA.id &&
    request.outputSchema.version === BLIND_SURVEY_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest === BLIND_SURVEY_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
      validator: blindSurveyOutputValidator(request),
    };
  }
  if (
    request.purpose === 'plan-review' &&
    request.outputSchema.id === PLAN_REVIEW_OUTPUT_SCHEMA.id &&
    request.outputSchema.version === PLAN_REVIEW_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest === PLAN_REVIEW_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
      validator: PLAN_REVIEW_OUTPUT_VALIDATOR,
    };
  }
  if (
    request.purpose === 'task-diff-review' &&
    request.outputSchema.id ===
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id &&
    request.outputSchema.version ===
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest ===
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
      validator: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
    };
  }
  if (
    request.purpose === 'task-diff-review' &&
    request.outputSchema.id === TASK_DIFF_REVIEW_OUTPUT_SCHEMA.id &&
    request.outputSchema.version === TASK_DIFF_REVIEW_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest === TASK_DIFF_REVIEW_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
      validator: TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
    };
  }
  if (
    request.purpose === 'task-implementation' &&
    request.outputSchema.id === TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.id &&
    request.outputSchema.version ===
      TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest ===
      TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA,
      validator: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
    };
  }
  throw workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
    'Provider invocation does not reference a code-owned semantic contract.',
    ExitCode.verification,
  );
}

function classifyProviderFailure(error: unknown): ProviderInvocationFailure {
  const code =
    error instanceof WorkflowError
      ? error.code
      : 'PROVIDER_WORKER_UNEXPECTED_FAILURE';
  const staleContext = new Set([
    'PROVIDER_CONTEXT_STALE_OR_WRONG',
    'PROVIDER_ACCEPTANCE_BINDING_STALE',
    'PROVIDER_REPAIR_AUTHORITY_STALE',
    'PROVIDER_INVOCATION_TERMINALLY_RESOLVED',
    'EXECUTION_CONTEXT_CAS_MISMATCH',
    'EXECUTION_CONTEXT_STALE_EPOCH',
    'EXECUTION_CONTEXT_STALE_MANIFEST',
  ]).has(code);
  const probe = providerFailureProbe(error);
  const executionKind = providerExecutionFailureKind(
    code,
    staleContext,
    probe !== null,
  );
  const retryAfterMs = providerRetryAfterMs(error);
  return {
    kind: staleContext
      ? ('repository-reconciliation-required' as const)
      : ('retryable' as const),
    code,
    message: `Provider invocation failed durably (${code}).`,
    ...(executionKind === null ? {} : { executionKind }),
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
    ...(executionKind === 'probe-transient' && probe !== null ? { probe } : {}),
  };
}

function providerExecutionFailureKind(
  code: string,
  staleContext: boolean,
  hasExactProbe: boolean,
): ExecutionFailureKind | null {
  if (staleContext) return 'unknown-side-effect';
  if (code === 'ENVIRONMENT_PROBE_TRANSIENT' && !hasExactProbe) return null;
  const exact = new Map<string, ExecutionFailureKind>([
    ['PROVIDER_TIMEOUT', 'provider-timeout'],
    ['NETWORK_TRANSIENT', 'network'],
    ['PROVIDER_RATE_LIMIT', 'rate-limit'],
    ['PROVIDER_PROCESS_CRASH', 'provider-process-crash'],
    ['PROVIDER_UNAVAILABLE', 'provider-capacity'],
    ['PROVIDER_CAPACITY', 'provider-capacity'],
    ['PROVIDER_OUTPUT_LIMIT_EXCEEDED', 'stdout-truncated'],
    ['PROVIDER_PROCESS_NONZERO', 'process-nonzero'],
    ['PROVIDER_NATIVE_OUTPUT_INVALID', 'schema-mismatch'],
    ['OUTPUT_JSON_PARSE_FAILED', 'json-parse'],
    ['OUTPUT_SCHEMA_MISMATCH', 'schema-mismatch'],
    ['OUTPUT_REQUIRED_FIELD_MISSING', 'missing-required-field'],
    ['OUTPUT_CITATION_OUT_OF_RANGE', 'citation-out-of-range'],
    ['ENVIRONMENT_PROBE_TRANSIENT', 'probe-transient'],
    ['NEEDS_USER_DECISION', 'needs-user-decision'],
    ['STATE_CORRUPTION', 'state-corruption'],
    ['PROVIDER_WORKER_UNEXPECTED_FAILURE', 'worker-crash'],
  ]);
  return exact.get(code) ?? null;
}

function providerFailureProbe(
  error: unknown,
): Readonly<ReadOnlyProbeRequest> | null {
  if (!(error instanceof WorkflowError) || error.details?.probe === undefined) {
    return null;
  }
  try {
    return assertReadOnlyProbe(error.details.probe);
  } catch {
    return null;
  }
}

function providerRetryAfterMs(error: unknown): number | null {
  const value =
    error instanceof WorkflowError ? error.details?.retryAfterMs : null;
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 86_400_000
    ? (value as number)
    : null;
}

function resolveCurrentAssignment(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  changeId: string,
  request: ReturnType<typeof readProviderInvocationRequest>,
  options: ProviderWorkerOptions,
): CurrentAgentRuntimeAssignmentV1 | null {
  const environment = options.environment ?? process.env;
  const configFilePath =
    options.agentProviderConfigPath ??
    environment.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  if (configFilePath === undefined) return null;
  // Blind survey creates the Manifest; it cannot consume current Manifest
  // authority. Every post-Manifest provider purpose uses the durable path.
  if (request.purpose === 'survey') return null;
  return createCurrentAgentRuntimeAssignmentV1({
    repositoryRoot: context.git.repositoryRoot,
    runtime: context.runtime,
    grantRuntimeRoot: context.lifecycleRuntime.root,
    changeId,
    request,
    configFilePath,
    platform: options.platform ?? process.platform,
  });
}

function resolveAgentRuntime(options: ProviderWorkerOptions): AgentRuntimePort {
  if (options.agentRuntime !== undefined) {
    return options.agentRuntime;
  }
  if (options.runner !== undefined) {
    return { runSingleShot: options.runner };
  }
  return productionAgentRuntime;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function runTerminalFollowups(
  cwd: string,
  terminal: ProviderInvocationRecord,
  options: ProviderWorkerOptions,
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
        consumedRoleResultReplay: productionConsumedPlanReviewReplayPort,
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

function isRoleAssignmentGrantRequired(error: unknown): boolean {
  return (
    error instanceof WorkflowError &&
    error.code === 'AGENT_RUNTIME_GRANT_REQUIRED'
  );
}

function isTerminalInvocation(record: ProviderInvocationRecord): boolean {
  return record.state === 'succeeded' || record.state === 'failed';
}

function recordTerminalWarning(
  cwd: string,
  terminal: ProviderInvocationRecord,
  operation:
    'automatic-retry' | 'retry-schedule-pump' | 'retention-maintenance',
  error: unknown,
): void {
  try {
    recordProviderWorkerMaintenanceWarning(cwd, terminal, operation, error);
  } catch (warningError) {
    process.emitWarning(
      `Provider worker ${operation} failed after durable ${terminal.state}; its warning journal also failed (${warningError instanceof WorkflowError ? warningError.code : 'PROVIDER_WORKER_MAINTENANCE_WARNING_UNSAFE'}).`,
      {
        code: 'PROVIDER_WORKER_MAINTENANCE_WARNING_UNSAFE',
        type: 'ProviderWorkerMaintenanceWarning',
      },
    );
  }
}

function renderWorkerResult(
  record: ReturnType<typeof readProviderInvocation>,
  launched: boolean,
): ProviderWorkerResult {
  return {
    schemaVersion: 1,
    kind: 'provider-worker-result',
    invocationId: record.invocationId,
    state: record.state === 'prepared' ? 'leased' : record.state,
    revision: record.revision,
    launched,
    failure: record.failure,
  };
}
