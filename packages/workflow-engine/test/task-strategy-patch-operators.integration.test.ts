import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import {
  applyPatchToIsolatedTree,
  applyPatchToWorktree,
  createBinaryPatch,
  readRegularTreeEntry,
} from '../src/runtime/repository-transaction/task-strategy-patch-operators.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-operators-'));
  const git = (...args: string[]) =>
    cp
      .execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' })
      .trim();
  git('init', '-q');
  const put = (name: string, bytes: string | Buffer) =>
    fs.writeFileSync(path.join(root, name), bytes);
  put('modify.bin', Buffer.from([0, 255, 1]));
  put('delete.txt', 'deleted\n');
  put('mode.sh', 'echo mode\n');
  put('literal[1].txt', 'before\n');
  git('add', '.');
  const source = git('write-tree');
  put('modify.bin', Buffer.from([0, 128, 42, 255]));
  fs.rmSync(path.join(root, 'delete.txt'));
  put('add.bin', Buffer.from([0, 4, 255]));
  put('literal[1].txt', 'after\n');
  fs.chmodSync(path.join(root, 'mode.sh'), 0o755);
  git('add', '-A');
  const candidate = git('write-tree');
  const patch = createBinaryPatch(root, source, candidate);
  git('read-tree', '--reset', '-u', source);
  return {
    root,
    git,
    put,
    source,
    candidate,
    patch,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('real binary projection preserves index and worktree, exact diff round-trips add/delete/mode/literal paths', () => {
  const f = fixture();
  try {
    const index = fs.readFileSync(path.join(f.root, '.git/index'));
    const before = fs.readFileSync(path.join(f.root, 'modify.bin'));
    const projected = applyPatchToIsolatedTree(f.root, f.source, f.patch);
    assert.equal(projected.candidateTree, f.candidate);
    assert.deepEqual(projected.changedPaths, [
      'add.bin',
      'delete.txt',
      'literal[1].txt',
      'mode.sh',
      'modify.bin',
    ]);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'modify.bin')), before);
    assert.equal(fs.existsSync(path.join(f.root, 'add.bin')), false);
    const expected = cp.execFileSync('/usr/bin/git', [
      '-C',
      f.root,
      'diff',
      '--binary',
      '--full-index',
      '--no-renames',
      '--diff-algorithm=myers',
      f.source,
      f.candidate,
      '--',
    ]);
    assert.deepEqual(f.patch, expected);
    assert.equal(readRegularTreeEntry(f.root, f.source, 'missing'), null);
    assert.equal(readRegularTreeEntry(f.root, f.candidate, 'delete.txt'), null);
    assert.equal(
      readRegularTreeEntry(f.root, f.candidate, 'literal[1].txt')?.objectId,
      f.git('rev-parse', `${f.candidate}:literal[1].txt`),
    );
    assert.equal(readRegularTreeEntry(f.root, f.candidate, 'literal*'), null);
    const entry = readRegularTreeEntry(f.root, f.candidate, 'mode.sh');
    assert.equal(entry?.mode, '100755');
    assert.ok(Object.isFrozen(entry));
    applyPatchToWorktree(f.root, f.patch);
    assert.deepEqual(
      fs.readFileSync(path.join(f.root, 'modify.bin')),
      Buffer.from([0, 128, 42, 255]),
    );
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
    assert.equal(fs.statSync(path.join(f.root, 'mode.sh')).mode & 0o111, 0o111);
    applyPatchToWorktree(f.root, f.patch, true);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'modify.bin')), before);
    assert.equal(
      fs.readFileSync(path.join(f.root, 'literal[1].txt'), 'utf8'),
      'before\n',
    );
    assert.equal(fs.existsSync(path.join(f.root, 'add.bin')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'delete.txt')), true);
    assert.equal(fs.statSync(path.join(f.root, 'mode.sh')).mode & 0o111, 0);
  } finally {
    f.cleanup();
  }
});

