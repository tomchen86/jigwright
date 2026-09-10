/**
 * Builds role topology comparison snapshots from current policy and
 * reviewed provider definitions.
 *
 * Invariants:
 * - Providers are sorted by logical identity, and enabled is true only for
 *   an explicit true policy value.
 */
import { resolveBuiltInProviderDefinitionSnapshot } from '../adapters/providers/built-in-provider-definition.ts';
import { listBuiltInProviders } from '../modules/provider-orchestration/provider-registry.ts';
import type { RoleTopologyResolutionDependencyPortV1 } from '../modules/provider-orchestration/role-topology-resolution.ts';
import { readCurrentPlanningAgentRolePlanV2 } from '../modules/source/planning-role-provider-policy-reader.ts';

/**
 * Bind the application-owned topology port to the current repository reader
 * and reviewed built-in provider definitions. Selection and authority remain
 * outside this adapter: it returns one immutable comparison snapshot only.
 */
export function createProductionRoleTopologyResolutionPort(
  platform: NodeJS.Platform = process.platform,
): RoleTopologyResolutionDependencyPortV1 {
  return Object.freeze({
    readResolutionSnapshot(request) {
      const providers = listBuiltInProviders()
        .map(({ id }) => {
          const definition = resolveBuiltInProviderDefinitionSnapshot(
            id,
            platform,
          );
          return Object.freeze({
            logicalProviderId: id,
            providerFamily: definition?.providerFamily ?? id,
            enabled: request.providerEnabled[id] === true,
            definitionDigest: definition?.definitionDigest ?? null,
          });
        })
        .sort((left, right) =>
          left.logicalProviderId.localeCompare(right.logicalProviderId),
        );
      const changeOverride = readCurrentPlanningAgentRolePlanV2(
        request.repositoryRoot,
        request.changeId,
      );
      return Object.freeze({
        baseCentralConfigurationDigest:
          changeOverride?.baseCentralConfigurationDigest ?? null,
        changeOverride,
        providerRegistry: Object.freeze({
          schemaVersion: 1 as const,
          policyDigest: request.providerPolicyDigest,
          providers: Object.freeze(providers),
        }),
      });
    },
  });
}

export const productionRoleTopologyResolutionPort =
  createProductionRoleTopologyResolutionPort();
