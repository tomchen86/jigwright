import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import { listGovernanceFindings } from '../src/composition-root/governance-findings-production.ts';
import {
  createGovernancePersistenceFixture,
  snapshotGovernancePersistence,
} from './governance-intake-fixture.ts';

test('Finding links an existing Work Item once without creating another inbox item', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-finding-item-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const before = snapshotGovernancePersistence(fixture);
    const link = (workItemId: string) =>
      dispatchGovernanceIntakeCommand(
        'finding',
        ['link', fixture.finding.finding.id, '--work-item', workItemId],
        fixture.repositoryRoot,
        {
          resolveRuntimeRoot: () => fixture.runtimeRoot,
          now: () => '2026-09-08T00:00:00.000Z',
        },
      );
    assert.throws(
      () => link('WORK-01K39R0V000000000000000099'),
      /exactly one stable path/,
    );
    assert.deepEqual(snapshotGovernancePersistence(fixture), before);
    const linked = link(fixture.item.item.id);
    assert.equal(linked.created, true);
    assert.equal(linked.originalText, fixture.finding.finding.text);
    assert.equal(linked.title, fixture.item.item.title);
    assert.equal(link(fixture.item.item.id).created, false);
    const [finding] = listGovernanceFindings(fixture.runtimeRoot);
    assert.equal(finding?.disposition, 'linked');
    assert.deepEqual(finding?.target, {
      kind: 'work-item',
      id: fixture.item.item.id,
    });
    const after = snapshotGovernancePersistence(fixture);
    assert.notEqual(after.refs, before.refs);
    assert.deepEqual(
      { ...after, refs: before.refs, findings: before.findings },
      before,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
