/** Execute one admitted provider claim and preserve its terminal and cleanup ordering. */
import path from 'node:path';
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import type { SessionRuntimeLayoutV1 } from '@jigwright/core/session-runtime-layout-port';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import type { GitState } from '../../modules/repository-consumer/repository-git-state.ts';
import type { PlanReviewSnapshotRuntime } from '../../modules/assurance/provider-review-manifests.ts';
import { semanticContract } from '../../modules/assurance/provider-output-contract.ts';
import { createAgentRuntimeProgressTracker } from '../../modules/provider-orchestration/agent-runtime-progress-tracker.ts';
import { taskStrategyImplementationOutputValidator } from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import type {
  AgentRuntimeAssignmentBindingV1,
  AgentRuntimeCompletionReceipt,
  AgentRuntimeGovernedInput,
  AgentRuntimeHostExecutionBindingV1,
  AgentRuntimeHostProbeEvidenceV1,
  AgentRuntimeProcessProgressProjection,
  AgentRuntimeSingleShotInput,
  AgentRuntimeSingleShotOptions,
  AgentRuntimeSingleShotReport,
  CurrentAgentRuntimeAssignmentV1,
  ProviderInvocationAcceptanceBinding,
  ProviderInvocationActivityHeartbeat,
  ProviderInvocationActivityHeartbeatInput,
  ProviderInvocationCancellationWatcher,
  ProviderRuntimeProtocolReceipt,
  ProviderWorkerRuntimePort,
} from '../../modules/provider-orchestration/agent-runtime-port.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type {
  ProviderInvocationCompletionInput,
  ProviderWorkerLeaseClaim,
} from '../../modules/provider-orchestration/provider-invocation-lifecycle.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import type { TaskStrategyImplementationLifecycle } from '../execute-task/task-strategy-implementation-lifecycle.ts';
import type {
  claimProviderWorker,
  ProviderWorkerClaimObservation,
  ProviderWorkerClaimOptions,
  ProviderWorkerClaimTaskMandate as TaskMandateDependencies,
} from './provider-worker-claim.ts';
import type { ProviderWorkerReplayDecision } from './provider-worker-replay.ts';
import type { ProviderWorkerFailureObservation } from './provider-failure-recording.ts';
import {
  isRoleAssignmentGrantRequired,
  type runProviderWorkerTerminalFollowups,
  type ProviderWorkerTerminalOptions,
} from './provider-terminal-followups.ts';

/** The original repository observation, viewed through only the facts this use case needs. */
export type ProviderWorkerRepositoryContext = {
  git: Pick<GitState, 'repositoryRoot'>;
  runtime: InvestigationRuntimePaths;
  lifecycleRuntime: SessionRuntimeLayoutV1;
};

export type ProviderWorkerFailureTarget = Readonly<{
  runtime: InvestigationRuntimePaths;
  invocationId: string;
  claim: ProviderWorkerLeaseClaim;
  usesWorkerFence: () => boolean;
}>;

type TerminalFollowups = typeof runProviderWorkerTerminalFollowups extends (
  effects: infer _Effects,
  ...args: infer Args
) => infer Result
  ? (...args: Args) => Result
  : never;

