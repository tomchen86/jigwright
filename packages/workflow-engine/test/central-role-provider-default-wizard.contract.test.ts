import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCentralRoleProviderDefault,
  type CentralProviderRuleV1,
  type CentralRoleProviderDefaultV1,
  type ProviderPartitionChoiceV1,
  type ProviderRuleChoiceV1,
  type SessionPartitionChoiceV1,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  configureCentralRoleProviderDefault,
  projectLogicalProviderCatalog,
  type CentralRoleProviderDefaultWizardPromptPort,
} from '../src/application/configure/central-role-provider-default-wizard.ts';
import type { AgentProviderConfigSnapshot } from '@jigwright/agent-runtime';

const current = createCentralRoleProviderDefault({
  schemaVersion: 1,
  kind: 'central-role-provider-default',
  providerGroups: [
    {
      roles: ['author'],
      sessionGroups: [['author']],
      providerRule: { kind: 'adaptive-author' },
    },
    {
      roles: ['builder'],
      sessionGroups: [['builder']],
      providerRule: {
        kind: 'ranked-fallback',
        preferredLogicalProviderId: null,
      },
    },
    {
      roles: ['reviewer'],
      sessionGroups: [['reviewer']],
      providerRule: {
        kind: 'ranked-fallback',
        preferredLogicalProviderId: 'claude',
      },
    },
  ],
  globalProviderRanking: ['claude', 'codex', 'gemini'],
});

function providerSnapshot(): AgentProviderConfigSnapshot {
  const capabilities = [
    'fresh-session',
    'plan-review',
    'survey',
    'task-diff-review',
    'task-implementation',
  ] as const;
  const profiles = [
    { id: 'codex-secondary', logicalProviderId: 'codex', enabled: true },
    { id: 'claude-primary', logicalProviderId: 'claude', enabled: true },
    { id: 'codex-primary', logicalProviderId: 'codex', enabled: true },
    { id: 'gemini-disabled', logicalProviderId: 'gemini', enabled: false },
  ].map(({ id, logicalProviderId, enabled }) => ({
    schemaVersion: 1 as const,
    kind: 'agent-provider-profile-snapshot' as const,
    id,
    logicalProviderId,
    family: logicalProviderId,
    capabilities,
    trustTier: 'built-in-reviewed' as const,
    enabled,
    protocol: `${logicalProviderId}-jsonl-v1`,
    platform: 'darwin',
    executable: `/opt/providers/${id}`,
    shell: false as const,
    startArgs: [] as const,
    resumeArgs: [] as const,
    promptInput: null,
    cancel: null,
    profileDigest: id.padEnd(64, '0').slice(0, 64),
  }));
  return Object.freeze({
    schemaVersion: 2,
    kind: 'agent-provider-config-snapshot',
    platform: 'darwin',
    providers: Object.freeze(profiles),
    preferences: Object.freeze({
      author: Object.freeze([
        'claude-primary',
        'codex-primary',
        'codex-secondary',
      ]),
      builder: Object.freeze([
        'codex-primary',
        'codex-secondary',
        'claude-primary',
      ]),
      reviewer: Object.freeze([
        'claude-primary',
        'codex-primary',
        'codex-secondary',
      ]),
    }),
    globalRanking: Object.freeze([
      'codex-secondary',
      'claude-primary',
      'codex-primary',
      'gemini-disabled',
    ]),
    globalRankingSource: 'explicit',
    configDigest: 'f'.repeat(64),
  });
}

class FakePrompt implements CentralRoleProviderDefaultWizardPromptPort {
  readonly sessionQuestions: Array<readonly string[]> = [];
  readonly ruleQuestions: Array<readonly string[]> = [];
  summary = '';

  async chooseProviderPartition(
    _choices: readonly ProviderPartitionChoiceV1[],
  ): Promise<ProviderPartitionChoiceV1['option']> {
    return 5;
  }

  async chooseSessionPartition(input: {
    roles: readonly string[];
    choices: readonly SessionPartitionChoiceV1[];
  }): Promise<SessionPartitionChoiceV1['option']> {
    this.sessionQuestions.push(input.roles);
    return 2;
  }

  async chooseProviderRule(input: {
    roles: readonly string[];
    choices: readonly ProviderRuleChoiceV1[];
  }): Promise<CentralProviderRuleV1> {
    this.ruleQuestions.push(input.roles);
    return input.choices[0]!.rule;
  }

