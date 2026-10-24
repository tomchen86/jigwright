/**
 * Checks PlanReview grant, participant, and collaboration evidence ownership.
 *
 * Invariants:
 * - Grant subjects, recorded participants, and assignment decisions bind exact canonical evidence.
 * - Optional grant requirements preserve their existing target and policy constraints.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import { type EvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import { assertPlanReviewSubject } from '../../modules/assurance/plan-review.ts';
import {
  isProviderRoleAssignment,
  isRoleContextSharingGrantedAssignment,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  type InvestigationEvidenceOwnership,
  assertProposeEvidenceNode,
} from './evidence-planning-ownership.ts';
import {
  GIT_OBJECT_ID_PATTERN,
  hasExactKeys,
  isDigest,
  isInvestigationOwner,
  isPlainRecord,
  refInvalid,
  sha256,
} from '../journal-primitives/evidence-store-values.ts';

export function assertPlanReviewAuthorizationGrantOwnership(input: {
  changeId: string;
  subject: ReturnType<typeof assertPlanReviewSubject>;
  assignment: unknown;
  author: unknown;
  grantAuthorization: unknown;
}): 'ordinary' | 'collaboration' | 'role-context-sharing' {
  if (
    !isProviderRoleAssignment(input.assignment) ||
    input.assignment.role !== 'plan-reviewer' ||
    input.assignment.targetDigest !== input.subject.subjectDigest
  ) {
    throw refInvalid();
  }
  const assignment = input.assignment;
  const author = assertPlanReviewRecordedParticipantOwnership(input.author);
  const grantAuthorization = input.grantAuthorization;
  if (isRoleContextSharingGrantedAssignment(assignment)) {
    if (
      !isPlainRecord(grantAuthorization) ||
      !hasExactKeys(grantAuthorization, [
        'kind',
        'grantId',
        'requirementNodeId',
        'expectedBinding',
        'reservationReceiptDigest',
        'reservationRecordDigest',
      ]) ||
      grantAuthorization.kind !==
        'role-context-sharing-plan-review-authorization.v1' ||
      grantAuthorization.grantId !== assignment.roleContextSharingGrantId ||
      !isDigest(grantAuthorization.requirementNodeId) ||
      grantAuthorization.reservationReceiptDigest !==
        assignment.reservationReceiptDigest ||
      !isDigest(grantAuthorization.reservationRecordDigest) ||
      !isPlainRecord(grantAuthorization.expectedBinding)
    ) {
      throw refInvalid();
    }
    const expected = grantAuthorization.expectedBinding;
    if (
      !hasExactKeys(expected, [
        'repositoryId',
        'repositoryOrigin',
        'policyBlob',
        'roleContextSharingPolicyDigest',
        'centralRoleConfigurationDigest',
        'changeOverrideDigest',
        'providerRegistryDigest',
        'eligibilityPolicyDigest',
        'changeId',
        'taskId',
        'baselineCommit',
        'baselineTree',
        'targetDigest',
        'lifecyclePhase',
        'subjectDigest',
        'planningGeneration',
        'rolePairs',
        'contextGeneration',
        'sessionGeneration',
        'sharedEngineSessionId',
        'providerDefinitionDigest',
        'reason',
      ]) ||
      typeof expected.repositoryId !== 'string' ||
      expected.repositoryId.length === 0 ||
      typeof expected.repositoryOrigin !== 'string' ||
      expected.repositoryOrigin.length === 0 ||
      typeof expected.policyBlob !== 'string' ||
      !GIT_OBJECT_ID_PATTERN.test(expected.policyBlob) ||
      ![
        expected.roleContextSharingPolicyDigest,
        expected.centralRoleConfigurationDigest,
        expected.changeOverrideDigest,
        expected.providerRegistryDigest,
        expected.eligibilityPolicyDigest,
        expected.providerDefinitionDigest,
      ].every(isDigest) ||
      expected.changeId !== input.changeId ||
      expected.taskId !== null ||
      expected.baselineCommit !== input.subject.investigationBaseline.head ||
      expected.baselineTree !== input.subject.investigationBaseline.tree ||
      expected.targetDigest !== input.subject.subjectDigest ||
      expected.lifecyclePhase !== 'plan-review' ||
      expected.subjectDigest !== input.subject.subjectDigest ||
      expected.planningGeneration !== input.subject.planningGenerationId ||
      canonicalJson(expected.rolePairs) !==
        canonicalJson(assignment.exactRolePairs) ||
      expected.contextGeneration !== assignment.contextGeneration ||
      expected.sessionGeneration !== assignment.sessionGeneration ||
      expected.sharedEngineSessionId !== assignment.sharedEngineSessionId ||
      expected.providerDefinitionDigest !==
        assignment.providerDefinitionDigest ||
      typeof expected.reason !== 'string' ||
      expected.reason.length === 0
    ) {
      throw refInvalid();
    }
    return 'role-context-sharing';
  }
  if ('grantId' in assignment) {
    if (
      !isPlainRecord(grantAuthorization) ||
      !hasExactKeys(grantAuthorization, [
        'grantId',
        'transitionDigest',
        'expectedBinding',
      ]) ||
      grantAuthorization.grantId !== assignment.grantId ||
      !isDigest(grantAuthorization.transitionDigest) ||
      !isPlainRecord(grantAuthorization.expectedBinding) ||
      canonicalJson(author) !== canonicalJson(assignment.author)
    ) {
      throw refInvalid();
    }
    const expected = grantAuthorization.expectedBinding;
    if (
      !hasExactKeys(expected, [
        'repositoryId',
        'repositoryOrigin',
        'policyBlob',
        'collaborationPolicyDigest',
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
      ]) ||
      typeof expected.repositoryId !== 'string' ||
      expected.repositoryId.length === 0 ||
      typeof expected.repositoryOrigin !== 'string' ||
      expected.repositoryOrigin.length === 0 ||
      typeof expected.policyBlob !== 'string' ||
      !GIT_OBJECT_ID_PATTERN.test(expected.policyBlob) ||
      !isDigest(expected.collaborationPolicyDigest) ||
      expected.changeId !== input.changeId ||
      expected.taskId !== null ||
      expected.baselineCommit !== input.subject.investigationBaseline.head ||
      expected.baselineTree !== input.subject.investigationBaseline.tree ||
      expected.targetDigest !== input.subject.subjectDigest ||
      expected.lifecyclePhase !== 'plan-review' ||
      canonicalJson(expected.rolePair) !==
        canonicalJson({
          authorRole: 'plan-author',
          conflictingRole: 'plan-reviewer',
        }) ||
      canonicalJson(expected.availableActor) !==
        canonicalJson({
          kind: 'provider',
          providerId: author.providerId,
          assurance: author.identityAssurance,
        }) ||
      expected.degradedForm !== 'same-provider-fresh-session' ||
      typeof expected.reason !== 'string' ||
      expected.reason.length === 0 ||
      grantAuthorization.transitionDigest !==
        sha256(
          canonicalJson({
            schemaVersion: 1,
            kind: 'collaboration-role-transition',
            expectedBinding: expected,
          }),
        )
    ) {
      throw refInvalid();
    }
    return 'collaboration';
  }
  if (
    grantAuthorization !== null ||
    author.providerId === null ||
    author.sessionId === null ||
    (assignment.requiredIndependence !== 'session-independent' &&
      assignment.requiredIndependence !== 'provider-independent') ||
    (assignment.achievedIndependence !== 'provider-independent' &&
      assignment.achievedIndependence !== 'session-independent') ||
    (assignment.requiredIndependence === 'provider-independent' &&
      assignment.achievedIndependence !== 'provider-independent') ||
    (author.providerId === assignment.providerId &&
      author.sessionId === assignment.sessionId)
  ) {
    throw refInvalid();
  }
  return 'ordinary';
}

type PlanReviewRecordedParticipantOwnership = Readonly<{
  providerId: ProviderId | null;
  sessionId: string | null;
  principalId: string | null;
  identityAssurance:
    'self-declared' | 'runtime-hint' | 'adapter-assigned' | 'maintainer-signed';
  engineSpawned: boolean;
}>;

function assertPlanReviewRecordedParticipantOwnership(
  value: unknown,
): PlanReviewRecordedParticipantOwnership {
  if (
    !isPlainRecord(value) ||
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
    throw refInvalid();
  }
  return value as PlanReviewRecordedParticipantOwnership;
}

export function assertPlanReviewGrantRequirementOwnership(
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  const output = node.output;
  assertProposeEvidenceNode(node, {
    type: 'plan-review-grant-requirement',
    nodeSchema: 'workflow.plan-review-grant-requirement.v3',
    outputSchema: 'workflow.plan-review-grant-requirement-output.v3',
    exactInputKeys: ['requirement'],
    provenanceKeys: [],
    semanticKeys: [],
  });
  if (
    !isPlainRecord(output) ||
    !hasExactKeys(output, ['requirement']) ||
    !isPlainRecord(output.requirement)
  ) {
    throw refInvalid();
  }
  const requirement = output.requirement;
  const collaborationRequirement =
    requirement.kind === 'collaboration-plan-review-requirement.v3' &&
    requirement.schemaVersion === 3;
  const roleContextRequirement =
    requirement.kind === 'role-context-sharing-plan-review-requirement.v3' &&
    requirement.schemaVersion === 3 &&
    hasExactKeys(requirement, [
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
    ]) &&
    isPlainRecord(requirement.author) &&
    isPlainRecord(requirement.roleTopology);
  if (
    (!collaborationRequirement && !roleContextRequirement) ||
    requirement.changeId !== expectedChangeId ||
    !isInvestigationOwner(requirement.investigationId) ||
    node.exactInputDigests.requirement !== sha256(canonicalJson(requirement))
  ) {
    throw refInvalid();
  }
  const subject = assertPlanReviewSubject(requirement.subject);
  if (collaborationRequirement) {
    if (
      !hasExactKeys(requirement, [
        'schemaVersion',
        'kind',
        'investigationId',
        'changeId',
        'subject',
        'author',
        'grantRequest',
      ])
    ) {
      throw refInvalid();
    }
    const author = assertPlanReviewRecordedParticipantOwnership(
      requirement.author,
    );
    assertCollaborationPlanReviewGrantRequestOwnership({
      value: requirement.grantRequest,
      changeId: expectedChangeId,
      subject,
      author,
    });
  }
  return Object.freeze({
    ownerInvestigationId: requirement.investigationId,
    dependencies: Object.freeze([]),
  });
}

function assertCollaborationPlanReviewGrantRequestOwnership(input: {
  value: unknown;
  changeId: string;
  subject: ReturnType<typeof assertPlanReviewSubject>;
  author: PlanReviewRecordedParticipantOwnership;
}): void {
  if (input.value === null) return;
  const value = input.value;
  if (
    !isPlainRecord(value) ||
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
    value.changeId !== input.changeId ||
    value.taskId !== null ||
    value.baselineCommit !== input.subject.investigationBaseline.head ||
    value.baselineTree !== input.subject.investigationBaseline.tree ||
    value.targetDigest !== input.subject.subjectDigest ||
    value.lifecyclePhase !== 'plan-review' ||
    canonicalJson(value.rolePair) !==
      canonicalJson({
        authorRole: 'plan-author',
        conflictingRole: 'plan-reviewer',
      }) ||
    input.author.providerId === null ||
    canonicalJson(value.availableActor) !==
      canonicalJson({
        kind: 'provider',
        providerId: input.author.providerId,
        assurance: input.author.identityAssurance,
      }) ||
    value.degradedForm !== 'same-provider-fresh-session' ||
    value.reason !==
      'No provider-independent exact-plan reviewer is callable for this exact planning generation.' ||
    value.ttlMinutes !== 30 ||
    value.maxUses !== 1
  ) {
    throw refInvalid();
  }
}
