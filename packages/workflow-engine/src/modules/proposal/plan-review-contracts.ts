import type {
  ProposeOutput,
  PlanReviewReservation,
  PlanReviewRetryEnvelope,
} from './propose-types.ts';
import type {
  RoleParticipant,
  RecordedRoleParticipant,
} from '../provider-orchestration/role-assignment.ts';
import type { ProviderId } from '../provider-orchestration/provider-registry.ts';
import type { CollaborationGrantRequest } from '../authority/collaboration-grant-codec.ts';
import {
  BLIND_SURVEY_GRANT_REASON,
  PLAN_REVIEW_GRANT_REASON,
  sha256,
  isRecord,
  hasExactKeys,
  DIGEST,
  planReviewRequestStale,
} from './propose-values.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type ProviderInvocationRequest,
  createProviderInvocationRequest,
} from '../provider-orchestration/provider-contracts.ts';
import type { ProviderRetryExplanation } from '../provider-orchestration/provider-retry-explanation.ts';
import type { PlanReviewSubject } from '../assurance/plan-review-subject.ts';
import type { RoleContextSharingPlanReviewRequirementV3 } from './role-context-sharing-plan-review.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { assertPlanReviewSubject } from '../assurance/plan-review.ts';

type ProposeLifecycleStatus = NonNullable<ProposeOutput['investigation']>;

type ProviderRetryDecisionBinding = NonNullable<
  PlanReviewReservation['retry']
>['retryDecision'];

export function blindSurveyGrantRequest(input: {
  changeId: string;
  baseline: { head: string; tree: string };
  targetDigest: string;
  author: RoleParticipant;
  callableProviderIds: Array<ProviderId>;
}): CollaborationGrantRequest | null {
  if (
    input.author.providerId === undefined ||
    input.callableProviderIds.length !== 1 ||
    input.callableProviderIds[0] !== input.author.providerId
  ) {
    return null;
  }
  return {
    changeId: input.changeId,
    taskId: null,
    baselineCommit: input.baseline.head,
    baselineTree: input.baseline.tree,
    targetDigest: input.targetDigest,
    lifecyclePhase: 'blind-survey',
    rolePair: {
      authorRole: 'investigation-author',
      conflictingRole: 'plan-reviewer',
    },
    availableActor: {
      kind: 'provider',
      providerId: input.author.providerId,
      assurance: input.author.identityAssurance,
    },
    degradedForm: 'same-provider-fresh-session',
    reason: BLIND_SURVEY_GRANT_REASON,
    ttlMinutes: 30,
    maxUses: 1,
  };
}

export function planReviewGrantRequest(input: {
  changeId: string;
  baseline: { head: string; tree: string };
  targetDigest: string;
  author: RoleParticipant;
  callableProviderIds: Array<ProviderId>;
}): CollaborationGrantRequest | null {
  if (
    input.author.providerId === undefined ||
    input.callableProviderIds.length !== 1 ||
    input.callableProviderIds[0] !== input.author.providerId
  ) {
    return null;
  }
  return {
    changeId: input.changeId,
    taskId: null,
    baselineCommit: input.baseline.head,
    baselineTree: input.baseline.tree,
    targetDigest: input.targetDigest,
    lifecyclePhase: 'plan-review',
    rolePair: {
      authorRole: 'plan-author',
      conflictingRole: 'plan-reviewer',
    },
    availableActor: {
      kind: 'provider',
      providerId: input.author.providerId,
      assurance: input.author.identityAssurance,
    },
    degradedForm: 'same-provider-fresh-session',
    reason: PLAN_REVIEW_GRANT_REASON,
    ttlMinutes: 30,
    maxUses: 1,
  };
}

export function planReviewRetryBindingDigest(
  input: PlanReviewRetryEnvelope,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: input.schemaVersion,
      kind: input.kind,
      investigationId: input.investigationId,
      changeId: input.changeId,
      expectedRevision: input.expectedRevision,
      baseline: input.baseline,
      subjectDigest: input.subjectDigest,
      planningGenerationId: input.planningGenerationId,
      expectedReservationNodeId: input.expectedReservationNodeId,
      failedInvocation: input.failedInvocation,
      acknowledgeProviderCost: input.acknowledgeProviderCost,
    }),
  );
}

