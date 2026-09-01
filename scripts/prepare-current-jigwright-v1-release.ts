import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  buildSingleJigwrightPackage,
  type SingleJigwrightPackageArtifactV1,
} from './build-single-jigwright-package.ts';
import {
  runCurrentJigwrightAdoption,
  verifyCurrentJigwrightAdoptionArtifacts,
  verifyCurrentJigwrightAdoptionReportV1,
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

export type CurrentJigwrightV1ReleaseCandidateFreshness = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-v1-release-candidate-freshness.v1';
  status: 'current' | 'stale';
  candidate: CurrentJigwrightV1ReleaseCandidate['release']['source'];
  current: CurrentJigwrightV1ReleaseCandidate['release']['source'];
  reasons: readonly (
    | 'candidate-source-dirty'
    | 'current-source-dirty'
    | 'source-commit-mismatch'
    | 'source-tree-mismatch'
  )[];
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
  verifyCurrentJigwrightAdoptionReportV1(candidate.adoption, candidate.release);
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
  if (!isDeepStrictEqual(integrity, currentIntegrityDocument(candidate))) {
    throw new Error('Current Jigwright v1 integrity binding is invalid.');
  }
  const adoption = readJson(path.join(outputRoot, 'adoption', 'report.json'));
  if (!isDeepStrictEqual(adoption, candidate.adoption)) {
    throw new Error('Current Jigwright v1 adoption binding is invalid.');
  }
  verifyCurrentJigwrightAdoptionArtifacts(
    path.join(outputRoot, 'adoption'),
    candidate.adoption,
  );
  const boundary = inspectPackageBoundary(tarballPath);
  if (boundary.license !== candidate.packageBoundary.license) {
    throw new Error('Current Jigwright v1 package license binding is invalid.');
  }
  const provenance = readJson(
    path.join(outputRoot, candidate.supplyChain.provenance),
  );
  if (!isDeepStrictEqual(provenance, currentProvenanceDocument(candidate))) {
    throw new Error('Current Jigwright v1 provenance binding is invalid.');
  }
  const sbom = readJson(path.join(outputRoot, candidate.supplyChain.sbom));
  if (!isDeepStrictEqual(sbom, currentSbomDocument(candidate))) {
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

/**
 * Reports whether a verified local candidate still exactly represents the
 * current clean repository source. This is observational and never changes
 * either the candidate or the repository.
 */
export function inspectCurrentJigwrightV1ReleaseCandidateFreshness(
  requestedRepositoryRoot: string,
  requestedOutputRoot: string,
): CurrentJigwrightV1ReleaseCandidateFreshness {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const candidate =
    verifyCurrentJigwrightV1ReleaseCandidate(requestedOutputRoot);
  return assessCurrentJigwrightV1ReleaseCandidateFreshness(
    candidate.release.source,
    currentSourceIdentity(repositoryRoot),
  );
}

export function assessCurrentJigwrightV1ReleaseCandidateFreshness(
  candidate: CurrentJigwrightV1ReleaseCandidate['release']['source'],
  current: CurrentJigwrightV1ReleaseCandidate['release']['source'],
): CurrentJigwrightV1ReleaseCandidateFreshness {
  const reasons: CurrentJigwrightV1ReleaseCandidateFreshness['reasons'][number][] =
    [];
  if (candidate.dirty) reasons.push('candidate-source-dirty');
  if (current.dirty) reasons.push('current-source-dirty');
  if (candidate.commit !== current.commit)
    reasons.push('source-commit-mismatch');
  if (candidate.tree !== current.tree) reasons.push('source-tree-mismatch');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'jigwright-v1-release-candidate-freshness.v1',
    status: reasons.length === 0 ? 'current' : 'stale',
    candidate: Object.freeze({ ...candidate }),
    current: Object.freeze({ ...current }),
    reasons: Object.freeze(reasons),
  });
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
  writeJson(
    path.join(outputRoot, candidate.supplyChain.integrity),
    currentIntegrityDocument(candidate),
  );
  writeJson(
    path.join(outputRoot, candidate.supplyChain.provenance),
    currentProvenanceDocument(candidate),
  );
  writeJson(
    path.join(outputRoot, candidate.supplyChain.sbom),
    currentSbomDocument(candidate),
  );
}

function currentIntegrityDocument(
  candidate: CurrentJigwrightV1ReleaseCandidate,
): JsonRecord {
  const artifactPath = `package/${candidate.release.tarball}`;
  return {
    schemaVersion: 1,
    kind: 'jigwright-v1-single-package-integrity.v1',
    source: candidate.release.source,
    artifacts: { [artifactPath]: candidate.release.digest },
  };
}

function currentProvenanceDocument(
  candidate: CurrentJigwrightV1ReleaseCandidate,
): JsonRecord {
  const artifactPath = `package/${candidate.release.tarball}`;
  return {
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
  };
}

function currentSbomDocument(
  candidate: CurrentJigwrightV1ReleaseCandidate,
): JsonRecord {
  return {
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
  };
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

function currentSourceIdentity(
  repositoryRoot: string,
): CurrentJigwrightV1ReleaseCandidate['release']['source'] {
  return Object.freeze({
    commit: runRequired('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    tree: runRequired('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: repositoryRoot,
    }),
    dirty:
      runRequired('git', ['status', '--porcelain=v1'], {
        cwd: repositoryRoot,
      }).length > 0,
  });
}

function digestFile(filePath: string): `sha256:${string}` {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')}`;
}

function runRequired(
  executable: string,
  args: string[],
  options: Readonly<{ cwd?: string }> = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
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
  const statusIndex = process.argv.indexOf('--status');
  if (
    outputIndex >= 0 &&
    process.argv[outputIndex + 1] !== undefined &&
    statusIndex < 0
  ) {
    const candidate = prepareCurrentJigwrightV1ReleaseCandidate(
      process.cwd(),
      process.argv[outputIndex + 1]!,
    );
    process.stdout.write(`${JSON.stringify(candidate)}\n`);
  } else if (
    statusIndex >= 0 &&
    process.argv[statusIndex + 1] !== undefined &&
    outputIndex < 0
  ) {
    const freshness = inspectCurrentJigwrightV1ReleaseCandidateFreshness(
      process.cwd(),
      process.argv[statusIndex + 1]!,
    );
    process.stdout.write(`${JSON.stringify(freshness)}\n`);
  } else {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/prepare-current-jigwright-v1-release.ts (--output|--status) <directory>',
    );
  }
}
