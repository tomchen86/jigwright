import type { AgentProviderConfigSnapshot } from '@jigwright/agent-runtime';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  createCentralRoleProviderDefault,
  providerPartitionChoices,
  providerRuleChoices,
  renderCentralRoleProviderDefaultSummary,
  sessionPartitionChoices,
  type CentralProviderRuleV1,
  type CentralRoleProviderDefaultV1,
  type ProviderPartitionChoiceV1,
  type ProviderRuleChoiceV1,
  type SessionPartitionChoiceV1,
} from '../../modules/provider-orchestration/central-role-provider-default.ts';
import type { AgentRole } from '../../modules/provider-orchestration/agent-role-plan.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const LOGICAL_PROVIDER_ID = /^[a-z0-9][a-z0-9._:@+-]{0,127}$/u;

export type CentralRoleProviderDefaultWizardPromptPort = Readonly<{
  chooseProviderPartition(
    choices: readonly ProviderPartitionChoiceV1[],
  ): Promise<ProviderPartitionChoiceV1['option']>;
  chooseSessionPartition(
    input: Readonly<{
      roles: readonly AgentRole[];
      choices: readonly SessionPartitionChoiceV1[];
    }>,
  ): Promise<SessionPartitionChoiceV1['option']>;
  chooseProviderRule(
    input: Readonly<{
      roles: readonly AgentRole[];
      choices: readonly ProviderRuleChoiceV1[];
    }>,
  ): Promise<CentralProviderRuleV1>;
  reorderProviderRanking(
    ranking: readonly string[],
  ): Promise<readonly string[]>;
  confirm(summary: string): Promise<boolean>;
}>;

export type ConfigureCentralRoleProviderDefaultInput = Readonly<{
  currentConfiguration: CentralRoleProviderDefaultV1;
  providerConfiguration: AgentProviderConfigSnapshot;
}>;

export type CentralRoleProviderDefaultWizardDependencies = Readonly<{
  prompt: CentralRoleProviderDefaultWizardPromptPort;
  assertProviderConfigurationCurrent(): AgentProviderConfigSnapshot;
  replaceConfiguration(
    expectedConfigurationDigest: string,
    configuration: CentralRoleProviderDefaultV1,
  ): Readonly<{ path: string }>;
}>;

export type CentralRoleProviderDefaultWizardResult = Readonly<{
  schemaVersion: 1;
  kind: 'central-role-provider-default-wizard-result';
  saved: boolean;
  configurationPath: string | null;
  configuration: CentralRoleProviderDefaultV1;
  configurationDigest: string;
  providerConfigurationDigest: string;
  summary: string;
  modelLaunched: false;
  assignmentSaved: false;
  callerSaved: false;
}>;

/**
 * Configure one declarative central default. The current caller is deliberately
 * absent from both this input and its prompt port, so it cannot become a saved
 * future assignment.
 */
export async function configureCentralRoleProviderDefault(
  input: ConfigureCentralRoleProviderDefaultInput,
  dependencies: CentralRoleProviderDefaultWizardDependencies,
): Promise<CentralRoleProviderDefaultWizardResult> {
  const initialProviderDigest = requireDigest(
    input.providerConfiguration.configDigest,
  );
  const logicalProviderCatalog = projectLogicalProviderCatalog(
    input.providerConfiguration,
  );
  const providerPartitions = providerPartitionChoices();
  const selectedProviderPartition = requireChoice(
    providerPartitions,
    await dependencies.prompt.chooseProviderPartition(providerPartitions),
  );
  const providerGroups = [];

  for (const roles of selectedProviderPartition.groups) {
    const availableSessionPartitions = sessionPartitionChoices(roles);
    const sessionGroups =
      availableSessionPartitions.length === 0
        ? [roles]
        : requireChoice(
            availableSessionPartitions,
            await dependencies.prompt.chooseSessionPartition({
              roles,
              choices: availableSessionPartitions,
            }),
          ).sessionGroups;
    const availableProviderRules = providerRuleChoices(
      roles,
      logicalProviderCatalog,
    );
    const providerRule = requireProviderRule(
      availableProviderRules,
      await dependencies.prompt.chooseProviderRule({
        roles,
        choices: availableProviderRules,
      }),
    );
    providerGroups.push({ roles, sessionGroups, providerRule });
  }

  const initialRanking = preserveCurrentRanking(
    input.currentConfiguration.globalProviderRanking,
    logicalProviderCatalog,
  );
  const globalProviderRanking = requireExactRanking(
    await dependencies.prompt.reorderProviderRanking(initialRanking),
    logicalProviderCatalog,
  );
  const configuration = createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups,
    globalProviderRanking,
  });
  const summary = renderCentralRoleProviderDefaultSummary(configuration);
  const confirmed = await dependencies.prompt.confirm(summary);
  const resultBase = {
    schemaVersion: 1 as const,
    kind: 'central-role-provider-default-wizard-result' as const,
    configuration,
    configurationDigest: configuration.configurationDigest,
    providerConfigurationDigest: initialProviderDigest,
    summary,
    modelLaunched: false as const,
    assignmentSaved: false as const,
    callerSaved: false as const,
  };
  if (confirmed !== true) {
    return Object.freeze({
      ...resultBase,
      saved: false,
      configurationPath: null,
    });
  }

  const currentProviderConfiguration =
    dependencies.assertProviderConfigurationCurrent();
  if (
    currentProviderConfiguration.configDigest !== initialProviderDigest ||
    canonicalJson(
      projectLogicalProviderCatalog(currentProviderConfiguration),
    ) !== canonicalJson(logicalProviderCatalog)
  ) {
    throw wizardError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_PROVIDER_CONFIG_STALE',
      'Host provider configuration changed before the central default could be saved.',
      ExitCode.conflict,
    );
  }
  const replacement = dependencies.replaceConfiguration(
    input.currentConfiguration.configurationDigest,
    configuration,
  );
  if (
    typeof replacement.path !== 'string' ||
    replacement.path.length === 0 ||
    replacement.path.includes('\0')
  ) {
    throw wizardInvalid();
  }
  return Object.freeze({
    ...resultBase,
    saved: true,
    configurationPath: replacement.path,
  });
}