export function createPlanReviewReplacementRequest(
  input: PlanReviewRetryEnvelope,
  failedRequest: ProviderInvocationRequest,
  executionPolicy: Pick<
    ProviderInvocationRequest,
    'policyDigest' | 'limits'
  > & { retryExplanation?: ProviderRetryExplanation },
): ProviderInvocationRequest {
  const bindingDigest = planReviewRetryBindingDigest(input);
  return createProviderInvocationRequest({
    invocationId: `invocation-plan-review-retry-${bindingDigest}`,
    nonce: `plan-review-retry-${bindingDigest}`,
    purpose: failedRequest.purpose,
    providerId: failedRequest.providerId,
    roleAssignment: failedRequest.roleAssignment,
    capabilityProfile: failedRequest.capabilityProfile,
    repositoryId: failedRequest.repositoryId,
    baseCommit: failedRequest.baseCommit,
    baseTree: failedRequest.baseTree,
    targetDigest: failedRequest.targetDigest,
    inputManifestDigest: failedRequest.inputManifestDigest,
    authorizationNodeId: failedRequest.authorizationNodeId,
    writeAllowedPaths: [...failedRequest.writeAllowedPaths],
    outputSchema: failedRequest.outputSchema,
    evaluatorVersion: failedRequest.evaluatorVersion,
    policyDigest: executionPolicy.policyDigest,
    limits: executionPolicy.limits,
    ...((input.retryExplanation ?? executionPolicy.retryExplanation) ===
    undefined
      ? {}
      : {
          retryExplanation:
            input.retryExplanation ?? executionPolicy.retryExplanation,
        }),
  });
}

export type CollaborationPlanReviewRequirementV3 = Readonly<{
  schemaVersion: 3;
  kind: 'collaboration-plan-review-requirement.v3';
  investigationId: string;
  changeId: string;
  subject: PlanReviewSubject;
  author: RecordedRoleParticipant;
  grantRequest: CollaborationGrantRequest | null;
}>;

export type DurablePlanReviewGrantRequirementV3 =
  | CollaborationPlanReviewRequirementV3
  | RoleContextSharingPlanReviewRequirementV3;

export type PlanReviewGrantRequirement =
  | {
      kind: 'collaboration';
      requirementNodeId: string;
      requirement: CollaborationPlanReviewRequirementV3;
    }
  | {
      kind: 'role-context-sharing';
      requirementNodeId: string;
      requirement: RoleContextSharingPlanReviewRequirementV3;
    };

export function createCollaborationPlanReviewRequirementV3(input: {
  investigationId: string;
  changeId: string;
  subject: PlanReviewSubject;
  author: RecordedRoleParticipant;
  grantRequest: CollaborationGrantRequest | null;
}): CollaborationPlanReviewRequirementV3 {
  return Object.freeze({
    schemaVersion: 3,
    kind: 'collaboration-plan-review-requirement.v3',
    investigationId: input.investigationId,
    changeId: input.changeId,
    subject: input.subject,
    author: input.author,
    grantRequest: input.grantRequest,
  });
}

export function assertDurableCollaborationPlanReviewRequirement(
  value: unknown,
  status: ProposeLifecycleStatus,
): CollaborationPlanReviewRequirementV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'subject',
      'author',
      'grantRequest',
    ]) ||
    value.schemaVersion !== 3 ||
    value.kind !== 'collaboration-plan-review-requirement.v3' ||
    value.investigationId !== status.investigationId ||
    value.changeId !== status.changeId
  ) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'The durable exact-plan collaboration requirement is malformed.',
      ExitCode.staleState,
    );
  }
  const subject = assertPlanReviewSubject(value.subject);
  if (
    canonicalJson(subject.investigationBaseline) !==
    canonicalJson(status.baseline)
  ) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'The durable exact-plan collaboration requirement is malformed.',
      ExitCode.staleState,
    );
  }
  const author = assertDurableCollaborationPlanReviewAuthor(value.author);
  const grantRequest = assertDurableCollaborationPlanReviewGrantRequest({
    value: value.grantRequest,
    status,
    subject,
    author,
  });
  const rebuilt = createCollaborationPlanReviewRequirementV3({
    investigationId: status.investigationId,
    changeId: status.changeId,
    subject,
    author,
    grantRequest,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(value)) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'The durable exact-plan collaboration requirement is malformed.',
      ExitCode.staleState,
    );
  }
  return rebuilt;
}

