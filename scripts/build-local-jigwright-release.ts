import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import zlib from 'node:zlib';

type Sha256Digest = `sha256:${string}`;
type ReleaseChannel = 'local-candidate' | 'release-candidate' | 'stable';

type ReleasePackageEntry = Readonly<{
  name: string;
  version: string;
  tarball: string;
  digest: Sha256Digest;
  license: string;
  dependencies: readonly Readonly<{
    name: string;
    version: string;
    optional: boolean;
  }>[];
}>;

export type LocalJigwrightReleaseMatrixV1 = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-release-compatibility-matrix.v1';
  releaseChannel: ReleaseChannel;
  source: Readonly<{
    commit: string;
    tree: string;
    dirty: boolean;
  }>;
  runtime: Readonly<{
    node: '>=22.22.1 <23';
    packageManager: 'pnpm@11.12.0';
  }>;
  lockfile: Readonly<{
    path: 'pnpm-lock.yaml';
    digest: Sha256Digest;
  }>;
  packages: readonly ReleasePackageEntry[];
  packageSetDigest: Sha256Digest;
  optionalPackages: readonly ['@jigwright/github-adapter', '@jigwright/grants'];
  policies: Readonly<{
    lifecycleScripts: 'denied';
    globalBinaryFallback: 'denied';
    floatingNpxFallback: 'denied';
    gitlinkDistribution: 'denied';
    exactConsumerVersions: true;
    unknownSchema: 'fail-closed';
  }>;
  publicContracts: Readonly<{
    manifestV3: Readonly<{
      schemaVersion: 3;
      export: 'jigwright/manifest-v3';
      validationApis: readonly [
        'validateDraftForSeal',
        'validateForAuthority',
        'inspectHistorical',
      ];
      sourceDigest: Sha256Digest;
    }>;
    planReview: Readonly<{
      contractVersion: 1;
      export: 'jigwright/plan-review';
      separateAuthority: true;
      sourceDigest: Sha256Digest;
    }>;
    guidance: Readonly<{
      export: 'jigwright CLI';
      catalog: 'workflow-command-guide.v1';
      catalogVersion: 'managed-task-lifecycle.v2';
      nextSteps: 'workflow-next-steps.v1';
      failureRecovery: 'workflow-failure-recovery.v1';
      sameSource: true;
      sourceDigest: Sha256Digest;
    }>;
    agentRuntime: Readonly<{
      package: '@jigwright/agent-runtime';
      wrapperProtocol: 'harness-jsonl-v1';
      engineEnvelope: 'harness-jsonl-v2';
      capabilitiesContract: 'agent-runtime-capabilities.v1';
      sourceDigest: Sha256Digest;
    }>;
    centralGrant: Readonly<{
      package: '@jigwright/grants';
      compositionExport: 'jigwright/central-grant';
      challenge: 'grant-challenge.v1';
      approvalSubject: 'grant-approval-subject.v1';
      policy: 'grant-policy.v2';
      canonicalRecord: 'grant-record.v1';
      transitionRegistry: 'grant-transition-registry.v1';
      proofModulePort: 'grant-proof-module.v1';
      legacyIssuance: 'denied';
      historicalReaders: readonly string[];
      sourceDigest: Sha256Digest;
    }>;
  }>;
  composition: Readonly<{
    packageVersions: Readonly<Record<string, string>>;
    packageIntegrities: Readonly<Record<string, Sha256Digest>>;
    grantPolicy: Readonly<{
      schemaVersion: 2;
      digest: Sha256Digest;
    }>;
    transitionRegistry: Readonly<{
      contractVersion: 'grant-transition-registry.v1';
      sourceDigest: Sha256Digest;
    }>;
    protectedCapabilities: Readonly<{
      schemaVersion: 1;
      digest: Sha256Digest;
    }>;
    humanGate: Readonly<{
      moduleId: 'human-gate-macos';
      version: '1';
      protocolVersion: 1;
      digest: Sha256Digest;
      sourceDigest: Sha256Digest;
      platforms: readonly ['darwin-arm64', 'darwin-x64'];
      provenance: 'source-and-fixed-binary-digest';
    }>;
    sshProof: Readonly<{
      moduleId: 'grant-proof-ssh';
      version: '1';
      sourceDigest: Sha256Digest;
      humanSelectedAlternative: true;
    }>;
    recoveryClosureDigest: Sha256Digest;
  }>;
}>;

const PACKAGE_DIRECTORIES = [
  'packages/agent-runtime',
  'packages/core',
  'packages/grants',
  'packages/github-adapter',
  'packages/openspec-adapter',
  'packages/workflow-engine',
] as const;

const EXACT_PACKAGE_NAMES = [
  '@jigwright/agent-runtime',
  '@jigwright/core',
  '@jigwright/github-adapter',
  '@jigwright/grants',
  '@jigwright/openspec-adapter',
  'jigwright',
] as const;
const OPTIONAL_PACKAGES = [
  '@jigwright/github-adapter',
  '@jigwright/grants',
] as const;
const INSTALL_LIFECYCLE_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
] as const;
const RELEASE_NODE_RANGE = '>=22.22.1 <23' as const;
const RELEASE_PACKAGE_MANAGER = 'pnpm@11.12.0' as const;

type ReleasePackageManifest = Record<string, unknown> &
  Readonly<{
    name: string;
    version: string;
    files: readonly string[];
  }>;

