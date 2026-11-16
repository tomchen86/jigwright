import type {
  TaskDiffExternalReviewBinding,
  TaskDiffExternalReviewReservation,
} from '../../modules/assurance/task-diff-external-record.ts';
import { sha256 } from '../../modules/assurance/task-diff-review-binding-record.ts';
import {
  assertStoredAdmittedRoleResultDigest,
  collaborationTransitionDigest,
  externalTaskDiffAuthorityInvalid,
  isExternalRecord,
  resolveConsumedRoleResultReplayPort,
  type TaskDiffReviewConsumedReplayValidation,
} from '../../modules/assurance/task-diff-review-values.ts';
/**
 * Authenticates initial external task diff reviews and their recorded grant
 * use.
 *
 * Invariants:
 * - External review grant use must match its target, transition, and signed
 *   envelope.
 */
// Authenticate stored initial external reviews and replay their exact grant use.
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  TaskDiffAuthenticatedReviewerAuthority,
  TaskDiffReviewRecord,
} from '../../modules/assurance/task-diff-review-artifact-record.ts';
import {
  createTaskDiffReviewRecord,
  parseTaskDiffReviewRecord,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import { type TaskDiffReviewExternalSubmissionInput } from '../../modules/assurance/task-diff-review-input.ts';
import type {
  TaskDiffReviewCandidatePlan,
  TaskDiffReviewSubject,
} from '../../modules/assurance/task-diff-review-record.ts';
import {
  bindingFromPayload,
  type CollaborationGrantExpectedBinding,
  collaborationPolicyDigestForPhase,
} from '../../modules/authority/collaboration-grant-codec.ts';
import type { CollaborationGrantSelectionCoreBinding } from '../../modules/authority/collaboration-grant-records.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type {
  BeginTaskDiffReviewOptions,
  CurrentExternalTaskDiffReview,
  TaskDiffReviewCollaborationGrantRequiredStatus,
  TaskDiffReviewLifecycleStatus,
} from '../../modules/lifecycle/task-diff-review-contracts.ts';
import { type AdmittedRoleResult } from '../../modules/provider-orchestration/role-admission-contracts.ts';
import {
  type GrantedRoleAssignment,
  type RecordedRoleParticipant,
  type RoleParticipant,
} from '../../modules/provider-orchestration/role-assignment.ts';
import { resolveBlobOid } from '../repository-transaction/git-object-ids.ts';

import type { CollaborationGrantUseProjection } from '../../modules/authority/collaboration-grant-records.ts';

import { createEvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { loadActiveSessionContext } from '../repository-observation/workflow-session-context.ts';
import {
  listCollaborationGrantInspections,
  readCollaborationGrantInspection,
} from '../storage-journal/collaboration-grant-records.ts';
import { readEvidenceNode } from '../storage-journal/evidence-object-store.ts';
import {
  createTaskDiffExternalReviewSubmission,
  listTaskDiffExternalReviewReservations,
  readTaskDiffExternalReviewReservation,
  readTaskDiffExternalReviewSubmission,
} from '../storage-journal/task-diff-review-external-store.ts';
import type { TaskDiffReviewCapabilities } from './task-diff-review-capabilities.ts';
import {
  baselineAdapterPolicy,
  parseBaselineJson,
} from './task-diff-review-context.ts';
import { resolveTaskDiffImplementationActor } from './task-diff-review-subject.ts';

export function createExternalTaskDiffReviewContentNode(
  submission: ReturnType<typeof createTaskDiffExternalReviewSubmission>,
  implementationActor: RecordedRoleParticipant,
) {
  return createEvidenceNode({
    type: 'task-diff-review-external-submission',
    nodeSchema: 'workflow.task-diff-review-external-submission.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: submission.subject.reviewPolicyDigest,
    exactInputDigests: {
      actor: sha256(canonicalJson(implementationActor)),
      input: submission.inputDigest,
      scope: submission.reviewScopeDigest,
      submission: submission.recordDigest,
      subject: submission.subjectDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.task-diff-review-external-submission-output.v1',
    output: { implementationActor, submission },
    runtimeMetadata: {},
  });
}

export function preflightExternalTaskDiffReviewSubmission(
  sessionId: string,
  implementationActor: RecordedRoleParticipant,
  subject: TaskDiffReviewSubject,
  reviewScope: Extract<
    TaskDiffReviewCandidatePlan,
    { action: 'review' }
  >['scope'],
  submission: TaskDiffReviewExternalSubmissionInput['submission'],
  inputDigest: string,
): void {
  createTaskDiffReviewRecord({
    subject,
    reviewScope,
    assignment: {
      implementerPrincipalId: requiredPrincipalId(implementationActor),
      implementerProviderId: implementationActor.providerId,
      implementationSessionId: sessionId,
      reviewerPrincipalId: `external-preflight:${inputDigest}`,
      reviewerProviderId: null,
      reviewerSessionId: null,
      achievedIndependence: 'none',
      degradedForm: 'caller-supplied',
      grantUseDigest: '0'.repeat(64),
    },
    submission,
  });
}

export function preflightExternalTaskDiffReviewerIdentity(
  sessionId: string,
  implementationActor: RecordedRoleParticipant,
  expectedBinding: CollaborationGrantExpectedBinding,
  subject: TaskDiffReviewSubject,
  reviewScope: Extract<
    TaskDiffReviewCandidatePlan,
    { action: 'review' }
  >['scope'],
  submission: TaskDiffReviewExternalSubmissionInput['submission'],
): void {
  const participant = externalParticipantFromGrant(expectedBinding);
  if (participant.principalId === undefined) {
    throw externalTaskDiffAuthorityInvalid();
  }
  createTaskDiffReviewRecord({
    subject,
    reviewScope,
    assignment: {
      implementerPrincipalId: requiredPrincipalId(implementationActor),
      implementerProviderId: implementationActor.providerId,
      implementationSessionId: sessionId,
      reviewerPrincipalId: participant.principalId,
      reviewerProviderId: null,
      reviewerSessionId: null,
      achievedIndependence: 'none',
      degradedForm: expectedBinding.degradedForm as
        'caller-supplied' | 'direct-human-review',
      grantUseDigest: '0'.repeat(64),
    },
    submission,
  });
}

export function createExternalTaskDiffReviewAuthorityNode(input: {
  sessionId: string;
  implementationActor: RecordedRoleParticipant;
  submission: ReturnType<typeof createTaskDiffExternalReviewSubmission>;
  contentNode: ReturnType<typeof createEvidenceNode>;
  roleResult: AdmittedRoleResult;
  review: TaskDiffReviewRecord;
}) {
  return createEvidenceNode({
    type: 'task-diff-review-external-authority-result',
    nodeSchema: 'workflow.task-diff-review-external-authority-result.v1',
    evaluator: 'workflow-task-diff-review.v1',
    policyDigest: input.submission.subject.reviewPolicyDigest,
    exactInputDigests: {
      admission: input.roleResult.resultDigest,
      content: input.contentNode.resultDigest,
      review: input.review.recordDigest,
      scope: input.submission.reviewScopeDigest,
      subject: input.submission.subjectDigest,
    },
    semanticParentResultDigests: {
      content: input.contentNode.resultDigest,
    },
    provenanceParentNodeIds: { content: input.contentNode.nodeId },
    outputSchema:
      'workflow.task-diff-review-external-authority-result-output.v1',
    output: {
      sessionId: input.sessionId,
      implementationActor: input.implementationActor,
      roleResult: input.roleResult,
      review: input.review,
    },
    runtimeMetadata: {},
  });
}

export function externalTaskDiffContentAdmission(
  contentNode: ReturnType<typeof createEvidenceNode>,
  subject: TaskDiffReviewSubject,
) {
  return {
    kind: 'task-diff-review' as const,
    nodeId: contentNode.nodeId,
    resultDigest: contentNode.resultDigest,
    outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    evaluator: 'task-diff-review.v1',
    policyDigest: subject.reviewPolicyDigest,
    contentDigest: contentNode.resultDigest,
    current: true as const,
  };
}

export function externalTaskDiffGrantCore(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskDiffReviewSubject,
  policy: ReturnType<typeof parseMaintainerPolicy>,
): CollaborationGrantSelectionCoreBinding {
  return externalTaskDiffGrantCoreForSubject(
    context.git.repositoryRoot,
    subject,
    policy,
  );
}

function externalTaskDiffGrantCoreForSubject(
  repositoryRoot: string,
  subject: TaskDiffReviewSubject,
  policy: ReturnType<typeof parseMaintainerPolicy>,
): CollaborationGrantSelectionCoreBinding {
  return {
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob: resolveBlobOid(
      repositoryRoot,
      subject.baseCommit,
      'workflow/maintainer-policy.json',
    ),
    collaborationPolicyDigest:
      collaborationPolicyDigestForPhase('task-diff-review'),
    changeId: subject.changeId,
    taskId: subject.taskId,
    baselineCommit: subject.baseCommit,
    baselineTree: subject.baseTree,
    targetDigest: subject.subjectDigest,
    lifecyclePhase: 'task-diff-review',
    rolePair: {
      authorRole: 'task-implementer',
      conflictingRole: 'task-diff-reviewer',
    },
  };
}

export function assertExternalTaskDiffGrantBinding(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    'externalBindingCollaborationGrantEnvelopeDigest'
  >,
  expectedCore: CollaborationGrantSelectionCoreBinding,
  expectedBinding: CollaborationGrantExpectedBinding,
  use: CollaborationGrantUseProjection,
): void {
  const {
    externalBindingCollaborationGrantEnvelopeDigest:
      collaborationGrantEnvelopeDigest,
  } = capabilities;

  const actualCore: CollaborationGrantSelectionCoreBinding = {
    repositoryId: expectedBinding.repositoryId,
    repositoryOrigin: expectedBinding.repositoryOrigin,
    policyBlob: expectedBinding.policyBlob,
    collaborationPolicyDigest: expectedBinding.collaborationPolicyDigest,
    changeId: expectedBinding.changeId,
    taskId: expectedBinding.taskId,
    baselineCommit: expectedBinding.baselineCommit,
    baselineTree: expectedBinding.baselineTree,
    targetDigest: expectedBinding.targetDigest,
    lifecyclePhase: expectedBinding.lifecyclePhase,
    rolePair: expectedBinding.rolePair,
  };
  if (
    canonicalJson(actualCore) !== canonicalJson(expectedCore) ||
    (expectedBinding.degradedForm !== 'caller-supplied' &&
      expectedBinding.degradedForm !== 'direct-human-review') ||
    use.targetDigest !== expectedCore.targetDigest ||
    use.transitionDigest !== collaborationTransitionDigest(expectedBinding) ||
    use.signedEnvelopeDigest !== collaborationGrantEnvelopeDigest(use.envelope)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
}

export function externalParticipantFromGrant(
  expectedBinding: CollaborationGrantExpectedBinding,
): RoleParticipant {
  const actor = expectedBinding.availableActor;
  if (
    expectedBinding.degradedForm === 'caller-supplied' &&
    actor.kind === 'caller'
  ) {
    return {
      providerId: undefined,
      sessionId: undefined,
      principalId: actor.callerId,
      identityAssurance: actor.assurance,
      engineSpawned: false,
    };
  }
  if (
    expectedBinding.degradedForm === 'direct-human-review' &&
    actor.kind === 'direct-human'
  ) {
    return {
      providerId: undefined,
      sessionId: undefined,
      principalId: actor.identity,
      identityAssurance: 'adapter-assigned',
      engineSpawned: false,
    };
  }
  throw externalTaskDiffAuthorityInvalid();
}

export function roleParticipantFromRecorded(
  participant: RecordedRoleParticipant,
): RoleParticipant {
  if (participant.identityAssurance === 'maintainer-signed') {
    throw externalTaskDiffAuthorityInvalid();
  }
  return {
    providerId: participant.providerId ?? undefined,
    sessionId: participant.sessionId ?? undefined,
    principalId: participant.principalId ?? undefined,
    identityAssurance: participant.identityAssurance,
    engineSpawned: participant.engineSpawned,
  };
}

export function externalTaskDiffActorReplayOptions(
  actor: RecordedRoleParticipant,
): BeginTaskDiffReviewOptions {
  if (actor.providerId === null) {
    if (actor.identityAssurance === 'maintainer-signed') {
      throw externalTaskDiffAuthorityInvalid();
    }
    return { environment: {} };
  }
  if (actor.identityAssurance === 'self-declared') {
    return { explicitActor: actor.providerId, environment: {} };
  }
  if (actor.identityAssurance === 'runtime-hint') {
    return { environment: { AGENT: actor.providerId } };
  }
  if (actor.identityAssurance === 'adapter-assigned') {
    return { environment: {} };
  }
  throw externalTaskDiffAuthorityInvalid();
}

export function requiredPrincipalId(
  participant: RecordedRoleParticipant,
): string {
  if (participant.principalId === null)
    throw externalTaskDiffAuthorityInvalid();
  return participant.principalId;
}

export function externalTaskDiffReviewAssignment(
  sessionId: string,
  implementationActor: RecordedRoleParticipant,
  assignment: GrantedRoleAssignment,
  grantUseDigest: string,
) {
  if (
    assignment.degradedForm !== 'caller-supplied' &&
    assignment.degradedForm !== 'direct-human-review'
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return {
    implementerPrincipalId: requiredPrincipalId(implementationActor),
    implementerProviderId: implementationActor.providerId,
    implementationSessionId: sessionId,
    reviewerPrincipalId: requiredPrincipalId(assignment.participant),
    reviewerProviderId: null,
    reviewerSessionId: null,
    achievedIndependence: 'none' as const,
    degradedForm: assignment.degradedForm,
    grantUseDigest,
  };
}

export function assertExternalTaskDiffAttemptMayProceed(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subjectDigest: string,
  requestedGrantId: string,
  implementationActor: RecordedRoleParticipant,
): void {
  for (const attempt of listTaskDiffExternalReviewReservations(
    runtime,
    subjectDigest,
  )) {
    if (
      canonicalJson(attempt.implementationActor) !==
      canonicalJson(implementationActor)
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const inspection = inspectExternalGrant(
      context.git.gitCommonDirectory,
      attempt.grant.grantId,
    );
    if (
      attempt.grant.grantId !== requestedGrantId &&
      (inspection.state === 'reserved' || inspection.state === 'consumed')
    ) {
      throw workflowError(
        'TASK_DIFF_EXTERNAL_REVIEW_ATTEMPT_ACTIVE',
        'Another exact external TaskDiffReview grant attempt is reserved or consumed without a canonical binding; resume that signed envelope before selecting a replacement.',
        ExitCode.conflict,
      );
    }
  }
}

export function assertExternalTaskDiffOrphanGrantMayProceed(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  requestedGrantId: string,
): void {
  const orphan = inspectExternalTaskDiffOrphanGrant(context, runtime, subject);
  if (orphan !== null && orphan.grantId !== requestedGrantId) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_ATTEMPT_ACTIVE',
      'An exact external TaskDiffReview grant was reserved before its attempt record was published; resume that grant before selecting a replacement.',
      ExitCode.conflict,
    );
  }
}

export function inspectExternalTaskDiffOrphanGrant(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
) {
  const attemptGrantIds = new Set(
    listTaskDiffExternalReviewReservations(runtime, subject.subjectDigest).map(
      (reservation) => reservation.grant.grantId,
    ),
  );
  const matches = listCollaborationGrantInspections(
    context.git.gitCommonDirectory,
  ).filter(
    (grant) =>
      grant.state === 'reserved' &&
      grant.changeId === context.session.changeId &&
      grant.taskId === context.session.taskId &&
      grant.lifecyclePhase === 'task-diff-review' &&
      grant.targetDigest === subject.subjectDigest &&
      (grant.degradedForm === 'caller-supplied' ||
        grant.degradedForm === 'direct-human-review') &&
      !attemptGrantIds.has(grant.grantId),
  );
  if (matches.length > 1) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_COMPETING_AUTHORITY',
      'Multiple orphaned external TaskDiffReview grant reservations cover the exact subject; status cannot select one.',
      ExitCode.guard,
    );
  }
  return matches[0] ?? null;
}

export function renderExternalTaskDiffOrphanGrantStatus(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskDiffReviewSubject,
  grant: NonNullable<ReturnType<typeof inspectExternalTaskDiffOrphanGrant>>,
): TaskDiffReviewLifecycleStatus {
  if (
    grant.transitionDigest === undefined ||
    (grant.degradedForm !== 'caller-supplied' &&
      grant.degradedForm !== 'direct-human-review')
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return Object.freeze({
    state: 'external-grant-resume-required' as const,
    source: 'external' as const,
    sessionId: context.session.sessionId,
    subject,
    degradedForm: grant.degradedForm,
    grantId: grant.grantId,
    grantEnvelopeDigest: grant.signedEnvelopeDigest,
    transitionDigest: grant.transitionDigest,
  });
}

export function requireExternalTaskDiffReviewReservation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subjectDigest: string,
  grantEnvelopeDigest: string,
): TaskDiffExternalReviewReservation {
  const reservation = readTaskDiffExternalReviewReservation(
    runtime,
    subjectDigest,
    grantEnvelopeDigest,
  );
  if (reservation === null) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return reservation;
}

export function assertExternalTaskDiffReservationContent(
  reservation: TaskDiffExternalReviewReservation,
  submission: ReturnType<typeof createTaskDiffExternalReviewSubmission>,
  contentNode: ReturnType<typeof createEvidenceNode>,
  implementationActor: RecordedRoleParticipant,
): void {
  if (
    reservation.inputDigest !== submission.inputDigest ||
    reservation.reviewScopeDigest !== submission.reviewScopeDigest ||
    reservation.submissionRecordDigest !== submission.recordDigest ||
    reservation.contentNodeId !== contentNode.nodeId ||
    reservation.contentResultDigest !== contentNode.resultDigest ||
    canonicalJson(reservation.implementationActor) !==
      canonicalJson(implementationActor)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
}

export function renderExternalDirectHumanPause(
  sessionId: string,
  subject: TaskDiffReviewSubject,
  reservation: TaskDiffExternalReviewReservation,
): TaskDiffReviewLifecycleStatus {
  return Object.freeze({
    state: 'direct-human-attestation-required' as const,
    source: 'external' as const,
    sessionId,
    subject,
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

export function externalTaskDiffGrantRequiredStatus(
  sessionId: string,
  subject: TaskDiffReviewSubject,
  implementationActor: RecordedRoleParticipant,
): TaskDiffReviewCollaborationGrantRequiredStatus {
  return Object.freeze({
    state: 'collaboration-grant-required' as const,
    sessionId,
    subject,
    implementationActor,
    inputSchema: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'collaboration-grant-selection' as const,
      lifecyclePhase: 'task-diff-review' as const,
      conflictingRole: 'task-diff-reviewer' as const,
      grantRequest: null,
      allowedDegradedForms: Object.freeze([
        'caller-supplied' as const,
        'direct-human-review' as const,
      ]),
      resumeOption: '--grant <grant-id>' as const,
    }),
  });
}

export function assertExternalTaskDiffProvidersUnavailable(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: TaskDiffReviewSubject,
): void {
  const policy = baselineAdapterPolicy(
    context.git.repositoryRoot,
    context.session.baseline.head,
  );
  if (
    policy.policy.providers.codex.enabled ||
    policy.policy.providers.claude.enabled ||
    !subject.reviewRequirement.required
  ) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_NOT_ALLOWED',
      'External TaskDiffReview is available only when no review provider is callable for the exact required subject.',
      ExitCode.guard,
    );
  }
}

function assertHistoricalExternalTaskDiffProvidersUnavailable(
  repositoryRoot: string,
  subject: TaskDiffReviewSubject,
): void {
  const policy = baselineAdapterPolicy(repositoryRoot, subject.baseCommit);
  if (
    policy.policy.providers.codex.enabled ||
    policy.policy.providers.claude.enabled ||
    !subject.reviewRequirement.required
  ) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_REVIEW_NOT_ALLOWED',
      'Historical external TaskDiffReview authority is invalid when a review provider was callable for its exact baseline subject.',
      ExitCode.guard,
    );
  }
}

