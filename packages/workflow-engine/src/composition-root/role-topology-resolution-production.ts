import { resolveBuiltInProviderDefinitionSnapshot } from '../adapters/providers/built-in-provider-definition.ts';
import { listBuiltInProviders } from '../modules/provider-orchestration/provider-registry.ts';
import type { RoleTopologyResolutionDependencyPortV1 } from '../modules/provider-orchestration/role-topology-resolution.ts';
import { readCurrentAgentRolePlan } from '../runtime/repository-transaction/agent-role-plan-store.ts';

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
      return Object.freeze({
        changeOverride: readCurrentAgentRolePlan(
          request.repositoryRoot,
          request.changeId,
          request.planningGeneration,
        ),
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
