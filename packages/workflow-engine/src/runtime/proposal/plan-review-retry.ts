import type { createPlanReviewPreparation } from './plan-review-preparation.ts';
import type { createPlanReviewStore } from './plan-review-store.ts';
import type { createProposeContext } from './propose-context.ts';
import type { createProposeProviderLifecycle } from './propose-provider-lifecycle.ts';
import type { createProposeStatus } from './propose-status.ts';
import type {
  ProposeOutput,
  PlanReviewRetryEnvelope,
  ProposeResumeOptions,
  PlanReviewReservation,
  ProposeLifecycleStatus,
} from '../../modules/proposal/propose-types.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  getProposeLifecycleStatus,
  assertCurrentExemptionContext,
} from './propose-context.ts';
import { readPlanReviewReservation } from './plan-review-store.ts';
import {
  sha256,
  PLAN_REVIEW_REQUEST_REF,
} from '../../modules/proposal/propose-values.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { readProviderInvocation } from '../storage-journal/provider-invocation-state.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  durablePlanReviewMandateBinding,
  ensurePlanReviewInvocation,
  readPriorPlanReviewSnapshotFiles,
} from './plan-review-preparation.ts';
import type { ProposeDecisionServices } from './propose-decision-services.ts';
import {
  providerInvocationExists,
  readProviderInvocationRequest,
} from '../storage-journal/provider-invocation-artifacts.ts';
import { createPlanReviewReplacementRequest } from '../../modules/proposal/plan-review-contracts.ts';
import { defaultProviderRetryExplanation } from '../../modules/provider-orchestration/provider-retry-explanation.ts';
import { createPlanReviewReplacementReservationNode } from '../../modules/proposal/propose-evidence.ts';

import {
  loadAiAdapterPolicy,
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
} from '../provider-policy/ai-adapter-policy.ts';
import { blockInvestigationForPlanReviewRetryUnderAuthority } from '../investigation-lifecycle/investigation-session.ts';
import { createProviderExecutionPolicySnapshot } from '../storage-journal/provider-invocation-policy.ts';
import {
  writeEvidenceNode,
  readEvidenceNode,
} from '../storage-journal/evidence-node-store.ts';
import { compareAndSwapEvidenceRef } from '../storage-journal/evidence-ref-store.ts';
import {
  type ProviderExecutionGrantAuthorization,
  authorizeAutomaticProviderRetry,
  assertProviderExecutionGrantAuthorization,
} from '../../modules/provider-orchestration/provider-retry-decision.ts';
import {
  providerExecutionPolicySnapshot,
  createReplacementAttempt,
  providerExecutionEnvironmentDigest,
} from '../../modules/provider-orchestration/execution-core.ts';
import {
  preflightProviderRepairRetry,
  loadProviderExecutionRepairContext,
} from '../storage-journal/provider-repair-governance.ts';
import type { ProviderRetryDecisionBinding } from '../../modules/provider-orchestration/provider-invocation-reservations.ts';

