import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateBuiltInEngineClosure } from '../bootstrap/generate-built-in-engine-closure.ts';
import { generateWorkflowBootstrapHost } from '../bootstrap/generate-workflow-bootstrap-host.ts';
import { rawDigest } from '../bootstrap/control-plane-bootstrap-values.ts';
import {
  verifyWorkflowBootstrapHost,
  workflowBootstrapHostPaths,
  WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT,
  WORKFLOW_BOOTSTRAP_HOST_MANIFEST_PATH,
  WORKFLOW_BOOTSTRAP_HOST_PIN_PATH,
} from '../bootstrap/workflow-bootstrap-host.ts';

function fixture(t: test.TestContext) {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-host-')),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const root = path.join(repository, 'packages/workflow-engine');
  const write = (relative: string, contents: string) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, { mode: 0o644 });
  };
  write('package.json', JSON.stringify({ name: 'jigwright', type: 'module' }));
  write('src/entrypoints/cli/workflow-cli.ts', 'export const cli = true;\n');
  for (const file of workflowBootstrapHostPaths()) write(file, 'export {};\n');
  generateBuiltInEngineClosure(repository, '--write');
  const generated = generateWorkflowBootstrapHost(repository, '--write');
  const verify = (digest = generated.manifestDigest) =>
    verifyWorkflowBootstrapHost(
      root,
      digest,
      generated.manifest.engineManifestDigest,
    );
  return { repository, root, write, generated, verify };
}

test('host generation roundtrip, exact inventory and read-only check', (t) => {
  const f = fixture(t);
  assert.equal(
    f.verify(),
    path.join(f.root, WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT),
  );
  assert.deepEqual(
    f.generated.manifest.files.map((entry) => entry.path),
    workflowBootstrapHostPaths(),
  );
  assert.ok(
    !workflowBootstrapHostPaths().includes(WORKFLOW_BOOTSTRAP_HOST_PIN_PATH),
  );
  const metadata = [
    WORKFLOW_BOOTSTRAP_HOST_MANIFEST_PATH,
    WORKFLOW_BOOTSTRAP_HOST_PIN_PATH,
  ];
  const before = metadata.map(
    (file) => fs.statSync(path.join(f.root, file)).mtimeMs,
  );
  assert.deepEqual(
    generateWorkflowBootstrapHost(f.repository, '--check'),
    f.generated,
  );
  assert.deepEqual(
    metadata.map((file) => fs.statSync(path.join(f.root, file)).mtimeMs),
    before,
  );
  f.write(WORKFLOW_BOOTSTRAP_HOST_PIN_PATH, '// stale pin\n');
  assert.throws(() => generateWorkflowBootstrapHost(f.repository, '--check'));
  assert.equal(
    fs.readFileSync(
      path.join(f.root, WORKFLOW_BOOTSTRAP_HOST_PIN_PATH),
      'utf8',
    ),
    '// stale pin\n',
  );
  assert.equal(
    f.verify(),
    path.join(f.root, WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT),
  );
});

test('trusted host and engine digests cannot be replaced by live metadata', (t) => {
  const f = fixture(t);
  assert.throws(() =>
    verifyWorkflowBootstrapHost(
      f.root,
      rawDigest('wrong'),
      f.generated.manifest.engineManifestDigest,
    ),
  );
  assert.throws(() =>
    verifyWorkflowBootstrapHost(
      f.root,
      f.generated.manifestDigest,
      rawDigest('other engine'),
    ),
  );
  f.write(WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT, 'export const changed = true;\n');
  assert.throws(() => f.verify());
  generateWorkflowBootstrapHost(f.repository, '--write');
  assert.throws(() => f.verify());
});