/** Durable operations and live host services; all routing stays in the use case. */
export type ProviderWorkerExecutionEffects = {
  loadInvestigationRuntimeContext(cwd: string): ProviderWorkerRepositoryContext;
  admitProviderWorkerReplay(
    taskMandate: TaskMandateDependencies,
    cwd: string,
    context: ProviderWorkerRepositoryContext,
    invocationId: string,
    options: ProviderWorkerTerminalOptions,
  ): ProviderWorkerReplayDecision;
  claimProviderWorker(
    taskMandate: TaskMandateDependencies,
    cwd: string,
    context: ProviderWorkerRepositoryContext,
    observation: ProviderWorkerClaimObservation,
    options: ProviderWorkerClaimOptions,
  ): ReturnType<typeof claimProviderWorker>;
  recordProviderWorkerFailure(
    observation: ProviderWorkerFailureObservation,
    target: ProviderWorkerFailureTarget,
  ): ProviderInvocationRecord;
  runTerminalFollowups: TerminalFollowups;
  assertTaskStrategyImplementationProviderOwnerCurrent: TaskStrategyImplementationLifecycle['assertTaskStrategyImplementationProviderOwnerCurrent'];
  readPlanReviewSnapshotRuntime(
    paths: InvestigationRuntimePaths,
    invocationId: string,
  ): PlanReviewSnapshotRuntime | null;
  readProviderInvocation(
    paths: InvestigationRuntimePaths,
    invocationId: string,
  ): ProviderInvocationRecord;
  readProviderInvocationRuntimeReceipt(
    paths: InvestigationRuntimePaths,
    invocationId: string,
  ): AgentRuntimeCompletionReceipt | null;
  prepareProviderInvocationAcceptanceBinding(
    paths: InvestigationRuntimePaths,
    invocationId: string,
    receiptRequirement: ProviderInvocationAcceptanceBinding['receiptRequirement'],
  ): ProviderInvocationAcceptanceBinding;
  assertProviderInvocationAcceptanceBindingTerminalCurrent(
    paths: InvestigationRuntimePaths,
    binding: ProviderInvocationAcceptanceBinding,
  ): void;
  completeProviderInvocationFromRunner(
    paths: InvestigationRuntimePaths,
    invocationId: string,
    input: ProviderInvocationCompletionInput,
  ): ProviderInvocationRecord;
  completeProviderInvocationFromRunnerForWorkerClaim(
    paths: InvestigationRuntimePaths,
    invocationId: string,
    input: ProviderInvocationCompletionInput &
      Readonly<{ workerFenceToken: string }>,
  ): ProviderInvocationRecord;
  completeProviderInvocationFromRunnerUnderLifecycleLock(
    paths: InvestigationRuntimePaths,
    invocationId: string,
    input: ProviderInvocationCompletionInput,
    assertOwned: () => void,
  ): ProviderInvocationRecord;
  releaseProviderInvocationWorkerFence(
    paths: InvestigationRuntimePaths,
    invocationId: string,
    ownerToken: string,
  ): void;
  releaseProviderInvocationWorkerFenceForWorkerClaim(
    paths: InvestigationRuntimePaths,
    invocationId: string,
    input: Readonly<
      Pick<ProviderWorkerLeaseClaim, 'leaseToken' | 'workerFenceToken'> &
        Pick<ProviderInvocationRecord, 'leaseGeneration'>
    >,
  ): void;
  withRepositoryLifecycleOperation(
    layout: SessionRuntimeLayoutV1,
    operation: (assertOwned: () => void) => ProviderInvocationRecord,
  ): ProviderInvocationRecord;
  resolveAssignment(
    context: ProviderWorkerRepositoryContext,
    initial: ProviderInvocationRecord,
    request: ProviderInvocationRequest,
    options: ProviderWorkerClaimOptions,
  ): CurrentAgentRuntimeAssignmentV1 | null;
  providerAcceptanceGovernedRuntimeInputs(
    paths: InvestigationRuntimePaths,
    binding: ProviderInvocationAcceptanceBinding,
  ): AgentRuntimeGovernedInput[];
  providerInvocationDurableGovernedRuntimeInputs(
    paths: InvestigationRuntimePaths,
    invocationId: string,
  ): AgentRuntimeGovernedInput[];
  productionAgentRuntime: ProviderWorkerRuntimePort;
  createProviderInvocationCancellationWatcher(
    paths: InvestigationRuntimePaths,
    invocationId: string,
    claim: ProviderWorkerLeaseClaim,
    externalSignal: AbortSignal | undefined,
  ): ProviderInvocationCancellationWatcher;
  startProviderInvocationActivityHeartbeat(
    paths: InvestigationRuntimePaths,
    input: ProviderInvocationActivityHeartbeatInput,
  ): ProviderInvocationActivityHeartbeat;
};

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
  effects: ProviderWorkerExecutionEffects,
  taskMandate: TaskMandateDependencies,
  cwd: string,
  requestedInvocationId: string,
  options: ProviderWorkerOptions = {},
): ProviderWorkerResult {
  const result = runProviderWorkerWithExecution(
    effects,
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
  effects: ProviderWorkerExecutionEffects,
  taskMandate: TaskMandateDependencies,
  cwd: string,
  requestedInvocationId: string,
  options: ProviderWorkerOptions = {},
): Promise<AsyncProviderWorkerResult> {
  const {
    loadInvestigationRuntimeContext,
    readProviderInvocationRuntimeReceipt,
  } = effects;
  const progress = createAgentRuntimeProgressTracker();
  let failureProtocolReceipt: ProviderRuntimeProtocolReceipt | null = null;
  let failureHostProbeEvidence: AgentRuntimeHostProbeEvidenceV1 | null = null;
  let failureHostExecutionBinding: AgentRuntimeHostExecutionBindingV1 | null =
    null;
  const result = await runProviderWorkerWithExecution(
    effects,
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

function runProviderWorkerWithExecution(
  effects: ProviderWorkerExecutionEffects,
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
  const {
    loadInvestigationRuntimeContext,
    admitProviderWorkerReplay,
    assertTaskStrategyImplementationProviderOwnerCurrent,
    readPlanReviewSnapshotRuntime,
    claimProviderWorker,
    createProviderInvocationCancellationWatcher,
    productionAgentRuntime,
    assertProviderInvocationAcceptanceBindingTerminalCurrent,
    completeProviderInvocationFromRunnerForWorkerClaim,
    completeProviderInvocationFromRunner,
    withRepositoryLifecycleOperation,
    completeProviderInvocationFromRunnerUnderLifecycleLock,
    recordProviderWorkerFailure,
    runTerminalFollowups,
    releaseProviderInvocationWorkerFenceForWorkerClaim,
    releaseProviderInvocationWorkerFence,
    resolveAssignment,
    prepareProviderInvocationAcceptanceBinding,
    providerAcceptanceGovernedRuntimeInputs,
    providerInvocationDurableGovernedRuntimeInputs,
    startProviderInvocationActivityHeartbeat,
    readProviderInvocation,
  } = effects;
  const context = loadInvestigationRuntimeContext(cwd);
  const outcome = admitProviderWorkerReplay(
    taskMandate,
    cwd,
    context,
    requestedInvocationId,
    options,
  );
  if (outcome.kind === 'replay') {
    return renderWorkerResult(outcome.record, false);
  }
  const { initial, request, taskDiffReviewOwner } = outcome;

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
  const agentRuntime = resolveAgentRuntime(options, productionAgentRuntime);
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
    const assignment = resolveAssignment(context, initial, request, options);
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

function resolveAgentRuntime(
  options: ProviderWorkerOptions,
  productionAgentRuntime: ProviderWorkerRuntimePort,
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
  record: ProviderInvocationRecord,
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
