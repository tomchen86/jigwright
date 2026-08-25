import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AgentProviderConfigError,
  parseAgentProviderConfigToml,
  resolveEligibleAgentProviderProfile,
  resolveAgentProviderProfile,
} from '../src/agent-provider-config.ts';
import {
  ProviderExecutableObservationError,
  MAX_PROVIDER_EXECUTABLE_BYTES,
  assertProviderExecutableObservationCurrent,
  inspectProviderExecutable,
  isProviderExecutableOwnerAdmitted,
} from '../src/provider-executable-identity.ts';

const configuration = `
# Host operational configuration; repository policy remains separate.
schema_version = 2

[[providers]]
id = "codex-local"
family = "codex"
trust_tier = "built-in-reviewed"
enabled = true
protocol = "codex-jsonl-v1"
executable = "/opt/homebrew/bin/codex"

[[providers]]
id = "claude-local"
family = "claude"
trust_tier = "built-in-reviewed"
enabled = true
protocol = "claude-stream-json-v1"
executable = "/opt/homebrew/bin/claude"

[[providers]]
id = "internal-wrapper"
family = "custom/internal"
trust_tier = "host-wrapper"
enabled = false
protocol = "harness-jsonl-v1"
executable = "/Users/example/.local/bin/internal-agent-wrapper"
start_args = ["run", "--request", "{request_file}"]
resume_args = ["resume", "--session", "{native_session_id}", "--request", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"

[provider_preferences]
author = ["claude-local", "codex-local"]
builder = ["codex-local", "claude-local"]
reviewer = ["claude-local", "codex-local"]
`;