export function buildLocalJigwrightRelease(
  requestedRepositoryRoot: string,
  requestedOutputRoot: string,
  options: Readonly<{
    allowDirty?: boolean;
    releaseChannel?: ReleaseChannel;
  }> = {},
): LocalJigwrightReleaseMatrixV1 {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const outputRoot = path.resolve(requestedOutputRoot);
  const releaseChannel = options.releaseChannel ?? 'local-candidate';
  const status = run(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    {
      cwd: repositoryRoot,
    },
  );
  const dirty = status.length > 0;
  if (dirty && options.allowDirty !== true) {
    throw new Error('Local Jigwright release requires a clean source tree.');
  }
  assertNoGitlinks(repositoryRoot);
  assertReleaseControlFiles(repositoryRoot);
  const releaseBindings = readReleaseBindings(repositoryRoot);
  assertEmptyOutputDirectory(outputRoot);

  const manifests = PACKAGE_DIRECTORIES.map((relativeDirectory) => {
    const packageRoot = path.join(repositoryRoot, relativeDirectory);
    const manifest = readReleasePackageManifest(
      path.join(packageRoot, 'package.json'),
      relativeDirectory,
    );
    return { relativeDirectory, packageRoot, manifest };
  }).sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
  const versions = new Map(
    manifests.map(({ manifest }) => [manifest.name, manifest.version]),
  );
  assertExactPackageSet(manifests.map(({ manifest }) => manifest.name));
  assertReleaseVersions(versions);

  fs.mkdirSync(outputRoot, { recursive: true });
  const stagingRoot = path.join(
    outputRoot,
    `.staging-${process.pid}-${crypto.randomUUID()}`,
  );
  const packages: ReleasePackageEntry[] = [];
  try {
    for (const { packageRoot, manifest } of manifests) {
      const stageParent = path.join(
        stagingRoot,
        safePackageName(manifest.name),
      );
      const stagedPackage = path.join(stageParent, 'package');
      fs.mkdirSync(stagedPackage, { recursive: true });
      for (const relativePath of manifest.files) {
        assertReleasePath(relativePath);
        const sourcePath = path.join(packageRoot, relativePath);
        if (!fs.existsSync(sourcePath)) {
          throw new Error(
            `Release path ${relativePath} is missing from ${manifest.name}.`,
          );
        }
        fs.cpSync(sourcePath, path.join(stagedPackage, relativePath), {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
        });
      }
      if (manifest.name === 'jigwright') {
        fs.copyFileSync(
          path.join(repositoryRoot, 'README.md'),
          path.join(stagedPackage, 'README.md'),
        );
        writeInstalledRuntimeManifest(stagedPackage, manifests);
      }
      const releaseManifest = releasePackageManifest(manifest, versions);
      fs.writeFileSync(
        path.join(stagedPackage, 'package.json'),
        `${JSON.stringify(releaseManifest, null, 2)}\n`,
        'utf8',
      );
      const tarball = `${safePackageName(manifest.name)}-${manifest.version}.tgz`;
      const tarballPath = path.join(outputRoot, tarball);
      writeDeterministicTarball(stageParent, tarballPath);
      packages.push({
        name: manifest.name,
        version: manifest.version,
        tarball,
        digest: digestFile(tarballPath),
        license:
          typeof releaseManifest.license === 'string'
            ? releaseManifest.license
            : 'UNLICENSED',
        dependencies: releaseDependencies(releaseManifest),
      });
    }
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }

  const publicContracts = releasePublicContracts(repositoryRoot);
  const composition = releaseComposition(
    repositoryRoot,
    packages,
    releaseBindings,
  );

  const packageSetDigest = digestCanonical(
    packages.map(({ name, version, tarball, digest }) => ({
      name,
      version,
      tarball,
      digest,
    })),
  );
  const matrix: LocalJigwrightReleaseMatrixV1 = {
    schemaVersion: 1,
    kind: 'jigwright-release-compatibility-matrix.v1',
    releaseChannel,
    source: {
      commit: run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
      tree: run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryRoot }),
      dirty,
    },
    runtime: {
      node: RELEASE_NODE_RANGE,
      packageManager: RELEASE_PACKAGE_MANAGER,
    },
    lockfile: {
      path: 'pnpm-lock.yaml',
      digest: digestFile(path.join(repositoryRoot, 'pnpm-lock.yaml')),
    },
    packages,
    packageSetDigest,
    optionalPackages: OPTIONAL_PACKAGES,
    policies: {
      lifecycleScripts: 'denied',
      globalBinaryFallback: 'denied',
      floatingNpxFallback: 'denied',
      gitlinkDistribution: 'denied',
      exactConsumerVersions: true,
      unknownSchema: 'fail-closed',
    },
    publicContracts,
    composition,
  };
  fs.writeFileSync(
    path.join(outputRoot, 'compatibility-matrix.json'),
    `${JSON.stringify(matrix, null, 2)}\n`,
    'utf8',
  );
  writeReleaseEvidence(repositoryRoot, outputRoot, matrix);
  return matrix;
}

function releasePublicContracts(
  repositoryRoot: string,
): LocalJigwrightReleaseMatrixV1['publicContracts'] {
  return {
    manifestV3: {
      schemaVersion: 3,
      export: 'jigwright/manifest-v3',
      validationApis: [
        'validateDraftForSeal',
        'validateForAuthority',
        'inspectHistorical',
      ],
      sourceDigest: digestPaths(repositoryRoot, [
        'packages/workflow-engine/src/modules/investigation/manifest/investigation-manifest.ts',
        'packages/workflow-engine/src/composition-root/public/manifest-v3.ts',
      ]),
    },
    planReview: {
      contractVersion: 1,
      export: 'jigwright/plan-review',
      separateAuthority: true,
      sourceDigest: digestPaths(repositoryRoot, [
        'packages/workflow-engine/src/modules/assurance/plan-review.ts',
        'packages/workflow-engine/src/modules/assurance/plan-review-validation.ts',
        'packages/workflow-engine/src/composition-root/public/plan-review.ts',
      ]),
    },
    guidance: {
      export: 'jigwright CLI',
      catalog: 'workflow-command-guide.v1',
      catalogVersion: 'managed-task-lifecycle.v2',
      nextSteps: 'workflow-next-steps.v1',
      failureRecovery: 'workflow-failure-recovery.v1',
      sameSource: true,
      sourceDigest: digestPaths(repositoryRoot, [
        'packages/workflow-engine/src/modules/guidance/catalog/managed-workflow-command-registry.ts',
        'packages/workflow-engine/src/modules/guidance/next-steps/workflow-guidance.ts',
      ]),
    },
    agentRuntime: {
      package: '@jigwright/agent-runtime',
      wrapperProtocol: 'harness-jsonl-v1',
      engineEnvelope: 'harness-jsonl-v2',
      capabilitiesContract: 'agent-runtime-capabilities.v1',
      sourceDigest: digestPaths(repositoryRoot, [
        'packages/agent-runtime/package.json',
        'packages/agent-runtime/src/agent-runtime-port.ts',
        'packages/agent-runtime/src/harness-jsonl-v1.ts',
        'packages/agent-runtime/src/harness-jsonl-v2.ts',
      ]),
    },
    centralGrant: {
      package: '@jigwright/grants',
      compositionExport: 'jigwright/central-grant',
      challenge: 'grant-challenge.v1',
      approvalSubject: 'grant-approval-subject.v1',
      policy: 'grant-policy.v2',
      canonicalRecord: 'grant-record.v1',
      transitionRegistry: 'grant-transition-registry.v1',
      proofModulePort: 'grant-proof-module.v1',
      legacyIssuance: 'denied',
      historicalReaders: [
        'jigwright.collaboration-grant-envelope-reader.v1',
        'jigwright.signed-attestation-envelope-reader.v1',
      ],
      sourceDigest: digestPaths(repositoryRoot, [
        'packages/grants/package.json',
        'packages/grants/src/central-grant-contracts.ts',
        'packages/grants/src/collaboration-grant-envelope-reader.ts',
        'packages/grants/src/signed-attestation-envelope-reader.ts',
        'packages/workflow-engine/src/modules/authority/grant-core.ts',
        'packages/workflow-engine/src/modules/authority/grant-policy.ts',
        'packages/workflow-engine/src/modules/authority/grant-transition-registry.ts',
        'packages/workflow-engine/src/composition-root/public/central-grant.ts',
      ]),
    },
  };
}

