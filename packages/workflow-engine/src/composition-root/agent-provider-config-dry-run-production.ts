/**
 * Evaluates provider configuration against observed executables and current
 * policy.
 *
 * Invariants:
 * - The policy must remain unchanged throughout configuration evaluation.
 */
import crypto from 'node:crypto';
import path from 'node:path';

import {
  type AgentProviderConfigSnapshot,
  type AgentProviderRole,
} from '@jigwright/core/agent-provider-config';
import {
  assertProviderExecutableObservationCurrent,
  inspectProviderExecutable,
  type ProviderExecutableObservation,
} from '@jigwright/agent-runtime/provider-executable-identity';
import { type AgentRuntimeExecutableIdentityV1 as ProviderExecutableIdentity } from '@jigwright/core/agent-runtime-port';

import { buildClaudeProviderInvocation } from '../adapters/providers/claude/claude-provider-adapter.ts';
import { buildCodexProviderInvocation } from '../adapters/providers/codex/codex-provider-adapter.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import {
  dryRunAgentProviderConfigSnapshot,
  dryRunAgentProviderConfigSnapshotWithPolicy,
  type AgentProviderConfigDryRunBuiltInPort,
  type AgentProviderConfigDryRunInput,
  type AgentProviderConfigDryRunReport,
} from '../runtime/provider-execution/agent-provider-config-dry-run.ts';
import { loadAiAdapterPolicy } from '../runtime/provider-policy/ai-adapter-policy.ts';
import {
  AgentProviderConfigFileError,
  assertAgentProviderConfigFileCurrent,
  loadAgentProviderConfigFile,
} from '../runtime/provider-execution/agent-provider-config-file.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';

export { AgentProviderConfigFileError } from '../runtime/provider-execution/agent-provider-config-file.ts';

const AGENT_PROVIDER_ROLES = [
  'author',
  'builder',
  'reviewer',
] as const satisfies readonly AgentProviderRole[];

export type AgentProviderConfigEvaluationReport = Readonly<{
  schemaVersion: 2;
  kind: 'agent-provider-config-evaluation';
  modelLaunched: false;
  /** No configured provider executable or provider probe process was launched. */
  processLaunched: false;
  assignmentSaved: false;
  sourceDigest: string;
  configDigest: string;
  platform: string;
  globalRanking: readonly string[];
  globalRankingSource: AgentProviderConfigSnapshot['globalRankingSource'];
  profiles: readonly Readonly<{
    id: string;
    logicalProviderId: string;
    family: string;
    capabilities: AgentProviderConfigSnapshot['providers'][number]['capabilities'];
    trustTier: 'built-in-reviewed' | 'host-wrapper';
    enabled: boolean;
    profileDigest: string;
    executableObservation: AgentProviderProfileExecutableObservation;
  }>[];
  rankings: Readonly<Record<AgentProviderRole, readonly string[]>>;
  roleDryRuns: Readonly<
    Record<AgentProviderRole, AgentProviderConfigDryRunReport>
  >;
}>;

export type AgentProviderProfileExecutableObservation = Readonly<{
  schemaVersion: 1;
  kind: 'agent-provider-profile-executable-observation';
  profileId: string;
  profileDigest: string;
  configDigest: string;
  candidatePath: string;
  state: ProviderExecutableObservation['state'];
  unsafeReason: ProviderExecutableObservation['unsafeReason'];
  identity: ProviderExecutableIdentity | null;
  /** This exact profile candidate was inspected as data and never executed. */
  processLaunched: false;
  availabilityAuthority: 'none';
  compatibility: 'not-probed';
  trustRootConsequence: 'not-evaluated';
  observationDigest: string;
}>;

const productionAgentProviderConfigDryRunPort: AgentProviderConfigDryRunBuiltInPort =
  Object.freeze({
    resolveDefinition({ providerId, platform }) {
      return resolveBuiltInProviderDefinitionSnapshot(providerId, platform);
    },
    buildInvocation(input) {
      return input.providerId === 'codex'
        ? buildCodexProviderInvocation({
            executable: input.executable,
            repositoryRoot: input.repositoryRoot,
            promptPath: input.promptPath,
            schemaPath: input.schemaPath,
            semanticOutputPath: input.semanticOutputPath,
          })
        : buildClaudeProviderInvocation({
            executable: input.executable,
            repositoryRoot: input.repositoryRoot,
            promptPath: input.promptPath,
            schemaPath: input.schemaPath,
            semanticOutputPath: input.semanticOutputPath,
            semanticOutputSchema: input.semanticOutputSchema,
          });
    },
  });

/**
 * Production composition for one current host configuration plus code-reviewed
 * provider definitions and command builders. This path accepts no raw TOML.
 */
export function dryRunAgentProviderConfig(
  repositoryRoot: string,
  configFilePath: string,
  input: AgentProviderConfigDryRunInput,
): AgentProviderConfigDryRunReport {
  const loaded = loadAgentProviderConfigFile(configFilePath, {
    platform: input.platform,
  });
  return dryRunAgentProviderConfigSnapshot(
    repositoryRoot,
    assertAgentProviderConfigFileCurrent(loaded),
    input,
    productionAgentProviderConfigDryRunPort,
  );
}

/**
 * Project every explicit role ranking from one external host-owned file.
 * This diagnostic never runs a configured provider executable or probe,
 * launches a model, writes a runtime file, or persists an assignment. Read-only
 * repository discovery may still invoke Git and does not make this observation
 * provider availability authority.
 */
