/**
 * Reads and renders task diff review status without advancing the review
 * lifecycle.
 *
 * Invariants:
 * - Competing active external grants cannot be resolved by filename order.
 */
import type {
  TaskDiffReviewContinuationReservationRecord,
  TaskDiffReviewReservationRecord,
} from '../../modules/assurance/task-diff-review-binding-record.ts';
import {
  externalTaskDiffAuthorityInvalid,
  reviewNotSatisfied,
  taskDiffReviewLineageConflict,
} from '../../modules/assurance/task-diff-review-values.ts';

import type {
  TaskDiffExternalContinuationReservation,
  TaskDiffExternalReviewReservation,
} from '../../modules/assurance/task-diff-external-record.ts';
// Read and render the current review state without advancing its lifecycle.
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { assertTaskDiffReviewChallengeResponseCurrent } from '../../modules/assurance/task-diff-review-artifact.ts';
import type { TaskDiffReviewSubject } from '../../modules/assurance/task-diff-review-record.ts';
import type {
  CurrentAuthenticatedTaskDiffReview,
  TaskDiffReviewContinuationLifecycleStatus,
  TaskDiffReviewExternalContinuationLifecycleStatus,
  TaskDiffReviewInspectionStatus,
  TaskDiffReviewLifecycleStatus,
} from '../../modules/lifecycle/task-diff-review-contracts.ts';
import { type ProviderRoleAssignment } from '../../modules/provider-orchestration/role-assignment.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { loadActiveSessionContext } from '../repository-observation/workflow-session-context.ts';
import { readCollaborationGrantInspection } from '../storage-journal/collaboration-grant-records.ts';
import { readEvidenceNode } from '../storage-journal/evidence-object-store.ts';
import { readProviderInvocation } from '../storage-journal/provider-invocation-state.ts';
import {
  listAllTaskDiffExternalContinuationReservations,
  listTaskDiffExternalReviewBindings,
  listTaskDiffExternalReviewReservations,
  readTaskDiffExternalChallengeResponse,
  readTaskDiffExternalClosureSubmission,
  readTaskDiffExternalContinuationBinding,
  readTaskDiffExternalReviewBinding,
  readTaskDiffExternalReviewSubmission,
} from '../storage-journal/task-diff-review-external-store.ts';
import {
  listAllTaskDiffReviewReservations,
  listAllTaskDiffReviewResultBindings,
  readTaskDiffReviewContinuationReservation,
  readTaskDiffReviewContinuationResultBinding,
  readTaskDiffReviewReservation,
  readTaskDiffReviewResultBinding,
} from '../storage-journal/task-diff-review-store.ts';
import type { TaskDiffReviewCapabilities } from './task-diff-review-capabilities.ts';
import {
  assertCurrentExternalTaskDiffReviewBinding,
  assertHistoricalExternalTaskDiffReviewBinding,
  authenticatedExternalReviewAuthority,
  createExternalTaskDiffReviewContentNode,
  externalTaskDiffActorReplayOptions,
  inspectExternalTaskDiffOrphanGrant,
  renderExternalDirectHumanPause,
  renderExternalTaskDiffOrphanGrantStatus,
} from './task-diff-review-external-binding.ts';
import {
  createExternalTaskDiffContinuationContentNode,
  renderExternalTaskDiffContinuationDirectHumanPause,
} from './task-diff-review-external-continuation-binding.ts';
import {
  assertNoAllSessionProviderSourceCollision,
  authenticatedTaskDiffReviewFromLineageSource,
  loadReusedTaskDiffReview,
  readExactProviderTaskDiffReviewSource,
  resolveTaskDiffReviewCandidatePlan,
} from './task-diff-review-lineage.ts';
import {
  assertContinuationReservationBound,
  assertCurrentTaskDiffFinalAssuranceBinding,
  assertCurrentTaskDiffReviewBinding,
  assertCurrentTaskDiffReviewContinuationBinding,
  assertReservationCurrent,
} from './task-diff-review-provider-binding.ts';
import {
  assertTaskDiffReviewCandidateCurrent,
  inspectTaskDiffReviewSubject,
  resolveTaskDiffImplementationActor,
} from './task-diff-review-subject.ts';

