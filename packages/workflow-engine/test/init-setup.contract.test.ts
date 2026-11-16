import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const launcher = path.resolve(
  'packages/workflow-engine/bootstrap/jigwright-cli.mjs',
);

test('init fills missing answers, installs only explicit targets, and preserves answered policy', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-setup-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    '# Local rules\n\nKeep this exact.\n',
  );
  const invoke = (...args: string[]) =>
    spawnSync(process.execPath, [launcher, 'init', ...args, '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        JIGWRIGHT_SETUP_HOME: path.join(temporary, 'host'),
      },
    });
  try {
    const first = invoke();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      fs.existsSync(path.join(root, 'workflow/agent-guidance.json')),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
      '# Local rules\n\nKeep this exact.\n',
    );
    const profile = fs.readFileSync(
      path.join(root, 'workflow/jigwright-profile.json'),
      'utf8',
    );
    const second = invoke('--guidance-target', 'AGENTS.md');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).result.status, 'updated');
    assert.match(
      fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
      /jigwright:region/u,
    );
    assert.match(second.stderr, /AGENTS\.md/u);
    const consumer = fs.readFileSync(
      path.join(root, 'workflow/repository-consumer.json'),
      'utf8',
    );
    const third = invoke('--handoff-path', 'docs/SHOULD-NOT-REPLACE.md');
    assert.equal(third.status, 0, third.stderr);
    assert.equal(JSON.parse(third.stdout).result.status, 'unchanged');
    assert.equal(
      fs.readFileSync(
        path.join(root, 'workflow/repository-consumer.json'),
        'utf8',
      ),
      consumer,
    );
    assert.equal(
      fs.readFileSync(
        path.join(root, 'workflow/jigwright-profile.json'),
        'utf8',
      ),
      profile,
    );
    assert.equal(fs.existsSync(path.join(temporary, 'host')), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('JSON setup uses the same validation and remembers explicit provider/guidance declines on the host', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-answers-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(root);
  const answers = path.join(temporary, 'answers.json');
  fs.writeFileSync(
    answers,
    JSON.stringify({
      providerConfig: null,
      guidanceTargets: [],
      consumerId: 'example',
      handoffPath: 'notes/HANDOFF.md',
      databasePolicy: 'disabled-v1',
    }),
  );
  const invoke = () =>
    spawnSync(
      process.execPath,
      [launcher, 'init', '--answers', answers, '--json'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          JIGWRIGHT_SETUP_HOME: path.join(temporary, 'host'),
        },
      },
    );
  try {
    const first = invoke();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).result.pending, []);
    const consumer = JSON.parse(
      fs.readFileSync(
        path.join(root, 'workflow/repository-consumer.json'),
        'utf8',
      ),
    );
    assert.equal(consumer.consumerId, 'example');
    assert.equal(consumer.documents.handoffPath, 'notes/HANDOFF.md');
    assert.equal(
      fs.existsSync(path.join(root, 'workflow/agent-guidance.json')),
      false,
    );
    assert.equal(
      fs
        .readFileSync(
          path.join(root, 'workflow/repository-consumer.json'),
          'utf8',
        )
        .includes('providerConfig'),
      false,
    );
    assert.equal(invoke().status, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('init rejects invalid input before creating config', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-invalid-'),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [launcher, 'init', '--handoff-path', '../escape.md', '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 12);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      'JIGWRIGHT_INIT_ANSWER_INVALID',
    );
    assert.equal(fs.existsSync(path.join(root, 'workflow')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interactive setup asks provider, confirms targets, then remaining settings and skips answered questions', async () => {
  const { initializeJigwrightConsumer } =
    await import('../src/entrypoints/cli/consumer-setup-cli.ts');
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-interactive-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Mine\n');
  const previous = process.env.JIGWRIGHT_SETUP_HOME;
  const previousProvider = process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  process.env.JIGWRIGHT_SETUP_HOME = path.join(temporary, 'host');
  delete process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  try {
    const prompts: string[] = [];
    const replies = ['', '', 'yes', 'example', '', ''];
    await initializeJigwrightConsumer(root, {
      ask: async (prompt) => {
        prompts.push(prompt);
        return replies.shift()!;
      },
      onDiff: () => {},
    });
    assert.match(prompts[0]!, /host provider/iu);
    assert.match(prompts[1]!, /Instruction Markdown/u);
    assert.match(prompts[2]!, /Install Jigwright guidance in \["AGENTS.md"\]/u);
    assert.match(prompts[3]!, /Repository identifier/u);
    const repeat = await initializeJigwrightConsumer(root, {
      ask: async () => assert.fail('Answered setup question was asked again'),
    });
    assert.equal('status' in repeat && repeat.status, 'unchanged');
  } finally {
    if (previous === undefined) delete process.env.JIGWRIGHT_SETUP_HOME;
    else process.env.JIGWRIGHT_SETUP_HOME = previous;
    if (previousProvider === undefined)
      delete process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
    else process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG = previousProvider;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('host provider selection is persistent runtime input without copying provider configuration into the repo', async () => {
  const { initializeJigwrightConsumer, configuredJigwrightEnvironment } =
    await import('../src/entrypoints/cli/consumer-setup-cli.ts');
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-provider-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(root);
  const provider = path.join(temporary, 'providers.toml');
  const document =
    'schema_version = 2\nglobal_ranking = ["codex-local"]\n\n[[providers]]\nid = "codex-local"\nfamily = "codex"\ntrust_tier = "built-in-reviewed"\nenabled = true\nprotocol = "codex-jsonl-v1"\nexecutable = "/opt/homebrew/bin/codex"\n\n[provider_preferences]\nauthor = ["codex-local"]\nbuilder = ["codex-local"]\nreviewer = ["codex-local"]\n';
  fs.writeFileSync(provider, document, { mode: 0o600 });
  const previous = process.env.JIGWRIGHT_SETUP_HOME;
  const previousProvider = process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  process.env.JIGWRIGHT_SETUP_HOME = path.join(temporary, 'host');
  delete process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  try {
    await initializeJigwrightConsumer(root, {
      argv: ['--provider-config', provider, '--no-guidance', '--json'],
    });
    assert.equal(
      configuredJigwrightEnvironment(root).JIGWRIGHT_AGENT_PROVIDER_CONFIG,
      fs.realpathSync(provider),
    );
    for (const name of fs.readdirSync(path.join(root, 'workflow'))) {
      const document = fs.readFileSync(
        path.join(root, 'workflow', name),
        'utf8',
      );
      assert.equal(document.includes(provider), false);
      assert.equal(document.includes('codex-local'), false);
    }
    assert.equal(fs.readFileSync(provider, 'utf8'), document);
  } finally {
    if (previous === undefined) delete process.env.JIGWRIGHT_SETUP_HOME;
    else process.env.JIGWRIGHT_SETUP_HOME = previous;
    if (previousProvider === undefined)
      delete process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
    else process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG = previousProvider;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('init preflights conflicting identity before writing confirmed guidance', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-preflight-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(path.join(root, 'workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'workflow/config.json'),
    '{"repositoryName":"existing"}\n',
  );
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Existing instructions\n');
  try {
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        'init',
        '--guidance-target',
        'AGENTS.md',
        '--consumer-id',
        'conflicting',
        '--json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          JIGWRIGHT_SETUP_HOME: path.join(temporary, 'host'),
        },
      },
    );
    assert.equal(result.status, 12);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      'JIGWRIGHT_INIT_ANSWER_INVALID',
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
      '# Existing instructions\n',
    );
    assert.deepEqual(fs.readdirSync(path.join(root, 'workflow')), [
      'config.json',
    ]);
    assert.equal(fs.existsSync(path.join(temporary, 'host')), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('init accepts Markdown extension and emits valid disposable-database consumer config', async () => {
  const { parseRepositoryConsumerConfiguration } =
    await import('../src/modules/repository-consumer/repository-consumer-policy.ts');
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-markdown-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(root);
  try {
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        'init',
        '--guidance-target',
        'AGENTS.markdown',
        '--database-policy',
        'postgresql-disposable-v1',
        '--json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          JIGWRIGHT_SETUP_HOME: path.join(temporary, 'host'),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      fs.readFileSync(path.join(root, 'AGENTS.markdown'), 'utf8'),
      /jigwright:region/u,
    );
    const consumer = parseRepositoryConsumerConfiguration(
      JSON.parse(
        fs.readFileSync(
          path.join(root, 'workflow/repository-consumer.json'),
          'utf8',
        ),
      ),
    );
    assert.equal(consumer.databasePolicy.adapterId, 'postgresql-disposable-v1');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('fresh provider setup creates host TOML once without launching provider processes', async () => {
  const { parseAgentProviderConfigToml } =
    await import('@jigwright/agent-runtime');
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-new-provider-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(root);
  const providerConfig = path.join(temporary, 'host', 'providers.toml');
  const sentinel = path.join(temporary, 'provider-was-started');
  const executable = path.join(temporary, 'fake-provider');
  fs.writeFileSync(executable, `#!/bin/sh\ntouch '${sentinel}'\n`, {
    mode: 0o700,
  });
  const providers = [{ id: 'codex-local', family: 'codex', executable }];
  const invoke = (...args: string[]) =>
    spawnSync(process.execPath, [launcher, 'init', ...args, '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        JIGWRIGHT_SETUP_HOME: path.join(temporary, 'setup'),
      },
    });
  try {
    const incomplete = invoke('--provider-config', providerConfig);
    assert.equal(incomplete.status, 12);
    assert.equal(
      JSON.parse(incomplete.stderr).error.code,
      'JIGWRIGHT_INIT_ANSWER_INVALID',
    );
    assert.equal(fs.existsSync(providerConfig), false);
    assert.equal(fs.existsSync(path.join(root, 'workflow')), false);
    const first = invoke(
      '--provider-config',
      providerConfig,
      '--providers',
      JSON.stringify(providers),
    );
    assert.equal(first.status, 0, first.stderr);
    const before = fs.readFileSync(providerConfig, 'utf8');
    const parsed = parseAgentProviderConfigToml(before, {
      platform: process.platform,
    });
    assert.deepEqual(parsed.globalRanking, ['codex-local']);
    assert.equal(parsed.providers[0]!.executable, executable);
    assert.equal(fs.statSync(providerConfig).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(invoke().status, 0);
    assert.equal(fs.readFileSync(providerConfig, 'utf8'), before);
    const replace = invoke(
      '--provider-config',
      providerConfig,
      '--providers',
      JSON.stringify(providers),
    );
    assert.equal(replace.status, 12);
    assert.equal(
      JSON.parse(replace.stderr).error.code,
      'JIGWRIGHT_INIT_ANSWER_INVALID',
    );
    assert.equal(fs.readFileSync(providerConfig, 'utf8'), before);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('interactive new provider setup adds one provider question before guidance', async () => {
  const { initializeJigwrightConsumer } =
    await import('../src/entrypoints/cli/consumer-setup-cli.ts');
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-new-provider-prompt-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(root);
  const providerConfig = path.join(temporary, 'providers.toml');
  const previous = process.env.JIGWRIGHT_SETUP_HOME;
  process.env.JIGWRIGHT_SETUP_HOME = path.join(temporary, 'setup');
  try {
    const prompts: string[] = [];
    const replies = [
      providerConfig,
      JSON.stringify([
        {
          id: 'codex-local',
          family: 'codex',
          executable: '/opt/homebrew/bin/codex',
        },
      ]),
      '[]',
      '',
      '',
      '',
    ];
    const result = await initializeJigwrightConsumer(root, {
      ask: async (prompt) => {
        prompts.push(prompt);
        return replies.shift()!;
      },
    });
    assert.match(prompts[0]!, /host provider/iu);
    assert.match(prompts[1]!, /Providers to add/u);
    assert.match(prompts[2]!, /Instruction Markdown/u);
    assert.deepEqual('pending' in result && result.pending, []);
    assert.equal(fs.existsSync(providerConfig), true);
  } finally {
    if (previous === undefined) delete process.env.JIGWRIGHT_SETUP_HOME;
    else process.env.JIGWRIGHT_SETUP_HOME = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('bootstrap help skips host setup lookup and other lookup failures use JSON errors', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-bootstrap-host-help-'),
  );
  fs.copyFileSync(launcher, path.join(temporary, 'jigwright-cli.mjs'));
  fs.writeFileSync(
    path.join(temporary, 'jigwright-init.mjs'),
    `export function initializeJigwrightConsumer() { return {}; }\nexport function configuredJigwrightEnvironment() { throw Object.assign(new Error("Invalid host setup"), {code:"JIGWRIGHT_INIT_PATH_UNSAFE"}); }\nexport { renderHumanCommandResult } from ${JSON.stringify(path.resolve('packages/workflow-engine/bootstrap/jigwright-init.mjs'))};\n`,
  );
  fs.writeFileSync(
    path.join(temporary, 'workflow-launcher.ts'),
    'process.stdout.write("help dispatched\\n");\n',
  );
  try {
    for (const alias of ['--help', '-h', 'help']) {
      const result = spawnSync(
        process.execPath,
        [path.join(temporary, 'jigwright-cli.mjs'), alias],
        { cwd: temporary, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'help dispatched\n');
    }
    const runtime = spawnSync(
      process.execPath,
      [path.join(temporary, 'jigwright-cli.mjs'), 'doctor', '--json'],
      { cwd: temporary, encoding: 'utf8' },
    );
    assert.equal(runtime.status, 12);
    assert.equal(
      JSON.parse(runtime.stderr).error.code,
      'JIGWRIGHT_INIT_PATH_UNSAFE',
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('init rejects invalid existing workflow schema and paths before guidance writes', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-workflow-preflight-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(path.join(root, 'workflow'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Original\n');
  try {
    for (const [schemaVersion, expectedCode] of [
      [99, 'INVALID_WORKFLOW_CONFIG'],
      [1, 'INVALID_POLICY_PATH'],
    ] as const) {
      const original = JSON.stringify({
        schemaVersion,
        repositoryName: 'consumer',
        changeRoot: '../outside',
      });
      fs.writeFileSync(path.join(root, 'workflow/config.json'), original);
      const result = spawnSync(
        process.execPath,
        [launcher, 'init', '--guidance-target', 'AGENTS.md', '--json'],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            JIGWRIGHT_SETUP_HOME: path.join(temporary, 'host'),
          },
        },
      );
      assert.equal(result.status, 12, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code, expectedCode);
      assert.equal(
        fs.readFileSync(path.join(root, 'workflow/config.json'), 'utf8'),
        original,
      );
      assert.equal(
        fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
        '# Original\n',
      );
      assert.deepEqual(fs.readdirSync(path.join(root, 'workflow')), [
        'config.json',
      ]);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('dangling provider destination is rejected before guidance or setup writes', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-dangling-provider-'),
  );
  const root = path.join(temporary, 'consumer');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Original\n');
  const provider = path.join(temporary, 'providers.toml');
  fs.symlinkSync(path.join(temporary, 'missing'), provider);
  try {
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        'init',
        '--provider-config',
        provider,
        '--providers',
        JSON.stringify([
          {
            id: 'codex-local',
            family: 'codex',
            executable: '/opt/homebrew/bin/codex',
          },
        ]),
        '--guidance-target',
        'AGENTS.md',
        '--json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          JIGWRIGHT_SETUP_HOME: path.join(temporary, 'setup'),
        },
      },
    );
    assert.equal(result.status, 12);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      'JIGWRIGHT_INIT_PATH_UNSAFE',
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
      '# Original\n',
    );
    assert.equal(fs.existsSync(path.join(root, 'workflow')), false);
    assert.equal(fs.existsSync(path.join(temporary, 'setup')), false);
    assert.equal(fs.lstatSync(provider).isSymbolicLink(), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('bootstrap finds saved provider config from an unborn repository subdirectory', async () => {
  const { initializeJigwrightConsumer } =
    await import('../src/entrypoints/cli/consumer-setup-cli.ts');
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-init-subdirectory-'),
  );
  const root = path.join(temporary, 'consumer');
  const subdirectory = path.join(root, 'nested');
  fs.mkdirSync(subdirectory, { recursive: true });
  assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
  const providerConfig = path.join(temporary, 'providers.toml');
  const previous = process.env.JIGWRIGHT_SETUP_HOME;
  const previousProvider = process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  process.env.JIGWRIGHT_SETUP_HOME = path.join(temporary, 'setup');
  delete process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  try {
    await initializeJigwrightConsumer(root, {
      argv: [
        '--provider-config',
        providerConfig,
        '--providers',
        JSON.stringify([
          {
            id: 'codex-local',
            family: 'codex',
            executable: '/opt/homebrew/bin/codex',
          },
        ]),
        '--json',
      ],
    });
    fs.copyFileSync(launcher, path.join(temporary, 'jigwright-cli.mjs'));
    fs.writeFileSync(
      path.join(temporary, 'jigwright-init.mjs'),
      `export { initializeJigwrightConsumer, configuredJigwrightEnvironment, renderHumanCommandResult } from ${JSON.stringify(path.resolve('packages/workflow-engine/bootstrap/jigwright-init.mjs'))};\n`,
    );
    fs.writeFileSync(
      path.join(temporary, 'workflow-launcher.ts'),
      'process.stdout.write(JSON.stringify({providerConfig:process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG}));\n',
    );
    const result = spawnSync(
      process.execPath,
      [path.join(temporary, 'jigwright-cli.mjs'), 'doctor', '--json'],
      { cwd: subdirectory, encoding: 'utf8', env: process.env },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).providerConfig,
      fs.realpathSync(providerConfig),
    );
  } finally {
    if (previous === undefined) delete process.env.JIGWRIGHT_SETUP_HOME;
    else process.env.JIGWRIGHT_SETUP_HOME = previous;
    if (previousProvider === undefined)
      delete process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
    else process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG = previousProvider;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