test('host provider config normalizes independently of registration order and ranks explicitly', () => {
  const snapshot = parseAgentProviderConfigToml(configuration, {
    platform: 'darwin',
  });
  const reordered = parseAgentProviderConfigToml(
    configuration.replace(
      /\[\[providers\]\]\nid = "codex-local"[\s\S]*?executable = "\/opt\/homebrew\/bin\/codex"\n\n\[\[providers\]\]\nid = "claude-local"[\s\S]*?executable = "\/opt\/homebrew\/bin\/claude"/u,
      `[[providers]]
id = "claude-local"
family = "claude"
trust_tier = "built-in-reviewed"
enabled = true
protocol = "claude-stream-json-v1"
executable = "/opt/homebrew/bin/claude"

[[providers]]
id = "codex-local"
family = "codex"
trust_tier = "built-in-reviewed"
enabled = true
protocol = "codex-jsonl-v1"
executable = "/opt/homebrew/bin/codex"`,
    ),
    { platform: 'darwin' },
  );

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.kind, 'agent-provider-config-snapshot');
  assert.match(snapshot.configDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(
    snapshot.providers.map(({ id }) => id),
    ['claude-local', 'codex-local', 'internal-wrapper'],
  );
  assert.equal(snapshot.configDigest, reordered.configDigest);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.providers), true);
  assert.equal(Object.isFrozen(snapshot.preferences.author), true);

  const author = resolveAgentProviderProfile(snapshot, { role: 'author' });
  assert.equal(author.profile.id, 'claude-local');
  assert.equal(author.rank, 0);
  assert.equal(author.selectionReason, 'role-ranking');

  const explicit = resolveAgentProviderProfile(snapshot, {
    profileId: 'codex-local',
  });
  assert.equal(explicit.profile.id, 'codex-local');
  assert.equal(explicit.rank, null);
  assert.equal(explicit.selectionReason, 'explicit-profile');

  const tampered = {
    ...snapshot,
    preferences: {
      ...snapshot.preferences,
      author: ['codex-local', 'claude-local'],
    },
  };
  assert.throws(
    () => resolveAgentProviderProfile(tampered, { role: 'author' }),
    AgentProviderConfigError,
  );

  const executableDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-runtime-executable-'),
  );
  try {
    fs.chmodSync(executableDirectory, 0o700);
    const executablePath = path.join(executableDirectory, 'provider');
    const executableBytes = Buffer.concat([
      Buffer.from('#!/bin/sh\nexit 0\n', 'utf8'),
      Buffer.alloc(131_123, 0x61),
    ]);
    fs.writeFileSync(executablePath, executableBytes, { mode: 0o700 });
    fs.chmodSync(executablePath, 0o700);

    const observed = inspectProviderExecutable(executablePath);
    assert.equal(observed.state, 'observed');
    assert.equal(observed.unsafeReason, null);
    assert.equal(observed.identity?.candidatePath, executablePath);
    assert.equal(observed.identity?.realPath, fs.realpathSync(executablePath));
    assert.equal(
      observed.identity?.sha256,
      crypto.createHash('sha256').update(executableBytes).digest('hex'),
    );
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(Object.isFrozen(observed.identity), true);
    assert.equal(
      assertProviderExecutableObservationCurrent(observed),
      observed,
    );
    assert.throws(
      () => assertProviderExecutableObservationCurrent({ ...observed }),
      (error) =>
        error instanceof ProviderExecutableObservationError &&
        error.code === 'PROVIDER_EXECUTABLE_OBSERVATION_STALE',
      'a structural clone must not recover the module-owned currentness capability',
    );

    fs.chmodSync(executablePath, 0o755);
    assert.throws(
      () => assertProviderExecutableObservationCurrent(observed),
      ProviderExecutableObservationError,
      'safe mode drift must still invalidate exact identity',
    );

    const contentBound = inspectProviderExecutable(executablePath);
    fs.writeFileSync(
      executablePath,
      Buffer.concat([
        Buffer.from('#!/bin/sh\nexit 1\n', 'utf8'),
        Buffer.alloc(131_123, 0x62),
      ]),
    );
    assert.throws(
      () => assertProviderExecutableObservationCurrent(contentBound),
      ProviderExecutableObservationError,
      'content drift must invalidate the digest-bound identity',
    );

    const replacementBound = inspectProviderExecutable(executablePath);
    const replacementPath = path.join(executableDirectory, 'replacement');
    fs.writeFileSync(replacementPath, fs.readFileSync(executablePath), {
      mode: 0o755,
    });
    fs.chmodSync(replacementPath, 0o755);
    fs.renameSync(replacementPath, executablePath);
    assert.throws(
      () => assertProviderExecutableObservationCurrent(replacementBound),
      ProviderExecutableObservationError,
      'same-byte atomic replacement must invalidate inode currentness',
    );

    const absentPath = path.join(executableDirectory, 'initially-absent');
    const absent = inspectProviderExecutable(absentPath);
    assert.equal(absent.state, 'absent');
    assert.equal(assertProviderExecutableObservationCurrent(absent), absent);
    fs.writeFileSync(absentPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(absentPath, 0o700);
    assert.throws(
      () => assertProviderExecutableObservationCurrent(absent),
      ProviderExecutableObservationError,
      'an absent candidate appearing after observation must fail currentness',
    );

    const symlinkTarget = path.join(executableDirectory, 'symlink-target');
    const symlinkCandidate = path.join(
      executableDirectory,
      'symlink-candidate',
    );
    fs.writeFileSync(symlinkTarget, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(symlinkTarget, 0o700);
    fs.symlinkSync(symlinkTarget, symlinkCandidate);
    const symlinked = inspectProviderExecutable(symlinkCandidate);
    assert.equal(symlinked.state, 'observed');
    assert.equal(symlinked.identity?.candidatePath, symlinkCandidate);
    assert.equal(symlinked.identity?.realPath, fs.realpathSync(symlinkTarget));
    assert.equal(
      assertProviderExecutableObservationCurrent(symlinked),
      symlinked,
    );

    if (process.platform !== 'win32') {
      const fifoTarget = path.join(executableDirectory, 'fifo-target');
      const fifoCandidate = path.join(executableDirectory, 'fifo-candidate');
      const created = spawnSync('mkfifo', [fifoTarget], { encoding: 'utf8' });
      assert.equal(created.status, 0, created.stderr);
      fs.symlinkSync(fifoTarget, fifoCandidate);
      const inspected = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          `import { inspectProviderExecutable } from ${JSON.stringify(
            new URL('../src/provider-executable-identity.ts', import.meta.url)
              .href,
          )}; process.stdout.write(JSON.stringify(inspectProviderExecutable(${JSON.stringify(
            fifoCandidate,
          )})));`,
        ],
        { encoding: 'utf8', timeout: 2_000 },
      );
      assert.equal(inspected.error, undefined, String(inspected.error));
      assert.equal(inspected.status, 0, inspected.stderr);
      assert.equal(
        JSON.parse(inspected.stdout).unsafeReason,
        'NON_REGULAR_FILE',
      );
    }

    const nonRegular = path.join(executableDirectory, 'directory');
    fs.mkdirSync(nonRegular, { mode: 0o700 });
    assert.deepEqual(inspectProviderExecutable(nonRegular), {
      schemaVersion: 1,
      kind: 'provider-executable-observation',
      candidatePath: nonRegular,
      state: 'unsafe',
      unsafeReason: 'NON_REGULAR_FILE',
      identity: null,
    });

    const nonExecutable = path.join(executableDirectory, 'non-executable');
    fs.writeFileSync(nonExecutable, 'not executable\n', { mode: 0o600 });
    fs.chmodSync(nonExecutable, 0o600);
    const unsafeBound = inspectProviderExecutable(nonExecutable);
    assert.equal(unsafeBound.unsafeReason, 'NOT_EXECUTABLE');
    assert.equal(
      assertProviderExecutableObservationCurrent(unsafeBound),
      unsafeBound,
    );
    assert.throws(
      () =>
        assertProviderExecutableObservationCurrent({
          ...unsafeBound,
        }),
      ProviderExecutableObservationError,
      'unsafe observations also retain a module-owned currentness capability',
    );
    fs.chmodSync(nonExecutable, 0o700);
    assert.throws(
      () => assertProviderExecutableObservationCurrent(unsafeBound),
      ProviderExecutableObservationError,
      'an unsafe candidate becoming executable must invalidate its observation',
    );

    const empty = path.join(executableDirectory, 'empty');
    fs.writeFileSync(empty, '', { mode: 0o700 });
    fs.chmodSync(empty, 0o700);
    assert.equal(inspectProviderExecutable(empty).unsafeReason, 'EMPTY_FILE');

    const oversized = path.join(executableDirectory, 'oversized');
    fs.writeFileSync(oversized, '#!/bin/sh\n', { mode: 0o700 });
    fs.chmodSync(oversized, 0o700);
    fs.truncateSync(oversized, MAX_PROVIDER_EXECUTABLE_BYTES + 1);
    assert.equal(
      inspectProviderExecutable(oversized).unsafeReason,
      'SIZE_LIMIT_EXCEEDED',
      'a sparse oversized file must fail before unbounded hashing',
    );

    const writable = path.join(executableDirectory, 'writable');
    fs.writeFileSync(writable, '#!/bin/sh\nexit 0\n', { mode: 0o722 });
    fs.chmodSync(writable, 0o722);
    assert.equal(
      inspectProviderExecutable(writable).unsafeReason,
      'GROUP_OR_WORLD_WRITABLE',
    );

    const hardlinked = path.join(executableDirectory, 'hardlinked');
    const hardlinkAlias = path.join(executableDirectory, 'hardlink-alias');
    fs.writeFileSync(hardlinked, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(hardlinked, 0o700);
    fs.linkSync(hardlinked, hardlinkAlias);
    assert.equal(
      inspectProviderExecutable(hardlinked).unsafeReason,
      'MULTIPLE_HARD_LINKS',
    );

    if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      const currentUid = process.getuid();
      const foreignUid = currentUid === 1 ? 2 : 1;
      assert.equal(isProviderExecutableOwnerAdmitted(currentUid), true);
      assert.equal(isProviderExecutableOwnerAdmitted(0), true);
      assert.equal(isProviderExecutableOwnerAdmitted(foreignUid), false);
    }
  } finally {
    fs.rmSync(executableDirectory, { recursive: true, force: true });
  }
});

