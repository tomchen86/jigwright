import type {
  CollaborationGrantCodec,
  DirectHumanReviewAttestationIssuer,
} from '../../modules/authority/collaboration-grant-codec.ts';
/**
 * Submits and reconciles external reviews and closures within their grant
 * transactions.
 *
 * Invariants:
 * - Review submission must retain the initially inspected subject and
 *   implementation actor.
 */
// Submit and reconcile external reviews and closures within their exact grant transactions.
import {
  type TaskDiffReviewExternalSubmissionInput,
  parseTaskDiffReviewExternalSubmissionInput,
  type TaskDiffReviewExternalClosureInput,
  parseTaskDiffReviewExternalClosureInput,
  type TaskDiffReviewExternalClosureRequestInput,
  parseTaskDiffReviewExternalClosureRequestInput,
} from '../../modules/assurance/task-diff-review-input.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import { type GrantedRoleAssignment } from '../../modules/provider-orchestration/role-assignment.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  type CollaborationGrantExpectedBinding,
  bindingFromPayload,
  type DirectHumanReviewAttestation,
} from '../../modules/authority/collaboration-grant-codec.ts';
import { type AuthoritativeCollaborationGrantVerifier } from '../../modules/authority/grant-verifier-port.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import {
  createTaskDiffReviewRecord,
  assertTaskDiffReviewContinuationSubmissionCurrent,
  parseTaskDiffReviewContinuationSubmission,
  createTaskDiffReviewChallengeResponse,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import type { TaskDiffReviewChallengeResponseRecord } from '../../modules/assurance/task-diff-review-artifact-record.ts';