function releaseComposition(
  repositoryRoot: string,
  packages: readonly ReleasePackageEntry[],
  releaseBindings: ReturnType<typeof readReleaseBindings>,
): LocalJigwrightReleaseMatrixV1['composition'] {
  const packageVersions = Object.fromEntries(
    packages.map(({ name, version }) => [name, version]),
  );
  const packageIntegrities = Object.fromEntries(
    packages.map(({ name, digest }) => [name, digest]),
  );
  const grantPolicyPath = path.join(
    repositoryRoot,
    releaseBindings.grantPolicyPath,
  );
  const grantPolicy = readManifest(grantPolicyPath);
  if (grantPolicy.schemaVersion !== 2) {
    throw new Error('Release GrantPolicyV2 binding is invalid.');
  }
  const protectedCapabilitiesPath = path.join(
    repositoryRoot,
    releaseBindings.protectedCapabilitiesPath,
  );
  const protectedCapabilities = readManifest(protectedCapabilitiesPath);
  if (protectedCapabilities.schemaVersion !== 1) {
    throw new Error('Release protected-capability binding is invalid.');
  }
  const recoveryClosurePath = path.join(
    repositoryRoot,
    releaseBindings.recoveryClosurePath,
  );
  const recoveryClosure = readManifest(recoveryClosurePath);
  if (
    recoveryClosure.kind !== 'built-in-engine-closure-manifest.v2' ||
    !Array.isArray(recoveryClosure.files)
  ) {
    throw new Error('Release recovery closure binding is invalid.');
  }
  const humanGateBinary = path.join(
    repositoryRoot,
    releaseBindings.humanGateBinaryPath,
  );
  const humanGateSource = path.join(
    repositoryRoot,
    releaseBindings.humanGateSourcePath,
  );
  assertFixedHumanGateArtifact(humanGateBinary, humanGateSource);

  return {
    packageVersions,
    packageIntegrities,
    grantPolicy: {
      schemaVersion: 2,
      digest: digestFile(grantPolicyPath),
    },
    transitionRegistry: {
      contractVersion: 'grant-transition-registry.v1',
      sourceDigest: digestPaths(repositoryRoot, [
        'packages/workflow-engine/src/modules/authority/grant-transition-registry.ts',
      ]),
    },
    protectedCapabilities: {
      schemaVersion: 1,
      digest: digestFile(protectedCapabilitiesPath),
    },
    humanGate: {
      moduleId: 'human-gate-macos',
      version: '1',
      protocolVersion: 1,
      digest: digestFile(humanGateBinary),
      sourceDigest: digestFile(humanGateSource),
      platforms: ['darwin-arm64', 'darwin-x64'],
      provenance: 'source-and-fixed-binary-digest',
    },
    sshProof: {
      moduleId: 'grant-proof-ssh',
      version: '1',
      sourceDigest: digestPaths(repositoryRoot, [
        'packages/workflow-engine/src/adapters/signing/ssh/grant-proof-ssh.ts',
        'packages/workflow-engine/src/modules/authority/grant-policy.ts',
      ]),
      humanSelectedAlternative: true,
    },
    recoveryClosureDigest: digestFile(recoveryClosurePath),
  };
}

function assertEmptyOutputDirectory(outputRoot: string): void {
  const existing = fs.lstatSync(outputRoot, { throwIfNoEntry: false });
  if (existing === undefined) return;
  if (
    existing.isSymbolicLink() ||
    !existing.isDirectory() ||
    fs.readdirSync(outputRoot).length !== 0
  ) {
    throw new Error(
      'Local Jigwright release output must be a new empty directory.',
    );
  }
}

function releasePackageManifest(
  source: Record<string, unknown>,
  versions: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const manifest = structuredClone(source);
  delete manifest.private;
  delete manifest.devDependencies;
  manifest.license =
    typeof manifest.license === 'string' ? manifest.license : 'UNLICENSED';
  manifest.engines = { node: RELEASE_NODE_RANGE };
  assertNoInstallLifecycleScripts(manifest);
  assertNoFloatingCommandFallback(manifest);
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const) {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) continue;
    manifest[field] = Object.fromEntries(
      Object.entries(dependencies).map(([name, range]) => {
        if (range === 'workspace:*') {
          const version = versions.get(name);
          if (version === undefined) {
            throw new Error(
              `Workspace dependency ${name} has no release package.`,
            );
          }
          return [name, version];
        }
        if (typeof range !== 'string' || !isExactVersion(range)) {
          throw new Error(
            `Release dependency ${name} must use an exact version.`,
          );
        }
        return [name, range];
      }),
    );
  }
  if (manifest.name === 'jigwright') {
    manifest.jigwrightRelease = {
      schemaVersion: 1,
      installedCliSurface: 'materialized-typescript-v1',
      entrypoint: './bootstrap/jigwright-cli.mjs',
    };
  }
  return manifest;
}

