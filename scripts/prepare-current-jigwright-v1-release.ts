import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  buildSingleJigwrightPackage,
  type SingleJigwrightPackageArtifactV1,
} from './build-single-jigwright-package.ts';
import {
  runCurrentJigwrightAdoption,
  type CurrentJigwrightAdoptionReportV1,
} from './run-current-jigwright-adoption.ts';

type JsonRecord = Record<string, unknown>;

const PACKAGE_TOP_LEVEL_ALLOWLIST = Object.freeze([
  'LICENSE',
  'README.md',
  'bin',
  'bootstrap',
  'dist',
  'internal',
  'native',
  'package.json',
  'runtime',
  'src',
] as const);

export type CurrentJigwrightV1PublishReadiness = Readonly<{
  status: 'implementation-ready';
  publishable: boolean;
  blockers: readonly string[];
}>;

export type CurrentJigwrightV1ReleaseCandidate = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-v1-single-package-candidate.v1';
  release: SingleJigwrightPackageArtifactV1;
  packageBoundary: Readonly<{
    publicPackageIdentities: readonly ['jigwright'];
    externalDependencies: 0;
    topLevelAllowlist: typeof PACKAGE_TOP_LEVEL_ALLOWLIST;
    license: string;
    verified: true;
  }>;
  reproducibility: Readonly<{
    repeatedDigest: `sha256:${string}`;
    identical: true;
  }>;
  adoption: CurrentJigwrightAdoptionReportV1;
  supplyChain: Readonly<{
    integrity: 'integrity.json';
    provenance: 'provenance.intoto.json';
    sbom: 'sbom.cdx.json';
    attestation: 'unsigned-local';
  }>;
  operationalGates: Readonly<{
    implementation: 'implementation-ready';
    independentReview: 'independent-review-pending';
    signedProvenance: 'signed-provenance-pending';
    realPilot: 'real-pilot-pending';
    fullGate: 'full-gate-pending';
    registryPublish: 'not-requested';
  }>;
  publishReadiness: CurrentJigwrightV1PublishReadiness;
}>;

export function prepareCurrentJigwrightV1ReleaseCandidate(
  requestedRepositoryRoot: string,
  requestedOutputRoot: string,
  options: Readonly<{ allowDirty?: boolean }> = {},
): CurrentJigwrightV1ReleaseCandidate {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const outputRoot = path.resolve(requestedOutputRoot);
  assertEmptyDirectory(outputRoot);

  const packageRoot = path.join(outputRoot, 'package');
  const release = buildSingleJigwrightPackage(
    repositoryRoot,
    packageRoot,
    options,
  );
  const repeatedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-current-v1-repeat-'),
  );
  let repeated: SingleJigwrightPackageArtifactV1;
  try {
    repeated = buildSingleJigwrightPackage(
      repositoryRoot,
      repeatedRoot,
      options,
    );
    if (
      repeated.digest !== release.digest ||
      !fs
        .readFileSync(path.join(repeatedRoot, repeated.tarball))
        .equals(fs.readFileSync(path.join(packageRoot, release.tarball)))
    ) {
      throw new Error(
        'Current Jigwright v1 package build is not reproducible.',
      );
    }
  } finally {
    fs.rmSync(repeatedRoot, { recursive: true, force: true });
  }

  const adoption = runCurrentJigwrightAdoption(
    repositoryRoot,
    path.join(outputRoot, 'adoption'),
    options,
  );
  if (adoption.release.digest !== release.digest) {
    throw new Error(
      'Current Jigwright adoption did not use the exact release.',
    );
  }
  writeJson(path.join(outputRoot, 'adoption', 'report.json'), adoption);

  const tarballPath = path.join(packageRoot, release.tarball);
  const boundary = inspectPackageBoundary(tarballPath);
  const operationalGates = Object.freeze({
    implementation: 'implementation-ready' as const,
    independentReview: 'independent-review-pending' as const,
    signedProvenance: 'signed-provenance-pending' as const,
    realPilot: 'real-pilot-pending' as const,
    fullGate: 'full-gate-pending' as const,
    registryPublish: 'not-requested' as const,
  });
  const base = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'jigwright-v1-single-package-candidate.v1' as const,
    release,
    packageBoundary: Object.freeze({
      publicPackageIdentities: Object.freeze(['jigwright'] as const),
      externalDependencies: 0 as const,
      topLevelAllowlist: PACKAGE_TOP_LEVEL_ALLOWLIST,
      license: boundary.license,
      verified: true as const,
    }),
    reproducibility: Object.freeze({
      repeatedDigest: repeated.digest,
      identical: true as const,
    }),
    adoption,
    supplyChain: Object.freeze({
      integrity: 'integrity.json' as const,
      provenance: 'provenance.intoto.json' as const,
      sbom: 'sbom.cdx.json' as const,
      attestation: 'unsigned-local' as const,
    }),
    operationalGates,
  });
  const candidate: CurrentJigwrightV1ReleaseCandidate = Object.freeze({
    ...base,
    publishReadiness: assessReadiness(base),
  });

  writeSupplyChainArtifacts(outputRoot, candidate);
  writeReleaseDocuments(outputRoot, candidate);
  writeJson(path.join(outputRoot, 'release-candidate.json'), candidate);
  verifyCurrentJigwrightV1ReleaseCandidate(outputRoot);
  return candidate;
}

