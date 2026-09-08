import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWorkItem,
  inspectWorkRegistryProjectionStatus,
  renderWorkRegistry,
  validateWorkRegistryProjections,
} from '../src/modules/governance-intake/work-registry.ts';

test('registry service preserves baseline projection bytes and recomputes drift', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'registry-projection-golden-'),
  );
  try {
    fs.mkdirSync(path.join(root, 'workflow'));
    for (const name of ['config.json', 'repository-consumer.json']) {
      fs.copyFileSync(
        new URL(`../../../workflow/${name}`, import.meta.url),
        path.join(root, 'workflow', name),
      );
    }
    createWorkItem(
      root,
      {
        schemaVersion: 1,
        kind: 'bug',
        lane: 'later',
        title: 'Exact projection',
        summary: 'Unicode 原文\nsecond line',
        sourceRefs: [],
      },
      {
        now: () => '2026-09-08T00:00:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000002',
      },
    );
    const output = renderWorkRegistry(root);
    // Captured from 1c4cf5e before migrating the writer to projection services.
    for (const [file, expected] of [
      [
        output.backlogPath,
        'd8c37f05867fcd648cd196a135ff2d4188d80d60f987fbb635e4683f0ff222bf',
      ],
      [
        output.inventoryPath,
        'c033172a05d2e0484b0135b031315c65ae8d096ae5db2bdcfd40dbe98aa4b463',
      ],
    ]) {
      assert.equal(
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(file!))
          .digest('hex'),
        expected,
      );
    }
    assert.equal(
      inspectWorkRegistryProjectionStatus(root).every(
        (row) => row.state === 'current',
      ),
      true,
    );
    fs.appendFileSync(output.backlogPath, '\nchanged');
    assert.equal(
      inspectWorkRegistryProjectionStatus(root).find(
        (row) => row.id === 'registry.backlog',
      )?.state,
      'drifted',
    );
    assert.throws(() => validateWorkRegistryProjections(root), {
      code: 'WORK_REGISTRY_PROJECTION_DRIFT',
    });
    const staleHistory = path.join(root, 'docs/work-history/2025.md');
    fs.mkdirSync(path.dirname(staleHistory), { recursive: true });
    fs.writeFileSync(staleHistory, 'stale');
    assert.equal(
      inspectWorkRegistryProjectionStatus(root).find((row) =>
        row.path.endsWith('/2025.md'),
      )?.state,
      'unexpected',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
