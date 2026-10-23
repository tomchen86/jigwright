/**
 * Begins and reconciles provider reviews and their continuation results.
 *
 * Invariants:
 * - Review admission must retain the subject inspected before the lifecycle
 *   operation.
 */
import {
  candidateDiverged,
  taskDiffReviewLineageConflict,
  continuationNotStarted,
  reviewNotStarted,
  reviewNotSatisfied,
  collaborationTransitionDigest,
  resolveAuthoritativeCollaborationGrantVerifier,
  type TaskDiffReviewConsumedReplayValidation,
} from '../../modules/assurance/task-diff-review-values.ts';
import { sha256 } from '../../modules/assurance/task-diff-review-binding-record.ts';
import type { TaskDiffReviewReservationRecord } from '../../modules/assurance/task-diff-review-binding-record.ts';

// Begin and reconcile provider reviews, preserving durable result and replay order.
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { listProviderIds } from '../../modules/provider-orchestration/provider-registry.ts';
import { type TaskDiffReviewChallengeResponseInput } from '../../modules/assurance/task-diff-review-input.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  createTaskDiffReviewChallengeResponse,
  assertTaskDiffReviewChallengeResponseCurrent,
  assertTaskDiffReviewContinuationSubmissionCurrent,
  parseTaskDiffReviewContinuationSubmission,
  createTaskDiffReviewRecord,
  completeTaskDiffReviewProviderSubmission,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import type {
  TaskDiffReviewChallengeResponseRecord,
  TaskDiffReviewRecord,
} from '../../modules/assurance/task-diff-review-artifact-record.ts';
import { TASK_DIFF_REVIEW_POLICY_DIGEST } from '../../modules/assurance/task-diff-review.ts';
import { type AdmittedRoleResult } from '../../modules/provider-orchestration/role-admission-contracts.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type {
  TaskDiffReviewRuntimeBindings,
  TaskDiffReviewRuntimeData,
} from './task-diff-review-lifecycle.ts';
import type {
  BeginTaskDiffReviewOptions,
  TaskDiffReviewInspectionStatus,
  TaskDiffReviewContinuationLifecycleStatus,
  ReconcileTaskDiffReviewContinuationOptions,
  ReconcileTaskDiffReviewOptions,
} from './task-diff-review-contracts.ts';
import type { createTaskDiffReviewCommonModule } from './task-diff-review-common.ts';
import type { createTaskDiffReviewSubjectModule } from './task-diff-review-subject.ts';
import type { createTaskDiffReviewExternalBindingModule } from './task-diff-review-external-binding.ts';
import type { createTaskDiffReviewProviderBindingModule } from './task-diff-review-provider-binding.ts';
import type { createTaskDiffReviewLineageModule } from './task-diff-review-lineage.ts';
import type { createTaskDiffReviewInspectionModule } from './task-diff-review-inspection.ts';
import type { createTaskDiffReviewProviderReservationsModule } from './task-diff-review-provider-reservations.ts';

type CollaborationGrantUseProjection =
  TaskDiffReviewRuntimeData['CollaborationGrantUseProjection'];

