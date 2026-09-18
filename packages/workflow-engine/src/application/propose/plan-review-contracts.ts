/**
 * Builds and validates proposal review grants, requirements, and retry bindings.
 *
 * Invariants:
 * - Stored requirements retain their exact subject, author, baseline, and role bindings.
 * - A retry keeps its deterministic identity and the failed request's semantic inputs.
 */
import type { ProviderRetryExplanation } from '../../modules/provider-orchestration/provider-retry-explanation.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { assertPlanReviewSubject } from '../../modules/assurance/plan-review.ts';
import type { PlanReviewSubject } from '../../modules/assurance/plan-review-subject.ts';
import {
  isKnownCollaborationPolicyDigestForPhase,
  type CollaborationGrantExpectedBinding,
  type CollaborationGrantRequest,
} from '../../modules/authority/collaboration-grant-codec.ts';
import {
  createProviderInvocationRequest,
  isRoleContextSharingGrantedAssignment,
  type ProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type {
  ProviderRoleAssignment,
  RecordedRoleParticipant,
  RoleParticipant,
} from '../../modules/provider-orchestration/role-assignment.ts';
import type { RoleTopologyResolutionV1 } from '../../modules/provider-orchestration/role-topology-resolution.ts';
import {
  BLIND_SURVEY_GRANT_REASON,
  DIGEST,
  hasExactKeys,
  isRecord,
  PLAN_REVIEW_GRANT_REASON,
  planReviewRequestStale,
  proposeAuthorizationInvalid,
  sha256,
} from './propose-common.ts';
import type {
  PlanReviewReservation,
  PlanReviewRetryEnvelope,
  ProposeOutput,
} from './propose-types.ts';
import {
  createRoleContextSharingPlanReviewRequirementV3,
  type RoleContextSharingPlanReviewAuthorizationV1,
  type RoleContextSharingPlanReviewRequirementV3,
} from './role-context-sharing-plan-review.ts';

type ProposeLifecycleStatus = NonNullable<ProposeOutput['investigation']>;
type ProviderRetryDecisionBinding = NonNullable<
  PlanReviewReservation['retry']
>['retryDecision'];

export type ProposeGrantAuthorization =
  | {
      grantId: string;
      transitionDigest: string;
      expectedBinding: CollaborationGrantExpectedBinding;
    }
  | RoleContextSharingPlanReviewAuthorizationV1;

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

export function collaborationTransitionDigest(
  expectedBinding: CollaborationGrantExpectedBinding,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'collaboration-role-transition',
      expectedBinding,
    }),
  );
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

export function assertDurableRoleContextSharingPlanReviewRequirement(
  value: unknown,
  status: ProposeLifecycleStatus,
): RoleContextSharingPlanReviewRequirementV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'taskId',
      'baseline',
      'subject',
      'author',
      'roleTopology',
      'reviewerPlacement',
      'contextGeneration',
      'sessionGeneration',
      'sharedEngineSessionId',
      'providerDefinitionDigest',
      'grantReferences',
    ]) ||
    value.schemaVersion !== 3 ||
    value.kind !== 'role-context-sharing-plan-review-requirement.v3' ||
    value.investigationId !== status.investigationId ||
    value.changeId !== status.changeId ||
    value.taskId !== null ||
    canonicalJson(value.baseline) !== canonicalJson(status.baseline) ||
    !isRecord(value.author) ||
    !Number.isSafeInteger(value.contextGeneration) ||
    (value.contextGeneration as number) < 1
  ) {
    throw durableRoleTopologyInvalid();
  }
  const subject = assertPlanReviewSubject(value.subject);
  const author = value.author as RecordedRoleParticipant;
  const roleTopology = assertDurablePlanReviewRoleTopology(value.roleTopology, {
    changeId: status.changeId,
    planningGeneration: subject.planningGenerationId,
    author,
    assignment: null,
    requiredDisposition: 'exact-grant-required',
  });
  const rebuilt = createRoleContextSharingPlanReviewRequirementV3({
    investigationId: status.investigationId,
    changeId: status.changeId,
    baseline: status.baseline,
    subject,
    author,
    roleTopology,
    contextGeneration: value.contextGeneration as number,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(value)) {
    throw durableRoleTopologyInvalid();
  }
  return rebuilt;
}