export function createPlanReviewRetryEnvelope(
  cwd: string,
  output: ProposeOutput,
  acknowledgement: { acknowledgeProviderCost: true },
): PlanReviewRetryEnvelope {
  if (
    output.nextAction !== 'retry-plan-review' ||
    output.investigation === null ||
    output.planReview === null ||
    output.planReview.state !== 'failed' ||
    output.planReview.failure?.kind !== 'retryable' ||
    acknowledgement.acknowledgeProviderCost !== true
  ) {
    throw workflowError(
      'PLAN_REVIEW_RETRY_NOT_AVAILABLE',
      'The propose wrapper has no retryable failed PlanReview invocation.',
      ExitCode.guard,
    );
  }
  const status = getProposeLifecycleStatus(
    cwd,
    output.investigation.investigationId,
  );
  const context = loadInvestigationRuntimeContext(cwd);
  const reservation = readPlanReviewReservation(context.runtime, status);
  if (
    reservation === null ||
    reservation.subject.subjectDigest !== output.planReview.subjectDigest ||
    reservation.request.invocationId !== output.planReview.invocationId ||
    reservation.request.requestDigest !== output.planReview.requestDigest
  ) {
    throw planReviewRetryInputStale();
  }
  const failed = readProviderInvocation(
    context.runtime,
    reservation.request.invocationId,
  );
  if (
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable'
  ) {
    throw planReviewRetryInputStale();
  }
  return {
    schemaVersion: 1,
    kind: 'plan-review-retry',
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: { ...status.baseline },
    subjectDigest: reservation.subject.subjectDigest,
    planningGenerationId: reservation.subject.planningGenerationId,
    expectedReservationNodeId: reservation.reservationNode.nodeId,
    failedInvocation: {
      invocationId: failed.invocationId,
      attempt: failed.attempt,
      revision: failed.revision,
      requestDigest: failed.requestDigest,
      failureDigest: sha256(canonicalJson(failed.failure)),
    },
    acknowledgeProviderCost: true,
  };
}
export function createPlanReviewRetry({
  planReviewRetryBlocker,
  readProviderRetryAccountingEvidence,
  taskMandate,
  authorizePlanReviewReservationMandate,
  dispatchPreparedPlanReview,
  getProposeStatus,
  readTrackedPlanReview,
  withProposeTransitionAuthority,
}: {
  planReviewRetryBlocker: ProposeDecisionServices['createInvestigationHumanActionBlocker'];
  readProviderRetryAccountingEvidence: ProposeDecisionServices['readProviderRetryAccountingEvidence'];
  taskMandate: ProposeDecisionServices['taskMandate'];
  authorizePlanReviewReservationMandate: ReturnType<
    typeof createPlanReviewPreparation
  >['authorizePlanReviewReservationMandate'];
  dispatchPreparedPlanReview: ReturnType<
    typeof createProposeProviderLifecycle
  >['dispatchPreparedPlanReview'];
  getProposeStatus: ReturnType<typeof createProposeStatus>['getProposeStatus'];
  readTrackedPlanReview: ReturnType<
    typeof createPlanReviewStore
  >['readTrackedPlanReview'];
  withProposeTransitionAuthority: ReturnType<
    typeof createProposeContext
  >['withProposeTransitionAuthority'];
}) {
  /**
   * Traverse the PlanReview replacement crash window on behalf of the WAL: the
   * replacement reservation was published (the evidence ref moved) but the
   * process died before the invocation record existed, so the full status
   * projection refuses to render and the ordinary retry surface cannot rebuild
   * an envelope. The replacement transaction holds the exact request this
   * reservation must match; when it does, the interrupted tail — mandate
   * authorization under the already-consumed grant, then invocation creation
   * from the failed attempt's immutable snapshot — runs to completion.
   * Anything that does not match this exact window is left untouched.
   */
  function completeInterruptedPlanReviewReplacement(
    cwd: string,
    input: {
      investigationId: string;
      changeId: string;
      replacementRequest: ProviderInvocationRequest;
      failedInvocationId: string;
      executionGrantId: string;
    },
  ): { published: boolean } {
    const initialContext = loadInvestigationRuntimeContext(cwd);
    return withProposeTransitionAuthority(
      cwd,
      initialContext.lifecycleRuntime,
      input.changeId,
      (assertOwned) => {
        assertOwned();
        const status = getProposeLifecycleStatus(cwd, input.investigationId);
        const context = loadInvestigationRuntimeContext(cwd);
        const reservation = readPlanReviewReservation(context.runtime, status);
        if (
          reservation === null ||
          reservation.retry === null ||
          canonicalJson(reservation.request) !==
            canonicalJson(input.replacementRequest)
        ) {
          return { published: false };
        }
        if (
          providerInvocationExists(
            context.runtime,
            reservation.request.invocationId,
          )
        ) {
          return { published: true };
        }
        const mandateBinding = durablePlanReviewMandateBinding(context, status);
        if (mandateBinding) {
          taskMandate.assertActiveTaskMandateBindingUnderLifecycleLock(
            cwd,
            mandateBinding,
            assertOwned,
          );
        }
        authorizePlanReviewReservationMandate(
          cwd,
          mandateBinding,
          reservation,
          assertOwned,
          { grantId: input.executionGrantId },
        );
        ensurePlanReviewInvocation(
          context.git.repositoryRoot,
          context.runtime,
          status,
          reservation,
          mandateBinding,
          readPriorPlanReviewSnapshotFiles(
            context.runtime,
            reservation.manifest,
            input.failedInvocationId,
          ),
        );
        assertOwned();
        return { published: true };
      },
    );
  }

  function resumePlanReviewRetry(
    cwd: string,
    input: PlanReviewRetryEnvelope,
    options: ProposeResumeOptions,
  ): ProposeOutput {
    const initialContext = loadInvestigationRuntimeContext(cwd);
    const retried = withProposeTransitionAuthority(
      cwd,
      initialContext.lifecycleRuntime,
      input.changeId,
      (assertOwned) => {
        assertOwned();
        const status = getProposeLifecycleStatus(cwd, input.investigationId);
        assertPlanReviewRetryStatusBinding(status, input);
        const context = loadInvestigationRuntimeContext(cwd);
        if (status.state === 'investigation-exempt') {
          assertCurrentExemptionContext(context, status);
        }
        const mandateBinding = durablePlanReviewMandateBinding(context, status);
        if (mandateBinding) {
          taskMandate.assertActiveTaskMandateBindingUnderLifecycleLock(
            cwd,
            mandateBinding,
            assertOwned,
          );
        }
        if (
          readTrackedPlanReview(context.git.repositoryRoot, status.changeId) !==
          null
        ) {
          throw planReviewRetryInputStale();
        }
        let reservation: PlanReviewReservation | null;
        try {
          reservation = readPlanReviewReservation(context.runtime, status);
        } catch (error) {
          if (
            error instanceof WorkflowError &&
            error.code === 'PLAN_REVIEW_REQUEST_STALE'
          ) {
            throw planReviewRetryInputStale();
          }
          throw error;
        }
        if (reservation === null) {
          throw planReviewRetryInputStale();
        }
        if (
          reservation.reservationNode.nodeId !== input.expectedReservationNodeId
        ) {
          assertExactPlanReviewRetryReplay(context.runtime, reservation, input);
          authorizePlanReviewReservationMandate(
            cwd,
            mandateBinding,
            reservation,
            assertOwned,
            options.executionGrantAuthorization === undefined
              ? undefined
              : { grantId: options.executionGrantAuthorization.grantId },
          );
          ensurePlanReviewInvocation(
            context.git.repositoryRoot,
            context.runtime,
            status,
            reservation,
            mandateBinding,
          );
          return reservation;
        }
        assertPlanReviewRetryFailureBinding(
          context.runtime,
          reservation,
          input,
        );
        const failed = readProviderInvocation(
          context.runtime,
          input.failedInvocation.invocationId,
        );
        const failedRequest = readProviderInvocationRequest(
          context.runtime,
          failed.invocationId,
        );
        const currentExecutionPolicy = loadAiAdapterPolicy(
          context.git.repositoryRoot,
        );
        const replacementRequest =
          options.executionGrantAuthorization?.replacementRequest ??
          createPlanReviewReplacementRequest(input, failedRequest, {
            policyDigest: currentExecutionPolicy.digest,
            retryExplanation:
              input.retryExplanation ??
              defaultProviderRetryExplanation(failed.failure),
            limits: {
              timeoutMs:
                input.timeoutMs ??
                currentExecutionPolicy.policy.limits.timeoutMs,
              aggregateOutputBytes:
                currentExecutionPolicy.policy.limits.aggregateOutputBytes,
            },
          });
        let retryAuthorization: ReturnType<
          typeof assertPlanReviewRetryExecutionDecision
        >;
        try {
          retryAuthorization = assertPlanReviewRetryExecutionDecision(
            context.runtime,
            failed,
            failedRequest,
            replacementRequest,
            currentExecutionPolicy,
            options.executionGrantAuthorization,
          );
        } catch (error) {
          // A denied or strategy-changing decision has no plan-review executor,
          // so refusing here would end the change with no move left. Park it on
          // human action instead: the failure is stated and a person decides.
          if (!isUnexecutablePlanReviewRetry(error)) throw error;
          return {
            blockedInvestigation:
              blockInvestigationForPlanReviewRetryUnderAuthority(
                planReviewRetryBlocker,
                cwd,
                input.changeId,
                input.investigationId,
                {
                  expectedRevision: status.revision,
                  failedInvocationId: failed.invocationId,
                  attempt: failed.attempt,
                  retryReasonCode: String(
                    (error as WorkflowError).details?.reasonCode ?? 'unknown',
                  ),
                  failureCode: failed.failure?.code ?? 'unknown',
                },
                assertOwned,
              ),
          };
        }
        const replacementSnapshotFiles = readPriorPlanReviewSnapshotFiles(
          context.runtime,
          reservation.manifest,
          failed.invocationId,
        );
        const replacementExecutionPolicySnapshot =
          createProviderExecutionPolicySnapshot(
            replacementRequest,
            currentExecutionPolicy,
            options.executionGrantAuthorization,
          );
        const replacementNode = createPlanReviewReplacementReservationNode(
          reservation,
          reservation.reservationNode,
          input,
          replacementRequest,
          failed.attempt + 1,
          providerRetryDecisionBinding(retryAuthorization),
          replacementExecutionPolicySnapshot,
        );
        writeEvidenceNode(context.runtime, replacementNode);
        compareAndSwapEvidenceRef(context.runtime, {
          changeId: status.changeId,
          refName: PLAN_REVIEW_REQUEST_REF,
          expectedNodeId: reservation.reservationNode.nodeId,
          nextNodeId: replacementNode.nodeId,
        });
        const replacement = readPlanReviewReservation(
          context.runtime,
          status,
          reservation.subject,
        );
        if (replacement === null) {
          throw planReviewRetryInputStale();
        }
        options.simulateCrashAfterPlanReviewReplacementReservation?.();
        authorizePlanReviewReservationMandate(
          cwd,
          mandateBinding,
          replacement,
          assertOwned,
          options.executionGrantAuthorization === undefined
            ? undefined
            : { grantId: options.executionGrantAuthorization.grantId },
        );
        ensurePlanReviewInvocation(
          context.git.repositoryRoot,
          context.runtime,
          status,
          replacement,
          mandateBinding,
          replacementSnapshotFiles,
        );
        assertOwned();
        return replacement;
      },
    );
    if ('blockedInvestigation' in retried) {
      return getProposeStatus(
        cwd,
        input.investigationId,
        options.collaborationGrantValidation,
      );
    }
    const output = getProposeStatus(
      cwd,
      input.investigationId,
      options.collaborationGrantValidation,
    );
    if (output.planReview?.invocationId !== retried.request.invocationId) {
      throw planReviewRetryInputStale();
    }
    dispatchPreparedPlanReview(cwd, output, options);
    return getProposeStatus(
      cwd,
      input.investigationId,
      options.collaborationGrantValidation,
    );
  }

  function assertPlanReviewRetryExecutionDecision(
    paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    failed: ReturnType<typeof readProviderInvocation>,
    failedRequest: ProviderInvocationRequest,
    replacementRequest: ProviderInvocationRequest,
    replacementExecutionPolicy: ReturnType<typeof loadAiAdapterPolicy>,
    executionGrantAuthorization?: ProviderExecutionGrantAuthorization,
  ): ReturnType<typeof authorizeAutomaticProviderRetry> {
    const authorization = authorizeAutomaticProviderRetry(
      readProviderRetryAccountingEvidence(paths, failed, failedRequest),
      {
        failed,
        failedRequest,
        replacementRequest,
        replacementExecutionPolicy,
        dataAuthorizationPolicyPort: AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
        boundedGrantRequest: executionGrantAuthorization?.grantRequest,
        executionGrantAuthorization,
        now: new Date().toISOString(),
      },
    );
    const prior = authorization;
    const replacementPolicy =
      providerExecutionPolicySnapshot(replacementRequest);
    const now = authorization.evaluatedAt;
    const decision = authorization.decision;
    const replacementAttemptId = `attempt-provider-${replacementRequest.invocationId}`;
    if (executionGrantAuthorization !== undefined) {
      assertProviderExecutionGrantAuthorization(
        authorization,
        executionGrantAuthorization,
        replacementAttemptId,
      );
    } else if (!decision.retryable || !decision.automatic) {
      throw workflowError(
        decision.requiredGrant === undefined
          ? 'PLAN_REVIEW_RETRY_DECISION_DENIED'
          : 'PLAN_REVIEW_RETRY_GRANT_REQUIRED',
        'The execution RetryDecision does not authorize this PlanReview replacement Attempt.',
        ExitCode.guard,
        {
          details: {
            reasonCode: decision.reasonCode,
            attemptCount: prior.job.attemptCount,
            providerAttemptCount: authorization.providerAttemptCount,
            nextRuntimeMs: authorization.nextReservation.runtimeMs,
            nextProviderCostMicros:
              authorization.nextReservation.providerCostMicros,
            nextProviderTokens: authorization.nextReservation.providerTokens,
            retryPolicy: prior.job.retryPolicy,
            evaluatedAt: now,
          },
        },
      );
    }
    if (
      executionGrantAuthorization === undefined &&
      (decision.retryMode === 'new-context' ||
        decision.retryMode === 'none' ||
        decision.retryMode === 'strategy-change')
    ) {
      throw workflowError(
        'PLAN_REVIEW_RETRY_STRATEGY_CHANGE_REQUIRED',
        'PlanReview retry requires a separately declared strategy change.',
        ExitCode.guard,
        { details: { reasonCode: decision.reasonCode } },
      );
    }
    const policyChanged =
      canonicalJson(prior.attempt.policySnapshot) !==
      canonicalJson(replacementPolicy);
    const retryMode: 'same-input' | 'execution-policy-change' | 'repair' =
      executionGrantAuthorization === undefined
        ? (decision.retryMode as
            'same-input' | 'execution-policy-change' | 'repair')
        : prior.attempt.failure?.retryClass === 'repairable'
          ? 'repair'
          : policyChanged
            ? 'execution-policy-change'
            : 'same-input';
    if (retryMode === 'repair') {
      preflightProviderRepairRetry(paths, {
        history: authorization.sourceInvocationIds.map((invocationId) => ({
          record: readProviderInvocation(paths, invocationId),
          request: readProviderInvocationRequest(paths, invocationId),
        })),
        failedRecord: failed,
        failedRequest,
      });
    }
    const replacement = createReplacementAttempt({
      workflow: prior.workflow,
      job: prior.job,
      previousAttempt: prior.attempt,
      attemptId: replacementAttemptId,
      retryMode,
      currentExecutionPolicy: replacementPolicy,
      repairContext:
        retryMode === 'repair'
          ? loadProviderExecutionRepairContext(paths, failed, failedRequest)
          : undefined,
      grantId: executionGrantAuthorization?.grantId,
      environmentDigest: providerExecutionEnvironmentDigest(replacementRequest),
      createdAt: now,
    });
    if (
      replacement.job.jobId !== prior.job.jobId ||
      replacement.job.contextDigest !== prior.job.contextDigest ||
      replacement.attempt.attemptNumber !== failed.attempt + 1
    ) {
      throw workflowError(
        'PLAN_REVIEW_RETRY_EXECUTION_LINEAGE_INVALID',
        'PlanReview replacement changed stable semantic Job identity.',
        ExitCode.staleState,
      );
    }
    return authorization;
  }
  return { completeInterruptedPlanReviewReplacement, resumePlanReviewRetry };
}

