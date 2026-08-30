import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveWorkspaceSourceClosure,
  resolveWorkspaceSourceExports,
} from '../bootstrap/workspace-source-closure.ts';

type PackageManifest = Readonly<{
  name: string;
  dependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
  exports?: unknown;
}>;

function createWorkspace(t: test.TestContext): string {
  const repositoryRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-source-closure-')),
  );
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  writePackage(repositoryRoot, 'workflow-engine', {
    name: 'jigwright',
    dependencies: { '@jigwright/core': 'workspace:*' },
  });
  writePackage(repositoryRoot, 'core', {
    name: '@jigwright/core',
    exports: {
      './check-registry-port': './src/check-registry-port.ts',
    },
  });
  writePackage(repositoryRoot, 'fixture-adapter', {
    name: '@jigwright/fixture-adapter',
    dependencies: { '@jigwright/core': 'workspace:*' },
    exports: { '.': './src/fixture-check-registry.ts' },
  });
  return repositoryRoot;
}

function writePackage(
  repositoryRoot: string,
  directoryName: string,
  manifest: PackageManifest,
): void {
  const packageRoot = path.join(repositoryRoot, 'packages', directoryName);
  fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  if (
    typeof manifest.exports === 'object' &&
    manifest.exports !== null &&
    !Array.isArray(manifest.exports)
  ) {
    for (const target of Object.values(manifest.exports)) {
      if (typeof target !== 'string' || !target.startsWith('./src/')) continue;
      const targetPath = path.join(packageRoot, ...target.slice(2).split('/'));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'export type Contract = Readonly<{}>;\n', {
        mode: 0o644,
      });
    }
  }
}

function rewriteManifest(
  repositoryRoot: string,
  directoryName: string,
  manifest: PackageManifest,
): void {
  fs.writeFileSync(
    path.join(repositoryRoot, 'packages', directoryName, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

test('builds a deterministic frozen transitive workspace source graph', (t) => {
  const repositoryRoot = createWorkspace(t);
  writePackage(repositoryRoot, 'support', {
    name: '@jigwright/support',
    exports: {
      './zeta': './src/zeta.ts',
      '.': './src/index.ts',
    },
  });
  rewriteManifest(repositoryRoot, 'core', {
    name: '@jigwright/core',
    dependencies: { '@jigwright/support': 'workspace:*' },
    exports: {
      './check-registry-port': './src/check-registry-port.ts',
    },
  });

  const observed = resolveWorkspaceSourceClosure(repositoryRoot);

  assert.deepEqual(observed, [
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
    {
      name: '@jigwright/support',
      sourceRoot: 'packages/support',
      closureRoot: 'node_modules/@jigwright/support',
    },
  ]);
  assert.ok(Object.isFrozen(observed));
  for (const descriptor of observed) {
    assert.ok(Object.isFrozen(descriptor));
  }
  const supportExports = resolveWorkspaceSourceExports(
    repositoryRoot,
    observed[2]!,
  );
  assert.deepEqual(supportExports, [
    { subpath: '.', sourcePath: 'src/index.ts' },
    { subpath: './zeta', sourcePath: 'src/zeta.ts' },
  ]);
  assert.ok(Object.isFrozen(supportExports));
  assert.ok(supportExports.every((entry) => Object.isFrozen(entry)));
  assert.equal(
    observed.some(
      (descriptor) => descriptor.name === '@jigwright/fixture-adapter',
    ),
    false,
  );
});

test('publishes one unscoped Jigwright package and executable while retaining the workflow script alias', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const publicPackageIdentities = fs
    .readdirSync(path.join(repositoryRoot, 'packages'), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      JSON.parse(
        fs.readFileSync(
          path.join(repositoryRoot, 'packages', entry.name, 'package.json'),
          'utf8',
        ),
      ),
    )
    .filter((manifest: { private?: unknown }) => manifest.private !== true)
    .map((manifest: { name?: unknown }) => manifest.name)
    .sort();
  const packageManifest = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'packages/workflow-engine/package.json'),
      'utf8',
    ),
  ) as {
    name?: unknown;
    private?: unknown;
    bin?: unknown;
  };
  const workspaceManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };

  assert.deepEqual(publicPackageIdentities, ['jigwright']);
  assert.equal(packageManifest.name, 'jigwright');
  assert.equal(packageManifest.private, false);
  assert.deepEqual(packageManifest.bin, {
    jigwright: './bootstrap/jigwright-cli.mjs',
  });
  assert.match(workspaceManifest.scripts?.workflow ?? '', /workflow-launcher/u);
});

test('rejects missing, aliased, and non-workspace runtime dependencies', async (t) => {
  const cases = [
    {
      name: 'missing',
      dependencyName: '@jigwright/missing',
      spec: 'workspace:*',
    },
    {
      name: 'alias',
      dependencyName: '@jigwright/core',
      spec: 'workspace:@jigwright/core@*',
    },
    {
      name: 'non-workspace',
      dependencyName: '@jigwright/core',
      spec: '^1.0.0',
    },
  ] as const;

  for (const current of cases) {
    await t.test(current.name, (nested) => {
      const repositoryRoot = createWorkspace(nested);
      rewriteManifest(repositoryRoot, 'workflow-engine', {
        name: 'jigwright',
        dependencies: { [current.dependencyName]: current.spec },
      });
      assert.throws(
        () => resolveWorkspaceSourceClosure(repositoryRoot),
        /workspace source closure/i,
      );
    });
  }
});