test('host wrapper remains an explicit lower-trust profile with bounded placeholders', () => {
  const snapshot = parseAgentProviderConfigToml(configuration, {
    platform: 'darwin',
  });
  const resolved = resolveAgentProviderProfile(snapshot, {
    profileId: 'internal-wrapper',
  });

  assert.equal(resolved.profile.trustTier, 'host-wrapper');
  assert.equal(resolved.profile.enabled, false);
  assert.equal(resolved.profile.protocol, 'harness-jsonl-v1');
  assert.deepEqual(resolved.profile.startArgs, [
    'run',
    '--request',
    '{request_file}',
  ]);
  assert.deepEqual(resolved.profile.resumeArgs, [
    'resume',
    '--session',
    '{native_session_id}',
    '--request',
    '{request_file}',
  ]);
  assert.equal(Object.isFrozen(resolved.profile.startArgs), true);
  assert.match(resolved.profile.profileDigest, /^[0-9a-f]{64}$/u);
});

test('harness-jsonl-v2 separates fresh and resumable session capabilities', () => {
  const resumableConfiguration = configuration
    .replace(
      'protocol = "harness-jsonl-v1"',
      'capabilities = ["fresh-session", "resumable-session"]\nprotocol = "harness-jsonl-v2"',
    )
    .replace('enabled = false', 'enabled = true')
    .replace(
      'reviewer = ["claude-local", "codex-local"]',
      'reviewer = ["claude-local", "codex-local", "internal-wrapper"]',
    )
    .replace(
      'author = ["claude-local", "codex-local"]',
      'author = ["claude-local", "codex-local", "internal-wrapper"]',
    )
    .replace(
      'builder = ["codex-local", "claude-local"]',
      'builder = ["codex-local", "claude-local", "internal-wrapper"]',
    );
  const snapshot = parseAgentProviderConfigToml(resumableConfiguration, {
    platform: 'darwin',
  });
  const wrapper = snapshot.providers.find(
    ({ id }) => id === 'internal-wrapper',
  )!;
  assert.equal(wrapper.protocol, 'harness-jsonl-v2');
  assert.deepEqual(wrapper.capabilities, [
    'fresh-session',
    'resumable-session',
  ]);

  const freshOnly = parseAgentProviderConfigToml(
    resumableConfiguration
      .replace('["fresh-session", "resumable-session"]', '["fresh-session"]')
      .replace(
        'resume_args = ["resume", "--session", "{native_session_id}", "--request", "{request_file}"]',
        'resume_args = []',
      ),
    { platform: 'darwin' },
  );
  assert.deepEqual(
    freshOnly.providers.find(({ id }) => id === 'internal-wrapper')!
      .capabilities,
    ['fresh-session'],
  );
});

