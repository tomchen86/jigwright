import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import {
  dismissGovernanceFinding,
  listGovernanceFindings,
  recordGovernanceFinding,
} from '../src/composition-root/governance-findings-production.ts';
import {
  createGovernancePersistenceFixture,
  runGitForTest,
  hasCode,
} from './governance-intake-fixture.ts';

test('ordinary clone retains immutable Findings and receipts without task-tree files', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-finding-clone-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    dismissGovernanceFinding(
      fixture.runtimeRoot,
      fixture.finding.finding.id,
      'Resolved before sharing the repository.',
      () => '2026-08-24T04:00:00.000Z',
    );
    const original = listGovernanceFindings(fixture.runtimeRoot);
    const clone = path.join(root, 'clone');
    runGitForTest(root, ['clone', fixture.repositoryRoot, clone]);
    fs.rmSync(fixture.repositoryRoot, { recursive: true });
    fs.rmSync(path.join(root, 'git-common'), { recursive: true, force: true });
    const runtimeRoot = path.join(clone, '.git', 'jigwright-runtime');
    const refsBeforeRead = runGitForTest(clone, ['show-ref']);
    assert.deepEqual(listGovernanceFindings(runtimeRoot), original);
    assert.equal(runGitForTest(clone, ['show-ref']), refsBeforeRead);
    assert.equal(fs.existsSync(runtimeRoot), false);
    const taskHead = runGitForTest(clone, ['rev-parse', 'HEAD']);
    const indexTree = runGitForTest(clone, ['write-tree']);
    const recorded = recordGovernanceFinding(
      { ...fixture.findingContext, repositoryRoot: clone, runtimeRoot },
      { schemaVersion: 1, text: '  A note in the clone.\n', sourceRefs: [] },
      () => '2026-08-24T04:01:00.000Z',
    );
    assert.equal(recorded.finding.text, '  A note in the clone.\n');
    assert.equal(runGitForTest(clone, ['rev-parse', 'HEAD']), taskHead);
    assert.equal(runGitForTest(clone, ['write-tree']), indexTree);
    assert.equal(runGitForTest(clone, ['status', '--porcelain']), '');
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'findings')), false);
    assert.equal(
      dismissGovernanceFinding(
        runtimeRoot,
        fixture.finding.finding.id,
        'Resolved before sharing the repository.',
      ).created,
      false,
    );
    const secondClone = path.join(root, 'second-clone');
    runGitForTest(root, ['clone', clone, secondClone]);
    assert.deepEqual(
      listGovernanceFindings(
        path.join(secondClone, '.git', 'jigwright-runtime'),
      ),
      listGovernanceFindings(runtimeRoot),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Finding writes merge remote divergence and preserve conflicting terminal receipts', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-finding-divergence-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const clone = path.join(root, 'clone');
    runGitForTest(root, ['clone', fixture.repositoryRoot, clone]);
    const runtimeRoot = path.join(clone, '.git', 'jigwright-runtime');
    const add = (repositoryRoot: string, runtimeRoot: string, text: string) =>
      recordGovernanceFinding(
        { ...fixture.findingContext, repositoryRoot, runtimeRoot },
        { schemaVersion: 1, text, sourceRefs: [] },
        () => '2026-08-24T04:01:00.000Z',
      );
    add(fixture.repositoryRoot, fixture.runtimeRoot, 'Captured upstream.');
    add(clone, runtimeRoot, 'Captured in the clone.');
    runGitForTest(clone, ['fetch', 'origin']);
    assert.equal(listGovernanceFindings(runtimeRoot).length, 3);
    add(clone, runtimeRoot, 'Publish the combined records.');
    const next = path.join(root, 'next');
    runGitForTest(root, ['clone', clone, next]);
    assert.equal(
      listGovernanceFindings(path.join(next, '.git', 'jigwright-runtime'))
        .length,
      4,
    );
    dismissGovernanceFinding(
      fixture.runtimeRoot,
      fixture.finding.finding.id,
      'Upstream decision.',
    );
    dismissGovernanceFinding(
      runtimeRoot,
      fixture.finding.finding.id,
      'Local decision.',
    );
    runGitForTest(clone, ['fetch', 'origin']);
    const refs = runGitForTest(clone, ['show-ref']);
    assert.throws(
      () => listGovernanceFindings(runtimeRoot),
      hasCode('GOVERNANCE_FINDING_DISPOSITION_COLLISION'),
    );
    assert.equal(runGitForTest(clone, ['show-ref']), refs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent Finding writers converge through Git ref CAS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-finding-cas-'));
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const moduleUrl = new URL(
      '../src/composition-root/governance-findings-production.ts',
      import.meta.url,
    ).href;
    const run = (expression: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--experimental-strip-types',
            '--input-type=module',
            '--eval',
            `import {recordGovernanceFinding, dismissGovernanceFinding} from ${JSON.stringify(moduleUrl)}; ${expression}`,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(stderr)),
        );
      });
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        run(
          `recordGovernanceFinding(${JSON.stringify(fixture.findingContext)}, {schemaVersion:1,text:'Concurrent note ${index}',sourceRefs:[]}, ()=>'2026-08-24T04:01:00.000Z');`,
        ),
      ),
    );
    assert.equal(listGovernanceFindings(fixture.runtimeRoot).length, 5);
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        run(
          `dismissGovernanceFinding(${JSON.stringify(fixture.runtimeRoot)}, ${JSON.stringify(fixture.finding.finding.id)}, 'Same terminal decision.', ()=>'2026-08-24T04:02:0${index}.000Z');`,
        ),
      ),
    );
    const finding = listGovernanceFindings(fixture.runtimeRoot).find(
      ({ id }) => id === fixture.finding.finding.id,
    )!;
    assert.equal(finding.disposition, 'dismissed');
    assert.equal(finding.reason, 'Same terminal decision.');
    assert.equal(
      runGitForTest(fixture.repositoryRoot, ['status', '--porcelain']),
      '',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