export function assertDurablePlanReviewRoleTopology(
  value: unknown,
  expectation: Readonly<{
    changeId: string;
    planningGeneration: string;
    author: RecordedRoleParticipant;
    assignment: ProviderRoleAssignment | null;
    requiredDisposition: 'satisfied' | 'exact-grant-required';
  }>,
): RoleTopologyResolutionV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'changeId',
      'planningGeneration',
      'centralRoleConfigurationDigest',
      'changeOverrideDigest',
      'providerRegistryDigest',
      'eligibilityPolicyDigest',
      'configuredRolePairs',
      'actualPlacements',
      'actualRolePairs',
      'exactGrantRolePairs',
      'explicitEligibility',
      'disposition',
    ]) ||
    value.schemaVersion !== 1 ||
    value.changeId !== expectation.changeId ||
    value.planningGeneration !== expectation.planningGeneration ||
    value.disposition !== expectation.requiredDisposition ||
    !DIGEST.test(String(value.centralRoleConfigurationDigest)) ||
    !DIGEST.test(String(value.changeOverrideDigest)) ||
    !DIGEST.test(String(value.providerRegistryDigest)) ||
    !DIGEST.test(String(value.eligibilityPolicyDigest)) ||
    !Array.isArray(value.configuredRolePairs) ||
    !Array.isArray(value.actualPlacements) ||
    !Array.isArray(value.actualRolePairs) ||
    !Array.isArray(value.exactGrantRolePairs) ||
    !isRecord(value.explicitEligibility)
  ) {
    throw durableRoleTopologyInvalid();
  }
  const configuredPairs = [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
  ] as const;
  const independence = [
    'none',
    'session-independent',
    'provider-independent',
  ] as const;
  if (
    value.configuredRolePairs.length !== configuredPairs.length ||
    value.configuredRolePairs.some((entry, index) => {
      if (!isRecord(entry)) return true;
      return (
        !hasExactKeys(entry, ['pair', 'required']) ||
        entry.pair !== configuredPairs[index] ||
        !independence.includes(entry.required as (typeof independence)[number])
      );
    }) ||
    value.actualPlacements.length !== 2
  ) {
    throw durableRoleTopologyInvalid();
  }
  const [authorPlacement, reviewerPlacement] = value.actualPlacements;
  if (
    !isRecord(authorPlacement) ||
    !isRecord(reviewerPlacement) ||
    !hasExactKeys(authorPlacement, [
      'role',
      'logicalProviderId',
      'providerDefinitionDigest',
      'sessionId',
    ]) ||
    !hasExactKeys(reviewerPlacement, [
      'role',
      'logicalProviderId',
      'providerDefinitionDigest',
      'sessionId',
    ]) ||
    authorPlacement.role !== 'author' ||
    reviewerPlacement.role !== 'reviewer' ||
    authorPlacement.logicalProviderId !== expectation.author.providerId ||
    authorPlacement.sessionId !== expectation.author.sessionId ||
    typeof reviewerPlacement.logicalProviderId !== 'string' ||
    typeof reviewerPlacement.sessionId !== 'string' ||
    !DIGEST.test(String(authorPlacement.providerDefinitionDigest)) ||
    !DIGEST.test(String(reviewerPlacement.providerDefinitionDigest))
  ) {
    throw durableRoleTopologyInvalid();
  }
  if (
    expectation.assignment !== null &&
    (expectation.assignment.role !== 'plan-reviewer' ||
      'grantId' in expectation.assignment ||
      expectation.assignment.requiredIndependence !== 'session-independent' ||
      (expectation.assignment.achievedIndependence !== 'provider-independent' &&
        expectation.assignment.achievedIndependence !==
          'session-independent') ||
      reviewerPlacement.logicalProviderId !==
        expectation.assignment.providerId ||
      reviewerPlacement.sessionId !== expectation.assignment.sessionId)
  ) {
    throw durableRoleTopologyInvalid();
  }
  const actualPair = value.actualRolePairs[0];
  if (
    value.actualRolePairs.length !== 1 ||
    !isRecord(actualPair) ||
    !hasExactKeys(actualPair, [
      'pair',
      'required',
      'achieved',
      'left',
      'right',
      'meetsOrExceedsConfiguredTopology',
    ]) ||
    actualPair.pair !== 'author-reviewer' ||
    !independence.includes(
      actualPair.required as (typeof independence)[number],
    ) ||
    !independence.includes(
      actualPair.achieved as (typeof independence)[number],
    ) ||
    actualPair.meetsOrExceedsConfiguredTopology !== true ||
    canonicalJson(actualPair.left) !== canonicalJson(authorPlacement) ||
    canonicalJson(actualPair.right) !== canonicalJson(reviewerPlacement) ||
    !hasExactKeys(value.explicitEligibility, [
      'status',
      'explicitlyListed',
      'grantReferences',
    ]) ||
    !Array.isArray(value.explicitEligibility.grantReferences)
  ) {
    throw durableRoleTopologyInvalid();
  }
  const exactRolePairs = value.exactGrantRolePairs;
  if (
    exactRolePairs.some(
      (pair, index) =>
        !configuredPairs.includes(pair as (typeof configuredPairs)[number]) ||
        (index > 0 && String(exactRolePairs[index - 1]) >= String(pair)),
    ) ||
    value.explicitEligibility.grantReferences.some(
      (reference) => typeof reference !== 'string' || reference.length === 0,
    ) ||
    (expectation.requiredDisposition === 'satisfied'
      ? exactRolePairs.length !== 0 ||
        value.explicitEligibility.status !== 'not-required' ||
        value.explicitEligibility.explicitlyListed !== false ||
        (actualPair.achieved !== 'provider-independent' &&
          actualPair.achieved !== 'session-independent')
      : exactRolePairs.length === 0 ||
        value.explicitEligibility.status !== 'listed' ||
        value.explicitEligibility.explicitlyListed !== true)
  ) {
    throw durableRoleTopologyInvalid();
  }
  return value as unknown as RoleTopologyResolutionV1;
}

