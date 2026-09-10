/**
 * Creates, reserves, and consumes exact role context sharing authority for
 * PlanReview.
 *
 * Invariants:
 * - PlanReview sharing eligibility must prelist exact unique grant
 *   identifiers.
 */
import {
  bindingFromRoleContextSharingGrantPayloadV1,
  ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  type RoleContextSharingGrantExpectedBindingV1,
} from '../../modules/authority/optional-grants-package.ts';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1,
  ROLE_CONTEXT_SHARING_POLICY_DIGEST,
  type RoleContextSharingEligibilityPortV1,
} from '../../modules/authority/role-context-sharing-grant.ts';
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
import { normalizeRoleContextSharingResultAdmissionBinding } from '../../modules/provider-orchestration/role-scheduler.ts';
import type {
  RecordedRoleParticipant,
  RoleContentAdmission,
  RoleContextSharingGrantedRoleAssignment,
  RoleProviderInvocationEvidence,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import type {
  ActualRolePlacementV1,
  RoleTopologyResolutionV1,
} from '../../modules/provider-orchestration/role-topology-resolution.ts';
import type { PlanReviewSubject } from '../../modules/assurance/plan-review.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type RoleContextSharingPlanReviewRequirementV3 = Readonly<{
  schemaVersion: 3;
  kind: 'role-context-sharing-plan-review-requirement.v3';
  investigationId: string;
  changeId: string;
  taskId: null;
  baseline: Readonly<{ head: string; tree: string }>;
  subject: PlanReviewSubject;
  author: RecordedRoleParticipant;
  roleTopology: RoleTopologyResolutionV1;
  reviewerPlacement: ActualRolePlacementV1;
  contextGeneration: number;
  sessionGeneration: 1;
  sharedEngineSessionId: string;
  providerDefinitionDigest: string;
  grantReferences: readonly string[];
}>;

export type RoleContextSharingPlanReviewAuthorizationV1 = Readonly<{
  kind: 'role-context-sharing-plan-review-authorization.v1';
  grantId: string;
  requirementNodeId: string;
  expectedBinding: RoleContextSharingGrantExpectedBindingV1;
  reservationReceiptDigest: string;
  reservationRecordDigest: string;
}>;

export function createRoleContextSharingPlanReviewRequirementV3(input: {
  investigationId: string;
  changeId: string;
  baseline: Readonly<{ head: string; tree: string }>;
  subject: PlanReviewSubject;
  author: RecordedRoleParticipant;
  roleTopology: RoleTopologyResolutionV1;
  contextGeneration: number;
}): RoleContextSharingPlanReviewRequirementV3 {
  const reviewerPlacement = input.roleTopology.actualPlacements.find(
    ({ role }) => role === 'reviewer',
  );
  if (
    input.roleTopology.disposition !== 'exact-grant-required' ||
    canonicalJson(input.roleTopology.exactGrantRolePairs) !==
      canonicalJson(['author-reviewer']) ||
    input.roleTopology.explicitEligibility.status !== 'listed' ||
    input.roleTopology.explicitEligibility.explicitlyListed !== true ||
    reviewerPlacement === undefined ||
    !isProviderId(reviewerPlacement.logicalProviderId) ||
    !DIGEST.test(reviewerPlacement.providerDefinitionDigest) ||
    !Number.isSafeInteger(input.contextGeneration) ||
    input.contextGeneration < 1
  ) {
    throw ineligible(
      'PlanReview R-007 v1 requires exactly the author-reviewer pair and one fixed provider placement.',
    );
  }
  const grantReferences = Object.freeze([
    ...input.roleTopology.explicitEligibility.grantReferences,
  ]);
  if (
    grantReferences.length === 0 ||
    grantReferences.some((grantId) => !UUID_V4.test(grantId)) ||
    new Set(grantReferences).size !== grantReferences.length
  ) {
    throw ineligible(
      'PlanReview R-007 eligibility must prelist exact unique grant UUIDs.',
    );
  }
  return deepFreeze({
    schemaVersion: 3 as const,
    kind: 'role-context-sharing-plan-review-requirement.v3' as const,
    investigationId: input.investigationId,
    changeId: input.changeId,
    taskId: null,
    baseline: input.baseline,
    subject: input.subject,
    author: input.author,
    roleTopology: input.roleTopology,
    reviewerPlacement,
    contextGeneration: input.contextGeneration,
    sessionGeneration: 1 as const,
    sharedEngineSessionId: input.investigationId,
    providerDefinitionDigest: reviewerPlacement.providerDefinitionDigest,
    grantReferences,
  });
}

