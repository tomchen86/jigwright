import {
  resolveAuthoritativeCollaborationGrantVerifier,
  collaborationTransitionDigest,
  reviewNotSatisfied,
} from '../../modules/assurance/task-diff-review-values.ts';
import { sha256 } from '../../modules/assurance/task-diff-review-binding-record.ts';
import type {
  TaskDiffReviewManifest,
  TaskDiffReviewContinuationManifest,
} from '../../modules/assurance/provider-review-manifests.ts';
import type {
  TaskDiffReviewReservationRecord,
  TaskDiffReviewContinuationReservationRecord,
} from '../../modules/assurance/task-diff-review-binding-record.ts';
import type { TaskMandateProviderAdmission } from '../../modules/authority/task-mandate-access-contract.ts';
import { listProviderIds } from '../../modules/provider-orchestration/provider-registry.ts';

/**
 * Reserves provider review and continuation invocations under lifecycle
 * authority.
 *
 * Invariants:
 * - Implementation actors require supported caller or engine provider
 *   attribution.
 */
// Reserve provider reviews and continuations under the existing lifecycle locks.
import { TASK_DIFF_REVIEW_POLICY_DIGEST } from '../../modules/assurance/task-diff-review.ts';
import type {
  TaskDiffReviewSubject,
  TaskDiffReviewCandidatePlan,
} from '../../modules/assurance/task-diff-review-record.ts';
import {
  type RecordedRoleParticipant,
  type RoleParticipant,
  scheduleOrdinaryRole,
  type ProviderRoleAssignment,
  type GrantedSameProviderRoleAssignment,
} from '../../modules/provider-orchestration/role-assignment.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { type TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import { createProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import type { TaskDiffReviewChallengeResponseRecord } from '../../modules/assurance/task-diff-review-artifact-record.ts';
import type { TaskDiffReviewRuntimeBindings } from './task-diff-review-lifecycle.ts';
import type {
  BeginTaskDiffReviewOptions,
  TaskDiffReviewCollaborationGrantRequiredStatus,
  CurrentTaskDiffReviewForProviderContinuation,
} from './task-diff-review-contracts.ts';
import type { createTaskDiffReviewCommonModule } from './task-diff-review-common.ts';
import type { createTaskDiffReviewProviderBindingModule } from './task-diff-review-provider-binding.ts';