export function assessCurrentJigwrightV1PublishReadiness(
  candidate: CurrentJigwrightV1ReleaseCandidate,
  mode: 'candidate' | 'publish',
): CurrentJigwrightV1PublishReadiness {
  const readiness = assessReadiness(candidate);
  if (mode === 'publish' && !readiness.publishable) {
    throw new Error(
      `Current Jigwright v1 is not publishable: ${readiness.blockers.join(', ')}.`,
    );
  }
  return readiness;
}

export function verifyCurrentJigwrightV1ReleaseCandidate(
  requestedOutputRoot: string,
): CurrentJigwrightV1ReleaseCandidate {
  const outputRoot = fs.realpathSync(requestedOutputRoot);
  const value = readJson(path.join(outputRoot, 'release-candidate.json'));
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright-v1-single-package-candidate.v1' ||
    !isRecord(value.release) ||
    value.release.schemaVersion !== 1 ||
    value.release.kind !== 'jigwright-single-package.v1' ||
    value.release.name !== 'jigwright' ||
    typeof value.release.version !== 'string' ||
    !isSafeTarballName(value.release.tarball) ||
    !isSha256Digest(value.release.digest) ||
    !isRecord(value.release.source) ||
    !isGitObjectId(value.release.source.commit) ||
    !isGitObjectId(value.release.source.tree) ||
    typeof value.release.source.dirty !== 'boolean' ||
    !isRecord(value.packageBoundary) ||
    value.packageBoundary.externalDependencies !== 0 ||
    value.packageBoundary.verified !== true ||
    typeof value.packageBoundary.license !== 'string' ||
    !Array.isArray(value.packageBoundary.publicPackageIdentities) ||
    JSON.stringify(value.packageBoundary.publicPackageIdentities) !==
      JSON.stringify(['jigwright']) ||
    JSON.stringify(value.packageBoundary.topLevelAllowlist) !==
      JSON.stringify(PACKAGE_TOP_LEVEL_ALLOWLIST) ||
    !isRecord(value.reproducibility) ||
    value.reproducibility.identical !== true ||
    value.reproducibility.repeatedDigest !== value.release.digest ||
    !isRecord(value.adoption) ||
    !isRecord(value.supplyChain) ||
    value.supplyChain.integrity !== 'integrity.json' ||
    value.supplyChain.provenance !== 'provenance.intoto.json' ||
    value.supplyChain.sbom !== 'sbom.cdx.json' ||
    value.supplyChain.attestation !== 'unsigned-local' ||
    !isRecord(value.operationalGates) ||
    JSON.stringify(value.operationalGates) !==
      JSON.stringify({
        implementation: 'implementation-ready',
        independentReview: 'independent-review-pending',
        signedProvenance: 'signed-provenance-pending',
        realPilot: 'real-pilot-pending',
        fullGate: 'full-gate-pending',
        registryPublish: 'not-requested',
      }) ||
    !isRecord(value.publishReadiness)
  ) {
    throw new Error('Current Jigwright v1 release candidate is invalid.');
  }
  const candidate = value as unknown as CurrentJigwrightV1ReleaseCandidate;
  const tarballPath = path.join(
    outputRoot,
    'package',
    candidate.release.tarball,
  );
  if (digestFile(tarballPath) !== candidate.release.digest) {
    throw new Error('Current Jigwright v1 artifact digest does not match.');
  }
  const integrity = readJson(
    path.join(outputRoot, candidate.supplyChain.integrity),
  );
  if (
    integrity.kind !== 'jigwright-v1-single-package-integrity.v1' ||
    !isRecord(integrity.artifacts) ||
    integrity.artifacts[`package/${candidate.release.tarball}`] !==
      candidate.release.digest
  ) {
    throw new Error('Current Jigwright v1 integrity binding is invalid.');
  }
  const adoption = readJson(path.join(outputRoot, 'adoption', 'report.json'));
  if (
    !isRecord(adoption.release) ||
    adoption.release.digest !== candidate.release.digest ||
    adoption.kind !== 'jigwright-current-local-adoption-report.v1'
  ) {
    throw new Error('Current Jigwright v1 adoption binding is invalid.');
  }
  const boundary = inspectPackageBoundary(tarballPath);
  if (boundary.license !== candidate.packageBoundary.license) {
    throw new Error('Current Jigwright v1 package license binding is invalid.');
  }
  const expectedHexDigest = candidate.release.digest.slice('sha256:'.length);
  const provenance = readJson(
    path.join(outputRoot, candidate.supplyChain.provenance),
  );
  const provenanceSubject = Array.isArray(provenance.subject)
    ? provenance.subject[0]
    : null;
  if (
    provenance._type !== 'https://in-toto.io/Statement/v1' ||
    !isRecord(provenanceSubject) ||
    provenanceSubject.name !== `package/${candidate.release.tarball}` ||
    !isRecord(provenanceSubject.digest) ||
    provenanceSubject.digest.sha256 !== expectedHexDigest
  ) {
    throw new Error('Current Jigwright v1 provenance binding is invalid.');
  }
  const sbom = readJson(path.join(outputRoot, candidate.supplyChain.sbom));
  const component = Array.isArray(sbom.components) ? sbom.components[0] : null;
  const hash =
    isRecord(component) && Array.isArray(component.hashes)
      ? component.hashes[0]
      : null;
  if (
    sbom.bomFormat !== 'CycloneDX' ||
    !isRecord(component) ||
    component.name !== 'jigwright' ||
    component.version !== candidate.release.version ||
    !isRecord(hash) ||
    hash.alg !== 'SHA-256' ||
    hash.content !== expectedHexDigest
  ) {
    throw new Error('Current Jigwright v1 SBOM binding is invalid.');
  }
  if (
    JSON.stringify(assessReadiness(candidate)) !==
    JSON.stringify(candidate.publishReadiness)
  ) {
    throw new Error('Current Jigwright v1 publish readiness is invalid.');
  }
  return candidate;
}

