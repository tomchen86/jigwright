/**
 * Authenticates external review continuations and recovers their terminal
 * assurance.
 *
 * Invariants:
 * - Terminal external assurance requires exactly one matching continuation
 *   binding.
 */
import { taskDiffExternalContinuationTargetDigest } from '../../modules/assurance/task-diff-external-authority.ts';
import type {
  TaskDiffExternalContinuationBinding,
  TaskDiffExternalContinuationReservation,
} from '../../modules/assurance/task-diff-external-record.ts';
// Authenticate external continuation bindings and recover terminal assurance.
import {
  assertTaskDiffReviewChallengeResponseCurrent,
  createTaskDiffReviewChallengeResponse,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  createTaskDiffFinalAssuranceRecord,
  assertTaskDiffFinalAssuranceCurrent,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import { listProviderIds } from '../../modules/provider-orchestration/provider-registry.ts';
import type {
  TaskDiffReviewChallengeResponseRecord,
  TaskDiffReviewRecord,
  TaskDiffReviewContinuationSubmission,
  TaskDiffFinalAssuranceRecord,
} from '../../modules/assurance/task-diff-review-artifact-record.ts';
import { type TaskDiffReviewExternalClosureInput } from '../../modules/assurance/task-diff-review-input.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import { TASK_DIFF_REVIEW_POLICY_DIGEST } from '../../modules/assurance/task-diff-review.ts';
import type { TaskDiffReviewSubject } from '../../modules/assurance/task-diff-review-record.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  type CollaborationGrantExpectedBinding,
  bindingFromPayload,
} from '../../modules/authority/collaboration-grant-codec.ts';
import {
  type Challenge,
  type ChallengeClosure,
  assertAuthorizedReviewChallengeClosure,
} from '../../modules/assurance/review-challenge.ts';
import { type AdmittedRoleResult } from '../../modules/provider-orchestration/role-admission-contracts.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import { type GrantedRoleAssignment } from '../../modules/provider-orchestration/role-assignment.ts';
import type {
  TaskDiffReviewRuntimeBindings,
  TaskDiffReviewRuntimeData,
} from './task-diff-review-lifecycle.ts';
import type {
  CurrentAuthenticatedTaskDiffReview,
  TaskDiffReviewReplayMode,
  TaskDiffReviewConsumedReplayValidation,
  CurrentExternalTaskDiffTerminalAssurance,
  TaskDiffReviewExternalContinuationLifecycleStatus,
  AuthenticatedExternalTaskDiffContinuation,
} from './task-diff-review-contracts.ts';
import type { createTaskDiffReviewCommonModule } from './task-diff-review-common.ts';
import type { createTaskDiffReviewExternalBindingModule } from './task-diff-review-external-binding.ts';

type CollaborationGrantSelectionCoreBinding =
  TaskDiffReviewRuntimeData['CollaborationGrantSelectionCoreBinding'];

