import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';
import {
  controlPlaneCandidateDigest,
  controlPlaneIndependentReviewAttestationDigest,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  REQUIRED_PROTECTED_CAPABILITIES,
  type ControlPlaneGrantEnvelope,
  type ControlPlaneIndependentReviewAttestationEnvelope,
  type ExactControlPlaneChange,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import {
  executeControlPlanePromotion,
  initializeControlPlaneSupervisorState,
  readControlPlaneSupervisorState,
  recoverControlPlanePromotion,
  type ControlPlaneUpdaterAuditRecord,
} from '../src/application/control-plane/intervention-control-updater.ts';
import {
  REQUIRED_PROTECTED_CAPABILITIES as TYPED_REQUIRED_PROTECTED_CAPABILITIES,
  type ProtectedCapabilitiesManifest as TypedProtectedCapabilitiesManifest,
} from '../src/adapters/consumer/repository/work-registry/protected-capabilities.ts';
import {
  setupFinalizedControlPlanePromotionFixture,
  setupInitialControlPlaneBootstrapFixture,
} from './control-plane-promotion-fixture.ts';
import { createFixtureRepository } from './fixture.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');
const SOURCE_REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');
const SOURCE_PROMOTION_STATE = path.join(
  SOURCE_REPOSITORY_ROOT,
  '.git',
  'workflow-engine',
  'intervention-control',
  'control-plane-supervisor.json',
);
const WORKFLOW_LAUNCHER = path.join(
  SOURCE_REPOSITORY_ROOT,
  'packages',
  'workflow-engine',
  'bootstrap',
  'workflow-launcher.ts',
);

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function protectedEntries(): ProtectedCapabilityEntry[] {
  return REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints =
      capability === 'control-plane.update'
        ? ['packages/workflow-engine/engine.mjs']
        : [`packages/bootstrap/${capability}.ts`];
    const dependencies = [`packages/bootstrap/shared/${capability}.ts`];
    const contentDigest = digest(`content:${capability}`);
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
}

