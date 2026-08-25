import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildLocalJigwrightRelease,
  parseJigwrightReleaseCompatibilityMatrix,
  verifyJigwrightReleaseCompatibilityMatrix,
} from '../../../scripts/build-local-jigwright-release.ts';
import {
  applyVerifiedJigwrightV1ReleaseEvidence,
  assessJigwrightV1PublishReadiness,
  JIGWRIGHT_V1_RELEASE_EVIDENCE_SIGNATURE_NAMESPACE,
  jigwrightV1ReleaseEvidenceSubject,
  prepareJigwrightV1ReleaseCandidate,
  verifyJigwrightV1ReleaseEvidenceObject,
} from '../../../scripts/prepare-jigwright-v1-release.ts';
import { canonicalJson } from '../../core/src/canonical-json.ts';
import { createSshSignedFixture } from './support/ssh-signed-fixture.ts';

const packageNames = [
  '@jigwright/agent-runtime',
  '@jigwright/core',
  '@jigwright/github-adapter',
  '@jigwright/grants',
  '@jigwright/openspec-adapter',
  'jigwright',
] as const;

test('v1 release artifacts are reproducible, exact, and supply-chain described', () => {
  const firstRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-v1-release-first-'),
  );
  const secondRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-v1-release-second-'),
  );
  try {
    const first = buildLocalJigwrightRelease(process.cwd(), firstRoot, {
      allowDirty: true,
      releaseChannel: 'local-candidate',
    });
    const second = buildLocalJigwrightRelease(process.cwd(), secondRoot, {
      allowDirty: true,
      releaseChannel: 'local-candidate',
    });

    assert.equal(first.kind, 'jigwright-release-compatibility-matrix.v1');
    assert.deepEqual(
      first.packages.map(({ name }) => name),
      packageNames,
    );
    assert.deepEqual(
      first.packages.map(({ name, version, digest }) => ({
        name,
        version,
        digest,
      })),
      second.packages.map(({ name, version, digest }) => ({
        name,
        version,
        digest,
      })),
    );
    assert.equal(first.packageSetDigest, second.packageSetDigest);
    assert.equal(first.lockfile.digest, second.lockfile.digest);
    assert.equal(first.runtime.node, '>=22.22.1 <23');
    assert.equal(first.runtime.packageManager, 'pnpm@11.12.0');
    assert.equal(first.policies.lifecycleScripts, 'denied');
    assert.equal(first.policies.globalBinaryFallback, 'denied');
    assert.equal(first.policies.floatingNpxFallback, 'denied');
    assert.equal(first.policies.gitlinkDistribution, 'denied');
    assert.deepEqual(first.optionalPackages, [
      '@jigwright/github-adapter',
      '@jigwright/grants',
    ]);
    assert.equal(first.publicContracts.manifestV3.schemaVersion, 3);
    assert.deepEqual(first.publicContracts.manifestV3.validationApis, [
      'validateDraftForSeal',
      'validateForAuthority',
      'inspectHistorical',
    ]);
    assert.equal(first.publicContracts.planReview.separateAuthority, true);
    assert.equal(
      first.publicContracts.guidance.catalog,
      'workflow-command-guide.v1',
    );
    assert.equal(
      first.publicContracts.guidance.nextSteps,
      'workflow-next-steps.v1',
    );
    assert.equal(
      first.publicContracts.guidance.failureRecovery,
      'workflow-failure-recovery.v1',
    );
    assert.equal(first.publicContracts.guidance.sameSource, true);
    assert.equal(first.publicContracts.centralGrant.legacyIssuance, 'denied');
    assert.equal(first.composition.grantPolicy.schemaVersion, 2);
    assert.equal(first.composition.humanGate.version, '1');
    assert.match(first.composition.humanGate.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(first.composition.humanGate.platforms, [
      'darwin-arm64',
      'darwin-x64',
    ]);
    assert.equal(first.composition.sshProof.humanSelectedAlternative, true);

    for (const relativePath of [
      'compatibility-matrix.json',
      'integrity.json',
      'provenance.intoto.json',
      'sbom.cdx.json',
      'extraction-sequence.json',
      'docs/API.md',
      'docs/OPERATIONS.md',
      'docs/COMPATIBILITY.md',
    ]) {
      assert.equal(fs.existsSync(path.join(firstRoot, relativePath)), true);
    }
    const operations = fs.readFileSync(
      path.join(firstRoot, 'docs/OPERATIONS.md'),
      'utf8',
    );
    assert.match(
      operations,
      /jigwright-v1-release-readiness-evidence\.v1.*objects\/sha256\/<digest>\.json/su,
    );
    assert.match(
      operations,
      /never creates a signature, runs a pilot or full gate, chooses a license, publishes, or accesses a remote/u,
    );
    const integrity = readJson(path.join(firstRoot, 'integrity.json'));
    for (const entry of first.packages) {
      assert.equal(
        integrity.artifacts[entry.tarball],
        digestFile(path.join(firstRoot, entry.tarball)),
      );
    }
    const provenance = readJson(path.join(firstRoot, 'provenance.intoto.json'));
    assert.equal(provenance._type, 'https://in-toto.io/Statement/v1');
    assert.equal(
      provenance.predicate.buildDefinition.externalParameters.releaseChannel,
      'local-candidate',
    );
    assert.equal(provenance.predicate.runDetails.attestation, 'unsigned-local');
    const sbom = readJson(path.join(firstRoot, 'sbom.cdx.json'));
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.deepEqual(
      sbom.components.map((component: { name: string }) => component.name),
      packageNames,
    );
    assert.match(sbom.components[0].purl, /^pkg:npm\//u);
    assert.equal(
      sbom.components.find(({ name }: { name: string }) => name === 'jigwright')
        .licenses[0].license.name,
      'UNLICENSED',
    );

    const parsed = parseJigwrightReleaseCompatibilityMatrix(
      fs.readFileSync(
        path.join(firstRoot, 'compatibility-matrix.json'),
        'utf8',
      ),
    );
    assert.equal(parsed.packageSetDigest, first.packageSetDigest);
    assert.throws(
      () =>
        parseJigwrightReleaseCompatibilityMatrix(
          JSON.stringify({ ...parsed, schemaVersion: 2 }),
        ),
      /unsupported/u,
    );
    assert.throws(
      () =>
        buildLocalJigwrightRelease(process.cwd(), firstRoot, {
          allowDirty: true,
          releaseChannel: 'local-candidate',
        }),
      /new empty directory/u,
    );
  } finally {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

test('v1 compatibility verification recomputes every public contract and composition binding', () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-v1-compatibility-verifier-'),
  );
  try {
    const matrix = buildLocalJigwrightRelease(process.cwd(), outputRoot, {
      allowDirty: true,
      releaseChannel: 'local-candidate',
    });
    const verification = {
      repositoryRoot: process.cwd(),
      releaseRoot: outputRoot,
    } as const;
    const verified = verifyJigwrightReleaseCompatibilityMatrix(
      JSON.stringify(matrix),
      verification,
    );
    assert.equal(
      verified.publicContracts.centralGrant.canonicalRecord,
      'grant-record.v1',
    );

    const tamperCases: readonly Readonly<{
      name: string;
      mutate: (candidate: any) => void;
    }>[] = [
      {
        name: 'manifest public contract',
        mutate: (candidate) => {
          candidate.publicContracts.manifestV3.validationApis[0] =
            'tamperedValidation';
        },
      },
      {
        name: 'PlanReview public contract',
        mutate: (candidate) => {
          candidate.publicContracts.planReview.contractVersion = 2;
        },
      },
      {
        name: 'guidance public contract',
        mutate: (candidate) => {
          candidate.publicContracts.guidance.catalogVersion = 'tampered';
        },
      },
      {
        name: 'Agent Runtime public contract',
        mutate: (candidate) => {
          candidate.publicContracts.agentRuntime.engineEnvelope = 'tampered';
        },
      },
      {
        name: 'Central Grant record identity',
        mutate: (candidate) => {
          candidate.publicContracts.centralGrant.canonicalRecord =
            'canonical-grant-record.v1';
        },
      },
      {
        name: 'package version composition',
        mutate: (candidate) => {
          candidate.composition.packageVersions['@jigwright/core'] = '9.9.9';
        },
      },
      {
        name: 'package integrity composition',
        mutate: (candidate) => {
          candidate.composition.packageIntegrities['@jigwright/core'] =
            validTamperedDigest();
        },
      },
      {
        name: 'GrantPolicyV2 binding',
        mutate: (candidate) => {
          candidate.composition.grantPolicy.digest = validTamperedDigest();
        },
      },
      {
        name: 'TransitionRegistry binding',
        mutate: (candidate) => {
          candidate.composition.transitionRegistry.sourceDigest =
            validTamperedDigest();
        },
      },
      {
        name: 'protected capability binding',
        mutate: (candidate) => {
          candidate.composition.protectedCapabilities.schemaVersion = 2;
        },
      },
      {
        name: 'Human Gate native artifact binding',
        mutate: (candidate) => {
          candidate.composition.humanGate.digest = validTamperedDigest();
        },
      },
      {
        name: 'Human Gate platform matrix',
        mutate: (candidate) => {
          candidate.composition.humanGate.platforms[0] = 'linux-x64';
        },
      },
      {
        name: 'SSH proof binding',
        mutate: (candidate) => {
          candidate.composition.sshProof.sourceDigest = validTamperedDigest();
        },
      },
      {
        name: 'recovery closure binding',
        mutate: (candidate) => {
          candidate.composition.recoveryClosureDigest = validTamperedDigest();
        },
      },
      {
        name: 'lockfile integrity binding',
        mutate: (candidate) => {
          candidate.lockfile.digest = validTamperedDigest();
        },
      },
      {
        name: 'package artifact integrity after self-consistent matrix rewrite',
        mutate: (candidate) => {
          const packageEntry = candidate.packages[0];
          packageEntry.digest = validTamperedDigest();
          candidate.composition.packageIntegrities[packageEntry.name] =
            packageEntry.digest;
          candidate.packageSetDigest = digestPackageSet(candidate.packages);
        },
      },
    ];

    for (const { name, mutate } of tamperCases) {
      const candidate = structuredClone(matrix);
      mutate(candidate);
      assert.throws(
        () =>
          verifyJigwrightReleaseCompatibilityMatrix(
            JSON.stringify(candidate),
            verification,
          ),
        /compatibility matrix .*match|artifact integrity/u,
        name,
      );
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('v1 candidate rehearses frozen install and downgrade while publish stays fail closed', () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-v1-candidate-'),
  );
  try {
    const dossier = prepareJigwrightV1ReleaseCandidate(
      process.cwd(),
      outputRoot,
      { allowDirty: true },
    );
    assert.equal(dossier.status, 'implementation-ready');
    assert.equal(dossier.reproducibleBuild, true);
    assert.equal(dossier.installAssurance.lifecycleScriptsDenied, true);
    assert.equal(dossier.installAssurance.offline, true);
    assert.equal(dossier.installAssurance.frozenLockfile, true);
    assert.equal(dossier.installAssurance.exactDowngradeRehearsed, true);
    assert.equal(dossier.genericBoundary.status, 'extraction-pending');
    assert.ok(dossier.genericBoundary.consumerOwnedAdapterSourceFiles > 0);
    assert.equal(
      dossier.historicalAssurance.providerAvailability.accepted,
      true,
    );
    assert.equal(
      dossier.historicalAssurance.providerAvailability.futureSla,
      false,
    );
    assert.equal(
      dossier.historicalAssurance.planningBindingMigration,
      'mixed-bindings-refused',
    );
    assert.deepEqual(dossier.operationalGates, {
      realPilot: 'real-pilot-pending',
      fullGate: 'full-gate-pending',
      registryPublish: 'not-requested',
    });
    assert.equal(dossier.extraction.steps.length, 8);
    assert.equal(
      dossier.extraction.steps[7]?.state,
      'operational-gate-pending',
    );

    const candidate = assessJigwrightV1PublishReadiness(dossier, 'candidate');
    assert.equal(candidate.status, 'implementation-ready');
    assert.equal(candidate.publishable, false);
    assert.deepEqual(candidate.blockers, [
      'clean-source-required',
      'consumer-policy-extraction-pending',
      'independent-bootstrap-review-pending',
      'license-decision-pending',
      'signed-provenance-pending',
      'real-pilot-pending',
      'full-gate-pending',
      'registry-publish-not-requested',
    ]);
    assert.throws(
      () => assessJigwrightV1PublishReadiness(dossier, 'publish'),
      /not publishable/u,
    );

    const cleanDossier = structuredClone(dossier) as any;
    cleanDossier.release.source.dirty = false;
    const fixture = createSshSignedFixture('release-reviewer');
    try {
      const completeEvidence = writeReleaseEvidenceObject(
        outputRoot,
        cleanDossier.release,
        fixture,
        [
          'full-gate',
          'real-pilot',
          'self-hosting-independent-review',
          'signed-provenance',
        ],
      );
      const verified = verifyJigwrightV1ReleaseEvidenceObject(
        completeEvidence.path,
        cleanDossier.release,
        [fixture.trustedSigner],
      );
      const completed = applyVerifiedJigwrightV1ReleaseEvidence(
        cleanDossier,
        verified,
      );
      assert.equal(completed.selfHosting.independentReview, 'complete');
      assert.equal(
        completed.evidence.releaseReadiness.signedProvenance,
        'complete',
      );
      assert.equal(completed.operationalGates.realPilot, 'complete');
      assert.equal(completed.operationalGates.fullGate, 'complete');
      assert.equal(
        completed.evidence.releaseReadiness.objectDigest,
        completeEvidence.digest,
      );
      assert.equal(completed.extraction.steps[3]?.state, 'complete');
      assert.equal(completed.extraction.steps[4]?.state, 'complete');
      assert.deepEqual(
        assessJigwrightV1PublishReadiness(completed, 'candidate').blockers,
        [
          'consumer-policy-extraction-pending',
          'license-decision-pending',
          'registry-publish-not-requested',
        ],
      );

      const provenanceOnly = writeReleaseEvidenceObject(
        outputRoot,
        cleanDossier.release,
        fixture,
        ['signed-provenance'],
      );
      const partiallyCompleted = applyVerifiedJigwrightV1ReleaseEvidence(
        cleanDossier,
        verifyJigwrightV1ReleaseEvidenceObject(
          provenanceOnly.path,
          cleanDossier.release,
          [fixture.trustedSigner],
        ),
      );
      assert.equal(
        partiallyCompleted.evidence.releaseReadiness.signedProvenance,
        'complete',
      );
      assert.equal(partiallyCompleted.selfHosting.independentReview, 'pending');
      assert.equal(
        partiallyCompleted.operationalGates.realPilot,
        'real-pilot-pending',
      );
      assert.equal(
        partiallyCompleted.operationalGates.fullGate,
        'full-gate-pending',
      );
    } finally {
      fixture.dispose();
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('v1 release evidence rejects stale, forged, mismatched, and non-addressed input', () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-v1-release-evidence-'),
  );
  const releaseRoot = path.join(outputRoot, 'release');
  const fixture = createSshSignedFixture('release-reviewer');
  try {
    const release = buildLocalJigwrightRelease(process.cwd(), releaseRoot, {
      allowDirty: true,
      releaseChannel: 'local-candidate',
    });
    const cleanRelease = structuredClone(release) as any;
    cleanRelease.source.dirty = false;

    const valid = writeReleaseEvidenceObject(
      outputRoot,
      cleanRelease,
      fixture,
      ['full-gate'],
    );
    assert.equal(
      verifyJigwrightV1ReleaseEvidenceObject(valid.path, cleanRelease, [
        fixture.trustedSigner,
      ]).claims.fullGate,
      true,
    );

    const staleRelease = structuredClone(cleanRelease) as any;
    staleRelease.source.commit = '0'.repeat(40);
    assert.throws(
      () =>
        verifyJigwrightV1ReleaseEvidenceObject(valid.path, staleRelease, [
          fixture.trustedSigner,
        ]),
      /subject.*match/u,
    );

    const staleTreeRelease = structuredClone(cleanRelease) as any;
    staleTreeRelease.source.tree = '0'.repeat(40);
    assert.throws(
      () =>
        verifyJigwrightV1ReleaseEvidenceObject(valid.path, staleTreeRelease, [
          fixture.trustedSigner,
        ]),
      /subject.*match/u,
    );

    const mismatchedPackageSet = structuredClone(cleanRelease) as any;
    mismatchedPackageSet.packageSetDigest = validTamperedDigest();
    const mismatch = writeReleaseEvidenceObject(
      outputRoot,
      mismatchedPackageSet,
      fixture,
      ['full-gate'],
    );
    assert.throws(
      () =>
        verifyJigwrightV1ReleaseEvidenceObject(mismatch.path, cleanRelease, [
          fixture.trustedSigner,
        ]),
      /subject.*match/u,
    );

    const mismatchedMatrix = structuredClone(cleanRelease) as any;
    mismatchedMatrix.releaseChannel = 'stable';
    const matrixMismatch = writeReleaseEvidenceObject(
      outputRoot,
      mismatchedMatrix,
      fixture,
      ['full-gate'],
    );
    assert.throws(
      () =>
        verifyJigwrightV1ReleaseEvidenceObject(
          matrixMismatch.path,
          cleanRelease,
          [fixture.trustedSigner],
        ),
      /subject.*match/u,
    );

    const envelope = readJson(valid.path);
    envelope.payload.claims[0].artifactDigest = validTamperedDigest();
    envelope.payloadDigest = digestCanonicalJson(envelope.payload);
    const forgedDigest = digestCanonicalJson(envelope);
    const forgedPath = releaseEvidenceObjectPath(outputRoot, forgedDigest);
    fs.mkdirSync(path.dirname(forgedPath), { recursive: true });
    fs.writeFileSync(forgedPath, `${JSON.stringify(envelope)}\n`, 'utf8');
    assert.throws(
      () =>
        verifyJigwrightV1ReleaseEvidenceObject(forgedPath, cleanRelease, [
          fixture.trustedSigner,
        ]),
      /signature.*invalid|invalid.*signature|untrusted/u,
    );

    const unknownVersion = readJson(valid.path);
    unknownVersion.payload.schemaVersion = 2;
    unknownVersion.payloadDigest = digestCanonicalJson(unknownVersion.payload);
    const unknownVersionDigest = digestCanonicalJson(unknownVersion);
    const unknownVersionPath = releaseEvidenceObjectPath(
      outputRoot,
      unknownVersionDigest,
    );
    fs.writeFileSync(
      unknownVersionPath,
      `${JSON.stringify(unknownVersion)}\n`,
      'utf8',
    );
    assert.throws(
      () =>
        verifyJigwrightV1ReleaseEvidenceObject(
          unknownVersionPath,
          cleanRelease,
          [fixture.trustedSigner],
        ),
      /payload is invalid/u,
    );

    const wrongAddressPath = releaseEvidenceObjectPath(
      outputRoot,
      validTamperedDigest(),
    );
    fs.writeFileSync(wrongAddressPath, fs.readFileSync(valid.path));
    assert.throws(
      () =>
        verifyJigwrightV1ReleaseEvidenceObject(wrongAddressPath, cleanRelease, [
          fixture.trustedSigner,
        ]),
      /content address/u,
    );

    const dirtyRelease = structuredClone(cleanRelease) as any;
    dirtyRelease.source.dirty = true;
    assert.throws(
      () =>
        verifyJigwrightV1ReleaseEvidenceObject(valid.path, dirtyRelease, [
          fixture.trustedSigner,
        ]),
      /clean source/u,
    );
  } finally {
    fixture.dispose();
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('released composition exposes versioned Manifest and Central Grant surfaces', () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-v1-public-surface-'),
  );
  try {
    const matrix = buildLocalJigwrightRelease(process.cwd(), outputRoot, {
      allowDirty: true,
      releaseChannel: 'local-candidate',
    });
    const main = matrix.packages.find(({ name }) => name === 'jigwright')!;
    const grants = matrix.packages.find(
      ({ name }) => name === '@jigwright/grants',
    )!;
    const manifest = JSON.parse(
      tar([
        '-xOzf',
        path.join(outputRoot, main.tarball),
        'package/package.json',
      ]),
    );
    assert.deepEqual(manifest.exports, {
      './central-grant': './src/composition-root/public/central-grant.ts',
      './manifest-v3': './src/composition-root/public/manifest-v3.ts',
      './plan-review': './src/composition-root/public/plan-review.ts',
    });
    const inventory = tar(['-tzf', path.join(outputRoot, main.tarball)]);
    assert.match(
      inventory,
      /package\/native\/human-gate-macos\/bin\/human-gate/u,
    );
    assert.match(
      inventory,
      /package\/src\/composition-root\/public\/manifest-v3\.ts/u,
    );
    assert.match(
      inventory,
      /package\/src\/composition-root\/public\/central-grant\.ts/u,
    );
    assert.match(
      inventory,
      /package\/src\/composition-root\/public\/plan-review\.ts/u,
    );
    const grantsManifest = JSON.parse(
      tar([
        '-xOzf',
        path.join(outputRoot, grants.tarball),
        'package/package.json',
      ]),
    );
    assert.equal(
      grantsManifest.exports['./central-grant-contracts'],
      './src/central-grant-contracts.ts',
    );
    assert.match(
      tar(['-tzf', path.join(outputRoot, grants.tarball)]),
      /package\/src\/central-grant-contracts\.ts/u,
    );
    assert.equal('devDependencies' in grantsManifest, false);
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

function digestFile(filePath: string): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')}`;
}

function validTamperedDigest(): string {
  return `sha256:${'0'.repeat(64)}`;
}

function digestPackageSet(
  packages: readonly Readonly<{
    name: string;
    version: string;
    tarball: string;
    digest: string;
  }>[],
): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        packages.map(({ name, version, tarball, digest }) => ({
          name,
          version,
          tarball,
          digest,
        })),
      ),
    )
    .digest('hex')}`;
}

function writeReleaseEvidenceObject(
  root: string,
  release: any,
  fixture: ReturnType<typeof createSshSignedFixture>,
  claimKinds: readonly (
    | 'full-gate'
    | 'real-pilot'
    | 'self-hosting-independent-review'
    | 'signed-provenance'
  )[],
): Readonly<{ path: string; digest: string }> {
  const payload = {
    schemaVersion: 1,
    kind: 'jigwright-v1-release-readiness-evidence.v1',
    signatureNamespace: JIGWRIGHT_V1_RELEASE_EVIDENCE_SIGNATURE_NAMESPACE,
    signerIdentity: fixture.trustedSigner.identity,
    subject: jigwrightV1ReleaseEvidenceSubject(release),
    claims: [...claimKinds]
      .sort((left, right) => left.localeCompare(right))
      .map((kind) => ({
        kind,
        result: 'complete',
        artifactDigest: digestCanonicalJson({ kind, release: release.source }),
      })),
  };
  const payloadDigest = digestCanonicalJson(payload);
  const envelope = {
    payload,
    payloadDigest,
    signature: fixture.sign(
      canonicalJson(payload),
      JIGWRIGHT_V1_RELEASE_EVIDENCE_SIGNATURE_NAMESPACE,
    ),
  };
  const digest = digestCanonicalJson(envelope);
  const objectPath = releaseEvidenceObjectPath(root, digest);
  fs.mkdirSync(path.dirname(objectPath), { recursive: true });
  fs.writeFileSync(objectPath, `${JSON.stringify(envelope)}\n`, 'utf8');
  return { path: objectPath, digest };
}

function releaseEvidenceObjectPath(root: string, digest: string): string {
  return path.join(
    root,
    'evidence',
    'objects',
    'sha256',
    `${digest.slice('sha256:'.length)}.json`,
  );
}

function digestCanonicalJson(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function tar(args: string[]): string {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
