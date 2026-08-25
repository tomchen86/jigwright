import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createExactLocalPackageInvocation,
  runExactLocalPackageInvocation,
} from '../src/exact-local-package-invocation.ts';

test('invokes an exact local package entrypoint without PATH or a global binary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-local-pkg-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'portable-fixture', type: 'module' })}\n`,
    );
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src/cli.ts'),
      'process.stdout.write(JSON.stringify({argv: process.argv.slice(2)}));\n',
    );
    const invocation = createExactLocalPackageInvocation({
      packageRoot: root,
      entrypoint: 'src/cli.ts',
      args: ['guide', '--json'],
      cwd: root,
    });

    assert.equal(invocation.executable, process.execPath);
    assert.equal(invocation.args[0], '--experimental-strip-types');
    assert.equal(
      invocation.args[1],
      path.join(fs.realpathSync(root), 'src/cli.ts'),
    );
    assert.deepEqual(
      JSON.parse(
        runExactLocalPackageInvocation(invocation, { timeoutMs: 120_000 }),
      ),
      { argv: ['guide', '--json'] },
    );
    assert.throws(
      () => runExactLocalPackageInvocation(invocation, { timeoutMs: 0 }),
      /Exact local package invocation is invalid/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
