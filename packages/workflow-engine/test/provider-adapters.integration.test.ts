import assert from 'node:assert/strict';
import { builtInProviderAdapters } from '../src/composition-root/built-in-provider-adapter-production.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildClaudeProviderInvocation,
  CLAUDE_EXECUTABLE_CANDIDATES,
  CLAUDE_REQUIRED_HELP_FLAGS,
} from '../src/adapters/providers/claude/claude-provider-adapter.ts';
import {
  buildCodexProviderInvocation,
  CODEX_EXECUTABLE_CANDIDATES,
} from '../src/adapters/providers/codex/codex-provider-adapter.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createProviderExecutionEnvironment,
  createTrustedExecutionEnvironment,
} from '../src/runtime/process-environment/execution-environment.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from '../src/modules/assurance/plan-review.ts';
import {
  createProviderRunnerForTesting,
  preflightBuiltInProvider,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import type { ProviderExecutableObservation } from '@jigwright/agent-runtime/provider-executable-identity';
import { createFixtureRepository } from './fixture.ts';
import {
  PROVIDER_SCHEMA,
  builtInProfile,
  providerRequestInput,
  executableIdentity,
  successfulProbe,
  fakeHost,
  sha256,
} from './provider-adapter-fixture.ts';

test('built-in adapters publish fixed candidates and capability-specific argv', () => {
  assert.deepEqual(CODEX_EXECUTABLE_CANDIDATES.darwin, [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]);
  assert.deepEqual(CLAUDE_EXECUTABLE_CANDIDATES.darwin, [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]);
  assert.equal(
    CLAUDE_EXECUTABLE_CANDIDATES.darwin.includes(
      '/Applications/Claude.app/Contents/MacOS/claude',
    ),
    false,
  );
  assert.equal(Object.isFrozen(CODEX_EXECUTABLE_CANDIDATES), true);
  assert.equal(Object.isFrozen(CODEX_EXECUTABLE_CANDIDATES.darwin), true);
  assert.equal(Object.isFrozen(CLAUDE_EXECUTABLE_CANDIDATES), true);
  assert.equal(Object.isFrozen(CLAUDE_EXECUTABLE_CANDIDATES.darwin), true);
  assert.deepEqual(
    resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin')
      ?.executableCandidates,
    CLAUDE_EXECUTABLE_CANDIDATES.darwin,
  );
  assert.deepEqual(
    resolveBuiltInProviderDefinitionSnapshot('codex', 'darwin')
      ?.executableCandidates,
    CODEX_EXECUTABLE_CANDIDATES.darwin,
  );

  const codex = buildCodexProviderInvocation({
    executable: '/real/codex',
    repositoryRoot: '/repo',
    promptPath: '/runtime/prompt.json',
    schemaPath: '/runtime/schema.json',
    semanticOutputPath: '/runtime/semantic-output.json',
  });
  assert.equal(codex.executable, '/real/codex');
  assert.equal(codex.shell, false);
  assert.equal(codex.cwd, '/repo');
  assert.equal(Object.isFrozen(codex), true);
  assert.equal(Object.isFrozen(codex.args), true);
  assert.deepEqual(codex.args, [
    '-a',
    'never',
    '-s',
    'read-only',
    '-C',
    '/repo',
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
    '--color',
    'never',
    '--output-schema',
    '/runtime/schema.json',
    '--output-last-message',
    '/runtime/semantic-output.json',
    '-',
  ]);
  assert.equal(codex.stdinSource, '/runtime/prompt.json');

  const claude = buildClaudeProviderInvocation({
    executable: '/real/claude',
    repositoryRoot: '/repo',
    promptPath: '/runtime/prompt.json',
    schemaPath: '/runtime/schema.json',
    semanticOutputPath: '/runtime/semantic-output.json',
    semanticOutputSchema: PROVIDER_SCHEMA,
  });
  assert.equal(claude.executable, '/real/claude');
  assert.equal(claude.shell, false);
  assert.equal(claude.cwd, '/repo');
  assert.equal(Object.isFrozen(claude), true);
  assert.equal(Object.isFrozen(claude.args), true);
  assert.deepEqual(claude.args, [
    '--print',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--permission-mode',
    'plan',
    '--tools',
    'Read,Glob,Grep',
    '--allowedTools',
    'Read,Glob,Grep',
    '--effort',
    'max',
    '--json-schema',
    canonicalJson(PROVIDER_SCHEMA),
  ]);
  assert.equal(claude.stdinSource, '/runtime/prompt.json');
  assert.equal(
    claude.args.some((argument) => argument === 'high'),
    false,
  );
  assert.ok(CLAUDE_REQUIRED_HELP_FLAGS.includes('--allowedTools'));
  assert.ok(CLAUDE_REQUIRED_HELP_FLAGS.includes('--effort'));
});

test('code-owned provider schemas omit unsupported external meta-schema identifiers', () => {
  for (const [schema, identity] of [
    [BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA, BLIND_SURVEY_OUTPUT_SCHEMA],
    [PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA, PLAN_REVIEW_OUTPUT_SCHEMA],
  ] as const) {
    assert.equal(Object.hasOwn(schema, '$schema'), false);

    const claude = buildClaudeProviderInvocation({
      executable: '/real/claude',
      repositoryRoot: '/repo',
      promptPath: '/runtime/prompt.json',
      schemaPath: '/runtime/schema.json',
      semanticOutputPath: '/runtime/semantic-output.json',
      semanticOutputSchema: schema,
    });
    const schemaFlagIndex = claude.args.indexOf('--json-schema');
    assert.notEqual(schemaFlagIndex, -1);
    const transmitted = claude.args[schemaFlagIndex + 1]!;
    assert.deepEqual(JSON.parse(transmitted), schema);
    assert.equal(sha256(transmitted), identity.digest);
  }
  assert.equal(
    Object.hasOwn(PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA, '$comment'),
    true,
  );
  assert.equal(
    Object.hasOwn(PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA, '$defs'),
    true,
  );
});

test('provider requests accept Git SHA-256 object identities', () => {
  const repository = createFixtureRepository();
  try {
    const policyDigest = crypto
      .createHash('sha256')
      .update('provider-policy')
      .digest('hex');
    const input = providerRequestInput(policyDigest, repository);
    input.baseCommit = 'a'.repeat(64);
    input.baseTree = 'b'.repeat(64);

    const request = createProviderInvocationRequest(input);

    assert.equal(request.baseCommit, input.baseCommit);
    assert.equal(request.baseTree, input.baseTree);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider environments preserve only reviewed provider-specific auth context', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-env-'),
  );
  try {
    const source = {
      HOME: temporaryDirectory,
      USER: 'reviewer',
      LOGNAME: 'reviewer',
      CODEX_HOME: path.join(temporaryDirectory, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(temporaryDirectory, '.claude'),
      OPENAI_API_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
      NODE_OPTIONS: '--require=/tmp/evil.cjs',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      GIT_CONFIG_GLOBAL: '/tmp/evil.gitconfig',
      PATH: '/tmp/fake-provider-bin',
      UNRELATED_SECRET: 'must-not-leak',
    };
    fs.mkdirSync(source.CODEX_HOME);
    fs.mkdirSync(source.CLAUDE_CONFIG_DIR);

    const codex = createProviderExecutionEnvironment(
      'codex',
      process.execPath,
      temporaryDirectory,
      source,
    );
    const claude = createProviderExecutionEnvironment(
      'claude',
      process.execPath,
      temporaryDirectory,
      source,
    );
    const neutralWrapper = createProviderExecutionEnvironment(
      null,
      process.execPath,
      temporaryDirectory,
      source,
    );

    assert.equal(codex.CODEX_HOME, source.CODEX_HOME);
    assert.equal(codex.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(claude.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR);
    assert.equal(claude.CODEX_HOME, undefined);
    assert.equal(neutralWrapper.CODEX_HOME, undefined);
    assert.equal(neutralWrapper.CLAUDE_CONFIG_DIR, undefined);
    for (const environment of [codex, claude, neutralWrapper]) {
      assert.equal(environment.HOME, source.HOME);
      assert.equal(environment.USER, 'reviewer');
      assert.equal(environment.LOGNAME, 'reviewer');
      assert.equal(environment.OPENAI_API_KEY, undefined);
      assert.equal(environment.ANTHROPIC_API_KEY, undefined);
      assert.equal(environment.NODE_OPTIONS, undefined);
      assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
      assert.equal(environment.UNRELATED_SECRET, undefined);
      assert.notEqual(environment.GIT_CONFIG_GLOBAL, source.GIT_CONFIG_GLOBAL);
      assert.equal(environment.TMPDIR, fs.realpathSync(temporaryDirectory));
      assert.equal(environment.TERM, 'dumb');
      assert.equal(environment.CI, '1');
      assert.equal(environment.GIT_PAGER, 'cat');
      assert.equal(environment.GIT_ATTR_NOSYSTEM, '1');
      assert.equal(environment.PATH?.includes('/tmp/fake-provider-bin'), false);
    }

    assert.equal(createTrustedExecutionEnvironment().GIT_ATTR_NOSYSTEM, '1');

    const rejectedRelativeHome = createProviderExecutionEnvironment(
      'claude',
      process.execPath,
      temporaryDirectory,
      { HOME: 'relative/home', USER: 'reviewer' },
    );
    assert.equal(rejectedRelativeHome.HOME, undefined);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('provider preflight inspects only fixed candidates and records canonical identity', () => {
  const inspected: string[] = [];
  const probed: string[][] = [];
  const identity = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/2.1.206/claude',
  );
  const host = fakeHost({
    inspectCandidate(candidate) {
      inspected.push(candidate);
      return candidate === '/opt/homebrew/bin/claude' ? identity : null;
    },
    runProbe(input) {
      probed.push(input.args);
      if (input.args[0] === '--version') {
        return successfulProbe('2.1.206 (Claude Code)\n');
      }
      if (input.args[0] === 'auth') {
        return successfulProbe('{"loggedIn":true,"authMethod":"claude.ai"}\n');
      }
      return successfulProbe(
        [
          '--print',
          '--output-format',
          '--no-session-persistence',
          '--safe-mode',
          '--disable-slash-commands',
          '--no-chrome',
          '--strict-mcp-config',
          '--mcp-config',
          '--permission-mode',
          '--tools',
          '--allowedTools',
          '--effort',
          '--json-schema',
        ].join('\n'),
      );
    },
  });

  const preflight = createProviderRunnerForTesting(
    builtInProviderAdapters,
    host,
  ).preflight;
  const resolution = preflight('claude', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: {
      PATH: '/tmp/fake-provider-bin',
      HOME: os.homedir(),
    },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.version, '2.1.206 (Claude Code)');
  assert.deepEqual(resolution.executable, identity);
  assert.deepEqual(inspected, [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]);
  assert.equal(
    inspected.some((candidate) => candidate.includes('/tmp/fake-provider-bin')),
    false,
  );
  assert.deepEqual(probed, [['--version'], ['--help'], ['auth', 'status']]);

  const disabled = createProviderRunnerForTesting(
    builtInProviderAdapters,
    fakeHost({
      inspectCandidate() {
        assert.fail('disabled providers must not be inspected');
      },
    }),
  ).preflight('claude', {
    platform: 'darwin',
    enabled: false,
    sourceEnvironment: process.env,
    temporaryDirectory: os.tmpdir(),
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(typeof preflightBuiltInProvider, 'function');
});

test('provider preflight preserves shared executable observation states', () => {
  const candidate = '/opt/homebrew/bin/claude';
  const identity = executableIdentity(candidate, candidate);
  const resolve = (observation: ProviderExecutableObservation) =>
    createProviderRunnerForTesting(
      builtInProviderAdapters,
      fakeHost({
        inspectCandidate(observedCandidate) {
          return observedCandidate === candidate ? observation : null;
        },
        runProbe(input) {
          if (input.args[0] === '--version') {
            return successfulProbe('2.1.206 (Claude Code)\n');
          }
          if (input.args[0] === 'auth') {
            return successfulProbe('{"loggedIn":true}\n');
          }
          return successfulProbe(CLAUDE_REQUIRED_HELP_FLAGS.join('\n'));
        },
      }),
    ).preflight('claude', {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    });

  assert.equal(
    resolve({
      schemaVersion: 1,
      kind: 'provider-executable-observation',
      candidatePath: candidate,
      state: 'absent',
      unsafeReason: null,
      identity: null,
    }).status,
    'absent',
  );
  assert.equal(
    resolve({
      schemaVersion: 1,
      kind: 'provider-executable-observation',
      candidatePath: candidate,
      state: 'unsafe',
      unsafeReason: 'GROUP_OR_WORLD_WRITABLE',
      identity: null,
    }).status,
    'unsafe-candidate',
  );
  const observed = resolve({
    schemaVersion: 1,
    kind: 'provider-executable-observation',
    candidatePath: candidate,
    state: 'observed',
    unsafeReason: null,
    identity,
  });
  assert.equal(observed.status, 'available');
  assert.deepEqual(observed.executable, identity);
});

test('Codex preflight probes root and exec capability surfaces with its own auth command', () => {
  const probed: string[][] = [];
  const identity = executableIdentity(
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  );
  const resolution = createProviderRunnerForTesting(
    builtInProviderAdapters,
    fakeHost({
      inspectCandidate(candidate) {
        return candidate === identity.candidatePath ? identity : null;
      },
      runProbe(input) {
        probed.push(input.args);
        if (input.args[0] === '--version') {
          return successfulProbe('codex-cli 0.145.0-alpha.30\n');
        }
        if (input.args[0] === 'login') {
          return successfulProbe('Logged in using ChatGPT\n');
        }
        return successfulProbe(
          input.args[0] === 'exec'
            ? [
                '--sandbox',
                '--cd',
                '--ephemeral',
                '--ignore-user-config',
                '--ignore-rules',
                '--output-schema',
                '--output-last-message',
                '--json',
                '--color',
              ].join('\n')
            : ['exec', '--ask-for-approval'].join('\n'),
        );
      },
    }),
  ).preflight('codex', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: { HOME: os.homedir() },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'available');
  assert.deepEqual(probed, [
    ['--version'],
    ['--help'],
    ['exec', '--help'],
    ['login', 'status'],
  ]);
});

test('provider preflight rejects ambiguous successful authentication output', () => {
  for (const [providerId, authCommand, authOutput] of [
    ['claude', 'auth', '{}\n'],
    ['codex', 'login', 'Authentication required\n'],
  ] as const) {
    const candidate =
      providerId === 'claude'
        ? '/opt/homebrew/bin/claude'
        : '/Applications/ChatGPT.app/Contents/Resources/codex';
    const identity = executableIdentity(
      candidate,
      providerId === 'claude'
        ? '/opt/homebrew/Caskroom/claude-code/2.1.206/claude'
        : candidate,
    );
    const resolution = createProviderRunnerForTesting(
      builtInProviderAdapters,
      fakeHost({
        inspectCandidate(observed) {
          return observed === candidate ? identity : null;
        },
        runProbe(input) {
          if (input.args[0] === '--version') {
            return successfulProbe(`${providerId} 1.0.0\n`);
          }
          if (input.args[0] === authCommand) {
            return successfulProbe(authOutput);
          }
          return successfulProbe(
            providerId === 'claude'
              ? CLAUDE_REQUIRED_HELP_FLAGS.join('\n')
              : input.args[0] === 'exec'
                ? [
                    '--sandbox',
                    '--cd',
                    '--ephemeral',
                    '--ignore-user-config',
                    '--ignore-rules',
                    '--output-schema',
                    '--output-last-message',
                    '--json',
                    '--color',
                  ].join('\n')
                : ['exec', '--ask-for-approval'].join('\n'),
          );
        },
      }),
    ).preflight(providerId, {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    });

    assert.equal(resolution.status, 'unauthenticated');
  }
});

test('preflight continues to a later reviewed candidate when the first is incompatible', () => {
  const first = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/1.0.0/claude',
  );
  const second = executableIdentity(
    '/usr/local/bin/claude',
    '/usr/local/Caskroom/claude-code/2.1.206/claude',
  );
  const probed: string[] = [];
  const resolution = createProviderRunnerForTesting(
    builtInProviderAdapters,
    fakeHost({
      inspectCandidate(candidate) {
        return candidate === first.candidatePath
          ? first
          : candidate === second.candidatePath
            ? second
            : null;
      },
      runProbe(input) {
        probed.push(`${input.executable}:${input.args.join(' ')}`);
        if (input.args[0] === '--version') {
          return successfulProbe(
            input.executable === first.realPath ? '1.0.0\n' : '2.1.206\n',
          );
        }
        if (input.args[0] === '--help') {
          return successfulProbe(
            input.executable === first.realPath
              ? '--print\n'
              : CLAUDE_REQUIRED_HELP_FLAGS.join('\n'),
          );
        }
        return successfulProbe('{"loggedIn":true}\n');
      },
    }),
  ).preflight('claude', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: { HOME: os.homedir() },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.executable?.realPath, second.realPath);
  assert.ok(probed.some((entry) => entry.startsWith(first.realPath)));
  assert.ok(probed.some((entry) => entry.startsWith(second.realPath)));
});

test('assigned built-in preflight probes only the exact selected profile executable', () => {
  const unselected = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/3.0.0/claude',
  );
  const selected = executableIdentity(
    '/usr/local/bin/claude',
    '/usr/local/Caskroom/claude-code/2.1.206/claude',
  );
  const inspected: string[] = [];
  const probed: string[] = [];
  const runner = createProviderRunnerForTesting(
    builtInProviderAdapters,
    fakeHost({
      inspectCandidate(candidate) {
        inspected.push(candidate);
        return candidate === unselected.candidatePath
          ? unselected
          : candidate === selected.candidatePath
            ? selected
            : null;
      },
      runProbe(input) {
        probed.push(input.executable);
        if (input.args[0] === '--version') {
          return successfulProbe('2.1.206\n');
        }
        if (input.args[0] === '--help') {
          return successfulProbe(CLAUDE_REQUIRED_HELP_FLAGS.join('\n'));
        }
        return successfulProbe('{"loggedIn":true}\n');
      },
    }),
  );

  const resolution = runner.preflightProfile(
    builtInProfile('/usr/local/bin/claude'),
    {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    },
  );

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.executable?.candidatePath, selected.candidatePath);
  assert.deepEqual(inspected, [selected.candidatePath]);
  assert.equal(
    probed.every((candidate) => candidate === selected.realPath),
    true,
  );
});

test('provider preflight rejects a reviewed symlink that resolves outside reviewed roots', () => {
  let probeCount = 0;
  const resolution = createProviderRunnerForTesting(
    builtInProviderAdapters,
    fakeHost({
      inspectCandidate(candidate) {
        return candidate === '/opt/homebrew/bin/claude'
          ? executableIdentity(candidate, '/tmp/caller-controlled-claude')
          : null;
      },
      runProbe() {
        probeCount += 1;
        return successfulProbe('');
      },
    }),
  ).preflight('claude', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: { HOME: os.homedir() },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'unsafe-candidate');
  assert.equal(probeCount, 0);
});

test('provider preflight rejects real paths outside exact reviewed install roots', () => {
  for (const realPath of [
    '/opt/homebrew/tmp/claude',
    '/opt/homebrew/Caskroom/unrelated-tool/1.0.0/claude',
  ]) {
    let probeCount = 0;
    const resolution = createProviderRunnerForTesting(
      builtInProviderAdapters,
      fakeHost({
        inspectCandidate(candidate) {
          return candidate === '/opt/homebrew/bin/claude'
            ? executableIdentity(candidate, realPath)
            : null;
        },
        runProbe() {
          probeCount += 1;
          return successfulProbe('');
        },
      }),
    ).preflight('claude', {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    });

    assert.equal(resolution.status, 'unsafe-candidate', realPath);
    assert.equal(probeCount, 0, realPath);
  }
});
