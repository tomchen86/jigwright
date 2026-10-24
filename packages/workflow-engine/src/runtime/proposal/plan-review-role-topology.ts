import {
  type PreparePlanReviewRoleTopologyInput,
  type PreparedPlanReviewRoleTopology,
  type ResolvePlanReviewRoleTopologyInput,
  assertProviderBackedAuthor,
  resolvePlanReviewRoleTopologyFromSnapshot,
  type SelectPlanReviewRoleTopologyInput,
  type SelectedPlanReviewRoleTopology,
} from '../../modules/proposal/plan-review-role-topology.ts';
import type {
  RoleTopologyResolutionDependencyPortV1,
  RoleTopologyResolutionV1,
  RoleTopologyResolutionSnapshotV1,
} from '../../modules/provider-orchestration/role-topology-resolution.ts';
import { scheduleOrdinaryRole } from '../../modules/provider-orchestration/role-assignment.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { createRoleContextSharingPlanReviewRequirementV3 } from '../../modules/proposal/role-context-sharing-plan-review.ts';

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