function engineSource(
  closureDigest: string,
  healthy: boolean,
  engine = 'E2',
): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--control-plane-self-test') {
  process.stdout.write(JSON.stringify({kind:'control-plane-self-test.v1',healthy:${healthy ? 'true' : 'false'},closureDigest:'${closureDigest}'}) + '\\n');
  process.exit(0);
}
if (mode === '--control-plane-restart-probe') {
  process.stdout.write(JSON.stringify({kind:'control-plane-restart.v1',ready:true,closureDigest:'${closureDigest}'}) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({kind:'ordinary-engine.v1',engine:'${engine}',argv:process.argv.slice(2)}) + '\\n');
process.exit(mode === '--launcher-exit-7' ? 7 : 0);
`;
}

test('minimal updater and production manifest loader share the protected capability vocabulary', () => {
  assert.deepEqual(
    REQUIRED_PROTECTED_CAPABILITIES,
    TYPED_REQUIRED_PROTECTED_CAPABILITIES,
  );
  const pure = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const typed: TypedProtectedCapabilitiesManifest = {
    ...pure,
    manifestPath: 'workflow/protected-capabilities.json',
  };
  assert.deepEqual(typed, pure);
});

test('trusted workflow launcher uses built-in E1 only before supervisor initialization', () => {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(SOURCE_REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const enginePackage = JSON.parse(
    fs.readFileSync(
      path.join(
        SOURCE_REPOSITORY_ROOT,
        'packages',
        'workflow-engine',
        'package.json',
      ),
      'utf8',
    ),
  ) as { scripts: Record<string, string> };
  assert.equal(
    rootPackage.scripts.workflow,
    'node --experimental-strip-types packages/workflow-engine/bootstrap/workflow-launcher.ts',
  );
  assert.equal(
    enginePackage.scripts.workflow,
    'node --experimental-strip-types bootstrap/workflow-launcher.ts',
  );

  const repository = createFixtureRepository();
  try {
    const launched = runWorkflowLauncher(repository, ['--help']);
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /^Usage:/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('trusted workflow launcher selection is independent of a tampered src tree', async () => {
  const value = await setupInitialControlPlaneBootstrapFixture({
    builtInEntrypointBytes: initialLauncherEngineSource(),
    now: NOW,
  });
  const isolatedPackage = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-launcher-trust-boundary-'),
  );
  const marker = path.join(isolatedPackage, 'mutable-src-loaded');
  try {
    const enginePackage = path.join(
      isolatedPackage,
      'packages',
      'workflow-engine',
    );
    const bootstrap = path.join(enginePackage, 'bootstrap');
    const mutableSource = path.join(enginePackage, 'src');
    fs.mkdirSync(bootstrap, { recursive: true });
    fs.mkdirSync(mutableSource, { recursive: true });
    fs.writeFileSync(
      path.join(enginePackage, 'package.json'),
      `${JSON.stringify({ type: 'module' })}\n`,
    );
    fs.cpSync(path.dirname(WORKFLOW_LAUNCHER), bootstrap, { recursive: true });
    const maliciousModule = `import fs from 'node:fs';
fs.writeFileSync(process.env.LAUNCHER_SRC_TAMPER_MARKER, 'loaded\\n');
export function bootstrapInterventionStateRoot() { return process.env.LAUNCHER_ATTACKER_STATE_ROOT; }
export function resolveControlPlaneEngineSelection() { return null; }
`;
    fs.writeFileSync(
      path.join(mutableSource, 'intervention-control-bootstrap-cli.ts'),
      maliciousModule,
    );
    fs.writeFileSync(
      path.join(mutableSource, 'intervention-control-updater.ts'),
      maliciousModule,
    );
    fs.writeFileSync(
      path.join(mutableSource, 'cli.ts'),
      `throw new Error('mutable built-in engine must not run');\n`,
    );

    const launched = runWorkflowLauncher(
      value.repository,
      ['ordinary-command'],
      {
        launcherPath: path.join(bootstrap, 'workflow-launcher.ts'),
        env: {
          ...process.env,
          LAUNCHER_SRC_TAMPER_MARKER: marker,
          LAUNCHER_ATTACKER_STATE_ROOT: path.join(isolatedPackage, 'attacker'),
        },
      },
    );
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), {
      kind: 'ordinary-engine.v1',
      engine: 'E1',
      argv: ['ordinary-command'],
    });
    assert.equal(fs.existsSync(marker), false);
  } finally {
    value.cleanup();
    fs.rmSync(isolatedPackage, { recursive: true, force: true });
  }
});

test('trusted workflow launcher rejects a tampered built-in E1 dependency', () => {
  const repository = createFixtureRepository();
  const isolatedPackage = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-launcher-built-in-closure-'),
  );
  try {
    const sourceEnginePackage = path.resolve(
      path.dirname(WORKFLOW_LAUNCHER),
      '..',
    );
    const enginePackage = path.join(
      isolatedPackage,
      'packages',
      'workflow-engine',
    );
    fs.mkdirSync(enginePackage, { recursive: true });
    fs.cpSync(
      path.join(sourceEnginePackage, 'bootstrap'),
      path.join(enginePackage, 'bootstrap'),
      { recursive: true },
    );
    fs.cpSync(
      path.join(sourceEnginePackage, 'src'),
      path.join(enginePackage, 'src'),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(sourceEnginePackage, 'package.json'),
      path.join(enginePackage, 'package.json'),
    );
    fs.appendFileSync(
      path.join(enginePackage, 'src', 'errors.ts'),
      '\n// untrusted dependency mutation\n',
    );

    const launched = runWorkflowLauncher(repository, ['--help'], {
      launcherPath: path.join(
        enginePackage,
        'bootstrap',
        'workflow-launcher.ts',
      ),
    });
    assert.notEqual(launched.status, 0);
    assert.equal(launched.stdout, '');
    assert.match(launched.stderr, /WORKFLOW_BUILT_IN_ENGINE_CLOSURE_MISMATCH/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(isolatedPackage, { recursive: true, force: true });
  }
});

test('trusted workflow launcher selects finalized E2 and preserves argv and exit status', async () => {
  const value = await setupFinalizedControlPlanePromotionFixture({
    candidateExecutableFactory: (closureDigest) =>
      Buffer.from(engineSource(closureDigest, true)),
  });
  try {
    assert.equal(value.record.transaction.state, 'FINALIZED');

    const launched = runWorkflowLauncher(value.repository, [
      'ordinary-command',
      '--exact-argument',
    ]);
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), {
      kind: 'ordinary-engine.v1',
      engine: 'E2',
      argv: ['ordinary-command', '--exact-argument'],
    });

    const exited = runWorkflowLauncher(value.repository, ['--launcher-exit-7']);
    assert.equal(exited.status, 7, exited.stderr);
    assert.equal(JSON.parse(exited.stdout).engine, 'E2');
  } finally {
    value.cleanup();
  }
});

test('trusted workflow launcher rejects a noncanonical terminal update record', async () => {
  const value = await setupFinalizedControlPlanePromotionFixture();
  try {
    assert.equal(value.record.transaction.state, 'FINALIZED');
    fs.appendFileSync(
      onlyPrivateJsonFile(path.join(value.stateRoot, 'control-updates')),
      ' ',
    );

    const launched = runWorkflowLauncher(value.repository, [
      'ordinary-command',
    ]);
    assert.notEqual(launched.status, 0);
    assert.equal(launched.stdout, '');
    assert.match(launched.stderr, /CONTROL_PLANE_SUPERVISOR_CORRUPT/);
  } finally {
    value.cleanup();
  }
});

test('trusted workflow launcher fails closed for missing, malformed, or mismatched supervisor authority', async () => {
  for (const [name, tamper] of [
    [
      'missing initialized pointer',
      (value: InitialControlPlaneFixture) => {
        fs.unlinkSync(supervisorPath(value.stateRoot));
      },
    ],
    [
      'closure mismatch',
      (value: InitialControlPlaneFixture) => {
        rewriteSupervisor(value.stateRoot, (supervisor) => {
          const active = supervisor.activeArtifact as Record<string, unknown>;
          active.closureDigest = digest('wrong-active-closure');
        });
      },
    ],
    [
      'artifact path mismatch',
      (value: InitialControlPlaneFixture) => {
        const supervisor = readControlPlaneSupervisorState(value.stateRoot);
        const alternate = path.join(
          value.stateRoot,
          'control-plane-artifacts',
          'alternate-artifact',
        );
        fs.mkdirSync(alternate, { mode: 0o700 });
        const alternateExecutable = path.join(alternate, 'engine');
        fs.copyFileSync(
          supervisor.activeArtifact.executablePath,
          alternateExecutable,
        );
        fs.chmodSync(alternateExecutable, 0o500);
        rewriteSupervisor(value.stateRoot, (record) => {
          const active = record.activeArtifact as Record<string, unknown>;
          active.executablePath = alternateExecutable;
        });
      },
    ],
    [
      'artifact digest mismatch',
      (value: InitialControlPlaneFixture) => {
        const executable = readControlPlaneSupervisorState(value.stateRoot)
          .activeArtifact.executablePath;
        fs.chmodSync(executable, 0o700);
        fs.writeFileSync(executable, '#!/usr/bin/env node\nprocess.exit(0);\n');
        fs.chmodSync(executable, 0o500);
      },
    ],
    [
      'artifact symlink',
      (value: InitialControlPlaneFixture) => {
        const executable = readControlPlaneSupervisorState(value.stateRoot)
          .activeArtifact.executablePath;
        const target = `${executable}.target`;
        fs.renameSync(executable, target);
        fs.symlinkSync(path.basename(target), executable);
      },
    ],
  ] as const) {
    const value = await setupInitialControlPlaneBootstrapFixture({ now: NOW });
    try {
      tamper(value);
      const launched = runWorkflowLauncher(value.repository, [
        'ordinary-command',
      ]);
      assert.notEqual(launched.status, 0, name);
      assert.equal(launched.stdout, '', name);
      assert.match(
        launched.stderr,
        /CONTROL_PLANE_(?:SUPERVISOR|EXECUTABLE|PROCESS)/,
        name,
      );
    } finally {
      value.cleanup();
    }
  }
});

type InitialControlPlaneFixture = Awaited<
  ReturnType<typeof setupInitialControlPlaneBootstrapFixture>
>;

function initialLauncherEngineSource(): string {
  return `#!/usr/bin/env node
process.stdout.write(JSON.stringify({kind:'ordinary-engine.v1',engine:'E1',argv:process.argv.slice(2)}) + '\\n');
process.exit(process.argv[2] === '--launcher-exit-7' ? 7 : 0);
`;
}

function onlyPrivateJsonFile(directory: string): string {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.isFile(), true);
  assert.equal(entries[0]?.isSymbolicLink(), false);
  assert.match(entries[0]?.name ?? '', /^[0-9a-f]{64}\.json$/);
  return path.join(directory, entries[0]!.name);
}

function runWorkflowLauncher(
  repository: string,
  argv: string[],
  options: {
    launcherPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return childProcess.spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      options.launcherPath ?? WORKFLOW_LAUNCHER,
      ...argv,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: options.env ?? process.env,
    },
  );
}

function supervisorPath(storageRoot: string): string {
  return path.join(storageRoot, 'control-plane-supervisor.json');
}

function rewriteSupervisor(
  storageRoot: string,
  mutate: (supervisor: Record<string, unknown>) => void,
): void {
  const filePath = supervisorPath(storageRoot);
  const supervisor = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
    string,
    unknown
  >;
  mutate(supervisor);
  delete supervisor.recordDigest;
  supervisor.recordDigest = digest(canonicalJson(supervisor));
  fs.writeFileSync(filePath, `${canonicalJson(supervisor)}\n`, { mode: 0o600 });
}
