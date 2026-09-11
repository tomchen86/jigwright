import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { authorityAuditUsage } from '../src/entrypoints/cli/authority-audit-cli.ts';

const cli = fileURLToPath(
  new URL('../src/entrypoints/cli/workflow-cli.ts', import.meta.url),
);

test('audit input failures retain exact human and JSON stderr and usage exit', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-errors-'));
  try {
    const human = spawnSync(
      process.execPath,
      ['--experimental-strip-types', cli, 'audit'],
      { cwd, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    );
    assert.equal(human.status, 2, human.stderr);
    assert.equal(human.stdout, '');
    assert.equal(
      human.stderr,
      `Jigwright\n\nCode: AUTHORITY_AUDIT_USAGE\n${authorityAuditUsage()}\n\nRun: pnpm workflow guide --json\n\n`,
    );
    const json = spawnSync(
      process.execPath,
      ['--experimental-strip-types', cli, 'audit', '--json'],
      { cwd, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    );
    assert.equal(json.status, 2, json.stderr);
    assert.equal(json.stdout, '');
    assert.deepEqual(JSON.parse(json.stderr), {
      ok: false,
      error: {
        code: 'AUTHORITY_AUDIT_USAGE',
        message: authorityAuditUsage(),
        recovery: 'pnpm workflow guide --json',
      },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('cold help from outside a repository performs no repository discovery or audit input observations', () => {
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-help-')),
  );
  const preload = path.join(cwd, 'forbid-observations.mjs');
  fs.writeFileSync(
    preload,
    `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const cwd = process.cwd();
    for (const name of ['spawnSync', 'spawn', 'execFileSync', 'execSync']) {
      childProcess[name] = () => { throw new Error('Unexpected cold-help subprocess: ' + name); };
    }
    for (const name of ['realpathSync', 'lstatSync', 'statSync', 'openSync', 'readFileSync']) {
      const original = fs[name];
      fs[name] = function(input, ...rest) {
        if (typeof input === 'string' && (input === cwd || input.startsWith(cwd + '/'))) {
          throw new Error('Unexpected cold-help repository/input read: ' + name);
        }
        return original.call(this, input, ...rest);
      };
    }
    syncBuiltinESMExports();
  `,
  );
  try {
    for (const args of [['help'], ['help', '--json']]) {
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--import', preload, cli, ...args],
        {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, NODE_NO_WARNINGS: '1', PATH: '' },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /audit/u);
      if (args.includes('--json'))
        assert.equal(JSON.parse(result.stdout).ok, true);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