import { type MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import { type ConsumedRoleResultReplayPort } from '../../modules/assurance/planning-assurance-validator.ts';
import type {
  TaskDiffReviewRuntimeBindings,
  TaskDiffReviewRuntimeData,
} from './task-diff-review-lifecycle.ts';
import type {
  SubmitExternalTaskDiffReviewOptions,
  TaskDiffReviewInspectionStatus,
  SubmitExternalTaskDiffReviewContinuationOptions,
  TaskDiffReviewExternalContinuationLifecycleStatus,
  ReconcileExternalTaskDiffReviewOptions,
} from './task-diff-review-contracts.ts';
import type { createTaskDiffReviewCommonModule } from './task-diff-review-common.ts';
import type { createTaskDiffReviewSubjectModule } from './task-diff-review-subject.ts';
import type { createTaskDiffReviewExternalBindingModule } from './task-diff-review-external-binding.ts';
import type { createTaskDiffReviewExternalContinuationBindingModule } from './task-diff-review-external-continuation-binding.ts';
import type { createTaskDiffReviewLineageModule } from './task-diff-review-lineage.ts';
import type { createTaskDiffReviewInspectionModule } from './task-diff-review-inspection.ts';

type TaskDiffExternalReviewReservation =
  TaskDiffReviewRuntimeData['TaskDiffExternalReviewReservation'];

type CollaborationGrantUseProjection =
  TaskDiffReviewRuntimeData['CollaborationGrantUseProjection'];

type VerifiedConsumedCollaborationGrantReplay =
  TaskDiffReviewRuntimeData['VerifiedConsumedCollaborationGrantReplay'];

type TaskDiffExternalContinuationReservation =
  TaskDiffReviewRuntimeData['TaskDiffExternalContinuationReservation'];

export function createTaskDiffReviewExternalCommandsModule(
  runtime: TaskDiffReviewRuntimeBindings,
  common: ReturnType<typeof createTaskDiffReviewCommonModule>,
  subject: ReturnType<typeof createTaskDiffReviewSubjectModule>,
  externalBinding: ReturnType<typeof createTaskDiffReviewExternalBindingModule>,
  externalContinuationBinding: ReturnType<
    typeof createTaskDiffReviewExternalContinuationBindingModule
  >,
  lineage: ReturnType<typeof createTaskDiffReviewLineageModule>,
  inspection: ReturnType<typeof createTaskDiffReviewInspectionModule>,
  collaborationGrants: Pick<
    CollaborationGrantCodec,
    'collaborationGrantEnvelopeDigest'
  >,
  createDirectHumanReviewAttestation: DirectHumanReviewAttestationIssuer,
  roleResultAdmission: Pick<
    RoleAdmissionServices,
    | 'authorizeGrantedOrdinaryRole'
    | 'admitRoleResult'
    | 'admitConsumedRoleResultReplay'
  >,
) {
  const {
    authorizeGrantedOrdinaryRole,
    admitRoleResult,
    admitConsumedRoleResultReplay,
  } = roleResultAdmission;
  const { collaborationGrantEnvelopeDigest } = collaborationGrants;
  const {
    loadActiveSessionContext,
    withRepositoryLifecycleOperation,
    withSessionOperation,
    loadInvestigationRuntimeContext,
    readTaskDiffExternalReviewBinding,
    readCollaborationGrantInspection,
    createTaskDiffExternalReviewSubmission,
    createEvidenceNode,
    writeEvidenceNode,
    verifyExactConsumedCollaborationGrantCrashReplay,
    selectAndReserveCollaborationGrantUnderLifecycleLock,
    failCollaborationReservationUnderLifecycleLock,
    createTaskDiffExternalReviewReservation,
    consumeCollaborationGrantUnderLifecycleLock,
    createTaskDiffExternalReviewBinding,
    taskDiffExternalContinuationTargetDigest,
    readTaskDiffExternalContinuationBinding,
    createTaskDiffExternalClosureSubmission,
    createTaskDiffExternalChallengeResponse,
    createTaskDiffExternalContinuationReservation,
    createTaskDiffExternalContinuationBinding,
    readTaskDiffExternalReviewSubmission,
    readTaskDiffExternalChallengeResponse,
    readTaskDiffExternalClosureSubmission,
    readReservedCollaborationGrant,
  } = runtime;
  const {
    externalTaskDiffInputStale,
    assertTaskDiffReviewLifecycleGrantCurrent,
    sha256,
    taskDiffReviewLineageConflict,
    externalTaskDiffLineageDeferred,
    parseBaselineJson,
    resolveConsumedCollaborationGrantReplayVerifier,
    resolveAuthoritativeCollaborationGrantVerifier,
    reviewNotSatisfied,
    taskDiffReviewLifecycleOptions,
    externalTaskDiffReconciliationNotAvailable,
    externalTaskDiffAuthorityInvalid,
    directHumanTaskDiffResumeInvalid,
  } = common;
  const {
    inspectTaskDiffReviewSubject,
    resolveTaskDiffImplementationActor,
    bindDocumentationRemediation,
  } = subject;
  const {
    assertCurrentExternalTaskDiffReviewBinding,
    renderExternalTaskDiffReviewStatus,
    assertExternalTaskDiffProvidersUnavailable,
    preflightExternalTaskDiffReviewSubmission,
    externalTaskDiffGrantRequiredStatus,
    externalTaskDiffGrantCore,
    assertExternalTaskDiffAttemptMayProceed,
    assertExternalTaskDiffOrphanGrantMayProceed,
    assertExternalTaskDiffGrantBinding,
    requireExternalTaskDiffReviewReservation,
    createExternalTaskDiffReviewContentNode,
    assertExternalTaskDiffReservationContent,
    preflightExternalTaskDiffReviewerIdentity,
    renderExternalDirectHumanPause,
    roleParticipantFromRecorded,
    externalParticipantFromGrant,
    externalTaskDiffReviewAssignment,
    externalTaskDiffContentAdmission,
    createExternalTaskDiffReviewAuthorityNode,
    externalTaskDiffActorReplayOptions,
  } = externalBinding;
  const {
    assertExternalTaskDiffContinuationInputCurrent,
    assertExternalTaskDiffContinuationProviderShortage,
    assertCurrentExternalTaskDiffContinuationBinding,
    ensureExternalTaskDiffFinalAssurance,
    renderExternalTaskDiffContinuationSatisfied,
    externalTaskDiffContinuationGrantRequiredStatus,
    externalTaskDiffContinuationGrantCore,
    assertExternalTaskDiffContinuationAttemptMayProceed,
    assertExternalTaskDiffContinuationOrphanGrantMayProceed,
    requireExternalTaskDiffContinuationReservation,
    createExternalTaskDiffContinuationContentNode,
    assertExternalTaskDiffContinuationReservationContent,
    preflightExternalTaskDiffChallengeClosure,
    renderExternalTaskDiffContinuationDirectHumanPause,
    externalTaskDiffContinuationContentAdmission,
    createExternalTaskDiffContinuationAuthorityNode,
  } = externalContinuationBinding;
  const {
    readExactProviderTaskDiffReviewSource,
    assertNoAllSessionProviderSourceCollision,
    resolveTaskDiffReviewCandidatePlan,
    loadCurrentAuthenticatedTaskDiffReview,
  } = lineage;
  const { inspectTaskDiffReviewStatus } = inspection;
  function submitExternalTaskDiffReview(
    cwd: string,
    requestedSessionId: string,
    inputCandidate: TaskDiffReviewExternalSubmissionInput,
    options: SubmitExternalTaskDiffReviewOptions = {},
  ): TaskDiffReviewInspectionStatus {
    const input = parseTaskDiffReviewExternalSubmissionInput(inputCandidate);
    const initialSubject = inspectTaskDiffReviewSubject(
      cwd,
      requestedSessionId,
    );
    if (
      !initialSubject.reviewRequirement.required ||
      input.subjectDigest !== initialSubject.subjectDigest
    ) {
      throw externalTaskDiffInputStale();
    }
    const initialImplementationActor = resolveTaskDiffImplementationActor(
      cwd,
      requestedSessionId,
      initialSubject,
      options,
    );
    const initialContext = loadActiveSessionContext(cwd, requestedSessionId);
    return withRepositoryLifecycleOperation(
      initialContext.runtime,
      (assertOwned) =>
        withSessionOperation(initialContext.runtime, requestedSessionId, () => {
          assertOwned();
          const context = loadActiveSessionContext(cwd, requestedSessionId);
          assertTaskDiffReviewLifecycleGrantCurrent(
            context,
            requestedSessionId,
          );
          const runtime = loadInvestigationRuntimeContext(cwd).runtime;
          const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
          const implementationActor = resolveTaskDiffImplementationActor(
            cwd,
            requestedSessionId,
            subject,
            options,
          );
          if (
            canonicalJson(subject) !== canonicalJson(initialSubject) ||
            canonicalJson(implementationActor) !==
              canonicalJson(initialImplementationActor) ||
            input.subjectDigest !== subject.subjectDigest
          ) {
            throw externalTaskDiffInputStale();
          }

          const inputDigest = sha256(canonicalJson(input));
          const existingBinding = readTaskDiffExternalReviewBinding(
            runtime,
            subject.subjectDigest,
          );
          const providerSource = readExactProviderTaskDiffReviewSource(
            runtime,
            context.session.sessionId,
            subject.subjectDigest,
          );
          if (existingBinding !== null) {
            assertNoAllSessionProviderSourceCollision(
              runtime,
              subject.subjectDigest,
            );
            if (
              providerSource.reservation !== null ||
              providerSource.binding !== null
            )
              throw taskDiffReviewLineageConflict();
            if (existingBinding.inputDigest !== inputDigest) {
              throw externalTaskDiffInputStale();
            }
            const current = assertCurrentExternalTaskDiffReviewBinding(
              context,
              runtime,
              subject,
              existingBinding,
              assertOwned,
              'governing',
              options,
            );
            bindDocumentationRemediation(
              cwd,
              requestedSessionId,
              current.review,
            );
            return renderExternalTaskDiffReviewStatus(
              context,
              runtime,
              subject,
              current,
            );
          }
          if (
            providerSource.reservation !== null ||
            providerSource.binding !== null
          )
            throw taskDiffReviewLineageConflict();
          assertNoAllSessionProviderSourceCollision(
            runtime,
            subject.subjectDigest,
          );

          const candidatePlan = resolveTaskDiffReviewCandidatePlan(
            context,
            runtime,
            subject,
            'governing',
            options,
          );
          if (candidatePlan.action !== 'review') {
            throw externalTaskDiffLineageDeferred();
          }
          assertExternalTaskDiffProvidersUnavailable(context, subject);
          preflightExternalTaskDiffReviewSubmission(
            context.session.sessionId,
            implementationActor,
            subject,
            candidatePlan.scope,
            input.submission,
            inputDigest,
          );
          if (options.collaborationGrant === undefined) {
            return externalTaskDiffGrantRequiredStatus(
              context.session.sessionId,
              subject,
              implementationActor,
            );
          }
          const grant = options.collaborationGrant;
          const policy = parseBaselineJson(
            context.git.repositoryRoot,
            context.session.baseline.head,
            'workflow/maintainer-policy.json',
            parseMaintainerPolicy,
          );
          const now = grant.now ?? new Date();
          const expectedCore = externalTaskDiffGrantCore(
            context,
            subject,
            policy,
          );
          const inspectedGrant = readCollaborationGrantInspection(
            context.git.gitCommonDirectory,
            grant.grantId,
          );
          assertExternalTaskDiffAttemptMayProceed(
            context,
            runtime,
            subject.subjectDigest,
            grant.grantId,
            implementationActor,
          );
          assertExternalTaskDiffOrphanGrantMayProceed(
            context,
            runtime,
            subject,
            grant.grantId,
          );

          let reservation: TaskDiffExternalReviewReservation;
          let assignment: GrantedRoleAssignment;
          let grantUse: CollaborationGrantUseProjection;
          let expectedBinding: CollaborationGrantExpectedBinding;
          let authoritativeVerifier: AuthoritativeCollaborationGrantVerifier | null =
            null;
          let consumedReplay: VerifiedConsumedCollaborationGrantReplay | null =
            null;
          let submission: ReturnType<
            typeof createTaskDiffExternalReviewSubmission
          >;
          let contentNode: ReturnType<typeof createEvidenceNode>;
          if (inspectedGrant?.state === 'consumed' && inspectedGrant.use) {
            grantUse = inspectedGrant.use;
            expectedBinding = bindingFromPayload(grantUse.envelope.payload);
            assertExternalTaskDiffGrantBinding(
              expectedCore,
              expectedBinding,
              grantUse,
            );
            reservation = requireExternalTaskDiffReviewReservation(
              runtime,
              subject.subjectDigest,
              grantUse.signedEnvelopeDigest,
            );
            submission = createTaskDiffExternalReviewSubmission(runtime, {
              subject,
              reviewScope: candidatePlan.scope,
              submission: input.submission,
              inputDigest,
            });
            contentNode = createExternalTaskDiffReviewContentNode(
              submission,
              implementationActor,
            );
            writeEvidenceNode(runtime, contentNode);
            assertExternalTaskDiffReservationContent(
              reservation,
              submission,
              contentNode,
              implementationActor,
            );
            assignment = grantUse.assignment as GrantedRoleAssignment;
            consumedReplay = verifyExactConsumedCollaborationGrantCrashReplay(
              context.git.repositoryRoot,
              grant.grantId,
              {
                transitionDigest: grantUse.transitionDigest,
                assignment,
                contentAdmission: {
                  kind: 'task-diff-review',
                  nodeId: contentNode.nodeId,
                  resultDigest: contentNode.resultDigest,
                  current: true,
                },
                directHumanReviewAttestation:
                  grant.directHumanReviewAttestation ?? null,
              },
              {
                expectedBinding,
                verifier: resolveConsumedCollaborationGrantReplayVerifier(
                  grant.consumedReplayVerifier,
                ),
              },
            );
          } else {
            const verifier = resolveAuthoritativeCollaborationGrantVerifier(
              grant.verifier,
            );
            authoritativeVerifier = verifier;
            const selection =
              selectAndReserveCollaborationGrantUnderLifecycleLock(
                context.git.repositoryRoot,
                grant.grantId,
                {
                  expectedCore,
                  allowedDegradedForms: [
                    'caller-supplied',
                    'direct-human-review',
                  ],
                  now,
                  verifier,
                },
                assertOwned,
              );
            expectedBinding = selection.expectedBinding;
            if (options.testCrashAfter === 'grant-reserved') {
              throw new Error(
                'Simulated external TaskDiffReview interruption after grant reservation.',
              );
            }
            try {
              preflightExternalTaskDiffReviewerIdentity(
                context.session.sessionId,
                implementationActor,
                expectedBinding,
                subject,
                candidatePlan.scope,
                input.submission,
              );
            } catch (error) {
              if (
                error instanceof WorkflowError &&
                error.code === 'TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'
              ) {
                failCollaborationReservationUnderLifecycleLock(
                  context.git.gitCommonDirectory,
                  selection.reservation.grantId,
                  selection.reservation.transitionDigest,
                  'External TaskDiffReview reviewer is not independent from the implementation actor.',
                  now,
                  assertOwned,
                );
              }
              throw error;
            }
            submission = createTaskDiffExternalReviewSubmission(runtime, {
              subject,
              reviewScope: candidatePlan.scope,
              submission: input.submission,
              inputDigest,
            });
            contentNode = createExternalTaskDiffReviewContentNode(
              submission,
              implementationActor,
            );
            writeEvidenceNode(runtime, contentNode);
            const grantReference = {
              degradedForm: expectedBinding.degradedForm as
                'caller-supplied' | 'direct-human-review',
              grantId: selection.reservation.grantId,
              grantEnvelopeDigest: collaborationGrantEnvelopeDigest(
                selection.reservation.envelope,
              ),
              grantTransitionDigest: selection.reservation.transitionDigest,
              grantTargetDigest: expectedBinding.targetDigest,
            } as const;
            reservation = createTaskDiffExternalReviewReservation(runtime, {
              subject,
              policyDigest: subject.reviewPolicyDigest,
              inputDigest,
              reviewScopeDigest: submission.reviewScopeDigest,
              submissionRecordDigest: submission.recordDigest,
              contentNodeId: contentNode.nodeId,
              contentResultDigest: contentNode.resultDigest,
              implementationActor,
              grant: grantReference,
            });
            if (
              expectedBinding.degradedForm === 'direct-human-review' &&
              grant.directHumanReviewAttestation === undefined
            ) {
              return renderExternalDirectHumanPause(
                context.session.sessionId,
                subject,
                reservation,
              );
            }
            try {
              assignment = authorizeGrantedOrdinaryRole({
                role: 'task-diff-reviewer',
                author: roleParticipantFromRecorded(implementationActor),
                targetDigest: subject.subjectDigest,
                reservation: selection.reservation,
                actualParticipant:
                  externalParticipantFromGrant(expectedBinding),
                callableProviderIds: [],
                ...(expectedBinding.degradedForm === 'direct-human-review'
                  ? {
                      directHumanReview: {
                        attestation: grant.directHumanReviewAttestation!,
                        policy,
                        verifier,
                        now,
                        reviewNodeId: contentNode.nodeId,
                        reviewResultDigest: contentNode.resultDigest,
                      },
                    }
                  : {}),
              });
              createTaskDiffReviewRecord({
                subject,
                reviewScope: submission.reviewScope,
                assignment: externalTaskDiffReviewAssignment(
                  context.session.sessionId,
                  implementationActor,
                  assignment,
                  '0'.repeat(64),
                ),
                submission: submission.submission,
              });
            } catch (error) {
              if (
                error instanceof WorkflowError &&
                error.code === 'TASK_DIFF_REVIEW_INDEPENDENCE_INVALID'
              ) {
                failCollaborationReservationUnderLifecycleLock(
                  context.git.gitCommonDirectory,
                  selection.reservation.grantId,
                  selection.reservation.transitionDigest,
                  'External TaskDiffReview reviewer is not independent from the implementation actor.',
                  now,
                  assertOwned,
                );
              }
              throw error;
            }
            const consumed = consumeCollaborationGrantUnderLifecycleLock(
              context.git.gitCommonDirectory,
              grant.grantId,
              {
                transitionDigest: selection.reservation.transitionDigest,
                assignment,
                contentAdmission: {
                  kind: 'task-diff-review',
                  nodeId: contentNode.nodeId,
                  resultDigest: contentNode.resultDigest,
                  current: true,
                },
                directHumanReviewAttestation:
                  grant.directHumanReviewAttestation ?? null,
                now,
                verifier,
              },
              assertOwned,
            );
            if (consumed.use === undefined) throw reviewNotSatisfied();
            grantUse = consumed.use;
            if (options.testCrashAfter === 'grant-consumed') {
              throw new Error(
                'Simulated external TaskDiffReview interruption after grant consumption.',
              );
            }
          }

          const content = externalTaskDiffContentAdmission(
            contentNode,
            subject,
          );
          const roleResult =
            consumedReplay === null
              ? (() => {
                  if (authoritativeVerifier === null)
                    throw reviewNotSatisfied();
                  return admitRoleResult({
                    assignment,
                    author: implementationActor,
                    participant: assignment.participant,
                    content,
                    providerInvocation: null,
                    grantUse,
                    grantValidation: {
                      now: new Date(grantUse.envelope.payload.expiresAt),
                      expectedBinding,
                      policy,
                      verifier: authoritativeVerifier,
                      transitionDigest: grantUse.transitionDigest,
                    },
                  });
                })()
              : admitConsumedRoleResultReplay({
                  assignment,
                  author: implementationActor,
                  participant: assignment.participant,
                  content,
                  providerInvocation: null,
                  replay: consumedReplay,
                });
          const grantUseDigest = sha256(canonicalJson(grantUse));
          const review = createTaskDiffReviewRecord({
            subject,
            reviewScope: submission.reviewScope,
            assignment: externalTaskDiffReviewAssignment(
              context.session.sessionId,
              implementationActor,
              assignment,
              grantUseDigest,
            ),
            submission: submission.submission,
          });
          const authorityNode = createExternalTaskDiffReviewAuthorityNode({
            sessionId: context.session.sessionId,
            implementationActor,
            submission,
            contentNode,
            roleResult,
            review,
          });
          writeEvidenceNode(runtime, authorityNode);
          createTaskDiffExternalReviewBinding(runtime, {
            reservation,
            grantUseDigest,
            admittedRoleResultDigest: roleResult.resultDigest,
            directHumanReviewAttestationDigest:
              assignment.directHumanReviewAttestationDigest,
            contentNodeId: contentNode.nodeId,
            contentResultDigest: contentNode.resultDigest,
            authorityNodeId: authorityNode.nodeId,
            authorityResultDigest: authorityNode.resultDigest,
            reviewRecordDigest: review.recordDigest,
          });
          bindDocumentationRemediation(cwd, requestedSessionId, review);
          assertOwned();
          const binding = readTaskDiffExternalReviewBinding(
            runtime,
            subject.subjectDigest,
          );
          if (binding === null) throw reviewNotSatisfied();
          return renderExternalTaskDiffReviewStatus(
            context,
            runtime,
            subject,
            assertCurrentExternalTaskDiffReviewBinding(
              context,
              runtime,
              subject,
              binding,
              assertOwned,
              'governing',
              options,
            ),
          );
        }),
      taskDiffReviewLifecycleOptions(initialContext, requestedSessionId),
    );
  }

  function submitExternalTaskDiffReviewContinuation(
    cwd: string,
    requestedSessionId: string,
    responseCandidate: TaskDiffReviewChallengeResponseRecord,
    inputCandidate: TaskDiffReviewExternalClosureInput,
    options: SubmitExternalTaskDiffReviewContinuationOptions = {},
  ): TaskDiffReviewExternalContinuationLifecycleStatus {
    const input = parseTaskDiffReviewExternalClosureInput(inputCandidate);
    const initial = loadCurrentAuthenticatedTaskDiffReview(
      cwd,
      requestedSessionId,
      options,
    );
    const initialResponse = assertExternalTaskDiffContinuationInputCurrent(
      initial,
      responseCandidate,
      input,
    );
    const initialContext = loadActiveSessionContext(cwd, requestedSessionId);

    return withRepositoryLifecycleOperation(
      initialContext.runtime,
      (assertOwned) =>
        withSessionOperation(initialContext.runtime, requestedSessionId, () => {
          assertOwned();
          const context = loadActiveSessionContext(cwd, requestedSessionId);
          assertTaskDiffReviewLifecycleGrantCurrent(
            context,
            requestedSessionId,
          );
          const runtime = loadInvestigationRuntimeContext(cwd).runtime;
          const current = loadCurrentAuthenticatedTaskDiffReview(
            cwd,
            requestedSessionId,
            options,
          );
          if (
            canonicalJson(current) !== canonicalJson(initial) ||
            canonicalJson(
              assertExternalTaskDiffContinuationInputCurrent(
                current,
                responseCandidate,
                input,
              ),
            ) !== canonicalJson(initialResponse)
          ) {
            throw externalTaskDiffInputStale();
          }
          const response = initialResponse;
          const submission = assertTaskDiffReviewContinuationSubmissionCurrent(
            current.review,
            response,
            parseTaskDiffReviewContinuationSubmission({
              schemaVersion: 1,
              reviewRecordDigest: input.reviewRecordDigest,
              responseDigest: input.responseDigest,
              proposedDispositions: input.proposedDispositions,
            }),
          );
          const inputDigest = sha256(canonicalJson(input));
          const targetDigest = taskDiffExternalContinuationTargetDigest({
            subjectDigest: current.review.subjectDigest,
            reviewRecordDigest: current.review.recordDigest,
            responseDigest: response.responseDigest,
          });
          const callableProviderIds =
            assertExternalTaskDiffContinuationProviderShortage(
              context,
              runtime,
              context.session.sessionId,
              current.review,
            );

          const existingBinding = readTaskDiffExternalContinuationBinding(
            runtime,
            targetDigest,
          );
          if (existingBinding !== null) {
            if (existingBinding.inputDigest !== inputDigest) {
              throw externalTaskDiffInputStale();
            }
            const authenticatedClosure =
              assertCurrentExternalTaskDiffContinuationBinding({
                context,
                runtime,
                current,
                response,
                binding: existingBinding,
                validation: options,
              });
            const finalAssurance = ensureExternalTaskDiffFinalAssurance({
              runtime,
              current,
              response,
              binding: existingBinding,
              authenticatedClosure,
            });
            return renderExternalTaskDiffContinuationSatisfied(
              context.session.sessionId,
              current,
              response,
              finalAssurance,
            );
          }

          if (options.collaborationGrant === undefined) {
            return externalTaskDiffContinuationGrantRequiredStatus(
              context.session.sessionId,
              current,
              response,
              targetDigest,
            );
          }
          const requestedGrant = options.collaborationGrant;
          const policy = parseBaselineJson(
            context.git.repositoryRoot,
            current.review.subject.baseCommit,
            'workflow/maintainer-policy.json',
            parseMaintainerPolicy,
          );
          const now = requestedGrant.now ?? new Date();
          const expectedCore = externalTaskDiffContinuationGrantCore(
            context,
            current.review.subject,
            targetDigest,
            policy,
          );
          assertExternalTaskDiffContinuationAttemptMayProceed(
            context,
            runtime,
            current.review.recordDigest,
            targetDigest,
            requestedGrant.grantId,
          );
          assertExternalTaskDiffContinuationOrphanGrantMayProceed(
            context,
            runtime,
            targetDigest,
            requestedGrant.grantId,
          );
          const inspectedGrant = readCollaborationGrantInspection(
            context.git.gitCommonDirectory,
            requestedGrant.grantId,
          );

          let reservation: TaskDiffExternalContinuationReservation;
          let assignment: GrantedRoleAssignment;
          let grantUse: CollaborationGrantUseProjection;
          let expectedBinding: CollaborationGrantExpectedBinding;
          let authoritativeVerifier: AuthoritativeCollaborationGrantVerifier | null =
            null;
          let consumedReplay: VerifiedConsumedCollaborationGrantReplay | null =
            null;
          let closureSubmission: ReturnType<
            typeof createTaskDiffExternalClosureSubmission
          >;
          let contentNode: ReturnType<typeof createEvidenceNode>;

          if (inspectedGrant?.state === 'consumed' && inspectedGrant.use) {
            grantUse = inspectedGrant.use;
            expectedBinding = bindingFromPayload(grantUse.envelope.payload);
            assertExternalTaskDiffGrantBinding(
              expectedCore,
              expectedBinding,
              grantUse,
            );
            reservation = requireExternalTaskDiffContinuationReservation(
              runtime,
              targetDigest,
              grantUse.signedEnvelopeDigest,
            );
            createTaskDiffExternalChallengeResponse(runtime, {
              subject: current.review.subject,
              response,
            });
            closureSubmission = createTaskDiffExternalClosureSubmission(
              runtime,
              {
                subject: current.review.subject,
                submission,
                inputDigest,
              },
            );
            contentNode =
              createExternalTaskDiffContinuationContentNode(closureSubmission);
            writeEvidenceNode(runtime, contentNode);
            assertExternalTaskDiffContinuationReservationContent(
              reservation,
              closureSubmission,
              contentNode,
            );
            assignment = grantUse.assignment as GrantedRoleAssignment;
            consumedReplay = verifyExactConsumedCollaborationGrantCrashReplay(
              context.git.repositoryRoot,
              requestedGrant.grantId,
              {
                transitionDigest: grantUse.transitionDigest,
                assignment,
                contentAdmission: {
                  kind: 'task-diff-review',
                  nodeId: contentNode.nodeId,
                  resultDigest: contentNode.resultDigest,
                  current: true,
                },
                directHumanReviewAttestation:
                  requestedGrant.directHumanReviewAttestation ?? null,
              },
              {
                expectedBinding,
                verifier: resolveConsumedCollaborationGrantReplayVerifier(
                  requestedGrant.consumedReplayVerifier,
                ),
              },
            );
          } else {
            const verifier = resolveAuthoritativeCollaborationGrantVerifier(
              requestedGrant.verifier,
            );
            authoritativeVerifier = verifier;
            const selection =
              selectAndReserveCollaborationGrantUnderLifecycleLock(
                context.git.repositoryRoot,
                requestedGrant.grantId,
                {
                  expectedCore,
                  allowedDegradedForms: [
                    'caller-supplied',
                    'direct-human-review',
                  ],
                  now,
                  verifier,
                },
                assertOwned,
              );
            expectedBinding = selection.expectedBinding;
            if (options.testCrashAfter === 'grant-reserved') {
              throw new Error(
                'Simulated external TaskDiffReview continuation interruption after grant reservation.',
              );
            }
            try {
              preflightExternalTaskDiffChallengeClosure(
                current.review,
                submission,
                expectedBinding,
              );
            } catch (error) {
              if (
                error instanceof WorkflowError &&
                error.code === 'REVIEW_CHALLENGE_INVALID'
              ) {
                failCollaborationReservationUnderLifecycleLock(
                  context.git.gitCommonDirectory,
                  selection.reservation.grantId,
                  selection.reservation.transitionDigest,
                  'External TaskDiffReview challenge closer is not authorized for the exact review.',
                  now,
                  assertOwned,
                );
              }
              throw error;
            }
            createTaskDiffExternalChallengeResponse(runtime, {
              subject: current.review.subject,
              response,
            });
            closureSubmission = createTaskDiffExternalClosureSubmission(
              runtime,
              {
                subject: current.review.subject,
                submission,
                inputDigest,
              },
            );
            contentNode =
              createExternalTaskDiffContinuationContentNode(closureSubmission);
            writeEvidenceNode(runtime, contentNode);
            const grantReference = {
              degradedForm: expectedBinding.degradedForm as
                'caller-supplied' | 'direct-human-review',
              grantId: selection.reservation.grantId,
              grantEnvelopeDigest: collaborationGrantEnvelopeDigest(
                selection.reservation.envelope,
              ),
              grantTransitionDigest: selection.reservation.transitionDigest,
              grantTargetDigest: expectedBinding.targetDigest,
            } as const;
            reservation = createTaskDiffExternalContinuationReservation(
              runtime,
              {
                subject: current.review.subject,
                policyDigest: current.review.subject.reviewPolicyDigest,
                reviewRecordDigest: current.review.recordDigest,
                responseDigest: response.responseDigest,
                inputDigest,
                contentNodeId: contentNode.nodeId,
                contentResultDigest: contentNode.resultDigest,
                grant: grantReference,
              },
            );
            if (
              expectedBinding.degradedForm === 'direct-human-review' &&
              requestedGrant.directHumanReviewAttestation === undefined
            ) {
              return renderExternalTaskDiffContinuationDirectHumanPause(
                context.session.sessionId,
                current,
                response,
                reservation,
              );
            }
            assignment = authorizeGrantedOrdinaryRole({
              role: 'task-diff-reviewer',
              author: roleParticipantFromRecorded(current.implementationActor),
              targetDigest,
              reservation: selection.reservation,
              actualParticipant: externalParticipantFromGrant(expectedBinding),
              callableProviderIds,
              degradedAuthorityOverride: {
                kind: 'task-diff-challenge-closure',
                targetDigest,
                subjectDigest: current.review.subjectDigest,
                reviewRecordDigest: current.review.recordDigest,
                responseDigest: response.responseDigest,
              },
              ...(expectedBinding.degradedForm === 'direct-human-review'
                ? {
                    directHumanReview: {
                      attestation: requestedGrant.directHumanReviewAttestation!,
                      policy,
                      verifier,
                      now,
                      reviewNodeId: contentNode.nodeId,
                      reviewResultDigest: contentNode.resultDigest,
                    },
                  }
                : {}),
            });
            const consumed = consumeCollaborationGrantUnderLifecycleLock(
              context.git.gitCommonDirectory,
              requestedGrant.grantId,
              {
                transitionDigest: selection.reservation.transitionDigest,
                assignment,
                contentAdmission: {
                  kind: 'task-diff-review',
                  nodeId: contentNode.nodeId,
                  resultDigest: contentNode.resultDigest,
                  current: true,
                },
                directHumanReviewAttestation:
                  requestedGrant.directHumanReviewAttestation ?? null,
                now,
                verifier,
              },
              assertOwned,
            );
            if (consumed.use === undefined) throw reviewNotSatisfied();
            grantUse = consumed.use;
            if (options.testCrashAfter === 'grant-consumed') {
              throw new Error(
                'Simulated external TaskDiffReview continuation interruption after grant consumption.',
              );
            }
          }

          const content = externalTaskDiffContinuationContentAdmission(
            contentNode,
            current.review.subject,
          );
          const roleResult =
            consumedReplay === null
              ? (() => {
                  if (authoritativeVerifier === null)
                    throw reviewNotSatisfied();
                  return admitRoleResult({
                    assignment,
                    author: current.implementationActor,
                    participant: assignment.participant,
                    content,
                    providerInvocation: null,
                    grantUse,
                    grantValidation: {
                      now: new Date(grantUse.envelope.payload.expiresAt),
                      expectedBinding,
                      policy,
                      verifier: authoritativeVerifier,
                      transitionDigest: grantUse.transitionDigest,
                    },
                  });
                })()
              : admitConsumedRoleResultReplay({
                  assignment,
                  author: current.implementationActor,
                  participant: assignment.participant,
                  content,
                  providerInvocation: null,
                  replay: consumedReplay,
                });
          const authorityNode = createExternalTaskDiffContinuationAuthorityNode(
            {
              submission: closureSubmission,
              contentNode,
              roleResult,
            },
          );
          writeEvidenceNode(runtime, authorityNode);
          const binding = createTaskDiffExternalContinuationBinding(runtime, {
            reservation,
            grantUseDigest: sha256(canonicalJson(grantUse)),
            admittedRoleResultDigest: roleResult.resultDigest,
            directHumanReviewAttestationDigest:
              assignment.directHumanReviewAttestationDigest,
            contentNodeId: contentNode.nodeId,
            contentResultDigest: contentNode.resultDigest,
            authorityNodeId: authorityNode.nodeId,
            authorityResultDigest: authorityNode.resultDigest,
          });
          const authenticatedClosure =
            assertCurrentExternalTaskDiffContinuationBinding({
              context,
              runtime,
              current,
              response,
              binding,
              validation: options,
            });
          const finalAssurance = ensureExternalTaskDiffFinalAssurance({
            runtime,
            current,
            response,
            binding,
            authenticatedClosure,
          });
          assertOwned();
          return renderExternalTaskDiffContinuationSatisfied(
            context.session.sessionId,
            current,
            response,
            finalAssurance,
          );
        }),
      taskDiffReviewLifecycleOptions(initialContext, requestedSessionId),
    );
  }

  function reconcileExternalTaskDiffReview(
    cwd: string,
    requestedSessionId: string,
    options: ReconcileExternalTaskDiffReviewOptions = {},
  ): TaskDiffReviewInspectionStatus {
    const status = inspectTaskDiffReviewStatus(cwd, requestedSessionId);
    if (status.state !== 'external-reconciliation-required') {
      throw externalTaskDiffReconciliationNotAvailable();
    }
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const grantInspection = readCollaborationGrantInspection(
      context.git.gitCommonDirectory,
      status.grantId,
    );
    if (
      status.grantState !== 'consumed' ||
      grantInspection?.state !== 'consumed' ||
      grantInspection.use === undefined ||
      grantInspection.signedEnvelopeDigest !== status.grantEnvelopeDigest ||
      grantInspection.transitionDigest !== status.transitionDigest ||
      grantInspection.degradedForm !== status.degradedForm ||
      grantInspection.use.signedEnvelopeDigest !== status.grantEnvelopeDigest ||
      grantInspection.use.transitionDigest !== status.transitionDigest ||
      grantInspection.use.degradedForm !== status.degradedForm ||
      (status.degradedForm === 'direct-human-review') !==
        (grantInspection.use.directHumanReviewAttestation !== null)
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const collaborationGrant = {
      grantId: status.grantId,
      ...(grantInspection.use.directHumanReviewAttestation === null
        ? {}
        : {
            directHumanReviewAttestation:
              grantInspection.use.directHumanReviewAttestation,
          }),
      ...(options.consumedReplayVerifier === undefined
        ? {}
        : { consumedReplayVerifier: options.consumedReplayVerifier }),
    };
    const consumedRoleResultReplay =
      options.consumedRoleResultReplay === undefined
        ? {}
        : { consumedRoleResultReplay: options.consumedRoleResultReplay };

    if (status.source === 'external') {
      const reservation = requireExternalTaskDiffReviewReservation(
        runtime,
        status.subject.subjectDigest,
        status.grantEnvelopeDigest,
      );
      const submission = readTaskDiffExternalReviewSubmission(
        runtime,
        status.subject.subjectDigest,
        status.reviewScopeDigest,
        status.inputDigest,
      );
      if (
        reservation.reservationDigest !== status.reservationDigest ||
        reservation.grant.grantId !== status.grantId ||
        reservation.grant.grantEnvelopeDigest !== status.grantEnvelopeDigest ||
        reservation.grant.grantTransitionDigest !== status.transitionDigest ||
        reservation.grant.grantTargetDigest !==
          grantInspection.use.targetDigest ||
        submission === null ||
        submission.recordDigest !== status.submissionRecordDigest
      ) {
        throw externalTaskDiffAuthorityInvalid();
      }
      const input = parseTaskDiffReviewExternalSubmissionInput({
        schemaVersion: 1,
        kind: 'task-diff-review-submission-input.v1',
        subjectDigest: status.subject.subjectDigest,
        submission: submission.submission,
      });
      if (sha256(canonicalJson(input)) !== status.inputDigest) {
        throw externalTaskDiffAuthorityInvalid();
      }
      return submitExternalTaskDiffReview(cwd, requestedSessionId, input, {
        ...externalTaskDiffActorReplayOptions(reservation.implementationActor),
        ...consumedRoleResultReplay,
        collaborationGrant,
      });
    }

    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: status.subject.subjectDigest,
      reviewRecordDigest: status.review.recordDigest,
      responseDigest: status.response.responseDigest,
    });
    const reservation = requireExternalTaskDiffContinuationReservation(
      runtime,
      targetDigest,
      status.grantEnvelopeDigest,
    );
    const response = readTaskDiffExternalChallengeResponse(
      runtime,
      status.subject.subjectDigest,
      status.review.recordDigest,
      status.response.responseDigest,
    );
    const submission = readTaskDiffExternalClosureSubmission(
      runtime,
      targetDigest,
      status.inputDigest,
    );
    if (
      reservation.reservationDigest !== status.reservationDigest ||
      reservation.grant.grantId !== status.grantId ||
      reservation.grant.grantEnvelopeDigest !== status.grantEnvelopeDigest ||
      reservation.grant.grantTransitionDigest !== status.transitionDigest ||
      reservation.grant.grantTargetDigest !==
        grantInspection.use.targetDigest ||
      response === null ||
      canonicalJson(response.response) !== canonicalJson(status.response) ||
      submission === null ||
      submission.subjectDigest !== status.subject.subjectDigest ||
      submission.reviewRecordDigest !== status.review.recordDigest ||
      submission.responseDigest !== status.response.responseDigest
    ) {
      throw externalTaskDiffAuthorityInvalid();
    }
    const input = parseTaskDiffReviewExternalClosureInput({
      schemaVersion: 1,
      kind: 'task-diff-review-closure-input.v1',
      subjectDigest: status.subject.subjectDigest,
      reviewRecordDigest: status.review.recordDigest,
      responseDigest: status.response.responseDigest,
      proposedDispositions: submission.submission.proposedDispositions,
    });
    if (sha256(canonicalJson(input)) !== status.inputDigest) {
      throw externalTaskDiffAuthorityInvalid();
    }
    return submitExternalTaskDiffReviewContinuation(
      cwd,
      requestedSessionId,
      response.response,
      input,
      {
        ...consumedRoleResultReplay,
        collaborationGrant,
      },
    );
  }

  function resumeDirectHumanTaskDiffReview(
    cwd: string,
    requestedSessionId: string,
    inputCandidate:
      | TaskDiffReviewExternalSubmissionInput
      | TaskDiffReviewExternalClosureRequestInput,
    requestedGrantId: string,
    options: Readonly<{
      now?: Date;
      signer?: MaintainerSignerProvider;
      verifier?: unknown;
      consumedReplayVerifier?: unknown;
      consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
    }> = {},
  ):
    | TaskDiffReviewInspectionStatus
    | TaskDiffReviewExternalContinuationLifecycleStatus {
    if (inputCandidate.kind === 'task-diff-review-submission-input.v1') {
      const input = parseTaskDiffReviewExternalSubmissionInput(inputCandidate);
      return resumeDirectHumanInitialTaskDiffReview(
        cwd,
        requestedSessionId,
        input,
        requestedGrantId,
        options,
      );
    }
    const input =
      parseTaskDiffReviewExternalClosureRequestInput(inputCandidate);
    return resumeDirectHumanTaskDiffReviewClosure(
      cwd,
      requestedSessionId,
      input,
      requestedGrantId,
      options,
    );
  }

  function resumeDirectHumanInitialTaskDiffReview(
    cwd: string,
    requestedSessionId: string,
    input: TaskDiffReviewExternalSubmissionInput,
    requestedGrantId: string,
    options: Readonly<{
      now?: Date;
      signer?: MaintainerSignerProvider;
      verifier?: unknown;
      consumedReplayVerifier?: unknown;
      consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
    }>,
  ): TaskDiffReviewInspectionStatus {
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const inputDigest = sha256(canonicalJson(input));
    const binding = readTaskDiffExternalReviewBinding(
      runtime,
      input.subjectDigest,
    );
    if (binding !== null) {
      if (
        binding.grant.degradedForm !== 'direct-human-review' ||
        binding.grant.grantId !== requestedGrantId ||
        binding.inputDigest !== inputDigest
      ) {
        throw directHumanTaskDiffResumeInvalid();
      }
      const reservation = requireExternalTaskDiffReviewReservation(
        runtime,
        input.subjectDigest,
        binding.grant.grantEnvelopeDigest,
      );
      return submitExternalTaskDiffReview(cwd, requestedSessionId, input, {
        ...externalTaskDiffActorReplayOptions(reservation.implementationActor),
        ...(options.consumedRoleResultReplay === undefined
          ? {}
          : {
              consumedRoleResultReplay: options.consumedRoleResultReplay,
            }),
      });
    }

    const status = inspectTaskDiffReviewStatus(cwd, requestedSessionId);
    if (
      status.state !== 'direct-human-attestation-required' ||
      status.source !== 'external' ||
      status.grantId !== requestedGrantId ||
      status.inputDigest !== inputDigest ||
      status.subject.subjectDigest !== input.subjectDigest
    ) {
      throw directHumanTaskDiffResumeInvalid();
    }
    const reservation = requireExternalTaskDiffReviewReservation(
      runtime,
      input.subjectDigest,
      status.grantEnvelopeDigest,
    );
    assertDirectHumanTaskDiffPause(
      context,
      reservation.grant,
      requestedGrantId,
      status.transitionDigest,
      status.reviewNodeId,
      status.reviewResultDigest,
    );
    const grant = readReservedCollaborationGrant(
      context.git.gitCommonDirectory,
      requestedGrantId,
    );
    if (
      collaborationGrantEnvelopeDigest(grant.envelope) !==
        status.grantEnvelopeDigest ||
      grant.transitionDigest !== status.transitionDigest
    ) {
      throw directHumanTaskDiffResumeInvalid();
    }
    const attestation = createDirectHumanReviewAttestation(
      cwd,
      {
        grantEnvelope: grant.envelope,
        transitionDigest: status.transitionDigest,
        reviewNodeId: status.reviewNodeId,
        reviewResultDigest: status.reviewResultDigest,
      },
      options,
    );
    const verifier = resolveAuthoritativeCollaborationGrantVerifier(
      options.verifier,
    );
    return submitExternalTaskDiffReview(cwd, requestedSessionId, input, {
      ...externalTaskDiffActorReplayOptions(reservation.implementationActor),
      ...(options.consumedRoleResultReplay === undefined
        ? {}
        : { consumedRoleResultReplay: options.consumedRoleResultReplay }),
      collaborationGrant: {
        grantId: requestedGrantId,
        ...(options.now === undefined ? {} : { now: options.now }),
        directHumanReviewAttestation: attestation,
        verifier,
        ...(options.consumedReplayVerifier === undefined
          ? {}
          : { consumedReplayVerifier: options.consumedReplayVerifier }),
      },
    });
  }

  function resumeDirectHumanTaskDiffReviewClosure(
    cwd: string,
    requestedSessionId: string,
    input: TaskDiffReviewExternalClosureRequestInput,
    requestedGrantId: string,
    options: Readonly<{
      now?: Date;
      signer?: MaintainerSignerProvider;
      verifier?: unknown;
      consumedReplayVerifier?: unknown;
      consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
    }>,
  ): TaskDiffReviewExternalContinuationLifecycleStatus {
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const current = loadCurrentAuthenticatedTaskDiffReview(
      cwd,
      requestedSessionId,
      options,
    );
    if (
      input.subjectDigest !== current.review.subjectDigest ||
      input.reviewRecordDigest !== current.review.recordDigest
    ) {
      throw directHumanTaskDiffResumeInvalid();
    }
    const response = createTaskDiffReviewChallengeResponse({
      review: current.review,
      responses: input.responses,
    });
    const closureInput = parseTaskDiffReviewExternalClosureInput({
      schemaVersion: 1,
      kind: 'task-diff-review-closure-input.v1',
      subjectDigest: input.subjectDigest,
      reviewRecordDigest: input.reviewRecordDigest,
      responseDigest: response.responseDigest,
      proposedDispositions: input.proposedDispositions,
    });
    const inputDigest = sha256(canonicalJson(closureInput));
    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: current.review.subjectDigest,
      reviewRecordDigest: current.review.recordDigest,
      responseDigest: response.responseDigest,
    });
    const binding = readTaskDiffExternalContinuationBinding(
      runtime,
      targetDigest,
    );
    if (binding !== null) {
      if (
        binding.grant.degradedForm !== 'direct-human-review' ||
        binding.grant.grantId !== requestedGrantId ||
        binding.inputDigest !== inputDigest
      ) {
        throw directHumanTaskDiffResumeInvalid();
      }
      return submitExternalTaskDiffReviewContinuation(
        cwd,
        requestedSessionId,
        response,
        closureInput,
        {
          ...(options.consumedRoleResultReplay === undefined
            ? {}
            : {
                consumedRoleResultReplay: options.consumedRoleResultReplay,
              }),
        },
      );
    }

    const status = inspectTaskDiffReviewStatus(cwd, requestedSessionId);
    if (
      (status.state !== 'direct-human-attestation-required' &&
        status.state !== 'external-reconciliation-required') ||
      status.source !== 'external-continuation' ||
      status.grantId !== requestedGrantId ||
      status.inputDigest !== inputDigest ||
      status.review.recordDigest !== input.reviewRecordDigest ||
      status.response.responseDigest !== response.responseDigest
    ) {
      throw directHumanTaskDiffResumeInvalid();
    }
    const reservation = requireExternalTaskDiffContinuationReservation(
      runtime,
      targetDigest,
      status.grantEnvelopeDigest,
    );
    assertDirectHumanTaskDiffPause(
      context,
      reservation.grant,
      requestedGrantId,
      status.transitionDigest,
      status.contentNodeId,
      status.contentResultDigest,
    );

    let attestation: DirectHumanReviewAttestation;
    const grantInspection = readCollaborationGrantInspection(
      context.git.gitCommonDirectory,
      requestedGrantId,
    );
    if (status.state === 'direct-human-attestation-required') {
      if (grantInspection?.state !== 'reserved') {
        throw directHumanTaskDiffResumeInvalid();
      }
      const grant = readReservedCollaborationGrant(
        context.git.gitCommonDirectory,
        requestedGrantId,
      );
      if (
        collaborationGrantEnvelopeDigest(grant.envelope) !==
          status.grantEnvelopeDigest ||
        grant.transitionDigest !== status.transitionDigest
      ) {
        throw directHumanTaskDiffResumeInvalid();
      }
      attestation = createDirectHumanReviewAttestation(
        cwd,
        {
          grantEnvelope: grant.envelope,
          transitionDigest: status.transitionDigest,
          reviewNodeId: status.contentNodeId,
          reviewResultDigest: status.contentResultDigest,
        },
        options,
      );
    } else {
      if (
        status.degradedForm !== 'direct-human-review' ||
        grantInspection?.state !== 'consumed' ||
        grantInspection.use?.directHumanReviewAttestation === null ||
        grantInspection.use?.directHumanReviewAttestation === undefined
      ) {
        throw directHumanTaskDiffResumeInvalid();
      }
      attestation = grantInspection.use.directHumanReviewAttestation;
    }
    return submitExternalTaskDiffReviewContinuation(
      cwd,
      requestedSessionId,
      response,
      closureInput,
      {
        ...(options.consumedRoleResultReplay === undefined
          ? {}
          : { consumedRoleResultReplay: options.consumedRoleResultReplay }),
        collaborationGrant: {
          grantId: requestedGrantId,
          ...(options.now === undefined ? {} : { now: options.now }),
          directHumanReviewAttestation: attestation,
          ...(options.consumedReplayVerifier === undefined
            ? {}
            : { consumedReplayVerifier: options.consumedReplayVerifier }),
          ...(grantInspection.state === 'reserved'
            ? {
                verifier: resolveAuthoritativeCollaborationGrantVerifier(
                  options.verifier,
                ),
              }
            : {}),
        },
      },
    );
  }

  function assertDirectHumanTaskDiffPause(
    context: ReturnType<typeof loadActiveSessionContext>,
    grant: TaskDiffExternalReviewReservation['grant'],
    requestedGrantId: string,
    transitionDigest: string,
    contentNodeId: string,
    contentResultDigest: string,
  ): void {
    const inspection = readCollaborationGrantInspection(
      context.git.gitCommonDirectory,
      requestedGrantId,
    );
    if (
      grant.degradedForm !== 'direct-human-review' ||
      grant.grantId !== requestedGrantId ||
      grant.grantTransitionDigest !== transitionDigest ||
      inspection === null ||
      (inspection.state !== 'reserved' && inspection.state !== 'consumed') ||
      inspection.degradedForm !== 'direct-human-review' ||
      inspection.signedEnvelopeDigest !== grant.grantEnvelopeDigest ||
      inspection.transitionDigest !== transitionDigest ||
      !/^[0-9a-f]{64}$/u.test(contentNodeId) ||
      !/^[0-9a-f]{64}$/u.test(contentResultDigest)
    ) {
      throw directHumanTaskDiffResumeInvalid();
    }
  }
  return {
    submitExternalTaskDiffReview,
    submitExternalTaskDiffReviewContinuation,
    reconcileExternalTaskDiffReview,
    resumeDirectHumanTaskDiffReview,
  };
}