test('session capability claims require harness-jsonl-v2 and an exact resume contract', () => {
  const base = configuration.replace(
    'protocol = "harness-jsonl-v1"',
    'capabilities = ["fresh-session", "resumable-session"]\nprotocol = "harness-jsonl-v2"',
  );
  for (const invalid of [
    base.replace('harness-jsonl-v2', 'harness-jsonl-v1'),
    base.replace(
      'resume_args = ["resume", "--session", "{native_session_id}", "--request", "{request_file}"]',
      'resume_args = []',
    ),
    base.replace('{native_session_id}', '{provider_session_id}'),
  ]) {
    assert.throws(
      () => parseAgentProviderConfigToml(invalid, { platform: 'darwin' }),
      AgentProviderConfigError,
    );
  }

  const legacy = parseAgentProviderConfigToml(configuration, {
    platform: 'darwin',
  });
  assert.deepEqual(
    legacy.providers.find(({ id }) => id === 'internal-wrapper')!.capabilities,
    [],
  );
});

test('host config refuses adaptive aliases, implicit ranking, mutable built-in argv, and unsafe paths', () => {
  for (const invalid of [
    configuration.replace('id = "claude-local"', 'id = "adaptive"'),
    configuration.replace(
      'author = ["claude-local", "codex-local"]',
      'author = ["claude-local"]',
    ),
    configuration.replace(
      'executable = "/opt/homebrew/bin/claude"',
      'executable = "/opt/homebrew/bin/claude"\nstart_args = ["--unsafe"]',
    ),
    configuration.replace('{request_file}', '{repository_root}'),
    configuration.replace(
      'executable = "/opt/homebrew/bin/codex"',
      'executable = "codex"',
    ),
  ]) {
    assert.throws(
      () => parseAgentProviderConfigToml(invalid, { platform: 'darwin' }),
      (error: unknown) =>
        error instanceof AgentProviderConfigError &&
        error.code === 'AGENT_PROVIDER_CONFIG_INVALID',
    );
  }

  assert.throws(
    () =>
      parseAgentProviderConfigToml(
        configuration.replace(
          '/opt/homebrew/bin/codex',
          'C:\\\\Program Files\\\\Codex\\\\codex.exe',
        ),
        { platform: 'darwin' },
      ),
    AgentProviderConfigError,
  );
});

