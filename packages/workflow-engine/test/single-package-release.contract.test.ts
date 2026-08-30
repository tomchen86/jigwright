import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildSingleJigwrightPackage } from '../../../scripts/build-single-jigwright-package.ts';

test('installed runtime descriptors are exact embedded-only records', () => {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-embedded-runtime-'),
  );
  try {
    const outputRoot = path.join(scratch, 'release');
    const artifact = buildSingleJigwrightPackage(process.cwd(), outputRoot, {
      allowDirty: true,
    });
    const runtime = JSON.parse(
      run('tar', [
        '-xOzf',
        path.join(outputRoot, artifact.tarball),
        'package/bootstrap/installed-runtime.json',
      ]),
    ) as { packages: Record<string, unknown>[] };

    for (const descriptor of runtime.packages) {
      assert.deepEqual(Object.keys(descriptor).sort(), [
        'embeddedSourceRoot',
        'name',
        'sourceManifestBase64',
        'sourceRoot',
      ]);
      if (descriptor.name === 'jigwright') {
        assert.equal(descriptor.embeddedSourceRoot, null);
      } else {
        assert.match(
          String(descriptor.embeddedSourceRoot),
          /^bootstrap\/installed-runtime-sources\/jigwright-[a-z0-9-]+$/u,
        );
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('single Jigwright tarball installs the complete CLI and public surfaces', () => {
  const workspaceManifest = JSON.parse(
    fs.readFileSync(path.resolve('package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.equal(
    workspaceManifest.scripts['jigwright:pack-local'],
    'node --experimental-strip-types scripts/build-single-jigwright-package.ts --output dist/local-release',
  );
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-single-package-'),
  );
  try {
    const outputRoot = path.join(scratch, 'release');
    const artifact = buildSingleJigwrightPackage(process.cwd(), outputRoot, {
      allowDirty: true,
    });
    assert.deepEqual(
      {
        kind: artifact.kind,
        name: artifact.name,
        version: artifact.version,
      },
      {
        kind: 'jigwright-single-package.v1',
        name: 'jigwright',
        version: '0.1.0',
      },
    );
    const tarballPath = path.join(outputRoot, artifact.tarball);
    assert.equal(fs.existsSync(tarballPath), true);
    assert.equal(
      artifact.digest,
      `sha256:${crypto
        .createHash('sha256')
        .update(fs.readFileSync(tarballPath))
        .digest('hex')}`,
    );
    const repeated = buildSingleJigwrightPackage(
      process.cwd(),
      path.join(scratch, 'repeated-release'),
      { allowDirty: true },
    );
    assert.equal(repeated.digest, artifact.digest);
    assert.deepEqual(
      fs.readFileSync(path.join(scratch, 'repeated-release', repeated.tarball)),
      fs.readFileSync(tarballPath),
    );

    const manifest = JSON.parse(
      run('tar', ['-xOzf', tarballPath, 'package/package.json']),
    ) as Record<string, any>;
    assert.equal(manifest.name, 'jigwright');
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.workspaces, undefined);
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.optionalDependencies, undefined);
    assert.equal(manifest.peerDependencies, undefined);
    assert.deepEqual(manifest.bin, { jigwright: './bin/jigwright.mjs' });
    assert.deepEqual(manifest.exports, {
      './central-grant': {
        types: './runtime/composition-root/public/central-grant.ts',
        import: './dist/runtime/composition-root/public/central-grant.js',
      },
      './manifest-v3': {
        types: './runtime/composition-root/public/manifest-v3.ts',
        import: './dist/runtime/composition-root/public/manifest-v3.js',
      },
      './plan-review': {
        types: './runtime/composition-root/public/plan-review.ts',
        import: './dist/runtime/composition-root/public/plan-review.js',
      },
    });
    assert.deepEqual(manifest.imports['#internal/agent-runtime'], {
      types: './internal/agent-runtime/src/index.ts',
      default: './dist/internal/agent-runtime/src/index.js',
    });
    assert.deepEqual(manifest.imports['#internal/core/canonical-json'], {
      types: './internal/core/src/canonical-json.ts',
      default: './dist/internal/core/src/canonical-json.js',
    });
    assert.deepEqual(
      manifest.imports['#internal/grants/central-grant-contracts'],
      {
        types: './internal/grants/src/central-grant-contracts.ts',
        default: './dist/internal/grants/src/central-grant-contracts.js',
      },
    );
    assert.deepEqual(
      manifest.imports['#internal/openspec-adapter/validation-payload'],
      {
        types: './internal/openspec-adapter/src/validation-payload.ts',
        default: './dist/internal/openspec-adapter/src/validation-payload.js',
      },
    );
    assert.deepEqual(manifest.jigwrightRelease, {
      schemaVersion: 1,
      installedCliSurface: 'embedded-workspace-typescript-v1',
      publicModuleSurface: 'compiled-package-import-map-v1',
      entrypoint: './bin/jigwright.mjs',
    });

    const inventory = run('tar', ['-tzf', tarballPath]);
    const topLevel = [
      ...new Set(
        inventory
          .split('\n')
          .filter((entry) => entry.startsWith('package/'))
          .map((entry) => entry.slice('package/'.length).split('/')[0])
          .filter((entry) => entry.length > 0),
      ),
    ].sort();
    assert.deepEqual(topLevel, [
      'LICENSE',
      'README.md',
      'bin',
      'bootstrap',
      'dist',
      'internal',
      'native',
      'package.json',
      'runtime',
      'src',
    ]);
    for (const expected of [
      'package/bin/jigwright.mjs',
      'package/bootstrap/installed-runtime.json',
      'package/bootstrap/installed-runtime-sources/jigwright-agent-runtime/src/index.ts',
      'package/bootstrap/installed-runtime-sources/jigwright-core/src/canonical-json.ts',
      'package/bootstrap/installed-runtime-sources/jigwright-grants/src/central-grant-contracts.ts',
      'package/bootstrap/installed-runtime-sources/jigwright-github-adapter/src/archive-pull-request.ts',
      'package/bootstrap/installed-runtime-sources/jigwright-openspec-adapter/src/index.ts',
      'package/internal/core/conformance/workflow-conformance-v2.json',
      'package/dist/internal/core/conformance/workflow-conformance-v2.json',
      'package/dist/runtime/composition-root/public/manifest-v3.js',
      'package/runtime/composition-root/public/manifest-v3.ts',
      'package/src/cli.ts',
    ]) {
      assert.match(inventory, new RegExp(`^${escapeRegExp(expected)}$`, 'mu'));
    }
    assert.doesNotMatch(inventory, /package\/apps\//u);
    assert.doesNotMatch(inventory, /package\/[^\n]*expense-app(?:\/|$)/u);
    assert.doesNotMatch(
      inventory,
      /package\/[^\n]*adapters\/compatibility(?:\/|$)/u,
    );
    assert.doesNotMatch(inventory, /package\/[^\n]*investigation-v2(?:\/|$)/u);
    assert.doesNotMatch(inventory, /package\/internal\/[^/]+\/package\.json/u);
    assert.doesNotMatch(
      inventory,
      /package\/bootstrap\/installed-runtime-sources\/[^/]+\/package\.json/u,
    );
    assert.doesNotMatch(inventory, /(?:^|\/)\._/mu);

    const consumerRoot = path.join(scratch, 'consumer');
    fs.mkdirSync(consumerRoot);
    fs.writeFileSync(
      path.join(consumerRoot, 'package.json'),
      `${JSON.stringify({ name: 'fixture', private: true, type: 'module' })}\n`,
    );
    run(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        tarballPath,
      ],
      consumerRoot,
    );
    fs.writeFileSync(
      path.join(consumerRoot, 'consumer.ts'),
      [
        "import { validateForAuthority, type InvestigationManifestV3 } from 'jigwright/manifest-v3';",
        "import { validatePlanReview, type ValidatePlanReviewInput } from 'jigwright/plan-review';",
        "import { loadGrantPolicyV2 } from 'jigwright/central-grant';",
        '',
        'export const publicValidators = [',
        '  validateForAuthority,',
        '  validatePlanReview,',
        '  loadGrantPolicyV2,',
        '] as const;',
        'export type PublicManifest = InvestigationManifestV3;',
        'export type PublicPlanReviewInput = ValidatePlanReviewInput;',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(consumerRoot, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            skipLibCheck: true,
            types: ['node'],
            typeRoots: [path.resolve('node_modules/@types')],
          },
          include: ['consumer.ts'],
        },
        null,
        2,
      )}\n`,
    );
    run(
      process.execPath,
      [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
      consumerRoot,
    );
    const installedRoot = path.join(consumerRoot, 'node_modules', 'jigwright');
    const repositoryRoot = path.join(scratch, 'repository');
    fs.mkdirSync(repositoryRoot);
    run('git', ['init', '--quiet'], repositoryRoot);
    const guidance = JSON.parse(
      run(
        process.execPath,
        [path.join(installedRoot, 'bin', 'jigwright.mjs'), 'guide', '--json'],
        repositoryRoot,
      ),
    );
    assert.equal(guidance.guide.kind, 'workflow-command-guide.v1');

    const surface = JSON.parse(
      run(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          [
            "const manifest = await import('jigwright/manifest-v3');",
            "const review = await import('jigwright/plan-review');",
            "const grant = await import('jigwright/central-grant');",
            'process.stdout.write(JSON.stringify({',
            "  manifest: typeof manifest.validateForAuthority === 'function',",
            "  review: typeof review.validatePlanReview === 'function',",
            "  grant: typeof grant.loadGrantPolicyV2 === 'function',",
            '}));',
          ].join('\n'),
        ],
        consumerRoot,
      ),
    );
    assert.deepEqual(surface, {
      manifest: true,
      review: true,
      grant: true,
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

function run(executable: string, args: string[], cwd?: string): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache:
        process.env.npm_config_cache ??
        path.join(os.tmpdir(), 'jigwright-test-npm-cache'),
    },
  });
  assert.equal(
    result.status,
    0,
    `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
