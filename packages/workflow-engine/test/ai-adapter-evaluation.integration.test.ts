/** Diagnostic adapter policy and immutable host-snapshot evaluation without launch. */
import { builtInProviderAdapters } from '../src/composition-root/built-in-provider-adapter-production.ts';
import test from 'node:test';
import {
  createFixtureRepository,
  git,
  runtimeRoot,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';
import { evaluateAiAdapter } from '../src/runtime/provider-execution/ai-adapter-evaluation.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  writePolicy,
  validPolicy,
  REQUIRED_CONTROLS,
  providersPolicy,
  limitsPolicy,
  adapterPolicyPath,
  runCli,
  hostProviderConfiguration,
} from './ai-adapter-evaluation-fixture.ts';

test('AI adapter evaluation denies launch on every platform without side effects', () => {
  const repository = createFixtureRepository();
  const marker = `adapter-secret-${Date.now()}`;
  const previousMarker = process.env.AI_ADAPTER_TEST_SECRET;
  try {
    writePolicy(repository, validPolicy());
    const beforeStatus = git(repository, ['status', '--porcelain=v1']);
    process.env.AI_ADAPTER_TEST_SECRET = marker;

    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const result = evaluateAiAdapter(
        builtInProviderAdapters,
        repository,
        platform,
      );
      assert.equal(result.schemaVersion, 3);
      assert.equal(result.mode, 'managed-read-only');
      assert.equal(result.decision, 'deny');
      assert.equal(result.launchAuthorized, false);
      assert.equal(result.lifecycleLaunchPolicy, 'lifecycle-only');
      assert.equal(result.filesystemSandboxVerified, false);
      assert.equal(result.sameUserProcessConfined, false);
      assert.equal(result.platform, platform);
      assert.deepEqual(result.limits, {
        timeoutMs: 3_600_000,
        aggregateOutputBytes: 1_048_576,
        maxConcurrent: 2,
      });
      assert.deepEqual(
        result.providers.map(({ id, enabled, capabilities }) => ({
          id,
          enabled,
          capabilities,
        })),
        [
          {
            id: 'codex',
            enabled: true,
            capabilities: [
              {
                purpose: 'survey',
                profile: 'repository-read-only',
              },
              {
                purpose: 'plan-review',
                profile: 'repository-read-only',
              },
              {
                purpose: 'task-implementation',
                profile: 'repository-read-only',
              },
              {
                purpose: 'task-diff-review',
                profile: 'repository-read-only',
              },
            ],
          },
          {
            id: 'claude',
            enabled: true,
            capabilities: [
              {
                purpose: 'survey',
                profile: 'repository-read-only',
              },
              {
                purpose: 'plan-review',
                profile: 'repository-read-only',
              },
              {
                purpose: 'task-implementation',
                profile: 'repository-read-only',
              },
              {
                purpose: 'task-diff-review',
                profile: 'repository-read-only',
              },
            ],
          },
        ],
      );
      for (const provider of result.providers) {
        assert.ok(
          [
            'available',
            'absent',
            'unsafe-candidate',
            'incompatible',
            'unauthenticated',
            'unsupported-platform',
          ].includes(provider.resolver.status),
        );
        if (platform !== 'darwin') {
          assert.equal(provider.resolver.status, 'unsupported-platform');
        }
        if (platform === 'darwin' && provider.resolver.status === 'available') {
          const resolver = provider.resolver as unknown as {
            version?: unknown;
            executable?: { realPath?: unknown; sha256?: unknown };
          };
          assert.equal(typeof resolver.version, 'string');
          assert.equal(typeof resolver.executable?.realPath, 'string');
          assert.match(String(resolver.executable?.sha256), /^[0-9a-f]{64}$/);
        }
      }
      assert.deepEqual(
        result.controls.map(({ id, status }) => ({ id, status })),
        REQUIRED_CONTROLS.map((id) => ({ id, status: 'not-verified' })),
      );
      assert.deepEqual(result.reasons, [
        'DIAGNOSTIC_COMMAND_DOES_NOT_LAUNCH',
        'SAME_USER_PROCESS_NOT_CONFINED',
        'OBSERVED_PROJECTION_EQUALITY_ONLY',
      ]);
      assert.ok(
        result.residuals.includes('TRANSIENT_WRITE_RESTORE_NOT_DETECTABLE'),
      );
      assert.ok(result.residuals.includes('SUBPROCESS_TREE_NOT_CONFINED'));
      assert.ok(
        result.residuals.includes(
          'TRANSIENT_EXECUTABLE_SUBSTITUTION_NOT_DETECTABLE',
        ),
      );
      assert.match(result.policyDigest, /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(result).includes(marker), false);
    }

    assert.equal(git(repository, ['status', '--porcelain=v1']), beforeStatus);
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    if (previousMarker === undefined) {
      delete process.env.AI_ADAPTER_TEST_SECRET;
    } else {
      process.env.AI_ADAPTER_TEST_SECRET = previousMarker;
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('AI adapter policy changes fail closed instead of enabling a launcher', () => {
  const repository = createFixtureRepository();
  try {
    const invalidPolicies: unknown[] = [
      { ...validPolicy(), schemaVersion: 2 },
      { ...validPolicy(), mode: 'enabled' },
      { ...validPolicy(), launchPolicy: 'allow' },
      {
        ...validPolicy(),
        requiredControls: REQUIRED_CONTROLS.slice(0, -1),
      },
      {
        ...validPolicy(),
        requiredControls: [
          REQUIRED_CONTROLS[0],
          REQUIRED_CONTROLS[0],
          ...REQUIRED_CONTROLS.slice(2),
        ],
      },
      {
        ...validPolicy(),
        requiredControls: [...REQUIRED_CONTROLS].reverse(),
      },
      {
        ...validPolicy(),
        providers: {
          ...providersPolicy(),
          unknown: { enabled: true },
        },
      },
      {
        ...validPolicy(),
        providers: {
          ...providersPolicy(),
          codex: {
            enabled: true,
            command: ['codex', 'exec'],
          },
        },
      },
      {
        ...validPolicy(),
        providers: {
          codex: { enabled: true },
        },
      },
      {
        ...validPolicy(),
        limits: {
          ...limitsPolicy(),
          timeoutMs: 3_600_001,
        },
      },
      {
        ...validPolicy(),
        limits: {
          ...limitsPolicy(),
          aggregateOutputBytes: 1_048_577,
        },
      },
      {
        ...validPolicy(),
        limits: {
          ...limitsPolicy(),
          maxConcurrent: 3,
        },
      },
      {
        ...validPolicy(),
        limits: {
          ...limitsPolicy(),
          maxConcurrent: 1.5,
        },
      },
      { ...validPolicy(), command: ['ai', 'run'] },
      (() => {
        const value = validPolicy() as Record<string, unknown>;
        delete value.launchPolicy;
        return value;
      })(),
    ];

    for (const policy of invalidPolicies) {
      writePolicy(repository, policy);
      assert.throws(
        () => evaluateAiAdapter(builtInProviderAdapters, repository, 'linux'),
        (error) => isWorkflowError(error, 'AI_ADAPTER_POLICY_INVALID'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('AI adapter policy may only disable built-ins and lower positive limits', () => {
  const repository = createFixtureRepository();
  try {
    writePolicy(repository, {
      ...validPolicy(),
      providers: {
        codex: { enabled: false },
        claude: { enabled: true },
      },
      limits: {
        timeoutMs: 10_000,
        aggregateOutputBytes: 32_768,
        maxConcurrent: 1,
      },
    });

    const result = evaluateAiAdapter(
      builtInProviderAdapters,
      repository,
      'linux',
    );
    assert.deepEqual(
      result.providers.map(({ id, enabled, resolver }) => ({
        id,
        enabled,
        resolver: resolver.status,
      })),
      [
        { id: 'codex', enabled: false, resolver: 'disabled' },
        { id: 'claude', enabled: true, resolver: 'unsupported-platform' },
      ],
    );
    assert.deepEqual(result.limits, {
      timeoutMs: 10_000,
      aggregateOutputBytes: 32_768,
      maxConcurrent: 1,
    });

    for (const limits of [
      { ...limitsPolicy(), timeoutMs: 0 },
      { ...limitsPolicy(), timeoutMs: 1.5 },
      { ...limitsPolicy(), aggregateOutputBytes: 0 },
      { ...limitsPolicy(), aggregateOutputBytes: 1.5 },
      { ...limitsPolicy(), maxConcurrent: 0 },
    ]) {
      writePolicy(repository, { ...validPolicy(), limits });
      assert.throws(
        () => evaluateAiAdapter(builtInProviderAdapters, repository, 'linux'),
        (error) => isWorkflowError(error, 'AI_ADAPTER_POLICY_INVALID'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('tracked adapter policy and schema publish the same strict v4 bounds', () => {
  const result = evaluateAiAdapter(
    builtInProviderAdapters,
    sourceRepositoryRoot,
    'linux',
  );
  assert.equal(result.schemaVersion, 3);
  assert.deepEqual(result.limits, limitsPolicy());
  assert.deepEqual(
    result.providers.map(({ id, enabled }) => ({ id, enabled })),
    [
      { id: 'codex', enabled: true },
      { id: 'claude', enabled: true },
    ],
  );

  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        sourceRepositoryRoot,
        'workflow/schemas/ai-adapter-policy.schema.json',
      ),
      'utf8',
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 4);
  assert.deepEqual(schema.properties.providers.required, ['codex', 'claude']);
  assert.equal(schema.properties.providers.additionalProperties, false);
  assert.deepEqual(
    {
      timeoutMs: schema.properties.limits.properties.timeoutMs.maximum,
      aggregateOutputBytes:
        schema.properties.limits.properties.aggregateOutputBytes.maximum,
      maxConcurrent: schema.properties.limits.properties.maxConcurrent.maximum,
    },
    limitsPolicy(),
  );
  assert.equal(schema.properties.limits.additionalProperties, false);
  assert.equal(schema.$defs.providerPolicy.additionalProperties, false);

  const pilotSchema = JSON.parse(
    fs.readFileSync(
      path.join(
        sourceRepositoryRoot,
        'workflow/schemas/provider-availability-pilot.schema.json',
      ),
      'utf8',
    ),
  );
  assert.equal(pilotSchema.additionalProperties, false);
  assert.equal(
    pilotSchema.properties.kind.const,
    'provider-availability-pilot-result.v1',
  );
  assert.equal(pilotSchema.$defs.observation.additionalProperties, false);
});

test(
  'AI adapter evaluation rejects a symlinked policy',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    try {
      const externalPath = path.join(repository, 'external-policy.json');
      fs.writeFileSync(
        externalPath,
        `${JSON.stringify(validPolicy(), null, 2)}\n`,
      );
      const policyPath = adapterPolicyPath(repository);
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      fs.rmSync(policyPath, { force: true });
      fs.symlinkSync('../external-policy.json', policyPath);

      assert.throws(
        () =>
          evaluateAiAdapter(
            builtInProviderAdapters,
            repository,
            process.platform,
          ),
        (error) => isWorkflowError(error, 'AI_ADAPTER_POLICY_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test('AI adapter evaluation remains diagnostic and ignores fake sandbox tools', () => {
  const repository = createFixtureRepository();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sandbox-bin-'));
  const markerPath = path.join(fakeBin, 'sandbox-ran');
  try {
    writePolicy(repository, validPolicy());
    const fakeSandbox = path.join(fakeBin, 'sandbox-exec');
    fs.writeFileSync(
      fakeSandbox,
      `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\nexit 0\n`,
    );
    fs.chmodSync(fakeSandbox, 0o755);
    const beforeStatus = git(repository, ['status', '--porcelain=v1']);

    const evaluation = runCli(repository, ['adapter', 'evaluate', '--json'], {
      PATH: fakeBin,
    });
    assert.equal(evaluation.status, 0, evaluation.stderr);
    const output = JSON.parse(evaluation.stdout);
    assert.equal(output.result.launchAuthorized, false);
    assert.equal(output.result.filesystemSandboxVerified, false);
    assert.equal('providerConfiguration' in output.result, false);
    assert.equal(fs.existsSync(markerPath), false);

    for (const args of [
      ['adapter', 'run', '--json'],
      ['adapter', 'evaluate', '--provider', 'sandbox-exec', '--json'],
      ['adapter', 'evaluate', '--command', 'ai', '--json'],
    ]) {
      const rejected = runCli(repository, args);
      assert.equal(rejected.status, 2);
      assert.equal(
        JSON.parse(rejected.stderr).error.code,
        'INVALID_AI_ADAPTER_USAGE',
      );
    }

    assert.equal(git(repository, ['status', '--porcelain=v1']), beforeStatus);
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('AI adapter config evaluation projects one external immutable host snapshot without launch or assignment', () => {
  const repository = createFixtureRepository();
  const hostDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-provider-config-host-'),
  );
  const markerPath = path.join(hostDirectory, 'provider-launched');
  const configPath = path.join(hostDirectory, 'agent-providers.toml');
  try {
    fs.chmodSync(hostDirectory, 0o700);
    fs.writeFileSync(configPath, hostProviderConfiguration(markerPath), {
      mode: 0o600,
    });
    const canonicalConfigPath = fs.realpathSync(configPath);
    const beforeStatus = git(repository, ['status', '--porcelain=v1']);
    const beforeHostEntries = fs.readdirSync(hostDirectory).sort();

    const evaluation = runCli(
      repository,
      ['adapter', 'evaluate', '--config', canonicalConfigPath, '--json'],
      { AGENT_PROVIDER_CONFIG_TEST_MARKER: markerPath },
    );
    assert.equal(evaluation.status, 0, evaluation.stderr);
    const output = JSON.parse(evaluation.stdout);
    assert.equal(output.result.action, 'evaluate');
    const report = output.result.providerConfiguration;
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.kind, 'agent-provider-config-evaluation');
    assert.equal(report.modelLaunched, false);
    assert.equal(report.assignmentSaved, false);
    assert.equal(report.platform, process.platform);
    assert.match(report.sourceDigest, /^[0-9a-f]{64}$/u);
    assert.match(report.configDigest, /^[0-9a-f]{64}$/u);
    assert.equal(report.globalRankingSource, 'explicit');
    assert.deepEqual(report.globalRanking, [
      'author-claude',
      'builder-codex',
      'reviewer-claude',
    ]);
    assert.deepEqual(report.rankings, {
      author: ['author-claude', 'builder-codex', 'reviewer-claude'],
      builder: ['builder-codex', 'author-claude', 'reviewer-claude'],
      reviewer: ['reviewer-claude', 'builder-codex', 'author-claude'],
    });
    assert.deepEqual(
      report.profiles.map(
        ({
          id,
          logicalProviderId,
          family,
          capabilities,
          trustTier,
          enabled,
        }: Record<string, unknown>) => ({
          id,
          logicalProviderId,
          family,
          capabilities,
          trustTier,
          enabled,
        }),
      ),
      [
        {
          id: 'author-claude',
          logicalProviderId: 'claude',
          family: 'claude',
          capabilities: [
            'fresh-session',
            'plan-review',
            'survey',
            'task-diff-review',
            'task-implementation',
          ],
          trustTier: 'host-wrapper',
          enabled: true,
        },
        {
          id: 'builder-codex',
          logicalProviderId: 'codex',
          family: 'codex',
          capabilities: [
            'fresh-session',
            'plan-review',
            'survey',
            'task-diff-review',
            'task-implementation',
          ],
          trustTier: 'host-wrapper',
          enabled: true,
        },
        {
          id: 'reviewer-claude',
          logicalProviderId: 'claude',
          family: 'claude',
          capabilities: [
            'fresh-session',
            'plan-review',
            'survey',
            'task-diff-review',
            'task-implementation',
          ],
          trustTier: 'host-wrapper',
          enabled: true,
        },
      ],
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(report.roleDryRuns).map(
          ([role, dryRun]: [string, any]) => [
            role,
            {
              modelLaunched: dryRun.modelLaunched,
              profileId: dryRun.selection.profileId,
              rank: dryRun.selection.rank,
              family: dryRun.definition.family,
              allowed: dryRun.dataAuthorization.allowed,
            },
          ],
        ),
      ),
      {
        author: {
          modelLaunched: false,
          profileId: 'author-claude',
          rank: 0,
          family: 'claude',
          allowed: false,
        },
        builder: {
          modelLaunched: false,
          profileId: 'builder-codex',
          rank: 0,
          family: 'codex',
          allowed: false,
        },
        reviewer: {
          modelLaunched: false,
          profileId: 'reviewer-claude',
          rank: 0,
          family: 'claude',
          allowed: false,
        },
      },
    );
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
    assert.equal(git(repository, ['status', '--porcelain=v1']), beforeStatus);
    assert.deepEqual(fs.readdirSync(hostDirectory).sort(), beforeHostEntries);

    const repositoryConfig = path.join(repository, 'agent-providers.toml');
    fs.writeFileSync(repositoryConfig, hostProviderConfiguration(markerPath), {
      mode: 0o600,
    });
    const gitCommonConfig = path.join(
      fs.realpathSync(
        path.resolve(
          repository,
          git(repository, ['rev-parse', '--git-common-dir']).trim(),
        ),
      ),
      'agent-providers.toml',
    );
    fs.writeFileSync(gitCommonConfig, hostProviderConfiguration(markerPath), {
      mode: 0o600,
    });

    for (const args of [
      ['adapter', 'evaluate', '--config'],
      ['adapter', 'evaluate', '--config', path.basename(configPath)],
      [
        'adapter',
        'evaluate',
        '--config',
        `${hostDirectory}${path.sep}nested${path.sep}..${path.sep}agent-providers.toml`,
      ],
      ['adapter', 'evaluate', '--config', fs.realpathSync(repositoryConfig)],
      ['adapter', 'evaluate', '--config', fs.realpathSync(gitCommonConfig)],
      [
        'adapter',
        'evaluate',
        '--config',
        canonicalConfigPath,
        '--config',
        canonicalConfigPath,
      ],
      [
        'adapter',
        'evaluate',
        '--config',
        canonicalConfigPath,
        '--profile',
        'builder-codex',
      ],
      [
        'adapter',
        'evaluate',
        '--config',
        canonicalConfigPath,
        '--command',
        'provider',
      ],
    ]) {
      const rejected = runCli(repository, [...args, '--json']);
      assert.notEqual(rejected.status, 0, JSON.stringify(args));
    }
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(hostDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
