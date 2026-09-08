// Validate provider reservations, results, and the final assurance they authorize.
import {
  type TaskDiffReviewSubject,
  TASK_DIFF_REVIEW_POLICY_DIGEST,
} from '../../modules/assurance/task-diff-review.ts';
import {
  type RecordedRoleParticipant,
  admitConsumedRoleResultReplay,
  admitRoleResult,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import {
  type CollaborationGrantRequest,
  type CollaborationGrantExpectedBinding,
  collaborationPolicyDigestForPhase,
  parseCollaborationGrantEnvelope,
  canonicalCollaborationGrantEnvelope,
  bindingFromPayload,
} from '../../modules/authority/collaboration-grant.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type TaskDiffReviewRecord,
  type TaskDiffReviewChallengeResponseRecord,
  assertTaskDiffReviewChallengeResponseCurrent,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  type TaskDiffReviewContinuationSubmission,
  assertTaskDiffReviewContinuationSubmissionCurrent,
  type TaskDiffFinalAssuranceRecord,
  createTaskDiffFinalAssuranceRecord,
  assertTaskDiffFinalAssuranceCurrent,
  type TaskDiffAuthenticatedReviewerAuthority,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import type {
  TaskDiffReviewRuntimeBindings,
  TaskDiffReviewRuntimeData,
} from './task-diff-review-lifecycle.ts';
import type {
  CurrentTaskDiffReviewForProviderContinuation,
  TaskDiffReviewReplayMode,
  ReconcileTaskDiffReviewOptions,
  CurrentAuthenticatedTaskDiffReview,
} from './task-diff-review-contracts.ts';
import type { createTaskDiffReviewCommonModule } from './task-diff-review-common.ts';
import type { createTaskDiffReviewSubjectModule } from './task-diff-review-subject.ts';

type TaskDiffReviewReservationRecord =
  TaskDiffReviewRuntimeData['TaskDiffReviewReservationRecord'];

type TaskDiffReviewContinuationReservationRecord =
  TaskDiffReviewRuntimeData['TaskDiffReviewContinuationReservationRecord'];

type VerifiedConsumedCollaborationGrantReplay =
  TaskDiffReviewRuntimeData['VerifiedConsumedCollaborationGrantReplay'];

type TaskDiffReviewContinuationResultBinding =
  TaskDiffReviewRuntimeData['TaskDiffReviewContinuationResultBinding'];

export function createTaskDiffReviewProviderBindingModule(
  runtime: TaskDiffReviewRuntimeBindings,
  common: ReturnType<typeof createTaskDiffReviewCommonModule>,
  subject: ReturnType<typeof createTaskDiffReviewSubjectModule>,
) {
  const {
    loadActiveSessionContext,
    runGit,
    loadInvestigationRuntimeContext,
    readTaskDiffReviewResultBinding,
    readProviderInvocation,
    readEvidenceNode,
    readCollaborationGrantInspection,
    readExactConsumedCollaborationGrantUse,
    readTaskDiffReviewContinuationResultBinding,
    createEvidenceNode,
    writeEvidenceNode,
    createTaskDiffFinalAssuranceBinding,
    readTaskDiffFinalAssuranceBinding,
  } = runtime;
  const {
    parseBaselineJson,
    baselineAdapterPolicy,
    sha256,
    reviewNotSatisfied,
    collaborationTransitionDigest,
    resolveConsumedRoleResultReplayPort,
    assertStoredAdmittedRoleResultDigest,
  } = common;
  const { assertTaskDiffReviewCandidateCurrent } = subject;
  function taskDiffReviewGrantRequest(input: {
    context: ReturnType<typeof loadActiveSessionContext>;
    subject: TaskDiffReviewSubject;
    implementationActor: RecordedRoleParticipant;
    callableProviderIds: readonly ProviderId[];
  }): CollaborationGrantRequest | null {
    const providerId = input.implementationActor.providerId;
    if (
      providerId === null ||
      (input.implementationActor.identityAssurance !== 'self-declared' &&
        input.implementationActor.identityAssurance !== 'runtime-hint') ||
      input.callableProviderIds.length !== 1 ||
      input.callableProviderIds[0] !== providerId
    ) {
      return null;
    }
    return taskDiffReviewGrantRequestForProvider({
      context: input.context,
      subject: input.subject,
      availableActor: {
        kind: 'provider',
        providerId,
        assurance: input.implementationActor.identityAssurance,
      },
      callableProviderIds: input.callableProviderIds,
    });
  }

  function taskDiffReviewGrantRequestForProvider(input: {
    context: ReturnType<typeof loadActiveSessionContext>;
    subject: TaskDiffReviewSubject;
    availableActor: CollaborationGrantRequest['availableActor'];
    callableProviderIds: readonly ProviderId[];
  }): CollaborationGrantRequest | null {
    if (
      input.availableActor.kind !== 'provider' ||
      input.callableProviderIds.length !== 1 ||
      input.callableProviderIds[0] !== input.availableActor.providerId
    ) {
      return null;
    }
    return {
      changeId: input.context.session.changeId,
      taskId: input.context.session.taskId,
      baselineCommit: input.context.session.baseline.head,
      baselineTree: input.context.session.baseline.tree,
      targetDigest: input.subject.subjectDigest,
      lifecyclePhase: 'task-diff-review',
      rolePair: {
        authorRole: 'task-implementer',
        conflictingRole: 'task-diff-reviewer',
      },
      availableActor: input.availableActor,
      degradedForm: 'same-provider-fresh-session',
      reason:
        'No session-independent TaskDiffReview reviewer is enabled for this exact candidate.',
      ttlMinutes: 30,
      maxUses: 1,
    };
  }

  function deriveTaskDiffCollaborationGrantBinding(
    repositoryRoot: string,
    request: CollaborationGrantRequest,
  ): CollaborationGrantExpectedBinding {
    const policy = parseBaselineJson(
      repositoryRoot,
      request.baselineCommit,
      'workflow/maintainer-policy.json',
      parseMaintainerPolicy,
    );
    return {
      repositoryId: policy.repository.id,
      repositoryOrigin: policy.repository.origin,
      policyBlob: runGit(repositoryRoot, [
        'rev-parse',
        `${request.baselineCommit}:workflow/maintainer-policy.json`,
      ]).trim(),
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
      availableActor: request.availableActor,
      degradedForm: request.degradedForm,
      reason: request.reason,
    };
  }

  function assertReservationCurrent(
    context: ReturnType<typeof loadActiveSessionContext>,
    subject: TaskDiffReviewSubject,
    expectedActor: RecordedRoleParticipant,
    reservation: TaskDiffReviewReservationRecord,
  ): void {
    if (
      reservation.sessionId !== context.session.sessionId ||
      reservation.changeId !== context.session.changeId ||
      reservation.taskId !== context.session.taskId ||
      reservation.repositoryRoot !== context.git.repositoryRealPath ||
      reservation.gitCommonDirectory !== context.git.gitCommonDirectory ||
      reservation.branch !== context.session.branch ||
      canonicalJson(reservation.baseline) !==
        canonicalJson(context.session.baseline) ||
      canonicalJson(reservation.mandateBinding) !==
        canonicalJson(context.session.mandateBinding ?? null) ||
      canonicalJson(reservation.subject) !== canonicalJson(subject) ||
      canonicalJson(reservation.implementationActor) !==
        canonicalJson(expectedActor)
    ) {
      throw workflowError(
        'TASK_DIFF_REVIEW_RESERVATION_STALE',
        'TaskDiffReview reservation no longer matches its WorkflowSession or candidate.',
        ExitCode.staleState,
      );
    }
  }

  function continuationProviderMatchesReview(
    review: TaskDiffReviewRecord,
    implementationActor: RecordedRoleParticipant,
    providerId: string,
  ): boolean {
    const originalReviewer = review.assignment.reviewerProviderId;
    if (originalReviewer === null) return true;
    const implementationProvider =
      implementationActor.providerId ?? review.assignment.implementerProviderId;
    return originalReviewer === implementationProvider
      ? providerId !== implementationProvider
      : providerId === originalReviewer;
  }

  function assertContinuationReservationCurrent(
    context: ReturnType<typeof loadActiveSessionContext>,
    current: CurrentTaskDiffReviewForProviderContinuation,
    response: TaskDiffReviewChallengeResponseRecord,
    reservation: TaskDiffReviewContinuationReservationRecord,
  ): void {
    assertTaskDiffReviewCandidateCurrent(current.subject, current.review);
    const exactResponse = assertTaskDiffReviewChallengeResponseCurrent(
      current.review,
      response,
    );
    const providerId = reservation.request.providerId;
    const policy = baselineAdapterPolicy(
      context.git.repositoryRoot,
      context.session.baseline.head,
    );
    if (
      reservation.sessionId !== context.session.sessionId ||
      reservation.changeId !== context.session.changeId ||
      reservation.taskId !== context.session.taskId ||
      reservation.repositoryRoot !== context.git.repositoryRealPath ||
      reservation.gitCommonDirectory !== context.git.gitCommonDirectory ||
      reservation.branch !== context.session.branch ||
      canonicalJson(reservation.baseline) !==
        canonicalJson(context.session.baseline) ||
      canonicalJson(reservation.mandateBinding) !==
        canonicalJson(context.session.mandateBinding ?? null) ||
      canonicalJson(reservation.subject) !==
        canonicalJson(current.review.subject) ||
      canonicalJson(reservation.implementationActor) !==
        canonicalJson(current.implementationActor) ||
      canonicalJson(reservation.review) !== canonicalJson(current.review) ||
      canonicalJson(reservation.response) !== canonicalJson(exactResponse) ||
      reservation.request.roleAssignment.providerId !== providerId ||
      reservation.request.roleAssignment.sessionId ===
        current.review.assignment.reviewerSessionId ||
      !policy.policy.providers[providerId].enabled ||
      !continuationProviderMatchesReview(
        current.review,
        current.implementationActor,
        providerId,
      ) ||
      canonicalJson(reservation.manifest.review) !==
        canonicalJson(current.review) ||
      canonicalJson(reservation.manifest.response) !==
        canonicalJson(exactResponse)
    ) {
      throw workflowError(
        'TASK_DIFF_REVIEW_CONTINUATION_RESERVATION_STALE',
        'TaskDiffReview continuation reservation no longer matches its current review, response, or WorkflowSession.',
        ExitCode.staleState,
      );
    }
  }

  function assertContinuationReservationBound(
    reviewReservation: TaskDiffReviewReservationRecord,
    review: TaskDiffReviewRecord,
    responseCandidate: TaskDiffReviewChallengeResponseRecord,
    reservation: TaskDiffReviewContinuationReservationRecord,
  ): void {
    const response = assertTaskDiffReviewChallengeResponseCurrent(
      review,
      responseCandidate,
    );
    if (
      reservation.sessionId !== reviewReservation.sessionId ||
      reservation.changeId !== reviewReservation.changeId ||
      reservation.taskId !== reviewReservation.taskId ||
      reservation.repositoryRoot !== reviewReservation.repositoryRoot ||
      reservation.gitCommonDirectory !== reviewReservation.gitCommonDirectory ||
      reservation.branch !== reviewReservation.branch ||
      canonicalJson(reservation.baseline) !==
        canonicalJson(reviewReservation.baseline) ||
      canonicalJson(reservation.mandateBinding) !==
        canonicalJson(reviewReservation.mandateBinding) ||
      canonicalJson(reservation.subject) !==
        canonicalJson(reviewReservation.subject) ||
      canonicalJson(reservation.implementationActor) !==
        canonicalJson(reviewReservation.implementationActor) ||
      canonicalJson(reservation.review) !== canonicalJson(review) ||
      canonicalJson(reservation.response) !== canonicalJson(response) ||
      !continuationProviderMatchesReview(
        review,
        reservation.implementationActor,
        reservation.request.providerId,
      ) ||
      !continuationProviderMatchesReview(
        review,
        reservation.implementationActor,
        reservation.request.roleAssignment.providerId,
      ) ||
      reservation.request.roleAssignment.sessionId ===
        review.assignment.reviewerSessionId ||
      canonicalJson(reservation.manifest.review) !== canonicalJson(review) ||
      canonicalJson(reservation.manifest.response) !== canonicalJson(response)
    ) {
      throw workflowError(
        'TASK_DIFF_REVIEW_CONTINUATION_RESERVATION_STALE',
        'TaskDiffReview continuation reservation no longer matches its current review, response, or WorkflowSession.',
        ExitCode.staleState,
      );
    }
  }

  function assertCurrentTaskDiffReviewBinding(
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    reservation: TaskDiffReviewReservationRecord,
    expectedReview: TaskDiffReviewRecord,
    replayMode: TaskDiffReviewReplayMode = 'governing',
    collaborationGrantValidation?: ReconcileTaskDiffReviewOptions['collaborationGrantValidation'],
  ): void {
    const binding = readTaskDiffReviewResultBinding(
      runtime,
      reservation.sessionId,
      reservation.subject.subjectDigest,
    );
    const invocation = readProviderInvocation(
      runtime,
      reservation.request.invocationId,
    );
    if (
      binding === null ||
      invocation.state !== 'succeeded' ||
      invocation.result === null ||
      invocation.result.runtimeObservation === null ||
      binding.ownerInvestigationId !== reservation.ownerInvestigationId ||
      binding.subjectDigest !== reservation.subject.subjectDigest ||
      binding.invocationId !== invocation.invocationId ||
      binding.requestDigest !== reservation.request.requestDigest ||
      binding.outputDigest !== invocation.result.outputDigest ||
      binding.runtimeObservationDigest !==
        sha256(canonicalJson(invocation.result.runtimeObservation)) ||
      canonicalJson(binding.review) !== canonicalJson(expectedReview)
    ) {
      throw reviewNotSatisfied();
    }
    const authorization = readEvidenceNode(
      runtime,
      reservation.authorizationNodeId,
    );
    const requestReservation = readEvidenceNode(
      runtime,
      reservation.reservationNodeId,
    );
    const observationNode = readEvidenceNode(
      runtime,
      binding.providerObservationNodeId,
    );
    if (
      observationNode.resultDigest !== binding.providerObservationDigest ||
      observationNode.type !== 'task-diff-review-provider-observation' ||
      observationNode.nodeSchema !==
        'workflow.task-diff-review-provider-observation.v1' ||
      observationNode.evaluator !== 'workflow-task-diff-review.v1' ||
      observationNode.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
      observationNode.outputSchema !==
        'workflow.task-diff-review-provider-observation-output.v1' ||
      canonicalJson(observationNode.output) !==
        canonicalJson({
          ownerInvestigationId: reservation.ownerInvestigationId,
          sessionId: reservation.sessionId,
          invocationId: invocation.invocationId,
          requestDigest: reservation.request.requestDigest,
          outputDigest: invocation.result.outputDigest,
          submission: invocation.result.output,
        }) ||
      canonicalJson(observationNode.runtimeMetadata) !==
        canonicalJson({
          runtimeObservation: invocation.result.runtimeObservation,
        }) ||
      observationNode.exactInputDigests.output !==
        invocation.result.outputDigest ||
      observationNode.exactInputDigests.request !==
        reservation.request.requestDigest ||
      observationNode.exactInputDigests.runtimeObservation !==
        binding.runtimeObservationDigest ||
      observationNode.exactInputDigests.subject !==
        reservation.subject.subjectDigest ||
      observationNode.semanticParentResultDigests.authorization !==
        authorization.resultDigest ||
      observationNode.semanticParentResultDigests.reservation !==
        requestReservation.resultDigest ||
      observationNode.provenanceParentNodeIds.authorization !==
        reservation.authorizationNodeId ||
      observationNode.provenanceParentNodeIds.reservation !==
        reservation.reservationNodeId
    ) {
      throw reviewNotSatisfied();
    }
    const content = {
      kind: 'task-diff-review' as const,
      nodeId: observationNode.nodeId,
      resultDigest: observationNode.resultDigest,
      outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
      evaluator: reservation.request.evaluatorVersion,
      policyDigest: reservation.request.policyDigest,
      contentDigest: observationNode.resultDigest,
      current: true as const,
    };
    const assignment = reservation.request.roleAssignment;
    let consumedReplay: VerifiedConsumedCollaborationGrantReplay | null = null;
    if ('grantId' in assignment) {
      const grantUse = binding.roleResult.grantUse;
      if (grantUse === null) throw reviewNotSatisfied();
      const envelope = parseCollaborationGrantEnvelope(
        canonicalCollaborationGrantEnvelope(grantUse.envelope),
      );
      const providerId = reservation.implementationActor.providerId;
      const authorAssurance = reservation.implementationActor.identityAssurance;
      if (
        providerId === null ||
        (authorAssurance !== 'self-declared' &&
          authorAssurance !== 'runtime-hint') ||
        assignment.grantId !== envelope.payload.grantId ||
        envelope.payload.availableActor.kind !== 'provider' ||
        authorAssurance !== envelope.payload.availableActor.assurance ||
        envelope.payload.availableActor.providerId !== providerId
      ) {
        throw reviewNotSatisfied();
      }
      const grantRequest: CollaborationGrantRequest = {
        changeId: reservation.changeId,
        taskId: reservation.taskId,
        baselineCommit: reservation.baseline.head,
        baselineTree: reservation.baseline.tree,
        targetDigest: reservation.subject.subjectDigest,
        lifecyclePhase: 'task-diff-review',
        rolePair: {
          authorRole: 'task-implementer',
          conflictingRole: 'task-diff-reviewer',
        },
        availableActor: {
          kind: 'provider',
          providerId,
          assurance: authorAssurance,
        },
        degradedForm: 'same-provider-fresh-session',
        reason:
          'No session-independent TaskDiffReview reviewer is enabled for this exact candidate.',
        ttlMinutes: 30,
        maxUses: 1,
      };
      const expectedBinding = deriveTaskDiffCollaborationGrantBinding(
        reservation.repositoryRoot,
        grantRequest,
      );
      const transitionDigest = collaborationTransitionDigest(expectedBinding);
      if (
        canonicalJson(bindingFromPayload(envelope.payload)) !==
          canonicalJson(expectedBinding) ||
        grantUse.transitionDigest !== transitionDigest
      ) {
        throw reviewNotSatisfied();
      }
      const consumedUse =
        replayMode === 'inspect'
          ? (() => {
              const inspection = readCollaborationGrantInspection(
                reservation.gitCommonDirectory,
                assignment.grantId,
              );
              return inspection?.state === 'consumed' &&
                inspection.use !== undefined
                ? inspection.use
                : null;
            })()
          : readExactConsumedCollaborationGrantUse(
              reservation.gitCommonDirectory,
              assignment.grantId,
              {
                transitionDigest,
                assignment,
                contentAdmission: {
                  kind: content.kind,
                  nodeId: content.nodeId,
                  resultDigest: content.resultDigest,
                  current: true,
                },
                now: new Date(envelope.payload.expiresAt),
              },
            );
      if (
        consumedUse === null ||
        canonicalJson(consumedUse) !== canonicalJson(grantUse)
      ) {
        throw reviewNotSatisfied();
      }
      if (replayMode === 'governing') {
        consumedReplay = resolveConsumedRoleResultReplayPort(
          collaborationGrantValidation,
        ).verify({
          repositoryRoot: reservation.repositoryRoot,
          expectedBinding,
          grantUse: consumedUse,
          assignment,
          content,
          directHumanReviewAttestation:
            binding.roleResult.directHumanReviewAttestation,
        });
      }
    } else if (binding.roleResult.grantUse !== null) {
      throw reviewNotSatisfied();
    }
    const participant =
      'grantId' in assignment
        ? assignment.participant
        : {
            providerId: assignment.providerId,
            sessionId: assignment.sessionId,
            principalId: null,
            identityAssurance: 'adapter-assigned' as const,
            engineSpawned: true as const,
          };
    const providerInvocation = {
      invocationId: invocation.invocationId,
      requestDigest: reservation.request.requestDigest,
      outputDigest: invocation.result.outputDigest,
      providerId: reservation.request.providerId,
      sessionId: assignment.sessionId!,
      targetDigest: reservation.subject.subjectDigest,
      engineSpawned: true as const,
    };
    const replayedRoleResult =
      replayMode === 'inspect' && 'grantId' in assignment
        ? binding.roleResult
        : consumedReplay !== null
          ? admitConsumedRoleResultReplay({
              assignment,
              author: reservation.implementationActor,
              participant,
              content,
              providerInvocation,
              replay: consumedReplay,
            })
          : admitRoleResult({
              assignment,
              author: reservation.implementationActor,
              participant,
              content,
              providerInvocation,
              grantUse: null,
              grantValidation: null,
            });
    if (replayMode === 'inspect') {
      assertStoredAdmittedRoleResultDigest(replayedRoleResult);
    }
    const grantUseDigest =
      replayedRoleResult.grantUse === null
        ? null
        : sha256(canonicalJson(replayedRoleResult.grantUse));
    if (
      canonicalJson(replayedRoleResult) !== canonicalJson(binding.roleResult) ||
      canonicalJson(expectedReview.assignment) !==
        canonicalJson({
          implementerPrincipalId: reservation.implementationActor.principalId!,
          implementerProviderId: reservation.implementationActor.providerId!,
          implementationSessionId: reservation.sessionId,
          reviewerPrincipalId:
            replayedRoleResult.participant.principalId ??
            `provider:${replayedRoleResult.assignment.providerId}`,
          reviewerProviderId: replayedRoleResult.assignment.providerId,
          reviewerSessionId: replayedRoleResult.assignment.sessionId,
          achievedIndependence: replayedRoleResult.achievedIndependence,
          degradedForm: replayedRoleResult.grantUse?.degradedForm ?? null,
          grantUseDigest,
        })
    ) {
      throw reviewNotSatisfied();
    }
    const resultNode = readEvidenceNode(runtime, binding.providerResultNodeId);
    if (
      resultNode.resultDigest !== binding.providerResultDigest ||
      resultNode.type !== 'task-diff-review-provider-result' ||
      resultNode.nodeSchema !==
        'workflow.task-diff-review-provider-result.v1' ||
      resultNode.evaluator !== 'workflow-task-diff-review.v1' ||
      resultNode.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
      resultNode.outputSchema !==
        'workflow.task-diff-review-provider-result-output.v1' ||
      canonicalJson(resultNode.output) !==
        canonicalJson({
          ownerInvestigationId: reservation.ownerInvestigationId,
          sessionId: reservation.sessionId,
          invocationId: invocation.invocationId,
          roleResult: replayedRoleResult,
          review: expectedReview,
        }) ||
      resultNode.exactInputDigests.admission !==
        replayedRoleResult.resultDigest ||
      resultNode.exactInputDigests.observation !==
        observationNode.resultDigest ||
      resultNode.exactInputDigests.subject !==
        reservation.subject.subjectDigest ||
      resultNode.semanticParentResultDigests.observation !==
        observationNode.resultDigest ||
      resultNode.provenanceParentNodeIds.observation !== observationNode.nodeId
    ) {
      throw reviewNotSatisfied();
    }
  }

  function assertCurrentTaskDiffReviewContinuationBinding(
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    reservation: TaskDiffReviewContinuationReservationRecord,
    expectedSubmission: TaskDiffReviewContinuationSubmission,
  ): void {
    const currentSubmission = assertTaskDiffReviewContinuationSubmissionCurrent(
      reservation.review,
      reservation.response,
      expectedSubmission,
    );
    const binding = readTaskDiffReviewContinuationResultBinding(
      runtime,
      reservation.sessionId,
      reservation.review.recordDigest,
    );
    const invocation = readProviderInvocation(
      runtime,
      reservation.request.invocationId,
    );
    if (
      binding === null ||
      invocation.state !== 'succeeded' ||
      invocation.result === null ||
      invocation.result.runtimeObservation === null ||
      binding.ownerInvestigationId !== reservation.ownerInvestigationId ||
      binding.sessionId !== reservation.sessionId ||
      binding.subjectDigest !== reservation.subject.subjectDigest ||
      binding.reviewRecordDigest !== reservation.review.recordDigest ||
      binding.responseDigest !== reservation.response.responseDigest ||
      binding.invocationId !== invocation.invocationId ||
      binding.requestDigest !== reservation.request.requestDigest ||
      binding.outputDigest !== invocation.result.outputDigest ||
      binding.runtimeObservationDigest !==
        sha256(canonicalJson(invocation.result.runtimeObservation)) ||
      canonicalJson(binding.submission) !== canonicalJson(currentSubmission)
    ) {
      throw reviewNotSatisfied();
    }
    const authorization = readEvidenceNode(
      runtime,
      reservation.authorizationNodeId,
    );
    const requestReservation = readEvidenceNode(
      runtime,
      reservation.reservationNodeId,
    );
    const resultNode = readEvidenceNode(runtime, binding.providerResultNodeId);
    if (
      resultNode.resultDigest !== binding.providerResultDigest ||
      resultNode.type !== 'task-diff-review-continuation-provider-result' ||
      resultNode.nodeSchema !==
        'workflow.task-diff-review-continuation-provider-result.v1' ||
      resultNode.evaluator !== 'workflow-task-diff-review.v1' ||
      resultNode.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
      resultNode.outputSchema !==
        'workflow.task-diff-review-continuation-provider-result-output.v1' ||
      canonicalJson(resultNode.output) !==
        canonicalJson({
          ownerInvestigationId: reservation.ownerInvestigationId,
          sessionId: reservation.sessionId,
          invocationId: invocation.invocationId,
          requestDigest: reservation.request.requestDigest,
          outputDigest: invocation.result.outputDigest,
          responseDigest: reservation.response.responseDigest,
          submission: currentSubmission,
        }) ||
      resultNode.exactInputDigests.output !== invocation.result.outputDigest ||
      resultNode.exactInputDigests.request !==
        reservation.request.requestDigest ||
      resultNode.exactInputDigests.response !==
        reservation.response.responseDigest ||
      resultNode.exactInputDigests.review !== reservation.review.recordDigest ||
      resultNode.exactInputDigests.runtimeObservation !==
        binding.runtimeObservationDigest ||
      resultNode.exactInputDigests.subject !==
        reservation.subject.subjectDigest ||
      resultNode.semanticParentResultDigests.authorization !==
        authorization.resultDigest ||
      resultNode.semanticParentResultDigests.reservation !==
        requestReservation.resultDigest ||
      resultNode.provenanceParentNodeIds.authorization !==
        reservation.authorizationNodeId ||
      resultNode.provenanceParentNodeIds.reservation !==
        reservation.reservationNodeId
    ) {
      throw reviewNotSatisfied();
    }
  }

  function ensureTaskDiffFinalAssurance(
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    current: CurrentTaskDiffReviewForProviderContinuation,
    continuationReservation: TaskDiffReviewContinuationReservationRecord,
    continuationBinding: TaskDiffReviewContinuationResultBinding,
  ): TaskDiffFinalAssuranceRecord {
    const existing = assertCurrentTaskDiffFinalAssuranceBinding(
      runtime,
      current,
      continuationReservation,
      continuationBinding,
    );
    if (existing !== null) return existing;
    assertCurrentTaskDiffReviewContinuationBinding(
      runtime,
      continuationReservation,
      continuationBinding.submission,
    );
    const authenticatedClosure = authenticatedProviderChallengeClosureAuthority(
      current,
      continuationReservation,
      continuationBinding,
    );
    const reviewerAuthority = authenticatedClosure.authority;
    const exceptions =
      current.review.assignment.degradedForm === null ||
      current.review.assignment.grantUseDigest === null
        ? []
        : [
            {
              kind: 'collaboration-grant-degradation' as const,
              stage: 'review' as const,
              grantUseDigest: current.review.assignment.grantUseDigest,
              degradedForm: current.review.assignment.degradedForm,
            },
          ];
    const assurance = createTaskDiffFinalAssuranceRecord({
      subject: current.review.subject,
      review: current.review,
      response: continuationReservation.response,
      submission: continuationBinding.submission,
      reviewerAuthority,
      exceptions,
      authenticatedReviewAuthority: current.authenticatedReviewAuthority,
      authenticatedChallengeClosureAuthority: authenticatedClosure,
    });
    const reviewResultNode = readEvidenceNode(
      runtime,
      current.reviewResultNodeId,
    );
    const continuationResultNode = readEvidenceNode(
      runtime,
      continuationBinding.providerResultNodeId,
    );
    if (
      reviewResultNode.resultDigest !== current.reviewResultDigest ||
      continuationResultNode.resultDigest !==
        continuationBinding.providerResultDigest
    ) {
      throw reviewNotSatisfied();
    }
    const assuranceNode = createEvidenceNode({
      type: 'task-diff-final-assurance',
      nodeSchema: 'workflow.task-diff-final-assurance.v1',
      evaluator: 'workflow-task-diff-review.v1',
      policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
      exactInputDigests: {
        authority: sha256(canonicalJson(reviewerAuthority)),
        closureAuthority: sha256(canonicalJson(authenticatedClosure)),
        response: continuationReservation.response.responseDigest,
        review: current.review.recordDigest,
        reviewAuthority: sha256(
          canonicalJson(current.authenticatedReviewAuthority),
        ),
        subject: current.review.subjectDigest,
        submission: sha256(canonicalJson(continuationBinding.submission)),
      },
      semanticParentResultDigests: {
        continuation: continuationResultNode.resultDigest,
        review: reviewResultNode.resultDigest,
      },
      provenanceParentNodeIds: {
        continuation: continuationResultNode.nodeId,
        review: reviewResultNode.nodeId,
      },
      outputSchema: 'workflow.task-diff-final-assurance-output.v1',
      output: assurance,
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, assuranceNode);
    createTaskDiffFinalAssuranceBinding(runtime, {
      subjectDigest: current.review.subjectDigest,
      assuranceNodeId: assuranceNode.nodeId,
      assuranceResultDigest: assuranceNode.resultDigest,
      assurance,
      createdAt: continuationBinding.createdAt,
    });
    return (
      assertCurrentTaskDiffFinalAssuranceBinding(
        runtime,
        current,
        continuationReservation,
        continuationBinding,
      ) ??
      (() => {
        throw reviewNotSatisfied();
      })()
    );
  }

  function assertCurrentTaskDiffFinalAssuranceBinding(
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    current: CurrentAuthenticatedTaskDiffReview,
    continuationReservation: TaskDiffReviewContinuationReservationRecord,
    continuationBinding: TaskDiffReviewContinuationResultBinding,
  ): TaskDiffFinalAssuranceRecord | null {
    const binding = readTaskDiffFinalAssuranceBinding(
      runtime,
      current.review.subjectDigest,
    );
    if (binding === null) return null;
    assertCurrentTaskDiffReviewContinuationBinding(
      runtime,
      continuationReservation,
      continuationBinding.submission,
    );
    const authenticatedClosure = authenticatedProviderChallengeClosureAuthority(
      current,
      continuationReservation,
      continuationBinding,
    );
    const assurance = assertTaskDiffFinalAssuranceCurrent({
      subject: current.review.subject,
      review: current.review,
      response: continuationReservation.response,
      assurance: binding.assurance,
      authenticatedReviewAuthority: current.authenticatedReviewAuthority,
      authenticatedChallengeClosureAuthority: authenticatedClosure,
    });
    const reviewResultNode = readEvidenceNode(
      runtime,
      current.reviewResultNodeId,
    );
    const continuationResultNode = readEvidenceNode(
      runtime,
      continuationBinding.providerResultNodeId,
    );
    const assuranceNode = readEvidenceNode(runtime, binding.assuranceNodeId);
    const reviewerAuthority = assurance.reviewerAuthority;
    if (
      binding.assuranceResultDigest !== assuranceNode.resultDigest ||
      canonicalJson(binding.assurance) !== canonicalJson(assurance) ||
      assuranceNode.type !== 'task-diff-final-assurance' ||
      assuranceNode.nodeSchema !== 'workflow.task-diff-final-assurance.v1' ||
      assuranceNode.evaluator !== 'workflow-task-diff-review.v1' ||
      assuranceNode.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
      assuranceNode.outputSchema !==
        'workflow.task-diff-final-assurance-output.v1' ||
      canonicalJson(assuranceNode.output) !== canonicalJson(assurance) ||
      assuranceNode.exactInputDigests.authority !==
        sha256(canonicalJson(reviewerAuthority)) ||
      assuranceNode.exactInputDigests.closureAuthority !==
        sha256(canonicalJson(authenticatedClosure)) ||
      assuranceNode.exactInputDigests.response !==
        continuationReservation.response.responseDigest ||
      assuranceNode.exactInputDigests.review !== current.review.recordDigest ||
      assuranceNode.exactInputDigests.reviewAuthority !==
        sha256(canonicalJson(current.authenticatedReviewAuthority)) ||
      assuranceNode.exactInputDigests.subject !==
        current.review.subjectDigest ||
      assuranceNode.exactInputDigests.submission !==
        sha256(canonicalJson(continuationBinding.submission)) ||
      assuranceNode.semanticParentResultDigests.continuation !==
        continuationResultNode.resultDigest ||
      assuranceNode.semanticParentResultDigests.review !==
        reviewResultNode.resultDigest ||
      assuranceNode.provenanceParentNodeIds.continuation !==
        continuationResultNode.nodeId ||
      assuranceNode.provenanceParentNodeIds.review !== reviewResultNode.nodeId
    ) {
      throw reviewNotSatisfied();
    }
    return assurance;
  }

  function authenticatedProviderChallengeClosureAuthority(
    current: CurrentAuthenticatedTaskDiffReview,
    reservation: TaskDiffReviewContinuationReservationRecord,
    binding: TaskDiffReviewContinuationResultBinding,
  ): TaskDiffAuthenticatedReviewerAuthority {
    const providerId = reservation.request.providerId;
    const principalId =
      current.review.assignment.reviewerProviderId === providerId
        ? current.review.assignment.reviewerPrincipalId
        : `provider:${providerId}`;
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
      stage: 'challenge-closure' as const,
      subjectDigest: current.review.subjectDigest,
      reviewRecordDigest: current.review.recordDigest,
      responseDigest: reservation.response.responseDigest,
      authorityNodeId: binding.providerResultNodeId,
      authorityResultDigest: binding.providerResultDigest,
      authority: Object.freeze({
        kind: 'engine-attributed-provider-reviewer' as const,
        principalId,
        providerId,
        policyDigest: current.review.subject.reviewPolicyDigest,
      }),
    });
  }
  return {
    taskDiffReviewGrantRequest,
    taskDiffReviewGrantRequestForProvider,
    deriveTaskDiffCollaborationGrantBinding,
    assertReservationCurrent,
    assertContinuationReservationCurrent,
    assertContinuationReservationBound,
    assertCurrentTaskDiffReviewBinding,
    assertCurrentTaskDiffReviewContinuationBinding,
    ensureTaskDiffFinalAssurance,
    assertCurrentTaskDiffFinalAssuranceBinding,
  };
}
