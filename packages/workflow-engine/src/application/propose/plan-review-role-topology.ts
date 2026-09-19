/**
 * Selects an exact-plan reviewer and derives its assignment or grant requirement.
 *
 * Invariants:
 * - All candidate placements use one immutable policy and provider snapshot.
 * - Ordinary assignments meet the resolved independence floor before invocation.
 * - Lowered placements require explicit eligibility for their exact role pairs.
 */
import type { ProposeLifecycleStatus } from './propose-types.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  scheduleOrdinaryRole,
  type RoleAssignment,
  type RoleCandidate,
  type RoleParticipant,
} from '../../modules/provider-orchestration/role-assignment.ts';
import {
  CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
  resolveRoleTopologyV1,
  type RoleTopologyResolutionDependencyPortV1,
  type RoleTopologyResolutionSnapshotV1,
  type RoleTopologyResolutionV1,
} from '../../modules/provider-orchestration/role-topology-resolution.ts';
import {
  createRoleContextSharingPlanReviewRequirementV3,
  type RoleContextSharingPlanReviewRequirementV3,
} from './role-context-sharing-plan-review.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { assertPlanReviewSubject } from '../../modules/assurance/plan-review.ts';
import { DIGEST, hasExactKeys, isRecord } from './propose-common.ts';
import type {
  ProviderRoleAssignment,
  RecordedRoleParticipant,
} from '../../modules/provider-orchestration/role-assignment.ts';

export type ResolvePlanReviewRoleTopologyInput = Readonly<{
  repositoryRoot: string;
  changeId: string;
  planningGeneration: string;
  author: Readonly<{
    providerId: string | undefined;
    sessionId: string | undefined;
  }>;
  reviewer: Readonly<{
    providerId: string;
    sessionId: string;
  }>;
  providerPolicyDigest: string;
  providerEnabled: Readonly<Record<string, boolean>>;
}>;

export type SelectPlanReviewRoleTopologyInput = Readonly<
  Omit<ResolvePlanReviewRoleTopologyInput, 'reviewer'> & {
    reviewers: readonly ResolvePlanReviewRoleTopologyInput['reviewer'][];
  }
>;

export type SelectedPlanReviewRoleTopology = Readonly<{
  reviewer: ResolvePlanReviewRoleTopologyInput['reviewer'];
  resolution: RoleTopologyResolutionV1;
}>;

export type PreparePlanReviewRoleTopologyInput = Readonly<{
  topology: Omit<ResolvePlanReviewRoleTopologyInput, 'reviewer'>;
  author: RoleParticipant;
  candidates: RoleCandidate[];
  requirement: Omit<
    Parameters<typeof createRoleContextSharingPlanReviewRequirementV3>[0],
    'roleTopology'
  >;
}>;

export type PreparedPlanReviewRoleTopology =
  | {
      kind: 'grant-required';
      roleTopology: RoleTopologyResolutionV1;
      requirement: RoleContextSharingPlanReviewRequirementV3;
    }
  | {
      kind: 'assigned';
      roleTopology: RoleTopologyResolutionV1;
      assignment: RoleAssignment;
    };

export function preparePlanReviewRoleTopology(
  input: PreparePlanReviewRoleTopologyInput,
  dependencies: RoleTopologyResolutionDependencyPortV1,
): PreparedPlanReviewRoleTopology {
  const ordinaryPlacements = input.candidates.flatMap((candidate) => {
    const outcome = scheduleOrdinaryRole({
      role: 'plan-reviewer',
      requestedIndependence: 'session-independent',
      author: input.author,
      targetDigest: input.requirement.subject.subjectDigest,
      candidates: [candidate],
    });
    return outcome.outcome === 'assigned' ? [outcome.assignment] : [];
  });
  const selectedTopology = selectPlanReviewRoleTopology(
    {
      ...input.topology,
      reviewers: ordinaryPlacements.map(({ providerId, sessionId }) => ({
        providerId,
        sessionId,
      })),
    },
    dependencies,
  );
  const roleTopology = selectedTopology.resolution;
  if (roleTopology.disposition === 'topology-unsatisfied') {
    throw workflowError(
      'ROLE_TOPOLOGY_UNSATISFIED',
      'The exact PlanReview placement does not satisfy the configured topology.',
      ExitCode.guard,
      {
        details: {
          exactRolePairs: roleTopology.exactGrantRolePairs,
        },
      },
    );
  }
  if (roleTopology.disposition === 'exact-grant-required') {
    if (roleTopology.explicitEligibility.status !== 'listed') {
      throw workflowError(
        'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE',
        'The exact lowered PlanReview role pairs are not explicitly listed for a role-context-sharing grant.',
        ExitCode.guard,
        {
          details: {
            exactRolePairs: roleTopology.exactGrantRolePairs,
          },
        },
      );
    }
    return {
      kind: 'grant-required',
      roleTopology,
      requirement: createRoleContextSharingPlanReviewRequirementV3({
        ...input.requirement,
        roleTopology,
      }),
    };
  }
  const requiredIndependence = roleTopology.actualRolePairs.find(
    ({ pair }) => pair === 'author-reviewer',
  )?.required;
  const selectedCandidate = input.candidates.find(
    ({ providerId, sessionId }) =>
      providerId === selectedTopology.reviewer.providerId &&
      sessionId === selectedTopology.reviewer.sessionId,
  );
  if (requiredIndependence === undefined || selectedCandidate === undefined) {
    throw workflowError(
      'ROLE_TOPOLOGY_UNSATISFIED',
      'A satisfied PlanReview topology has no exact provider assignment.',
      ExitCode.guard,
    );
  }
  const strengthenedSchedule = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    requestedIndependence: requiredIndependence,
    author: input.author,
    targetDigest: input.requirement.subject.subjectDigest,
    candidates: [selectedCandidate],
  });
  if (strengthenedSchedule.outcome !== 'assigned') {
    throw workflowError(
      'ROLE_TOPOLOGY_UNSATISFIED',
      'A satisfied PlanReview topology has no exact provider assignment.',
      ExitCode.guard,
    );
  }
  return {
    kind: 'assigned',
    roleTopology,
    assignment: strengthenedSchedule.assignment,
  };
}

