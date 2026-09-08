import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OPENSPEC_PACKAGE_INTEGRITY,
  openSpecSupplyChainPaths,
  verifyOpenSpecSupplyChain,
} from '../src/adapters/planning/openspec/documents/openspec-provenance.ts';
import { resolveOpenSpecInstallation } from '../src/adapters/planning/openspec/documents/openspec-executor.ts';

function fixture(t: test.TestContext, manager: string): string {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'jigwright-package-manager-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      packageManager: manager,
      devDependencies: { '@fission-ai/openspec': '1.6.0' },
    }),
  );
  const installed = path.join(root, 'node_modules/@fission-ai/openspec');
  fs.mkdirSync(path.join(installed, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(installed, 'package.json'),
    JSON.stringify({
      name: '@fission-ai/openspec',
      version: '1.6.0',
      bin: { openspec: './bin/openspec.js' },
    }),
  );
  fs.writeFileSync(
    path.join(installed, 'bin/openspec.js'),
    'process.stdout.write("1.6.0\\n");\n',
  );
  return root;
}

function npmLock(integrity = OPENSPEC_PACKAGE_INTEGRITY) {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { devDependencies: { '@fission-ai/openspec': '1.6.0' } },
      'node_modules/@fission-ai/openspec': { version: '1.6.0', integrity },
    },
  });
}

test('npm installation uses its lock and project script policy without pnpm files', (t) => {
  const root = fixture(t, 'npm@11.0.0');
  fs.writeFileSync(path.join(root, 'package-lock.json'), npmLock());
  fs.writeFileSync(path.join(root, '.npmrc'), 'ignore-scripts=true\n');
  const provenance = verifyOpenSpecSupplyChain(root);
  assert.equal(provenance.lockfileVersion, '3');
  assert.equal(provenance.integrity, OPENSPEC_PACKAGE_INTEGRITY);
  assert.deepEqual(openSpecSupplyChainPaths(root), [
    'package-lock.json',
    '.npmrc',
  ]);
  assert.equal(resolveOpenSpecInstallation(root).version, '1.6.0');
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    npmLock('sha512-wrong'),
  );
  assert.throws(() => verifyOpenSpecSupplyChain(root), /integrity/i);
  fs.writeFileSync(path.join(root, 'package-lock.json'), npmLock());
  fs.writeFileSync(path.join(root, '.npmrc'), 'ignore-scripts=false\n');
  assert.throws(() => verifyOpenSpecSupplyChain(root), /scripts/i);
});

test('npm shrinkwrap wins over a stale package lock and participates in contract identity', (t) => {
  const root = fixture(t, 'npm@11.0.0');
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    npmLock('sha512-stale'),
  );
  fs.writeFileSync(path.join(root, 'npm-shrinkwrap.json'), npmLock());
  fs.writeFileSync(path.join(root, '.npmrc'), 'ignore-scripts=true\n');
  assert.equal(verifyOpenSpecSupplyChain(root).lockedVersion, '1.6.0');
  assert.deepEqual(openSpecSupplyChainPaths(root), [
    'npm-shrinkwrap.json',
    '.npmrc',
  ]);
});

test('Yarn Classic verifies its exact descriptor, integrity and script policy', (t) => {
  const root = fixture(t, 'yarn@1.22.22');
  const lock = `# yarn lockfile v1\n\n"@fission-ai/openspec@1.6.0":\n  version "1.6.0"\n  resolved "https://registry.yarnpkg.com/@fission-ai/openspec/-/openspec-1.6.0.tgz"\n  integrity ${OPENSPEC_PACKAGE_INTEGRITY}\n`;
  fs.writeFileSync(path.join(root, 'yarn.lock'), lock);
  fs.writeFileSync(path.join(root, '.yarnrc'), 'ignore-scripts true\n');
  assert.equal(
    verifyOpenSpecSupplyChain(root).integrity,
    OPENSPEC_PACKAGE_INTEGRITY,
  );
  assert.deepEqual(openSpecSupplyChainPaths(root), ['yarn.lock', '.yarnrc']);
  assert.equal(resolveOpenSpecInstallation(root).version, '1.6.0');
  fs.writeFileSync(
    path.join(root, 'yarn.lock'),
    lock.replace('version "1.6.0"', 'version "1.6.1"'),
  );
  assert.throws(() => verifyOpenSpecSupplyChain(root), /version/i);
});

test('Yarn Modern reports its own checksum honestly and supports node_modules installs', (t) => {
  const root = fixture(t, 'yarn@4.0.0');
  const checksum = `10c0/${'a'.repeat(128)}`;
  fs.writeFileSync(
    path.join(root, 'yarn.lock'),
    `__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"@fission-ai/openspec@npm:1.6.0":\n  version: 1.6.0\n  resolution: "@fission-ai/openspec@npm:1.6.0"\n  checksum: ${checksum}\n  languageName: node\n  linkType: hard\n`,
  );
  fs.writeFileSync(
    path.join(root, '.yarnrc.yml'),
    'nodeLinker: node-modules\nenableScripts: false\n',
  );
  assert.equal(
    verifyOpenSpecSupplyChain(root).integrity,
    `yarn-checksum:${checksum}`,
  );
  assert.deepEqual(openSpecSupplyChainPaths(root), [
    'yarn.lock',
    '.yarnrc.yml',
  ]);
  assert.equal(resolveOpenSpecInstallation(root).version, '1.6.0');
  fs.writeFileSync(
    path.join(root, '.yarnrc.yml'),
    'nodeLinker: pnp\nenableScripts: false\n',
  );
  assert.throws(() => verifyOpenSpecSupplyChain(root), /node-modules/i);
});

test('non-Node repositories and ambiguous unselected package managers have actionable diagnostics', (t) => {
  const root = fixture(t, 'npm@11.0.0');
  fs.unlinkSync(path.join(root, 'package.json'));
  assert.throws(() => verifyOpenSpecSupplyChain(root), /JavaScript|Node/i);
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  fs.writeFileSync(path.join(root, 'yarn.lock'), '');
  assert.throws(() => openSpecSupplyChainPaths(root), /packageManager/i);
});
