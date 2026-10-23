import type {
  TaskDiffReviewReservationRecord,
  TaskDiffReviewContinuationReservationRecord,
} from '../../modules/assurance/task-diff-review-binding-record.ts';
import { taskDiffExternalContinuationTargetDigest } from '../../modules/assurance/task-diff-external-authority.ts';
import type { ChangeRoutingAdmissionReader } from '../../modules/lifecycle/change-routing.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import { listProviderIds } from '../../modules/provider-orchestration/provider-registry.ts';
/**
 * Applies authenticated task diff review and assurance requirements to
 * completion.
 *
 * Invariants:
 * - An accepted challenge prevents completion until the changed candidate
 *   is reviewed.
 */
// Apply review requirements and assurance gates to task completion.
import { assertTaskDiffReviewContentSatisfied } from '../../modules/assurance/task-diff-review-artifact.ts';
import type { TaskDiffReviewRecord } from '../../modules/assurance/task-diff-review-artifact-record.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import { inspectSession } from '../session-inspection/session-inspection.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type CollaborationGrantRequest,
  collaborationPolicyDigestForPhase,
} from '../../modules/authority/collaboration-grant-codec.ts';
import type { TaskDiffReviewSubject } from '../../modules/assurance/task-diff-review-record.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type {
  TaskDiffReviewRuntimeBindings,
  TaskDiffReviewRuntimeData,
} from './task-diff-review-lifecycle.ts';
import type {
  TaskDiffReviewConsumedReplayValidation,
  TaskDiffReviewCompletionGateOptions,
  ProtectedTaskApplyTaskDiffProviderGrantContinuation,
  ProtectedTaskApplyTaskDiffGrantContinuation,
} from './task-diff-review-contracts.ts';
import type { createTaskDiffReviewCommonModule } from './task-diff-review-common.ts';
import type { createTaskDiffReviewSubjectModule } from './task-diff-review-subject.ts';
import type { createTaskDiffReviewExternalBindingModule } from './task-diff-review-external-binding.ts';
import type { createTaskDiffReviewExternalContinuationBindingModule } from './task-diff-review-external-continuation-binding.ts';
import type { createTaskDiffReviewProviderBindingModule } from './task-diff-review-provider-binding.ts';
import type { createTaskDiffReviewLineageModule } from './task-diff-review-lineage.ts';
import type { createTaskDiffReviewInspectionModule } from './task-diff-review-inspection.ts';

type DocumentationReviewCapture =
  TaskDiffReviewRuntimeData['DocumentationReviewCapture'];

type CollaborationGrantSelectionCoreBinding =
  TaskDiffReviewRuntimeData['CollaborationGrantSelectionCoreBinding'];

