import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  resolveParentInterventionFence,
  assertParentInterventionFenceCleared,
} from '../bootstrap/control-plane-bootstrap-local.ts';
import { dispatchBootstrapInterventionCommand } from '../src/entrypoints/cli/intervention-control-bootstrap-cli.ts';
import {
  metadataFixture,
  humanDependencies,
  writeRecord,
  withDigest,
} from './intervention-metadata-fixture.ts';

for (const binding of ['active', 'adopted'] as const) {
  test(`existing ${binding} metadata keeps the parent fenced until signed disposition`, () => {
    const f = metadataFixture(binding);
    try {
      const identity = {
        worktreeRoot: f.repositoryRoot,
        branchRef: 'refs/heads/work/parent-A',
      };
      const before = f.protectedBytes();
      const fence = resolveParentInterventionFence(f.stateRoot, identity);
      assert.equal(fence?.checkpointId, f.checkpoint.checkpointId);
      assert.throws(() => assertParentInterventionFenceCleared(fence), {
        code: 'WORKFLOW_PARENT_INTERVENTION_BLOCKED',
      });
      assert.equal(
        dispatchBootstrapInterventionCommand(
          ['status', 'parent-A'],
          f.repositoryRoot,
        ).effectsPerformed,
        false,
      );
      assert.deepEqual(
        resolveParentInterventionFence(f.stateRoot, identity),
        fence,
      );
      dispatchBootstrapInterventionCommand(
        [
          'change',
          'revoke-intervention',
          'parent-A',
          '--reason',
          'Retire repair',
        ],
        f.repositoryRoot,
        humanDependencies().dependencies,
      );
      assert.equal(resolveParentInterventionFence(f.stateRoot, identity), null);
      assert.deepEqual(f.protectedBytes(), before);
      assert.equal(fs.existsSync(f.marker), false);
    } finally {
      f.cleanup();
    }
  });
}
test('parent fence rejects a digest-valid checkpoint identity mismatch', () => {
  const f = metadataFixture();
  try {
    writeRecord(
      f.interventionFile,
      withDigest({
        ...f.intervention,
        parent: { ...f.intervention.parent, changeId: 'different-parent' },
      }),
    );
    assert.throws(
      () =>
        resolveParentInterventionFence(f.stateRoot, {
          worktreeRoot: f.repositoryRoot,
          branchRef: 'refs/heads/work/parent-A',
        }),
      { code: 'WORKFLOW_PARENT_INTERVENTION_FENCE_CORRUPT' },
    );
  } finally {
    f.cleanup();
  }
});

test('workflow launcher enforces the parent fence and routes sealed status before signed disposition', () => {
  const f = metadataFixture('adopted');
  try {
    const before = f.protectedBytes();
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.resolve(
            import.meta.dirname,
            '../bootstrap/workflow-launcher.ts',
          ),
          ...args,
        ],
        {
          cwd: f.repositoryRoot,
          encoding: 'utf8',
          env: { ...process.env, JIGWRIGHT_WORKTREE_ROOT: f.repositoryRoot },
        },
      );
    const blocked = run(['open-task', 'parent-A', '--json']);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /WORKFLOW_PARENT_INTERVENTION_BLOCKED/);
    const status = run(['intervention', 'status', 'parent-A', '--json']);
    assert.equal(status.status, 0, status.stderr);
    const response = JSON.parse(status.stdout);
    assert.equal(response.result.action, 'status');
    assert.equal(response.result.effectsPerformed, false);
    dispatchBootstrapInterventionCommand(
      [
        'change',
        'revoke-intervention',
        'parent-A',
        '--reason',
        'Retire repair',
      ],
      f.repositoryRoot,
      humanDependencies().dependencies,
    );
    const resumed = run(['--help']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /Usage:/);
    assert.equal(fs.existsSync(f.marker), false);
    assert.deepEqual(f.protectedBytes(), before);
  } finally {
    f.cleanup();
  }
});
