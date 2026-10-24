/**
 * Asserts that a plan review or propose Grant authorizes the exact
 * collaboration transition it claims.
 */
import type { ProposeGrantAuthorization } from '../../modules/proposal/propose-types.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { isKnownCollaborationPolicyDigestForPhase } from '../../modules/authority/collaboration-grant-codec.ts';
import type { CollaborationGrantExpectedBinding } from '../../modules/authority/collaboration-grant-codec.ts';
import { isRoleContextSharingGrantedAssignment } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { RecordedRoleParticipant } from '../../modules/provider-orchestration/role-assignment.ts';
import {
  BLIND_SURVEY_GRANT_REASON,
  DIGEST,
  hasExactKeys,
  isRecord,
  PLAN_REVIEW_GRANT_REASON,
  planReviewRequestStale,
  proposeAuthorizationInvalid,
  sha256,
} from '../../modules/proposal/propose-values.ts';
import type { RoleContextSharingPlanReviewAuthorizationV1 } from '../../modules/proposal/role-context-sharing-plan-review.ts';
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