  async reorderProviderRanking(
    ranking: readonly string[],
  ): Promise<readonly string[]> {
    return [...ranking].reverse();
  }

  async confirm(summary: string): Promise<boolean> {
    this.summary = summary;
    return true;
  }
}

test('logical provider catalog deduplicates aliases in explicit host rank order, including disabled identities', () => {
  assert.deepEqual(projectLogicalProviderCatalog(providerSnapshot()), [
    'codex',
    'claude',
    'gemini',
  ]);
});

test('wizard asks one three-role session question, rechecks host currentness, and saves no caller assignment', async () => {
  const providerConfiguration = providerSnapshot();
  const prompt = new FakePrompt();
  const writes: Array<{
    expected: string;
    configuration: CentralRoleProviderDefaultV1;
  }> = [];
  let currentnessChecks = 0;

  const result = await configureCentralRoleProviderDefault(
    { currentConfiguration: current, providerConfiguration },
    {
      prompt,
      assertProviderConfigurationCurrent() {
        currentnessChecks += 1;
        return providerConfiguration;
      },
      replaceConfiguration(expected, configuration) {
        writes.push({ expected, configuration });
        return { path: 'workflow/role-provider-default.json' };
      },
    },
  );

  assert.deepEqual(prompt.sessionQuestions, [
    ['author', 'builder', 'reviewer'],
  ]);
  assert.deepEqual(prompt.ruleQuestions, [['author', 'builder', 'reviewer']]);
  assert.equal(currentnessChecks, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.expected, current.configurationDigest);
  assert.deepEqual(writes[0]?.configuration.providerGroups[0]?.sessionGroups, [
    ['author', 'builder'],
    ['reviewer'],
  ]);
  assert.deepEqual(writes[0]?.configuration.globalProviderRanking, [
    'gemini',
    'codex',
    'claude',
  ]);
  assert.equal(result.saved, true);
  assert.equal(result.modelLaunched, false);
  assert.equal(result.assignmentSaved, false);
  assert.equal(result.callerSaved, false);
  assert.doesNotMatch(
    JSON.stringify(result.configuration),
    /caller|assignment/iu,
  );
  assert.doesNotMatch(prompt.summary, /->|resolved provider|setup caller/iu);
  assert.match(prompt.summary, /Adaptive \(current caller per change\)/u);
});

test('wizard suppresses session questions for the fully split topology and cancellation writes nothing', async () => {
  const providerConfiguration = providerSnapshot();
  const prompt = new FakePrompt();
  prompt.chooseProviderPartition = async () => 1;
  prompt.chooseSessionPartition = async () => {
    throw new Error('single-role groups must not ask a session question');
  };
  prompt.confirm = async (summary) => {
    prompt.summary = summary;
    return false;
  };
  let writes = 0;

  const result = await configureCentralRoleProviderDefault(
    { currentConfiguration: current, providerConfiguration },
    {
      prompt,
      assertProviderConfigurationCurrent() {
        throw new Error('cancelled configuration must not recheck for a write');
      },
      replaceConfiguration() {
        writes += 1;
        return { path: 'workflow/role-provider-default.json' };
      },
    },
  );

  assert.equal(result.saved, false);
  assert.equal(result.callerSaved, false);
  assert.equal(writes, 0);
  assert.deepEqual(prompt.ruleQuestions, [
    ['author'],
    ['builder'],
    ['reviewer'],
  ]);
});

test('wizard refuses provider-catalog drift after confirmation before persistence', async () => {
  const providerConfiguration = providerSnapshot();
  const prompt = new FakePrompt();
  let writes = 0;
  const drifted = {
    ...providerConfiguration,
    configDigest: 'e'.repeat(64),
  } as AgentProviderConfigSnapshot;

  await assert.rejects(
    configureCentralRoleProviderDefault(
      { currentConfiguration: current, providerConfiguration },
      {
        prompt,
        assertProviderConfigurationCurrent: () => drifted,
        replaceConfiguration() {
          writes += 1;
          return { path: 'workflow/role-provider-default.json' };
        },
      },
    ),
    /provider configuration changed/iu,
  );
  assert.equal(writes, 0);
});
