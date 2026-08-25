import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
  resolveRoleTopologyV1,
  type RoleTopologyResolutionDependencyPortV1,
  type RoleTopologyResolutionV1,
} from '../../modules/provider-orchestration/role-topology-resolution.ts';

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

/**
 * Application bridge for exact-plan review. Composition must inject the
 * repository/configuration snapshot reader; this layer never imports or
 * chooses a concrete adapter, store, executable, or authority implementation.
 */
export function resolvePlanReviewRoleTopology(
  input: ResolvePlanReviewRoleTopologyInput,
  dependencies: RoleTopologyResolutionDependencyPortV1,
): RoleTopologyResolutionV1 {
  if (
    input.author.providerId === undefined ||
    input.author.sessionId === undefined
  ) {
    throw workflowError(
      'ROLE_TOPOLOGY_PARTICIPANT_INVALID',
      'Plan-review topology requires one exact provider-backed author.',
      ExitCode.verification,
    );
  }
  const { changeOverride, providerRegistry } =
    dependencies.readResolutionSnapshot({
      repositoryRoot: input.repositoryRoot,
      changeId: input.changeId,
      planningGeneration: input.planningGeneration,
      providerPolicyDigest: input.providerPolicyDigest,
      providerEnabled: input.providerEnabled,
    });
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
  const definitionByProvider = new Map(
    providerRegistry.providers.map((entry) => [
      entry.logicalProviderId,
      entry.definitionDigest,
    ]),
  );
  const authorDefinitionDigest = definitionByProvider.get(
    input.author.providerId,
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
    changeOverride,
    providerRegistry,
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: input.author.providerId,
        providerDefinitionDigest: authorDefinitionDigest,
        sessionId: input.author.sessionId,
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