export function durableRoleTopologyInvalid(): ReturnType<typeof workflowError> {
  return workflowError(
    'PLAN_REVIEW_ROLE_TOPOLOGY_STALE',
    'Durable PlanReview role-topology evidence is malformed or stale.',
    ExitCode.staleState,
  );
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

export function assertPlanReviewGrantAuthorization(
  value: unknown,
  author: RecordedRoleParticipant,
  request: ProviderInvocationRequest,
): ProposeGrantAuthorization | null {
  if (isRoleContextSharingGrantedAssignment(request.roleAssignment)) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'kind',
        'grantId',
        'requirementNodeId',
        'expectedBinding',
        'reservationReceiptDigest',
        'reservationRecordDigest',
      ]) ||
      value.kind !== 'role-context-sharing-plan-review-authorization.v1' ||
      value.grantId !== request.roleAssignment.roleContextSharingGrantId ||
      typeof value.requirementNodeId !== 'string' ||
      !DIGEST.test(value.requirementNodeId) ||
      !isRecord(value.expectedBinding) ||
      value.reservationReceiptDigest !==
        request.roleAssignment.reservationReceiptDigest ||
      typeof value.reservationRecordDigest !== 'string' ||
      !DIGEST.test(value.reservationRecordDigest)
    ) {
      throw planReviewRequestStale();
    }
    const expectedBinding =
      value.expectedBinding as RoleContextSharingPlanReviewAuthorizationV1['expectedBinding'];
    if (
      expectedBinding.baselineCommit !== request.baseCommit ||
      expectedBinding.baselineTree !== request.baseTree ||
      expectedBinding.targetDigest !== request.targetDigest ||
      expectedBinding.lifecyclePhase !== 'plan-review' ||
      canonicalJson(expectedBinding.rolePairs) !==
        canonicalJson(request.roleAssignment.exactRolePairs) ||
      expectedBinding.contextGeneration !==
        request.roleAssignment.contextGeneration ||
      expectedBinding.sessionGeneration !==
        request.roleAssignment.sessionGeneration ||
      expectedBinding.sharedEngineSessionId !==
        request.roleAssignment.sharedEngineSessionId ||
      expectedBinding.providerDefinitionDigest !==
        request.roleAssignment.providerDefinitionDigest
    ) {
      throw planReviewRequestStale();
    }
    return {
      kind: 'role-context-sharing-plan-review-authorization.v1',
      grantId: request.roleAssignment.roleContextSharingGrantId,
      requirementNodeId: value.requirementNodeId,
      expectedBinding,
      reservationReceiptDigest: value.reservationReceiptDigest,
      reservationRecordDigest: value.reservationRecordDigest,
    };
  }
  if (!('grantId' in request.roleAssignment)) {
    if (
      value !== null ||
      author.providerId === null ||
      request.roleAssignment.requiredIndependence !== 'session-independent' ||
      (request.roleAssignment.achievedIndependence !== 'provider-independent' &&
        request.roleAssignment.achievedIndependence !==
          'session-independent') ||
      (request.providerId === author.providerId &&
        request.roleAssignment.sessionId === author.sessionId)
    ) {
      throw workflowError(
        'PLAN_REVIEW_REQUEST_STALE',
        'Ordinary plan-review authorization is not session-independent.',
        ExitCode.staleState,
      );
    }
    return null;
  }
  if (
    !isRecord(value) ||
    'kind' in value ||
    !hasExactKeys(value, ['grantId', 'transitionDigest', 'expectedBinding']) ||
    value.grantId !== request.roleAssignment.grantId ||
    typeof value.transitionDigest !== 'string' ||
    !DIGEST.test(value.transitionDigest) ||
    !isRecord(value.expectedBinding)
  ) {
    throw workflowError(
      'PLAN_REVIEW_REQUEST_STALE',
      'Granted plan-review authorization is malformed.',
      ExitCode.staleState,
    );
  }
  const expectedBinding =
    value.expectedBinding as CollaborationGrantExpectedBinding;
  if (
    author.providerId === null ||
    request.providerId !== author.providerId ||
    request.roleAssignment.providerId !== author.providerId ||
    request.roleAssignment.achievedIndependence !== 'session-independent' ||
    !isKnownCollaborationPolicyDigestForPhase(
      expectedBinding.collaborationPolicyDigest,
      'plan-review',
    ) ||
    expectedBinding.baselineCommit !== request.baseCommit ||
    expectedBinding.baselineTree !== request.baseTree ||
    expectedBinding.targetDigest !== request.targetDigest ||
    expectedBinding.lifecyclePhase !== 'plan-review' ||
    canonicalJson(expectedBinding.rolePair) !==
      canonicalJson({
        authorRole: 'plan-author',
        conflictingRole: 'plan-reviewer',
      }) ||
    canonicalJson(expectedBinding.availableActor) !==
      canonicalJson({
        kind: 'provider',
        providerId: author.providerId,
        assurance: author.identityAssurance,
      }) ||
    expectedBinding.degradedForm !== 'same-provider-fresh-session' ||
    expectedBinding.reason !== PLAN_REVIEW_GRANT_REASON ||
    collaborationTransitionDigest(expectedBinding) !== value.transitionDigest
  ) {
    throw workflowError(
      'PLAN_REVIEW_REQUEST_STALE',
      'Granted plan-review authorization no longer matches the exact subject.',
      ExitCode.staleState,
    );
  }
  return {
    grantId: String(value.grantId),
    transitionDigest: value.transitionDigest,
    expectedBinding,
  };
}