export function assertDurableCollaborationPlanReviewAuthor(
  value: unknown,
): RecordedRoleParticipant {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) ||
    (value.providerId !== null &&
      value.providerId !== 'codex' &&
      value.providerId !== 'claude') ||
    (value.sessionId !== null &&
      (typeof value.sessionId !== 'string' || value.sessionId.length === 0)) ||
    (value.principalId !== null &&
      (typeof value.principalId !== 'string' ||
        value.principalId.length === 0)) ||
    ![
      'self-declared',
      'runtime-hint',
      'adapter-assigned',
      'maintainer-signed',
    ].includes(String(value.identityAssurance)) ||
    typeof value.engineSpawned !== 'boolean'
  ) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'The durable exact-plan collaboration requirement is malformed.',
      ExitCode.staleState,
    );
  }
  return Object.freeze({
    providerId: value.providerId,
    sessionId: value.sessionId,
    principalId: value.principalId,
    identityAssurance:
      value.identityAssurance as RecordedRoleParticipant['identityAssurance'],
    engineSpawned: value.engineSpawned,
  });
}

export function assertDurableCollaborationPlanReviewGrantRequest(input: {
  value: unknown;
  status: ProposeLifecycleStatus;
  subject: PlanReviewSubject;
  author: RecordedRoleParticipant;
}): CollaborationGrantRequest | null {
  if (input.value === null) {
    // A null request retains the no-topology caller/direct-human continuation.
    return null;
  }
  const value = input.value;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'taskId',
      'baselineCommit',
      'baselineTree',
      'targetDigest',
      'lifecyclePhase',
      'rolePair',
      'availableActor',
      'degradedForm',
      'reason',
      'ttlMinutes',
      'maxUses',
    ]) ||
    value.changeId !== input.status.changeId ||
    value.taskId !== null ||
    value.baselineCommit !== input.status.baseline.head ||
    value.baselineTree !== input.status.baseline.tree ||
    value.targetDigest !== input.subject.subjectDigest ||
    value.lifecyclePhase !== 'plan-review' ||
    canonicalJson(value.rolePair) !==
      canonicalJson({
        authorRole: 'plan-author',
        conflictingRole: 'plan-reviewer',
      }) ||
    input.author.providerId === null ||
    input.author.identityAssurance === 'maintainer-signed' ||
    canonicalJson(value.availableActor) !==
      canonicalJson({
        kind: 'provider',
        providerId: input.author.providerId,
        assurance: input.author.identityAssurance,
      }) ||
    value.degradedForm !== 'same-provider-fresh-session' ||
    value.reason !== PLAN_REVIEW_GRANT_REASON ||
    value.ttlMinutes !== 30 ||
    value.maxUses !== 1
  ) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'The durable exact-plan collaboration requirement is malformed.',
      ExitCode.staleState,
    );
  }
  return Object.freeze({
    changeId: value.changeId,
    taskId: null,
    baselineCommit: value.baselineCommit,
    baselineTree: value.baselineTree,
    targetDigest: value.targetDigest,
    lifecyclePhase: 'plan-review',
    rolePair: {
      authorRole: 'plan-author' as const,
      conflictingRole: 'plan-reviewer' as const,
    },
    availableActor: {
      kind: 'provider' as const,
      providerId: input.author.providerId,
      assurance: input.author.identityAssurance,
    },
    degradedForm: 'same-provider-fresh-session',
    reason: PLAN_REVIEW_GRANT_REASON,
    ttlMinutes: 30,
    maxUses: 1,
  });
}

export function assertPlanReviewRetryDecisionBinding(
  value: unknown,
): ProviderRetryDecisionBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'evaluatedAt',
      'evidenceDigest',
      'executionJobId',
      'executionRevision',
      'failedAttemptId',
      'kind',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retry-decision-binding' ||
    typeof value.executionJobId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.executionJobId) ||
    !Number.isSafeInteger(value.executionRevision) ||
    (value.executionRevision as number) < 0 ||
    typeof value.failedAttemptId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.failedAttemptId) ||
    typeof value.evidenceDigest !== 'string' ||
    !DIGEST.test(value.evidenceDigest) ||
    typeof value.evaluatedAt !== 'string' ||
    Number.isNaN(Date.parse(value.evaluatedAt))
  ) {
    throw planReviewRequestStale();
  }
  return value as ProviderRetryDecisionBinding;
}