export function createTaskDiffReviewProviderCommandsModule(
  runtime: TaskDiffReviewRuntimeBindings,
  common: ReturnType<typeof createTaskDiffReviewCommonModule>,
  subject: ReturnType<typeof createTaskDiffReviewSubjectModule>,
  externalBinding: ReturnType<typeof createTaskDiffReviewExternalBindingModule>,
  providerBinding: ReturnType<typeof createTaskDiffReviewProviderBindingModule>,
  lineage: ReturnType<typeof createTaskDiffReviewLineageModule>,
  inspection: ReturnType<typeof createTaskDiffReviewInspectionModule>,
  providerReservations: ReturnType<
    typeof createTaskDiffReviewProviderReservationsModule
  >,
  roleResultAdmission: Pick<RoleAdmissionServices, 'admitRoleResult'>,
) {
  const { admitRoleResult } = roleResultAdmission;
  const {
    loadActiveSessionContext,
    withRepositoryLifecycleOperation,
    withSessionOperation,
    loadInvestigationRuntimeContext,
    readTaskDiffExternalReviewBinding,
    readTaskDiffReviewContinuationReservation,
    listAllTaskDiffExternalContinuationBindings,
    listAllTaskDiffExternalContinuationReservations,
    readTaskDiffReviewContinuationResultBinding,
    readProviderInvocation,
    readEvidenceNode,
    createEvidenceNode,
    writeEvidenceNode,
    createTaskDiffReviewContinuationResultBinding,
    readTaskDiffReviewReservation,
    readTaskDiffReviewResultBinding,
    createTaskDiffReviewResultBinding,
    consumeCollaborationGrantUnderLifecycleLock,
  } = runtime;
  const {
    assertTaskDiffReviewLifecycleGrantCurrent,
    taskDiffReviewLifecycleOptions,
    baselineAdapterPolicy,
    parseBaselineJson,
  } = common;
  const {
    inspectTaskDiffReviewSubject,
    resolveTaskDiffImplementationActor,
    bindDocumentationRemediation,
  } = subject;
  const { assertCurrentExternalTaskDiffReviewBinding, inspectExternalGrant } =
    externalBinding;
  const {
    assertReservationCurrent,
    assertContinuationReservationCurrent,
    assertCurrentTaskDiffReviewContinuationBinding,
    ensureTaskDiffFinalAssurance,
    assertCurrentTaskDiffReviewBinding,
    taskDiffReviewGrantRequest,
    deriveTaskDiffCollaborationGrantBinding,
  } = providerBinding;
  const {
    readExactProviderTaskDiffReviewSource,
    assertNoAllSessionProviderSourceCollision,
    resolveTaskDiffReviewCandidatePlan,
    loadReusedTaskDiffReview,
    loadCurrentTaskDiffReview,
    ensureTaskDiffReviewSupersession,
  } = lineage;
  const {
    renderReusedTaskDiffReviewStatus,
    inspectExternalTaskDiffPendingStatus,
    renderTaskDiffReviewStatus,
    renderTaskDiffReviewContinuationStatus,
  } = inspection;
  const {
    createNewTaskDiffReviewReservation,
    ensureTaskDiffReviewInvocation,
    createNewTaskDiffReviewContinuationReservation,
    ensureTaskDiffReviewContinuationInvocation,
  } = providerReservations;
  function beginTaskDiffReview(
    cwd: string,
    requestedSessionId: string,
    options: BeginTaskDiffReviewOptions = {},
  ): TaskDiffReviewInspectionStatus {
    const initialSubject = inspectTaskDiffReviewSubject(
      cwd,
      requestedSessionId,
    );
    if (!initialSubject.reviewRequirement.required) {
      return Object.freeze({
        state: 'not-required',
        sessionId: requestedSessionId,
        subject: initialSubject,
      });
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
          const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
          if (canonicalJson(subject) !== canonicalJson(initialSubject)) {
            throw candidateDiverged();
          }
          const runtime = loadInvestigationRuntimeContext(cwd).runtime;
          const implementationActor = resolveTaskDiffImplementationActor(
            cwd,
            requestedSessionId,
            subject,
            options,
          );
          if (
            canonicalJson(implementationActor) !==
            canonicalJson(initialImplementationActor)
          ) {
            throw candidateDiverged();
          }
          const externalBinding = readTaskDiffExternalReviewBinding(
            runtime,
            subject.subjectDigest,
          );
          const providerSource = readExactProviderTaskDiffReviewSource(
            runtime,
            context.session.sessionId,
            subject.subjectDigest,
          );
          const existing = providerSource.reservation;
          if (externalBinding !== null) {
            assertNoAllSessionProviderSourceCollision(
              runtime,
              subject.subjectDigest,
            );
            if (existing !== null || providerSource.binding !== null)
              throw taskDiffReviewLineageConflict();
            assertCurrentExternalTaskDiffReviewBinding(
              context,
              runtime,
              subject,
              externalBinding,
              assertOwned,
              'governing',
              options,
            );
            const candidatePlan = resolveTaskDiffReviewCandidatePlan(
              context,
              runtime,
              subject,
              'governing',
              options,
            );
            if (candidatePlan.action !== 'reuse') {
              throw taskDiffReviewLineageConflict();
            }
            return renderReusedTaskDiffReviewStatus(
              context.session.sessionId,
              subject,
              loadReusedTaskDiffReview(
                runtime,
                context,
                subject,
                candidatePlan,
                'governing',
                options,
              ),
            );
          }
          const externalPending = inspectExternalTaskDiffPendingStatus(
            context,
            runtime,
            subject,
          );
          if (externalPending !== null) {
            assertNoAllSessionProviderSourceCollision(
              runtime,
              subject.subjectDigest,
            );
            if (existing !== null || providerSource.binding !== null)
              throw taskDiffReviewLineageConflict();
            return externalPending;
          }
          if (providerSource.binding !== null) {
            const candidatePlan = resolveTaskDiffReviewCandidatePlan(
              context,
              runtime,
              subject,
              'governing',
              options,
            );
            if (candidatePlan.action !== 'reuse') {
              throw taskDiffReviewLineageConflict();
            }
            return renderReusedTaskDiffReviewStatus(
              context.session.sessionId,
              subject,
              loadReusedTaskDiffReview(
                runtime,
                context,
                subject,
                candidatePlan,
                'governing',
                options,
              ),
            );
          }
          const candidatePlan =
            existing === null
              ? resolveTaskDiffReviewCandidatePlan(
                  context,
                  runtime,
                  subject,
                  'governing',
                  options,
                )
              : null;
          if (candidatePlan?.action === 'reuse') {
            return renderReusedTaskDiffReviewStatus(
              context.session.sessionId,
              subject,
              loadReusedTaskDiffReview(
                runtime,
                context,
                subject,
                candidatePlan,
                'governing',
                options,
              ),
            );
          }
          const created =
            existing ??
            createNewTaskDiffReviewReservation(
              context,
              runtime,
              subject,
              candidatePlan!,
              implementationActor,
              options.collaborationGrant,
              assertOwned,
            );
          if (
            created.kind === 'task-diff-review-collaboration-grant-required'
          ) {
            return created.status;
          }
          const reservation = created;
          assertReservationCurrent(
            context,
            subject,
            implementationActor,
            reservation,
          );
          ensureTaskDiffReviewInvocation(
            context,
            runtime,
            reservation,
            assertOwned,
          );
          assertOwned();
          return renderTaskDiffReviewStatus(runtime, reservation);
        }),
      taskDiffReviewLifecycleOptions(initialContext, requestedSessionId),
    );
  }

  function beginTaskDiffReviewContinuationFromInput(
    cwd: string,
    requestedSessionId: string,
    input: TaskDiffReviewChallengeResponseInput,
    validation: TaskDiffReviewConsumedReplayValidation = {},
  ): TaskDiffReviewContinuationLifecycleStatus {
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const current = loadCurrentTaskDiffReview(context, runtime, validation);
    if (input.reviewRecordDigest !== current.review.recordDigest) {
      throw workflowError(
        'TASK_DIFF_REVIEW_RESPONSE_INPUT_STALE',
        'TaskDiffReview challenge response input does not name the current exact review record.',
        ExitCode.staleState,
      );
    }
    const response = createTaskDiffReviewChallengeResponse({
      review: current.review,
      responses: input.responses,
    });
    return beginTaskDiffReviewContinuation(
      cwd,
      context.session.sessionId,
      response,
      validation,
    );
  }

  function beginTaskDiffReviewContinuation(
    cwd: string,
    requestedSessionId: string,
    responseCandidate: TaskDiffReviewChallengeResponseRecord,
    validation: TaskDiffReviewConsumedReplayValidation = {},
  ): TaskDiffReviewContinuationLifecycleStatus {
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
          const current = loadCurrentTaskDiffReview(
            context,
            runtime,
            validation,
          );
          const response = assertTaskDiffReviewChallengeResponseCurrent(
            current.review,
            responseCandidate,
          );
          assertNoExternalTaskDiffContinuationCollision(
            context,
            runtime,
            current.review,
          );
          const existing = readTaskDiffReviewContinuationReservation(
            runtime,
            context.session.sessionId,
            current.review.recordDigest,
          );
          const reservation =
            existing ??
            createNewTaskDiffReviewContinuationReservation(
              context,
              runtime,
              current,
              response,
            );
          assertContinuationReservationCurrent(
            context,
            current,
            response,
            reservation,
          );
          ensureTaskDiffReviewContinuationInvocation(
            context,
            runtime,
            reservation,
            assertOwned,
          );
          assertOwned();
          return renderTaskDiffReviewContinuationStatus(
            runtime,
            reservation,
            current,
          );
        }),
      taskDiffReviewLifecycleOptions(initialContext, requestedSessionId),
    );
  }

  function assertNoExternalTaskDiffContinuationCollision(
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    review: TaskDiffReviewRecord,
  ): void {
    if (
      listAllTaskDiffExternalContinuationBindings(runtime).some(
        (binding) => binding.reviewRecordDigest === review.recordDigest,
      )
    ) {
      throw taskDiffReviewLineageConflict();
    }
    for (const attempt of listAllTaskDiffExternalContinuationReservations(
      runtime,
    ).filter(
      (reservation) => reservation.reviewRecordDigest === review.recordDigest,
    )) {
      const inspection = inspectExternalGrant(
        context.git.gitCommonDirectory,
        attempt.grant.grantId,
      );
      if (inspection.state === 'reserved' || inspection.state === 'consumed') {
        throw taskDiffReviewLineageConflict();
      }
    }
  }

  function reconcileTaskDiffReviewContinuation(
    cwd: string,
    requestedSessionId: string,
    requestedResponseDigest: string,
    options: ReconcileTaskDiffReviewContinuationOptions = {},
  ): TaskDiffReviewContinuationLifecycleStatus {
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
          const current = loadCurrentTaskDiffReview(context, runtime, options);
          const reservation = readTaskDiffReviewContinuationReservation(
            runtime,
            context.session.sessionId,
            current.review.recordDigest,
          );
          if (reservation === null) throw continuationNotStarted();
          if (reservation.response.responseDigest !== requestedResponseDigest) {
            throw continuationNotStarted();
          }
          assertContinuationReservationCurrent(
            context,
            current,
            reservation.response,
            reservation,
          );
          let binding = readTaskDiffReviewContinuationResultBinding(
            runtime,
            context.session.sessionId,
            current.review.recordDigest,
          );
          if (binding !== null) {
            assertCurrentTaskDiffReviewContinuationBinding(
              runtime,
              reservation,
              binding.submission,
            );
          } else {
            const invocation = readProviderInvocation(
              runtime,
              reservation.request.invocationId,
            );
            if (
              invocation.state !== 'succeeded' ||
              invocation.result === null
            ) {
              return renderTaskDiffReviewContinuationStatus(
                runtime,
                reservation,
                current,
              );
            }
            if (invocation.result.runtimeObservation === null) {
              throw workflowError(
                'TASK_DIFF_REVIEW_PROVIDER_OBSERVATION_REQUIRED',
                'TaskDiffReview continuation authority requires a fixed-runner repository observation.',
                ExitCode.verification,
              );
            }
            const submission =
              assertTaskDiffReviewContinuationSubmissionCurrent(
                current.review,
                reservation.response,
                parseTaskDiffReviewContinuationSubmission(
                  invocation.result.output,
                ),
              );
            const authorization = readEvidenceNode(
              runtime,
              reservation.authorizationNodeId,
            );
            const requestReservation = readEvidenceNode(
              runtime,
              reservation.reservationNodeId,
            );
            const resultNode = createEvidenceNode({
              type: 'task-diff-review-continuation-provider-result',
              nodeSchema:
                'workflow.task-diff-review-continuation-provider-result.v1',
              evaluator: 'workflow-task-diff-review.v1',
              policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
              exactInputDigests: {
                output: invocation.result.outputDigest,
                request: reservation.request.requestDigest,
                response: reservation.response.responseDigest,
                review: reservation.review.recordDigest,
                runtimeObservation: sha256(
                  canonicalJson(invocation.result.runtimeObservation),
                ),
                subject: reservation.subject.subjectDigest,
              },
              semanticParentResultDigests: {
                authorization: authorization.resultDigest,
                reservation: requestReservation.resultDigest,
              },
              provenanceParentNodeIds: {
                authorization: authorization.nodeId,
                reservation: requestReservation.nodeId,
              },
              outputSchema:
                'workflow.task-diff-review-continuation-provider-result-output.v1',
              output: {
                ownerInvestigationId: reservation.ownerInvestigationId,
                sessionId: reservation.sessionId,
                invocationId: invocation.invocationId,
                requestDigest: reservation.request.requestDigest,
                outputDigest: invocation.result.outputDigest,
                responseDigest: reservation.response.responseDigest,
                submission,
              },
              runtimeMetadata: {
                runtimeObservation: invocation.result.runtimeObservation,
              },
            });
            writeEvidenceNode(runtime, resultNode);
            binding = createTaskDiffReviewContinuationResultBinding(runtime, {
              ownerInvestigationId: reservation.ownerInvestigationId,
              sessionId: reservation.sessionId,
              subjectDigest: reservation.subject.subjectDigest,
              reviewRecordDigest: reservation.review.recordDigest,
              responseDigest: reservation.response.responseDigest,
              invocationId: invocation.invocationId,
              requestDigest: reservation.request.requestDigest,
              outputDigest: invocation.result.outputDigest,
              runtimeObservationDigest: sha256(
                canonicalJson(invocation.result.runtimeObservation),
              ),
              providerResultNodeId: resultNode.nodeId,
              providerResultDigest: resultNode.resultDigest,
              submission,
              createdAt: invocation.updatedAt,
            });
            if (options.testCrashAfter === 'advisory-result-persisted') {
              throw new Error(
                'Simulated TaskDiffReview continuation interruption after advisory result persistence.',
              );
            }
          }
          ensureTaskDiffFinalAssurance(runtime, current, reservation, binding);
          assertOwned();
          return renderTaskDiffReviewContinuationStatus(
            runtime,
            reservation,
            current,
          );
        }),
      taskDiffReviewLifecycleOptions(initialContext, requestedSessionId),
    );
  }

  function reconcileTaskDiffReview(
    cwd: string,
    requestedSessionId: string,
    options: ReconcileTaskDiffReviewOptions = {},
  ): TaskDiffReviewInspectionStatus {
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
          const subject = inspectTaskDiffReviewSubject(cwd, requestedSessionId);
          if (!subject.reviewRequirement.required) {
            return Object.freeze({
              state: 'not-required' as const,
              sessionId: context.session.sessionId,
              subject,
            });
          }
          const runtime = loadInvestigationRuntimeContext(cwd).runtime;
          const reservation = readTaskDiffReviewReservation(
            runtime,
            context.session.sessionId,
            subject.subjectDigest,
          );
          if (reservation === null) throw reviewNotStarted();
          assertReservationCurrent(
            context,
            subject,
            reservation.implementationActor,
            reservation,
          );
          const existing = readTaskDiffReviewResultBinding(
            runtime,
            context.session.sessionId,
            subject.subjectDigest,
          );
          if (existing !== null) {
            assertCurrentTaskDiffReviewBinding(
              runtime,
              reservation,
              existing.review,
              'governing',
              options.collaborationGrantValidation,
            );
            ensureTaskDiffReviewSupersession(
              context,
              runtime,
              existing,
              options.collaborationGrantValidation,
            );
            bindDocumentationRemediation(
              cwd,
              requestedSessionId,
              existing.review,
            );
            return renderTaskDiffReviewStatus(runtime, reservation);
          }
          const invocation = readProviderInvocation(
            runtime,
            reservation.request.invocationId,
          );
          if (invocation.state !== 'succeeded' || invocation.result === null) {
            return renderTaskDiffReviewStatus(runtime, reservation);
          }
          if (invocation.result.runtimeObservation === null) {
            throw workflowError(
              'TASK_DIFF_REVIEW_PROVIDER_OBSERVATION_REQUIRED',
              'TaskDiffReview authority requires a fixed-runner repository observation.',
              ExitCode.verification,
            );
          }
          const authorization = readEvidenceNode(
            runtime,
            reservation.authorizationNodeId,
          );
          const requestReservation = readEvidenceNode(
            runtime,
            reservation.reservationNodeId,
          );
          const observationNode = createEvidenceNode({
            type: 'task-diff-review-provider-observation',
            nodeSchema: 'workflow.task-diff-review-provider-observation.v1',
            evaluator: 'workflow-task-diff-review.v1',
            policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
            exactInputDigests: {
              output: invocation.result.outputDigest,
              request: reservation.request.requestDigest,
              runtimeObservation: sha256(
                canonicalJson(invocation.result.runtimeObservation),
              ),
              subject: subject.subjectDigest,
            },
            semanticParentResultDigests: {
              authorization: authorization.resultDigest,
              reservation: requestReservation.resultDigest,
            },
            provenanceParentNodeIds: {
              authorization: authorization.nodeId,
              reservation: requestReservation.nodeId,
            },
            outputSchema:
              'workflow.task-diff-review-provider-observation-output.v1',
            output: {
              ownerInvestigationId: reservation.ownerInvestigationId,
              sessionId: reservation.sessionId,
              invocationId: invocation.invocationId,
              requestDigest: reservation.request.requestDigest,
              outputDigest: invocation.result.outputDigest,
              submission: invocation.result.output,
            },
            runtimeMetadata: {
              runtimeObservation: invocation.result.runtimeObservation,
            },
          });
          writeEvidenceNode(runtime, observationNode);
          const roleResult = admitTaskDiffReviewProviderResult({
            context,
            reservation,
            invocation: { ...invocation, result: invocation.result },
            observationNode,
            validation: options.collaborationGrantValidation,
            assertOwned,
          });
          if (
            roleResult.assignment.providerId === null ||
            roleResult.assignment.sessionId === null ||
            (roleResult.achievedIndependence !== 'provider-independent' &&
              roleResult.achievedIndependence !== 'session-independent')
          ) {
            throw reviewNotSatisfied();
          }
          const grantUseDigest =
            roleResult.grantUse === null
              ? null
              : sha256(canonicalJson(roleResult.grantUse));
          const degradedForm = roleResult.grantUse?.degradedForm ?? null;
          if (
            degradedForm !== null &&
            degradedForm !== 'same-provider-fresh-session'
          ) {
            throw reviewNotSatisfied();
          }
          const review = createTaskDiffReviewRecord({
            subject,
            reviewScope: reservation.manifest.reviewScope,
            assignment: {
              implementerPrincipalId:
                reservation.implementationActor.principalId!,
              implementerProviderId:
                reservation.implementationActor.providerId!,
              implementationSessionId: reservation.sessionId,
              reviewerPrincipalId:
                roleResult.participant.principalId ??
                `provider:${roleResult.assignment.providerId}`,
              reviewerProviderId: roleResult.assignment.providerId,
              reviewerSessionId: roleResult.assignment.sessionId,
              achievedIndependence: roleResult.achievedIndependence,
              degradedForm,
              grantUseDigest,
            },
            // The provider result holds what the reviewer wrote, so it must be
            // completed with the engine-derived fields before it is a record.
            submission: completeTaskDiffReviewProviderSubmission(
              invocation.result.output,
            ) as never,
          });
          const resultNode = createEvidenceNode({
            type: 'task-diff-review-provider-result',
            nodeSchema: 'workflow.task-diff-review-provider-result.v1',
            evaluator: 'workflow-task-diff-review.v1',
            policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
            exactInputDigests: {
              admission: roleResult.resultDigest,
              observation: observationNode.resultDigest,
              subject: subject.subjectDigest,
            },
            semanticParentResultDigests: {
              observation: observationNode.resultDigest,
            },
            provenanceParentNodeIds: { observation: observationNode.nodeId },
            outputSchema: 'workflow.task-diff-review-provider-result-output.v1',
            output: {
              ownerInvestigationId: reservation.ownerInvestigationId,
              sessionId: reservation.sessionId,
              invocationId: invocation.invocationId,
              roleResult,
              review,
            },
            runtimeMetadata: {},
          });
          writeEvidenceNode(runtime, resultNode);
          const resultBinding = createTaskDiffReviewResultBinding(runtime, {
            ownerInvestigationId: reservation.ownerInvestigationId,
            sessionId: reservation.sessionId,
            subjectDigest: subject.subjectDigest,
            invocationId: invocation.invocationId,
            requestDigest: reservation.request.requestDigest,
            outputDigest: invocation.result.outputDigest,
            runtimeObservationDigest: sha256(
              canonicalJson(invocation.result.runtimeObservation),
            ),
            providerObservationNodeId: observationNode.nodeId,
            providerObservationDigest: observationNode.resultDigest,
            providerResultNodeId: resultNode.nodeId,
            providerResultDigest: resultNode.resultDigest,
            roleResult,
            review,
            createdAt: invocation.updatedAt,
          });
          bindDocumentationRemediation(cwd, requestedSessionId, review);
          if (options.testCrashAfter === 'result-binding-persisted') {
            throw new Error(
              'Simulated TaskDiffReview interruption after result binding persistence.',
            );
          }
          ensureTaskDiffReviewSupersession(
            context,
            runtime,
            resultBinding,
            options.collaborationGrantValidation,
          );
          assertOwned();
          return renderTaskDiffReviewStatus(runtime, reservation);
        }),
      taskDiffReviewLifecycleOptions(initialContext, requestedSessionId),
    );
  }

  function admitTaskDiffReviewProviderResult(input: {
    context: ReturnType<typeof loadActiveSessionContext>;
    reservation: TaskDiffReviewReservationRecord;
    invocation: ReturnType<typeof readProviderInvocation> & {
      result: NonNullable<ReturnType<typeof readProviderInvocation>['result']>;
    };
    observationNode: ReturnType<typeof createEvidenceNode>;
    validation: ReconcileTaskDiffReviewOptions['collaborationGrantValidation'];
    assertOwned: () => void;
  }): AdmittedRoleResult {
    const assignment = input.reservation.request.roleAssignment;
    const content = {
      kind: 'task-diff-review' as const,
      nodeId: input.observationNode.nodeId,
      resultDigest: input.observationNode.resultDigest,
      outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
      evaluator: input.reservation.request.evaluatorVersion,
      policyDigest: input.reservation.request.policyDigest,
      contentDigest: input.observationNode.resultDigest,
      current: true as const,
    };
    let grantUse: CollaborationGrantUseProjection | null = null;
    let grantValidation: NonNullable<
      Parameters<typeof admitRoleResult>[0]['grantValidation']
    > | null = null;
    if ('grantId' in assignment) {
      const policy = baselineAdapterPolicy(
        input.context.git.repositoryRoot,
        input.context.session.baseline.head,
      );
      const callableProviderIds = listProviderIds().filter(
        (providerId) => policy.policy.providers[providerId].enabled,
      );
      const grantRequest = taskDiffReviewGrantRequest({
        context: input.context,
        subject: input.reservation.subject,
        implementationActor: input.reservation.implementationActor,
        callableProviderIds,
      });
      if (grantRequest === null) throw reviewNotSatisfied();
      const expectedBinding = deriveTaskDiffCollaborationGrantBinding(
        input.context.git.repositoryRoot,
        grantRequest,
      );
      const transitionDigest = collaborationTransitionDigest(expectedBinding);
      const maintainerPolicy = parseBaselineJson(
        input.context.git.repositoryRoot,
        expectedBinding.baselineCommit,
        'workflow/maintainer-policy.json',
        parseMaintainerPolicy,
      );
      const verifier = resolveAuthoritativeCollaborationGrantVerifier(
        input.validation?.verifier,
      );
      const now = input.validation?.now ?? new Date();
      const consumed = consumeCollaborationGrantUnderLifecycleLock(
        input.context.git.gitCommonDirectory,
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
          now,
          verifier,
        },
        input.assertOwned,
      );
      if (consumed.use === undefined) throw reviewNotSatisfied();
      grantUse = consumed.use;
      grantValidation = {
        now,
        expectedBinding,
        policy: maintainerPolicy,
        verifier,
        transitionDigest,
      };
    }
    return admitRoleResult({
      assignment,
      author: input.reservation.implementationActor,
      participant:
        'grantId' in assignment
          ? assignment.participant
          : {
              providerId: assignment.providerId,
              sessionId: assignment.sessionId,
              principalId: null,
              identityAssurance: 'adapter-assigned',
              engineSpawned: true,
            },
      content,
      providerInvocation: {
        invocationId: input.invocation.invocationId,
        requestDigest: input.reservation.request.requestDigest,
        outputDigest: input.invocation.result.outputDigest,
        providerId: input.reservation.request.providerId,
        sessionId: assignment.sessionId!,
        targetDigest: input.reservation.subject.subjectDigest,
        engineSpawned: true,
      },
      grantUse,
      grantValidation,
    });
  }
  return {
    beginTaskDiffReview,
    beginTaskDiffReviewContinuationFromInput,
    beginTaskDiffReviewContinuation,
    reconcileTaskDiffReviewContinuation,
    reconcileTaskDiffReview,
  };
}
