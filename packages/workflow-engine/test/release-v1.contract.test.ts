import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  assessCurrentJigwrightV1PublishReadiness,
  prepareCurrentJigwrightV1ReleaseCandidate,
  verifyCurrentJigwrightV1ReleaseCandidate,
} from '../../../scripts/prepare-current-jigwright-v1-release.ts';
import './single-package-release.contract.test.ts';

test('the v1 command prepares one current-only Jigwright package', () => {
  const workspaceManifest = readJson(path.resolve('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    workspaceManifest.scripts['jigwright:release-v1'],
    'node --experimental-strip-types scripts/prepare-current-jigwright-v1-release.ts --output dist/release-v1',
  );
  assert.equal(
    workspaceManifest.scripts['jigwright:release-workspace'],
    undefined,
  );
});

test('single-package v1 candidate binds reproducibility and stays fail closed for publish', () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-current-v1-release-'),
  );
  try {
    const candidate = prepareCurrentJigwrightV1ReleaseCandidate(
      process.cwd(),
      outputRoot,
      { allowDirty: true },
    );

    assert.equal(candidate.schemaVersion, 1);
    assert.equal(candidate.kind, 'jigwright-v1-single-package-candidate.v1');
    assert.equal(candidate.release.name, 'jigwright');
    assert.equal(candidate.release.version, '0.1.0');
    assert.match(candidate.release.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(candidate.packageBoundary.publicPackageIdentities, [
      'jigwright',
    ]);
    assert.equal(candidate.packageBoundary.externalDependencies, 0);
    assert.equal(candidate.packageBoundary.verified, true);
    assert.equal(candidate.reproducibility.identical, true);
    assert.equal(
      candidate.reproducibility.repeatedDigest,
      candidate.release.digest,
    );
    assert.equal(candidate.adoption.release.digest, candidate.release.digest);
    assert.equal(
      candidate.adoption.kind,
      'jigwright-current-local-adoption-report.v1',
    );
    assert.deepEqual(candidate.operationalGates, {
      implementation: 'implementation-ready',
      independentReview: 'independent-review-pending',
      signedProvenance: 'signed-provenance-pending',
      realPilot: 'real-pilot-pending',
      fullGate: 'full-gate-pending',
      registryPublish: 'not-requested',
    });
    assert.equal(candidate.publishReadiness.publishable, false);
    assert.deepEqual(candidate.publishReadiness.blockers, [
      ...(candidate.release.source.dirty ? ['clean-source-required'] : []),
      'license-decision-pending',
      'independent-review-pending',
      'signed-provenance-pending',
      'real-pilot-pending',
      'full-gate-pending',
      'registry-publish-not-requested',
    ]);
    assert.throws(
      () => assessCurrentJigwrightV1PublishReadiness(candidate, 'publish'),
      /not publishable/u,
    );

    for (const relativePath of [
      `package/${candidate.release.tarball}`,
      'adoption/report.json',
      'integrity.json',
      'provenance.intoto.json',
      'sbom.cdx.json',
      'release-candidate.json',
      'docs/API.md',
      'docs/OPERATIONS.md',
      'docs/COMPATIBILITY.md',
    ]) {
      assert.equal(fs.existsSync(path.join(outputRoot, relativePath)), true);
    }
    assert.equal(
      verifyCurrentJigwrightV1ReleaseCandidate(outputRoot).release.digest,
      candidate.release.digest,
    );

    const provenancePath = path.join(outputRoot, 'provenance.intoto.json');
    const provenanceBytes = fs.readFileSync(provenancePath);
    const provenance = readJson(provenancePath);
    provenance.subject[0].digest.sha256 = '0'.repeat(64);
    fs.writeFileSync(provenancePath, JSON.stringify(provenance));
    assert.throws(
      () => verifyCurrentJigwrightV1ReleaseCandidate(outputRoot),
      /provenance binding/u,
    );
    fs.writeFileSync(provenancePath, provenanceBytes);

    const sbomPath = path.join(outputRoot, 'sbom.cdx.json');
    const sbomBytes = fs.readFileSync(sbomPath);
    const sbom = readJson(sbomPath);
    sbom.components[0].name = 'tampered';
    fs.writeFileSync(sbomPath, JSON.stringify(sbom));
    assert.throws(
      () => verifyCurrentJigwrightV1ReleaseCandidate(outputRoot),
      /SBOM binding/u,
    );
    fs.writeFileSync(sbomPath, sbomBytes);

    const candidatePath = path.join(outputRoot, 'release-candidate.json');
    const candidateBytes = fs.readFileSync(candidatePath);
    const escaped = readJson(candidatePath);
    escaped.release.tarball = '../../outside.tgz';
    fs.writeFileSync(candidatePath, JSON.stringify(escaped));
    assert.throws(
      () => verifyCurrentJigwrightV1ReleaseCandidate(outputRoot),
      /candidate is invalid/u,
    );
    fs.writeFileSync(candidatePath, candidateBytes);

    fs.appendFileSync(
      path.join(outputRoot, 'package', candidate.release.tarball),
      'tampered',
    );
    assert.throws(
      () => verifyCurrentJigwrightV1ReleaseCandidate(outputRoot),
      /artifact digest/u,
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('jigwright init writes the default MVP profile once and never rewrites policy', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-v1-init-'),
  );
  try {
    const launcher = path.resolve(
      'packages/workflow-engine/bootstrap/jigwright-cli.mjs',
    );
    const first = spawnSync(process.execPath, [launcher, 'init', '--json'], {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr);
    const profilePath = path.join(
      repository,
      'workflow/jigwright-profile.json',
    );
    const before = fs.readFileSync(profilePath, 'utf8');
    const profile = JSON.parse(before);
    assert.equal(profile.ordinary.requiredIndependence, 'session-independent');
    assert.equal(profile.ordinary.providerMode, 'single-provider-allowed');
    assert.equal(profile.ordinary.perChangeAgentPlan, 'optional-override');
    assert.equal(
      profile.capabilities.grants,
      'optional-fail-closed-when-required',
    );
    assert.equal(profile.capabilities.workRegistry, 'consumer-owned');

    const second = spawnSync(process.execPath, [launcher, 'init', '--json'], {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(second.status, 12);
    assert.equal(
      JSON.parse(second.stderr).error.code,
      'JIGWRIGHT_INIT_ALREADY_CONFIGURED',
    );
    assert.equal(fs.readFileSync(profilePath, 'utf8'), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