export function inspectExternalTaskDiffPendingStatus(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    'changeContract' | 'resolveCurrentTaskStrategyCorrection'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
): TaskDiffReviewLifecycleStatus | null {
  const active = listTaskDiffExternalReviewReservations(
    runtime,
    subject.subjectDigest,
  ).flatMap((reservation) => {
    const grant = readCollaborationGrantInspection(
      context.git.gitCommonDirectory,
      reservation.grant.grantId,
    );
    if (grant === null || grant.state === 'available') {
      throw externalTaskDiffAuthorityInvalid();
    }
    if (
      grant.state === 'failed' ||
      grant.state === 'expired' ||
      grant.state === 'revoked'
    ) {
      return [];
    }
    validateExternalTaskDiffPendingAttempt(runtime, reservation, grant);
    return [{ reservation, grant }];
  });
  if (active.length === 0) return null;
  if (active.length !== 1) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_COMPETING_AUTHORITY',
      'Multiple active external TaskDiffReview grant attempts exist for the exact subject; status cannot select one by filename order.',
      ExitCode.guard,
    );
  }
  const { reservation, grant } = active[0]!;
  const currentActor = resolveTaskDiffImplementationActor(
    capabilities,
    context.git.repositoryRoot,
    context.session.sessionId,
    subject,
    externalTaskDiffActorReplayOptions(reservation.implementationActor),
  );
  if (
    canonicalJson(currentActor) !==
    canonicalJson(reservation.implementationActor)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  if (
    grant.state === 'reserved' &&
    reservation.grant.degradedForm === 'direct-human-review'
  ) {
    return renderExternalDirectHumanPause(
      context.session.sessionId,
      subject,
      reservation,
    );
  }
  if (grant.state !== 'reserved' && grant.state !== 'consumed') {
    throw externalTaskDiffAuthorityInvalid();
  }
  return Object.freeze({
    state: 'external-reconciliation-required' as const,
    source: 'external' as const,
    sessionId: context.session.sessionId,
    subject,
    implementationActor: currentActor,
    degradedForm: reservation.grant.degradedForm,
    grantState: grant.state,
    grantId: reservation.grant.grantId,
    grantEnvelopeDigest: reservation.grant.grantEnvelopeDigest,
    transitionDigest: reservation.grant.grantTransitionDigest,
    reservationDigest: reservation.reservationDigest,
    inputDigest: reservation.inputDigest,
    reviewScopeDigest: reservation.reviewScopeDigest,
    submissionRecordDigest: reservation.submissionRecordDigest,
    reviewNodeId: reservation.contentNodeId,
    reviewResultDigest: reservation.contentResultDigest,
  });
}

