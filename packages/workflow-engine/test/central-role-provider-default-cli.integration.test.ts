import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createCentralRoleProviderDefaultTerminalPrompt,
  dispatchCentralRoleProviderDefaultCommand,
} from '../src/entrypoints/cli/central-role-provider-default-cli.ts';
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import { CENTRAL_ROLE_PROVIDER_DEFAULT_PATH } from '../src/runtime/repository-transaction/central-role-provider-default-store.ts';
import { createFixtureRepository } from './fixture.ts';

const sourceRepositoryRoot = path.resolve(import.meta.dirname, '../../..');

test('role-config CLI reaches production dependencies only through composition root', () => {
  const source = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/entrypoints/cli/central-role-provider-default-cli.ts',
    ),
    'utf8',
  );
  assert.match(
    source,
    /from ['"]\.\.\/\.\.\/composition-root\/central-role-provider-default-production\.ts['"]/u,
  );
  assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/application\//u);
  assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/runtime\//u);
  assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/modules\//u);
});

test('role-config CLI shows and atomically configures declarative central rules from one external host catalog', async () => {
  const repository = createFixtureRepository();
  const hostDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'central-role-provider-host-'),
  );
  try {
    fs.chmodSync(hostDirectory, 0o700);
    const hostConfigPath = path.join(hostDirectory, 'agent-providers.toml');
    fs.writeFileSync(hostConfigPath, hostConfiguration(), { mode: 0o600 });
    const canonicalHostConfigPath = fs.realpathSync(hostConfigPath);
    writeCurrentDefault(repository);

    const shown = await dispatchCentralRoleProviderDefaultCommand(
      ['show'],
      repository,
    );
    assert.equal(shown.kind, 'central-role-provider-default-inspection');
    assert.equal(shown.assignmentSaved, false);
    assert.equal(shown.callerSaved, false);
    assert.doesNotMatch(shown.summary, /->|resolved provider/iu);

    let sessionQuestionCount = 0;
    const configured = await dispatchCentralRoleProviderDefaultCommand(
      ['configure', '--config', canonicalHostConfigPath],
      repository,
      {
        platform: process.platform,
        prompt: {
          async chooseProviderPartition() {
            return 5;
          },
          async chooseSessionPartition() {
            sessionQuestionCount += 1;
            return 4;
          },
          async chooseProviderRule({ choices }) {
            return choices[0]!.rule;
          },
          async reorderProviderRanking(ranking) {
            return [...ranking].reverse();
          },
          async confirm() {
            return true;
          },
        },
      },
    );
    assert.equal(
      configured.kind,
      'central-role-provider-default-wizard-result',
    );
    if (configured.kind !== 'central-role-provider-default-wizard-result') {
      assert.fail('configure must return the wizard result');
    }
    assert.equal(configured.saved, true);
    assert.equal(configured.modelLaunched, false);
    assert.equal(configured.assignmentSaved, false);
    assert.equal(configured.callerSaved, false);
    assert.equal(sessionQuestionCount, 1);
    assert.deepEqual(configured.configuration.globalProviderRanking, [
      'codex',
      'claude',
    ]);
    assert.deepEqual(
      configured.configuration.providerGroups[0]?.sessionGroups,
      [['author', 'reviewer'], ['builder']],
    );
    const persisted = fs.readFileSync(
      path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH),
      'utf8',
    );
    assert.equal(
      persisted,
      renderCentralRoleProviderDefault(configured.configuration),
    );
    assert.doesNotMatch(persisted, /callerId|resolvedProvider|assignment/u);

    writeSimulationDefault(repository);
    const simulated = await dispatchCentralRoleProviderDefaultCommand(
      ['simulate', '--config', canonicalHostConfigPath, '--caller', 'codex'],
      repository,
      { platform: process.platform },
    );
    assert.equal(simulated.kind, 'central-role-provider-default-simulation');
    if (simulated.kind !== 'central-role-provider-default-simulation') {
      assert.fail('simulate must return a non-authoritative simulation');
    }
    assert.equal(simulated.modelLaunched, false);
    assert.equal(simulated.assignmentSaved, false);
    assert.equal(simulated.callerSaved, false);
    assert.equal(simulated.assumption, 'declared-capabilities-only');
    assert.equal(simulated.result.outcome, 'resolved');
    if (simulated.result.outcome !== 'resolved') {
      assert.fail('the split-session Adaptive fixture must resolve');
    }
    assert.equal(
      simulated.result.resolution.dataAuthorizationInputManifestDigest,
      null,
    );
    assert.equal(
      simulated.result.resolution.dataAuthorizationRelevantTargetDigest,
      null,
    );
    assert.deepEqual(
      simulated.result.resolution.placements.map(
        ({ role, logicalProviderId, sessionMode }) => ({
          role,
          logicalProviderId,
          sessionMode,
        }),
      ),
      [
        {
          role: 'author',
          logicalProviderId: 'codex',
          sessionMode: 'caller-existing',
        },
        {
          role: 'builder',
          logicalProviderId: 'codex',
          sessionMode: 'fresh',
        },
        {
          role: 'reviewer',
          logicalProviderId: 'codex',
          sessionMode: 'fresh',
        },
      ],
    );

    const simulatedCli = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
        ),
        'role-config',
        'simulate',
        '--config',
        canonicalHostConfigPath,
        '--caller',
        'codex',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(simulatedCli.status, 0, simulatedCli.stderr);
    assert.equal(
      JSON.parse(simulatedCli.stdout).result.kind,
      'central-role-provider-default-simulation',
    );

    fs.writeFileSync(
      canonicalHostConfigPath,
      hostConfiguration().replace(/^global_ranking = .*\n/mu, ''),
      { mode: 0o600 },
    );
    await assert.rejects(
      () =>
        dispatchCentralRoleProviderDefaultCommand(
          ['configure', '--config', canonicalHostConfigPath],
          repository,
          {
            platform: process.platform,
            prompt: {
              async chooseProviderPartition() {
                return 1;
              },
              async chooseSessionPartition() {
                return 1;
              },
              async chooseProviderRule({ choices }) {
                return choices[0]!.rule;
              },
              async reorderProviderRanking(ranking) {
                return ranking;
              },
              async confirm() {
                return false;
              },
            },
          },
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_PROVIDER_CONFIG_INVALID',
    );

    const cli = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
        ),
        'role-config',
        'show',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const output = JSON.parse(cli.stdout);
    assert.equal(
      output.result.kind,
      'central-role-provider-default-inspection',
    );
  } finally {
    fs.rmSync(hostDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('terminal wizard prompt supports explicit ranking moves and never invents a choice', async () => {
  const answers = ['2', 'down 1', 'done', 'yes'];
  const prompts: string[] = [];
  const prompt = createCentralRoleProviderDefaultTerminalPrompt({
    async ask(question) {
      prompts.push(question);
      return answers.shift()!;
    },
  });

  assert.equal(
    await prompt.chooseProviderPartition([
      { option: 1, groups: [['author']], notation: 'author' },
      {
        option: 2,
        groups: [['author'], ['builder']],
        notation: 'author | builder',
      },
    ]),
    2,
  );
  assert.deepEqual(await prompt.reorderProviderRanking(['claude', 'codex']), [
    'codex',
    'claude',
  ]);
  assert.equal(await prompt.confirm('summary'), true);
  assert.equal(answers.length, 0);
  assert.equal(prompts.length, 4);
});

function writeCurrentDefault(repository: string): void {
  const configuration = createCentralRoleProviderDefault({
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
          preferredLogicalProviderId: null,
        },
      },
    ],
    globalProviderRanking: ['claude', 'codex'],
  });
  const destination = path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    renderCentralRoleProviderDefault(configuration),
    {
      mode: 0o644,
    },
  );
}

