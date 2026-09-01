import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type {
  CurrentGrantVerifierPort,
  GrantVerifierPort,
} from '../src/grant-verifier-port.ts';

const packageRoot = path.resolve(import.meta.dirname, '..');

test('core owns the neutral Grant verifier port without an implementation dependency', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { exports?: Record<string, string> };
  assert.equal(
    manifest.exports?.['./grant-verifier-port'],
    './src/grant-verifier-port.ts',
  );

  const source = fs.readFileSync(
    path.join(packageRoot, 'src/grant-verifier-port.ts'),
    'utf8',
  );
  assert.match(source, /export type GrantVerifierPort = Readonly</);
  assert.match(
    source,
    /export type CurrentGrantVerifierPort = GrantVerifierPort/,
  );
  assert.doesNotMatch(source, /^[ \t]*import\b/m);
  assert.doesNotMatch(
    source,
    /^[ \t]*(?:export[ \t]+)?(?:const|let|var|function|class|enum|namespace)[ \t]+[A-Za-z_$]/m,
  );
  assert.doesNotMatch(source, /@jigwright\/grants|workflow-engine/);

  const verifier: GrantVerifierPort = {
    verify(payload, signature, identity, namespace) {
      assert.deepEqual(
        [payload, signature, identity, namespace],
        ['payload', 'signature', 'identity', 'namespace'],
      );
    },
  };
  const currentVerifier: CurrentGrantVerifierPort = {
    ...verifier,
    assertCurrent() {},
  };

  currentVerifier.verify('payload', 'signature', 'identity', 'namespace');
  currentVerifier.assertCurrent();
});