export function createTaskDiffReviewProviderReservationsModule(
  runtime: TaskDiffReviewRuntimeBindings,
  common: ReturnType<typeof createTaskDiffReviewCommonModule>,
  providerBinding: ReturnType<typeof createTaskDiffReviewProviderBindingModule>,
  roleResultAdmission: Pick<
    RoleAdmissionServices,
    'authorizeGrantedOrdinaryRole'
  >,
  taskMandate: Pick<
    TaskMandateProviderAdmission,
    'authorizeTaskMandateProviderReservationUnderLifecycleLock'
  >,
) {
  const { authorizeTaskMandateProviderReservationUnderLifecycleLock } =
    taskMandate;
  const { authorizeGrantedOrdinaryRole } = roleResultAdmission;
  const {
    loadActiveSessionContext,
    loadInvestigationRuntimeContext,
    reserveCollaborationGrantUnderLifecycleLock,
    createEvidenceNode,
    writeEvidenceNode,
    providerInvocationManifestDigest,
    storeProviderExecutionPolicySnapshot,
    createTaskDiffReviewReservation,
    createTaskDiffReviewContinuationReservation,
    providerInvocationExists,
    readProviderInvocation,
    readProviderInvocationRequest,
    readProviderInvocationManifest,
    createProviderInvocation,
  } = runtime;
  const { baselineAdapterPolicy } = common;
  const {
    taskDiffReviewGrantRequest,
    deriveTaskDiffCollaborationGrantBinding,
  } = providerBinding;
  function createNewTaskDiffReviewReservation(
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    subject: TaskDiffReviewSubject,
    candidatePlan: TaskDiffReviewCandidatePlan,
    implementationActor: RecordedRoleParticipant,
    collaborationGrant: BeginTaskDiffReviewOptions['collaborationGrant'],
    assertOwned: () => void,
  ):
    | TaskDiffReviewReservationRecord
    | Readonly<{
        kind: 'task-diff-review-collaboration-grant-required';
        status: TaskDiffReviewCollaborationGrantRequiredStatus;
      }> {
    if (implementationActor.identityAssurance === 'maintainer-signed') {
      throw workflowError(
        'TASK_DIFF_REVIEW_ACTOR_INVALID',
        'TaskDiffReview implementation actor has unsupported assurance.',
        ExitCode.guard,
      );
    }
    const callerAttributed =
      !implementationActor.engineSpawned &&
      (implementationActor.identityAssurance === 'self-declared' ||
        implementationActor.identityAssurance === 'runtime-hint');
    const engineAttributedProvider =
      implementationActor.engineSpawned &&
      implementationActor.identityAssurance === 'adapter-assigned' &&
      implementationActor.providerId !== null &&
      implementationActor.sessionId !== null;
    if (!callerAttributed && !engineAttributedProvider) {
      throw workflowError(
        'TASK_DIFF_REVIEW_ACTOR_INVALID',
        'TaskDiffReview implementation actor has unsupported assurance.',
        ExitCode.guard,
      );
    }
    const policy = baselineAdapterPolicy(
      context.git.repositoryRoot,
      context.session.baseline.head,
    );
    const seed = sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-review-owner.v1',
        sessionId: context.session.sessionId,
        subjectDigest: subject.subjectDigest,
      }),
    );
    const providerSessionId = `provider-session-task-diff-${seed}`;
    const author: RoleParticipant = {
      providerId: implementationActor.providerId ?? undefined,
      sessionId: implementationActor.sessionId ?? undefined,
      principalId: implementationActor.principalId ?? undefined,
      identityAssurance: implementationActor.identityAssurance,
      engineSpawned: implementationActor.engineSpawned,
    };
    const scheduled = scheduleOrdinaryRole({
      role: 'task-diff-reviewer',
      author,
      targetDigest: subject.subjectDigest,
      candidates: listProviderIds().map((providerId) => ({
        providerId,
        sessionId: providerSessionId,
        enabled: policy.policy.providers[providerId].enabled,
        available: policy.policy.providers[providerId].enabled,
      })),
    });
    let assignment: ProviderRoleAssignment;
    if (scheduled.outcome !== 'assigned') {
      const callableProviderIds = listProviderIds().filter(
        (providerId) => policy.policy.providers[providerId].enabled,
      );
      const grantRequest = taskDiffReviewGrantRequest({
        context,
        subject,
        implementationActor,
        callableProviderIds,
      });
      if (collaborationGrant === undefined) {
        return Object.freeze({
          kind: 'task-diff-review-collaboration-grant-required' as const,
          status: Object.freeze({
            state: 'collaboration-grant-required' as const,
            sessionId: context.session.sessionId,
            subject,
            implementationActor,
            inputSchema: Object.freeze({
              schemaVersion: 1 as const,
              kind: 'collaboration-grant-selection' as const,
              lifecyclePhase: 'task-diff-review' as const,
              conflictingRole: 'task-diff-reviewer' as const,
              grantRequest,
              allowedDegradedForms: Object.freeze(
                grantRequest === null
                  ? (['caller-supplied', 'direct-human-review'] as const)
                  : (['same-provider-fresh-session'] as const),
              ),
              resumeOption: '--grant <grant-id>' as const,
            }),
          }),
        });
      }
      if (grantRequest === null) {
        throw workflowError(
          'COLLABORATION_GRANT_FORM_REQUIRED',
          'TaskDiffReview requires an explicitly typed caller-supplied or direct-human review grant when no provider is callable.',
          ExitCode.guard,
        );
      }
      const expectedBinding = deriveTaskDiffCollaborationGrantBinding(
        context.git.repositoryRoot,
        grantRequest,
      );
      const verifier = resolveAuthoritativeCollaborationGrantVerifier(
        collaborationGrant.verifier,
      );
      const transitionDigest = collaborationTransitionDigest(expectedBinding);
      const grantReservation = reserveCollaborationGrantUnderLifecycleLock(
        context.git.repositoryRoot,
        collaborationGrant.grantId,
        {
          transitionDigest,
          expected: expectedBinding,
          ...(collaborationGrant.now === undefined
            ? {}
            : { now: collaborationGrant.now }),
          verifier,
        },
        assertOwned,
      );
      assignment = authorizeGrantedOrdinaryRole({
        role: 'task-diff-reviewer',
        author,
        targetDigest: subject.subjectDigest,
        reservation: grantReservation,
        actualParticipant: {
          providerId: implementationActor.providerId ?? undefined,
          sessionId: providerSessionId,
          principalId: `collaboration-grant:${grantReservation.grantId}:task-diff-reviewer`,
          identityAssurance: implementationActor.identityAssurance,
          engineSpawned: true,
        },
        callableProviderIds,
      }) as GrantedSameProviderRoleAssignment;
    } else {
      assignment = scheduled.assignment;
    }
    const ownerInvestigationId = `investigation-task-diff-${seed}`;
    if (candidatePlan.action !== 'review') throw reviewNotSatisfied();
    const mandateBinding = (context.session.mandateBinding ??
      null) as TaskMandateBinding | null;
    const authorization = createEvidenceNode({
      type: 'task-diff-review-authorization',
      nodeSchema: 'workflow.task-diff-review-authorization.v1',
      evaluator: 'workflow-task-diff-review.v1',
      policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
      exactInputDigests: {
        actor: sha256(canonicalJson(implementationActor)),
        assignment: sha256(canonicalJson(assignment)),
        mandate: sha256(canonicalJson(mandateBinding)),
        session: sha256(
          canonicalJson({
            sessionId: context.session.sessionId,
            changeId: context.session.changeId,
            taskId: context.session.taskId,
          }),
        ),
        subject: subject.subjectDigest,
      },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'workflow.task-diff-review-authorization-output.v1',
      output: {
        ownerInvestigationId,
        sessionId: context.session.sessionId,
        changeId: context.session.changeId,
        taskId: context.session.taskId,
        subject,
        implementationActor,
        assignment,
        mandateBinding,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, authorization);
    const manifest: TaskDiffReviewManifest = {
      schemaVersion: 1,
      kind: 'task-diff-review-manifest',
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      sessionId: context.session.sessionId,
      repositoryId: context.config.repositoryName,
      repositoryIdentity: subject.repositoryId,
      baseCommit: context.session.baseline.head,
      baseTree: context.session.baseline.tree,
      subject,
      reviewScope: candidatePlan.scope,
      capabilityProfile: 'repository-read-only',
    };
    const request = createProviderInvocationRequest({
      invocationId: `invocation-task-diff-${seed}`,
      nonce: `task-diff-review-${seed}`,
      purpose: 'task-diff-review',
      providerId: assignment.providerId,
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: context.config.repositoryName,
      baseCommit: context.session.baseline.head,
      baseTree: context.session.baseline.tree,
      targetDigest: subject.subjectDigest,
      inputManifestDigest: providerInvocationManifestDigest(manifest),
      authorizationNodeId: authorization.nodeId,
      writeAllowedPaths: [],
      outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
      evaluatorVersion: 'task-diff-review.v1',
      policyDigest: policy.digest,
      limits: {
        timeoutMs: policy.policy.limits.timeoutMs,
        aggregateOutputBytes: policy.policy.limits.aggregateOutputBytes,
      },
    });
    const requestReservation = createEvidenceNode({
      type: 'task-diff-review-request-reservation',
      nodeSchema: 'workflow.task-diff-review-request-reservation.v1',
      evaluator: 'workflow-task-diff-review.v1',
      policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
      exactInputDigests: {
        manifest: request.inputManifestDigest,
        request: request.requestDigest,
        subject: subject.subjectDigest,
      },
      semanticParentResultDigests: {
        authorization: authorization.resultDigest,
      },
      provenanceParentNodeIds: { authorization: authorization.nodeId },
      outputSchema: 'workflow.task-diff-review-request-reservation-output.v1',
      output: {
        ownerInvestigationId,
        sessionId: context.session.sessionId,
        changeId: context.session.changeId,
        taskId: context.session.taskId,
        subject,
        implementationActor,
        assignment,
        manifest,
        request,
        mandateBinding,
      },
      runtimeMetadata: {},
    });
    storeProviderExecutionPolicySnapshot(runtime, request, policy);
    writeEvidenceNode(runtime, requestReservation);
    return createTaskDiffReviewReservation(runtime, {
      ownerInvestigationId,
      sessionId: context.session.sessionId,
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      repositoryRoot: context.git.repositoryRealPath,
      gitCommonDirectory: context.git.gitCommonDirectory,
      branch: context.session.branch,
      baseline: context.session.baseline,
      mandateBinding,
      subject,
      implementationActor,
      manifest,
      request,
      authorizationNodeId: authorization.nodeId,
      reservationNodeId: requestReservation.nodeId,
      createdAt: new Date().toISOString(),
    });
  }

  function createNewTaskDiffReviewContinuationReservation(
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    current: CurrentTaskDiffReviewForProviderContinuation,
    response: TaskDiffReviewChallengeResponseRecord,
  ): TaskDiffReviewContinuationReservationRecord {
    const review = current.review;
    const implementationActor = current.implementationActor;
    const implementationActorAssurance = implementationActor.identityAssurance;
    if (implementationActorAssurance === 'maintainer-signed') {
      throw workflowError(
        'TASK_DIFF_REVIEW_ACTOR_INVALID',
        'TaskDiffReview continuation cannot derive provider scheduling from a maintainer-signed implementation actor.',
        ExitCode.guard,
      );
    }
    const policy = baselineAdapterPolicy(
      context.git.repositoryRoot,
      context.session.baseline.head,
    );
    const seed = sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-review-continuation-owner.v1',
        sessionId: context.session.sessionId,
        subjectDigest: review.subjectDigest,
        reviewRecordDigest: review.recordDigest,
        responseDigest: response.responseDigest,
      }),
    );
    const providerSessionId = `provider-session-task-diff-continuation-${seed}`;
    const preferredProviderId = review.assignment.reviewerProviderId;
    if (
      preferredProviderId !== null &&
      preferredProviderId !== 'codex' &&
      preferredProviderId !== 'claude'
    ) {
      throw reviewNotSatisfied();
    }
    const reviewerProviderId =
      preferredProviderId !== null &&
      preferredProviderId !== implementationActor.providerId
        ? preferredProviderId
        : listProviderIds().find(
            (providerId) =>
              policy.policy.providers[providerId].enabled &&
              providerId !== implementationActor.providerId,
          );
    if (reviewerProviderId === undefined) {
      throw workflowError(
        'TASK_DIFF_REVIEW_CONTINUATION_REVIEWER_REQUIRED',
        'Challenge continuation requires a Reviewer in a fresh independent session.',
        ExitCode.guard,
      );
    }
    const scheduled = scheduleOrdinaryRole({
      role: 'task-diff-reviewer',
      author: {
        providerId: implementationActor.providerId ?? undefined,
        sessionId: implementationActor.sessionId ?? undefined,
        principalId: implementationActor.principalId ?? undefined,
        identityAssurance: implementationActorAssurance,
        engineSpawned: false,
      },
      targetDigest: review.subjectDigest,
      candidates: [
        {
          providerId: reviewerProviderId,
          sessionId: providerSessionId,
          enabled: policy.policy.providers[reviewerProviderId].enabled,
          available: policy.policy.providers[reviewerProviderId].enabled,
        },
      ],
    });
    if (
      scheduled.outcome !== 'assigned' ||
      scheduled.assignment.providerId !== reviewerProviderId ||
      scheduled.assignment.sessionId === review.assignment.reviewerSessionId
    ) {
      throw workflowError(
        'TASK_DIFF_REVIEW_CONTINUATION_REVIEWER_REQUIRED',
        'Challenge continuation requires the original Reviewer provider in a fresh session.',
        ExitCode.guard,
      );
    }
    const assignment = scheduled.assignment;
    const ownerInvestigationId = `investigation-task-diff-continuation-${seed}`;
    const mandateBinding = context.session.mandateBinding ?? null;
    const authorization = createEvidenceNode({
      type: 'task-diff-review-authorization',
      nodeSchema: 'workflow.task-diff-review-authorization.v1',
      evaluator: 'workflow-task-diff-review.v1',
      policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
      exactInputDigests: {
        actor: sha256(canonicalJson(implementationActor)),
        assignment: sha256(canonicalJson(assignment)),
        mandate: sha256(canonicalJson(mandateBinding)),
        session: sha256(
          canonicalJson({
            sessionId: context.session.sessionId,
            changeId: context.session.changeId,
            taskId: context.session.taskId,
          }),
        ),
        subject: review.subjectDigest,
      },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'workflow.task-diff-review-authorization-output.v1',
      output: {
        ownerInvestigationId,
        sessionId: context.session.sessionId,
        changeId: context.session.changeId,
        taskId: context.session.taskId,
        subject: review.subject,
        implementationActor,
        assignment,
        mandateBinding,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(runtime, authorization);
    const manifest: TaskDiffReviewContinuationManifest = {
      schemaVersion: 1,
      kind: 'task-diff-review-continuation-manifest',
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      sessionId: context.session.sessionId,
      repositoryId: context.config.repositoryName,
      repositoryIdentity: review.subject.repositoryId,
      baseCommit: context.session.baseline.head,
      baseTree: context.session.baseline.tree,
      subject: review.subject,
      review,
      response,
      capabilityProfile: 'repository-read-only',
    };
    const request = createProviderInvocationRequest({
      invocationId: `invocation-task-diff-continuation-${seed}`,
      nonce: `task-diff-review-continuation-${seed}`,
      purpose: 'task-diff-review',
      providerId: assignment.providerId,
      roleAssignment: assignment,
      capabilityProfile: 'repository-read-only',
      repositoryId: context.config.repositoryName,
      baseCommit: context.session.baseline.head,
      baseTree: context.session.baseline.tree,
      targetDigest: review.subjectDigest,
      inputManifestDigest: providerInvocationManifestDigest(manifest),
      authorizationNodeId: authorization.nodeId,
      writeAllowedPaths: [],
      outputSchema: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
      evaluatorVersion: 'task-diff-review-continuation.v1',
      policyDigest: policy.digest,
      limits: {
        timeoutMs: policy.policy.limits.timeoutMs,
        aggregateOutputBytes: policy.policy.limits.aggregateOutputBytes,
      },
    });
    const requestReservation = createEvidenceNode({
      type: 'task-diff-review-continuation-request-reservation',
      nodeSchema: 'workflow.task-diff-review-continuation-reservation.v1',
      evaluator: 'workflow-task-diff-review.v1',
      policyDigest: TASK_DIFF_REVIEW_POLICY_DIGEST,
      exactInputDigests: {
        manifest: request.inputManifestDigest,
        request: request.requestDigest,
        response: response.responseDigest,
        review: review.recordDigest,
        subject: review.subjectDigest,
      },
      semanticParentResultDigests: {
        authorization: authorization.resultDigest,
      },
      provenanceParentNodeIds: { authorization: authorization.nodeId },
      outputSchema:
        'workflow.task-diff-review-continuation-reservation-output.v1',
      output: {
        ownerInvestigationId,
        sessionId: context.session.sessionId,
        changeId: context.session.changeId,
        taskId: context.session.taskId,
        subject: review.subject,
        implementationActor,
        assignment,
        review,
        response,
        manifest,
        request,
        mandateBinding,
      },
      runtimeMetadata: {},
    });
    storeProviderExecutionPolicySnapshot(runtime, request, policy);
    writeEvidenceNode(runtime, requestReservation);
    return createTaskDiffReviewContinuationReservation(runtime, {
      ownerInvestigationId,
      sessionId: context.session.sessionId,
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      repositoryRoot: context.git.repositoryRealPath,
      gitCommonDirectory: context.git.gitCommonDirectory,
      branch: context.session.branch,
      baseline: context.session.baseline,
      mandateBinding,
      subject: review.subject,
      implementationActor,
      review,
      response,
      manifest,
      request,
      authorizationNodeId: authorization.nodeId,
      reservationNodeId: requestReservation.nodeId,
      createdAt: new Date().toISOString(),
    });
  }

  function ensureTaskDiffReviewInvocation(
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    reservation: TaskDiffReviewReservationRecord,
    assertOwned: () => void,
  ): void {
    const policy = baselineAdapterPolicy(
      context.git.repositoryRoot,
      context.session.baseline.head,
    );
    storeProviderExecutionPolicySnapshot(runtime, reservation.request, policy);
    if (reservation.mandateBinding !== null) {
      authorizeTaskMandateProviderReservationUnderLifecycleLock(
        context.git.repositoryRoot,
        reservation.mandateBinding,
        reservation.request.invocationId,
        {
          providerId: reservation.request.providerId,
          dataTypes: [
            'diff',
            'repository-metadata',
            'source-code',
            'test-output',
          ],
          sourceCode: true,
          secrets: false,
          retry: false,
          budget: null,
          requestDigest: reservation.request.requestDigest,
        },
        assertOwned,
      );
    }
    if (providerInvocationExists(runtime, reservation.request.invocationId)) {
      const invocation = readProviderInvocation(
        runtime,
        reservation.request.invocationId,
      );
      const request = readProviderInvocationRequest(
        runtime,
        reservation.request.invocationId,
      );
      const manifest = readProviderInvocationManifest(
        runtime,
        reservation.request.invocationId,
      );
      if (
        invocation.investigationId !== reservation.ownerInvestigationId ||
        invocation.changeId !== reservation.changeId ||
        invocation.attempt !== 1 ||
        invocation.requestDigest !== reservation.request.requestDigest ||
        canonicalJson(invocation.mandateBinding ?? null) !==
          canonicalJson(reservation.mandateBinding) ||
        canonicalJson(request) !== canonicalJson(reservation.request) ||
        canonicalJson(manifest) !== canonicalJson(reservation.manifest)
      ) {
        throw workflowError(
          'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
          'Durable TaskDiffReview provider work differs from its exact reservation.',
          ExitCode.conflict,
        );
      }
      return;
    }
    createProviderInvocation(runtime, {
      investigationId: reservation.ownerInvestigationId,
      changeId: reservation.changeId,
      ...(reservation.mandateBinding === null
        ? {}
        : { mandateBinding: reservation.mandateBinding }),
      attempt: 1,
      manifest: reservation.manifest,
      request: reservation.request,
      createdAt: reservation.createdAt,
    });
    assertOwned();
  }

  function ensureTaskDiffReviewContinuationInvocation(
    context: ReturnType<typeof loadActiveSessionContext>,
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    reservation: TaskDiffReviewContinuationReservationRecord,
    assertOwned: () => void,
  ): void {
    const policy = baselineAdapterPolicy(
      context.git.repositoryRoot,
      context.session.baseline.head,
    );
    storeProviderExecutionPolicySnapshot(runtime, reservation.request, policy);
    if (reservation.mandateBinding !== null) {
      authorizeTaskMandateProviderReservationUnderLifecycleLock(
        context.git.repositoryRoot,
        reservation.mandateBinding,
        reservation.request.invocationId,
        {
          providerId: reservation.request.providerId,
          dataTypes: [
            'diff',
            'repository-metadata',
            'source-code',
            'test-output',
          ],
          sourceCode: true,
          secrets: false,
          retry: false,
          budget: null,
          requestDigest: reservation.request.requestDigest,
        },
        assertOwned,
      );
    }
    if (providerInvocationExists(runtime, reservation.request.invocationId)) {
      const invocation = readProviderInvocation(
        runtime,
        reservation.request.invocationId,
      );
      const request = readProviderInvocationRequest(
        runtime,
        reservation.request.invocationId,
      );
      const manifest = readProviderInvocationManifest(
        runtime,
        reservation.request.invocationId,
      );
      if (
        invocation.investigationId !== reservation.ownerInvestigationId ||
        invocation.changeId !== reservation.changeId ||
        invocation.attempt !== 1 ||
        invocation.requestDigest !== reservation.request.requestDigest ||
        canonicalJson(invocation.mandateBinding ?? null) !==
          canonicalJson(reservation.mandateBinding) ||
        canonicalJson(request) !== canonicalJson(reservation.request) ||
        canonicalJson(manifest) !== canonicalJson(reservation.manifest)
      ) {
        throw workflowError(
          'TASK_DIFF_REVIEW_REQUEST_CONFLICT',
          'Durable TaskDiffReview continuation work differs from its exact reservation.',
          ExitCode.conflict,
        );
      }
      return;
    }
    createProviderInvocation(runtime, {
      investigationId: reservation.ownerInvestigationId,
      changeId: reservation.changeId,
      ...(reservation.mandateBinding === null
        ? {}
        : { mandateBinding: reservation.mandateBinding }),
      attempt: 1,
      manifest: reservation.manifest,
      request: reservation.request,
      createdAt: reservation.createdAt,
    });
    assertOwned();
  }
  return {
    createNewTaskDiffReviewReservation,
    createNewTaskDiffReviewContinuationReservation,
    ensureTaskDiffReviewInvocation,
    ensureTaskDiffReviewContinuationInvocation,
  };
}