function assessReadiness(
  candidate: Pick<
    CurrentJigwrightV1ReleaseCandidate,
    'release' | 'packageBoundary' | 'operationalGates'
  >,
): CurrentJigwrightV1PublishReadiness {
  const blockers: string[] = [];
  if (candidate.release.source.dirty) blockers.push('clean-source-required');
  if (candidate.packageBoundary.license === 'UNLICENSED') {
    blockers.push('license-decision-pending');
  }
  if (candidate.operationalGates.independentReview !== ('complete' as string)) {
    blockers.push('independent-review-pending');
  }
  if (candidate.operationalGates.signedProvenance !== ('complete' as string)) {
    blockers.push('signed-provenance-pending');
  }
  if (candidate.operationalGates.realPilot !== ('complete' as string)) {
    blockers.push('real-pilot-pending');
  }
  if (candidate.operationalGates.fullGate !== ('complete' as string)) {
    blockers.push('full-gate-pending');
  }
  if (candidate.operationalGates.registryPublish !== ('requested' as string)) {
    blockers.push('registry-publish-not-requested');
  }
  return Object.freeze({
    status: 'implementation-ready',
    publishable: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

function inspectPackageBoundary(
  tarballPath: string,
): Readonly<{ license: string }> {
  const inventory = runRequired('tar', ['-tzf', tarballPath]);
  const entries = inventory.split('\n').filter((entry) => entry.length > 0);
  const topLevel = [
    ...new Set(
      entries
        .filter((entry) => entry.startsWith('package/'))
        .map((entry) => entry.slice('package/'.length).split('/')[0])
        .filter((entry) => entry.length > 0),
    ),
  ].sort();
  if (
    JSON.stringify(topLevel) !== JSON.stringify(PACKAGE_TOP_LEVEL_ALLOWLIST)
  ) {
    throw new Error('Current Jigwright v1 package allowlist does not match.');
  }
  if (
    entries.some(
      (entry) =>
        entry.startsWith('package/apps/') ||
        entry.includes('/expense-app/') ||
        /package\/(?:internal|bootstrap\/installed-runtime-sources)\/[^/]+\/package\.json$/u.test(
          entry,
        ),
    )
  ) {
    throw new Error('Current Jigwright v1 package contains a forbidden path.');
  }
  const manifest = parseJson(
    runRequired('tar', ['-xOzf', tarballPath, 'package/package.json']),
  );
  const dependencyFields = [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ];
  if (
    manifest.name !== 'jigwright' ||
    manifest.private !== undefined ||
    manifest.workspaces !== undefined ||
    dependencyFields.some((field) => field in manifest) ||
    typeof manifest.license !== 'string'
  ) {
    throw new Error('Current Jigwright v1 package boundary is invalid.');
  }
  return Object.freeze({ license: manifest.license });
}

function writeSupplyChainArtifacts(
  outputRoot: string,
  candidate: CurrentJigwrightV1ReleaseCandidate,
): void {
  const artifactPath = `package/${candidate.release.tarball}`;
  writeJson(path.join(outputRoot, candidate.supplyChain.integrity), {
    schemaVersion: 1,
    kind: 'jigwright-v1-single-package-integrity.v1',
    source: candidate.release.source,
    artifacts: { [artifactPath]: candidate.release.digest },
  });
  writeJson(path.join(outputRoot, candidate.supplyChain.provenance), {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: artifactPath,
        digest: { sha256: candidate.release.digest.slice('sha256:'.length) },
      },
    ],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'jigwright-single-package.v1',
        externalParameters: { releaseChannel: 'local-candidate' },
        internalParameters: {
          sourceCommit: candidate.release.source.commit,
          sourceTree: candidate.release.source.tree,
        },
        resolvedDependencies: [],
      },
      runDetails: { attestation: 'unsigned-local' },
    },
  });
  writeJson(path.join(outputRoot, candidate.supplyChain.sbom), {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: { component: { type: 'application', name: 'jigwright' } },
    components: [
      {
        type: 'application',
        name: 'jigwright',
        version: candidate.release.version,
        purl: `pkg:npm/jigwright@${candidate.release.version}`,
        hashes: [
          {
            alg: 'SHA-256',
            content: candidate.release.digest.slice('sha256:'.length),
          },
        ],
        licenses: [{ license: { name: candidate.packageBoundary.license } }],
      },
    ],
  });
}