function writeSimulationDefault(repository: string): void {
  const configuration = createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author', 'builder', 'reviewer'],
        sessionGroups: [['author'], ['builder'], ['reviewer']],
        providerRule: { kind: 'adaptive-author' },
      },
    ],
    globalProviderRanking: ['claude', 'codex'],
  });
  fs.writeFileSync(
    path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH),
    renderCentralRoleProviderDefault(configuration),
    { mode: 0o644 },
  );
}

function hostConfiguration(): string {
  const executable =
    process.platform === 'win32'
      ? 'C:\\\\Tools\\\\provider.exe'
      : '/opt/providers/provider';
  return `
schema_version = 2
global_ranking = ["claude-primary", "claude-alias", "codex-primary"]

[[providers]]
id = "claude-primary"
logical_provider_id = "claude"
family = "claude"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "claude-stream-json-v1"
executable = "${executable}"

[[providers]]
id = "codex-primary"
logical_provider_id = "codex"
family = "codex"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "codex-jsonl-v1"
executable = "${executable}"

[[providers]]
id = "claude-alias"
logical_provider_id = "claude"
family = "claude"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = false
protocol = "claude-stream-json-v1"
executable = "${executable}"

[provider_preferences]
author = ["claude-primary", "codex-primary"]
builder = ["codex-primary", "claude-primary"]
reviewer = ["claude-primary", "codex-primary"]
`;
}