export function assertProposeGrantAuthorization(
  value: unknown,
  actor: {
    providerId: ProviderId;
    assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  },
  request: ProviderInvocationRequest,
): ProposeGrantAuthorization | null {
  if (!('grantId' in request.roleAssignment)) {
    if (
      value !== null ||
      request.roleAssignment.role !== 'plan-reviewer' ||
      request.purpose !== 'survey' ||
      request.roleAssignment.requiredIndependence !== 'session-independent' ||
      (request.roleAssignment.achievedIndependence !== 'provider-independent' &&
        request.roleAssignment.achievedIndependence !==
          'session-independent') ||
      (request.providerId === actor.providerId &&
        request.roleAssignment.sessionId === `author-${actor.providerId}`)
    ) {
      throw proposeAuthorizationInvalid();
    }
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['grantId', 'transitionDigest', 'expectedBinding']) ||
    typeof value.grantId !== 'string' ||
    value.grantId !== request.roleAssignment.grantId ||
    typeof value.transitionDigest !== 'string' ||
    !DIGEST.test(value.transitionDigest) ||
    !isRecord(value.expectedBinding)
  ) {
    throw proposeAuthorizationInvalid();
  }
  const expectedBinding =
    value.expectedBinding as CollaborationGrantExpectedBinding;
  if (
    request.providerId !== actor.providerId ||
    request.roleAssignment.providerId !== actor.providerId ||
    request.roleAssignment.requiredIndependence !== 'provider-independent' ||
    request.roleAssignment.achievedIndependence !== 'session-independent' ||
    !isKnownCollaborationPolicyDigestForPhase(
      expectedBinding.collaborationPolicyDigest,
      'blind-survey',
    ) ||
    expectedBinding.baselineCommit !== request.baseCommit ||
    expectedBinding.baselineTree !== request.baseTree ||
    expectedBinding.targetDigest !== request.targetDigest ||
    expectedBinding.lifecyclePhase !== 'blind-survey' ||
    canonicalJson(expectedBinding.rolePair) !==
      canonicalJson({
        authorRole: 'investigation-author',
        conflictingRole: 'plan-reviewer',
      }) ||
    canonicalJson(expectedBinding.availableActor) !==
      canonicalJson({
        kind: 'provider',
        providerId: actor.providerId,
        assurance: actor.assurance,
      }) ||
    expectedBinding.degradedForm !== 'same-provider-fresh-session' ||
    expectedBinding.reason !== BLIND_SURVEY_GRANT_REASON ||
    collaborationTransitionDigest(expectedBinding) !== value.transitionDigest
  ) {
    throw proposeAuthorizationInvalid();
  }
  return {
    grantId: value.grantId,
    transitionDigest: value.transitionDigest,
    expectedBinding,
  };
}