test('rejects duplicate and case-fold-colliding workspace identities', async (t) => {
  await t.test('duplicate package identity', (nested) => {
    const repositoryRoot = createWorkspace(nested);
    writePackage(repositoryRoot, 'core-copy', {
      name: '@jigwright/core',
      exports: { '.': './src/index.ts' },
    });
    assert.throws(
      () => resolveWorkspaceSourceClosure(repositoryRoot),
      /workspace source closure/i,
    );
  });

  await t.test('case-fold package identity collision', (nested) => {
    const repositoryRoot = createWorkspace(nested);
    writePackage(repositoryRoot, 'core-copy', {
      name: '@jigwright/Core',
      exports: { '.': './src/index.ts' },
    });
    assert.throws(
      () => resolveWorkspaceSourceClosure(repositoryRoot),
      /workspace source closure/i,
    );
  });
});

test('rejects unsafe source roots, manifests, and exported source files', async (t) => {
  await t.test('symlinked package source root', (nested) => {
    const repositoryRoot = createWorkspace(nested);
    const coreRoot = path.join(repositoryRoot, 'packages', 'core');
    const movedRoot = path.join(repositoryRoot, 'core-real');
    fs.renameSync(coreRoot, movedRoot);
    fs.symlinkSync(movedRoot, coreRoot, 'dir');
    assert.throws(
      () => resolveWorkspaceSourceClosure(repositoryRoot),
      /workspace source closure/i,
    );
  });

  await t.test('hard-linked manifest', (nested) => {
    const repositoryRoot = createWorkspace(nested);
    const manifestPath = path.join(
      repositoryRoot,
      'packages/core/package.json',
    );
    fs.linkSync(manifestPath, path.join(repositoryRoot, 'manifest-copy.json'));
    assert.throws(
      () => resolveWorkspaceSourceClosure(repositoryRoot),
      /workspace source closure/i,
    );
  });

  await t.test('symlinked export target', (nested) => {
    const repositoryRoot = createWorkspace(nested);
    const exportPath = path.join(
      repositoryRoot,
      'packages/core/src/check-registry-port.ts',
    );
    const realSource = path.join(repositoryRoot, 'outside.ts');
    fs.writeFileSync(realSource, 'export type Outside = never;\n');
    fs.rmSync(exportPath);
    fs.symlinkSync(realSource, exportPath);
    assert.throws(
      () => resolveWorkspaceSourceClosure(repositoryRoot),
      /workspace source closure/i,
    );
  });

  await t.test('hard-linked export target', (nested) => {
    const repositoryRoot = createWorkspace(nested);
    const exportPath = path.join(
      repositoryRoot,
      'packages/core/src/check-registry-port.ts',
    );
    fs.linkSync(exportPath, path.join(repositoryRoot, 'export-copy.ts'));
    assert.throws(
      () => resolveWorkspaceSourceClosure(repositoryRoot),
      /workspace source closure/i,
    );
  });
});

test('rejects unsafe package names, source roots, and exports shapes', async (t) => {
  await t.test('unsafe package name', (nested) => {
    const repositoryRoot = createWorkspace(nested);
    rewriteManifest(repositoryRoot, 'core', {
      name: '@jigwright/core/extra',
      exports: { '.': './src/index.ts' },
    });
    assert.throws(
      () => resolveWorkspaceSourceClosure(repositoryRoot),
      /workspace source closure/i,
    );
  });

  await t.test('unsafe source root segment', (nested) => {
    const repositoryRoot = createWorkspace(nested);
    writePackage(repositoryRoot, 'bad root', {
      name: '@jigwright/bad-root',
      exports: { '.': './src/index.ts' },
    });
    assert.throws(
      () => resolveWorkspaceSourceClosure(repositoryRoot),
      /workspace source closure/i,
    );
  });

  const unsafeExports = [
    ['./bad target', { '.': '../outside.ts' }],
    ['./conditional target', { '.': { import: './src/index.ts' } }],
    ['./array exports', ['./src/index.ts']],
    ['./unsafe subpath', { '../private': './src/index.ts' }],
    ['./non-source target', { '.': './test/index.ts' }],
  ] as const;
  for (const [name, exportsField] of unsafeExports) {
    await t.test(name, (nested) => {
      const repositoryRoot = createWorkspace(nested);
      rewriteManifest(repositoryRoot, 'core', {
        name: '@jigwright/core',
        exports: exportsField,
      });
      assert.throws(
        () => resolveWorkspaceSourceClosure(repositoryRoot),
        /workspace source closure/i,
      );
    });
  }
});

test('rejects runtime declarations outside dependencies without weakening closure', async (t) => {
  for (const field of ['optionalDependencies', 'peerDependencies'] as const) {
    await t.test(field, (nested) => {
      const repositoryRoot = createWorkspace(nested);
      rewriteManifest(repositoryRoot, 'core', {
        name: '@jigwright/core',
        exports: {
          './check-registry-port': './src/check-registry-port.ts',
        },
        [field]: { external: '1.0.0' },
      });
      assert.throws(
        () => resolveWorkspaceSourceClosure(repositoryRoot),
        /workspace source closure/i,
      );
    });
  }
});
