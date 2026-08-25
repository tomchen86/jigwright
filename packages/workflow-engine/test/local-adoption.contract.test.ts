import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runLocalJigwrightAdoption } from '../../../scripts/run-local-jigwright-adoption.ts';

test('local tarball consumer completes the read-only adoption and downgrade rehearsal', () => {
  const adoptionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-local-adoption-'),
  );
  try {
    const report = runLocalJigwrightAdoption(process.cwd(), adoptionRoot, {
      allowDirty: true,
    });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, 'jigwright-local-adoption-report.v1');
    assert.equal(report.install.networkPolicy, 'offline-local-tarballs');
    assert.equal(report.install.packageManager, 'pnpm@11.12.0');
    assert.equal(report.install.frozenLockfileVerified, true);
    assert.equal(report.release.packages.length, 6);
    assert.equal(
      report.release.packages.every(({ version }) => version === '0.1.0'),
      true,
    );
    assert.deepEqual(report.install.omittedOptionalPackages, [
      '@jigwright/github-adapter',
      '@jigwright/grants',
    ]);
    assert.deepEqual(
      report.install.packages.map(({ name }) => name),
      [
        '@jigwright/agent-runtime',
        '@jigwright/core',
        '@jigwright/openspec-adapter',
        'jigwright',
      ],
    );
    assert.equal(
      report.install.packages.every(({ version }) => version === '0.1.0'),
      true,
    );

    assert.equal(report.parity.schemaVersion, 1);
    assert.equal(report.parity.kind, 'jigwright-read-only-dual-run.v1');
    assert.deepEqual(
      report.parity.scenarios.map(({ id, domain }) => ({ id, domain })),
      [
        { id: 'guidance-catalog', domain: 'routing' },
        { id: 'current-task-history-list', domain: 'task-history' },
        { id: 'missing-current-task-history', domain: 'task-history' },
        {
          id: 'missing-current-change-validation',
          domain: 'planning',
        },
        { id: 'archived-change-namespace', domain: 'archive-history' },
        { id: 'execution-history-list', domain: 'execution-history' },
        { id: 'intake-history-list', domain: 'intake-history' },
        { id: 'concurrency-history-list', domain: 'concurrency-history' },
        {
          id: 'historical-ci-dependency-range',
          domain: 'historical-ci-replay',
        },
      ],
    );
    for (const { embedded, installed, equal } of report.parity.scenarios) {
      assert.equal(equal, true);
      assert.equal(installed.exitCode, embedded.exitCode);
      assert.deepEqual(installed.classification, embedded.classification);
      assert.deepEqual(installed.payload, embedded.payload);
    }
    assert.equal(report.parity.equal, true);
    assert.deepEqual(
      report.parity.scenarios.map(({ id, embedded }) => ({
        id,
        validation: embedded.classification.validation,
        errorClass: embedded.classification.errorClass,
      })),
      [
        {
          id: 'guidance-catalog',
          validation: 'accepted',
          errorClass: null,
        },
        {
          id: 'current-task-history-list',
          validation: 'accepted',
          errorClass: null,
        },
        {
          id: 'missing-current-task-history',
          validation: 'rejected',
          errorClass: 'SESSION_UNREADABLE',
        },
        {
          id: 'missing-current-change-validation',
          validation: 'rejected',
          errorClass: 'OPENSPEC_CHANGE_TREE_UNSAFE',
        },
        {
          id: 'archived-change-namespace',
          validation: 'rejected',
          errorClass: 'PLANNING_CHANGE_ID_RESERVED',
        },
        {
          id: 'execution-history-list',
          validation: 'accepted',
          errorClass: null,
        },
        {
          id: 'intake-history-list',
          validation: 'accepted',
          errorClass: null,
        },
        {
          id: 'concurrency-history-list',
          validation: 'accepted',
          errorClass: null,
        },
        {
          id: 'historical-ci-dependency-range',
          validation: 'rejected',
          errorClass: 'CI_COMMITTED_CHECKOUT_INVALID',
        },
      ],
    );
    assert.match(report.parity.reportDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      report.parity.reportPath,
      `reports/${report.parity.reportDigest.slice('sha256:'.length)}.json`,
    );
    assert.equal(
      fs.existsSync(path.join(adoptionRoot, report.parity.reportPath)),
      true,
    );

    assert.equal(report.grantBoundary.singleExecution, true);
    assert.equal(report.grantBoundary.humanInteractions, 0);
    assert.equal(report.grantBoundary.grantEffects, 0);
    assert.deepEqual(report.grantBoundary.installed.classification, {
      validation: 'rejected',
      resultClass: null,
      errorClass: 'JIGWRIGHT_OPTIONAL_GRANTS_UNAVAILABLE',
    });
    assert.deepEqual(report.cutover.observation.classification, {
      validation: 'accepted',
      resultClass: 'workflow-command-guide.v1',
      errorClass: null,
    });
    assert.deepEqual(report.downgrade.revertedCommits, [
      report.fixture.cutoverCommit,
      report.fixture.dependencyCommit,
    ]);
    assert.equal(report.downgrade.exactDependencyRemoved, true);
    assert.deepEqual(report.downgrade.observation.classification, {
      validation: 'accepted',
      resultClass: 'workflow-command-guide.v1',
      errorClass: null,
    });
    assert.deepEqual(report.deferred, {
      externalEffects: 'canonical-record-read-only-replay',
      operationalGates: ['full-gate', 'real-protected-pilot'],
      embeddedRemoval: 'separate-explicit-task',
    });
  } finally {
    fs.rmSync(adoptionRoot, { recursive: true, force: true });
  }
});
