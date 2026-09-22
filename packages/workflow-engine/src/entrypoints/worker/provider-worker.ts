import { taskMandateOperations } from '../../composition-root/task-mandate-production.ts';

import {
  claimProviderWorker,
  type ProviderWorkerClaimOptions,
  type ProviderWorkerClaimTaskMandate as TaskMandateDependencies,
} from '../../composition-root/provider-worker-claim-production.ts';
/**
 * Runs provider invocations and publishes their admitted results and
 * terminal follow-ups.
 *
 * Invariants:
 * - An AgentRuntime turn may emit at most one terminal failure receipt.
 */
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { startProviderInvocationActivityHeartbeat } from '../../runtime/storage-journal/provider-invocation-activity.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  type AgentRuntimeAssignmentBindingV1,
  type AgentRuntimeCompletionReceipt,
  type AgentRuntimeHostExecutionBindingV1,
  type AgentRuntimeHostProbeEvidenceV1,
  type ProviderWorkerRuntimePort,
  type AgentRuntimeProcessProgressProjection,
  type AgentRuntimeSingleShotInput,
  type AgentRuntimeSingleShotOptions,
  type AgentRuntimeSingleShotReport,
  type ProviderInvocationAcceptanceBinding,
  type ProviderRuntimeProtocolReceipt,
  createAgentRuntimeProgressTracker,
  productionAgentRuntime,
  providerAcceptanceGovernedRuntimeInputs,
  providerInvocationDurableGovernedRuntimeInputs,
} from '../../composition-root/agent-runtime-production.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';

import { resolveCurrentProviderWorkerAssignment } from '../../composition-root/provider-worker-assignment-production.ts';
import { productionConsumedRoleResultReplayPort } from '../../composition-root/grant-verifier-composition.ts';
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
} from '../../composition-root/task-diff-review-production.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
  TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA,
  taskStrategyImplementationOutputValidator,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import { assertTaskStrategyImplementationProviderOwnerCurrent } from '../../composition-root/task-strategy-production.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyOutputValidator,
  assertProviderInvocationAcceptanceBindingTerminalCurrent,
  claimProviderInvocationForWorker,
  completeProviderInvocationFromRunner,
  completeProviderInvocationFromRunnerForWorkerClaim,
  completeProviderInvocationFromRunnerUnderLifecycleLock,
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
} from '../../runtime/storage-journal/provider-invocation-store.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import {
  runProviderWorkerTerminalFollowups as runTerminalFollowups,
  isRoleAssignmentGrantRequired,
  type ProviderWorkerTerminalOptions,
} from '../../composition-root/provider-worker-terminal-production.ts';
import { recordProviderWorkerFailure } from '../../composition-root/provider-worker-failure-production.ts';
import { withRepositoryLifecycleOperation } from '../../runtime/session-workspace/session-store.ts';

const PROVIDER_CANCELLATION_POLL_INTERVAL_MS = 25;

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

export type ProviderWorkerOptions = ProviderWorkerClaimOptions &
  ProviderWorkerTerminalOptions & {
    signal?: AbortSignal;
  };

/**
 * Claim and execute one exact durable provider invocation. Replays never
 * manufacture replacement work: an already leased or terminal record is
 * rendered from its durable state, while only `prepared` may acquire a lease.
 */
export function runProviderWorkerWithMandate(
  taskMandate: TaskMandateDependencies,
  cwd: string,
  requestedInvocationId: string,
  options: ProviderWorkerOptions = {},
): ProviderWorkerResult {
  const result = runProviderWorkerWithExecution(
    taskMandate,
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
export async function runProviderWorkerAsyncWithMandate(
  taskMandate: TaskMandateDependencies,
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
    taskMandate,
    cwd,
    requestedInvocationId,
    options,
    (agentRuntime, input, runtimeOptions) => {
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
  agentRuntime: ProviderWorkerRuntimePort,
  input: AgentRuntimeSingleShotInput,
  options: AgentRuntimeSingleShotOptions,
) => AgentRuntimeSingleShotReport | Promise<AgentRuntimeSingleShotReport>;

function withCurrentTaskDiffReviewProviderLifecycle<T>(
  taskMandate: TaskMandateDependencies,
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

function runProviderWorkerWithExecution(
  taskMandate: TaskMandateDependencies,
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
            taskMandate,
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
  const { claim, claimInput } = claimProviderWorker(
    taskMandate,
    cwd,
    context,
    { initial, request, taskDiffReviewOwner, taskStrategyImplementationOwner },
    options,
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
  ): ProviderInvocationRecord =>
    recordProviderWorkerFailure(
      {
        error,
        targetSchema: semantic.schema,
        acceptanceBinding,
        preparedHostAssignmentBinding,
        runtimeProgress,
        runtimeFailureProtocolReceipt,
        runtimeFailureHostProbeEvidence,
        runtimeFailureHostExecutionBinding,
      },
      {
        runtime: context.runtime,
        invocationId: request.invocationId,
        claim,
        usesWorkerFence: () =>
          taskDiffReviewOwner !== null ||
          cancellationWatcher?.hasExactCancellation() === true,
      },
    );
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
    const assignment = resolveCurrentProviderWorkerAssignment(
      {
        repositoryRoot: context.git.repositoryRoot,
        runtime: context.runtime,
        grantRuntimeRoot: context.lifecycleRuntime.root,
        changeId: initial.changeId,
        request,
      },
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
      // The durable record only learns what happened once the run ends. While
      // it runs, this publication is the only way to tell a live provider from
      // a dead worker.
      const activity =
        runtimeProgress === undefined
          ? null
          : startProviderInvocationActivityHeartbeat(context.runtime, {
              invocationId: request.invocationId,
              leaseGeneration: claim.record.leaseGeneration,
              workerId: claimInput.workerId,
              progress: runtimeProgress,
            });
      return Promise.resolve(report)
        .then((completedReport) =>
          completeWithReport(completedReport, acceptanceBinding),
        )
        .catch((error) => failWithError(error, acceptanceBinding))
        .finally(() => activity?.stop())
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

function resolveAgentRuntime(
  options: ProviderWorkerOptions,
): ProviderWorkerRuntimePort {
  if (options.agentRuntime !== undefined) {
    return options.agentRuntime;
  }
  if (options.runner !== undefined) {
    const runner = options.runner;
    // The deprecated test seam stays explicitly synchronous-only. Every
    // injected ProviderWorkerRuntimePort, by contrast, now has the complete async API.
    return {
      runSingleShot: runner,
      async runSingleShotAsync() {
        throw workflowError(
          'AGENT_RUNTIME_ASYNC_UNAVAILABLE',
          'The selected Agent Runtime does not implement asynchronous execution.',
          ExitCode.verification,
        );
      },
    };
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

function isTerminalInvocation(record: ProviderInvocationRecord): boolean {
  return record.state === 'succeeded' || record.state === 'failed';
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

export const runProviderWorker = runProviderWorkerWithMandate.bind(
  undefined,
  taskMandateOperations,
);
export const runProviderWorkerAsync = runProviderWorkerAsyncWithMandate.bind(
  undefined,
  taskMandateOperations,
);
