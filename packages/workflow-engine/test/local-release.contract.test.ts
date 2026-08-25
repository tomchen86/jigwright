import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildLocalJigwrightRelease } from '../../../scripts/build-local-jigwright-release.ts';

test('local Jigwright release contains installable exact-version package artifacts', () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-local-release-'),
  );
  try {
    const matrix = buildLocalJigwrightRelease(process.cwd(), outputRoot, {
      allowDirty: true,
    });
    assert.equal(matrix.schemaVersion, 1);
    assert.deepEqual(
      matrix.packages.map((entry) => entry.name),
      [
        '@jigwright/agent-runtime',
        '@jigwright/core',
        '@jigwright/github-adapter',
        '@jigwright/grants',
        '@jigwright/openspec-adapter',
        'jigwright',
      ],
    );
    for (const entry of matrix.packages) {
      const tarballPath = path.join(outputRoot, entry.tarball);
      assert.equal(fs.existsSync(tarballPath), true);
      assert.equal(
        entry.digest,
        `sha256:${crypto.createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex')}`,
      );
      assert.equal(entry.version, '0.1.0');
    }

    const main = matrix.packages.find((entry) => entry.name === 'jigwright')!;
    const mainTarball = path.join(outputRoot, main.tarball);
    const manifest = JSON.parse(
      runTar(['-xOzf', mainTarball, 'package/package.json']),
    );
    assert.equal(manifest.name, 'jigwright');
    assert.equal(manifest.bin.jigwright, './bootstrap/jigwright-cli.mjs');
    assert.deepEqual(manifest.jigwrightRelease, {
      schemaVersion: 1,
      installedCliSurface: 'materialized-typescript-v1',
      entrypoint: './bootstrap/jigwright-cli.mjs',
    });
    assert.equal(manifest.private, undefined);
    assert.equal(
      Object.values(manifest.dependencies).some(
        (version) => version === 'workspace:*',
      ),
      false,
    );
    const inventory = runTar(['-tzf', mainTarball]);
    assert.match(
      inventory,
      /package\/bootstrap\/recovery-runtime\/node_modules\/@jigwright\/core\/package\.json/,
    );
    assert.match(inventory, /package\/bootstrap\/installed-runtime\.json/u);
    assert.match(
      inventory,
      /package\/bootstrap\/installed-runtime-launcher\.mjs/u,
    );
    assert.match(
      inventory,
      /package\/bootstrap\/installed-runtime-optional-sources\/jigwright-github-adapter\/src\/archive-pull-request\.ts/u,
    );
    assert.doesNotMatch(inventory, /(?:^|\/)\._/mu);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

function runTar(args: string[]): string {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