function writeInstalledRuntimeManifest(
  stagedPackage: string,
  manifests: readonly Readonly<{
    packageRoot: string;
    manifest: ReleasePackageManifest;
  }>[],
): void {
  const closure = readManifest(
    path.join(stagedPackage, 'bootstrap', 'built-in-engine-closure.json'),
  );
  if (!Array.isArray(closure.packages)) {
    throw new Error('Installed Jigwright runtime closure is invalid.');
  }
  const byName = new Map(
    manifests.map(({ packageRoot, manifest }) => [
      manifest.name,
      { packageRoot, manifest },
    ]),
  );
  const root = byName.get('jigwright');
  if (root === undefined) {
    throw new Error('Installed Jigwright runtime root package is missing.');
  }
  const rootOptionalDependencies = isRecord(root.manifest.optionalDependencies)
    ? new Set(Object.keys(root.manifest.optionalDependencies))
    : new Set<string>();
  const packages = closure.packages.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.name !== 'string' ||
      typeof value.sourceRoot !== 'string'
    ) {
      throw new Error('Installed Jigwright runtime closure is invalid.');
    }
    const source = byName.get(value.name);
    if (source === undefined) {
      throw new Error(`Installed runtime package is missing: ${value.name}`);
    }
    const optional = rootOptionalDependencies.has(value.name);
    const fallbackSourceRoot = optional
      ? path.join(
          'bootstrap',
          'installed-runtime-optional-sources',
          safePackageName(value.name),
        )
      : null;
    if (fallbackSourceRoot !== null) {
      fs.cpSync(
        path.join(source.packageRoot, 'src'),
        path.join(stagedPackage, fallbackSourceRoot, 'src'),
        {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
        },
      );
    }
    return {
      name: value.name,
      sourceRoot: value.sourceRoot,
      probe: releasePackageProbe(value.name),
      optional,
      fallbackSourceRoot,
      sourceManifestBase64: fs
        .readFileSync(path.join(source.packageRoot, 'package.json'))
        .toString('base64'),
    };
  });
  fs.writeFileSync(
    path.join(stagedPackage, 'bootstrap', 'installed-runtime.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'jigwright-installed-runtime.v1',
        packages,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function releasePackageProbe(name: string): string {
  const probes: Readonly<Record<string, string>> = {
    jigwright: './bootstrap/jigwright-cli.mjs',
    '@jigwright/agent-runtime': '@jigwright/agent-runtime',
    '@jigwright/core': '@jigwright/core/canonical-json',
    '@jigwright/github-adapter': '@jigwright/github-adapter',
    '@jigwright/grants': '@jigwright/grants/grant-envelope-verifier',
    '@jigwright/openspec-adapter': '@jigwright/openspec-adapter',
  };
  const probe = probes[name];
  if (probe === undefined) {
    throw new Error(`Installed runtime package probe is missing: ${name}`);
  }
  return probe;
}

function readManifest(manifestPath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!isRecord(value))
    throw new Error(`Invalid package manifest: ${manifestPath}`);
  return value;
}

function readReleasePackageManifest(
  manifestPath: string,
  relativeDirectory: string,
): ReleasePackageManifest {
  const manifest = readManifest(manifestPath);
  if (
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every((entry) => typeof entry === 'string')
  ) {
    throw new Error(`Package ${relativeDirectory} is not release-ready.`);
  }
  return manifest as ReleasePackageManifest;
}

function assertReleasePath(value: string): void {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid package release path: ${value}`);
  }
}

function safePackageName(name: string): string {
  return name.replace(/^@/, '').replaceAll('/', '-');
}

export function parseJigwrightReleaseCompatibilityMatrix(
  document: string,
): LocalJigwrightReleaseMatrixV1 {
  let value: unknown;
  try {
    value = JSON.parse(document);
  } catch {
    throw new Error('Jigwright release compatibility matrix is malformed.');
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Jigwright release compatibility schema is unsupported.');
  }
  if (
    value.kind !== 'jigwright-release-compatibility-matrix.v1' ||
    !['local-candidate', 'release-candidate', 'stable'].includes(
      String(value.releaseChannel),
    ) ||
    !Array.isArray(value.packages) ||
    value.packages.length !== EXACT_PACKAGE_NAMES.length ||
    !value.packages.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        typeof entry.version === 'string' &&
        isExactVersion(entry.version) &&
        typeof entry.tarball === 'string' &&
        entry.tarball.length > 0 &&
        !path.isAbsolute(entry.tarball) &&
        path.basename(entry.tarball) === entry.tarball &&
        typeof entry.digest === 'string' &&
        /^sha256:[a-f0-9]{64}$/u.test(entry.digest),
    ) ||
    value.packages.some(
      (entry, index) =>
        (entry as Record<string, unknown>).name !== EXACT_PACKAGE_NAMES[index],
    ) ||
    typeof value.packageSetDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.packageSetDigest)
  ) {
    throw new Error('Jigwright release compatibility matrix is malformed.');
  }
  const computedPackageSetDigest = digestCanonical(
    value.packages.map((entry) => {
      const candidate = entry as Record<string, unknown>;
      return {
        name: candidate.name,
        version: candidate.version,
        tarball: candidate.tarball,
        digest: candidate.digest,
      };
    }),
  );
  if (computedPackageSetDigest !== value.packageSetDigest) {
    throw new Error(
      'Jigwright release compatibility package set does not match its digest.',
    );
  }
  return value as LocalJigwrightReleaseMatrixV1;
}

export function verifyJigwrightReleaseCompatibilityMatrix(
  document: string,
  context: Readonly<{
    repositoryRoot: string;
    releaseRoot: string;
  }>,
): LocalJigwrightReleaseMatrixV1 {
  const matrix = parseJigwrightReleaseCompatibilityMatrix(document);
  const repositoryRoot = fs.realpathSync(context.repositoryRoot);
  const releaseRoot = fs.realpathSync(context.releaseRoot);
  const packages = expectedReleasePackages(repositoryRoot, releaseRoot);
  const releaseBindings = readReleaseBindings(repositoryRoot);
  const dirty =
    run('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repositoryRoot,
    }).length > 0;
  const expected: LocalJigwrightReleaseMatrixV1 = {
    schemaVersion: 1,
    kind: 'jigwright-release-compatibility-matrix.v1',
    releaseChannel: matrix.releaseChannel,
    source: {
      commit: run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
      tree: run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryRoot }),
      dirty,
    },
    runtime: {
      node: RELEASE_NODE_RANGE,
      packageManager: RELEASE_PACKAGE_MANAGER,
    },
    lockfile: {
      path: 'pnpm-lock.yaml',
      digest: digestFile(path.join(repositoryRoot, 'pnpm-lock.yaml')),
    },
    packages,
    packageSetDigest: digestCanonical(
      packages.map(({ name, version, tarball, digest }) => ({
        name,
        version,
        tarball,
        digest,
      })),
    ),
    optionalPackages: OPTIONAL_PACKAGES,
    policies: {
      lifecycleScripts: 'denied',
      globalBinaryFallback: 'denied',
      floatingNpxFallback: 'denied',
      gitlinkDistribution: 'denied',
      exactConsumerVersions: true,
      unknownSchema: 'fail-closed',
    },
    publicContracts: releasePublicContracts(repositoryRoot),
    composition: releaseComposition(repositoryRoot, packages, releaseBindings),
  };
  if (!isDeepStrictEqual(matrix, expected)) {
    throw new Error(
      'Jigwright release compatibility matrix does not match local release inputs.',
    );
  }
  return matrix;
}

function expectedReleasePackages(
  repositoryRoot: string,
  releaseRoot: string,
): readonly ReleasePackageEntry[] {
  const manifests = PACKAGE_DIRECTORIES.map((relativeDirectory) => {
    const packageRoot = path.join(repositoryRoot, relativeDirectory);
    const manifest = readReleasePackageManifest(
      path.join(packageRoot, 'package.json'),
      relativeDirectory,
    );
    return { packageRoot, manifest };
  }).sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
  assertExactPackageSet(manifests.map(({ manifest }) => manifest.name));
  const versions = new Map(
    manifests.map(({ manifest }) => [manifest.name, manifest.version]),
  );
  assertReleaseVersions(versions);

  return manifests.map(({ manifest }) => {
    const releaseManifest = releasePackageManifest(manifest, versions);
    const tarball = `${safePackageName(manifest.name)}-${manifest.version}.tgz`;
    const tarballPath = path.join(releaseRoot, tarball);
    const artifact = fs.lstatSync(tarballPath, { throwIfNoEntry: false });
    if (!artifact?.isFile() || artifact.isSymbolicLink()) {
      throw new Error(
        `Release package artifact integrity cannot be verified: ${tarball}`,
      );
    }
    return {
      name: manifest.name,
      version: manifest.version,
      tarball,
      digest: digestFile(tarballPath),
      license:
        typeof releaseManifest.license === 'string'
          ? releaseManifest.license
          : 'UNLICENSED',
      dependencies: releaseDependencies(releaseManifest),
    };
  });
}

function assertExactPackageSet(names: readonly string[]): void {
  if (
    names.length !== EXACT_PACKAGE_NAMES.length ||
    names.some((name, index) => name !== EXACT_PACKAGE_NAMES[index])
  ) {
    throw new Error('Jigwright v1 requires the exact reviewed package set.');
  }
}

function assertReleaseVersions(versions: ReadonlyMap<string, string>): void {
  for (const name of EXACT_PACKAGE_NAMES) {
    const version = versions.get(name);
    if (version === undefined || !isExactVersion(version)) {
      throw new Error(`Release package ${name} must use an exact version.`);
    }
  }
}

function assertNoGitlinks(repositoryRoot: string): void {
  const staged = run('git', ['ls-files', '--stage'], { cwd: repositoryRoot });
  if (
    staged
      .split('\n')
      .filter(Boolean)
      .some((line) => line.startsWith('160000 '))
  ) {
    throw new Error('Jigwright releases cannot contain gitlinks.');
  }
}

function assertReleaseControlFiles(repositoryRoot: string): void {
  const rust = readManifest(
    path.join(repositoryRoot, 'release/v1/r1-decision.json'),
  );
  const selfHosting = readManifest(
    path.join(repositoryRoot, 'release/v1/self-hosting.json'),
  );
  const license = readManifest(
    path.join(repositoryRoot, 'release/v1/license-state.json'),
  );
  if (
    rust.kind !== 'jigwright-rust-r1-decision.v1' ||
    rust.decision !== 'A-typescript-v1' ||
    rust.typescriptAuthority !== true ||
    rust.rustDependencyInV1 !== false ||
    rust.rewriteDuringExtraction !== 'forbidden' ||
    selfHosting.kind !== 'jigwright-self-hosting-policy.v1' ||
    selfHosting.rule !== 'n-plus-one-uses-n' ||
    !isRecord(selfHosting.firstReleaseBootstrap) ||
    selfHosting.firstReleaseBootstrap.mode !==
      'narrow-one-time-embedded-baseline' ||
    selfHosting.firstReleaseBootstrap.authorityCommit !==
      'b149246ee02872cac517880f9bf9ba3a01d7c467' ||
    selfHosting.firstReleaseBootstrap.appliesOnlyToVersion !== '0.1.0' ||
    selfHosting.firstReleaseBootstrap.independentReview !== 'pending' ||
    !isRecord(selfHosting.nextRelease) ||
    selfHosting.nextRelease.version !== '0.1.1' ||
    selfHosting.nextRelease.requiredAuthorityVersion !== '0.1.0' ||
    license.kind !== 'jigwright-release-license-state.v1' ||
    license.packageLicense !== 'UNLICENSED' ||
    license.status !== 'owner-decision-pending' ||
    license.candidateBuildAllowed !== true ||
    license.registryPublishAllowed !== false
  ) {
    throw new Error('Jigwright v1 release controls are invalid.');
  }
}

function readReleaseBindings(repositoryRoot: string): Readonly<{
  grantPolicyPath: string;
  protectedCapabilitiesPath: string;
  recoveryClosurePath: string;
  providerAvailabilityRecordPath: string;
  humanGateBinaryPath: string;
  humanGateSourcePath: string;
}> {
  const value = readManifest(
    path.join(repositoryRoot, 'release/v1/bindings.json'),
  );
  const keys = [
    'grantPolicyPath',
    'protectedCapabilitiesPath',
    'recoveryClosurePath',
    'providerAvailabilityRecordPath',
    'humanGateBinaryPath',
    'humanGateSourcePath',
  ] as const;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright-release-bindings.v1' ||
    !keys.every(
      (key) =>
        typeof value[key] === 'string' &&
        isSafeRepositoryPath(value[key] as string),
    )
  ) {
    throw new Error('Jigwright v1 release bindings are invalid.');
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, value[key]])),
  ) as Readonly<{
    grantPolicyPath: string;
    protectedCapabilitiesPath: string;
    recoveryClosurePath: string;
    providerAvailabilityRecordPath: string;
    humanGateBinaryPath: string;
    humanGateSourcePath: string;
  }>;
}

function isSafeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    value
      .split('/')
      .every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function assertNoInstallLifecycleScripts(
  manifest: Readonly<Record<string, unknown>>,
): void {
  if (!isRecord(manifest.scripts)) return;
  for (const script of INSTALL_LIFECYCLE_SCRIPTS) {
    if (Object.hasOwn(manifest.scripts, script)) {
      throw new Error(
        `Release package ${String(manifest.name)} declares forbidden lifecycle script ${script}.`,
      );
    }
  }
}

function assertNoFloatingCommandFallback(
  manifest: Readonly<Record<string, unknown>>,
): void {
  const values = isRecord(manifest.scripts)
    ? Object.values(manifest.scripts)
    : [];
  if (
    values.some(
      (value) =>
        typeof value === 'string' &&
        /(?:^|\s)(?:npx|npm\s+exec)(?:\s|$)/u.test(value),
    )
  ) {
    throw new Error(
      `Release package ${String(manifest.name)} declares a floating command fallback.`,
    );
  }
  if (
    manifest.bin !== undefined &&
    (!isRecord(manifest.bin) ||
      Object.values(manifest.bin).some(
        (value) =>
          typeof value !== 'string' ||
          !value.startsWith('./') ||
          value.includes('..'),
      ))
  ) {
    throw new Error(
      `Release package ${String(manifest.name)} has unsafe bins.`,
    );
  }
}

function isExactVersion(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(
    value,
  );
}

function releaseDependencies(
  manifest: Readonly<Record<string, unknown>>,
): ReleasePackageEntry['dependencies'] {
  const required = isRecord(manifest.dependencies) ? manifest.dependencies : {};
  const optional = isRecord(manifest.optionalDependencies)
    ? manifest.optionalDependencies
    : {};
  return [
    ...Object.entries(required).map(([name, version]) => ({
      name,
      version: exactDependencyVersion(name, version),
      optional: false,
    })),
    ...Object.entries(optional).map(([name, version]) => ({
      name,
      version: exactDependencyVersion(name, version),
      optional: true,
    })),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function exactDependencyVersion(name: string, value: unknown): string {
  if (typeof value !== 'string' || !isExactVersion(value)) {
    throw new Error(`Release dependency ${name} must use an exact version.`);
  }
  return value;
}

function assertFixedHumanGateArtifact(
  binaryPath: string,
  sourcePath: string,
): void {
  const binary = fs.lstatSync(binaryPath, { throwIfNoEntry: false });
  const source = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
  if (
    !binary?.isFile() ||
    binary.isSymbolicLink() ||
    (binary.mode & 0o111) === 0 ||
    binary.size < 1 ||
    binary.size > 2 * 1024 * 1024 ||
    !source?.isFile() ||
    source.isSymbolicLink()
  ) {
    throw new Error('Fixed macOS Human Gate release artifact is unsafe.');
  }
  const header = fs.readFileSync(binaryPath).subarray(0, 32);
  if (
    header.length < 32 ||
    header.readUInt32BE(0) !== 0xcafebabe ||
    header.readUInt32BE(4) !== 2 ||
    header.readUInt32BE(8) !== 0x01000007 ||
    header.readUInt32BE(28) !== 0x0100000c
  ) {
    throw new Error(
      'Fixed macOS Human Gate must be the reviewed arm64/x64 universal artifact.',
    );
  }
}

function writeDeterministicTarball(
  stageParent: string,
  tarballPath: string,
): void {
  const entries = collectTarEntries(stageParent, 'package');
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const { name, prefix } = splitUstarPath(entry.archivePath);
    const header = Buffer.alloc(512);
    writeTarText(header, 0, 100, name);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.bytes.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = entry.directory ? '5'.charCodeAt(0) : '0'.charCodeAt(0);
    writeTarText(header, 257, 6, 'ustar\0');
    writeTarText(header, 263, 2, '00');
    writeTarText(header, 345, 155, prefix);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    const checksumText = checksum.toString(8).padStart(6, '0');
    writeTarText(header, 148, 6, checksumText);
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header);
    if (!entry.directory) {
      blocks.push(entry.bytes);
      const remainder = entry.bytes.length % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  blocks.push(Buffer.alloc(1024));
  const gzip = zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
  gzip.fill(0, 4, 8);
  gzip[9] = 0xff;
  fs.writeFileSync(tarballPath, gzip);
}

function collectTarEntries(
  stageParent: string,
  relativePath: string,
): readonly Readonly<{
  archivePath: string;
  directory: boolean;
  mode: number;
  bytes: Buffer;
}>[] {
  const absolutePath = path.join(stageParent, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`Unsupported release archive entry: ${relativePath}`);
  }
  if (stat.isDirectory()) {
    const own = {
      archivePath: `${relativePath}/`,
      directory: true,
      mode: 0o755,
      bytes: Buffer.alloc(0),
    } as const;
    const children = fs
      .readdirSync(absolutePath)
      .sort((left, right) => left.localeCompare(right))
      .flatMap((name) =>
        collectTarEntries(stageParent, path.posix.join(relativePath, name)),
      );
    return [own, ...children];
  }
  return [
    {
      archivePath: relativePath,
      directory: false,
      mode: (stat.mode & 0o111) === 0 ? 0o644 : 0o755,
      bytes: fs.readFileSync(absolutePath),
    },
  ];
}

function splitUstarPath(value: string): { name: string; prefix: string } {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: '' };
  for (let index = value.lastIndexOf('/'); index > 0;) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
    index = value.lastIndexOf('/', index - 1);
  }
  throw new Error(`Release archive path exceeds ustar bounds: ${value}`);
}

function writeTarText(
  target: Buffer,
  offset: number,
  width: number,
  value: string,
): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > width) throw new Error('Release tar field is too long.');
  bytes.copy(target, offset);
}

function writeTarOctal(
  target: Buffer,
  offset: number,
  width: number,
  value: number,
): void {
  const encoded = value.toString(8).padStart(width - 1, '0');
  if (encoded.length > width - 1) {
    throw new Error('Release tar numeric field is too large.');
  }
  writeTarText(target, offset, width - 1, encoded);
  target[offset + width - 1] = 0;
}

function writeReleaseEvidence(
  repositoryRoot: string,
  outputRoot: string,
  matrix: LocalJigwrightReleaseMatrixV1,
): void {
  const matrixPath = path.join(outputRoot, 'compatibility-matrix.json');
  const subjects = matrix.packages.map(({ name, tarball, digest }) => ({
    name,
    uri: tarball,
    digest: { sha256: digest.slice('sha256:'.length) },
  }));
  writeJson(path.join(outputRoot, 'provenance.intoto.json'), {
    _type: 'https://in-toto.io/Statement/v1',
    subject: subjects,
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://jigwright.dev/release/local-typescript-v1',
        externalParameters: {
          releaseChannel: matrix.releaseChannel,
          packageSetDigest: matrix.packageSetDigest,
        },
        internalParameters: {
          runtime: matrix.runtime,
          lifecycleScripts: matrix.policies.lifecycleScripts,
        },
        resolvedDependencies: [
          {
            uri: 'git+local:jigwright',
            digest: {
              gitCommit: matrix.source.commit,
              gitTree: matrix.source.tree,
            },
          },
          {
            uri: matrix.lockfile.path,
            digest: {
              sha256: matrix.lockfile.digest.slice('sha256:'.length),
            },
          },
          ...[
            'release/v1/r1-decision.json',
            'release/v1/self-hosting.json',
            'release/v1/license-state.json',
            'release/v1/bindings.json',
          ].map((relativePath) => ({
            uri: relativePath,
            digest: {
              sha256: digestFile(path.join(repositoryRoot, relativePath)).slice(
                'sha256:'.length,
              ),
            },
          })),
          ...[
            'packages/workflow-engine/native/human-gate-macos/bin/human-gate',
            'packages/workflow-engine/native/human-gate-macos/client/main.swift',
          ].map((relativePath) => ({
            uri: relativePath,
            digest: {
              sha256: digestFile(path.join(repositoryRoot, relativePath)).slice(
                'sha256:'.length,
              ),
            },
          })),
        ],
      },
      runDetails: {
        builder: {
          id: 'https://jigwright.dev/builders/local-release-v1',
          sourceDigest: digestFile(
            path.join(
              repositoryRoot,
              'scripts/build-local-jigwright-release.ts',
            ),
          ),
        },
        metadata: {
          invocationId: matrix.packageSetDigest,
          sourceDirty: matrix.source.dirty,
          reproducibleTimestampPolicy: 'normalized-zero',
        },
        attestation: 'unsigned-local',
      },
    },
  });
  writeJson(path.join(outputRoot, 'sbom.cdx.json'), {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${deterministicUuid(matrix.packageSetDigest)}`,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: 'jigwright-release',
        version: matrix.packages.find(({ name }) => name === 'jigwright')!
          .version,
      },
    },
    components: matrix.packages.map(({ name, version, digest, license }) => ({
      type: name === 'jigwright' ? 'application' : 'library',
      name,
      version,
      purl: npmPackageUrl(name, version),
      hashes: [{ alg: 'SHA-256', content: digest.slice('sha256:'.length) }],
      licenses: [
        {
          license:
            license === 'UNLICENSED' ? { name: license } : { id: license },
        },
      ],
    })),
    dependencies: matrix.packages.map(({ name, version, dependencies }) => ({
      ref: npmPackageUrl(name, version),
      dependsOn: dependencies.map((dependency) =>
        npmPackageUrl(dependency.name, dependency.version),
      ),
    })),
  });
  writeJson(path.join(outputRoot, 'extraction-sequence.json'), {
    schemaVersion: 1,
    kind: 'jigwright-extraction-sequence.v1',
    source: matrix.source,
    steps: extractionSequence(matrix),
    rewritePolicy: 'forbidden-during-extraction',
    rustDecision: {
      gate: 'R1',
      decision: 'A-typescript-v1',
      rustDependencyInV1: false,
    },
  });
  writeGeneratedReleaseDocuments(outputRoot, matrix);

  const evidencePaths = [
    'compatibility-matrix.json',
    'provenance.intoto.json',
    'sbom.cdx.json',
    'extraction-sequence.json',
    'docs/API.md',
    'docs/OPERATIONS.md',
    'docs/COMPATIBILITY.md',
    'docs/RELEASE_NOTES.md',
  ];
  writeJson(path.join(outputRoot, 'integrity.json'), {
    schemaVersion: 1,
    kind: 'jigwright-release-integrity.v1',
    packageSetDigest: matrix.packageSetDigest,
    artifacts: Object.fromEntries(
      [...matrix.packages.map(({ tarball }) => tarball), ...evidencePaths]
        .sort((left, right) => left.localeCompare(right))
        .map((relativePath) => [
          relativePath,
          digestFile(path.join(outputRoot, relativePath)),
        ]),
    ),
  });

  verifyJigwrightReleaseCompatibilityMatrix(
    fs.readFileSync(matrixPath, 'utf8'),
    { repositoryRoot, releaseRoot: outputRoot },
  );
}