/** A retry decision a plan review has no executor for. */
function isUnexecutablePlanReviewRetry(error: unknown): boolean {
  return (
    error instanceof WorkflowError &&
    (error.code === 'PLAN_REVIEW_RETRY_STRATEGY_CHANGE_REQUIRED' ||
      error.code === 'PLAN_REVIEW_RETRY_DECISION_DENIED')
  );
}

function assertPlanReviewRetryStatusBinding(
  status: ProposeLifecycleStatus,
  input: PlanReviewRetryEnvelope,
): void {
  if (
    status.investigationId !== input.investigationId ||
    status.changeId !== input.changeId ||
    status.revision !== input.expectedRevision ||
    canonicalJson(status.baseline) !== canonicalJson(input.baseline)
  ) {
    throw planReviewRetryInputStale();
  }
}

function assertPlanReviewRetryFailureBinding(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: PlanReviewReservation,
  input: PlanReviewRetryEnvelope,
): void {
  const failed = readProviderInvocation(
    paths,
    input.failedInvocation.invocationId,
  );
  const request = readProviderInvocationRequest(paths, failed.invocationId);
  if (
    reservation.subject.subjectDigest !== input.subjectDigest ||
    reservation.subject.planningGenerationId !== input.planningGenerationId ||
    reservation.request.invocationId !== failed.invocationId ||
    reservation.request.requestDigest !== request.requestDigest ||
    failed.investigationId !== input.investigationId ||
    failed.changeId !== input.changeId ||
    failed.attempt !== (reservation.retry?.attempt ?? 1) ||
    failed.attempt !== input.failedInvocation.attempt ||
    failed.revision !== input.failedInvocation.revision ||
    failed.requestDigest !== input.failedInvocation.requestDigest ||
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable' ||
    sha256(canonicalJson(failed.failure)) !==
      input.failedInvocation.failureDigest
  ) {
    throw planReviewRetryInputStale();
  }
}

