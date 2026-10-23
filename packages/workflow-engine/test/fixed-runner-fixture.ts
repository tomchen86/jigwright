/** Copied package host plus inert retired state. No updater or authority ceremony. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapInterventionStateRoot } from '../bootstrap/control-plane-trust.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  REQUIRED_PROTECTED_CAPABILITIES,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import { createFixtureRepository, git } from './fixture.ts';
import {
  BOOTSTRAP_RUNTIME_NAMES,
  sealFixtureWorkflowHost,
} from './support/bootstrap-runtime-fixture.ts';
const SOURCE_ENGINE_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_ORIGIN = 'https://github.com/example/fixture.git';
export const FIXED_RUNNER_FIXTURE_REPOSITORY_ID =
  'github:R_fixed_runner_fixture';
const CONTROL_PLANE_FIXTURE_REPOSITORY_ID = FIXED_RUNNER_FIXTURE_REPOSITORY_ID;
const FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH =
  'src/runtime/repository-validation/protected-capabilities.ts';

export function setupFixedRunnerFixture(
  options: {
    builtInEntrypointBytes?: string;
    candidateExecutableFactory?: (closureDigest: `sha256:${string}`) => Buffer;
  } = {},
) {
  const engineRoot = createSealedEnginePackage(options.builtInEntrypointBytes);
  const repository = createRepository(engineRoot);
  const stateRoot = bootstrapInterventionStateRoot(
    fs.realpathSync(path.join(repository, '.git')),
  );
  const packageEngineDigest = controlPlaneFixtureDigest(
    fs.readFileSync(
      path.join(engineRoot, 'bootstrap/built-in-engine-closure.json'),
    ),
  );
  const closureDigest = controlPlaneFixtureDigest('retired candidate closure');
  const executableBytes =
    options.candidateExecutableFactory?.(closureDigest) ??
    Buffer.from(
      '#!/usr/bin/env node\nprocess.stdout.write("retired candidate\\n");\n',
    );
  const executableDigest = controlPlaneFixtureDigest(executableBytes);
  const executablePath = path.join(
    stateRoot,
    'control-plane-artifacts',
    executableDigest.slice(7),
    'engine',
  );
  fs.mkdirSync(path.dirname(executablePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(executablePath, executableBytes, { mode: 0o500 });
  const retiredSelection = {
    kind: 'control-plane-supervisor-state.v1',
    repositoryId: FIXED_RUNNER_FIXTURE_REPOSITORY_ID,
    activeArtifact: {
      artifactId: executableDigest,
      executableDigest,
      closureDigest,
      executablePath,
    },
    generation: 2,
    transition: {
      grantId: 'retired-grant',
      txId: 'retired-transaction',
      phase: 'candidate-selected',
    },
  };
  const retiredUpdate = { transaction: { state: 'FINALIZED' } };
  fs.writeFileSync(
    path.join(stateRoot, 'control-plane-supervisor.json'),
    JSON.stringify(retiredSelection) + '\n',
    { mode: 0o600 },
  );
  fs.mkdirSync(path.join(stateRoot, 'control-updates'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(stateRoot, 'control-updates', '0'.repeat(64) + '.json'),
    JSON.stringify(retiredUpdate) + '\n',
    { mode: 0o600 },
  );
  return {
    engineRoot,
    repository,
    stateRoot,
    packageEngineDigest,
    retiredSelection,
    retiredUpdate,
    cleanup() {
      fs.rmSync(path.resolve(engineRoot, '../..'), {
        recursive: true,
        force: true,
      });
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function createSealedEnginePackage(builtInEntrypointBytes?: string): string {
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-runner-engine-')),
  );
  const root = path.join(workspace, 'packages', 'workflow-engine');
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
  const packageBytes = `${JSON.stringify(
    { name: 'jigwright', private: true, type: 'module' },
    null,
    2,
  )}\n`;
  const entrypointBytes =
    builtInEntrypointBytes ??
    [
      "import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../../../bootstrap/built-in-engine-closure-pin.ts';",
      "import { bootstrapInterventionStateRoot } from '../../../bootstrap/control-plane-trust.ts';",
      'void BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST;',
      'void bootstrapInterventionStateRoot;',
      "process.stdout.write('fixture built-in engine\\n');",
      '',
    ].join('\n');
  const protectedLoaderBytes =
    "export const fixtureProtectedCapabilitiesLoader = 'v1';\n";
  fs.writeFileSync(path.join(root, 'package.json'), packageBytes);
  fs.writeFileSync(path.join(source, 'workflow-cli.ts'), entrypointBytes);
  const protectedLoaderPath = path.join(
    root,
    FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH,
  );
  fs.mkdirSync(path.dirname(protectedLoaderPath), { recursive: true });
  fs.writeFileSync(protectedLoaderPath, protectedLoaderBytes);
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
        digest: controlPlaneFixtureDigest(packageBytes),
      },
      {
        path: 'src/entrypoints/cli/workflow-cli.ts',
        mode: '100644',
        digest: controlPlaneFixtureDigest(entrypointBytes),
      },
      {
        path: FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH,
        mode: '100644',
        digest: controlPlaneFixtureDigest(protectedLoaderBytes),
      },
    ],
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(
    path.join(bootstrap, 'built-in-engine-closure.json'),
    manifestBytes,
  );
  fs.writeFileSync(
    path.join(bootstrap, 'built-in-engine-closure-pin.ts'),
    [
      'export const BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST =',
      `  '${controlPlaneFixtureDigest(manifestBytes)}' as const;`,
      '',
    ].join('\n'),
  );
  sealFixtureWorkflowHost(root);
  return root;
}

function createRepository(engineRoot: string): string {
  const repository = createFixtureRepository();
  git(repository, ['remote', 'add', 'origin', FIXTURE_ORIGIN]);
  const policy = JSON.parse(
    fs.readFileSync(
      path.resolve(SOURCE_ENGINE_ROOT, '../../workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as Record<string, unknown> & {
    repository: { id: string; origin: string };
  };
  policy.repository = {
    id: CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
    origin: FIXTURE_ORIGIN,
  };
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  fs.cpSync(engineRoot, repositoryEngineRoot(repository), { recursive: true });
  const manifest = createFixtureProtectedManifest(repository);
  const { manifestDigest: _manifestDigest, ...manifestPayload } = manifest;
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(manifestPayload, null, 2)}\n`,
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install fixture package']);
  git(repository, [
    'update-ref',
    'refs/remotes/origin/main',
    git(repository, ['rev-parse', 'HEAD']).trim(),
  ]);
  return repository;
}

function createFixtureProtectedManifest(repository: string) {
  const entries: ProtectedCapabilityEntry[] =
    REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
      const entrypoints = [`protected/${capability}/entry.ts`];
      const dependencies = [
        `protected/${capability}/dependency.ts`,
        ...(capability === 'adoption.journal'
          ? ['workflow/protected-capabilities.json']
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
      const contentDigest = controlPlaneFixtureDigest(
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

function repositoryEngineRoot(repository: string): string {
  return path.join(fs.realpathSync(repository), 'packages/workflow-engine');
}

export function controlPlaneFixtureDigest(
  value: string | Buffer,
): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
