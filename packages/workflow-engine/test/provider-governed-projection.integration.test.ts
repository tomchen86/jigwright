import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureGovernedProviderProjection,
  compareGovernedProviderProjections,
} from '../src/runtime/repository-transaction/git.ts';
import { createFixtureRepository, git } from './fixture.ts';
import { isWorkflowError } from './provider-adapter-fixture.ts';

test('governed projection names repository, planning, ref, index, ignored, and runtime drift', () => {
  const cases: Array<{
    expected: string;
    mutate(repository: string, runtimeInput: string): void;
  }> = [
    {
      expected: 'tracked-worktree',
      mutate(repository) {
        fs.writeFileSync(path.join(repository, 'src/.gitkeep'), 'changed\n');
      },
    },
    {
      expected: 'untracked-worktree',
      mutate(repository) {
        fs.writeFileSync(path.join(repository, 'src/untracked.ts'), 'new\n');
      },
    },
    {
      expected: 'ignored-worktree-manifest',
      mutate(repository) {
        fs.mkdirSync(path.join(repository, 'node_modules/new-package'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(repository, 'node_modules/new-package/index.js'),
          'ignored\n',
        );
      },
    },
    {
      expected: 'index',
      mutate(repository) {
        fs.writeFileSync(path.join(repository, 'src/staged.ts'), 'staged\n');
        git(repository, ['add', 'src/staged.ts']);
      },
    },
    {
      expected: 'refs',
      mutate(repository) {
        const head = git(repository, ['rev-parse', 'HEAD']).trim();
        git(repository, ['update-ref', 'refs/heads/provider-drift', head]);
        git(repository, ['symbolic-ref', 'HEAD', 'refs/heads/provider-drift']);
      },
    },
    {
      expected: 'git-control',
      mutate(repository) {
        git(repository, ['config', 'provider.test-control', 'changed']);
      },
    },
    {
      expected: 'git-control',
      mutate(repository) {
        const infoDirectory = path.join(repository, '.git', 'objects', 'info');
        fs.mkdirSync(infoDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(infoDirectory, 'alternates'),
          '/tmp/untrusted-object-store\n',
        );
      },
    },
    {
      expected: 'git-control',
      mutate(repository) {
        const head = `${git(repository, ['rev-parse', 'HEAD']).trim()}\n`;
        for (const pseudoref of ['FETCH_HEAD', 'MERGE_HEAD', 'REBASE_HEAD']) {
          fs.writeFileSync(path.join(repository, '.git', pseudoref), head);
        }
      },
    },
    {
      expected: 'planning-artifacts',
      mutate(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/design.md'),
          '\nchanged\n',
        );
      },
    },
    {
      expected: 'governed-runtime-inputs',
      mutate(_repository, runtimeInput) {
        fs.writeFileSync(runtimeInput, 'changed runtime input\n');
      },
    },
  ];

  for (const { expected, mutate } of cases) {
    const repository = createFixtureRepository();
    const runtimeDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'provider-runtime-input-'),
    );
    const runtimeInput = path.join(runtimeDirectory, 'request.json');
    try {
      fs.writeFileSync(runtimeInput, '{"request":"original"}\n');
      const before = captureGovernedProviderProjection(repository, [
        { id: 'request', path: runtimeInput },
      ]);
      mutate(repository, runtimeInput);
      const after = captureGovernedProviderProjection(repository, [
        { id: 'request', path: runtimeInput },
      ]);
      const comparison = compareGovernedProviderProjections(before, after);

      assert.equal(comparison.unchanged, false, expected);
      assert.ok(
        comparison.changedCategories.includes(expected),
        `${expected}: ${comparison.changedCategories.join(', ')}`,
      );
      assert.notEqual(comparison.beforeDigest, comparison.afterDigest);
    } finally {
      fs.rmSync(runtimeDirectory, { recursive: true, force: true });
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('governed refs projection binds symbolic-ref targets at the same object', () => {
  const repository = createFixtureRepository();
  try {
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['update-ref', 'refs/heads/provider-alternate', head]);
    const before = captureGovernedProviderProjection(repository);
    git(repository, ['symbolic-ref', 'HEAD', 'refs/heads/provider-alternate']);
    const after = captureGovernedProviderProjection(repository);

    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, false);
    assert.ok(comparison.changedCategories.includes('refs'));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed refs projection ignores unrelated shared refs during linked-worktree activity', () => {
  const repository = createFixtureRepository();
  const linkedParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-concurrent-worktree-'),
  );
  const linked = path.join(linkedParent, 'linked');
  try {
    git(repository, ['worktree', 'add', '-b', 'concurrent-task', linked]);
    const before = captureGovernedProviderProjection(repository);

    fs.writeFileSync(path.join(linked, 'concurrent-change.txt'), 'changed\n');
    git(linked, ['add', 'concurrent-change.txt']);
    git(linked, ['commit', '-m', 'Advance unrelated concurrent task']);
    // Shared refs that are not selected by this worktree are outside the
    // accidental-drift tripwire, including remote-tracking activity.
    git(repository, [
      'update-ref',
      'refs/remotes/origin/concurrent-task',
      git(linked, ['rev-parse', 'HEAD']).trim(),
    ]);

    const after = captureGovernedProviderProjection(repository);
    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, true);
    assert.deepEqual(comparison.changedCategories, []);
  } finally {
    if (fs.existsSync(linked)) {
      git(repository, ['worktree', 'remove', '--force', linked]);
    }
    fs.rmSync(linkedParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed Git control rejects symlinked control roots', () => {
  const repository = createFixtureRepository();
  const hookTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-hooks-'));
  try {
    const hooks = path.join(repository, '.git', 'hooks');
    fs.rmSync(hooks, { recursive: true, force: true });
    fs.symlinkSync(hookTarget, hooks);

    assert.throws(
      () => captureGovernedProviderProjection(repository),
      (error) => isWorkflowError(error, 'GOVERNED_PROJECTION_FAILED'),
    );
  } finally {
    fs.rmSync(hookTarget, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed runtime directory policy rejects the bare parent segment', () => {
  const repository = createFixtureRepository();
  const runtimeDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-runtime-policy-'),
  );
  try {
    for (const mutableContentPaths of [[], ['..']]) {
      assert.throws(
        () =>
          captureGovernedProviderProjection(repository, [
            {
              id: 'semantic-output',
              path: runtimeDirectory,
              kind: 'directory-closure',
              expectedFiles: ['..'],
              mutableContentPaths,
            },
          ]),
        (error) => isWorkflowError(error, 'GOVERNED_PROJECTION_FAILED'),
      );
    }
  } finally {
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed Git control binds common-dir rerere state from a linked worktree', () => {
  const repository = createFixtureRepository();
  const linkedParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-linked-worktree-'),
  );
  const linked = path.join(linkedParent, 'linked');
  try {
    git(repository, ['worktree', 'add', '-b', 'provider-linked', linked]);
    const before = captureGovernedProviderProjection(linked);
    const rerere = path.join(
      repository,
      '.git',
      'rr-cache',
      '0123456789abcdef',
    );
    fs.mkdirSync(rerere, { recursive: true });
    fs.writeFileSync(path.join(rerere, 'preimage'), 'conflict\n');
    const after = captureGovernedProviderProjection(linked);

    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, false);
    assert.ok(comparison.changedCategories.includes('git-control'));
  } finally {
    if (fs.existsSync(linked)) {
      git(repository, ['worktree', 'remove', '--force', linked]);
    }
    fs.rmSync(linkedParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
