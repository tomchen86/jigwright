/**
 * Connects role/provider default inspection, configuration prompts and
 * simulations to production storage.
 *
 * Invariants:
 * - Configuration and simulation require an explicit provider ranking from
 *   the admitted host configuration.
 */
import path from 'node:path';

import {
  AgentProviderConfigError,
  type AgentProviderConfigSnapshot,
} from '@jigwright/core/agent-provider-config';

import {
  configureCentralRoleProviderDefault,
  type CentralRoleProviderDefaultWizardPromptPort,
  type CentralRoleProviderDefaultWizardResult,
} from '../application/configure/central-role-provider-default-wizard.ts';
import {
  simulateCentralRoleProviderDefault,
  type CentralRoleProviderDefaultSimulationReport,
} from './change-role-assignment-simulation-production.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  renderCentralRoleProviderDefaultSummary,
  type CentralRoleProviderDefaultV1,
} from '../modules/provider-orchestration/central-role-provider-default.ts';
import {
  AgentProviderConfigFileError,
  assertAgentProviderConfigFileCurrent,
  loadAgentProviderConfigFile,
} from '../runtime/provider-execution/agent-provider-config-file.ts';
import {
  readCurrentCentralRoleProviderDefault,
  replaceCurrentCentralRoleProviderDefault,
} from '../runtime/repository-transaction/central-role-provider-default-store.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';

export type CentralRoleProviderDefaultInspection = Readonly<{
  schemaVersion: 1;
  kind: 'central-role-provider-default-inspection';
  configuration: CentralRoleProviderDefaultV1;
  configurationDigest: string;
  summary: string;
  modelLaunched: false;
  assignmentSaved: false;
  callerSaved: false;
}>;

export type CentralRoleProviderDefaultPromptSession = Readonly<{
  prompt: CentralRoleProviderDefaultWizardPromptPort;
  close(): void;
}>;

export type CentralRoleProviderDefaultPromptSessionFactory =
  () => CentralRoleProviderDefaultPromptSession;

export type {
  CentralRoleProviderDefaultSimulationReport,
  CentralRoleProviderDefaultWizardPromptPort,
  CentralRoleProviderDefaultWizardResult,
};

export function inspectCentralRoleProviderDefault(
  repositoryRoot: string,
): CentralRoleProviderDefaultInspection {
  const configuration = readCurrentCentralRoleProviderDefault(repositoryRoot);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'central-role-provider-default-inspection',
    configuration,
    configurationDigest: configuration.configurationDigest,
    summary: renderCentralRoleProviderDefaultSummary(configuration),
    modelLaunched: false,
    assignmentSaved: false,
    callerSaved: false,
  });
}

/**
 * Compose one wizard run only after the external host configuration has been
 * admitted. The entrypoint owns prompt presentation; this composition owns
 * currentness checks and the atomic central-default replacement.
 */
export async function configureCentralRoleProviderDefaultProduction(
  repositoryRoot: string,
  configPath: string,
  platform: NodeJS.Platform,
  createPromptSession: CentralRoleProviderDefaultPromptSessionFactory,
): Promise<CentralRoleProviderDefaultWizardResult> {
  const loaded = loadHostConfiguration(repositoryRoot, configPath, platform);
  const providerConfiguration = assertExplicitRanking(loaded.snapshot);
  const promptSession = createPromptSession();
  if (
    typeof promptSession?.prompt?.chooseProviderPartition !== 'function' ||
    typeof promptSession.close !== 'function'
  ) {
    throw workflowError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_PROMPT_INVALID',
      'Central role/provider setup received an invalid terminal response.',
      ExitCode.usage,
    );
  }
  try {
    return await configureCentralRoleProviderDefault(
      {
        currentConfiguration:
          readCurrentCentralRoleProviderDefault(repositoryRoot),
        providerConfiguration,
      },
      {
        prompt: promptSession.prompt,
        assertProviderConfigurationCurrent() {
          return assertExplicitRanking(
            assertAgentProviderConfigFileCurrent(loaded),
          );
        },
        replaceConfiguration(expectedConfigurationDigest, configuration) {
          return replaceCurrentCentralRoleProviderDefault(
            repositoryRoot,
            expectedConfigurationDigest,
            configuration,
          );
        },
      },
    );
  } finally {
    promptSession.close();
  }
}

export function simulateCentralRoleProviderDefaultProduction(
  repositoryRoot: string,
  configPath: string,
  callerLogicalProviderId: string,
  platform: NodeJS.Platform,
): CentralRoleProviderDefaultSimulationReport {
  const loaded = loadHostConfiguration(repositoryRoot, configPath, platform);
  const providerConfiguration = assertExplicitRanking(
    assertAgentProviderConfigFileCurrent(loaded),
  );
  const report = simulateCentralRoleProviderDefault(repositoryRoot, {
    providerConfigurationSourceDigest: loaded.sourceDigest,
    providerConfiguration,
    callerLogicalProviderId,
  });
  assertAgentProviderConfigFileCurrent(loaded);
  return report;
}

function loadHostConfiguration(
  repositoryRoot: string,
  configPath: string,
  platform: NodeJS.Platform,
) {
  try {
    const loaded = loadAgentProviderConfigFile(configPath, { platform });
    const repository = discoverRepository(repositoryRoot);
    if (
      isSameOrDescendant(repository.repositoryRealPath, loaded.sourcePath) ||
      isSameOrDescendant(repository.gitCommonDirectory, loaded.sourcePath)
    ) {
      throw new AgentProviderConfigFileError(
        'AGENT_PROVIDER_CONFIG_FILE_UNSAFE',
      );
    }
    return loaded;
  } catch (error) {
    if (
      error instanceof AgentProviderConfigFileError ||
      error instanceof AgentProviderConfigError
    ) {
      throw workflowError(
        error.code,
        error.message,
        ExitCode.unsafeEnvironment,
      );
    }
    throw error;
  }
}

function assertExplicitRanking(
  snapshot: AgentProviderConfigSnapshot,
): AgentProviderConfigSnapshot {
  if (snapshot.globalRankingSource !== 'explicit') {
    throw workflowError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_EXPLICIT_RANKING_REQUIRED',
      'Central role/provider setup requires one explicit host provider ranking.',
      ExitCode.verification,
    );
  }
  return snapshot;
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}
