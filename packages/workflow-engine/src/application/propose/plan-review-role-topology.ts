/**
 * Selects an exact-plan reviewer and derives its assignment or grant requirement.
 *
 * Invariants:
 * - All candidate placements use one immutable policy and provider snapshot.
 * - Ordinary assignments meet the resolved independence floor before invocation.
 * - Lowered placements require explicit eligibility for their exact role pairs.
 *
 * Depends on: role scheduling, topology resolution, and role-context-sharing requirements.
 * Failure modes: a wrong reviewer is selected or an ineligible grant requirement is returned.
 */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  scheduleOrdinaryRole,
  type RoleAssignment,
  type RoleCandidate,
  type RoleParticipant,
} from '../../modules/provider-orchestration/role-scheduler.ts';
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
