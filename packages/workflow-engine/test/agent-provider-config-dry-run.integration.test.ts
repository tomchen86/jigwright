import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AgentProviderConfigError,
  type BuiltInReviewedProviderProfileSnapshot,
} from '@jigwright/agent-runtime';
import {
  createAgentRuntimeCapabilitiesV1,
  createAgentRuntimeProbeEvidenceV1,
} from '@jigwright/core/agent-runtime-port';

import { dryRunAgentProviderConfig } from '../src/composition-root/agent-provider-config-dry-run-production.ts';
import {
  createAgentProviderProfileProbeForTesting,
  probeAgentProviderProfile,
} from '../src/composition-root/agent-provider-probe-production.ts';
import {
  AgentProviderConfigFileError,
  assertAgentProviderConfigFileCurrent,
  loadAgentProviderConfigFile,
} from '../src/runtime/provider-execution/agent-provider-config-file.ts';
import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '../src/runtime/provider-execution/built-in-provider-definition.ts';
import { createFixtureRepository, sourceRepositoryRoot } from './fixture.ts';

const configuration = `
schema_version = 2
global_ranking = ["claude-local", "codex-local", "internal-wrapper"]

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

function writeProviderConfig(
  repository: string,
  document = configuration,
): string {
  const configPath = path.join(repository, 'agent-providers.toml');
  fs.writeFileSync(configPath, document, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return fs.realpathSync(configPath);
}

test('host config file loading seals one immutable snapshot and fails currentness closed', () => {
  const repository = createFixtureRepository();
  try {
    const configPath = writeProviderConfig(repository);
    const loaded = loadAgentProviderConfigFile(configPath, {
      platform: 'darwin',
    });

    assert.equal(loaded.sourcePath, configPath);
    assert.match(loaded.sourceDigest, /^[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.snapshot), true);
    assert.equal(Object.isFrozen(loaded.snapshot.providers), true);
    assert.equal(assertAgentProviderConfigFileCurrent(loaded), loaded.snapshot);
    assert.throws(
      () => assertAgentProviderConfigFileCurrent({ ...loaded }),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_STALE',
    );

    fs.writeFileSync(
      configPath,
      configuration.replace(
        'author = ["claude-local", "codex-local"]',
        'author = ["codex-local", "claude-local"]',
      ),
    );
    assert.throws(
      () => assertAgentProviderConfigFileCurrent(loaded),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_STALE',
    );

    const restoredPath = writeProviderConfig(repository);
    const identityBound = loadAgentProviderConfigFile(restoredPath, {
      platform: 'darwin',
    });
    const replacementPath = path.join(
      path.dirname(restoredPath),
      'agent-providers-replacement.toml',
    );
    fs.writeFileSync(replacementPath, configuration, { mode: 0o600 });
    fs.renameSync(replacementPath, restoredPath);
    assert.throws(
      () => assertAgentProviderConfigFileCurrent(identityBound),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_STALE',
      'same-byte atomic replacement must not retain exact file currentness',
    );

    writeProviderConfig(repository);
    const hardlinkPath = path.join(repository, 'agent-providers-hardlink.toml');
    fs.linkSync(configPath, hardlinkPath);
    assert.throws(
      () =>
        loadAgentProviderConfigFile(configPath, {
          platform: 'darwin',
        }),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_UNSAFE',
    );
    fs.unlinkSync(hardlinkPath);

    const symlinkPath = path.join(repository, 'agent-providers-link.toml');
    fs.symlinkSync(configPath, symlinkPath);
    assert.throws(
      () =>
        loadAgentProviderConfigFile(symlinkPath, {
          platform: 'darwin',
        }),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_UNSAFE',
    );

    fs.chmodSync(configPath, 0o666);
    assert.throws(
      () =>
        loadAgentProviderConfigFile(configPath, {
          platform: 'darwin',
        }),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_UNSAFE',
    );

    const invalidUtf8Path = path.join(repository, 'invalid-utf8.toml');
    fs.writeFileSync(invalidUtf8Path, Buffer.from([0xc3, 0x28]), {
      mode: 0o600,
    });
    assert.throws(
      () =>
        loadAgentProviderConfigFile(fs.realpathSync(invalidUtf8Path), {
          platform: 'darwin',
        }),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_UNSAFE',
    );

    const unsafeParent = path.join(repository, 'unsafe-config-directory');
    fs.mkdirSync(unsafeParent, { mode: 0o777 });
    fs.chmodSync(unsafeParent, 0o777);
    const unsafeParentConfig = path.join(unsafeParent, 'agent-providers.toml');
    fs.writeFileSync(unsafeParentConfig, configuration, { mode: 0o600 });
    assert.throws(
      () =>
        loadAgentProviderConfigFile(fs.realpathSync(unsafeParentConfig), {
          platform: 'darwin',
        }),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_UNSAFE',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('host config currentness preserves unavailable and unsafe hard failures', () => {
  const repository = createFixtureRepository();
  try {
    const configPath = writeProviderConfig(repository);
    const unavailable = loadAgentProviderConfigFile(configPath, {
      platform: 'darwin',
    });
    fs.unlinkSync(configPath);
    assert.throws(
      () => assertAgentProviderConfigFileCurrent(unavailable),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_UNAVAILABLE',
    );

    writeProviderConfig(repository);
    const unsafe = loadAgentProviderConfigFile(configPath, {
      platform: 'darwin',
    });
    fs.chmodSync(configPath, 0o666);
    assert.throws(
      () => assertAgentProviderConfigFileCurrent(unsafe),
      (error) =>
        error instanceof AgentProviderConfigFileError &&
        error.code === 'AGENT_PROVIDER_CONFIG_FILE_UNSAFE',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('built-in config dry-run consumes the production boundary and preserves code-owned argv', () => {
  const runtimeSource = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../src/runtime/provider-execution/agent-provider-config-dry-run.ts',
    ),
    'utf8',
  );

  assert.doesNotMatch(runtimeSource, /adapters\/providers\/claude/u);
  assert.doesNotMatch(runtimeSource, /adapters\/providers\/codex/u);
  assert.doesNotMatch(runtimeSource, /buildClaudeProviderInvocation/u);
  assert.doesNotMatch(runtimeSource, /buildCodexProviderInvocation/u);

  const productionSource = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../src/composition-root/agent-provider-config-dry-run-production.ts',
    ),
    'utf8',
  );
  assert.match(productionSource, /buildClaudeProviderInvocation/u);
  assert.match(productionSource, /buildCodexProviderInvocation/u);
  assert.match(productionSource, /loadAgentProviderConfigFile/u);
  assert.match(productionSource, /assertAgentProviderConfigFileCurrent/u);
  assert.doesNotMatch(productionSource, /document: string/u);

  const runnerSource = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../src/runtime/provider-execution/provider-runner.ts',
    ),
    'utf8',
  );
  assert.match(runnerSource, /inspectProviderExecutable/u);
  assert.doesNotMatch(runnerSource, /function inspectRealCandidate/u);

  const contractsSource = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../src/modules/provider-orchestration/provider-contracts.ts',
    ),
    'utf8',
  );
  assert.match(
    contractsSource,
    /@jigwright\/agent-runtime\/provider-executable-identity/u,
  );
  assert.doesNotMatch(
    contractsSource,
    /export type ProviderExecutableIdentity = \{/u,
  );

  const repository = createFixtureRepository();
  try {
    const configPath = writeProviderConfig(repository);
    const runtimeDirectory = path.join(repository, '.git', 'dry-run-runtime');
    const report = dryRunAgentProviderConfig(repository, configPath, {
      platform: 'darwin',
      selection: { role: 'builder' },
      runtimeDirectory,
      semanticOutputSchema: { type: 'object', additionalProperties: false },
    });

    assert.equal(report.modelLaunched, false);
    assert.equal(report.selection.profileId, 'codex-local');
    assert.equal(report.selection.rank, 0);
    assert.equal(report.selection.reason, 'role-ranking');
    assert.equal(report.definition.trustTier, 'built-in-reviewed');
    assert.equal(
      report.definition.definitionDigest,
      resolveBuiltInProviderDefinitionSnapshot('codex', 'darwin')!
        .definitionDigest,
    );
    assert.equal(report.command.shell, false);
    assert.equal(report.command.executable, '/opt/homebrew/bin/codex');
    assert.deepEqual(report.command.argv.hostOwned, []);
    assert.deepEqual(report.command.argv.codeOwned.slice(0, 4), [
      '-a',
      'never',
      '-s',
      'read-only',
    ]);
    assert.equal(report.dataAuthorization.allowed, true);
    assert.equal(
      report.dataAuthorization.policyDigest,
      loadAiAdapterPolicy(repository).digest,
    );
    assert.equal(report.authority.repositoryAuthority, 'none');
    assert.equal(report.authority.roleLaneConsequence, 'not-resolved');
    assert.equal(report.authority.grantConsequence, 'not-evaluated');
    assert.equal(fs.existsSync(runtimeDirectory), false);

    const claude = dryRunAgentProviderConfig(repository, configPath, {
      platform: 'darwin',
      selection: { profileId: 'claude-local' },
      runtimeDirectory,
      semanticOutputSchema: { type: 'object' },
    });
    assert.equal(claude.command.argv.codeOwned.includes('--safe-mode'), true);
    assert.deepEqual(claude.command.argv.hostOwned, []);

    for (const invalid of [
      configuration.replace(
        '/opt/homebrew/bin/claude',
        '/tmp/unreviewed/claude',
      ),
      configuration.replace(
        'protocol = "claude-stream-json-v1"',
        'protocol = "caller-selected-v1"',
      ),
    ]) {
      writeProviderConfig(repository, invalid);
      assert.throws(
        () =>
          dryRunAgentProviderConfig(repository, configPath, {
            platform: 'darwin',
            selection: { profileId: 'claude-local' },
            runtimeDirectory,
            semanticOutputSchema: { type: 'object' },
          }),
        AgentProviderConfigError,
      );
    }

    writeProviderConfig(repository);

    const policyPath = path.join(
      repository,
      'workflow',
      'ai-adapter-policy.json',
    );
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      providers: { codex: { enabled: boolean } };
    };
    policy.providers.codex.enabled = false;
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    const denied = dryRunAgentProviderConfig(repository, configPath, {
      platform: 'darwin',
      selection: { role: 'builder' },
      runtimeDirectory,
      semanticOutputSchema: { type: 'object' },
    });
    assert.equal(denied.dataAuthorization.allowed, false);
    assert.equal(
      denied.dataAuthorization.reason,
      'REPOSITORY_PROVIDER_DISABLED',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('host-wrapper dry-run remains lower-trust, non-authoritative, and policy denied', () => {
  const repository = createFixtureRepository();
  try {
    const configPath = writeProviderConfig(repository);
    const runtimeDirectory = path.join(repository, '.git', 'dry-run-runtime');
    const report = dryRunAgentProviderConfig(repository, configPath, {
      platform: 'darwin',
      selection: { profileId: 'internal-wrapper' },
      runtimeDirectory,
      semanticOutputSchema: { type: 'object' },
    });

    assert.equal(report.modelLaunched, false);
    assert.equal(report.definition.trustTier, 'host-wrapper');
    assert.equal(report.definition.assuranceEligibility, 'custom-wrapper');
    assert.equal(report.dataAuthorization.allowed, false);
    assert.equal(
      report.dataAuthorization.reason,
      'HOST_WRAPPER_NOT_AUTHORIZED_BY_POLICY_V4',
    );
    assert.equal(report.authority.repositoryAuthority, 'none');
    assert.deepEqual(report.command.argv.codeOwned, []);
    assert.deepEqual(report.command.argv.hostOwned, [
      'run',
      '--request',
      path.join(runtimeDirectory, 'request.json'),
    ]);
    assert.equal(report.command.cwd, runtimeDirectory);
    assert.equal(
      report.command.stdinSource,
      path.join(runtimeDirectory, 'prompt.json'),
    );
    assert.equal(fs.existsSync(runtimeDirectory), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('profile probe admits only exact host-observed built-in evidence and detects definition drift', async () => {
  const repository = createFixtureRepository();
  const hostDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-provider-probe-config-'),
  );
  try {
    const configPath = writeExternalProviderConfig(hostDirectory);
    const goodProbe = createAgentProviderProfileProbeForTesting({
      probeBuiltIn(profile) {
        return builtInProbeEvidence(profile, 'host-observed');
      },
      probeHostWrapper() {
        assert.fail('built-in profile must not use host-wrapper effects');
      },
    });
    const report = await goodProbe(
      repository,
      configPath,
      'codex-local',
      'probe',
      'darwin',
    );
    assert.equal(report.evidence.status, 'ready');
    assert.equal(report.evidence.observationClass, 'host-observed');
    assert.equal(report.profileId, 'codex-local');
    assert.equal(
      report.evidence.definition.definitionDigest,
      resolveBuiltInProviderDefinitionSnapshot('codex', 'darwin')!
        .definitionDigest,
    );
    assert.equal(report.modelLaunched, false);
    assert.equal(report.empiricalAvailabilityAccepted, false);
    assert.equal(
      report.availabilityDecisionAuthority,
      'provider-availability-pilot.v1',
    );

    const wrongDefinitionProbe = createAgentProviderProfileProbeForTesting({
      probeBuiltIn(profile) {
        const wrong = {
          ...profile,
          family: 'claude',
          protocol: 'claude-stream-json-v1',
        } as BuiltInReviewedProviderProfileSnapshot;
        return builtInProbeEvidence(wrong, 'host-observed');
      },
      probeHostWrapper() {
        assert.fail('built-in profile must not use host-wrapper effects');
      },
    });
    await assert.rejects(
      () =>
        wrongDefinitionProbe(
          repository,
          configPath,
          'codex-local',
          'probe',
          'darwin',
        ),
      (error: unknown) =>
        isErrorCode(error, 'AGENT_PROVIDER_PROBE_DEFINITION_STALE'),
    );
  } finally {
    fs.rmSync(hostDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('profile probe rejects synthetic evidence and policy drift after the host effect', async () => {
  const syntheticRepository = createFixtureRepository();
  const policyDriftRepository = createFixtureRepository();
  const hostDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-provider-probe-admission-'),
  );
  try {
    const configPath = writeExternalProviderConfig(hostDirectory);
    const syntheticProbe = createAgentProviderProfileProbeForTesting({
      probeBuiltIn(profile) {
        return builtInProbeEvidence(profile, 'synthetic-fixture');
      },
      probeHostWrapper() {
        assert.fail('built-in profile must not use host-wrapper effects');
      },
    });
    await assert.rejects(
      () =>
        syntheticProbe(
          syntheticRepository,
          configPath,
          'codex-local',
          'probe',
          'darwin',
        ),
      (error: unknown) =>
        isErrorCode(error, 'AGENT_PROVIDER_PROBE_EVIDENCE_INVALID'),
    );

    const policyDriftProbe = createAgentProviderProfileProbeForTesting({
      probeBuiltIn(profile) {
        const policyPath = path.join(
          policyDriftRepository,
          'workflow',
          'ai-adapter-policy.json',
        );
        const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
          providers: { codex: { enabled: boolean } };
        };
        policy.providers.codex.enabled = !policy.providers.codex.enabled;
        fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
        return builtInProbeEvidence(profile, 'host-observed');
      },
      probeHostWrapper() {
        assert.fail('built-in profile must not use host-wrapper effects');
      },
    });
    await assert.rejects(
      () =>
        policyDriftProbe(
          policyDriftRepository,
          configPath,
          'codex-local',
          'probe',
          'darwin',
        ),
      (error: unknown) =>
        isErrorCode(error, 'AGENT_PROVIDER_PROBE_POLICY_STALE'),
    );
  } finally {
    fs.rmSync(hostDirectory, { recursive: true, force: true });
    fs.rmSync(syntheticRepository, { recursive: true, force: true });
    fs.rmSync(policyDriftRepository, { recursive: true, force: true });
  }
});

test('jigwright agent provider probe and test execute the exact host-wrapper profile without availability authority', async () => {
  const repository = createFixtureRepository();
  const hostDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-provider-wrapper-config-'),
  );
  try {
    const configPath = writeHostWrapperConfig(hostDirectory);
    const overridePlatform = process.platform === 'darwin' ? 'linux' : 'darwin';
    const overrideReport = await probeAgentProviderProfile(
      repository,
      configPath,
      'wrapper-local',
      'probe',
      overridePlatform,
    );
    assert.equal(overrideReport.evidence.status, 'ready');
    assert.equal(
      overrideReport.evidence.definition.definitionDigest,
      overrideReport.profileDigest,
    );
    for (const args of [
      ['agent', 'provider', 'probe', 'wrapper-local', '--config', configPath],
      [
        'agent',
        'provider',
        'test',
        'wrapper-local',
        '--config',
        configPath,
        '--live',
      ],
    ]) {
      const result = runCli(repository, [...args, '--json']);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout).result;
      assert.equal(report.evidence.status, 'ready');
      assert.equal(report.evidence.observationClass, 'host-observed');
      assert.equal(report.evidence.providerVersion, 'fixture-wrapper-v1');
      assert.equal(report.modelLaunched, false);
      assert.equal(report.empiricalAvailabilityAccepted, false);
      assert.equal(
        report.availabilityDecisionAuthority,
        'provider-availability-pilot.v1',
      );
      assert.equal(
        report.executableCandidate,
        fs.realpathSync(process.execPath),
      );
    }
  } finally {
    fs.rmSync(hostDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function writeHostWrapperConfig(hostDirectory: string): string {
  const executable = fs.realpathSync(process.execPath);
  const fixture = path.join(
    sourceRepositoryRoot,
    'packages/agent-runtime/test/fixtures/provider-wrapper-fixture.mjs',
  );
  return writeExternalProviderConfig(
    hostDirectory,
    `
