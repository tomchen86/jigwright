import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapInterventionStateRoot } from '../bootstrap/control-plane-trust.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  type ProtectedCapabilityEntry,
  REQUIRED_PROTECTED_CAPABILITIES,
} from '../src/modules/authority/intervention-control.ts';
import {
  recoveryAuthorityDescriptorDigest,
  type RecoveryAuthorityDescriptorPayloadV1,
  type RecoveryAuthorityDescriptorV1,
  type RecoveryAuthorityExpectations,
  recoveryAuthorityRepositoryIdentityDigest,
} from '../src/modules/authority/recovery-authority-contract.ts';
import {
  createRecoveryQuarantineEnterGrantPayload,
  createRecoveryQuarantineReleaseGrantPayload,
  RECOVERY_QUARANTINE_ENTER_NAMESPACE,
  RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
  type RecoveryQuarantineAuditRecord,
  type RecoveryQuarantineEnvelope,
  type RecoveryQuarantineGrantPayload,
} from '../src/modules/authority/recovery-quarantine-contract.ts';
import {
  executeRecoveryQuarantineEnter,
  executeRecoveryQuarantineRelease,
} from '../src/runtime/recovery/recovery-quarantine.ts';
import { loadProtectedCapabilitiesFromTrustBase } from '../src/runtime/repository-validation/protected-capabilities.ts';
import {
  digest,
  writeJsonRecord,
} from './control-plane-supervisor-selection-fixture.ts';
import {
  FIXED_RUNNER_FIXTURE_REPOSITORY_ID,
  setupFixedRunnerFixture,
} from './fixed-runner-fixture.ts';
import { createFixtureRepository, git } from './fixture.ts';
import {
  BOOTSTRAP_RUNTIME_NAMES,
  sealFixtureWorkflowHost,
} from './support/bootstrap-runtime-fixture.ts';

const SOURCE_ENGINE_ROOT = path.resolve(import.meta.dirname, '..');

const FIXTURE_ORIGIN = 'https://github.com/example/fixture.git';

const RECOVERY_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns';

const RECOVERY_FINGERPRINT =
  'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U';

const FIXTURE_GRANT_PACKAGE_PATH = 'packages/grants/package.json';

const FIXTURE_ROLE_CONTEXT_SHARING_SOURCE =
  'packages/grants/src/role-context-sharing-degradation.ts';

const FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH =
  'src/runtime/repository-validation/protected-capabilities.ts';