export function assertCurrentExternalTaskDiffReviewBinding(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'changeContract'
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
    | 'resolveCurrentTaskStrategyCorrection'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  binding: TaskDiffExternalReviewBinding,
  assertOwned?: () => void,
  replayMode: 'inspect' | 'governing' = 'governing',
  validation?: TaskDiffReviewConsumedReplayValidation,
): CurrentExternalTaskDiffReview {
  const current = assertHistoricalExternalTaskDiffReviewBinding(
    capabilities,
    context,
    runtime,
    binding,
    assertOwned,
    replayMode,
    validation,
  );
  const implementationActor =
    replayMode === 'inspect'
      ? current.reservation.implementationActor
      : resolveTaskDiffImplementationActor(
          capabilities,
          context.git.repositoryRoot,
          context.session.sessionId,
          subject,
          externalTaskDiffActorReplayOptions(
            current.reservation.implementationActor,
          ),
        );
  if (
    binding.subjectDigest !== subject.subjectDigest ||
    binding.targetDigest !== subject.subjectDigest ||
    binding.policyDigest !== subject.reviewPolicyDigest ||
    !sameRecordedTaskDiffActorAuthority(
      current.reservation.implementationActor,
      implementationActor,
    )
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  assertExternalTaskDiffProvidersUnavailable(context, subject);
  return current;
}

function sameRecordedTaskDiffActorAuthority(
  left: RecordedRoleParticipant,
  right: RecordedRoleParticipant,
): boolean {
  return (
    canonicalJson({ ...left, sessionId: null }) ===
    canonicalJson({ ...right, sessionId: null })
  );
}

export function bindingSubject(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffExternalReviewBinding,
): TaskDiffReviewSubject {
  return requireExternalTaskDiffSubmission(runtime, binding).subject;
}

export function assertHistoricalExternalTaskDiffReviewBinding(
  capabilities: Pick<
    TaskDiffReviewCapabilities,
    | 'externalBindingAdmitConsumedRoleResultReplay'
    | 'externalBindingCollaborationGrantEnvelopeDigest'
  >,
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffExternalReviewBinding,
  assertOwned?: () => void,
  replayMode: 'inspect' | 'governing' = 'governing',
  validation?: TaskDiffReviewConsumedReplayValidation,
): CurrentExternalTaskDiffReview {
  const {
    externalBindingAdmitConsumedRoleResultReplay: admitConsumedRoleResultReplay,
  } = capabilities;

  const subject = bindingSubject(runtime, binding);
  assertHistoricalExternalTaskDiffProvidersUnavailable(
    context.git.repositoryRoot,
    subject,
  );
  if (
    binding.subjectDigest !== subject.subjectDigest ||
    binding.targetDigest !== subject.subjectDigest ||
    binding.policyDigest !== subject.reviewPolicyDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const reservation = requireExternalTaskDiffReviewReservation(
    runtime,
    subject.subjectDigest,
    binding.grant.grantEnvelopeDigest,
  );
  if (reservation.reservationDigest !== binding.reservationDigest) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const submission = requireExternalTaskDiffSubmission(runtime, binding);
  const contentNode = readAndValidateExternalTaskDiffContentNode(
    runtime,
    binding,
    reservation.implementationActor,
  );
  const authorityNode = readEvidenceNode(runtime, binding.authorityNodeId);
  const output = exactExternalAuthorityOutput(authorityNode.output);
  const implementationActor = reservation.implementationActor;
  if (
    output.sessionId !== implementationActor.sessionId ||
    canonicalJson(output.implementationActor) !==
      canonicalJson(implementationActor)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const storedRoleResult = output.roleResult;
  const storedReview = parseTaskDiffReviewRecord(output.review);
  const grantUse = storedRoleResult.grantUse;
  if (grantUse === null) throw externalTaskDiffAuthorityInvalid();
  const expectedBinding = bindingFromPayload(grantUse.envelope.payload);
  const policy = parseBaselineJson(
    context.git.repositoryRoot,
    subject.baseCommit,
    'workflow/maintainer-policy.json',
    parseMaintainerPolicy,
  );
  const expectedCore = externalTaskDiffGrantCoreForSubject(
    context.git.repositoryRoot,
    subject,
    policy,
  );
  assertExternalTaskDiffGrantBinding(
    capabilities,
    expectedCore,
    expectedBinding,
    grantUse,
  );
  if (
    grantUse.grantId !== binding.grant.grantId ||
    grantUse.signedEnvelopeDigest !== binding.grant.grantEnvelopeDigest ||
    grantUse.transitionDigest !== binding.grant.grantTransitionDigest ||
    grantUse.targetDigest !== binding.grant.grantTargetDigest ||
    grantUse.degradedForm !== binding.grant.degradedForm ||
    sha256(canonicalJson(grantUse)) !== binding.grantUseDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  assertNoCompetingConsumedExternalTaskDiffAttempt(
    context,
    runtime,
    subject.subjectDigest,
    binding,
  );
  const grantInspection = readCollaborationGrantInspection(
    context.git.gitCommonDirectory,
    binding.grant.grantId,
  );
  if (
    grantInspection?.state !== 'consumed' ||
    grantInspection.use === undefined ||
    canonicalJson(grantInspection.use) !== canonicalJson(grantUse)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const consumedUse = grantInspection.use;
  const replayedRoleResult =
    replayMode === 'inspect'
      ? storedRoleResult
      : admitConsumedRoleResultReplay({
          assignment: storedRoleResult.assignment,
          author: implementationActor,
          participant: storedRoleResult.participant,
          content: externalTaskDiffContentAdmission(contentNode, subject),
          providerInvocation: null,
          replay: resolveConsumedRoleResultReplayPort(validation).verify({
            repositoryRoot: context.git.repositoryRoot,
            expectedBinding,
            grantUse: consumedUse,
            assignment: storedRoleResult.assignment,
            content: externalTaskDiffContentAdmission(contentNode, subject),
            directHumanReviewAttestation:
              storedRoleResult.directHumanReviewAttestation,
          }),
        });
  if (replayMode === 'inspect') {
    assertStoredAdmittedRoleResultDigest(replayedRoleResult);
  }
  if (
    canonicalJson(replayedRoleResult) !== canonicalJson(storedRoleResult) ||
    replayedRoleResult.resultDigest !== binding.admittedRoleResultDigest ||
    replayedRoleResult.providerInvocation !== null
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const replayedReview = createTaskDiffReviewRecord({
    subject,
    reviewScope: submission.reviewScope,
    assignment: externalTaskDiffReviewAssignment(
      output.sessionId,
      implementationActor,
      replayedRoleResult.assignment as GrantedRoleAssignment,
      binding.grantUseDigest,
    ),
    submission: submission.submission,
  });
  if (
    canonicalJson(replayedReview) !== canonicalJson(storedReview) ||
    storedReview.recordDigest !== binding.reviewRecordDigest ||
    (binding.grant.degradedForm === 'direct-human-review'
      ? (replayedRoleResult.assignment as GrantedRoleAssignment)
          .directHumanReviewAttestationDigest !==
        binding.directHumanReviewAttestationDigest
      : binding.directHumanReviewAttestationDigest !== null)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  const expectedAuthorityNode = createExternalTaskDiffReviewAuthorityNode({
    sessionId: output.sessionId,
    implementationActor,
    submission,
    contentNode,
    roleResult: replayedRoleResult,
    review: replayedReview,
  });
  if (
    authorityNode.nodeId !== binding.authorityNodeId ||
    authorityNode.resultDigest !== binding.authorityResultDigest ||
    canonicalJson(authorityNode) !== canonicalJson(expectedAuthorityNode)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return Object.freeze({
    binding,
    reservation,
    implementationActor,
    assignment: replayedRoleResult.assignment as GrantedRoleAssignment,
    roleResult: replayedRoleResult,
    review: replayedReview,
  });
}

function requireExternalTaskDiffSubmission(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffExternalReviewBinding,
) {
  const submission = readTaskDiffExternalReviewSubmission(
    runtime,
    binding.subjectDigest,
    binding.reviewScopeDigest,
    binding.inputDigest,
  );
  if (
    submission === null ||
    submission.recordDigest !== binding.submissionRecordDigest ||
    submission.inputDigest !== binding.inputDigest
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return submission;
}

function readAndValidateExternalTaskDiffContentNode(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  binding: TaskDiffExternalReviewBinding,
  implementationActor: RecordedRoleParticipant,
) {
  const submission = requireExternalTaskDiffSubmission(runtime, binding);
  const contentNode = readEvidenceNode(runtime, binding.contentNodeId);
  const expected = createExternalTaskDiffReviewContentNode(
    submission,
    implementationActor,
  );
  if (
    contentNode.nodeId !== binding.contentNodeId ||
    contentNode.resultDigest !== binding.contentResultDigest ||
    canonicalJson(contentNode) !== canonicalJson(expected)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return contentNode;
}

function exactExternalAuthorityOutput(value: unknown): Readonly<{
  sessionId: string;
  implementationActor: RecordedRoleParticipant;
  roleResult: AdmittedRoleResult;
  review: unknown;
}> {
  if (
    !isExternalRecord(value) ||
    Object.keys(value).sort().join('\0') !==
      ['implementationActor', 'review', 'roleResult', 'sessionId']
        .sort()
        .join('\0') ||
    typeof value.sessionId !== 'string' ||
    !isExternalRecord(value.implementationActor) ||
    !isExternalRecord(value.roleResult)
  ) {
    throw externalTaskDiffAuthorityInvalid();
  }
  return value as {
    sessionId: string;
    implementationActor: RecordedRoleParticipant;
    roleResult: AdmittedRoleResult;
    review: unknown;
  };
}

function assertNoCompetingConsumedExternalTaskDiffAttempt(
  context: ReturnType<typeof loadActiveSessionContext>,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subjectDigest: string,
  binding: TaskDiffExternalReviewBinding,
): void {
  const attempts = listTaskDiffExternalReviewReservations(
    runtime,
    subjectDigest,
  );
  for (const attempt of attempts) {
    const inspection = inspectExternalGrant(
      context.git.gitCommonDirectory,
      attempt.grant.grantId,
    );
    if (
      inspection.state === 'consumed' &&
      attempt.grant.grantEnvelopeDigest !== binding.grant.grantEnvelopeDigest
    ) {
      throw workflowError(
        'TASK_DIFF_EXTERNAL_REVIEW_COMPETING_AUTHORITY',
        'More than one external TaskDiffReview grant was consumed for the exact subject; no canonical authority may be selected by filename order.',
        ExitCode.guard,
      );
    }
  }
}

export function inspectExternalGrant(
  gitCommonDirectory: string,
  grantId: string,
) {
  const entry = readCollaborationGrantInspection(gitCommonDirectory, grantId);
  if (entry === null) throw externalTaskDiffAuthorityInvalid();
  return entry;
}

export function renderExternalTaskDiffReviewStatus(
  context: ReturnType<typeof loadActiveSessionContext>,
  _runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  subject: TaskDiffReviewSubject,
  current: CurrentExternalTaskDiffReview,
): TaskDiffReviewLifecycleStatus {
  return Object.freeze({
    state:
      current.review.challenges.length === 0
        ? ('satisfied' as const)
        : ('challenge-response-required' as const),
    source: 'external' as const,
    sessionId: context.session.sessionId,
    subject,
    implementationActor: current.implementationActor,
    assignment: current.assignment,
    review: current.review,
    finalAssurance: null,
  });
}

export function authenticatedExternalReviewAuthority(
  current: CurrentExternalTaskDiffReview,
): TaskDiffAuthenticatedReviewerAuthority {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    stage: 'review' as const,
    subjectDigest: current.review.subjectDigest,
    reviewRecordDigest: current.review.recordDigest,
    responseDigest: null,
    authorityNodeId: current.binding.authorityNodeId,
    authorityResultDigest: current.binding.authorityResultDigest,
    authority: Object.freeze({
      kind: 'grant-attributed-external-reviewer' as const,
      principalId: current.review.assignment.reviewerPrincipalId,
      degradedForm: current.binding.grant.degradedForm,
      grantUseDigest: current.binding.grantUseDigest,
      policyDigest: current.review.subject.reviewPolicyDigest,
    }),
  });
}