const constrainedConfiguration = `
schema_version = 2
global_ranking = ["alpha-primary", "alpha-alias", "charlie", "delta-disabled", "bravo"]

[[providers]]
id = "charlie"
logical_provider_id = "charlie"
family = "google"
capabilities = ["survey", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "charlie-jsonl-v1"
executable = "/opt/providers/charlie"

[[providers]]
id = "alpha-alias"
logical_provider_id = "alpha"
family = "openai"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "alpha-jsonl-v1"
executable = "/opt/providers/alpha-alias"

[[providers]]
id = "delta-disabled"
logical_provider_id = "delta"
family = "anthropic"
capabilities = ["fresh-session", "plan-review", "task-diff-review"]
trust_tier = "built-in-reviewed"
enabled = false
protocol = "delta-jsonl-v1"
executable = "/opt/providers/delta"

[[providers]]
id = "bravo"
logical_provider_id = "bravo"
family = "anthropic"
capabilities = ["fresh-session", "plan-review", "task-diff-review"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "bravo-jsonl-v1"
executable = "/opt/providers/bravo"

[[providers]]
id = "alpha-primary"
logical_provider_id = "alpha"
family = "openai"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "alpha-jsonl-v1"
executable = "/opt/providers/alpha-primary"

[provider_preferences]
author = ["alpha-primary", "alpha-alias", "charlie", "bravo"]
builder = ["charlie", "alpha-primary", "alpha-alias", "bravo"]
reviewer = ["alpha-primary", "alpha-alias", "bravo", "charlie"]
`;

test('host facts and explicit global ranking are canonical across registration order', () => {
  const snapshot = parseAgentProviderConfigToml(constrainedConfiguration, {
    platform: 'darwin',
  });
  const reordered = parseAgentProviderConfigToml(
    constrainedConfiguration.replace(
      /(\[\[providers\]\]\nid = "charlie"[\s\S]*?executable = "\/opt\/providers\/charlie"\n\n)(\[\[providers\]\]\nid = "alpha-alias"[\s\S]*?executable = "\/opt\/providers\/alpha-alias"\n\n)/u,
      '$2$1',
    ),
    { platform: 'darwin' },
  );

  assert.equal(snapshot.configDigest, reordered.configDigest);
  assert.equal(snapshot.globalRankingSource, 'explicit');
  assert.deepEqual(snapshot.globalRanking, [
    'alpha-primary',
    'alpha-alias',
    'charlie',
    'delta-disabled',
    'bravo',
  ]);
  assert.deepEqual(
    snapshot.providers.map(
      ({ id, logicalProviderId, family, capabilities, enabled }) => ({
        id,
        logicalProviderId,
        family,
        capabilities,
        enabled,
      }),
    ),
    [
      {
        id: 'alpha-alias',
        logicalProviderId: 'alpha',
        family: 'openai',
        capabilities: [
          'fresh-session',
          'plan-review',
          'survey',
          'task-diff-review',
          'task-implementation',
        ],
        enabled: true,
      },
      {
        id: 'alpha-primary',
        logicalProviderId: 'alpha',
        family: 'openai',
        capabilities: [
          'fresh-session',
          'plan-review',
          'survey',
          'task-diff-review',
          'task-implementation',
        ],
        enabled: true,
      },
      {
        id: 'bravo',
        logicalProviderId: 'bravo',
        family: 'anthropic',
        capabilities: ['fresh-session', 'plan-review', 'task-diff-review'],
        enabled: true,
      },
      {
        id: 'charlie',
        logicalProviderId: 'charlie',
        family: 'google',
        capabilities: ['survey', 'task-implementation'],
        enabled: true,
      },
      {
        id: 'delta-disabled',
        logicalProviderId: 'delta',
        family: 'anthropic',
        capabilities: ['fresh-session', 'plan-review', 'task-diff-review'],
        enabled: false,
      },
    ],
  );
});