function extractionSequence(
  matrix: LocalJigwrightReleaseMatrixV1,
): readonly Readonly<{
  step: number;
  name: string;
  state: 'complete' | 'implementation-ready' | 'operational-gate-pending';
  evidence: string;
}>[] {
  return [
    {
      step: 1,
      name: 'freeze-source-and-public-interface-digests',
      state: matrix.source.dirty ? 'implementation-ready' : 'complete',
      evidence: 'compatibility-matrix.json',
    },
    {
      step: 2,
      name: 'create-independent-repository-without-history-rewrite',
      state: 'complete',
      evidence: `${matrix.source.commit}:${matrix.source.tree}`,
    },
    {
      step: 3,
      name: 'import-packages-tests-fixtures-docs-and-license-state',
      state: 'complete',
      evidence: matrix.packageSetDigest,
    },
    {
      step: 4,
      name: 'configure-n-plus-one-self-hosting-with-n',
      state: 'implementation-ready',
      evidence: 'first-v1-bootstrap-review-pending',
    },
    {
      step: 5,
      name: 'rerun-portability-and-supply-chain-assurance',
      state: 'implementation-ready',
      evidence: 'targeted-local-assurance-ready-real-pilot-pending',
    },
    {
      step: 6,
      name: 'build-release-candidate-and-fresh-install',
      state: 'implementation-ready',
      evidence: 'prepare-jigwright-v1-release-candidate',
    },
    {
      step: 7,
      name: 'rehearse-exact-upgrade-and-downgrade',
      state: 'implementation-ready',
      evidence: 'run-local-jigwright-adoption',
    },
    {
      step: 8,
      name: 'publish-v1-and-record-support-policy',
      state: 'operational-gate-pending',
      evidence: 'npm-publish-not-requested',
    },
  ];
}