for (const corruption of [
  'missing',
  'extra',
  'duplicate',
  'traversal',
  'alias',
  'noncanonical',
  'unknown-key',
] as const) {
  test(`rejects ${corruption} manifest even with its supplied digest`, (t) => {
    const f = fixture(t);
    const manifest = JSON.parse(f.generated.manifestBytes);
    if (corruption === 'missing') manifest.files.pop();
    if (corruption === 'extra') manifest.files.push(manifest.files[0]);
    if (corruption === 'duplicate') manifest.files[1] = manifest.files[0];
    if (corruption === 'traversal') manifest.files[0].path = '../outside.ts';
    if (corruption === 'alias')
      manifest.files[0].path = 'bootstrap/./canonical-json.ts';
    if (corruption === 'unknown-key') manifest.untrusted = true;
    const bytes =
      corruption === 'noncanonical'
        ? JSON.stringify(manifest)
        : `${JSON.stringify(manifest, null, 2)}\n`;
    f.write(WORKFLOW_BOOTSTRAP_HOST_MANIFEST_PATH, bytes);
    assert.throws(() => f.verify(rawDigest(bytes)));
  });
}

for (const corruption of [
  'missing',
  'mode',
  'hardlink',
  'symlink',
  'parent-symlink',
] as const) {
  test(`refuses ${corruption} host filesystem before returning an executable`, (t) => {
    const f = fixture(t);
    const target = path.join(f.root, WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT);
    if (corruption === 'missing') fs.unlinkSync(target);
    if (corruption === 'mode') fs.chmodSync(target, 0o600);
    if (corruption === 'hardlink')
      fs.linkSync(target, path.join(f.root, 'alias'));
    if (corruption === 'symlink') {
      fs.renameSync(target, `${target}.real`);
      fs.symlinkSync(`${target}.real`, target);
    }
    if (corruption === 'parent-symlink') {
      fs.renameSync(
        path.join(f.root, 'bootstrap'),
        path.join(f.root, 'indirect'),
      );
      fs.symlinkSync('indirect', path.join(f.root, 'bootstrap'));
    }
    assert.throws(() => f.verify());
  });
}

test('host regeneration requires fresh engine artifacts and refuses unsafe outputs', (t) => {
  const f = fixture(t);
  f.write(
    'src/entrypoints/cli/workflow-cli.ts',
    'export const changed = true;\n',
  );
  assert.throws(() => generateWorkflowBootstrapHost(f.repository, '--write'));
  generateBuiltInEngineClosure(f.repository, '--write');
  const updated = generateWorkflowBootstrapHost(f.repository, '--write');
  assert.notEqual(
    updated.manifest.engineManifestDigest,
    f.generated.manifest.engineManifestDigest,
  );
  const pin = path.join(f.root, WORKFLOW_BOOTSTRAP_HOST_PIN_PATH);
  fs.linkSync(pin, `${pin}.alias`);
  assert.throws(() => generateWorkflowBootstrapHost(f.repository, '--write'));
});

for (const source of [
  "import './missing.ts';",
  "export * from './missing.ts';",
  "type Missing = import('./missing.ts').Missing;",
  "import missing = require('./missing.ts');",
  "void import('./missing.ts');",
  "require('./missing.ts');",
  "(require)('./missing.ts');",
  "const load = require; load('./missing.ts');",
  "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('./missing.cjs');",
  "import * as module from 'node:module'; module.createRequire(import.meta.url)('./missing.cjs');",
  "void import('node:module');",
  "const name = './canonical-json.ts'; void import(name);",
  "import 'unlisted-package';",
  "import './workflow-bootstrap-host-pin.ts';",
]) {
  test(`generator rejects incomplete dependency: ${source}`, (t) => {
    const f = fixture(t);
    f.write(WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT, `${source}\n`);
    assert.throws(
      () => generateWorkflowBootstrapHost(f.repository, '--write'),
      /bootstrap import/,
    );
  });
}

test('generator admits explicit host and independently pinned source dependencies', (t) => {
  const f = fixture(t);
  f.write(
    WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT,
    "import 'node:fs'; import './canonical-json.ts'; import '../src/entrypoints/cli/workflow-cli.ts';\n",
  );
  const generated = generateWorkflowBootstrapHost(f.repository, '--write');
  assert.equal(
    f.verify(generated.manifestDigest),
    path.join(f.root, WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT),
  );
});
