import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCurrentJigwrightAdoption } from '../../../scripts/run-current-jigwright-adoption.ts';

test('the public adoption command is current-only and preserves the workspace rehearsal', () => {
  const workspaceManifest = JSON.parse(
    fs.readFileSync(path.resolve('package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  assert.equal(
    workspaceManifest.scripts['jigwright:adopt-local'],
    'node --experimental-strip-types scripts/run-current-jigwright-adoption.ts',
  );
  assert.equal(
    workspaceManifest.scripts['jigwright:adopt-workspace'],
    undefined,
  );
});

test('one exact Jigwright tarball bootstraps a fresh current-only consumer', () => {
  const adoptionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-current-adoption-'),
  );
  try {
    const report = runCurrentJigwrightAdoption(process.cwd(), adoptionRoot, {
      allowDirty: true,
    });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, 'jigwright-current-local-adoption-report.v1');
    assert.deepEqual(
      {
        kind: report.release.kind,
        name: report.release.name,
        version: report.release.version,
      },
      {
        kind: 'jigwright-single-package.v1',
        name: 'jigwright',
        version: '0.1.0',
      },
    );
    assert.match(report.release.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(report.install.publicPackageIdentities, ['jigwright']);
    assert.equal(report.install.networkPolicy, 'offline-exact-local-tarball');
    assert.equal(report.install.lifecycleScriptsDenied, true);
    assert.equal(report.install.lockfileVerified, true);
    assert.deepEqual(report.install.package, {
      name: 'jigwright',
      version: '0.1.0',
      digest: report.release.digest,
    });

    assert.equal(report.bootstrap.init.kind, 'jigwright-init-result.v1');
    assert.equal(report.bootstrap.init.status, 'initialized');
    assert.equal(
      report.bootstrap.repeatedInit.errorClass,
      'JIGWRIGHT_INIT_ALREADY_CONFIGURED',
    );
    assert.equal(report.bootstrap.policyUnchanged, true);
    assert.equal(report.bootstrap.guide, 'workflow-command-guide.v1');
    assert.deepEqual(report.publicSurfaces, {
      manifestV3: true,
      planReview: true,
      centralGrant: true,
    });
    assert.deepEqual(report.currentOnly, {
      historicalRuntimeState: 'unsupported',
      dualRun: 'retired',
      rollback: 'revert-consumer-cutover-commit',
    });
    assert.deepEqual(report.operationalGates, {
      implementation: 'implementation-ready',
      realPilot: 'real-pilot-pending',
      fullGate: 'full-gate-pending',
    });
    assert.equal('parity' in report, false);
    assert.equal('downgrade' in report, false);
    assert.equal(report.consumer.clean, true);
    assert.match(report.consumer.commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.match(report.consumer.tree, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
  } finally {
    fs.rmSync(adoptionRoot, { recursive: true, force: true });
  }
});
