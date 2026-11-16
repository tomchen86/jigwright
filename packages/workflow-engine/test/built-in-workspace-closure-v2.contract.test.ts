import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const WORKFLOW_ENGINE_ROOT = path.resolve(import.meta.dirname, '..');

type Digest = `sha256:${string}`;

type ClosureModule =
  typeof import('../bootstrap/control-plane-bootstrap-closure.ts');

test('V2 built-in closure maps workspace sources and rejects retired manifests, unlisted sources, and tampering', async () => {
  const fixture = createWorkspaceClosureFixture();
  try {
    const surface = await loadFixtureClosure(fixture.root);
    assertRetiredV1ManifestRejected(surface);

    const closure = surface.verifiedBuiltInEngineClosure(
      fixture.workflowEngineRoot,
    );
    assert.equal(closure.manifest.kind, 'built-in-engine-closure-manifest.v2');
    assert.deepEqual(
      closure.files.map((entry) => [entry.path, entry.repositoryPath]),
      [
        [
          'node_modules/@jigwright/core/package.json',
          'packages/core/package.json',
        ],
        [
          'node_modules/@jigwright/core/src/value.ts',
          'packages/core/src/value.ts',
        ],
        ['package.json', 'packages/workflow-engine/package.json'],
        [
          'src/entrypoints/cli/workflow-cli.ts',
          'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
        ],
      ],
    );
    const unlistedSource = path.join(
      fixture.root,
      'packages/core/src/extra.ts',
    );
    fs.writeFileSync(unlistedSource, 'export const extra = true;\n', {
      mode: 0o644,
    });
    assert.throws(
      () => surface.verifiedBuiltInEngineClosure(fixture.workflowEngineRoot),
      hasCode('WORKFLOW_BUILT_IN_ENGINE_CLOSURE_MISMATCH'),
    );
    fs.rmSync(unlistedSource);

    assert.doesNotThrow(() =>
      surface.verifiedBuiltInEngineClosure(fixture.workflowEngineRoot),
    );

    const coreSource = path.join(fixture.root, 'packages/core/src/value.ts');
    fs.writeFileSync(coreSource, 'export const value = "tampered";\n');
    try {
      assert.throws(
        () => surface.verifiedBuiltInEngineClosure(fixture.workflowEngineRoot),
        hasCode('WORKFLOW_BUILT_IN_ENGINE_CLOSURE_MISMATCH'),
      );
    } finally {
      fs.writeFileSync(coreSource, fixture.coreSourceBytes);
    }
    assert.doesNotThrow(() =>
      surface.verifiedBuiltInEngineClosure(fixture.workflowEngineRoot),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createWorkspaceClosureFixture(): {
  root: string;
  workflowEngineRoot: string;
  coreSourceBytes: string;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'built-in-workspace-closure-v2-')),
  );
  const workflowEngineRoot = path.join(root, 'packages/workflow-engine');
  const workflowBootstrap = path.join(workflowEngineRoot, 'bootstrap');
  const workflowSource = path.join(workflowEngineRoot, 'src/entrypoints/cli');
  const coreRoot = path.join(root, 'packages/core');
  const coreSource = path.join(coreRoot, 'src');
  fs.mkdirSync(workflowBootstrap, { recursive: true });
  fs.mkdirSync(workflowSource, { recursive: true });
  fs.mkdirSync(coreSource, { recursive: true });

  const workflowPackageBytes = `${JSON.stringify(
    {
      name: 'jigwright',
      private: false,
      type: 'module',
      dependencies: { '@jigwright/core': 'workspace:*' },
    },
    null,
    2,
  )}\n`;
  const workflowSourceBytes =
    "export { value } from '@jigwright/core/value';\n";
  const corePackageBytes = `${JSON.stringify(
    {
      name: '@jigwright/core',
      private: true,
      type: 'module',
      exports: { './value': './src/value.ts' },
    },
    null,
    2,
  )}\n`;
  const coreSourceBytes = "export const value = 'core-value';\n";
  fs.writeFileSync(
    path.join(workflowEngineRoot, 'package.json'),
    workflowPackageBytes,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(workflowSource, 'workflow-cli.ts'),
    workflowSourceBytes,
    {
      mode: 0o644,
    },
  );
  fs.writeFileSync(path.join(coreRoot, 'package.json'), corePackageBytes, {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(coreSource, 'value.ts'), coreSourceBytes, {
    mode: 0o644,
  });

  const packages = [
    {
      name: 'jigwright',
      sourceRoot: 'packages/workflow-engine',
      closureRoot: '.',
    },
    {
      name: '@jigwright/core',
      sourceRoot: 'packages/core',
      closureRoot: 'node_modules/@jigwright/core',
    },
  ];
  const files = [
    {
      path: 'node_modules/@jigwright/core/package.json',
      mode: '100644',
      digest: digest(corePackageBytes),
    },
    {
      path: 'node_modules/@jigwright/core/src/value.ts',
      mode: '100644',
      digest: digest(coreSourceBytes),
    },
    {
      path: 'package.json',
      mode: '100644',
      digest: digest(workflowPackageBytes),
    },
    {
      path: 'src/entrypoints/cli/workflow-cli.ts',
      mode: '100644',
      digest: digest(workflowSourceBytes),
    },
  ];
  const manifest = {
    kind: 'built-in-engine-closure-manifest.v2',
    entrypoint: 'src/entrypoints/cli/workflow-cli.ts',
    scope: 'workspace-runtime-source-closure',
    packages,
    files,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(
    path.join(workflowBootstrap, 'built-in-engine-closure.json'),
    manifestBytes,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(workflowBootstrap, 'built-in-engine-closure-pin.ts'),
    [
      '// Fixture pin.',
      'export const BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST =',
      `  '${digest(manifestBytes)}' as const;`,
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  for (const name of [
    'canonical-json.ts',
    'control-plane-bootstrap-closure.ts',
    'control-plane-bootstrap-files.ts',
    'control-plane-bootstrap-types.ts',
    'control-plane-bootstrap-values.ts',
  ]) {
    fs.copyFileSync(
      path.join(WORKFLOW_ENGINE_ROOT, 'bootstrap', name),
      path.join(workflowBootstrap, name),
    );
  }
  return { root, workflowEngineRoot, coreSourceBytes };
}

async function loadFixtureClosure(
  repositoryRoot: string,
): Promise<ClosureModule> {
  const modulePath = path.join(
    repositoryRoot,
    'packages/workflow-engine/bootstrap/control-plane-bootstrap-closure.ts',
  );
  return (await import(
    `${pathToFileURL(modulePath).href}?fixture=${crypto.randomUUID()}`
  )) as ClosureModule;
}

function assertRetiredV1ManifestRejected(surface: ClosureModule): void {
  assert.throws(
    () =>
      surface.verifyClosureManifest({
        kind: 'built-in-engine-closure-manifest.v1',
        entrypoint: 'src/entrypoints/cli/workflow-cli.ts',
        scope: 'package-json-and-all-src-typescript',
        files: [
          {
            path: 'package.json',
            mode: '100644',
            digest: `sha256:${'1'.repeat(64)}`,
          },
          {
            path: 'src/entrypoints/cli/workflow-cli.ts',
            mode: '100644',
            digest: `sha256:${'2'.repeat(64)}`,
          },
        ],
      }),
    hasCode('WORKFLOW_BUILT_IN_ENGINE_CLOSURE_MISMATCH'),
  );
}

function digest(value: string | Buffer): Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected;
}