/**
 * Application bridge for exact-plan review. Composition must inject the
 * repository/configuration snapshot reader; this layer never imports or
 * chooses a concrete adapter, store, executable, or authority implementation.
 */
export function resolvePlanReviewRoleTopology(
  input: ResolvePlanReviewRoleTopologyInput,
  dependencies: RoleTopologyResolutionDependencyPortV1,
): RoleTopologyResolutionV1 {
  assertProviderBackedAuthor(input.author);
  const snapshot = readResolutionSnapshot(input, dependencies);
  return resolvePlanReviewRoleTopologyFromSnapshot(input, snapshot);
}

/**
 * Select the first ordinary reviewer that satisfies the exact current topology.
 * A listed exact-Grant placement is considered only when no ordinary candidate
 * satisfies the strengthened floor. Every candidate is evaluated against one
 * immutable dependency snapshot so selection cannot mix policy observations.
 */
export function selectPlanReviewRoleTopology(
  input: SelectPlanReviewRoleTopologyInput,
  dependencies: RoleTopologyResolutionDependencyPortV1,
): SelectedPlanReviewRoleTopology {
  assertProviderBackedAuthor(input.author);
  if (input.reviewers.length === 0) {
    throw workflowError(
      'ROLE_TOPOLOGY_UNSATISFIED',
      'Plan-review role topology has no callable provider-backed reviewer placement.',
      ExitCode.guard,
    );
  }
  const snapshot = readResolutionSnapshot(input, dependencies);
  const candidates = input.reviewers.map((reviewer) => ({
    reviewer,
    resolution: resolvePlanReviewRoleTopologyFromSnapshot(
      { ...input, reviewer },
      snapshot,
    ),
  }));
  return (
    candidates.find(
      ({ resolution }) => resolution.disposition === 'satisfied',
    ) ??
    candidates.find(
      ({ resolution }) => resolution.disposition === 'exact-grant-required',
    ) ??
    candidates[0]!
  );
}

function assertProviderBackedAuthor(
  author: ResolvePlanReviewRoleTopologyInput['author'],
): void {
  if (author.providerId === undefined || author.sessionId === undefined) {
    throw workflowError(
      'ROLE_TOPOLOGY_PARTICIPANT_INVALID',
      'Plan-review topology requires one exact provider-backed author.',
      ExitCode.verification,
    );
  }
}

function readResolutionSnapshot(
  input: Omit<ResolvePlanReviewRoleTopologyInput, 'reviewer'>,
  dependencies: RoleTopologyResolutionDependencyPortV1,
): RoleTopologyResolutionSnapshotV1 {
  const snapshot = dependencies.readResolutionSnapshot({
    repositoryRoot: input.repositoryRoot,
    changeId: input.changeId,
    planningGeneration: input.planningGeneration,
    providerPolicyDigest: input.providerPolicyDigest,
    providerEnabled: input.providerEnabled,
  });
  const { providerRegistry } = snapshot;
  if (
    providerRegistry.policyDigest !== input.providerPolicyDigest ||
    providerRegistry.providers.some(
      (entry) =>
        input.providerEnabled[entry.logicalProviderId] !== entry.enabled,
    )
  ) {
    throw workflowError(
      'ROLE_TOPOLOGY_PROVIDER_REGISTRY_MISMATCH',
      'Plan-review topology provider registry does not match the requested policy snapshot.',
      ExitCode.guard,
    );
  }
  return snapshot;
}

function resolvePlanReviewRoleTopologyFromSnapshot(
  input: ResolvePlanReviewRoleTopologyInput,
  snapshot: RoleTopologyResolutionSnapshotV1,
): RoleTopologyResolutionV1 {
  const { baseCentralConfigurationDigest, changeOverride, providerRegistry } =
    snapshot;
  const definitionByProvider = new Map(
    providerRegistry.providers.map((entry) => [
      entry.logicalProviderId,
      entry.definitionDigest,
    ]),
  );
  const authorDefinitionDigest = definitionByProvider.get(
    input.author.providerId!,
  );
  const reviewerDefinitionDigest = definitionByProvider.get(
    input.reviewer.providerId,
  );
  if (authorDefinitionDigest == null || reviewerDefinitionDigest == null) {
    throw workflowError(
      'ROLE_TOPOLOGY_PROVIDER_DEFINITION_UNAVAILABLE',
      'Plan-review topology requires current reviewed provider-definition snapshots.',
      ExitCode.guard,
    );
  }
  return resolveRoleTopologyV1({
    changeId: input.changeId,
    planningGeneration: input.planningGeneration,
    centralConfiguration: CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
    baseCentralConfigurationDigest,
    changeOverride,
    providerRegistry,
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: input.author.providerId!,
        providerDefinitionDigest: authorDefinitionDigest,
        sessionId: input.author.sessionId!,
      },
      {
        role: 'reviewer',
        logicalProviderId: input.reviewer.providerId,
        providerDefinitionDigest: reviewerDefinitionDigest,
        sessionId: input.reviewer.sessionId,
      },
    ],
  });
}

/**
 * Builds and validates proposal review grants, requirements, and retry bindings.
 *
 * Invariants:
 * - Stored requirements retain their exact subject, author, baseline, and role bindings.
 * - A retry keeps its deterministic identity and the failed request's semantic inputs.
 */

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