function providerRetryDecisionBinding(
  authorization: ReturnType<typeof authorizeAutomaticProviderRetry>,
): ProviderRetryDecisionBinding {
  return {
    schemaVersion: 1,
    kind: 'provider-retry-decision-binding',
    executionJobId: authorization.job.jobId,
    executionRevision: authorization.executionRevision,
    failedAttemptId: authorization.attempt.attemptId,
    evidenceDigest: authorization.evidenceDigest,
    evaluatedAt: authorization.evaluatedAt,
  };
}

function assertExactPlanReviewRetryReplay(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: PlanReviewReservation,
  input: PlanReviewRetryEnvelope,
): void {
  if (reservation.retry === null) {
    throw workflowError(
      'PLAN_REVIEW_RETRY_DECISION_EVIDENCE_REQUIRED',
      'A malformed current PlanReview retry reservation cannot authorize provider work.',
      ExitCode.guard,
    );
  }
  const failed = readProviderInvocation(
    paths,
    input.failedInvocation.invocationId,
  );
  const failedRequest = readProviderInvocationRequest(
    paths,
    input.failedInvocation.invocationId,
  );
  const previousReservationNode = readEvidenceNode(
    paths,
    input.expectedReservationNodeId,
  );
  const expectedRequest = createPlanReviewReplacementRequest(
    input,
    failedRequest,
    {
      policyDigest: reservation.request.policyDigest,
      limits: reservation.request.limits,
      retryExplanation: reservation.request.retryExplanation,
    },
  );
  const expectedReservationNode = createPlanReviewReplacementReservationNode(
    reservation,
    previousReservationNode,
    input,
    expectedRequest,
    input.failedInvocation.attempt + 1,
    reservation.retry.retryDecision,
    reservation.retry.executionPolicySnapshot,
  );
  if (
    (input.timeoutMs !== undefined &&
      reservation.request.limits.timeoutMs !== input.timeoutMs) ||
    reservation.subject.subjectDigest !== input.subjectDigest ||
    reservation.subject.planningGenerationId !== input.planningGenerationId ||
    reservation.retry.previousReservationNodeId !==
      input.expectedReservationNodeId ||
    canonicalJson(reservation.retry.failedInvocation) !==
      canonicalJson(input.failedInvocation) ||
    failed.investigationId !== input.investigationId ||
    failed.changeId !== input.changeId ||
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable' ||
    failed.attempt !== input.failedInvocation.attempt ||
    failed.revision !== input.failedInvocation.revision ||
    failed.requestDigest !== input.failedInvocation.requestDigest ||
    failedRequest.requestDigest !== input.failedInvocation.requestDigest ||
    sha256(canonicalJson(failed.failure)) !==
      input.failedInvocation.failureDigest ||
    canonicalJson(reservation.request) !== canonicalJson(expectedRequest) ||
    canonicalJson(reservation.reservationNode) !==
      canonicalJson(expectedReservationNode)
  ) {
    throw planReviewRetryInputStale();
  }
}

function planReviewRetryInputStale() {
  return workflowError(
    'PLAN_REVIEW_RETRY_INPUT_STALE',
    'PlanReview retry input is not bound to the exact failed review attempt.',
    ExitCode.staleState,
  );
}