test('host facts fail closed on incomplete ranking, unknown capability, and split logical identity', () => {
  for (const invalid of [
    constrainedConfiguration.replace(
      '"delta-disabled", "bravo"',
      '"delta-disabled"',
    ),
    constrainedConfiguration.replace(
      '"survey", "task-implementation"',
      '"survey", "unknown"',
    ),
    constrainedConfiguration.replace(
      'id = "alpha-alias"\nlogical_provider_id = "alpha"\nfamily = "openai"',
      'id = "alpha-alias"\nlogical_provider_id = "alpha"\nfamily = "anthropic"',
    ),
  ]) {
    assert.throws(
      () => parseAgentProviderConfigToml(invalid, { platform: 'darwin' }),
      AgentProviderConfigError,
    );
  }
});

test('constraint-first selection skips a conflicting preference and follows global ranking', () => {
  const snapshot = parseAgentProviderConfigToml(constrainedConfiguration, {
    platform: 'darwin',
  });

  const resolution = resolveEligibleAgentProviderProfile(snapshot, {
    role: 'reviewer',
    preferredLogicalProviderIds: ['alpha'],
    requiredCapabilities: ['fresh-session', 'task-diff-review'],
    allowedProviderFamilies: ['anthropic', 'google'],
    excludedLogicalProviderIds: ['alpha'],
  });

  assert.equal(resolution.profile.id, 'bravo');
  assert.equal(resolution.profile.logicalProviderId, 'bravo');
  assert.equal(resolution.rank, 4);
  assert.equal(resolution.selectionReason, 'global-ranking');
  assert.equal(resolution.rankingSource, 'explicit');
});

test('logical-provider exclusion removes every profile alias before ranking', () => {
  const snapshot = parseAgentProviderConfigToml(constrainedConfiguration, {
    platform: 'darwin',
  });

  const resolution = resolveEligibleAgentProviderProfile(snapshot, {
    role: 'author',
    preferredLogicalProviderIds: ['alpha'],
    requiredCapabilities: ['survey'],
    allowedProviderFamilies: ['openai', 'google', 'anthropic'],
    excludedLogicalProviderIds: ['alpha'],
  });

  assert.equal(resolution.profile.id, 'charlie');
  assert.equal(resolution.rank, 2);
  assert.equal(resolution.selectionReason, 'global-ranking');
});

test('legacy config projects an explicit compatibility ranking without changing per-role resolution', () => {
  const snapshot = parseAgentProviderConfigToml(configuration, {
    platform: 'darwin',
  });

  assert.equal(snapshot.globalRankingSource, 'legacy-author-preferences');
  assert.deepEqual(snapshot.globalRanking, [
    'claude-local',
    'codex-local',
    'internal-wrapper',
  ]);
  assert.equal(
    resolveAgentProviderProfile(snapshot, { role: 'builder' }).profile.id,
    'codex-local',
  );
  assert.throws(
    () =>
      resolveEligibleAgentProviderProfile(snapshot, {
        role: 'builder',
        preferredLogicalProviderIds: ['codex'],
        requiredCapabilities: ['task-implementation'],
        allowedProviderFamilies: ['codex'],
        excludedLogicalProviderIds: [],
      }),
    AgentProviderConfigError,
  );
  assert.deepEqual(
    snapshot.providers.map(({ id, logicalProviderId, capabilities }) => ({
      id,
      logicalProviderId,
      capabilities,
    })),
    [
      {
        id: 'claude-local',
        logicalProviderId: 'claude',
        capabilities: [],
      },
      {
        id: 'codex-local',
        logicalProviderId: 'codex',
        capabilities: [],
      },
      {
        id: 'internal-wrapper',
        logicalProviderId: 'custom/internal',
        capabilities: [],
      },
    ],
  );
});