function validateExternalTaskDiffPendingAttempt(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffExternalReviewReservation,
  grant: NonNullable<ReturnType<typeof readCollaborationGrantInspection>>,
): void {
  const submission = readTaskDiffExternalReviewSubmission(
    runtime,
    reservation.subjectDigest,
    reservation.reviewScopeDigest,
    reservation.inputDigest,
  );
  if (
    submission === null ||
    submission.recordDigest !== reservation.submissionRecordDigest ||
    submission.inputDigest !== reservation.inputDigest ||
    grant.grantId !== reservation.grant.grantId ||
    grant.signedEnvelopeDigest !== reservation.grant.grantEnvelopeDigest ||
    grant.targetDigest !== reservation.grant.grantTargetDigest ||
    grant.degradedForm !== reservation.grant.degradedForm ||
    grant.transitionDigest !== reservation.grant.grantTransitionDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const contentNode = readEvidenceNode(runtime, reservation.contentNodeId);
  const expectedNode = createExternalTaskDiffReviewContentNode(
    submission,
    reservation.implementationActor,
  );
  if (
    contentNode.resultDigest !== reservation.contentResultDigest ||
    canonicalJson(contentNode) !== canonicalJson(expectedNode) ||
    (grant.state === 'consumed' &&
      (grant.use === undefined ||
        grant.use.signedEnvelopeDigest !==
          reservation.grant.grantEnvelopeDigest ||
        grant.use.transitionDigest !==
          reservation.grant.grantTransitionDigest ||
        grant.use.targetDigest !== reservation.grant.grantTargetDigest ||
        grant.use.degradedForm !== reservation.grant.degradedForm))
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
}

function inspectExternalTaskDiffContinuationPendingStatus(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  currentSubject: TaskDiffReviewSubject,
): TaskDiffReviewExternalContinuationLifecycleStatus | null {
  const active = listAllTaskDiffExternalContinuationReservations(runtime)
    .filter(
      (reservation) =>
        readTaskDiffExternalContinuationBinding(
          runtime,
          reservation.targetDigest,
        ) === null,
    )
    .flatMap((reservation) => {
      const grant = readCollaborationGrantInspection(
        context.git.gitCommonDirectory,
        reservation.grant.grantId,
      );
      if (grant === null || grant.state === 'available') {
        throw externalTaskDiffAuthorityInvalid();
      }
      if (
        grant.state === 'failed' ||
        grant.state === 'expired' ||
        grant.state === 'revoked'
      ) {
        return [];
      }
      return [{ reservation, grant }];
    });
  if (active.length === 0) return null;
  if (active.length !== 1) throw taskDiffReviewLineageConflict();
  const { reservation, grant } = active[0]!;
  const current = loadStructuralTaskDiffReviewForContinuation(
    capabilities,
    context,
    runtime,
    currentSubject,
    reservation,
  );
  const storedResponse = readTaskDiffExternalChallengeResponse(
    runtime,
    reservation.subjectDigest,
    reservation.reviewRecordDigest,
    reservation.responseDigest,
  );
  if (storedResponse === null) throw externalTaskDiffAuthorityInvalid();
  const response = assertTaskDiffReviewChallengeResponseCurrent(
    current.review,
    storedResponse.response,
  );
  const submission = readTaskDiffExternalClosureSubmission(
    runtime,
    reservation.targetDigest,
    reservation.inputDigest,
  );
  if (
    submission === null ||
    submission.subjectDigest !== reservation.subjectDigest ||
    submission.reviewRecordDigest !== reservation.reviewRecordDigest ||
    submission.responseDigest !== reservation.responseDigest ||
    submission.targetDigest !== reservation.targetDigest ||
    grant.grantId !== reservation.grant.grantId ||
    grant.signedEnvelopeDigest !== reservation.grant.grantEnvelopeDigest ||
    grant.targetDigest !== reservation.grant.grantTargetDigest ||
    grant.degradedForm !== reservation.grant.degradedForm ||
    grant.transitionDigest !== reservation.grant.grantTransitionDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const contentNode = readEvidenceNode(runtime, reservation.contentNodeId);
  const expectedContentNode =
    createExternalTaskDiffContinuationContentNode(submission);
  if (
    contentNode.resultDigest !== reservation.contentResultDigest ||
    canonicalJson(contentNode) !== canonicalJson(expectedContentNode) ||
    (grant.state === 'consumed' &&
      (grant.use === undefined ||
        grant.use.signedEnvelopeDigest !==
          reservation.grant.grantEnvelopeDigest ||
        grant.use.transitionDigest !==
          reservation.grant.grantTransitionDigest ||
        grant.use.targetDigest !== reservation.grant.grantTargetDigest ||
        grant.use.degradedForm !== reservation.grant.degradedForm ||
        grant.use.structuredContent.nodeId !== reservation.contentNodeId ||
        grant.use.structuredContent.resultDigest !==
          reservation.contentResultDigest))
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  if (
    grant.state === 'reserved' &&
    reservation.grant.degradedForm === 'direct-human-review'
  ) {
    return renderExternalTaskDiffContinuationDirectHumanPause(
      context.session.sessionId,
      current,
      response,
      reservation,
    );
  }
  if (grant.state !== 'reserved' && grant.state !== 'consumed') {
    throw externalTaskDiffAuthorityInvalid();
  }
  return Object.freeze({
    state: 'external-reconciliation-required' as const,
    source: 'external-continuation' as const,
    sessionId: context.session.sessionId,
    subject: current.subject,
    implementationActor: current.implementationActor,
    review: current.review,
    response,
    degradedForm: reservation.grant.degradedForm,
    grantState: grant.state,
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

function loadStructuralTaskDiffReviewForContinuation(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  currentSubject: TaskDiffReviewSubject,
  continuation: TaskDiffExternalContinuationReservation,
): CurrentAuthenticatedTaskDiffReview {
  const externalBindings = listTaskDiffExternalReviewBindings(runtime).filter(
    (binding) => binding.reviewRecordDigest === continuation.reviewRecordDigest,
  );
  const providerBindings = listAllTaskDiffReviewResultBindings(runtime).filter(
    (binding) =>
      binding.review.recordDigest === continuation.reviewRecordDigest,
  );
  if (externalBindings.length + providerBindings.length !== 1) {
    throw taskDiffReviewLineageConflict();
  }
  if (externalBindings[0] !== undefined) {
    const historical = assertHistoricalExternalTaskDiffReviewBinding(
      capabilities,
      context,
      runtime,
      externalBindings[0],
      undefined,
      'inspect',
    );
    assertTaskDiffReviewCandidateCurrent(currentSubject, historical.review);
    if (
      continuation.subjectDigest !== historical.review.subjectDigest ||
      canonicalJson(continuation.subject) !==
        canonicalJson(historical.review.subject)
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    return Object.freeze({
      source: 'external' as const,
      subject: currentSubject,
      review: historical.review,
      implementationActor: historical.implementationActor,
      authenticatedReviewAuthority:
        authenticatedExternalReviewAuthority(historical),
      reviewResultNodeId: historical.binding.authorityNodeId,
      reviewResultDigest: historical.binding.authorityResultDigest,
    });
  }
  const providerBinding = providerBindings[0]!;
  const reservations = listAllTaskDiffReviewReservations(runtime).filter(
    (reservation) =>
      reservation.sessionId === providerBinding.sessionId &&
      reservation.subject.subjectDigest === providerBinding.subjectDigest,
  );
  if (reservations.length !== 1) throw taskDiffReviewLineageConflict();
  const reservation = reservations[0]!;
  assertCurrentTaskDiffReviewBinding(
    capabilities,
    runtime,
    reservation,
    providerBinding.review,
    'inspect',
  );
  assertTaskDiffReviewCandidateCurrent(currentSubject, providerBinding.review);
  if (
    continuation.subjectDigest !== providerBinding.review.subjectDigest ||
    canonicalJson(continuation.subject) !==
      canonicalJson(providerBinding.review.subject)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const providerId = providerBinding.review.assignment.reviewerProviderId;
  if (providerId === null) throw externalTaskDiffAuthorityInvalid();
  return Object.freeze({
    source: 'provider' as const,
    subject: currentSubject,
    review: providerBinding.review,
    implementationActor: reservation.implementationActor,
    authenticatedReviewAuthority: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
      stage: 'review' as const,
      subjectDigest: providerBinding.review.subjectDigest,
      reviewRecordDigest: providerBinding.review.recordDigest,
      responseDigest: null,
      authorityNodeId: providerBinding.providerResultNodeId,
      authorityResultDigest: providerBinding.providerResultDigest,
      authority: Object.freeze({
        kind: 'engine-attributed-provider-reviewer' as const,
        principalId: providerBinding.review.assignment.reviewerPrincipalId,
        providerId,
        policyDigest: providerBinding.review.subject.reviewPolicyDigest,
      }),
    }),
    reviewResultNodeId: providerBinding.providerResultNodeId,
    reviewResultDigest: providerBinding.providerResultDigest,
  });
}

export function inspectTaskDiffReviewStatus(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'changeContract'
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'externalContinuationBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
    | 'resolveCurrentTaskStrategyCorrection'
  >,
  cwd: string,
  requestedSessionId: string,
): TaskDiffReviewInspectionStatus {
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const subject = inspectTaskDiffReviewSubject(
    capabilities,
    cwd,
    requestedSessionId,
  );
  if (!subject.reviewRequirement.required) {
    return Object.freeze({
      state: 'not-required' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const externalContinuationPending =
    inspectExternalTaskDiffContinuationPendingStatus(
      capabilities,
      context,
      runtime,
      subject,
    );
  if (externalContinuationPending !== null) {
    return externalContinuationPending;
  }
  const providerSource = readExactProviderTaskDiffReviewSource(
    runtime,
    context.session.sessionId,
    subject.subjectDigest,
  );
  const reservation = providerSource.reservation;
  const externalBinding = readTaskDiffExternalReviewBinding(
    runtime,
    subject.subjectDigest,
  );
  if (externalBinding !== null) {
    assertNoAllSessionProviderSourceCollision(runtime, subject.subjectDigest);
    if (reservation !== null || providerSource.binding !== null)
      throw taskDiffReviewLineageConflict();
    assertCurrentExternalTaskDiffReviewBinding(
      capabilities,
      context,
      runtime,
      subject,
      externalBinding,
      undefined,
      'inspect',
    );
    const candidatePlan = resolveTaskDiffReviewCandidatePlan(
      capabilities,
      context,
      runtime,
      subject,
      'inspect',
    );
    if (candidatePlan.action !== 'reuse') {
      throw taskDiffReviewLineageConflict();
    }
    return renderInspectedReusedTaskDiffReviewStatus(
      capabilities,
      runtime,
      context.session.sessionId,
      subject,
      loadReusedTaskDiffReview(
        capabilities,
        runtime,
        context,
        subject,
        candidatePlan,
        'inspect',
      ),
    );
  }
  const externalPending = inspectExternalTaskDiffPendingStatus(
    capabilities,
    context,
    runtime,
    subject,
  );
  if (externalPending !== null) {
    assertNoAllSessionProviderSourceCollision(runtime, subject.subjectDigest);
    if (reservation !== null || providerSource.binding !== null)
      throw taskDiffReviewLineageConflict();
    return externalPending;
  }
  const orphanExternalGrant = inspectExternalTaskDiffOrphanGrant(
    context,
    runtime,
    subject,
  );
  if (orphanExternalGrant !== null) {
    assertNoAllSessionProviderSourceCollision(runtime, subject.subjectDigest);
    if (reservation !== null || providerSource.binding !== null)
      throw taskDiffReviewLineageConflict();
    return renderExternalTaskDiffOrphanGrantStatus(
      context,
      subject,
      orphanExternalGrant,
    );
  }
  if (reservation === null) {
    const candidatePlan = resolveTaskDiffReviewCandidatePlan(
      capabilities,
      context,
      runtime,
      subject,
      'inspect',
    );
    if (candidatePlan.action === 'reuse') {
      return renderInspectedReusedTaskDiffReviewStatus(
        capabilities,
        runtime,
        context.session.sessionId,
        subject,
        loadReusedTaskDiffReview(
          capabilities,
          runtime,
          context,
          subject,
          candidatePlan,
          'inspect',
        ),
      );
    }
    return Object.freeze({
      state: 'ready' as const,
      sessionId: context.session.sessionId,
      subject,
    });
  }
  if (providerSource.binding !== null) {
    const candidatePlan = resolveTaskDiffReviewCandidatePlan(
      capabilities,
      context,
      runtime,
      subject,
      'inspect',
    );
    if (candidatePlan.action !== 'reuse') {
      throw taskDiffReviewLineageConflict();
    }
    const current = loadReusedTaskDiffReview(
      capabilities,
      runtime,
      context,
      subject,
      candidatePlan,
      'inspect',
    );
    const continuationReservation = readTaskDiffReviewContinuationReservation(
      runtime,
      context.session.sessionId,
      providerSource.binding.review.recordDigest,
    );
    if (continuationReservation !== null) {
      assertContinuationReservationBound(
        reservation,
        providerSource.binding.review,
        continuationReservation.response,
        continuationReservation,
      );
      return renderTaskDiffReviewContinuationStatus(
        capabilities,
        runtime,
        continuationReservation,
      );
    }
    return renderInspectedReusedTaskDiffReviewStatus(
      capabilities,
      runtime,
      context.session.sessionId,
      subject,
      current,
    );
  }
  assertReservationCurrent(
    context,
    subject,
    reservation.implementationActor,
    reservation,
  );
  return renderTaskDiffReviewStatus(capabilities, runtime, reservation);
}

export function renderReusedTaskDiffReviewStatus(
  currentSessionId: string,
  currentSubject: TaskDiffReviewSubject,
  current: ReturnType<typeof loadReusedTaskDiffReview>,
): TaskDiffReviewLifecycleStatus {
  const state =
    current.terminal.state === 'challenge-open'
      ? current.terminal.closureSource === null
        ? ('challenge-response-required' as const)
        : ('challenge-closure-required' as const)
      : current.terminal.state;
  if (current.source === 'external') {
    return Object.freeze({
      state,
      source: 'external' as const,
      sessionId: currentSessionId,
      subject: currentSubject,
      implementationActor: current.current.implementationActor,
      assignment: current.current.assignment,
      review: current.review,
      finalAssurance: current.terminal.finalAssurance,
    });
  }
  return Object.freeze({
    state,
    sessionId: currentSessionId,
    subject: currentSubject,
    implementationActor: current.reservation.implementationActor,
    assignment: current.reservation.request
      .roleAssignment as ProviderRoleAssignment,
    ownerInvestigationId: current.reservation.ownerInvestigationId,
    invocationId: current.reservation.request.invocationId,
    review: current.review,
    finalAssurance: current.terminal.finalAssurance,
  });
}

function renderInspectedReusedTaskDiffReviewStatus(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  currentSessionId: string,
  currentSubject: TaskDiffReviewSubject,
  current: ReturnType<typeof loadReusedTaskDiffReview>,
): TaskDiffReviewInspectionStatus {
  if (
    current.source === 'provider' &&
    current.terminal.state === 'challenge-open' &&
    current.terminal.closureSource === 'provider'
  ) {
    const continuation = readTaskDiffReviewContinuationReservation(
      runtime,
      current.reservation.sessionId,
      current.review.recordDigest,
    );
    if (continuation === null) throw taskDiffReviewLineageConflict();
    assertContinuationReservationBound(
      current.reservation,
      current.review,
      continuation.response,
      continuation,
    );
    return renderTaskDiffReviewContinuationStatus(
      capabilities,
      runtime,
      continuation,
    );
  }
  return renderReusedTaskDiffReviewStatus(
    currentSessionId,
    currentSubject,
    current,
  );
}

export function renderTaskDiffReviewStatus(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewReservationRecord,
): TaskDiffReviewInspectionStatus {
  const assignment = reservation.request
    .roleAssignment as ProviderRoleAssignment;
  const common = {
    sessionId: reservation.sessionId,
    subject: reservation.subject,
    implementationActor: reservation.implementationActor,
    assignment,
    ownerInvestigationId: reservation.ownerInvestigationId,
    invocationId: reservation.request.invocationId,
  };
  const binding = readTaskDiffReviewResultBinding(
    runtime,
    reservation.sessionId,
    reservation.subject.subjectDigest,
  );
  if (binding !== null) {
    assertCurrentTaskDiffReviewBinding(
      capabilities,
      runtime,
      reservation,
      binding.review,
      'inspect',
    );
    if (binding.review.challenges.length === 0) {
      return Object.freeze({
        state: 'satisfied',
        ...common,
        review: binding.review,
        finalAssurance: null,
      });
    }
    const continuationReservation = readTaskDiffReviewContinuationReservation(
      runtime,
      reservation.sessionId,
      binding.review.recordDigest,
    );
    if (continuationReservation === null) {
      return Object.freeze({
        state: 'challenge-response-required',
        ...common,
        review: binding.review,
        finalAssurance: null,
      });
    }
    assertContinuationReservationBound(
      reservation,
      binding.review,
      continuationReservation.response,
      continuationReservation,
    );
    return renderTaskDiffReviewContinuationStatus(
      capabilities,
      runtime,
      continuationReservation,
    );
  }
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  if (invocation.state === 'failed') {
    if (invocation.failure === null) throw reviewNotSatisfied();
    return Object.freeze({
      state: 'provider-failed',
      ...common,
      failure: invocation.failure,
    });
  }
  return Object.freeze({
    state:
      invocation.state === 'succeeded'
        ? 'provider-succeeded-awaiting-reconciliation'
        : 'waiting-for-provider',
    ...common,
  });
}

export function renderTaskDiffReviewContinuationStatus(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: TaskDiffReviewContinuationReservationRecord,
  authenticatedCurrent?: CurrentAuthenticatedTaskDiffReview,
): TaskDiffReviewContinuationLifecycleStatus {
  const assignment = reservation.request
    .roleAssignment as ProviderRoleAssignment;
  const common = {
    sessionId: reservation.sessionId,
    subject: reservation.subject,
    implementationActor: reservation.implementationActor,
    assignment,
    ownerInvestigationId: reservation.ownerInvestigationId,
    invocationId: reservation.request.invocationId,
    review: reservation.review,
    response: reservation.response,
  };
  const binding = readTaskDiffReviewContinuationResultBinding(
    runtime,
    reservation.sessionId,
    reservation.review.recordDigest,
  );
  if (binding !== null) {
    assertCurrentTaskDiffReviewContinuationBinding(
      runtime,
      reservation,
      binding.submission,
    );
    const current =
      authenticatedCurrent ??
      authenticatedProviderTaskDiffReviewForContinuationStatus(
        capabilities,
        runtime,
        reservation,
      );
    const finalAssurance = assertCurrentTaskDiffFinalAssuranceBinding(
      runtime,
      current,
      reservation,
      binding,
    );
    return Object.freeze({
      state:
        finalAssurance === null
          ? 'challenge-closure-required'
          : finalAssurance.verdict,
      ...common,
      finalAssurance,
      failure: null,
    });
  }
  const invocation = readProviderInvocation(
    runtime,
    reservation.request.invocationId,
  );
  if (invocation.state === 'failed') {
    if (invocation.failure === null) throw reviewNotSatisfied();
    return Object.freeze({
      state: 'provider-failed',
      ...common,
      finalAssurance: null,
      failure: invocation.failure,
    });
  }
  return Object.freeze({
    state:
      invocation.state === 'succeeded'
        ? 'provider-succeeded-awaiting-reconciliation'
        : 'waiting-for-provider',
    ...common,
    finalAssurance: null,
    failure: null,
  });
}

function authenticatedProviderTaskDiffReviewForContinuationStatus(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'providerBindingAdmitConsumedRoleResultReplay'
    | 'providerBindingAdmitRoleResult'
    | 'providerBindingCanonicalCollaborationGrantEnvelope'
    | 'providerBindingParseCollaborationGrantEnvelope'
  >,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  continuation: TaskDiffReviewContinuationReservationRecord,
): CurrentAuthenticatedTaskDiffReview {
  const matches = listAllTaskDiffReviewResultBindings(runtime).filter(
    (binding) =>
      binding.review.recordDigest === continuation.review.recordDigest,
  );
  if (matches.length !== 1) throw reviewNotSatisfied();
  const binding = matches[0]!;
  const reservation = readTaskDiffReviewReservation(
    runtime,
    binding.sessionId,
    binding.subjectDigest,
  );
  if (reservation === null) throw reviewNotSatisfied();
  assertCurrentTaskDiffReviewBinding(
    capabilities,
    runtime,
    reservation,
    binding.review,
    'inspect',
  );
  return authenticatedTaskDiffReviewFromLineageSource({
    source: 'provider',
    subject: binding.review.subject,
    reviewRecordDigest: binding.review.recordDigest,
    reviewScope: binding.review.reviewScope,
    finalAssuranceCommitmentDigest: null,
    provider: Object.freeze({ reservation, binding }),
  });
}