/** Collapse ranked invocation profiles to ranked logical independence IDs. */
export function projectLogicalProviderCatalog(
  providerConfiguration: AgentProviderConfigSnapshot,
): readonly string[] {
  if (
    providerConfiguration?.schemaVersion !== 2 ||
    providerConfiguration.kind !== 'agent-provider-config-snapshot' ||
    !DIGEST.test(providerConfiguration.configDigest) ||
    !Array.isArray(providerConfiguration.providers) ||
    providerConfiguration.providers.length === 0 ||
    !Array.isArray(providerConfiguration.globalRanking) ||
    providerConfiguration.globalRanking.length === 0
  ) {
    throw wizardInvalid();
  }
  const profileById = new Map<string, string>();
  for (const profile of providerConfiguration.providers) {
    if (
      typeof profile.id !== 'string' ||
      profileById.has(profile.id) ||
      typeof profile.logicalProviderId !== 'string' ||
      !LOGICAL_PROVIDER_ID.test(profile.logicalProviderId)
    ) {
      throw wizardInvalid();
    }
    profileById.set(profile.id, profile.logicalProviderId);
  }
  if (
    new Set(providerConfiguration.globalRanking).size !==
      providerConfiguration.globalRanking.length ||
    providerConfiguration.globalRanking.length !== profileById.size
  ) {
    throw wizardInvalid();
  }
  const seen = new Set<string>();
  const logicalProviders: string[] = [];
  for (const profileId of providerConfiguration.globalRanking) {
    const logicalProviderId = profileById.get(profileId);
    if (logicalProviderId === undefined) throw wizardInvalid();
    if (!seen.has(logicalProviderId)) {
      seen.add(logicalProviderId);
      logicalProviders.push(logicalProviderId);
    }
  }
  if (logicalProviders.length === 0) throw wizardInvalid();
  return Object.freeze(logicalProviders);
}

function preserveCurrentRanking(
  current: readonly string[],
  catalog: readonly string[],
): readonly string[] {
  const catalogSet = new Set(catalog);
  const retained = current.filter((logicalProviderId) =>
    catalogSet.has(logicalProviderId),
  );
  const retainedSet = new Set(retained);
  return Object.freeze([
    ...retained,
    ...catalog.filter(
      (logicalProviderId) => !retainedSet.has(logicalProviderId),
    ),
  ]);
}

function requireExactRanking(
  candidate: readonly string[],
  catalog: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(candidate) ||
    candidate.length !== catalog.length ||
    new Set(candidate).size !== candidate.length ||
    candidate.some(
      (logicalProviderId) =>
        typeof logicalProviderId !== 'string' ||
        !catalog.includes(logicalProviderId),
    )
  ) {
    throw wizardInvalid();
  }
  return Object.freeze([...candidate]);
}

function requireChoice<
  T extends Readonly<{ option: ProviderPartitionChoiceV1['option'] }>,
>(choices: readonly T[], option: ProviderPartitionChoiceV1['option']): T {
  const selected = choices.find((choice) => choice.option === option);
  if (selected === undefined) throw wizardInvalid();
  return selected;
}

function requireProviderRule(
  choices: readonly ProviderRuleChoiceV1[],
  candidate: CentralProviderRuleV1,
): CentralProviderRuleV1 {
  const admitted = choices.find(
    ({ rule }) => canonicalJson(rule) === canonicalJson(candidate),
  )?.rule;
  if (admitted === undefined) throw wizardInvalid();
  return admitted;
}

function requireDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw wizardInvalid();
  return value;
}

function wizardInvalid() {
  return wizardError(
    'CENTRAL_ROLE_PROVIDER_DEFAULT_WIZARD_INVALID',
    'Central role/provider default wizard input or response is invalid.',
    ExitCode.verification,
  );
}

function wizardError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
) {
  return workflowError(code, message, exitCode);
}