function writeReleaseDocuments(
  outputRoot: string,
  candidate: CurrentJigwrightV1ReleaseCandidate,
): void {
  writeText(
    path.join(outputRoot, 'docs', 'API.md'),
    [
      '# Jigwright v1 API',
      '',
      'The only public installation identity is `jigwright`.',
      '',
      '- CLI: `jigwright`',
      '- `jigwright/manifest-v3`',
      '- `jigwright/plan-review`',
      '- `jigwright/central-grant`',
      '',
    ].join('\n'),
  );
  writeText(
    path.join(outputRoot, 'docs', 'OPERATIONS.md'),
    [
      '# Jigwright v1 Operations',
      '',
      `Exact local artifact: \`package/${candidate.release.tarball}\` (${candidate.release.digest}).`,
      '',
      'This candidate is local and unsigned. It does not publish, access a remote, run a real pilot, or run the full gate.',
      '',
      '- `independent-review-pending`',
      '- `signed-provenance-pending`',
      '- `real-pilot-pending`',
      '- `full-gate-pending`',
      '- `registry-publish-not-requested`',
      '',
    ].join('\n'),
  );
  writeText(
    path.join(outputRoot, 'docs', 'COMPATIBILITY.md'),
    [
      '# Jigwright v1 Compatibility',
      '',
      'Jigwright v1 is current-only. It does not read or migrate v1/v2 runtime state.',
      'A consumer rollback reverts its dependency/cutover commit; Jigwright does not replay an embedded legacy engine.',
      '',
    ].join('\n'),
  );
}

function assertEmptyDirectory(root: string): void {
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (
    stats !== undefined &&
    (!stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.readdirSync(root).length > 0)
  ) {
    throw new Error('Current Jigwright v1 release output must be empty.');
  }
  fs.mkdirSync(root, { recursive: true });
}

function digestFile(filePath: string): `sha256:${string}` {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')}`;
}

function runRequired(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function parseJson(value: string): JsonRecord {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed))
    throw new Error('Current Jigwright v1 JSON is invalid.');
  return parsed;
}

function readJson(filePath: string): JsonRecord {
  return parseJson(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isGitObjectId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
  );
}

function isSafeTarballName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^jigwright-[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?\.tgz$/u.test(value)
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || process.argv[outputIndex + 1] === undefined) {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/prepare-current-jigwright-v1-release.ts --output <directory>',
    );
  }
  const candidate = prepareCurrentJigwrightV1ReleaseCandidate(
    process.cwd(),
    process.argv[outputIndex + 1]!,
  );
  process.stdout.write(`${JSON.stringify(candidate)}\n`);
}
