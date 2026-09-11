/**
 * Simulates central role defaults from declared provider capabilities and
 * current repository policy.
 *
 * Invariants:
 * - The report records declared-capabilities-only assumptions and does not
 *   save an assignment or launch a model.
 */
import crypto from 'node:crypto';

import {
  assertAgentProviderConfigSnapshot,
  type AgentProviderConfigSnapshot,
} from '@jigwright/core/agent-provider-config';

import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import {
  resolveChangeRoleAssignmentV1,
  type ResolveChangeRoleAssignmentResultV1,
} from '../modules/provider-orchestration/change-role-assignment.ts';
import {
  isProviderId,
  listBuiltInProviders,
} from '../modules/provider-orchestration/provider-registry.ts';
import { loadAiAdapterPolicy } from '../runtime/provider-execution/ai-adapter-policy.ts';
import { readCurrentCentralRoleProviderDefault } from '../runtime/repository-transaction/central-role-provider-default-store.ts';

export type CentralRoleProviderDefaultSimulationReport = Readonly<{
  schemaVersion: 1;
  kind: 'central-role-provider-default-simulation';
  assumption: 'declared-capabilities-only';
  callerLogicalProviderId: string;
  providerConfigurationSourceDigest: string;
  result: ResolveChangeRoleAssignmentResultV1;
  modelLaunched: false;
  assignmentSaved: false;
  callerSaved: false;
}>;

/**
 * Resolve one explicit hypothetical caller without launching, probing, or
 * persisting. Declared session capabilities are simulation inputs only and do
 * not become runtime or grant authority through this report.
 */
export function simulateCentralRoleProviderDefault(
  repositoryRoot: string,
  input: Readonly<{
    providerConfigurationSourceDigest: string;
    providerConfiguration: AgentProviderConfigSnapshot;
    callerLogicalProviderId: string;
  }>,
): CentralRoleProviderDefaultSimulationReport {
  const providerConfiguration = assertAgentProviderConfigSnapshot(
    input.providerConfiguration,
  );
  const callerProfileId = providerConfiguration.globalRanking.find(
    (profileId) =>
      providerConfiguration.providers.find(({ id }) => id === profileId)
        ?.logicalProviderId === input.callerLogicalProviderId,
  );
  const policy = loadAiAdapterPolicy(repositoryRoot);
  const centralDefault = readCurrentCentralRoleProviderDefault(repositoryRoot);
  const providerRegistryDigest = sha256(canonicalJson(listBuiltInProviders()));
  const planningGeneration = sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'central-role-provider-default-simulation-input',
      callerLogicalProviderId: input.callerLogicalProviderId,
      centralConfigurationDigest: centralDefault.configurationDigest,
      providerConfigurationDigest: providerConfiguration.configDigest,
      providerRegistryDigest,
      dataAuthorizationPolicyDigest: policy.digest,
    }),
  );
  const result = resolveChangeRoleAssignmentV1({
    changeId: 'role-config-simulation',
    planningGeneration,
    providerRegistryDigest,
    centralDefault,
    changeOverride: null,
    providerConfiguration,
    caller: {
      logicalProviderId: input.callerLogicalProviderId,
      profileId: callerProfileId ?? null,
      engineSessionId: 'role-config-simulation-caller-session',
      adoptableRoles: [],
    },
    dataAuthorization: {
      policyDigest: policy.digest,
      inputManifestDigest: null,
      relevantTargetDigest: null,
      profiles: providerConfiguration.providers.map((profile) => {
        const builtIn = isProviderId(profile.family);
        const allowed =
          profile.enabled &&
          profile.trustTier === 'built-in-reviewed' &&
          builtIn &&
          policy.policy.providers[profile.family].enabled;
        return {
          profileId: profile.id,
          allowed,
          reason: !profile.enabled
            ? 'HOST_PROFILE_DISABLED'
            : profile.trustTier !== 'built-in-reviewed' || !builtIn
              ? 'NO_AUTHORITATIVE_LAUNCH_PATH'
              : policy.policy.providers[profile.family].enabled
                ? 'BUILT_IN_PROVIDER_AUTHORIZED_FOR_SIMULATION'
                : 'REPOSITORY_PROVIDER_DISABLED',
        };
      }),
    },
    sessionCapabilities: providerConfiguration.providers.map((profile) => ({
      profileId: profile.id,
      canStartFresh: profile.capabilities.includes('fresh-session'),
      canResume: false,
    })),
  });
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'central-role-provider-default-simulation' as const,
    assumption: 'declared-capabilities-only' as const,
    callerLogicalProviderId: input.callerLogicalProviderId,
    providerConfigurationSourceDigest: input.providerConfigurationSourceDigest,
    result,
    modelLaunched: false as const,
    assignmentSaved: false as const,
    callerSaved: false as const,
  });
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