test('real tree reader rejects symlink and gitlink without pathspec expansion', () => {
  const f = fixture();
  try {
    fs.symlinkSync('delete.txt', path.join(f.root, 'link'));
    f.git('add', 'link');
    f.git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'1'.repeat(40)},submodule`,
    );
    const tree = f.git('write-tree');
    for (const name of ['link', 'submodule'])
      assert.throws(() => readRegularTreeEntry(f.root, tree, name), {
        code: 'TASK_STRATEGY_PATCH_MODE_INVALID',
      });
  } finally {
    f.cleanup();
  }
});

for (const reverse of [false, true])
  test(`worktree apply failure preserves ${reverse ? 'reverse' : 'forward'} error and cleans temporary directory`, (t) => {
    const f = fixture();
    const directories: string[] = [];
    const mkdtemp = fs.mkdtempSync;
    t.mock.method(
      fs,
      'mkdtempSync',
      (...args: Parameters<typeof fs.mkdtempSync>) => {
        const dir = mkdtemp(...args);
        directories.push(String(dir));
        return dir;
      },
    );
    try {
      assert.throws(
        () =>
          applyPatchToWorktree(f.root, Buffer.from('invalid patch'), reverse),
        (error: unknown) => {
          assert.equal(
            (error as { code: string }).code,
            'TASK_STRATEGY_PATCH_IMPORT_FAILED',
          );
          assert.match(
            (error as Error).message,
            reverse ? /restored to its sealed RED/ : /applied to the exact RED/,
          );
          return true;
        },
      );
      assert.equal(directories.length, 1);
      assert.equal(fs.existsSync(directories[0]!), false);
    } finally {
      t.mock.restoreAll();
      f.cleanup();
    }
  });

for (const stage of ['read-tree', 'apply', 'write-tree', 'diff'] as const)
  test(`isolated projection failure at ${stage} preserves catch boundary and cleanup`, (t) => {
    const f = fixture();
    const directories: string[] = [];
    const spawn = cp.spawnSync,
      mkdtemp = fs.mkdtempSync;
    t.mock.method(
      fs,
      'mkdtempSync',
      (...args: Parameters<typeof fs.mkdtempSync>) => {
        const dir = mkdtemp(...args);
        directories.push(String(dir));
        return dir;
      },
    );
    t.mock.method(
      cp,
      'spawnSync',
      (...args: Parameters<typeof cp.spawnSync>) => {
        if (args[1]?.includes(stage))
          return {
            pid: 0,
            output: [null, '', 'injected'],
            stdout: '',
            stderr: 'injected',
            status: 1,
            signal: null,
          };
        return spawn(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      assert.throws(() => applyPatchToIsolatedTree(f.root, f.source, f.patch), {
        code:
          stage === 'apply'
            ? 'TASK_STRATEGY_PATCH_INVALID'
            : 'GIT_COMMAND_FAILED',
      });
      assert.equal(directories.length, 1);
      assert.equal(fs.existsSync(directories[0]!), false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      f.cleanup();
    }
  });

for (const operation of ['projection', 'worktree'] as const)
  for (const stage of ['mkdtemp', 'write', 'cleanup'] as const)
    test(`${operation} ${stage} error identity is outside apply catch`, (t) => {
      const f = fixture();
      const failure = new Error(stage);
      const dirs: string[] = [];
      const mkdtemp = fs.mkdtempSync;
      t.mock.method(
        fs,
        'mkdtempSync',
        (...args: Parameters<typeof fs.mkdtempSync>) => {
          if (stage === 'mkdtemp') throw failure;
          const dir = mkdtemp(...args);
          dirs.push(String(dir));
          return dir;
        },
      );
      if (stage === 'write')
        t.mock.method(fs, 'writeFileSync', () => {
          throw failure;
        });
      if (stage === 'cleanup')
        t.mock.method(fs, 'rmSync', () => {
          throw failure;
        });
      try {
        // Cleanup also overrides the wrapped invalid-patch error, exactly as finally did before extraction.
        assert.throws(
          () =>
            operation === 'projection'
              ? applyPatchToIsolatedTree(
                  f.root,
                  f.source,
                  Buffer.from('invalid'),
                )
              : applyPatchToWorktree(f.root, Buffer.from('invalid')),
          (error: unknown) => error === failure,
        );
        if (stage === 'write') assert.equal(fs.existsSync(dirs[0]!), false);
        if (stage === 'mkdtemp') assert.equal(dirs.length, 0);
      } finally {
        t.mock.restoreAll();
        for (const dir of dirs)
          fs.rmSync(dir, { recursive: true, force: true });
        f.cleanup();
      }
    });
