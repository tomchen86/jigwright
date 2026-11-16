/** Exact role-sharing PlanReview requirements, bindings and eligibility rules. */
import type { RoleContextSharingGrantExpectedBindingV1 } from '@jigwright/core/role-context-sharing-grant-codec';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1,
  ROLE_CONTEXT_SHARING_POLICY_DIGEST,
} from '../authority/role-context-sharing-grant.ts';
import type { RoleContextSharingEligibilityPortV1 } from '../authority/role-context-sharing-grant.ts';
import { isProviderId } from '../provider-orchestration/provider-registry.ts';
import type { RecordedRoleParticipant } from '../provider-orchestration/role-assignment.ts';
import type {
  ActualRolePlacementV1,
  RoleTopologyResolutionV1,
} from '../provider-orchestration/role-topology-resolution.ts';
import type { PlanReviewSubject } from '../assurance/plan-review-subject.ts';
export const DIGEST = /^[0-9a-f]{64}$/u;

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

export function ineligible(message: string) {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE',
    message,
    ExitCode.guard,
  );
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