function writeGeneratedReleaseDocuments(
  outputRoot: string,
  matrix: LocalJigwrightReleaseMatrixV1,
): void {
  const docsRoot = path.join(outputRoot, 'docs');
  fs.mkdirSync(docsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(docsRoot, 'API.md'),
    [
      '# Jigwright v1 API',
      '',
      'Generated from `compatibility-matrix.json`.',
      '',
      '- `jigwright/manifest-v3`: direct Manifest v3 authoring and validation.',
      '- `jigwright/plan-review`: separate PlanReview contract and validation.',
      '- `jigwright` CLI guidance: versioned guide catalog, next-step projection, and failure-recovery contract from one source.',
      '- `jigwright/central-grant`: Grant challenge, ApprovalSubject, policy, transition, and proof-module ports.',
      '- `@jigwright/agent-runtime`: wrapper protocols, capabilities, start/resume/cancel/status surfaces.',
      '- `@jigwright/grants`: optional Grant implementation and historical read/verify/cleanup adapters; no legacy issuance.',
      '- `@jigwright/openspec-adapter`: independently versioned planning adapter.',
      '- `@jigwright/github-adapter`: optional independently versioned remote adapter.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(docsRoot, 'OPERATIONS.md'),
    [
      '# Jigwright v1 operator guide',
      '',
      'Generated release-candidate procedure:',
      '',
      '1. Build from a clean frozen source commit.',
      '2. Verify `integrity.json`, `provenance.intoto.json`, and `sbom.cdx.json`.',
      '3. Install exact tarballs with network disabled, lifecycle scripts denied, and a frozen lockfile.',
      '4. Rehearse exact upgrade and downgrade in a disposable consumer.',
      '5. Supply independently reviewed self-hosting, real-pilot, full-gate, signed-provenance, and license evidence before publish.',
      '6. Store readiness claims as a signed `jigwright-v1-release-readiness-evidence.v1` object at `objects/sha256/<digest>.json`, then pass it with `prepare-jigwright-v1-release --evidence-object <path>`.',
      '',
      'Release preparation verifies supplied local evidence against the exact source commit, tree, package set, and compatibility matrix. It never creates a signature, runs a pilot or full gate, chooses a license, publishes, or accesses a remote.',
      '',
      'The local candidate command never publishes, pushes, creates a remote, or performs a real provider action.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(docsRoot, 'COMPATIBILITY.md'),
    [
      '# Jigwright v1 compatibility and support',
      '',
      `Package set: \`${matrix.packageSetDigest}\``,
      `Runtime: Node \`${matrix.runtime.node}\`; \`${matrix.runtime.packageManager}\`.`,
      '',
      '- Consumers pin exact package versions and lockfile integrity.',
      '- Breaking report or schema changes require a major version and migration path.',
      '- Unknown newer schemas fail closed.',
      '- Historical managed trailers, reports, and CI replay remain readable.',
      '- Historical `C-AVAILABILITY` records remain verifiable empirical observations and never become a future-provider SLA.',
      '- Planning cutover refuses mixed embedded/external bindings and requires the exact `@jigwright/openspec-adapter` version.',
      '- Agent execution cutover pins the exact `@jigwright/agent-runtime` version, performs read-only dual-run comparison, and preserves historical execution records.',
      '- Provider adapters version remote API assumptions independently.',
      '- Release artifacts are retained for exact downgrade rehearsal.',
      '- License remains `UNLICENSED` until the repository owner records a release license decision.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(docsRoot, 'RELEASE_NOTES.md'),
    [
      '# Jigwright 0.1.0 local release candidate',
      '',
      'Status: implementation-ready; registry publish, real pilot, and full gate remain pending.',
      '',
      'This candidate packages the public `jigwright` CLI/composition and exact optional/internal `@jigwright/*` packages without rewriting the TypeScript engine.',
      '',
    ].join('\n'),
    'utf8',
  );
}

function npmPackageUrl(name: string, version: string): string {
  if (name.startsWith('@')) {
    const separator = name.indexOf('/');
    if (separator < 2 || separator === name.length - 1) {
      throw new Error(`Invalid scoped npm package name: ${name}`);
    }
    return `pkg:npm/${encodeURIComponent(name.slice(0, separator))}/${encodeURIComponent(name.slice(separator + 1))}@${version}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

function digestPaths(
  repositoryRoot: string,
  relativePaths: readonly string[],
): Sha256Digest {
  return digestCanonical(
    [...relativePaths]
      .sort((left, right) => left.localeCompare(right))
      .map((relativePath) => ({
        path: relativePath,
        digest: digestFile(path.join(repositoryRoot, relativePath)),
      })),
  );
}

function digestFile(filePath: string): Sha256Digest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')}`;
}

function digestCanonical(value: unknown): Sha256Digest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function deterministicUuid(digest: Sha256Digest): string {
  const hex = digest.slice('sha256:'.length);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(
  executable: string,
  args: string[],
  options: Readonly<{ cwd?: string }> = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || process.argv[outputIndex + 1] === undefined) {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/build-local-jigwright-release.ts --output <directory>',
    );
  }
  const matrix = buildLocalJigwrightRelease(
    process.cwd(),
    process.argv[outputIndex + 1]!,
  );
  process.stdout.write(`${JSON.stringify(matrix)}\n`);
}