test('protected manifest loader accepts and binds an optional sealed Grant verifier composition', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(
    engineRoot,
    'github:R_bootstrap_grant_composition_fixture',
  );

  try {
    const manifest = installFixtureGrantVerifierComposition(repository);
    const expectedManifestDigest = digest(canonicalJson(manifest));
    const {
      grantVerifierComposition: _grantVerifierComposition,
      ...historicalPayload
    } = manifest;
    assert.notEqual(
      expectedManifestDigest,
      digest(canonicalJson(historicalPayload)),
    );

    const verified = loadProtectedCapabilitiesFromTrustBase(repository, 'HEAD');
    assert.equal(verified.manifestDigest, expectedManifestDigest);
    assert.equal(manifest.grantVerifierComposition.packageVersion, '0.1.0');
    assert.equal(
      manifest.grantVerifierComposition.verifierImplementation,
      'ssh-maintainer-policy.v1',
    );
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected manifest loader keeps a historical manifest without a Grant verifier composition readable', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(
    engineRoot,
    'github:R_bootstrap_historical_manifest_fixture',
  );

  try {
    const verified = loadProtectedCapabilitiesFromTrustBase(repository, 'HEAD');
    assert.equal(verified.grantVerifierComposition, undefined);
    assert.equal(fs.existsSync(supervisorPath(repository)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected manifest loader rejects a partial Grant verifier composition candidate', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(
    engineRoot,
    'github:R_bootstrap_partial_grant_composition_fixture',
  );

  try {
    installFixtureGrantVerifierComposition(repository, (composition) => {
      delete composition.packageVersion;
    });
    assert.throws(() =>
      loadProtectedCapabilitiesFromTrustBase(repository, 'HEAD'),
    );
    assert.equal(fs.existsSync(supervisorPath(repository)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected manifest loader rejects unknown Grant verifier composition keys', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(
    engineRoot,
    'github:R_bootstrap_unknown_grant_composition_fixture',
  );

  try {
    installFixtureGrantVerifierComposition(repository, (composition) => {
      composition.unreviewedFallback = true;
    });
    assert.throws(() =>
      loadProtectedCapabilitiesFromTrustBase(repository, 'HEAD'),
    );
    assert.equal(fs.existsSync(supervisorPath(repository)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected manifest loader requires an exact role-context-sharing verifier binding when the Grant verifier composition is present', () => {
  for (const variant of ['exact', 'omitted', 'partial', 'unknown'] as const) {
    const engineRoot = createSealedEnginePackage();
    const repository = createRepository(
      engineRoot,
      `github:R_bootstrap_role_context_${variant}_fixture`,
    );
    try {
      installFixtureGrantVerifierComposition(
        repository,
        (composition) => {
          if (variant === 'exact') return;
          if (variant === 'omitted') {
            delete composition.roleContextSharingGrant;
            return;
          }
          const binding = composition.roleContextSharingGrant as Record<
            string,
            unknown
          >;
          if (variant === 'partial') delete binding.policyDigest;
          else binding.unreviewedFallback = true;
        },
        true,
      );
      if (variant === 'exact') {
        assert.ok(
          loadProtectedCapabilitiesFromTrustBase(repository, 'HEAD')
            .grantVerifierComposition,
        );
      } else {
        assert.throws(() =>
          loadProtectedCapabilitiesFromTrustBase(repository, 'HEAD'),
        );
      }
    } finally {
      fs.rmSync(engineRoot, { recursive: true, force: true });
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('ordinary package launch leaves global selection residue unconsumed without a supervisor', () => {
  const engineRoot = createSealedEnginePackage();
  const globalResidues = [
    'control-plane-approval-candidates',
    'control-updates',
    'operations',
  ];
  const repositories = [...globalResidues, 'unknown-root-entry'].map(
    (name) => ({
      name,
      repository: createRepository(engineRoot, `github:R_residue_${name}`),
    }),
  );
  const local = createRepository(engineRoot, 'github:R_local_only_residue');

  try {
    for (const { name, repository } of repositories) {
      const root = stateRoot(repository);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (name === 'unknown-root-entry') {
        fs.writeFileSync(path.join(root, 'unknown.json'), '{}\n', {
          mode: 0o600,
        });
      } else {
        const directory = path.join(root, name);
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.writeFileSync(path.join(directory, 'persisted.json'), '{}\n', {
          mode: 0o600,
        });
      }
      const result = runLauncher(engineRoot, repository, ['fixture-command']);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }

    const localRoot = stateRoot(local);
    for (const name of [
      'checkpoints',
      'interventions',
      'sidecar-sessions',
      'adoptions',
      'local-parent-sessions',
      'local-engine-artifacts',
    ]) {
      fs.mkdirSync(path.join(localRoot, name), {
        recursive: true,
        mode: 0o700,
      });
    }
    const localResult = runLauncher(engineRoot, local, ['fixture-command']);
    assert.equal(localResult.status, 0, localResult.stderr);
    assert.equal(fs.existsSync(supervisorPath(local)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    for (const { repository } of repositories) {
      fs.rmSync(repository, { recursive: true, force: true });
    }
    fs.rmSync(local, { recursive: true, force: true });
  }
});

test('ordinary package launch does not select a forged generation-one supervisor', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(
    engineRoot,
    'github:R_forged_generation_one',
  );

  try {
    const closureDigest = digest('forged-generation-one-closure');
    const source = forgedSupervisorSource(closureDigest);
    const artifact = {
      artifactId: digest('forged-artifact'),
      executableDigest: digest(source),
    };
    const root = stateRoot(repository);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    writeJsonRecord(supervisorPath(repository), {
      kind: 'control-plane-supervisor-state.v1',
      generation: 1,
      activeArtifact: {
        artifactId: artifact.artifactId,
        executableDigest: artifact.executableDigest,
        closureDigest,
      },
    });

    const result = runLauncher(engineRoot, repository, ['fixture-command']);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary package launch ignores inert V1 records and never executes their probe-capable artifact', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'inert-v1-selection-'));
  const marker = path.join(scratch, 'executed');
  const value = setupFixedRunnerFixture({
    candidateExecutableFactory: () =>
      Buffer.from(`#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');
`),
  });
  try {
    const positiveControl = spawnSync(
      process.execPath,
      [
        value.retiredSelection.activeArtifact.executablePath,
        '--control-plane-restart-probe',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(positiveControl.status, 0, positiveControl.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'executed');
    fs.unlinkSync(marker);
    const supervisor = path.join(
      value.stateRoot,
      'control-plane-supervisor.json',
    );
    const historicalBytes = Buffer.from(
      JSON.stringify({
        ...value.retiredSelection,
        kind: 'control-plane-supervisor-state.v1',
      }) + '\n',
    );
    fs.writeFileSync(supervisor, historicalBytes);
    const head = git(value.repository, ['rev-parse', 'HEAD']);
    const result = runLauncher(value.engineRoot, value.repository, [
      'fixture-command',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture built-in engine/);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(fs.readFileSync(supervisor), historicalBytes);
    assert.equal(git(value.repository, ['rev-parse', 'HEAD']), head);
  } finally {
    value.cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('active Recovery Quarantine fences package and inert retired engine state before any probe', async () => {
  const engineRoot = createSealedEnginePackage();
  const builtInRepository = createRepository(
    engineRoot,
    'github:R_recovery_quarantine_builtin_fixture',
  );
  const promoted = await setupFixedRunnerFixture();
  let builtInQuarantine: ReturnType<
    typeof installActiveRecoveryQuarantineMarker
  > | null = null;
  let promotedQuarantine: ReturnType<
    typeof installActiveRecoveryQuarantineMarker
  > | null = null;

  try {
    builtInQuarantine = installActiveRecoveryQuarantineMarker(
      builtInRepository,
      'github:R_recovery_quarantine_builtin_fixture',
    );
    for (const argv of [
      ['fixture-command'],
      ['--help'],
      ['status', 'fixture-session', '--json'],
      ['intervention', 'status', 'fixture-intervention', '--json'],
      ['control-plane', 'initialize', '--json'],
      ['control-plane', 'rollback'],
      ['control-plane', 'rollback', '-not-an-id'],
      ['control-plane', 'rollback', 'fixture-source-grant', '--json', 'extra'],
      [
        'recovery-authority',
        'status',
        '--expectations',
        '/tmp/fixture-recovery-expectations.json',
      ],
      [
        'recovery-quarantine',
        'enter',
        '/tmp/fixture-recovery-enter.json',
        '--expectations',
        '/tmp/fixture-recovery-expectations.json',
      ],
    ]) {
      const blocked = runLauncher(engineRoot, builtInRepository, argv);
      assert.notEqual(blocked.status, 0, argv.join(' '));
      assert.match(blocked.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
      assert.doesNotMatch(blocked.stdout, /fixture-built-in-engine/);
    }

    const sealedRecovery = runLauncher(engineRoot, builtInRepository, [
      'control-plane',
      'rollback',
      'fixture-source-grant',
      '--json',
    ]);
    assert.notEqual(sealedRecovery.status, 0);
    assert.match(sealedRecovery.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    assert.doesNotMatch(sealedRecovery.stdout, /fixture-built-in-engine/);

    const sealedRelease = runLauncher(engineRoot, builtInRepository, [
      'recovery-quarantine',
      'release',
      '/tmp/fixture-recovery-release.json',
      '--expectations',
      '/tmp/fixture-recovery-expectations.json',
      '--json',
    ]);
    assert.notEqual(sealedRelease.status, 0);
    assert.doesNotMatch(sealedRelease.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    assert.doesNotMatch(sealedRelease.stdout, /fixture-built-in-engine/);

    builtInQuarantine.release();
    const released = runLauncher(engineRoot, builtInRepository, [
      'fixture-command',
    ]);
    assert.equal(released.status, 0, released.stderr);
    assert.match(released.stdout, /fixture-built-in-engine/);

    promotedQuarantine = installActiveRecoveryQuarantineMarker(
      promoted.repository,
      FIXED_RUNNER_FIXTURE_REPOSITORY_ID,
    );
    const promotedProbe = runLauncher(SOURCE_ENGINE_ROOT, promoted.repository, [
      '--control-plane-self-test',
    ]);
    assert.notEqual(promotedProbe.status, 0);
    assert.match(promotedProbe.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    assert.doesNotMatch(promotedProbe.stdout, /control-plane-self-test/);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(builtInRepository, { recursive: true, force: true });
    builtInQuarantine?.cleanup();
    promotedQuarantine?.cleanup();
    promoted.cleanup();
  }
});

test('Recovery Quarantine canonical inventory rejects tamper and ignores noncanonical markers', () => {
  const engineRoot = createSealedEnginePackage();
  const repositories: string[] = [];
  const quarantines: Array<
    ReturnType<typeof installActiveRecoveryQuarantineMarker>
  > = [];
  const fixture = (suffix: string) => {
    const repositoryId = `github:R_recovery_quarantine_${suffix}`;
    const repository = createRepository(engineRoot, repositoryId);
    repositories.push(repository);
    const quarantine = installActiveRecoveryQuarantineMarker(
      repository,
      repositoryId,
    );
    quarantines.push(quarantine);
    return { repository, quarantine };
  };
  const assertCorrupt = (repository: string) => {
    const result = runLauncher(engineRoot, repository, ['fixture-command']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WORKFLOW_RECOVERY_QUARANTINE_STATE_CORRUPT/);
    assert.doesNotMatch(result.stdout, /fixture-built-in-engine/);
  };

  try {
    const tampered = fixture('tampered');
    const marker = JSON.parse(
      fs.readFileSync(tampered.quarantine.markerPath, 'utf8'),
    ) as Record<string, unknown>;
    marker.enteredAt = '2026-08-10T12:00:02.000Z';
    writeJsonRecord(tampered.quarantine.markerPath, marker);
    assertCorrupt(tampered.repository);

    const unknown = fixture('unknown');
    fs.writeFileSync(
      path.join(
        recoveryAuthorityStateRoot(unknown.repository),
        'operator-note',
      ),
      'unknown\n',
      { mode: 0o600 },
    );
    assertCorrupt(unknown.repository);

    const residue = fixture('residue');
    fs.writeFileSync(
      path.join(
        recoveryAuthorityStateRoot(residue.repository),
        'recovery-quarantine',
        `.active-marker.json.${'0'.repeat(64)}.${crypto.randomUUID()}.tmp`,
      ),
      '{}\n',
      { mode: 0o600 },
    );
    assertCorrupt(residue.repository);

    const hardLinked = fixture('hardlink');
    fs.linkSync(
      hardLinked.quarantine.markerPath,
      path.join(hardLinked.repository, 'marker-alias.json'),
    );
    assertCorrupt(hardLinked.repository);

    const symlinked = fixture('symlink');
    const canonical = recoveryAuthorityStateRoot(symlinked.repository);
    const target = `${canonical}-target`;
    fs.renameSync(canonical, target);
    fs.symlinkSync(target, canonical);
    assertCorrupt(symlinked.repository);

    const outside = fixture('outside');
    const outsideCanonical = recoveryAuthorityStateRoot(outside.repository);
    fs.renameSync(outsideCanonical, `${outsideCanonical}-shadow`);
    const allowed = runLauncher(engineRoot, outside.repository, [
      'fixture-command',
    ]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /fixture-built-in-engine/);
  } finally {
    for (const quarantine of quarantines) quarantine.cleanup();
    for (const repository of repositories) {
      fs.rmSync(repository, { recursive: true, force: true });
    }
    fs.rmSync(engineRoot, { recursive: true, force: true });
  }
});

test('ordinary package launch does not select an engine from origin history', () => {
  const engineRoot = createSealedEnginePackage();
  const advanced = createRepository(engineRoot, 'github:R_remote_advanced');
  const rewritten = createRepository(engineRoot, 'github:R_remote_rewritten');

  try {
    fs.writeFileSync(
      path.join(advanced, 'after-bootstrap.txt'),
      'descendant\n',
    );
    git(advanced, ['add', 'after-bootstrap.txt']);
    git(advanced, ['commit', '-m', 'Advance trusted origin base']);
    git(advanced, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const allowed = runLauncher(engineRoot, advanced, ['fixture-command']);
    assert.equal(allowed.status, 0, allowed.stderr);

    git(rewritten, ['update-ref', 'refs/remotes/origin/main', 'HEAD^']);
    const rejected = runLauncher(engineRoot, rewritten, ['fixture-command']);
    assert.equal(rejected.status, 0, rejected.stderr);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(advanced, { recursive: true, force: true });
    fs.rmSync(rewritten, { recursive: true, force: true });
  }
});

function createSealedEnginePackage(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'control-plane-initial-supervisor-engine-'),
  );
  const bootstrap = path.join(root, 'bootstrap');
  const source = path.join(root, 'src/entrypoints/cli');
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  for (const name of [
    ...BOOTSTRAP_RUNTIME_NAMES.filter(
      (name) => name !== 'built-in-engine-closure-pin.ts',
    ),
    'workflow-launcher.ts',
  ]) {
    fs.copyFileSync(
      path.join(SOURCE_ENGINE_ROOT, 'bootstrap', name),
      path.join(bootstrap, name),
    );
  }
  for (const name of [
    'harness-bootstrap-dependency-closure.json',
    'harness-bootstrap-launcher.ts',
    'harness-bootstrap-runtime-closure-pin.ts',
  ]) {
    fs.copyFileSync(
      path.join(SOURCE_ENGINE_ROOT, 'bootstrap', name),
      path.join(bootstrap, name),
    );
  }
  fs.cpSync(
    path.join(SOURCE_ENGINE_ROOT, 'bootstrap', 'recovery-runtime'),
    path.join(bootstrap, 'recovery-runtime'),
    { recursive: true },
  );
  const packageBytes = `${JSON.stringify(
    { name: 'jigwright', private: true, type: 'module' },
    null,
    2,
  )}\n`;
  const entrypointBytes = [
    "import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../../../bootstrap/built-in-engine-closure-pin.ts';",
    "import { bootstrapInterventionStateRoot } from '../../../bootstrap/control-plane-trust.ts';",
    'void BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST;',
    'void bootstrapInterventionStateRoot;',
    'const argv = process.argv.slice(2);',
    "process.stdout.write(`${JSON.stringify({ kind: 'fixture-built-in-engine', argv })}\\n`);",
    '',
  ].join('\n');
  const protectedLoaderBytes =
    "export const fixtureProtectedCapabilitiesLoader = 'v1';\n";
  fs.writeFileSync(path.join(root, 'package.json'), packageBytes, {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(source, 'workflow-cli.ts'), entrypointBytes, {
    mode: 0o644,
  });
  const protectedLoaderPath = path.join(
    root,
    FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH,
  );
  fs.mkdirSync(path.dirname(protectedLoaderPath), { recursive: true });
  fs.writeFileSync(protectedLoaderPath, protectedLoaderBytes, { mode: 0o644 });
  const manifest = {
    kind: 'built-in-engine-closure-manifest.v2',
    entrypoint: 'src/entrypoints/cli/workflow-cli.ts',
    scope: 'workspace-runtime-source-closure',
    packages: [
      {
        name: 'jigwright',
        sourceRoot: 'packages/workflow-engine',
        closureRoot: '.',
      },
    ],
    files: [
      {
        path: 'package.json',
        mode: '100644',
        digest: digest(packageBytes),
      },
      {
        path: 'src/entrypoints/cli/workflow-cli.ts',
        mode: '100644',
        digest: digest(entrypointBytes),
      },
      {
        path: FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH,
        mode: '100644',
        digest: digest(protectedLoaderBytes),
      },
    ],
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(
    path.join(bootstrap, 'built-in-engine-closure.json'),
    manifestBytes,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(bootstrap, 'built-in-engine-closure-pin.ts'),
    [
      'export const BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST =',
      `  '${digest(manifestBytes)}' as const;`,
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  sealFixtureWorkflowHost(root);
  return root;
}

function createRepository(engineRoot: string, repositoryId: string): string {
  const repository = createFixtureRepository();
  installRepositoryIdentity(repository, repositoryId, engineRoot);
  return repository;
}

function installRepositoryIdentity(
  repository: string,
  repositoryId: string,
  engineRoot?: string,
): void {
  const remotes = git(repository, ['remote']).split('\n').filter(Boolean);
  git(repository, [
    'remote',
    remotes.includes('origin') ? 'set-url' : 'add',
    'origin',
    FIXTURE_ORIGIN,
  ]);
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: { id: repositoryId, origin: FIXTURE_ORIGIN },
      },
      null,
      2,
    )}\n`,
  );
  if (engineRoot !== undefined) {
    fs.cpSync(engineRoot, repositoryEngineRoot(repository), {
      recursive: true,
    });
  }
  writeFixtureProtectedManifest(repository);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', `Set repository identity ${repositoryId}`]);
  if (engineRoot !== undefined) {
    git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }
}

function writeFixtureProtectedManifest(repository: string): void {
  const manifest = createFixtureProtectedManifest(repository);
  const { manifestDigest: _manifestDigest, ...manifestPayload } = manifest;
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(manifestPayload, null, 2)}\n`,
  );
}

function forgedSupervisorSource(closureDigest: string): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--control-plane-restart-probe') {
  process.stdout.write(JSON.stringify({kind:'control-plane-restart.v1',ready:true,closureDigest:${JSON.stringify(closureDigest)}}) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({kind:'forged-generation-one'}) + '\\n');
process.exit(0);
`;
}

function createFixtureProtectedManifest(
  repository: string,
  extraAuthorizationDependencies: readonly string[] = [],
): ReturnType<typeof createProtectedCapabilityManifest> {
  const entries: ProtectedCapabilityEntry[] =
    REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
      const entrypoints = [`protected/${capability}/entry.ts`];
      const dependencies = [
        ...new Set([
          `protected/${capability}/dependency.ts`,
          ...(capability === 'adoption.journal'
            ? ['workflow/protected-capabilities.json']
            : []),
          ...(capability === 'authorization.verify'
            ? extraAuthorizationDependencies
            : []),
          ...(capability === 'policy.classify'
            ? [
                'packages/workflow-engine/src/runtime/repository-validation/protected-capabilities.ts',
              ]
            : []),
          ...(capability === 'control-plane.update'
            ? BOOTSTRAP_RUNTIME_NAMES.map(
                (name) => `packages/workflow-engine/bootstrap/${name}`,
              )
            : []),
        ]),
      ].sort();
      for (const filePath of [...entrypoints, ...dependencies]) {
        if (filePath === 'workflow/protected-capabilities.json') continue;
        const absolute = path.join(repository, filePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        if (!fs.existsSync(absolute)) {
          fs.writeFileSync(absolute, `fixture protected file: ${filePath}\n`);
        }
      }
      const identities = [...new Set([...entrypoints, ...dependencies])]
        .map((filePath) =>
          filePath === 'workflow/protected-capabilities.json'
            ? {
                path: filePath,
                mode: 'manifest-self',
                objectId: 'manifest-self',
              }
            : {
                path: filePath,
                mode: '100644',
                objectId: git(repository, ['hash-object', filePath]).trim(),
              },
        )
        .sort((left, right) => left.path.localeCompare(right.path));
      const contentDigest = digest(
        canonicalJson({
          kind: 'protected-capability-content.v1',
          files: identities,
        }),
      );
      return {
        capability,
        entrypoints,
        dependencies,
        contentDigest,
        closureDigest: protectedCapabilityClosureDigest(
          entrypoints,
          dependencies,
          contentDigest,
        ),
      };
    });
  return createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries,
  });
}

function installFixtureGrantVerifierComposition(
  repository: string,
  mutate?: (composition: Record<string, unknown>) => void,
  includeRoleContextSharing = true,
) {
  const packageBytes = `${JSON.stringify(
    {
      name: '@jigwright/grants',
      version: '0.1.0',
      private: true,
      type: 'module',
      ...(includeRoleContextSharing
        ? {
            exports: {
              './collaboration-grant-envelope-reader':
                './src/collaboration-grant-envelope-reader.ts',
              './grant-envelope-verifier': './src/grant-envelope-verifier.ts',
              './grant-lifecycle': './src/grant-lifecycle.ts',
              './role-context-sharing-degradation':
                './src/role-context-sharing-degradation.ts',
            },
          }
        : {}),
    },
    null,
    2,
  )}\n`;
  const packagePath = path.join(repository, FIXTURE_GRANT_PACKAGE_PATH);
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  fs.writeFileSync(packagePath, packageBytes);
  const roleSourceBytes = 'export const roleContextSharing = true;\n';
  if (includeRoleContextSharing) {
    const roleSourcePath = path.join(
      repository,
      FIXTURE_ROLE_CONTEXT_SHARING_SOURCE,
    );
    fs.mkdirSync(path.dirname(roleSourcePath), { recursive: true });
    fs.writeFileSync(roleSourcePath, roleSourceBytes);
  }

  const manifest = createFixtureProtectedManifest(repository, [
    FIXTURE_GRANT_PACKAGE_PATH,
    ...(includeRoleContextSharing ? [FIXTURE_ROLE_CONTEXT_SHARING_SOURCE] : []),
  ]);
  const closure = (
    capability: (typeof REQUIRED_PROTECTED_CAPABILITIES)[number],
  ) =>
    manifest.entries.find((entry) => entry.capability === capability)!
      .closureDigest;
  const compositionPayload = {
    kind: 'collaboration-grant-verifier-composition.v1',
    packageName: '@jigwright/grants',
    packageVersion: '0.1.0',
    packageManifestPath: FIXTURE_GRANT_PACKAGE_PATH,
    packageManifestDigest: digest(packageBytes),
    verifierImplementation: 'ssh-maintainer-policy.v1',
    verifierContractVersion: 'jigwright.grant-envelope-verifier.v1',
    readerContractVersion: 'jigwright.collaboration-grant-envelope-reader.v1',
    signatureNamespaces: ['workflow.collaboration-grant.v2'],
    authorizedEffects: ['role-independence-degradation-only'],
    sourcePaths: [FIXTURE_GRANT_PACKAGE_PATH],
    sourceDigest: digest(
      canonicalJson({
        kind: 'collaboration-grant-verifier-source.v1',
        files: [
          {
            path: FIXTURE_GRANT_PACKAGE_PATH,
            digest: digest(packageBytes),
          },
        ],
      }),
    ),
    collaborationPolicyDigest: digest('fixture-collaboration-policy').slice(
      'sha256:'.length,
    ),
    taskDiffReviewPolicyDigest: digest('fixture-task-diff-review-policy').slice(
      'sha256:'.length,
    ),
    ...(includeRoleContextSharing
      ? {
          roleContextSharingGrant: {
            kind: 'role-context-sharing-grant-verifier-binding.v1',
            packageExport: './role-context-sharing-degradation',
            packageExportTarget: './src/role-context-sharing-degradation.ts',
            readerContractVersion:
              'jigwright.role-context-sharing-grant-reader.v1',
            signatureNamespace: 'workflow.role-context-sharing-grant.v1',
            authorizedEffect: 'role-context-sharing-degradation',
            policyDigest: digest('fixture-role-context-policy').slice(
              'sha256:'.length,
            ),
            sourcePaths: [
              FIXTURE_GRANT_PACKAGE_PATH,
              FIXTURE_ROLE_CONTEXT_SHARING_SOURCE,
            ],
            sourceDigest: digest(
              canonicalJson({
                kind: 'role-context-sharing-grant-verifier-source.v1',
                files: [
                  {
                    path: FIXTURE_GRANT_PACKAGE_PATH,
                    digest: digest(packageBytes),
                  },
                  {
                    path: FIXTURE_ROLE_CONTEXT_SHARING_SOURCE,
                    digest: digest(roleSourceBytes),
                  },
                ],
              }),
            ),
            authorizationClosureDigest: closure('authorization.verify'),
          },
        }
      : {}),
    authorizationClosureDigest: closure('authorization.verify'),
    humanTrustRootsClosureDigest: closure('human.trust-roots'),
    applyJournalClosureDigest: closure('apply.journal'),
    controlPlaneUpdateClosureDigest: closure('control-plane.update'),
    recoveryClosureDigest: closure('recovery.rollback'),
    repairAuthority: 'human-only-authority-plan-or-sealed-recovery',
  };
  const composition: Record<string, unknown> = {
    ...compositionPayload,
    compositionDigest: digest(canonicalJson(compositionPayload)),
  };
  mutate?.(composition);
  const { compositionDigest: _compositionDigest, ...mutatedPayload } =
    composition;
  composition.compositionDigest = digest(canonicalJson(mutatedPayload));
  const { manifestDigest: _manifestDigest, ...historicalPayload } = manifest;
  const payload = {
    kind: historicalPayload.kind,
    schemaVersion: historicalPayload.schemaVersion,
    manifestPath: historicalPayload.manifestPath,
    grantVerifierComposition: composition,
    entries: historicalPayload.entries,
  };
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  git(repository, ['add', '.']);
  git(repository, [
    'commit',
    '-m',
    'Install fixture Collaboration Grant verifier composition',
  ]);
  git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return payload;
}

function artifactId(activeArtifact: { artifactId: string }): string {
  return activeArtifact.artifactId;
}

function runLauncher(_engineRoot: string, repository: string, argv: string[]) {
  return runLauncherFromRoot(
    repositoryEngineRoot(repository),
    repository,
    argv,
  );
}

function runLauncherFromRoot(
  engineRoot: string,
  repository: string,
  argv: string[],
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(engineRoot, 'bootstrap/workflow-launcher.ts'),
      ...argv,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: process.env,
    },
  );
}

function repositoryEngineRoot(repository: string): string {
  return path.join(fs.realpathSync(repository), 'packages/workflow-engine');
}

function stateRoot(repository: string): string {
  return bootstrapInterventionStateRoot(
    fs.realpathSync(path.join(repository, '.git')),
  );
}

function recoveryAuthorityStateRoot(repository: string): string {
  return path.join(
    fs.realpathSync(path.join(repository, '.git')),
    'workflow-engine',
    'recovery-authority-state',
  );
}

function installActiveRecoveryQuarantineMarker(
  repository: string,
  repositoryId: string,
): {
  markerPath: string;
  release: () => void;
  cleanup: () => void;
} {
  const root = recoveryAuthorityStateRoot(repository);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(root), 0o700);
  fs.chmodSync(root, 0o700);
  const externalAuditRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-quarantine-audit-')),
  );
  fs.chmodSync(externalAuditRoot, 0o700);
  const authority = recoveryQuarantineAuthority(repositoryId);
  const issuedAt = '2026-08-10T12:00:00.000Z';
  const enterPayload = createRecoveryQuarantineEnterGrantPayload({
    repositoryId,
    authorityDescriptorDigest: authority.descriptor.descriptorDigest,
    authorityGeneration: authority.descriptor.generation,
    recoveryRuntimeDigest: authority.descriptor.sealedRuntime.closureDigest,
    externalAuditRoot,
    humanSigner: authority.descriptor.signer.identity,
    signerFingerprint: authority.descriptor.signer.fingerprint,
    issuedAt,
  });
  const dependencies = recoveryQuarantineDependencies(
    authority,
    externalAuditRoot,
    '2026-08-10T12:00:01.000Z',
  );
  const entered = executeRecoveryQuarantineEnter(
    root,
    recoveryQuarantineEnvelope(enterPayload),
    dependencies,
  );
  return {
    markerPath: entered.markerPath,
    release() {
      const releasePayload = createRecoveryQuarantineReleaseGrantPayload({
        repositoryId,
        authorityDescriptorDigest: authority.descriptor.descriptorDigest,
        authorityGeneration: authority.descriptor.generation,
        recoveryRuntimeDigest: authority.descriptor.sealedRuntime.closureDigest,
        externalAuditRoot,
        humanSigner: authority.descriptor.signer.identity,
        signerFingerprint: authority.descriptor.signer.fingerprint,
        issuedAt: '2026-08-10T12:01:00.000Z',
        activeMarkerDigest: entered.marker.markerDigest,
      });
      executeRecoveryQuarantineRelease(
        root,
        recoveryQuarantineEnvelope(releasePayload),
        recoveryQuarantineDependencies(
          authority,
          externalAuditRoot,
          '2026-08-10T12:01:01.000Z',
        ),
      );
    },
    cleanup() {
      fs.rmSync(externalAuditRoot, { recursive: true, force: true });
    },
  };
}

function recoveryQuarantineAuthority(repositoryId: string): {
  descriptor: RecoveryAuthorityDescriptorV1;
  expectations: RecoveryAuthorityExpectations;
} {
  const repositoryIdentity = {
    repositoryId,
    origin: FIXTURE_ORIGIN,
    gitObjectFormat: 'sha1' as const,
  };
  const sealedRuntime = {
    artifactId: digest('recovery-runtime-artifact'),
    executableDigest: digest('recovery-runtime-executable'),
    closureDigest: digest('recovery-runtime-closure'),
    protocolVersion: 1,
  };
  const auditLedger = {
    ledgerId: 'fixture-recovery-audit',
    rootBindingDigest: digest('fixture-recovery-audit-root'),
  };
  const payload: RecoveryAuthorityDescriptorPayloadV1 = {
    kind: 'harness-recovery-authority.v1',
    repositoryIdentity,
    repositoryIdentityDigest:
      recoveryAuthorityRepositoryIdentityDigest(repositoryIdentity),
    generation: 1,
    signer: {
      identity: 'fixture-recovery-maintainer',
      publicKey: RECOVERY_PUBLIC_KEY,
      fingerprint: RECOVERY_FINGERPRINT,
    },
    allowedDomains: [
      RECOVERY_QUARANTINE_ENTER_NAMESPACE,
      RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
    ],
    sealedRuntime,
    auditLedger,
    createdAt: '2026-08-10T11:59:00.000Z',
  };
  const descriptor = {
    ...payload,
    descriptorDigest: recoveryAuthorityDescriptorDigest(payload),
  };
  return {
    descriptor,
    expectations: {
      repositoryIdentity,
      generation: descriptor.generation,
      signerFingerprint: descriptor.signer.fingerprint,
      sealedRuntime,
      auditLedger,
      descriptorDigest: descriptor.descriptorDigest,
    },
  };
}

function recoveryQuarantineEnvelope(
  payload: RecoveryQuarantineGrantPayload,
): RecoveryQuarantineEnvelope {
  const namespace =
    payload.operation === 'enter-quarantine'
      ? RECOVERY_QUARANTINE_ENTER_NAMESPACE
      : RECOVERY_QUARANTINE_RELEASE_NAMESPACE;
  return {
    payload,
    signature: crypto
      .createHash('sha256')
      .update(`${namespace}\0${canonicalJson(payload)}`)
      .digest('base64'),
  };
}

function recoveryQuarantineDependencies(
  authority: ReturnType<typeof recoveryQuarantineAuthority>,
  externalAuditRoot: string,
  now: string,
) {
  return {
    authorityDescriptor: authority.descriptor,
    authorityExpectations: authority.expectations,
    externalAuditRoot,
    now: new Date(now),
    verifyHumanSignature(
      payload: string,
      signature: string,
      _signer: string,
      namespace: string,
    ) {
      return (
        signature ===
        crypto
          .createHash('sha256')
          .update(`${namespace}\0${payload}`)
          .digest('base64')
      );
    },
    appendAudit(_record: RecoveryQuarantineAuditRecord) {},
  };
}

function supervisorPath(repository: string): string {
  return path.join(stateRoot(repository), 'control-plane-supervisor.json');
}

function repositoryIdentity(repository: string) {
  return {
    gitCommonDirectory: fs.realpathSync(
      git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]).trim(),
    ),
    worktreeRoot: fs.realpathSync(repository),
    branchRef: git(repository, ['symbolic-ref', 'HEAD']).trim(),
  };
}
