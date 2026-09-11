/**
 * Projects provider command previews and authorization decisions without
 * launching providers.
 *
 * Invariants:
 * - Dry-run repository and runtime paths must be absolute for the selected
 *   platform.
 */
import path from 'node:path';

import {
  AgentProviderConfigError,
  assertAgentProviderConfigSnapshot,
  resolveAgentProviderProfile,
  type AgentProviderConfigSnapshot,
  type AgentProviderProfileResolution,
  type AgentProviderRole,
} from '@jigwright/core/agent-provider-config';
import { type ProviderDefinitionSnapshot } from '@jigwright/core/provider-definition-snapshot';

import type { ProviderInvocationPlan } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  isProviderId,
  type ProviderId,
} from '../../modules/provider-orchestration/provider-registry.ts';
import {
  loadAiAdapterPolicy,
  type LoadedAiAdapterPolicy,
} from './ai-adapter-policy.ts';

export type AgentProviderConfigDryRunInput = Readonly<{
  platform: NodeJS.Platform;
  selection:
    Readonly<{ profileId: string }> | Readonly<{ role: AgentProviderRole }>;
  runtimeDirectory: string;
  semanticOutputSchema: unknown;
}>;

export type AgentProviderConfigDryRunReport = Readonly<{
  schemaVersion: 1;
  kind: 'agent-provider-config-dry-run';
  modelLaunched: false;
  configDigest: string;
  profileDigest: string;
  selection: Readonly<{
    profileId: string;
    role: AgentProviderRole | null;
    rank: number | null;
    reason: AgentProviderProfileResolution['selectionReason'];
  }>;
  definition: Readonly<{
    family: string;
    trustTier: 'built-in-reviewed' | 'host-wrapper';
    definitionDigest: string;
    protocol: string;
    executableCandidate: string;
    assuranceEligibility: 'built-in-reviewed' | 'custom-wrapper';
    capabilities: 'not-probed';
  }>;
  command: Readonly<{
    executable: string;
    shell: false;
    cwd: string;
    argv: Readonly<{
      codeOwned: readonly string[];
      hostOwned: readonly string[];
    }>;
    stdinSource: string;
    slots: Readonly<{
      requestFile: string;
      promptFile: string;
      schemaFile: string;
      semanticOutputFile: string;
    }>;
  }>;
  dataAuthorization: Readonly<{
    allowed: boolean;
    policyDigest: string;
    providerId: 'codex' | 'claude' | null;
    reason:
      | 'BUILT_IN_PROVIDER_AUTHORIZED'
      | 'HOST_PROFILE_DISABLED'
      | 'REPOSITORY_PROVIDER_DISABLED'
      | 'HOST_WRAPPER_NOT_AUTHORIZED_BY_POLICY_V4';
  }>;
  authority: Readonly<{
    repositoryAuthority: 'none';
    roleLaneConsequence: 'not-resolved';
    grantConsequence: 'not-evaluated';
  }>;
}>;

export type AgentProviderConfigDryRunBuiltInPort = Readonly<{
  resolveDefinition(
    input: Readonly<{
      providerId: ProviderId;
      platform: NodeJS.Platform;
    }>,
  ): ProviderDefinitionSnapshot | null;
  buildInvocation(
    input: Readonly<{
      providerId: ProviderId;
      executable: string;
      repositoryRoot: string;
      promptPath: string;
      schemaPath: string;
      semanticOutputPath: string;
      semanticOutputSchema: unknown;
    }>,
  ): ProviderInvocationPlan;
}>;

/**
 * Parse and simulate one host profile without invoking preflight or a model.
 * Repository authorization is observed, never minted, by this diagnostic.
 */
/** Consume a validated immutable file snapshot at the production boundary. */
export function dryRunAgentProviderConfigSnapshot(
  repositoryRoot: string,
  snapshot: AgentProviderConfigSnapshot,
  input: AgentProviderConfigDryRunInput,
  builtInPort: AgentProviderConfigDryRunBuiltInPort,
): AgentProviderConfigDryRunReport {
  return dryRunAgentProviderConfigSnapshotWithPolicy(
    repositoryRoot,
    snapshot,
    input,
    builtInPort,
    loadAiAdapterPolicy(repositoryRoot),
  );
}

/** Use one already-loaded exact repository policy across a larger evaluation. */
export function dryRunAgentProviderConfigSnapshotWithPolicy(
  repositoryRoot: string,
  snapshot: AgentProviderConfigSnapshot,
  input: AgentProviderConfigDryRunInput,
  builtInPort: AgentProviderConfigDryRunBuiltInPort,
  policy: LoadedAiAdapterPolicy,
): AgentProviderConfigDryRunReport {
  assertDryRunPaths(repositoryRoot, input);
  const config = assertAgentProviderConfigSnapshot(snapshot);
  const selection = resolveAgentProviderProfile(config, input.selection);
  const slots = runtimeSlots(input.runtimeDirectory, input.platform);
  const definition = resolveDefinition(selection, input.platform, builtInPort);
  const command = buildDryRunCommand(
    repositoryRoot,
    selection,
    slots,
    input.semanticOutputSchema,
    builtInPort,
  );
  const dataAuthorization = evaluateDataAuthorization(selection, policy);

  return deepFreeze({
    schemaVersion: 1,
    kind: 'agent-provider-config-dry-run',
    modelLaunched: false,
    configDigest: config.configDigest,
    profileDigest: selection.profile.profileDigest,
    selection: {
      profileId: selection.profile.id,
      role: selection.role,
      rank: selection.rank,
      reason: selection.selectionReason,
    },
    definition,
    command,
    dataAuthorization,
    authority: {
      repositoryAuthority: 'none',
      roleLaneConsequence: 'not-resolved',
      grantConsequence: 'not-evaluated',
    },
  });
}