export function deriveRoleContextSharingPlanReviewExpectedBinding(input: {
  requirement: RoleContextSharingPlanReviewRequirementV3;
  repositoryId: string;
  repositoryOrigin: string;
  policyBlob: string;
  reason: string;
}): RoleContextSharingGrantExpectedBindingV1 {
  const requirement = input.requirement;
  return {
    repositoryId: input.repositoryId,
    repositoryOrigin: input.repositoryOrigin,
    policyBlob: input.policyBlob,
    roleContextSharingPolicyDigest: ROLE_CONTEXT_SHARING_POLICY_DIGEST,
    centralRoleConfigurationDigest:
      requirement.roleTopology.centralRoleConfigurationDigest,
    changeOverrideDigest: requirement.roleTopology.changeOverrideDigest,
    providerRegistryDigest: requirement.roleTopology.providerRegistryDigest,
    eligibilityPolicyDigest: requirement.roleTopology.eligibilityPolicyDigest,
    changeId: requirement.changeId,
    taskId: null,
    baselineCommit: requirement.baseline.head,
    baselineTree: requirement.baseline.tree,
    targetDigest: requirement.subject.subjectDigest,
    lifecyclePhase: 'plan-review',
    subjectDigest: requirement.subject.subjectDigest,
    planningGeneration: requirement.subject.planningGenerationId,
    rolePairs: requirement.roleTopology.exactGrantRolePairs,
    contextGeneration: requirement.contextGeneration,
    sessionGeneration: requirement.sessionGeneration,
    sharedEngineSessionId: requirement.sharedEngineSessionId,
    providerDefinitionDigest: requirement.providerDefinitionDigest,
    reason: input.reason,
  };
}

export function createRoleContextSharingRequirementEligibilityPort(input: {
  requirement: RoleContextSharingPlanReviewRequirementV3;
  grantId: string;
  expected: RoleContextSharingGrantExpectedBindingV1;
}): RoleContextSharingEligibilityPortV1 {
  if (!input.requirement.grantReferences.includes(input.grantId)) {
    throw ineligible('The selected R-007 grant UUID is not explicitly listed.');
  }
  return Object.freeze({
    contractVersion: ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1,
    policyDigest: input.requirement.roleTopology.eligibilityPolicyDigest,
    assertEligible(observed: RoleContextSharingGrantExpectedBindingV1) {
      if (canonicalJson(observed) !== canonicalJson(input.expected)) {
        throw ineligible(
          'The selected R-007 grant does not match the durable PlanReview requirement.',
        );
      }
    },
  });
}

export function reserveRoleContextSharingPlanReview(input: {
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
}): Readonly<{
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
      bindingFromRoleContextSharingGrantPayloadV1(available.envelope.payload),
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

export function consumeRoleContextSharingPlanReview(input: {
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
}): Readonly<{
  record: RoleContextSharingLifecycleRecordV1;
  use: RoleContextSharingLifecycleUseV1;
  reservationReceiptDigest: string;
  terminalReceiptDigest: string;
  useProjectionDigest: string;
  evidence: ConsumedRoleContextSharingUseEvidenceV1;
}> {
  const admission = normalizeRoleContextSharingResultAdmissionBinding({
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

function ineligible(message: string) {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE',
    message,
    ExitCode.guard,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
import crypto from 'node:crypto';