schema_version = 2
global_ranking = ["wrapper-local"]

[[providers]]
id = "wrapper-local"
family = "codex"
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = ${JSON.stringify(executable)}
start_args = [${JSON.stringify(fixture)}, "host-start", "{request_file}"]
resume_args = [${JSON.stringify(fixture)}, "host-resume", "{native_session_id}", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"

[provider_preferences]
author = ["wrapper-local"]
builder = ["wrapper-local"]
reviewer = ["wrapper-local"]
`,
  );
}

function writeExternalProviderConfig(
  hostDirectory: string,
  document = configuration,
): string {
  const configPath = path.join(hostDirectory, 'agent-providers.toml');
  fs.writeFileSync(configPath, document, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return fs.realpathSync(configPath);
}

function builtInProbeEvidence(
  profile: BuiltInReviewedProviderProfileSnapshot,
  observationClass: 'host-observed' | 'synthetic-fixture',
) {
  const definition = resolveBuiltInProviderDefinitionSnapshot(
    profile.family as 'codex' | 'claude',
    'darwin',
  )!;
  const capabilities = createAgentRuntimeCapabilitiesV1({
    structuredStreaming: true,
    structuredOutput: true,
    resumableAfterTurn: false,
    forkable: false,
    reattachableInFlight: false,
    cancellationAck: true,
    usageReporting: 'none',
  });
  return createAgentRuntimeProbeEvidenceV1({
    authority: 'observation-only',
    observationClass,
    definition: {
      schemaVersion: 1,
      kind: 'built-in-provider-definition.v1',
      providerFamily: profile.family,
      protocol: definition.protocol,
      definitionDigest: definition.definitionDigest,
    },
    status: 'ready',
    executableIdentity: {
      candidatePath: profile.executable,
      realPath: profile.executable,
      device: '1',
      inode: '2',
      mode: 0o100755,
      uid: 501,
      gid: 20,
      size: 1_024,
      mtimeNs: '1',
      sha256: 'a'.repeat(64),
    },
    providerVersion: 'fixture-v1',
    authentication:
      observationClass === 'host-observed' ? 'authenticated' : 'not-observed',
    capabilities,
  });
}

function runCli(repository: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
      ...args,
    ],
    { cwd: repository, encoding: 'utf8', env: process.env },
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === code
  );
}