export function createTaskDiffReviewCompletionModule(
  changeContract: ChangeContractServices,
  runtime: TaskDiffReviewRuntimeBindings,
  common: ReturnType<typeof createTaskDiffReviewCommonModule>,
  subject: ReturnType<typeof createTaskDiffReviewSubjectModule>,
  externalBinding: ReturnType<typeof createTaskDiffReviewExternalBindingModule>,
  externalContinuationBinding: ReturnType<
    typeof createTaskDiffReviewExternalContinuationBindingModule
  >,
  providerBinding: ReturnType<typeof createTaskDiffReviewProviderBindingModule>,
  lineage: ReturnType<typeof createTaskDiffReviewLineageModule>,
  inspection: ReturnType<typeof createTaskDiffReviewInspectionModule>,
) {
  const {
    loadActiveSessionContext,
    loadInvestigationRuntimeContext,
    readProviderInvocation,
    readProviderInvocationManifest,
    readProviderInvocationRequest,
    readTaskDiffReviewContinuationReservation,
    readTaskDiffReviewReservation,
    listActiveWorkflowSessionIds,
  } = runtime;
  const {
    reviewNotSatisfied,
    continuationNotStarted,
    reviewNotStarted,
    protectedTaskApplyReviewChallenge,
    protectedTaskApplyReviewAuthorizationInvalid,
    baselineAdapterPolicy,
    parseBaselineJson,
  } = common;
  const {
    inspectTaskDiffReviewSubject,
    taskDiffReviewIsActive,
    taskDiffReviewRequirementIncludingDocumentation,
    resolveTaskDiffReviewContract,
    taskDiffDocumentationRequirement,
  } = subject;
  const { externalTaskDiffGrantCore } = externalBinding;
  const {
    assertExternalTaskDiffContinuationProviderShortage,
    externalTaskDiffContinuationGrantCore,
  } = externalContinuationBinding;
  const {
    assertContinuationReservationCurrent,
    assertReservationCurrent,
    taskDiffReviewGrantRequestForProvider,
  } = providerBinding;
  const {
    resolveTaskDiffReviewCandidatePlan,
    loadReusedTaskDiffReview,
    loadCurrentTaskDiffReview,
  } = lineage;
  const { inspectTaskDiffReviewStatus } = inspection;
  function assertCurrentTaskDiffReviewSatisfied(
    cwd: string,
    requestedSessionId: string,
    validation: TaskDiffReviewConsumedReplayValidation = {},
  ): TaskDiffReviewRecord | null {
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
    if (!subject.reviewRequirement.required) return null;
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const plan = resolveTaskDiffReviewCandidatePlan(
      context,
      runtime,
      subject,
      'governing',
      validation,
    );
    if (plan.action !== 'reuse') throw reviewNotSatisfied();
    const current = loadReusedTaskDiffReview(
      runtime,
      context,
      subject,
      plan,
      'governing',
      validation,
    );
    if (current.terminal.state === 'challenge-open') {
      return assertTaskDiffReviewContentSatisfied(
        subject,
        current.review,
        null,
      );
    }
    if (current.terminal.state === 'changes-required') {
      throw workflowError(
        'TASK_DIFF_REVIEW_CHANGES_REQUIRED',
        'Authenticated TaskDiff Final Assurance accepted at least one challenge; change the candidate and obtain review for the new subject.',
        ExitCode.verification,
      );
    }
    return current.terminal.finalAssurance === null
      ? assertTaskDiffReviewContentSatisfied(subject, current.review, null)
      : current.review;
  }

  function assertTaskDiffReviewCompletionGateSatisfied(
    cwd: string,
    requestedSessionId: string,
    options: TaskDiffReviewCompletionGateOptions = {},
  ): TaskDiffReviewRecord | null {
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    if (
      !taskDiffReviewIsActive(
        context.git.repositoryRoot,
        context.session.baseline.head,
      )
    ) {
      return null;
    }
    const inspection = inspectSession(changeContract, cwd, requestedSessionId, {
      expectedSession: context.session,
      ...(options.projectedTaskIds === undefined
        ? {}
        : { projectedTaskIds: [...options.projectedTaskIds] }),
      ...(options.projectionSourceDigest === undefined
        ? {}
        : { projectionSourceDigest: options.projectionSourceDigest }),
      ...(options.authorizedTransitionPaths === undefined
        ? {}
        : {
            authorizedTransitionPaths: [...options.authorizedTransitionPaths],
          }),
    });
    const requirement = taskDiffReviewRequirementIncludingDocumentation(
      resolveTaskDiffReviewContract(inspection).requirement,
      options.candidateTree === undefined
        ? undefined
        : taskDiffDocumentationRequirement(inspection, options.candidateTree),
    );
    if (!requirement.required) return null;
    try {
      return assertCurrentTaskDiffReviewSatisfied(cwd, requestedSessionId, {
        ...(options.consumedRoleResultReplay === undefined
          ? {}
          : {
              consumedRoleResultReplay: options.consumedRoleResultReplay,
            }),
      });
    } catch (error) {
      if (
        error instanceof WorkflowError &&
        [
          'TASK_DIFF_REVIEW_NOT_READY',
          'TASK_DIFF_REVIEW_NOT_STARTED',
          'TASK_DIFF_REVIEW_NOT_SATISFIED',
        ].includes(error.code)
      ) {
        const projected = (options.projectedTaskIds?.length ?? 0) > 0;
        throw workflowError(
          'TASK_DIFF_REVIEW_REQUIRED',
          'Completion requires current engine-minted TaskDiff Final Assurance for the exact checked candidate.',
          ExitCode.verification,
          {
            details: {
              sessionId: context.session.sessionId,
              reviewRequirement: requirement,
              ...(options.transactionId === undefined
                ? {}
                : { transactionId: options.transactionId }),
              ...(options.candidateTree === undefined
                ? {}
                : { candidateTree: options.candidateTree }),
            },
            recovery: projected
              ? `Run pnpm workflow rollback-completion ${context.session.sessionId} --reason "TaskDiffReview required" --json, then run pnpm workflow finalize ${context.session.sessionId} --message "<subject>" --json.`
              : `Run pnpm workflow finalize ${context.session.sessionId} --message "<subject>" --json, complete the returned review-diff recovery, then retry the same command.`,
          },
        );
      }
      throw error;
    }
  }

  function loadTaskDiffDocumentationReviewCapture(
    cwd: string,
    requestedSessionId: string,
  ): DocumentationReviewCapture | null {
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const status = inspectTaskDiffReviewStatus(cwd, requestedSessionId);
    if (status.subject.documentationRequirement?.required !== true) return null;
    if (status.state !== 'satisfied' || !('review' in status)) {
      throw workflowError(
        'DOCUMENTATION_CLOSURE_REQUIRED',
        'The final task completion requires a satisfied documentation closure review.',
        ExitCode.verification,
      );
    }
    return Object.freeze({
      review: status.review,
      finalAssurance: status.finalAssurance,
    });
  }

  function assertTaskDiffReviewProviderOwnerCurrent(
    cwd: string,
    requestedInvocationId: string,
    validation: TaskDiffReviewConsumedReplayValidation = {},
  ):
    | TaskDiffReviewReservationRecord
    | TaskDiffReviewContinuationReservationRecord {
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const invocation = readProviderInvocation(runtime, requestedInvocationId);
    const manifest = readProviderInvocationManifest(
      runtime,
      requestedInvocationId,
    );
    const request = readProviderInvocationRequest(
      runtime,
      requestedInvocationId,
    );
    if (manifest.kind === 'task-diff-review-continuation-manifest') {
      const context = loadActiveSessionContext(cwd, manifest.sessionId);
      const current = loadCurrentTaskDiffReview(context, runtime, validation);
      const reservation = readTaskDiffReviewContinuationReservation(
        runtime,
        manifest.sessionId,
        manifest.review.recordDigest,
      );
      if (reservation === null) throw continuationNotStarted();
      assertContinuationReservationCurrent(
        context,
        current,
        manifest.response,
        reservation,
      );
      if (
        invocation.investigationId !== reservation.ownerInvestigationId ||
        canonicalJson(invocation.mandateBinding ?? null) !==
          canonicalJson(reservation.mandateBinding) ||
        canonicalJson(manifest) !== canonicalJson(reservation.manifest) ||
        canonicalJson(request) !== canonicalJson(reservation.request)
      ) {
        throw workflowError(
          'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
          'Provider invocation no longer matches its current TaskDiffReview continuation owner.',
          ExitCode.staleState,
        );
      }
      return reservation;
    }
    if (manifest.kind !== 'task-diff-review-manifest') {
      throw workflowError(
        'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
        'Provider invocation is not owned by TaskDiffReview.',
        ExitCode.guard,
      );
    }
    const context = loadActiveSessionContext(cwd, manifest.sessionId);
    const subject = inspectTaskDiffReviewSubject(cwd, manifest.sessionId);
    const reservation = readTaskDiffReviewReservation(
      runtime,
      manifest.sessionId,
      manifest.subject.subjectDigest,
    );
    if (reservation === null) throw reviewNotStarted();
    assertReservationCurrent(
      context,
      subject,
      reservation.implementationActor,
      reservation,
    );
    if (
      invocation.investigationId !== reservation.ownerInvestigationId ||
      canonicalJson(invocation.mandateBinding ?? null) !==
        canonicalJson(reservation.mandateBinding) ||
      canonicalJson(manifest) !== canonicalJson(reservation.manifest) ||
      canonicalJson(request) !== canonicalJson(reservation.request)
    ) {
      throw workflowError(
        'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
        'Provider invocation no longer matches its current TaskDiffReview owner.',
        ExitCode.staleState,
      );
    }
    return reservation;
  }

  function deriveProtectedTaskApplyTaskDiffProviderGrantContinuation(
    cwd: string,
    requestedInvocationId: string,
  ): ProtectedTaskApplyTaskDiffProviderGrantContinuation | null {
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const manifest = readProviderInvocationManifest(
      runtime,
      requestedInvocationId,
    );
    if (
      manifest.kind !== 'task-diff-review-manifest' &&
      manifest.kind !== 'task-diff-review-continuation-manifest'
    ) {
      return null;
    }
    const context = loadActiveSessionContext(cwd, manifest.sessionId);
    const parentChallengeId = protectedTaskApplyReviewChallenge(
      context,
      manifest.sessionId,
    );
    if (parentChallengeId === null) return null;
    const owner = assertTaskDiffReviewProviderOwnerCurrent(
      cwd,
      requestedInvocationId,
    );
    if (
      owner.sessionId !== manifest.sessionId ||
      owner.subject.subjectDigest !== manifest.subject.subjectDigest
    ) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    return Object.freeze({
      invocationId: requestedInvocationId,
      repositoryId: manifest.repositoryId,
      changeId: context.session.changeId,
      sessionId: manifest.sessionId,
      parentChallengeId,
      subjectDigest: manifest.subject.subjectDigest,
    });
  }

  function deriveProtectedTaskApplyTaskDiffGrantContinuation(
    cwd: string,
    request: CollaborationGrantRequest,
  ): ProtectedTaskApplyTaskDiffGrantContinuation | null {
    if (request.lifecyclePhase !== 'task-diff-review') return null;
    const lifecycle = loadInvestigationRuntimeContext(cwd);
    let matched: ProtectedTaskApplyTaskDiffGrantContinuation | null = null;
    for (const sessionId of listActiveWorkflowSessionIds(
      lifecycle.lifecycleRuntime,
    )) {
      const context = loadActiveSessionContext(cwd, sessionId);
      if (
        context.session.changeId !== request.changeId ||
        context.session.taskId !== request.taskId ||
        context.session.baseline.head !== request.baselineCommit ||
        context.session.baseline.tree !== request.baselineTree
      ) {
        continue;
      }
      const subject = inspectTaskDiffReviewSubject(cwd, sessionId);
      if (subject.subjectDigest !== request.targetDigest) continue;
      const parentChallengeId = protectedTaskApplyReviewChallenge(
        context,
        sessionId,
      );
      if (parentChallengeId === null) return null;
      assertCurrentProtectedTaskDiffCollaborationGrantRequest(
        context,
        subject,
        request,
      );
      if (matched !== null) {
        throw protectedTaskApplyReviewAuthorizationInvalid();
      }
      matched = Object.freeze({
        sessionId,
        parentChallengeId,
        subjectDigest: subject.subjectDigest,
      });
    }
    return matched;
  }

  function assertCurrentProtectedTaskDiffCollaborationGrantRequest(
    context: ReturnType<typeof loadActiveSessionContext>,
    subject: TaskDiffReviewSubject,
    request: CollaborationGrantRequest,
  ): void {
    const policy = baselineAdapterPolicy(
      context.git.repositoryRoot,
      context.session.baseline.head,
    );
    const callableProviderIds = listProviderIds().filter(
      (providerId) => policy.policy.providers[providerId].enabled,
    );
    const sameProvider = taskDiffReviewGrantRequestForProvider({
      context,
      subject,
      availableActor: request.availableActor,
      callableProviderIds,
    });
    if (
      sameProvider !== null &&
      canonicalJson(sameProvider) === canonicalJson(request)
    ) {
      return;
    }

    const maintainerPolicy = parseBaselineJson(
      context.git.repositoryRoot,
      context.session.baseline.head,
      'workflow/maintainer-policy.json',
      parseMaintainerPolicy,
    );
    if (request.targetDigest === subject.subjectDigest) {
      if (!isExternalTaskDiffGrantRequest(request)) {
        throw protectedTaskApplyReviewAuthorizationInvalid();
      }
      if (
        policy.policy.providers.codex.enabled ||
        policy.policy.providers.claude.enabled ||
        !subject.reviewRequirement.required
      ) {
        throw protectedTaskApplyReviewAuthorizationInvalid();
      }
      assertExternalTaskDiffGrantRequestCore(
        request,
        externalTaskDiffGrantCore(context, subject, maintainerPolicy),
      );
      return;
    }

    const runtime = loadInvestigationRuntimeContext(
      context.git.repositoryRoot,
    ).runtime;
    const status = inspectTaskDiffReviewStatus(
      context.git.repositoryRoot,
      context.session.sessionId,
    );
    if (!('review' in status) || !('response' in status)) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: status.review.subjectDigest,
      reviewRecordDigest: status.review.recordDigest,
      responseDigest: status.response.responseDigest,
    });
    if (request.targetDigest !== targetDigest) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    if (!isExternalTaskDiffGrantRequest(request)) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    assertExternalTaskDiffContinuationProviderShortage(
      context,
      runtime,
      context.session.sessionId,
      status.review,
    );
    assertExternalTaskDiffGrantRequestCore(
      request,
      externalTaskDiffContinuationGrantCore(
        context,
        subject,
        targetDigest,
        maintainerPolicy,
      ),
    );
  }

  function assertExternalTaskDiffGrantRequestCore(
    request: CollaborationGrantRequest,
    expected: CollaborationGrantSelectionCoreBinding,
  ): void {
    const actual: CollaborationGrantSelectionCoreBinding = {
      repositoryId: expected.repositoryId,
      repositoryOrigin: expected.repositoryOrigin,
      policyBlob: expected.policyBlob,
      collaborationPolicyDigest: collaborationPolicyDigestForPhase(
        request.lifecyclePhase,
      ),
      changeId: request.changeId,
      taskId: request.taskId,
      baselineCommit: request.baselineCommit,
      baselineTree: request.baselineTree,
      targetDigest: request.targetDigest,
      lifecyclePhase: request.lifecyclePhase,
      rolePair: request.rolePair,
    };
    if (
      canonicalJson(actual) !== canonicalJson(expected) ||
      !isExternalTaskDiffGrantRequest(request)
    ) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
  }

  function isExternalTaskDiffGrantRequest(
    request: CollaborationGrantRequest,
  ): boolean {
    return (
      (request.degradedForm === 'caller-supplied' &&
        request.availableActor.kind === 'caller') ||
      (request.degradedForm === 'direct-human-review' &&
        request.availableActor.kind === 'direct-human')
    );
  }
  return {
    assertCurrentTaskDiffReviewSatisfied,
    assertTaskDiffReviewCompletionGateSatisfied,
    loadTaskDiffDocumentationReviewCapture,
    assertTaskDiffReviewProviderOwnerCurrent,
    deriveProtectedTaskApplyTaskDiffProviderGrantContinuation,
    deriveProtectedTaskApplyTaskDiffGrantContinuation,
  };
}
