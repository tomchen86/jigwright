import type { RoleContextSharingGrantOperations } from '../../modules/authority/role-context-sharing-grant.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import { ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1 } from '@jigwright/core/role-context-sharing-grant-codec';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { AuthoritativeRoleContextSharingGrantVerifier } from '../../modules/authority/role-context-sharing-grant-verifier-port.ts';
import type {
  RoleContextSharingGrantLifecyclePortV1,
  RoleContextSharingLifecycleRecordV1,
  RoleContextSharingLifecycleUseV1,
  ConsumedRoleContextSharingUseEvidenceV1,
} from '../../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
import type { MaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import { computeRoleContextSharingResultAdmissionDigestV1 } from '../../modules/authority/role-context-sharing-consumed-replay.ts';
import { isProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import type {
  RecordedRoleParticipant,
  RoleContextSharingGrantedRoleAssignment,
} from '../../modules/provider-orchestration/role-assignment.ts';
import type {
  RoleContentAdmission,
  RoleProviderInvocationEvidence,
} from '../../modules/provider-orchestration/role-admission-contracts.ts';
import crypto from 'node:crypto';
import {
  DIGEST,
  deriveRoleContextSharingPlanReviewExpectedBinding,
  createRoleContextSharingRequirementEligibilityPort,
  ineligible,
  deepFreeze,
} from '../../modules/proposal/role-context-sharing-plan-review.ts';
import type {
  RoleContextSharingPlanReviewRequirementV3,
  RoleContextSharingPlanReviewAuthorizationV1,
} from '../../modules/proposal/role-context-sharing-plan-review.ts';
export function reserveRoleContextSharingPlanReview(
  grants: Pick<
    RoleContextSharingGrantOperations,
    'bindingFromRoleContextSharingGrantPayloadV1'
  >,
  input: {
    gitCommonDirectory: string;
    requirementNodeId: string;
    requirement: RoleContextSharingPlanReviewRequirementV3;
    grantId: string;
    policy: MaintainerPolicy;
    policyBlob: string;
    verifier: AuthoritativeRoleContextSharingGrantVerifier;
    lifecycle: RoleContextSharingGrantLifecyclePortV1;
    now?: Date;
    assertOwned: () => void;
  },
): Readonly<{
  record: RoleContextSharingLifecycleRecordV1;
  assignment: RoleContextSharingGrantedRoleAssignment;
  authorization: RoleContextSharingPlanReviewAuthorizationV1;
}> {
  if (!input.requirement.grantReferences.includes(input.grantId)) {
    throw ineligible('The selected R-007 grant UUID is not explicitly listed.');
  }
  const available = input.lifecycle.read(
    input.gitCommonDirectory,
    input.grantId,
  );
  const expected = deriveRoleContextSharingPlanReviewExpectedBinding({
    requirement: input.requirement,
    repositoryId: input.policy.repository.id,
    repositoryOrigin: input.policy.repository.origin,
    policyBlob: input.policyBlob,
    reason: available.envelope.payload.reason,
  });
  if (
    canonicalJson(
      grants.bindingFromRoleContextSharingGrantPayloadV1(
        available.envelope.payload,
      ),
    ) !== canonicalJson(expected)
  ) {
    throw ineligible(
      'The selected R-007 grant envelope is not bound to this durable requirement.',
    );
  }
  const eligibility = createRoleContextSharingRequirementEligibilityPort({
    requirement: input.requirement,
    grantId: input.grantId,
    expected,
  });
  const record = input.lifecycle.reserveOrReadExactUnderLifecycleLock(
    input.gitCommonDirectory,
    input.grantId,
    {
      ...(input.now === undefined ? {} : { now: input.now }),
      expected,
      policy: input.policy,
      verifier: input.verifier,
      eligibility,
    },
    input.assertOwned,
  );
  const reservationReceiptDigest = record.reservation?.reservationDigest;
  if (
    record.state !== 'reserved' ||
    reservationReceiptDigest === undefined ||
    !DIGEST.test(reservationReceiptDigest)
  ) {
    throw ineligible('The selected R-007 grant was not exactly reserved.');
  }
  const placement = input.requirement.reviewerPlacement;
  if (!isProviderId(placement.logicalProviderId)) {
    throw ineligible('The durable R-007 reviewer provider is unavailable.');
  }
  const assignment: RoleContextSharingGrantedRoleAssignment = deepFreeze({
    role: 'plan-reviewer' as const,
    providerId: placement.logicalProviderId,
    sessionId: placement.sessionId,
    targetDigest: input.requirement.subject.subjectDigest,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence: 'session-independent' as const,
    authorityKind: 'role-context-sharing-grant.v1' as const,
    roleContextSharingGrantId: input.grantId,
    authorizedEffect: ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
    exactRolePairs: input.requirement.roleTopology.exactGrantRolePairs,
    contextGeneration: input.requirement.contextGeneration,
    sessionGeneration: input.requirement.sessionGeneration,
    sharedEngineSessionId: input.requirement.sharedEngineSessionId,
    providerDefinitionDigest: input.requirement.providerDefinitionDigest,
    reservationReceiptDigest,
  });
  return deepFreeze({
    record,
    assignment,
    authorization: {
      kind: 'role-context-sharing-plan-review-authorization.v1' as const,
      grantId: input.grantId,
      requirementNodeId: input.requirementNodeId,
      expectedBinding: expected,
      reservationReceiptDigest,
      reservationRecordDigest: record.recordDigest,
    },
  });
}

export function consumeRoleContextSharingPlanReview(
  roleAdmission: RoleAdmissionServices,
  input: {
    gitCommonDirectory: string;
    requirement: RoleContextSharingPlanReviewRequirementV3;
    authorization: RoleContextSharingPlanReviewAuthorizationV1;
    assignment: RoleContextSharingGrantedRoleAssignment;
    policy: MaintainerPolicy;
    verifier: AuthoritativeRoleContextSharingGrantVerifier;
    lifecycle: RoleContextSharingGrantLifecyclePortV1;
    author: RecordedRoleParticipant;
    participant: RecordedRoleParticipant;
    content: RoleContentAdmission;
    providerInvocation: RoleProviderInvocationEvidence;
    now?: Date;
    assertOwned: () => void;
  },
): Readonly<{
  record: RoleContextSharingLifecycleRecordV1;
  use: RoleContextSharingLifecycleUseV1;
  reservationReceiptDigest: string;
  terminalReceiptDigest: string;
  useProjectionDigest: string;
  evidence: ConsumedRoleContextSharingUseEvidenceV1;
}> {
  const admission =
    roleAdmission.normalizeRoleContextSharingResultAdmissionBinding({
      assignment: input.assignment,
      author: input.author,
      participant: input.participant,
      content: input.content,
      providerInvocation: input.providerInvocation,
    });
  const expected = input.authorization.expectedBinding;
  const eligibility = createRoleContextSharingRequirementEligibilityPort({
    requirement: input.requirement,
    grantId: input.authorization.grantId,
    expected,
  });
  const use: RoleContextSharingLifecycleUseV1 = deepFreeze({
    rolePairs: admission.assignment.exactRolePairs,
    providerId: admission.assignment.providerId,
    sessionId: admission.assignment.sessionId,
    sharedEngineSessionId: admission.assignment.sharedEngineSessionId,
    contextGeneration: admission.assignment.contextGeneration,
    sessionGeneration: admission.assignment.sessionGeneration,
    providerDefinitionDigest: admission.assignment.providerDefinitionDigest,
    invocationId: admission.providerInvocation.invocationId,
    requestDigest: admission.providerInvocation.requestDigest,
    assignmentDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(admission.assignment))
      .digest('hex'),
    admissionDigest:
      computeRoleContextSharingResultAdmissionDigestV1(admission),
  });
  const record = input.lifecycle.consumeOrReadExactUnderLifecycleLock(
    input.gitCommonDirectory,
    input.authorization.grantId,
    {
      expected,
      use,
      ...(input.now === undefined ? {} : { now: input.now }),
      policy: input.policy,
      verifier: input.verifier,
      eligibility,
    },
    input.assertOwned,
  );
  const reservationReceiptDigest = record.receiptDigests[0];
  const terminalReceiptDigest = record.receiptDigests[1];
  if (
    record.state !== 'consumed' ||
    record.receiptDigests.length !== 2 ||
    record.use === null ||
    canonicalJson(record.use) !== canonicalJson(use) ||
    reservationReceiptDigest !== input.authorization.reservationReceiptDigest ||
    reservationReceiptDigest === undefined ||
    terminalReceiptDigest === undefined
  ) {
    throw ineligible(
      'The R-007 grant did not reach one exact durable consumed use.',
    );
  }
  const useProjectionDigest = crypto
    .createHash('sha256')
    .update(canonicalJson(use))
    .digest('hex');
  const evidence: ConsumedRoleContextSharingUseEvidenceV1 = deepFreeze({
    kind: 'role-context-sharing-consumed-use.v1' as const,
    grantId: input.authorization.grantId,
    envelope: record.envelope,
    expectedBinding: expected,
    reservationReceiptDigest,
    terminalReceiptDigest,
    terminalRecordDigest: record.recordDigest,
    use,
    useProjectionDigest,
  });
  return deepFreeze({
    record,
    use,
    reservationReceiptDigest,
    terminalReceiptDigest,
    useProjectionDigest,
    evidence,
  });
}