export function evaluateAgentProviderConfig(
  repositoryRoot: string,
  configFilePath: string,
  platform: NodeJS.Platform = process.platform,
): AgentProviderConfigEvaluationReport {
  const repository = discoverRepository(repositoryRoot);
  const loaded = loadAgentProviderConfigFile(configFilePath, { platform });
  assertExternalHostConfigPath(
    loaded.sourcePath,
    repository.repositoryRealPath,
    repository.gitCommonDirectory,
  );
  const runtimeDirectory = path.join(
    path.dirname(loaded.sourcePath),
    '.agent-provider-config-evaluation',
  );
  const roleDryRuns = {} as Record<
    AgentProviderRole,
    AgentProviderConfigDryRunReport
  >;
  const initialSnapshot = assertAgentProviderConfigFileCurrent(loaded);
  const policySnapshot = loadAiAdapterPolicy(repository.repositoryRealPath);
  const executableObservations = new Map<
    string,
    ProviderExecutableObservation
  >();
  const executableObservationsByCandidate = new Map<
    string,
    ProviderExecutableObservation
  >();
  for (const profile of initialSnapshot.providers) {
    let observation = executableObservationsByCandidate.get(profile.executable);
    if (observation === undefined) {
      observation = inspectProviderExecutable(profile.executable);
      executableObservationsByCandidate.set(profile.executable, observation);
    }
    executableObservations.set(profile.id, observation);
  }

  for (const role of AGENT_PROVIDER_ROLES) {
    const currentSnapshot = assertAgentProviderConfigFileCurrent(loaded);
    roleDryRuns[role] = dryRunAgentProviderConfigSnapshotWithPolicy(
      repository.repositoryRealPath,
      currentSnapshot,
      {
        platform,
        selection: { role },
        runtimeDirectory,
        semanticOutputSchema: {
          type: 'object',
          additionalProperties: true,
        },
      },
      productionAgentProviderConfigDryRunPort,
      policySnapshot,
    );
  }

  const currentSnapshot = assertAgentProviderConfigFileCurrent(loaded);
  const report: AgentProviderConfigEvaluationReport = deepFreezeEvaluation({
    schemaVersion: 2,
    kind: 'agent-provider-config-evaluation',
    modelLaunched: false,
    processLaunched: false,
    assignmentSaved: false,
    sourceDigest: loaded.sourceDigest,
    configDigest: currentSnapshot.configDigest,
    platform: currentSnapshot.platform,
    globalRanking: [...currentSnapshot.globalRanking],
    globalRankingSource: currentSnapshot.globalRankingSource,
    profiles: currentSnapshot.providers.map((profile) => {
      const executableObservation = executableObservations.get(profile.id);
      if (
        executableObservation === undefined ||
        executableObservation.candidatePath !== profile.executable
      ) {
        throw new AgentProviderConfigFileError(
          'AGENT_PROVIDER_CONFIG_FILE_STALE',
        );
      }
      return {
        id: profile.id,
        logicalProviderId: profile.logicalProviderId,
        family: profile.family,
        capabilities: [...profile.capabilities],
        trustTier: profile.trustTier,
        enabled: profile.enabled,
        profileDigest: profile.profileDigest,
        executableObservation: bindProfileExecutableObservation(
          currentSnapshot.configDigest,
          profile.id,
          profile.profileDigest,
          executableObservation,
        ),
      };
    }),
    rankings: copyRankings(currentSnapshot),
    roleDryRuns,
  });

  for (const observation of executableObservationsByCandidate.values()) {
    assertProviderExecutableObservationCurrent(observation);
  }
  const finalPolicy = loadAiAdapterPolicy(repository.repositoryRealPath);
  if (
    finalPolicy.digest !== policySnapshot.digest ||
    finalPolicy.document !== policySnapshot.document
  ) {
    throw new AgentProviderConfigFileError('AGENT_PROVIDER_CONFIG_FILE_STALE');
  }
  const finalSnapshot = assertAgentProviderConfigFileCurrent(loaded);
  if (finalSnapshot.configDigest !== report.configDigest) {
    throw new AgentProviderConfigFileError('AGENT_PROVIDER_CONFIG_FILE_STALE');
  }
  return report;
}

function bindProfileExecutableObservation(
  configDigest: string,
  profileId: string,
  profileDigest: string,
  observation: ProviderExecutableObservation,
): AgentProviderProfileExecutableObservation {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'agent-provider-profile-executable-observation' as const,
    profileId,
    profileDigest,
    configDigest,
    candidatePath: observation.candidatePath,
    state: observation.state,
    unsafeReason: observation.unsafeReason,
    identity: observation.identity,
    processLaunched: false as const,
    availabilityAuthority: 'none' as const,
    compatibility: 'not-probed' as const,
    trustRootConsequence: 'not-evaluated' as const,
  };
  return deepFreezeEvaluation({
    ...payload,
    observationDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(payload))
      .digest('hex'),
  });
}

function copyRankings(
  snapshot: AgentProviderConfigSnapshot,
): Record<AgentProviderRole, string[]> {
  return {
    author: [...snapshot.preferences.author],
    builder: [...snapshot.preferences.builder],
    reviewer: [...snapshot.preferences.reviewer],
  };
}

function assertExternalHostConfigPath(
  configPath: string,
  repositoryRoot: string,
  gitCommonDirectory: string,
): void {
  if (
    isSameOrDescendant(repositoryRoot, configPath) ||
    isSameOrDescendant(gitCommonDirectory, configPath)
  ) {
    throw new AgentProviderConfigFileError('AGENT_PROVIDER_CONFIG_FILE_UNSAFE');
  }
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function deepFreezeEvaluation<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeEvaluation(child);
    Object.freeze(value);
  }
  return value;
}