function assertDryRunPaths(
  repositoryRoot: string,
  input: AgentProviderConfigDryRunInput,
): void {
  if (
    !isAbsoluteForPlatform(repositoryRoot, input.platform) ||
    !isAbsoluteForPlatform(input.runtimeDirectory, input.platform)
  ) {
    throw new AgentProviderConfigError();
  }
}

function resolveDefinition(
  selection: AgentProviderProfileResolution,
  platform: NodeJS.Platform,
  builtInPort: AgentProviderConfigDryRunBuiltInPort,
): AgentProviderConfigDryRunReport['definition'] {
  const { profile } = selection;
  if (profile.trustTier === 'host-wrapper') {
    return deepFreeze({
      family: profile.family,
      trustTier: profile.trustTier,
      definitionDigest: profile.profileDigest,
      protocol: profile.protocol,
      executableCandidate: profile.executable,
      assuranceEligibility: 'custom-wrapper',
      capabilities: 'not-probed',
    });
  }
  if (!isProviderId(profile.family)) throw new AgentProviderConfigError();
  const definition = builtInPort.resolveDefinition({
    providerId: profile.family,
    platform,
  });
  if (
    definition === null ||
    definition.protocol !== profile.protocol ||
    !definition.executableCandidates.includes(profile.executable)
  ) {
    throw new AgentProviderConfigError();
  }
  return deepFreeze({
    family: profile.family,
    trustTier: profile.trustTier,
    definitionDigest: definition.definitionDigest,
    protocol: definition.protocol,
    executableCandidate: profile.executable,
    assuranceEligibility: 'built-in-reviewed',
    capabilities: 'not-probed',
  });
}

function buildDryRunCommand(
  repositoryRoot: string,
  selection: AgentProviderProfileResolution,
  slots: AgentProviderConfigDryRunReport['command']['slots'],
  semanticOutputSchema: unknown,
  builtInPort: AgentProviderConfigDryRunBuiltInPort,
): AgentProviderConfigDryRunReport['command'] {
  const { profile } = selection;
  if (profile.trustTier === 'host-wrapper') {
    return deepFreeze({
      executable: profile.executable,
      shell: false,
      cwd: path.dirname(slots.requestFile),
      argv: {
        codeOwned: [],
        hostOwned: profile.startArgs.map((argument) =>
          argument.replaceAll('{request_file}', slots.requestFile),
        ),
      },
      stdinSource: slots.promptFile,
      slots,
    });
  }
  if (!isProviderId(profile.family)) throw new AgentProviderConfigError();
  const plan = builtInPort.buildInvocation({
    providerId: profile.family,
    executable: profile.executable,
    repositoryRoot,
    promptPath: slots.promptFile,
    schemaPath: slots.schemaFile,
    semanticOutputPath: slots.semanticOutputFile,
    semanticOutputSchema,
  });
  return deepFreeze({
    executable: plan.executable,
    shell: false,
    cwd: plan.cwd,
    argv: {
      codeOwned: [...plan.args],
      hostOwned: [],
    },
    stdinSource: plan.stdinSource,
    slots,
  });
}

function evaluateDataAuthorization(
  selection: AgentProviderProfileResolution,
  loaded: ReturnType<typeof loadAiAdapterPolicy>,
): AgentProviderConfigDryRunReport['dataAuthorization'] {
  const { profile } = selection;
  if (profile.trustTier === 'host-wrapper') {
    return deepFreeze({
      allowed: false,
      policyDigest: loaded.digest,
      providerId: null,
      reason: 'HOST_WRAPPER_NOT_AUTHORIZED_BY_POLICY_V4',
    });
  }
  if (!isProviderId(profile.family)) throw new AgentProviderConfigError();
  if (!profile.enabled) {
    return deepFreeze({
      allowed: false,
      policyDigest: loaded.digest,
      providerId: profile.family,
      reason: 'HOST_PROFILE_DISABLED',
    });
  }
  if (!loaded.policy.providers[profile.family].enabled) {
    return deepFreeze({
      allowed: false,
      policyDigest: loaded.digest,
      providerId: profile.family,
      reason: 'REPOSITORY_PROVIDER_DISABLED',
    });
  }
  return deepFreeze({
    allowed: true,
    policyDigest: loaded.digest,
    providerId: profile.family,
    reason: 'BUILT_IN_PROVIDER_AUTHORIZED',
  });
}

function runtimeSlots(
  runtimeDirectory: string,
  platform: NodeJS.Platform,
): AgentProviderConfigDryRunReport['command']['slots'] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return deepFreeze({
    requestFile: pathApi.join(runtimeDirectory, 'request.json'),
    promptFile: pathApi.join(runtimeDirectory, 'prompt.json'),
    schemaFile: pathApi.join(runtimeDirectory, 'schema.json'),
    semanticOutputFile: pathApi.join(runtimeDirectory, 'semantic-output.json'),
  });
}

function isAbsoluteForPlatform(
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === 'win32'
    ? path.win32.isAbsolute(candidate)
    : path.posix.isAbsolute(candidate);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