export function createTaskDiffReviewExternalContinuationBindingModule(
  runtime: TaskDiffReviewRuntimeBindings,
  common: ReturnType<typeof createTaskDiffReviewCommonModule>,
  externalBinding: ReturnType<typeof createTaskDiffReviewExternalBindingModule>,
  roleResultAdmission: Pick<
    RoleAdmissionServices,
    'admitConsumedRoleResultReplay'
  >,
) {
  const { admitConsumedRoleResultReplay } = roleResultAdmission;
  const {
    loadActiveSessionContext,
    loadInvestigationRuntimeContext,
    listAllTaskDiffExternalContinuationBindings,
    readTaskDiffExternalChallengeResponse,
    listAllTaskDiffReviewContinuationReservations,
    listAllTaskDiffReviewContinuationResultBindings,
    readTaskDiffReviewContinuationReservation,
    readTaskDiffReviewContinuationResultBinding,
    readProviderInvocation,
    listAllTaskDiffExternalContinuationReservations,
    listTaskDiffExternalContinuationReservations,
    listCollaborationGrantInspections,
    readTaskDiffExternalContinuationReservation,
    createTaskDiffExternalClosureSubmission,
    createEvidenceNode,
    readTaskDiffExternalClosureSubmission,
    readEvidenceNode,
    readCollaborationGrantInspection,
    writeEvidenceNode,
    createTaskDiffFinalAssuranceBinding,
    readTaskDiffFinalAssuranceBinding,
  } = runtime;
  const {
    taskDiffReviewLineageConflict,
    externalTaskDiffAuthorityInvalid,
    externalTaskDiffInputStale,
    baselineAdapterPolicy,
    isExternalRecord,
    parseBaselineJson,
    resolveConsumedRoleResultReplayPort,
    assertStoredAdmittedRoleResultDigest,
    sha256,
    reviewNotSatisfied,
  } = common;
  const {
    externalTaskDiffGrantCore,
    inspectExternalGrant,
    externalParticipantFromGrant,
    assertExternalTaskDiffGrantBinding,
    requiredPrincipalId,
  } = externalBinding;
  function loadAuthenticatedExternalTaskDiffTerminalAssurance(input: {
    context: ReturnType<typeof loadActiveSessionContext>;
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
    current: CurrentAuthenticatedTaskDiffReview;
    replayMode?: TaskDiffReviewReplayMode;
    validation?: TaskDiffReviewConsumedReplayValidation;
  }): CurrentExternalTaskDiffTerminalAssurance | null {
    const { context, runtime, current, replayMode = 'governing' } = input;
    const bindings = listAllTaskDiffExternalContinuationBindings(
      runtime,
    ).filter(
      (binding) => binding.reviewRecordDigest === current.review.recordDigest,
    );
    if (bindings.length === 0) return null;
    if (bindings.length !== 1) throw taskDiffReviewLineageConflict();
    const binding = bindings[0]!;
    assertExternalTaskDiffContinuationProviderShortage(
      context,
      runtime,
      context.session.sessionId,
      current.review,
    );
    const storedResponse = readTaskDiffExternalChallengeResponse(
      runtime,
      current.review.subjectDigest,
      current.review.recordDigest,
      binding.responseDigest,
    );
    if (storedResponse === null) throw externalTaskDiffAuthorityInvalid();
    const response = assertTaskDiffReviewChallengeResponseCurrent(
      current.review,
      storedResponse.response,
    );
    const authenticatedClosure =
      assertCurrentExternalTaskDiffContinuationBinding({
        context,
        runtime,
        current,
        response,
        binding,
        replayMode,
        validation: input.validation,
      });
    const finalAssurance = assertCurrentExternalTaskDiffFinalAssuranceBinding({
      runtime,
      current,
      response,
      binding,
      authenticatedClosure,
    });
    if (finalAssurance === null) return null;
    return Object.freeze({
      source: 'external-continuation' as const,
      subject: current.subject,
      review: current.review,
      response,
      finalAssurance,
      continuationAuthorityNodeId: binding.authorityNodeId,
      continuationAuthorityResultDigest: binding.authorityResultDigest,
    });
  }

  function assertExternalTaskDiffContinuationInputCurrent(
    current: CurrentAuthenticatedTaskDiffReview,
    responseCandidate: TaskDiffReviewChallengeResponseRecord,
    input: TaskDiffReviewExternalClosureInput,
  ): TaskDiffReviewChallengeResponseRecord {
    const response = assertTaskDiffReviewChallengeResponseCurrent(
      current.review,
      responseCandidate,
    );
    const rebuilt = createTaskDiffReviewChallengeResponse({
      review: current.review,
      responses: response.responses,
    });
    if (
      current.review.challenges.length === 0 ||
      canonicalJson(rebuilt) !== canonicalJson(response) ||
      input.subjectDigest !== current.review.subjectDigest ||
      input.reviewRecordDigest !== current.review.recordDigest ||
      input.responseDigest !== response.responseDigest
    ) {
      throw externalTaskDiffInputStale();
    }
    return response;
  }

  const TASK_DIFF_EXTERNAL_CONTINUATION_SHORTAGE_FAILURE_CODES = new Set([
    'PROVIDER_CAPACITY',
    'PROVIDER_RATE_LIMIT',
    'PROVIDER_TOOL_UNAVAILABLE',
    'PROVIDER_UNAVAILABLE',
  ]);

  function assertExternalTaskDiffContinuationProviderShortage(
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    sessionId: string,
    review: TaskDiffReviewRecord,
  ): ProviderId[] {
    const reservations = listAllTaskDiffReviewContinuationReservations(
      runtime,
    ).filter(
      ({ review: candidate }) => candidate.recordDigest === review.recordDigest,
    );
    const results = listAllTaskDiffReviewContinuationResultBindings(
      runtime,
    ).filter(
      ({ reviewRecordDigest }) => reviewRecordDigest === review.recordDigest,
    );
    const exactReservation = readTaskDiffReviewContinuationReservation(
      runtime,
      sessionId,
      review.recordDigest,
    );
    const exactResult = readTaskDiffReviewContinuationResultBinding(
      runtime,
      sessionId,
      review.recordDigest,
    );
    if (
      results.length > 0 ||
      exactResult !== null ||
      reservations.length > 1 ||
      (exactReservation !== null &&
        !reservations.some(
          (reservation) =>
            reservation.reservationDigest ===
            exactReservation.reservationDigest,
        ))
    ) {
      throw taskDiffReviewLineageConflict();
    }
    if (reservations.length === 1) {
      const reservation = reservations[0]!;
      if (
        canonicalJson(reservation.review) !== canonicalJson(review) ||
        reservation.subject.subjectDigest !== review.subjectDigest
      ) {
        throw taskDiffReviewLineageConflict();
      }
      const invocation = readProviderInvocation(
        runtime,
        reservation.request.invocationId,
      );
      if (
        invocation.requestDigest !== reservation.request.requestDigest ||
        invocation.investigationId !== reservation.ownerInvestigationId ||
        invocation.changeId !== reservation.changeId
      ) {
        throw taskDiffReviewLineageConflict();
      }
      if (
        invocation.state === 'failed' &&
        invocation.failure !== null &&
        TASK_DIFF_EXTERNAL_CONTINUATION_SHORTAGE_FAILURE_CODES.has(
          invocation.failure.code,
        )
      ) {
        return [];
      }
      if (invocation.state !== 'failed') {
        throw taskDiffReviewLineageConflict();
      }
      throw externalTaskDiffContinuationProviderShortageRequired();
    }

    const callableProviderIds = listProviderIds().filter(
      (providerId) =>
        baselineAdapterPolicy(
          context.git.repositoryRoot,
          review.subject.baseCommit,
        ).policy.providers[providerId].enabled,
    );
    if (callableProviderIds.length !== 0) {
      throw externalTaskDiffContinuationProviderShortageRequired();
    }
    return [];
  }

  function externalTaskDiffContinuationProviderShortageRequired(): WorkflowError {
    return workflowError(
      'TASK_DIFF_EXTERNAL_CONTINUATION_PROVIDER_SHORTAGE_REQUIRED',
      'External TaskDiffReview challenge closure requires either no callable review provider or one exact provider continuation that failed with an availability shortage.',
      ExitCode.guard,
    );
  }

  function externalTaskDiffContinuationGrantCore(
    context: ReturnType<typeof loadActiveSessionContext>,
    subject: TaskDiffReviewSubject,
    targetDigest: string,
    policy: ReturnType<typeof parseMaintainerPolicy>,
  ): CollaborationGrantSelectionCoreBinding {
    return {
      ...externalTaskDiffGrantCore(context, subject, policy),
      targetDigest,
    };
  }

  function assertExternalTaskDiffContinuationAttemptMayProceed(
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    reviewRecordDigest: string,
    targetDigest: string,
    requestedGrantId: string,
  ): void {
    const completed = listAllTaskDiffExternalContinuationBindings(
      runtime,
    ).filter((binding) => binding.reviewRecordDigest === reviewRecordDigest);
    if (completed.some((binding) => binding.targetDigest !== targetDigest)) {
      throw taskDiffReviewLineageConflict();
    }
    for (const attempt of listAllTaskDiffExternalContinuationReservations(
      runtime,
    ).filter(
      (reservation) => reservation.reviewRecordDigest === reviewRecordDigest,
    )) {
      const inspection = inspectExternalGrant(
        context.git.gitCommonDirectory,
        attempt.grant.grantId,
      );
      if (
        (attempt.targetDigest !== targetDigest ||
          attempt.grant.grantId !== requestedGrantId) &&
        (inspection.state === 'reserved' || inspection.state === 'consumed')
      ) {
        throw workflowError(
          'TASK_DIFF_EXTERNAL_CONTINUATION_ATTEMPT_ACTIVE',
          'Another exact external TaskDiffReview continuation grant attempt is active; resume that signed envelope before selecting a replacement.',
          ExitCode.conflict,
        );
      }
    }
  }

  function assertExternalTaskDiffContinuationOrphanGrantMayProceed(
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    targetDigest: string,
    requestedGrantId: string,
  ): void {
    const recordedGrantIds = new Set(
      listTaskDiffExternalContinuationReservations(runtime, targetDigest).map(
        ({ grant }) => grant.grantId,
      ),
    );
    const orphans = listCollaborationGrantInspections(
      context.git.gitCommonDirectory,
    ).filter(
      (grant) =>
        grant.state === 'reserved' &&
        grant.changeId === context.session.changeId &&
        grant.taskId === context.session.taskId &&
        grant.lifecyclePhase === 'task-diff-review' &&
        grant.targetDigest === targetDigest &&
        (grant.degradedForm === 'caller-supplied' ||
          grant.degradedForm === 'direct-human-review') &&
        !recordedGrantIds.has(grant.grantId),
    );
    if (orphans.length > 1) {
      throw workflowError(
        'TASK_DIFF_EXTERNAL_CONTINUATION_COMPETING_AUTHORITY',
        'Multiple orphaned external continuation grant reservations cover the exact challenge target.',
        ExitCode.guard,
      );
    }
    if (orphans[0] !== undefined && orphans[0].grantId !== requestedGrantId) {
      throw workflowError(
        'TASK_DIFF_EXTERNAL_CONTINUATION_ATTEMPT_ACTIVE',
        'An exact external continuation grant was reserved before its attempt record was published; resume that grant first.',
        ExitCode.conflict,
      );
    }
  }

  function requireExternalTaskDiffContinuationReservation(
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    targetDigest: string,
    grantEnvelopeDigest: string,
  ): TaskDiffExternalContinuationReservation {
    const reservation = readTaskDiffExternalContinuationReservation(
      runtime,
      targetDigest,
      grantEnvelopeDigest,
    );
    if (reservation === null) throw externalTaskDiffAuthorityInvalid();
    return reservation;
  }

  function preflightExternalTaskDiffChallengeClosure(
    review: TaskDiffReviewRecord,
    submission: TaskDiffReviewContinuationSubmission,
    expectedBinding: CollaborationGrantExpectedBinding,
  ): void {
    const participant = externalParticipantFromGrant(expectedBinding);
    if (participant.principalId === undefined) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const challenges: readonly Challenge[] = review.challenges.map(
      (challenge) => ({
        challengeId: challenge.challengeId,
        raisedBy: challenge.raisedBy,
        severity:
          challenge.severity === 'critical' ? 'forbidden-floor' : 'ordinary',
        targetId: challenge.challengeId,
      }),
    );
    const closures: readonly ChallengeClosure[] =
      submission.proposedDispositions.map((entry) => ({
        challengeId: entry.challengeId,
        disposition: entry.decision,
        closedBy: participant.principalId!,
        ...(entry.supersededBy === null
          ? {}
          : { supersededBy: entry.supersededBy }),
      }));
    assertAuthorizedReviewChallengeClosure({
      expectedSubjectDigest: review.subjectDigest,
      authoritySubjectDigest: review.subjectDigest,
      authenticatedCloserId: participant.principalId,
      challenges,
      closures,
      context: {
        authorId: review.assignment.implementerPrincipalId,
        reviewerIds: [participant.principalId],
        domainOwnerIds: [],
      },
    });
  }

  function createExternalTaskDiffContinuationContentNode(
    submission: ReturnType<typeof createTaskDiffExternalClosureSubmission>,
  ) {
    return createEvidenceNode({
      type: 'task-diff-review-external-continuation-submission',
      nodeSchema:
        'workflow.task-diff-review-external-continuation-submission.v1',
      evaluator: 'workflow-task-diff-review.v1',
      policyDigest: submission.subject.reviewPolicyDigest,
      exactInputDigests: {
        input: submission.inputDigest,
        response: submission.responseDigest,
        review: submission.reviewRecordDigest,
        submission: submission.recordDigest,
        subject: submission.subjectDigest,
      },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema:
        'workflow.task-diff-review-external-continuation-submission-output.v1',
      output: { submission },
      runtimeMetadata: {},
    });
  }

  function externalTaskDiffContinuationContentAdmission(
    contentNode: ReturnType<typeof createEvidenceNode>,
    subject: TaskDiffReviewSubject,
  ) {
    return {
      kind: 'task-diff-review' as const,
      nodeId: contentNode.nodeId,
      resultDigest: contentNode.resultDigest,
      outputSchema: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
      evaluator: 'task-diff-review-continuation.v1',
      policyDigest: subject.reviewPolicyDigest,
      contentDigest: contentNode.resultDigest,
      current: true as const,
    };
  }

  function createExternalTaskDiffContinuationAuthorityNode(input: {
    submission: ReturnType<typeof createTaskDiffExternalClosureSubmission>;
    contentNode: ReturnType<typeof createEvidenceNode>;
    roleResult: AdmittedRoleResult;
  }) {
    return createEvidenceNode({
      type: 'task-diff-review-external-continuation-authority-result',
      nodeSchema:
        'workflow.task-diff-review-external-continuation-authority-result.v1',
      evaluator: 'workflow-task-diff-review.v1',
      policyDigest: input.submission.subject.reviewPolicyDigest,
      exactInputDigests: {
        admission: input.roleResult.resultDigest,
        content: input.contentNode.resultDigest,
        input: input.submission.inputDigest,
        response: input.submission.responseDigest,
        review: input.submission.reviewRecordDigest,
        subject: input.submission.subjectDigest,
      },
      semanticParentResultDigests: { content: input.contentNode.resultDigest },
      provenanceParentNodeIds: { content: input.contentNode.nodeId },
      outputSchema:
        'workflow.task-diff-review-external-continuation-authority-result-output.v1',
      output: { roleResult: input.roleResult },
      runtimeMetadata: {},
    });
  }

  function assertExternalTaskDiffContinuationReservationContent(
    reservation: TaskDiffExternalContinuationReservation,
    submission: ReturnType<typeof createTaskDiffExternalClosureSubmission>,
    contentNode: ReturnType<typeof createEvidenceNode>,
  ): void {
    if (
      reservation.targetDigest !== submission.targetDigest ||
      reservation.subjectDigest !== submission.subjectDigest ||
      reservation.reviewRecordDigest !== submission.reviewRecordDigest ||
      reservation.responseDigest !== submission.responseDigest ||
      reservation.inputDigest !== submission.inputDigest ||
      reservation.contentNodeId !== contentNode.nodeId ||
      reservation.contentResultDigest !== contentNode.resultDigest
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
  }

  function renderExternalTaskDiffContinuationDirectHumanPause(
    sessionId: string,
    current: CurrentAuthenticatedTaskDiffReview,
    response: TaskDiffReviewChallengeResponseRecord,
    reservation: TaskDiffExternalContinuationReservation,
  ): TaskDiffReviewExternalContinuationLifecycleStatus {
    return Object.freeze({
      state: 'direct-human-attestation-required' as const,
      source: 'external-continuation' as const,
      sessionId,
      subject: current.subject,
      implementationActor: current.implementationActor,
      review: current.review,
      response,
      grantId: reservation.grant.grantId,
      grantEnvelopeDigest: reservation.grant.grantEnvelopeDigest,
      transitionDigest: reservation.grant.grantTransitionDigest,
      reservationDigest: reservation.reservationDigest,
      inputDigest: reservation.inputDigest,
      contentNodeId: reservation.contentNodeId,
      contentResultDigest: reservation.contentResultDigest,
      reviewNodeId: reservation.contentNodeId,
      reviewResultDigest: reservation.contentResultDigest,
    });
  }

  function externalTaskDiffContinuationGrantRequiredStatus(
    sessionId: string,
    current: CurrentAuthenticatedTaskDiffReview,
    response: TaskDiffReviewChallengeResponseRecord,
    targetDigest: string,
  ): TaskDiffReviewExternalContinuationLifecycleStatus {
    return Object.freeze({
      state: 'collaboration-grant-required' as const,
      source: 'external-continuation' as const,
      sessionId,
      subject: current.subject,
      implementationActor: current.implementationActor,
      review: current.review,
      response,
      targetDigest,
      inputSchema: Object.freeze({
        schemaVersion: 1 as const,
        kind: 'collaboration-grant-selection' as const,
        lifecyclePhase: 'task-diff-review' as const,
        conflictingRole: 'task-diff-reviewer' as const,
        grantRequest: null,
        targetDigest,
        subjectDigest: current.review.subjectDigest,
        reviewRecordDigest: current.review.recordDigest,
        responseDigest: response.responseDigest,
        allowedDegradedForms: Object.freeze([
          'caller-supplied' as const,
          'direct-human-review' as const,
        ]),
        resumeOption: '--grant <grant-id>' as const,
      }),
    });
  }

  function renderExternalTaskDiffContinuationSatisfied(
    sessionId: string,
    current: CurrentAuthenticatedTaskDiffReview,
    response: TaskDiffReviewChallengeResponseRecord,
    finalAssurance: TaskDiffFinalAssuranceRecord,
  ): TaskDiffReviewExternalContinuationLifecycleStatus {
    return Object.freeze({
      state: finalAssurance.verdict,
      source: 'external-continuation' as const,
      sessionId,
      subject: current.subject,
      implementationActor: current.implementationActor,
      review: current.review,
      response,
      finalAssurance,
    });
  }

  function assertCurrentExternalTaskDiffContinuationBinding(input: {
    context: ReturnType<typeof loadActiveSessionContext>;
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
    current: CurrentAuthenticatedTaskDiffReview;
    response: TaskDiffReviewChallengeResponseRecord;
    binding: TaskDiffExternalContinuationBinding;
    replayMode?: TaskDiffReviewReplayMode;
    validation?: TaskDiffReviewConsumedReplayValidation;
  }): AuthenticatedExternalTaskDiffContinuation {
    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: input.current.review.subjectDigest,
      reviewRecordDigest: input.current.review.recordDigest,
      responseDigest: input.response.responseDigest,
    });
    if (
      input.binding.targetDigest !== targetDigest ||
      input.binding.subjectDigest !== input.current.review.subjectDigest ||
      input.binding.policyDigest !==
        input.current.review.subject.reviewPolicyDigest ||
      input.binding.reviewRecordDigest !== input.current.review.recordDigest ||
      input.binding.responseDigest !== input.response.responseDigest
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const reservation = requireExternalTaskDiffContinuationReservation(
      input.runtime,
      targetDigest,
      input.binding.grant.grantEnvelopeDigest,
    );
    if (reservation.reservationDigest !== input.binding.reservationDigest) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const storedResponse = readTaskDiffExternalChallengeResponse(
      input.runtime,
      input.current.review.subjectDigest,
      input.current.review.recordDigest,
      input.response.responseDigest,
    );
    const submission = readTaskDiffExternalClosureSubmission(
      input.runtime,
      targetDigest,
      input.binding.inputDigest,
    );
    if (
      storedResponse === null ||
      submission === null ||
      canonicalJson(storedResponse.response) !==
        canonicalJson(input.response) ||
      submission.subjectDigest !== input.current.review.subjectDigest ||
      submission.reviewRecordDigest !== input.current.review.recordDigest ||
      submission.responseDigest !== input.response.responseDigest
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const contentNode = readEvidenceNode(
      input.runtime,
      input.binding.contentNodeId,
    );
    assertExternalTaskDiffContinuationReservationContent(
      reservation,
      submission,
      contentNode,
    );
    const expectedContentNode =
      createExternalTaskDiffContinuationContentNode(submission);
    if (
      contentNode.resultDigest !== input.binding.contentResultDigest ||
      canonicalJson(contentNode) !== canonicalJson(expectedContentNode)
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const authorityNode = readEvidenceNode(
      input.runtime,
      input.binding.authorityNodeId,
    );
    if (
      !isExternalRecord(authorityNode.output) ||
      Object.keys(authorityNode.output).sort().join('\0') !== 'roleResult' ||
      !isExternalRecord(authorityNode.output.roleResult)
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const storedRoleResult = authorityNode.output
      .roleResult as AdmittedRoleResult;
    if (storedRoleResult.grantUse === null) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const grantUse = storedRoleResult.grantUse;
    const expectedBinding = bindingFromPayload(grantUse.envelope.payload);
    const policy = parseBaselineJson(
      input.context.git.repositoryRoot,
      input.current.review.subject.baseCommit,
      'workflow/maintainer-policy.json',
      parseMaintainerPolicy,
    );
    const expectedCore = externalTaskDiffContinuationGrantCore(
      input.context,
      input.current.review.subject,
      targetDigest,
      policy,
    );
    assertExternalTaskDiffGrantBinding(expectedCore, expectedBinding, grantUse);
    const assignment = grantUse.assignment as GrantedRoleAssignment;
    const consumedInspection = readCollaborationGrantInspection(
      input.context.git.gitCommonDirectory,
      input.binding.grant.grantId,
    );
    if (
      consumedInspection?.state !== 'consumed' ||
      consumedInspection.use === undefined ||
      canonicalJson(consumedInspection.use) !== canonicalJson(grantUse)
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const consumedUse = consumedInspection.use;
    const content = externalTaskDiffContinuationContentAdmission(
      contentNode,
      input.current.review.subject,
    );
    const roleResult =
      input.replayMode === 'inspect'
        ? storedRoleResult
        : admitConsumedRoleResultReplay({
            assignment,
            author: input.current.implementationActor,
            participant: storedRoleResult.participant,
            content,
            providerInvocation: null,
            replay: resolveConsumedRoleResultReplayPort(
              input.validation,
            ).verify({
              repositoryRoot: input.context.git.repositoryRoot,
              expectedBinding,
              grantUse: consumedUse,
              assignment,
              content,
              directHumanReviewAttestation:
                storedRoleResult.directHumanReviewAttestation,
            }),
          });
    if (input.replayMode === 'inspect') {
      assertStoredAdmittedRoleResultDigest(roleResult);
    }
    const expectedAuthorityNode =
      createExternalTaskDiffContinuationAuthorityNode({
        submission,
        contentNode,
        roleResult,
      });
    if (
      canonicalJson(roleResult) !== canonicalJson(storedRoleResult) ||
      input.binding.grantUseDigest !== sha256(canonicalJson(consumedUse)) ||
      input.binding.admittedRoleResultDigest !== roleResult.resultDigest ||
      input.binding.directHumanReviewAttestationDigest !==
        assignment.directHumanReviewAttestationDigest ||
      input.binding.grant.grantId !== consumedUse.grantId ||
      input.binding.grant.grantEnvelopeDigest !==
        consumedUse.signedEnvelopeDigest ||
      input.binding.grant.grantTransitionDigest !==
        consumedUse.transitionDigest ||
      input.binding.grant.grantTargetDigest !== consumedUse.targetDigest ||
      input.binding.grant.degradedForm !== consumedUse.degradedForm ||
      authorityNode.nodeId !== input.binding.authorityNodeId ||
      authorityNode.resultDigest !== input.binding.authorityResultDigest ||
      canonicalJson(authorityNode) !== canonicalJson(expectedAuthorityNode)
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    assertNoCompetingConsumedExternalTaskDiffContinuationAttempt(
      input.context,
      input.runtime,
      input.current.review.recordDigest,
      input.binding,
    );
    const authority = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
      stage: 'challenge-closure' as const,
      subjectDigest: input.current.review.subjectDigest,
      reviewRecordDigest: input.current.review.recordDigest,
      responseDigest: input.response.responseDigest,
      authorityNodeId: authorityNode.nodeId,
      authorityResultDigest: authorityNode.resultDigest,
      authority: Object.freeze({
        kind: 'grant-attributed-external-reviewer' as const,
        principalId: requiredPrincipalId(roleResult.participant),
        degradedForm: input.binding.grant.degradedForm,
        grantUseDigest: input.binding.grantUseDigest,
        policyDigest: input.current.review.subject.reviewPolicyDigest,
      }),
    });
    return Object.freeze({
      reservation,
      binding: input.binding,
      roleResult,
      authority,
      createdAt:
        grantUse.directHumanReviewAttestation?.payload.signedAt ??
        new Date(grantUse.envelope.payload.expiresAt).toISOString(),
    });
  }

  function assertNoCompetingConsumedExternalTaskDiffContinuationAttempt(
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    reviewRecordDigest: string,
    binding: TaskDiffExternalContinuationBinding,
  ): void {
    for (const attempt of listAllTaskDiffExternalContinuationReservations(
      runtime,
    ).filter(
      (reservation) => reservation.reviewRecordDigest === reviewRecordDigest,
    )) {
      const inspection = inspectExternalGrant(
        context.git.gitCommonDirectory,
        attempt.grant.grantId,
      );
      if (
        inspection.state === 'consumed' &&
        attempt.grant.grantEnvelopeDigest !== binding.grant.grantEnvelopeDigest
      ) {
        throw workflowError(
          'TASK_DIFF_EXTERNAL_CONTINUATION_COMPETING_AUTHORITY',
          'More than one external continuation grant was consumed for the exact challenge target.',
          ExitCode.guard,
        );
      }
    }
  }

  function ensureExternalTaskDiffFinalAssurance(input: {
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
    current: CurrentAuthenticatedTaskDiffReview;
    response: TaskDiffReviewChallengeResponseRecord;
    binding: TaskDiffExternalContinuationBinding;
    authenticatedClosure: AuthenticatedExternalTaskDiffContinuation;
  }): TaskDiffFinalAssuranceRecord {
    const existing = assertCurrentExternalTaskDiffFinalAssuranceBinding(input);
    if (existing !== null) return existing;
    const submission = readTaskDiffExternalClosureSubmission(
      input.runtime,
      input.binding.targetDigest,
      input.binding.inputDigest,
    );
    if (submission === null) throw externalTaskDiffAuthorityInvalid();
    const reviewerAuthority = input.authenticatedClosure.authority.authority;
    if (reviewerAuthority.kind !== 'grant-attributed-external-reviewer') {
      throw externalTaskDiffAuthorityInvalid();
    }
    const assurance = createTaskDiffFinalAssuranceRecord({
      subject: input.current.review.subject,
      review: input.current.review,
      response: input.response,
      submission: submission.submission,
      reviewerAuthority,
      exceptions: expectedExternalTaskDiffFinalAssuranceExceptions(
        input.current.review,
        reviewerAuthority,
      ),
      authenticatedReviewAuthority: input.current.authenticatedReviewAuthority,
      authenticatedChallengeClosureAuthority:
        input.authenticatedClosure.authority,
    });
    const reviewResultNode = readEvidenceNode(
      input.runtime,
      input.current.reviewResultNodeId,
    );
    const continuationResultNode = readEvidenceNode(
      input.runtime,
      input.binding.authorityNodeId,
    );
    if (
      reviewResultNode.resultDigest !== input.current.reviewResultDigest ||
      continuationResultNode.resultDigest !==
        input.binding.authorityResultDigest
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const assuranceNode = createEvidenceNode({
      type: 'task-diff-final-assurance',
      nodeSchema: 'workflow.task-diff-final-assurance.v1',
      evaluator: 'workflow-task-diff-review.v1',
      policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
      exactInputDigests: {
        authority: sha256(canonicalJson(reviewerAuthority)),
        closureAuthority: sha256(
          canonicalJson(input.authenticatedClosure.authority),
        ),
        response: input.response.responseDigest,
        review: input.current.review.recordDigest,
        reviewAuthority: sha256(
          canonicalJson(input.current.authenticatedReviewAuthority),
        ),
        subject: input.current.review.subjectDigest,
        submission: sha256(canonicalJson(submission.submission)),
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
    writeEvidenceNode(input.runtime, assuranceNode);
    createTaskDiffFinalAssuranceBinding(input.runtime, {
      subjectDigest: input.current.review.subjectDigest,
      assuranceNodeId: assuranceNode.nodeId,
      assuranceResultDigest: assuranceNode.resultDigest,
      assurance,
      createdAt: input.authenticatedClosure.createdAt,
    });
    return (
      assertCurrentExternalTaskDiffFinalAssuranceBinding(input) ??
      (() => {
        throw reviewNotSatisfied();
      })()
    );
  }

  function assertCurrentExternalTaskDiffFinalAssuranceBinding(input: {
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
    current: CurrentAuthenticatedTaskDiffReview;
    response: TaskDiffReviewChallengeResponseRecord;
    binding: TaskDiffExternalContinuationBinding;
    authenticatedClosure: AuthenticatedExternalTaskDiffContinuation;
  }): TaskDiffFinalAssuranceRecord | null {
    const binding = readTaskDiffFinalAssuranceBinding(
      input.runtime,
      input.current.review.subjectDigest,
    );
    if (binding === null) return null;
    const submission = readTaskDiffExternalClosureSubmission(
      input.runtime,
      input.binding.targetDigest,
      input.binding.inputDigest,
    );
    if (submission === null) throw externalTaskDiffAuthorityInvalid();
    const assurance = assertTaskDiffFinalAssuranceCurrent({
      subject: input.current.review.subject,
      review: input.current.review,
      response: input.response,
      assurance: binding.assurance,
      authenticatedReviewAuthority: input.current.authenticatedReviewAuthority,
      authenticatedChallengeClosureAuthority:
        input.authenticatedClosure.authority,
    });
    const assuranceNode = readEvidenceNode(
      input.runtime,
      binding.assuranceNodeId,
    );
    const reviewResultNode = readEvidenceNode(
      input.runtime,
      input.current.reviewResultNodeId,
    );
    const continuationResultNode = readEvidenceNode(
      input.runtime,
      input.binding.authorityNodeId,
    );
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
        sha256(canonicalJson(assurance.reviewerAuthority)) ||
      assuranceNode.exactInputDigests.closureAuthority !==
        sha256(canonicalJson(input.authenticatedClosure.authority)) ||
      assuranceNode.exactInputDigests.reviewAuthority !==
        sha256(canonicalJson(input.current.authenticatedReviewAuthority)) ||
      assuranceNode.exactInputDigests.response !==
        input.response.responseDigest ||
      assuranceNode.exactInputDigests.review !==
        input.current.review.recordDigest ||
      assuranceNode.exactInputDigests.subject !==
        input.current.review.subjectDigest ||
      assuranceNode.exactInputDigests.submission !==
        sha256(canonicalJson(submission.submission)) ||
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

  function expectedExternalTaskDiffFinalAssuranceExceptions(
    review: TaskDiffReviewRecord,
    reviewerAuthority: Extract<
      TaskDiffFinalAssuranceRecord['reviewerAuthority'],
      { kind: 'grant-attributed-external-reviewer' }
    >,
  ) {
    return [
      ...(review.assignment.degradedForm === null ||
      review.assignment.grantUseDigest === null
        ? []
        : [
            {
              kind: 'collaboration-grant-degradation' as const,
              stage: 'review' as const,
              grantUseDigest: review.assignment.grantUseDigest,
              degradedForm: review.assignment.degradedForm,
            },
          ]),
      {
        kind: 'collaboration-grant-degradation' as const,
        stage: 'challenge-closure' as const,
        grantUseDigest: reviewerAuthority.grantUseDigest,
        degradedForm: reviewerAuthority.degradedForm,
      },
    ];
  }
  return {
    loadAuthenticatedExternalTaskDiffTerminalAssurance,
    assertExternalTaskDiffContinuationInputCurrent,
    assertExternalTaskDiffContinuationProviderShortage,
    externalTaskDiffContinuationGrantCore,
    assertExternalTaskDiffContinuationAttemptMayProceed,
    assertExternalTaskDiffContinuationOrphanGrantMayProceed,
    requireExternalTaskDiffContinuationReservation,
    preflightExternalTaskDiffChallengeClosure,
    createExternalTaskDiffContinuationContentNode,
    externalTaskDiffContinuationContentAdmission,
    createExternalTaskDiffContinuationAuthorityNode,
    assertExternalTaskDiffContinuationReservationContent,
    renderExternalTaskDiffContinuationDirectHumanPause,
    externalTaskDiffContinuationGrantRequiredStatus,
    renderExternalTaskDiffContinuationSatisfied,
    assertCurrentExternalTaskDiffContinuationBinding,
    ensureExternalTaskDiffFinalAssurance,
  };
}
