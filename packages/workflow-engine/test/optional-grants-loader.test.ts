import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { readModuleReferences } from './support/dependency-graph.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const ENGINE = path.resolve(import.meta.dirname, '..');
const LOADER = 'src/runtime/grants/optional-grants-package.ts';

test('optional loading refuses a missing package and retains a successful module', async () => {
  const missing = await createLoaderFixture();
  try {
    assert.throws(
      () =>
        missing.loader.selectCollaborationGrantSignatureNamespaceV1({
          version: 2,
          signatureNamespace: 'workflow.collaboration-grant.v2',
        }),
      { code: 'JIGWRIGHT_OPTIONAL_GRANTS_UNAVAILABLE' },
    );
  } finally {
    missing.close();
  }
  const fixture = await createLoaderFixture();
  try {
    fixture.install(
      'collaboration-grant-envelope-reader',
      'exports.selectCollaborationGrantSignatureNamespaceV1 = (value) => value.signatureNamespace;',
    );
    const payload = {
      version: 2 as const,
      signatureNamespace: 'workflow.collaboration-grant.v2' as const,
    };
    assert.equal(
      fixture.loader.selectCollaborationGrantSignatureNamespaceV1(payload),
      payload.signatureNamespace,
    );
    fs.rmSync(fixture.packageRoot, { recursive: true });
    assert.equal(
      fixture.loader.selectCollaborationGrantSignatureNamespaceV1(payload),
      payload.signatureNamespace,
    );
  } finally {
    fixture.close();
  }
});

test('optional loading preserves implementation errors and retries an unsuccessful load', async () => {
  const fixture = await createLoaderFixture();
  try {
    fixture.install(
      'grant-envelope-verifier',
      "throw Object.assign(new Error('dependency initialization failed'), { code: 'MODULE_NOT_FOUND' });",
    );
    assert.throws(() => fixture.loader.assertOptionalGrantsPackageAvailable(), {
      code: 'MODULE_NOT_FOUND',
      message: 'dependency initialization failed',
    });
    fixture.install('grant-envelope-verifier', 'module.exports = {};');
    assert.doesNotThrow(() =>
      fixture.loader.assertOptionalGrantsPackageAvailable(),
    );
    fixture.install(
      'signed-attestation-envelope-reader',
      'module.exports = {};',
    );
    assert.throws(
      () =>
        fixture.loader.canonicalSignedAttestationPayloadBytesV1(
          { version: 1 },
          {} as never,
        ),
      { code: 'JIGWRIGHT_OPTIONAL_GRANTS_EXPORT_INVALID' },
    );
  } finally {
    fixture.close();
  }
});

test('optional package calls are statically resolvable and canonical schema and codecs have pure closures', () => {
  const loader = path.join(ENGINE, LOADER);
  const refs = readModuleReferences(loader, fs.readFileSync(loader, 'utf8'));
  assert.equal(
    refs.some(({ specifier }) => specifier === null),
    false,
  );
  for (const name of [
    'grant-envelope-contracts',
    'grant-lifecycle-contracts',
    'collaboration-grant-envelope-codec',
    'signed-attestation-envelope-codec',
    'role-context-sharing-grant-codec',
  ]) {
    assertPureDependencyClosure(
      path.resolve(ENGINE, '../core/src', `${name}.ts`),
    );
  }
});

async function createLoaderFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-optional-loader-'),
  );
  const packageRoot = path.join(root, 'node_modules/@jigwright/grants');
  for (const relative of [LOADER, 'src/foundation/errors/errors.ts']) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(ENGINE, relative), path.join(root, relative));
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  fs.mkdirSync(path.join(root, 'node_modules/@jigwright'), { recursive: true });
  fs.symlinkSync(
    path.resolve(ENGINE, '../core'),
    path.join(root, 'node_modules/@jigwright/core'),
    'dir',
  );
  const loader = (await import(
    pathToFileURL(path.join(root, LOADER)).href
  )) as typeof import('../src/runtime/grants/optional-grants-package.ts');
  return {
    loader,
    packageRoot,
    install(subpath: string, source: string) {
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@jigwright/grants',
          exports: { './*': './*.cjs' },
        }) + '\n',
      );
      fs.writeFileSync(path.join(packageRoot, `${subpath}.cjs`), source + '\n');
    },
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
