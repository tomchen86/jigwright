import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  buildSingleJigwrightPackage,
  type SingleJigwrightPackageArtifactV1,
} from './build-single-jigwright-package.ts';
import { loadWorkflowConformanceVectorsV2 } from '../packages/core/src/conformance-vectors.ts';

type JsonRecord = Record<string, unknown>;
type Sha256Digest = `sha256:${string}`;

const CONFORMANCE_VECTOR_SOURCE_PATH =
  'packages/core/conformance/workflow-conformance-v2.json';
const CONFORMANCE_VECTOR_EVIDENCE_PATH =
  'facts/workflow-conformance-v2.json' as const;
const COMMIT_DATES = Object.freeze({
  baseline: '2026-08-30T00:00:00.000Z',
  dependency: '2026-08-30T00:01:00.000Z',
  cutover: '2026-08-30T00:02:00.000Z',
  rollbackCutover: '2026-08-30T00:03:00.000Z',
  rollbackDependency: '2026-08-30T00:04:00.000Z',
});

type GitIdentityV1 = Readonly<{
  commit: string;
  tree: string;
}>;

export type CurrentJigwrightCommandObservationV1 = Readonly<{
  exitCode: number;
  stream: 'stdout' | 'stderr';
  payload: JsonRecord;
  payloadDigest: Sha256Digest;
}>;

export type CurrentJigwrightRepositoryStateFingerprintV1 = Readonly<{
  refs: Sha256Digest;
  tracked: Sha256Digest;
  privateRuntime: Sha256Digest;
}>;

export type CurrentJigwrightV3ComparisonFactsV1 = Readonly<{
  init: Readonly<{
    fresh: CurrentJigwrightCommandObservationV1;
    repeated: CurrentJigwrightCommandObservationV1;
    profileDigest: Sha256Digest;
  }>;
  commands: Readonly<{
    guide: CurrentJigwrightCommandObservationV1;
    doctor: CurrentJigwrightCommandObservationV1;
    status: CurrentJigwrightCommandObservationV1;
    jobList: CurrentJigwrightCommandObservationV1;
  }>;
  manifestV3: Readonly<{
    schemaVersion: 3;
    kind: 'manifest-first-investigation';
    writerOutcome: 'sealed';
    readerOutcome: 'verified';
    manifestDigest: string;
    investigationTargetDigest: string;
    negativeOutcome: 'blocked';
    negativeCode: string;
  }>;
  centralGrant: Readonly<{
    policySchemaVersion: 2;
    policyDigest: Sha256Digest;
    recordKind: 'grant-record.v1';
    recordState: 'pending';
    challengeDigest: Sha256Digest;
    recordDigest: Sha256Digest;
    publicReadKind: 'grant-record.v1';
  }>;
  state: Readonly<{
    before: CurrentJigwrightRepositoryStateFingerprintV1;
    after: CurrentJigwrightRepositoryStateFingerprintV1;
    unchanged: true;
  }>;
  routedEffects: Readonly<{
    scope: 'selected-current-v3-read-only-probes';
    requestedGrantTransitions: 0;
    humanGateCommands: 0;
    externalEffectCommands: 0;
    observedStateMutation: 0;
  }>;
}>;

export type CurrentJigwrightAdoptionComparisonV1 = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-current-v3-source-installed-comparison.v1';
  bindings: Readonly<{
    releaseDigest: Sha256Digest;
    source: GitIdentityV1;
    consumer: GitIdentityV1;
    vectors: Readonly<{
      path: 'facts/workflow-conformance-v2.json';
      fileDigest: Sha256Digest;
      vectorSetDigest: Sha256Digest;
    }>;
  }>;
  source: CurrentJigwrightV3ComparisonFactsV1;
  installed: CurrentJigwrightV3ComparisonFactsV1;
  factsDigest: Sha256Digest;
  exact: true;
}>;

export type CurrentJigwrightAdoptionReportV1 = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-current-local-adoption-report.v1';
  release: SingleJigwrightPackageArtifactV1;
  install: Readonly<{
    networkPolicy: 'offline-exact-local-tarball';
    packageManager: 'npm';
    lifecycleScriptsDenied: true;
    lockfileVerified: true;
    publicPackageIdentities: readonly ['jigwright'];
    package: Readonly<{
      name: 'jigwright';
      version: string;
      digest: `sha256:${string}`;
    }>;
    lockfile: Readonly<{
      path: 'package-lock.json';
      digest: Sha256Digest;
      resolved: string;
      integrity: `sha512-${string}`;
      integrityVerified: true;
    }>;
  }>;
  bootstrap: Readonly<{
    init: Readonly<{
      kind: 'jigwright-init-result.v1';
      status: 'initialized';
      path: string;
      digest: `sha256:${string}`;
    }>;
    repeatedInit: Readonly<{
      exitCode: 12;
      errorClass: 'JIGWRIGHT_INIT_ALREADY_CONFIGURED';
    }>;
    policyUnchanged: true;
    guide: 'workflow-command-guide.v1';
  }>;
  publicSurfaces: Readonly<{
    manifestV3: true;
    planReview: true;
    centralGrant: true;
  }>;
  consumer: Readonly<{
    commit: string;
    tree: string;
    clean: true;
    history: Readonly<{
      baseline: GitIdentityV1;
      dependency: GitIdentityV1;
      cutover: GitIdentityV1;
    }>;
    rollback: Readonly<{
      kind: 'jigwright-consumer-rollback-rehearsal.v1';
      revertedCommits: readonly [string, string];
      commit: string;
      tree: string;
      baselineTreeMatched: true;
      clean: true;
    }>;
  }>;
  comparison: CurrentJigwrightAdoptionComparisonV1;
  currentOnly: Readonly<{
    historicalRuntimeState: 'unsupported';
    dualRun: 'retired';
    rollback: 'revert-consumer-cutover-commit';
  }>;
  operationalGates: Readonly<{
    implementation: 'implementation-ready';
    realPilot: 'real-pilot-pending';
    fullGate: 'full-gate-pending';
  }>;
}>;

export function runCurrentJigwrightAdoption(
  requestedRepositoryRoot: string,
  requestedAdoptionRoot: string,
  options: Readonly<{ allowDirty?: boolean }> = {},
): CurrentJigwrightAdoptionReportV1 {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const adoptionRoot = path.resolve(requestedAdoptionRoot);
  assertEmptyDirectory(adoptionRoot);

  const releaseRoot = path.join(adoptionRoot, 'release');
  const release = buildSingleJigwrightPackage(
    repositoryRoot,
    releaseRoot,
    options,
  );
  if (release.name !== 'jigwright') {
    throw new Error(
      'Current adoption requires the single public Jigwright package.',
    );
  }

  const vectorSourcePath = path.join(
    repositoryRoot,
    CONFORMANCE_VECTOR_SOURCE_PATH,
  );
  const vectorEvidencePath = path.join(
    adoptionRoot,
    CONFORMANCE_VECTOR_EVIDENCE_PATH,
  );
  const vectorBytes = fs.readFileSync(vectorSourcePath);
  const vectorDocument = loadWorkflowConformanceVectorsV2({
    vectorPath: vectorSourcePath,
  });
  fs.mkdirSync(path.dirname(vectorEvidencePath), { recursive: true });
  fs.writeFileSync(vectorEvidencePath, vectorBytes);

  const consumerRoot = path.join(adoptionRoot, 'consumer');
  fs.mkdirSync(consumerRoot, { recursive: true });
  initializeConsumerRepository(consumerRoot);
  writeJson(path.join(consumerRoot, 'package.json'), {
    name: 'jigwright-current-adoption-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
  });
  writeText(path.join(consumerRoot, '.gitignore'), 'node_modules/\n');
  writeJson(path.join(consumerRoot, 'workflow', 'config.json'), {
    schemaVersion: 1,
    repositoryName: 'jigwright-current-adoption-consumer',
    consumerNamespace: 'jigwright-current-adoption-consumer',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
  });
  writeText(
    path.join(consumerRoot, 'docs', 'adoption.md'),
    '# Current Jigwright adoption\n',
  );
  git(consumerRoot, [
    'add',
    '--',
    '.gitignore',
    'package.json',
    'workflow/config.json',
    'docs/adoption.md',
  ]);
  commitConsumer(
    consumerRoot,
    'Create current Jigwright consumer baseline',
    COMMIT_DATES.baseline,
  );
  const baseline = gitIdentity(consumerRoot);

  const tarballPath = path.join(releaseRoot, release.tarball);
  const tarballReference = `file:${path
    .relative(consumerRoot, tarballPath)
    .split(path.sep)
    .join('/')}`;
  writeJson(path.join(consumerRoot, 'package.json'), {
    name: 'jigwright-current-adoption-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { jigwright: tarballReference },
  });
  const installEnvironment = {
    CI: 'true',
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
    npm_config_cache: path.join(adoptionRoot, 'npm-cache'),
  };
  runRequired(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=true',
    ],
    consumerRoot,
    installEnvironment,
  );
  const lockfilePath = path.join(consumerRoot, 'package-lock.json');
  const lockfileBefore = fs.readFileSync(lockfilePath);
  runRequired(
    'npm',
    ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    consumerRoot,
    installEnvironment,
  );
  if (!fs.readFileSync(lockfilePath).equals(lockfileBefore)) {
    throw new Error(
      'Current adoption frozen install changed package-lock.json.',
    );
  }
  const lockfile = inspectInstalledLockfile(
    lockfilePath,
    tarballReference,
    tarballPath,
  );
  git(consumerRoot, ['add', '--', 'package.json', 'package-lock.json']);
  commitConsumer(
    consumerRoot,
    'Bind exact local Jigwright dependency',
    COMMIT_DATES.dependency,
  );
  const dependency = gitIdentity(consumerRoot);

  const installedRoot = fs.realpathSync(
    path.join(consumerRoot, 'node_modules', 'jigwright'),
  );
  const installedManifest = readJson(path.join(installedRoot, 'package.json'));
  if (
    installedManifest.name !== 'jigwright' ||
    installedManifest.version !== release.version ||
    'dependencies' in installedManifest ||
    'optionalDependencies' in installedManifest ||
    'peerDependencies' in installedManifest
  ) {
    throw new Error('Installed current Jigwright package identity is invalid.');
  }

  const sourceProbeRoot = path.join(adoptionRoot, 'source-probe');
  runRequired(
    'git',
    ['clone', '--quiet', '--no-hardlinks', consumerRoot, sourceProbeRoot],
    adoptionRoot,
  );
  configureConsumerRepository(sourceProbeRoot);

  const sourceExecutable = path.join(
    repositoryRoot,
    'packages/workflow-engine/bootstrap/jigwright-cli.mjs',
  );
  const installedExecutable = path.join(installedRoot, 'bin', 'jigwright.mjs');

  const sourceFreshInit = observeJigwrightCommand(
    sourceExecutable,
    sourceProbeRoot,
    ['init'],
  );
  const sourceInit = requireFreshInit(sourceFreshInit);
  const sourceProfilePath = path.join(sourceProbeRoot, sourceInit.path);
  const sourceProfileBytes = fs.readFileSync(sourceProfilePath);
  const sourceRepeatedInit = observeJigwrightCommand(
    sourceExecutable,
    sourceProbeRoot,
    ['init'],
  );
  requireRepeatedInit(
    sourceRepeatedInit,
    sourceProfilePath,
    sourceProfileBytes,
  );
  git(sourceProbeRoot, ['add', '--', sourceInit.path]);
  commitConsumer(
    sourceProbeRoot,
    'Activate current Jigwright profile',
    COMMIT_DATES.cutover,
  );

  const installedFreshInit = observeJigwrightCommand(
    installedExecutable,
    consumerRoot,
    ['init'],
  );
  const init = requireFreshInit(installedFreshInit);
  const profilePath = path.join(consumerRoot, init.path);
  const profileBytes = fs.readFileSync(profilePath);
  const installedRepeatedInit = observeJigwrightCommand(
    installedExecutable,
    consumerRoot,
    ['init'],
  );
  requireRepeatedInit(installedRepeatedInit, profilePath, profileBytes);
  if (
    !sourceProfileBytes.equals(profileBytes) ||
    !sameJson(sourceFreshInit, installedFreshInit) ||
    !sameJson(sourceRepeatedInit, installedRepeatedInit)
  ) {
    throw new Error('Source and installed Jigwright init facts differ.');
  }
  git(consumerRoot, ['add', '--', init.path]);
  commitConsumer(
    consumerRoot,
    'Activate current Jigwright profile',
    COMMIT_DATES.cutover,
  );
  const cutover = gitIdentity(consumerRoot);
  if (!sameJson(gitIdentity(sourceProbeRoot), cutover)) {
    throw new Error('Source and installed Jigwright cutover trees differ.');
  }

  const sourceFacts = collectCurrentV3ComparisonFacts({
    repositoryRoot,
    consumerRoot,
    executable: sourceExecutable,
    manifestSpecifier: pathToFileURL(
      path.join(
        repositoryRoot,
        'packages/workflow-engine/src/composition-root/public/manifest-v3.ts',
      ),
    ).href,
    centralGrantSpecifier: pathToFileURL(
      path.join(
        repositoryRoot,
        'packages/workflow-engine/src/composition-root/public/central-grant.ts',
      ),
    ).href,
    vectorEvidencePath,
    freshInit: sourceFreshInit,
    repeatedInit: sourceRepeatedInit,
    profileDigest: digestBytes(sourceProfileBytes),
  });
  const installedFacts = collectCurrentV3ComparisonFacts({
    repositoryRoot,
    consumerRoot,
    executable: installedExecutable,
    manifestSpecifier: 'jigwright/manifest-v3',
    centralGrantSpecifier: 'jigwright/central-grant',
    vectorEvidencePath,
    freshInit: installedFreshInit,
    repeatedInit: installedRepeatedInit,
    profileDigest: digestBytes(profileBytes),
  });
  if (!sameJson(sourceFacts, installedFacts)) {
    throw new Error('Source and installed current-v3 facts differ.');
  }

  const publicSurfaces = inspectInstalledPublicSurfaces(consumerRoot);
  const rollback = rehearseConsumerRollback(
    adoptionRoot,
    consumerRoot,
    baseline,
    dependency,
    cutover,
  );
  const clean = git(consumerRoot, ['status', '--porcelain']).length === 0;
  if (!clean) throw new Error('Current Jigwright adoption consumer is dirty.');

  const comparison = createCurrentJigwrightAdoptionComparison({
    releaseDigest: release.digest,
    source: { commit: release.source.commit, tree: release.source.tree },
    consumer: cutover,
    vectorFileDigest: digestBytes(vectorBytes),
    vectorSetDigest: vectorDocument.vectorSetDigest,
    sourceFacts,
    installedFacts,
  });
  const report: CurrentJigwrightAdoptionReportV1 = Object.freeze({
    schemaVersion: 1,
    kind: 'jigwright-current-local-adoption-report.v1',
    release,
    install: Object.freeze({
      networkPolicy: 'offline-exact-local-tarball',
      packageManager: 'npm',
      lifecycleScriptsDenied: true,
      lockfileVerified: true,
      publicPackageIdentities: Object.freeze(['jigwright'] as const),
      package: Object.freeze({
        name: 'jigwright' as const,
        version: release.version,
        digest: release.digest,
      }),
      lockfile,
    }),
    bootstrap: Object.freeze({
      init: Object.freeze({
        kind: 'jigwright-init-result.v1' as const,
        status: 'initialized' as const,
        path: init.path,
        digest: init.digest,
      }),
      repeatedInit: Object.freeze({
        exitCode: 12 as const,
        errorClass: 'JIGWRIGHT_INIT_ALREADY_CONFIGURED' as const,
      }),
      policyUnchanged: true as const,
      guide: 'workflow-command-guide.v1' as const,
    }),
    publicSurfaces: Object.freeze({
      manifestV3: true as const,
      planReview: true as const,
      centralGrant: true as const,
    }),
    consumer: Object.freeze({
      ...cutover,
      clean: true as const,
      history: Object.freeze({ baseline, dependency, cutover }),
      rollback,
    }),
    comparison,
    currentOnly: Object.freeze({
      historicalRuntimeState: 'unsupported' as const,
      dualRun: 'retired' as const,
      rollback: 'revert-consumer-cutover-commit' as const,
    }),
    operationalGates: Object.freeze({
      implementation: 'implementation-ready' as const,
      realPilot: 'real-pilot-pending' as const,
      fullGate: 'full-gate-pending' as const,
    }),
  });
  verifyCurrentJigwrightAdoptionReportV1(report, release);
  verifyCurrentJigwrightAdoptionArtifacts(adoptionRoot, report);
  return report;
}

function initializeConsumerRepository(consumerRoot: string): void {
  git(consumerRoot, ['init', '-b', 'main']);
  configureConsumerRepository(consumerRoot);
}

function configureConsumerRepository(consumerRoot: string): void {
  git(consumerRoot, ['config', 'user.email', 'jigwright@example.test']);
  git(consumerRoot, ['config', 'user.name', 'Jigwright Adoption']);
}

function commitConsumer(
  repositoryRoot: string,
  message: string,
  timestamp: string,
): void {
  git(repositoryRoot, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  });
}

function gitIdentity(repositoryRoot: string): GitIdentityV1 {
  return Object.freeze({
    commit: git(repositoryRoot, ['rev-parse', 'HEAD']),
    tree: git(repositoryRoot, ['rev-parse', 'HEAD^{tree}']),
  });
}

function inspectInstalledLockfile(
  lockfilePath: string,
  expectedResolved: string,
  tarballPath: string,
): CurrentJigwrightAdoptionReportV1['install']['lockfile'] {
  const value = readJson(lockfilePath);
  const packages = isRecord(value.packages) ? value.packages : null;
  const installed =
    packages === null || !isRecord(packages['node_modules/jigwright'])
      ? null
      : packages['node_modules/jigwright'];
  const integrity = installed?.integrity;
  const expectedIntegrity = `sha512-${crypto
    .createHash('sha512')
    .update(fs.readFileSync(tarballPath))
    .digest('base64')}`;
  if (
    value.lockfileVersion !== 3 ||
    installed?.resolved !== expectedResolved ||
    typeof integrity !== 'string' ||
    integrity !== expectedIntegrity
  ) {
    throw new Error('Current adoption lockfile binding is invalid.');
  }
  return Object.freeze({
    path: 'package-lock.json' as const,
    digest: digestBytes(fs.readFileSync(lockfilePath)),
    resolved: expectedResolved,
    integrity: integrity as `sha512-${string}`,
    integrityVerified: true as const,
  });
}

function observeJigwrightCommand(
  executable: string,
  repositoryRoot: string,
  args: readonly string[],
): CurrentJigwrightCommandObservationV1 {
  const result = runCommand(
    process.execPath,
    [executable, '--repository-root', repositoryRoot, ...args, '--json'],
    repositoryRoot,
  );
  if (result.status === null) {
    throw new Error(`Jigwright ${args.join(' ')} was interrupted.`);
  }
  const stream = result.status === 0 ? 'stdout' : 'stderr';
  const output = stream === 'stdout' ? result.stdout : result.stderr;
  if (typeof output !== 'string' || output.trim().length === 0) {
    throw new Error(`Jigwright ${args.join(' ')} returned no JSON payload.`);
  }
  const payload = normalizeCommandPayload(
    parseJsonOutput(output),
    repositoryRoot,
  );
  return Object.freeze({
    exitCode: result.status,
    stream,
    payload,
    payloadDigest: digestJson(payload),
  });
}

function requireFreshInit(
  observation: CurrentJigwrightCommandObservationV1,
): Readonly<{
  kind: 'jigwright-init-result.v1';
  status: 'initialized';
  path: string;
  digest: Sha256Digest;
}> {
  const result = isRecord(observation.payload.result)
    ? observation.payload.result
    : null;
  if (
    observation.exitCode !== 0 ||
    observation.stream !== 'stdout' ||
    observation.payload.ok !== true ||
    result?.kind !== 'jigwright-init-result.v1' ||
    result.status !== 'initialized' ||
    result.path !== 'workflow/jigwright-profile.json' ||
    !isSha256Digest(result.digest)
  ) {
    throw new Error('Current Jigwright init result is invalid.');
  }
  return result as ReturnType<typeof requireFreshInit>;
}

function requireRepeatedInit(
  observation: CurrentJigwrightCommandObservationV1,
  profilePath: string,
  expectedBytes: Buffer,
): void {
  const error = isRecord(observation.payload.error)
    ? observation.payload.error
    : null;
  if (
    observation.exitCode !== 12 ||
    observation.stream !== 'stderr' ||
    observation.payload.ok !== false ||
    error?.code !== 'JIGWRIGHT_INIT_ALREADY_CONFIGURED' ||
    !fs.readFileSync(profilePath).equals(expectedBytes)
  ) {
    throw new Error('Current Jigwright init did not preserve policy bytes.');
  }
}

function inspectInstalledPublicSurfaces(consumerRoot: string): JsonRecord {
  const publicSurfaces = parseJsonOutput(
    runRequired(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "const manifest = await import('jigwright/manifest-v3');",
          "const review = await import('jigwright/plan-review');",
          "const grant = await import('jigwright/central-grant');",
          'process.stdout.write(JSON.stringify({',
          "  manifestV3: typeof manifest.validateForAuthority === 'function',",
          "  planReview: typeof review.validatePlanReview === 'function',",
          "  centralGrant: typeof grant.loadGrantPolicyV2 === 'function',",
          '}));',
        ].join('\n'),
      ],
      consumerRoot,
    ),
  );
  if (
    publicSurfaces.manifestV3 !== true ||
    publicSurfaces.planReview !== true ||
    publicSurfaces.centralGrant !== true
  ) {
    throw new Error(
      'Installed current Jigwright public surface is incomplete.',
    );
  }
  return publicSurfaces;
}

function normalizeCommandPayload(
  value: JsonRecord,
  repositoryRoot: string,
): JsonRecord {
  const gitCommonDirectory = path.resolve(
    repositoryRoot,
    git(repositoryRoot, ['rev-parse', '--git-common-dir']),
  );
  return normalizeJsonStrings(value, [
    [gitCommonDirectory, '<consumer-git-common>'],
    [fs.realpathSync(repositoryRoot), '<consumer-root>'],
  ]) as JsonRecord;
}

function normalizeJsonStrings(
  value: unknown,
  replacements: readonly (readonly [string, string])[],
): unknown {
  if (typeof value === 'string') {
    return [...replacements]
      .sort(([left], [right]) => right.length - left.length)
      .reduce(
        (current, [source, target]) => current.replaceAll(source, target),
        value,
      );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonStrings(entry, replacements));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeJsonStrings(entry, replacements),
      ]),
    );
  }
  return value;
}

function repositoryStateFingerprint(
  repositoryRoot: string,
): CurrentJigwrightRepositoryStateFingerprintV1 {
  const commonDirectory = path.resolve(
    repositoryRoot,
    git(repositoryRoot, ['rev-parse', '--git-common-dir']),
  );
  return Object.freeze({
    refs: digestBytes(git(repositoryRoot, ['show-ref', '--head'])),
    tracked: digestBytes(git(repositoryRoot, ['ls-files', '-s', '-z'])),
    privateRuntime: fingerprintFilesystemTree(
      path.join(commonDirectory, 'workflow-engine'),
    ),
  });
}

function fingerprintFilesystemTree(root: string): Sha256Digest {
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stats === undefined) return digestBytes('absent\n');
  const entries: string[] = [];
  const visit = (absolutePath: string, relativePath: string): void => {
    const current = fs.lstatSync(absolutePath);
    const mode = (current.mode & 0o777).toString(8).padStart(3, '0');
    if (current.isSymbolicLink()) {
      entries.push(
        `link\0${relativePath}\0${mode}\0${fs.readlinkSync(absolutePath)}`,
      );
      return;
    }
    if (current.isDirectory()) {
      entries.push(`directory\0${relativePath}\0${mode}`);
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(
          path.join(absolutePath, name),
          path.posix.join(relativePath, name),
        );
      }
      return;
    }
    if (current.isFile()) {
      entries.push(
        `file\0${relativePath}\0${mode}\0${digestBytes(fs.readFileSync(absolutePath))}`,
      );
      return;
    }
    entries.push(`other\0${relativePath}\0${mode}`);
  };
  visit(root, '.');
  return digestBytes(entries.join('\n'));
}

function collectCurrentV3ComparisonFacts(
  input: Readonly<{
    repositoryRoot: string;
    consumerRoot: string;
    executable: string;
    manifestSpecifier: string;
    centralGrantSpecifier: string;
    vectorEvidencePath: string;
    freshInit: CurrentJigwrightCommandObservationV1;
    repeatedInit: CurrentJigwrightCommandObservationV1;
    profileDigest: Sha256Digest;
  }>,
): CurrentJigwrightV3ComparisonFactsV1 {
  const before = repositoryStateFingerprint(input.consumerRoot);
  const guide = observeJigwrightCommand(input.executable, input.consumerRoot, [
    'guide',
  ]);
  const doctor = observeJigwrightCommand(input.executable, input.consumerRoot, [
    'doctor',
  ]);
  const status = observeJigwrightCommand(input.executable, input.consumerRoot, [
    'status',
  ]);
  const jobList = observeJigwrightCommand(
    input.executable,
    input.consumerRoot,
    ['job', 'list'],
  );
  requireReadOnlyCommand(guide, 'guide');
  requireReadOnlyCommand(doctor, 'doctor');
  requireReadOnlyCommand(status, 'status');
  requireReadOnlyCommand(jobList, 'job', 'list');

  const publicFacts = runCurrentV3PublicProbe(input);
  const manifestV3 = isRecord(publicFacts.manifestV3)
    ? publicFacts.manifestV3
    : null;
  const centralGrant = isRecord(publicFacts.centralGrant)
    ? publicFacts.centralGrant
    : null;
  if (!isManifestV3ComparisonFacts(manifestV3)) {
    throw new Error('Current Manifest V3 comparison facts are invalid.');
  }
  if (!isCentralGrantComparisonFacts(centralGrant)) {
    throw new Error('Current Central Grant comparison facts are invalid.');
  }

  const after = repositoryStateFingerprint(input.consumerRoot);
  if (!sameJson(before, after)) {
    throw new Error('Current-v3 read-only probes changed repository state.');
  }
  return Object.freeze({
    init: Object.freeze({
      fresh: input.freshInit,
      repeated: input.repeatedInit,
      profileDigest: input.profileDigest,
    }),
    commands: Object.freeze({ guide, doctor, status, jobList }),
    manifestV3,
    centralGrant,
    state: Object.freeze({ before, after, unchanged: true as const }),
    routedEffects: Object.freeze({
      scope: 'selected-current-v3-read-only-probes' as const,
      requestedGrantTransitions: 0 as const,
      humanGateCommands: 0 as const,
      externalEffectCommands: 0 as const,
      observedStateMutation: 0 as const,
    }),
  });
}

function requireReadOnlyCommand(
  observation: CurrentJigwrightCommandObservationV1,
  command: string,
  action?: string,
): void {
  if (
    observation.exitCode !== 0 ||
    observation.stream !== 'stdout' ||
    observation.payload.ok !== true ||
    observation.payload.command !== command ||
    (action !== undefined && observation.payload.action !== action)
  ) {
    const code =
      typeof observation.payload.code === 'string'
        ? observation.payload.code
        : isRecord(observation.payload.error)
          ? String(observation.payload.error.code)
          : 'unknown';
    throw new Error(
      `Current Jigwright ${[command, action].filter(Boolean).join(' ')} probe failed: ${code}.`,
    );
  }
  if (
    command === 'guide' &&
    (!isRecord(observation.payload.guide) ||
      observation.payload.guide.kind !== 'workflow-command-guide.v1')
  ) {
    throw new Error('Current Jigwright guide payload is invalid.');
  }
  if (
    command === 'status' &&
    (!Array.isArray(observation.payload.sessions) ||
      observation.payload.sessions.length !== 0)
  ) {
    throw new Error('Current Jigwright status probe is not an empty read.');
  }
  if (
    command === 'job' &&
    (!Array.isArray(observation.payload.jobs) ||
      observation.payload.jobs.length !== 0)
  ) {
    throw new Error('Current Jigwright Job probe is not an empty read.');
  }
}

function runCurrentV3PublicProbe(
  input: Readonly<{
    consumerRoot: string;
    manifestSpecifier: string;
    centralGrantSpecifier: string;
    vectorEvidencePath: string;
  }>,
): JsonRecord {
  const identity = gitIdentity(input.consumerRoot);
  return parseJsonOutput(
    runRequired(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        CURRENT_V3_PUBLIC_PROBE,
      ],
      input.consumerRoot,
      {
        JIGWRIGHT_ADOPTION_REPOSITORY_ROOT: input.consumerRoot,
        JIGWRIGHT_ADOPTION_MANIFEST_SPECIFIER: input.manifestSpecifier,
        JIGWRIGHT_ADOPTION_CENTRAL_GRANT_SPECIFIER: input.centralGrantSpecifier,
        JIGWRIGHT_ADOPTION_VECTOR_PATH: input.vectorEvidencePath,
        JIGWRIGHT_ADOPTION_CONSUMER_HEAD: identity.commit,
        JIGWRIGHT_ADOPTION_CONSUMER_TREE: identity.tree,
      },
    ),
  );
}

const CURRENT_V3_PUBLIC_PROBE = String.raw`
import crypto from 'node:crypto';
import fs from 'node:fs';

const required = (name) => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Current adoption probe input is missing.');
  }
  return value;
};
const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');
const repositoryRoot = required('JIGWRIGHT_ADOPTION_REPOSITORY_ROOT');
const manifest = await import(required('JIGWRIGHT_ADOPTION_MANIFEST_SPECIFIER'));
const grant = await import(
  required('JIGWRIGHT_ADOPTION_CENTRAL_GRANT_SPECIFIER')
);
const vectorDocument = JSON.parse(
  fs.readFileSync(required('JIGWRIGHT_ADOPTION_VECTOR_PATH'), 'utf8'),
);
const centralVector = vectorDocument.domains?.['central-grant']?.[0];
if (
  centralVector?.id !== 'central-grant-challenge-and-subject' ||
  typeof centralVector.grantRecordCanonical !== 'string' ||
  typeof centralVector.grantRecordDigest !== 'string'
) {
  throw new Error('Current Central Grant vector is unavailable.');
}
const head = required('JIGWRIGHT_ADOPTION_CONSUMER_HEAD');
const tree = required('JIGWRIGHT_ADOPTION_CONSUMER_TREE');
const state = {
  schemaVersion: 1,
  applicabilityKind: 'exemption',
  repositoryId: 'jigwright-current-adoption-consumer',
  changeId: 'current-v3-source-installed-comparison',
  investigationId: 'investigation-current-v3-comparison',
  normalizedIntent: {
    schemaVersion: 1,
    summary: 'Verify exact source and installed current-v3 behavior.',
    explicitPaths: ['docs/adoption.md'],
    explicitSymbols: [],
    explicitConfigKeys: [],
    renamePairs: [],
  },
  authoring: {
    sessionRevision: 1,
    sessionSnapshotDigest: sha256('current-v3-comparison-snapshot'),
  },
  exemption: {
    category: 'documentation-only',
    baseline: { commitOid: head, treeOid: tree },
    declaredPaths: ['docs/adoption.md'],
    declaredChangeClasses: ['documentation-only'],
    rationale: 'The local parity probe reads current public contracts only.',
    semanticAuthor: {
      id: 'local-adoption',
      provenance: 'local:current-v3-source-installed-comparison',
    },
    nonTrivialBehaviorReliance: 'none-declared',
    researchBudgetMinutes: null,
  },
};
const built = manifest.buildInvestigationManifestDraft({
  repositoryRoot,
  state,
});
if (built.outcome !== 'built') throw new Error('Manifest V3 writer blocked.');
const sealed = manifest.sealInvestigationManifestDraft({
  draft: built.draft,
  approval: {
    semanticAuthor: {
      id: 'local-adoption',
      provenance: 'local:current-v3-source-installed-comparison',
    },
    approvalProvenanceDigest: sha256('current-v3-comparison-approval'),
  },
});
if (sealed.outcome !== 'sealed') throw new Error('Manifest V3 seal blocked.');
const expected = {
  repositoryId: state.repositoryId,
  changeId: state.changeId,
  investigationId: state.investigationId,
  sessionRevision: state.authoring.sessionRevision,
  sessionSnapshotDigest: state.authoring.sessionSnapshotDigest,
};
const verified = manifest.validateForAuthority({
  repositoryRoot,
  manifest: sealed.manifest,
  expected,
});
if (verified.outcome !== 'verified') {
  throw new Error('Manifest V3 authority read blocked.');
}
const tampered = structuredClone(sealed.manifest);
tampered.manifestDigest = '0'.repeat(64);
const negative = manifest.validateForAuthority({
  repositoryRoot,
  manifest: tampered,
  expected,
});
if (negative.outcome !== 'blocked') {
  throw new Error('Manifest V3 negative read did not fail closed.');
}

const policyDocument = JSON.stringify({
  schemaVersion: 2,
  defaultProfile: 'local-presence',
  profiles: {
    'local-presence': { requiredClaims: ['fresh-local-device-owner'] },
  },
  approvalModules: [
    {
      moduleId: 'human-gate-macos',
      version: '1',
      allowedClaims: ['fresh-local-device-owner'],
      configurationDigest: grant.HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
    },
  ],
}) + '\n';
const policy = grant.parseGrantPolicyV2Document(policyDocument);
const canonicalRecord = centralVector.grantRecordCanonical + '\n';
const record = grant.parseCanonicalGrantRecordV1(canonicalRecord);
const publicRecord = grant.assertCentralGrantPublicDocumentV1(record);
const recordDigest = 'sha256:' + sha256(centralVector.grantRecordCanonical);
if (recordDigest !== centralVector.grantRecordDigest) {
  throw new Error('Current Central Grant vector digest is invalid.');
}

process.stdout.write(
  JSON.stringify({
    manifestV3: {
      schemaVersion: sealed.manifest.schemaVersion,
      kind: sealed.manifest.kind,
      writerOutcome: sealed.outcome,
      readerOutcome: verified.outcome,
      manifestDigest: verified.manifestDigest,
      investigationTargetDigest: verified.investigationTargetDigest,
      negativeOutcome: negative.outcome,
      negativeCode: negative.blocker.failureCode,
    },
    centralGrant: {
      policySchemaVersion: policy.policy.schemaVersion,
      policyDigest: 'sha256:' + policy.digest,
      recordKind: record.kind,
      recordState: record.state,
      challengeDigest: record.challenge.challengeDigest,
      recordDigest,
      publicReadKind: publicRecord.kind,
    },
  }),
);
`;

function isManifestV3ComparisonFacts(
  value: JsonRecord | null,
): value is CurrentJigwrightV3ComparisonFactsV1['manifestV3'] {
  return (
    value !== null &&
    hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'writerOutcome',
      'readerOutcome',
      'manifestDigest',
      'investigationTargetDigest',
      'negativeOutcome',
      'negativeCode',
    ]) &&
    value.schemaVersion === 3 &&
    value.kind === 'manifest-first-investigation' &&
    value.writerOutcome === 'sealed' &&
    value.readerOutcome === 'verified' &&
    isDigest(value.manifestDigest) &&
    isDigest(value.investigationTargetDigest) &&
    value.negativeOutcome === 'blocked' &&
    value.negativeCode === 'RECONSTRUCTION_MISMATCH'
  );
}

function isCentralGrantComparisonFacts(
  value: JsonRecord | null,
): value is CurrentJigwrightV3ComparisonFactsV1['centralGrant'] {
  return (
    value !== null &&
    hasExactKeys(value, [
      'policySchemaVersion',
      'policyDigest',
      'recordKind',
      'recordState',
      'challengeDigest',
      'recordDigest',
      'publicReadKind',
    ]) &&
    value.policySchemaVersion === 2 &&
    isSha256Digest(value.policyDigest) &&
    value.recordKind === 'grant-record.v1' &&
    value.recordState === 'pending' &&
    isSha256Digest(value.challengeDigest) &&
    isSha256Digest(value.recordDigest) &&
    value.publicReadKind === 'grant-record.v1'
  );
}

function createCurrentJigwrightAdoptionComparison(
  input: Readonly<{
    releaseDigest: Sha256Digest;
    source: GitIdentityV1;
    consumer: GitIdentityV1;
    vectorFileDigest: Sha256Digest;
    vectorSetDigest: unknown;
    sourceFacts: CurrentJigwrightV3ComparisonFactsV1;
    installedFacts: CurrentJigwrightV3ComparisonFactsV1;
  }>,
): CurrentJigwrightAdoptionComparisonV1 {
  if (!isSha256Digest(input.vectorSetDigest)) {
    throw new Error('Current workflow vector-set digest is invalid.');
  }
  const bindings = Object.freeze({
    releaseDigest: input.releaseDigest,
    source: Object.freeze({ ...input.source }),
    consumer: Object.freeze({ ...input.consumer }),
    vectors: Object.freeze({
      path: CONFORMANCE_VECTOR_EVIDENCE_PATH,
      fileDigest: input.vectorFileDigest,
      vectorSetDigest: input.vectorSetDigest,
    }),
  });
  const digestSubject = {
    bindings,
    source: input.sourceFacts,
    installed: input.installedFacts,
  };
  const comparison: CurrentJigwrightAdoptionComparisonV1 = Object.freeze({
    schemaVersion: 1,
    kind: 'jigwright-current-v3-source-installed-comparison.v1',
    bindings,
    source: input.sourceFacts,
    installed: input.installedFacts,
    factsDigest: digestJson(digestSubject),
    exact: true,
  });
  return verifyCurrentJigwrightAdoptionComparisonV1(comparison);
}

export function verifyCurrentJigwrightAdoptionComparisonV1(
  value: unknown,
  expected: Readonly<{
    releaseDigest?: Sha256Digest;
    source?: GitIdentityV1;
    consumer?: GitIdentityV1;
  }> = {},
): CurrentJigwrightAdoptionComparisonV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindings',
      'source',
      'installed',
      'factsDigest',
      'exact',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright-current-v3-source-installed-comparison.v1' ||
    value.exact !== true ||
    !isSha256Digest(value.factsDigest) ||
    !isRecord(value.bindings) ||
    !hasExactKeys(value.bindings, [
      'releaseDigest',
      'source',
      'consumer',
      'vectors',
    ]) ||
    !isSha256Digest(value.bindings.releaseDigest) ||
    !isGitIdentity(value.bindings.source) ||
    !isGitIdentity(value.bindings.consumer) ||
    !isRecord(value.bindings.vectors) ||
    !hasExactKeys(value.bindings.vectors, [
      'path',
      'fileDigest',
      'vectorSetDigest',
    ]) ||
    value.bindings.vectors.path !== CONFORMANCE_VECTOR_EVIDENCE_PATH ||
    !isSha256Digest(value.bindings.vectors.fileDigest) ||
    !isSha256Digest(value.bindings.vectors.vectorSetDigest) ||
    !isCurrentV3ComparisonFacts(value.source) ||
    !isCurrentV3ComparisonFacts(value.installed) ||
    !sameJson(value.source, value.installed)
  ) {
    throw new Error('Current Jigwright adoption comparison is invalid.');
  }
  const comparison = value as unknown as CurrentJigwrightAdoptionComparisonV1;
  if (
    comparison.factsDigest !==
      digestJson({
        bindings: comparison.bindings,
        source: comparison.source,
        installed: comparison.installed,
      }) ||
    (expected.releaseDigest !== undefined &&
      comparison.bindings.releaseDigest !== expected.releaseDigest) ||
    (expected.source !== undefined &&
      !sameJson(comparison.bindings.source, expected.source)) ||
    (expected.consumer !== undefined &&
      !sameJson(comparison.bindings.consumer, expected.consumer))
  ) {
    throw new Error('Current Jigwright adoption comparison is invalid.');
  }
  return comparison;
}

function isCurrentV3ComparisonFacts(
  value: unknown,
): value is CurrentJigwrightV3ComparisonFactsV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'init',
      'commands',
      'manifestV3',
      'centralGrant',
      'state',
      'routedEffects',
    ]) ||
    !isRecord(value.init) ||
    !hasExactKeys(value.init, ['fresh', 'repeated', 'profileDigest']) ||
    !isCommandObservation(value.init.fresh) ||
    !isCommandObservation(value.init.repeated) ||
    !isSha256Digest(value.init.profileDigest) ||
    !isFreshInitPayload(value.init.fresh) ||
    !isRepeatedInitPayload(value.init.repeated) ||
    !isRecord(value.commands) ||
    !hasExactKeys(value.commands, ['guide', 'doctor', 'status', 'jobList']) ||
    !isCommandObservation(value.commands.guide) ||
    !isCommandObservation(value.commands.doctor) ||
    !isCommandObservation(value.commands.status) ||
    !isCommandObservation(value.commands.jobList) ||
    !isSuccessfulCommand(value.commands.guide, 'guide') ||
    !isSuccessfulCommand(value.commands.doctor, 'doctor') ||
    !isSuccessfulCommand(value.commands.status, 'status') ||
    !isSuccessfulCommand(value.commands.jobList, 'job', 'list') ||
    !isRecord(value.manifestV3) ||
    !isManifestV3ComparisonFacts(value.manifestV3) ||
    !isRecord(value.centralGrant) ||
    !isCentralGrantComparisonFacts(value.centralGrant) ||
    !isRecord(value.state) ||
    !hasExactKeys(value.state, ['before', 'after', 'unchanged']) ||
    !isStateFingerprint(value.state.before) ||
    !isStateFingerprint(value.state.after) ||
    value.state.unchanged !== true ||
    !sameJson(value.state.before, value.state.after) ||
    !isRecord(value.routedEffects) ||
    !sameJson(value.routedEffects, {
      scope: 'selected-current-v3-read-only-probes',
      requestedGrantTransitions: 0,
      humanGateCommands: 0,
      externalEffectCommands: 0,
      observedStateMutation: 0,
    })
  ) {
    return false;
  }
  const guide = value.commands.guide as CurrentJigwrightCommandObservationV1;
  const status = value.commands.status as CurrentJigwrightCommandObservationV1;
  const jobList = value.commands
    .jobList as CurrentJigwrightCommandObservationV1;
  const freshInit = value.init.fresh as CurrentJigwrightCommandObservationV1;
  const freshResult = freshInit.payload.result;
  return (
    isRecord(freshResult) &&
    freshResult.digest === value.init.profileDigest &&
    isRecord(guide.payload.guide) &&
    guide.payload.guide.kind === 'workflow-command-guide.v1' &&
    Array.isArray(status.payload.sessions) &&
    status.payload.sessions.length === 0 &&
    Array.isArray(jobList.payload.jobs) &&
    jobList.payload.jobs.length === 0
  );
}

function isCommandObservation(
  value: unknown,
): value is CurrentJigwrightCommandObservationV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['exitCode', 'stream', 'payload', 'payloadDigest']) &&
    Number.isSafeInteger(value.exitCode) &&
    Number(value.exitCode) >= 0 &&
    (value.stream === 'stdout' || value.stream === 'stderr') &&
    isRecord(value.payload) &&
    isSha256Digest(value.payloadDigest) &&
    value.payloadDigest === digestJson(value.payload)
  );
}

function isFreshInitPayload(
  observation: CurrentJigwrightCommandObservationV1,
): boolean {
  const result = isRecord(observation.payload.result)
    ? observation.payload.result
    : null;
  return (
    observation.exitCode === 0 &&
    observation.stream === 'stdout' &&
    observation.payload.ok === true &&
    result?.kind === 'jigwright-init-result.v1' &&
    result.status === 'initialized' &&
    result.path === 'workflow/jigwright-profile.json' &&
    isSha256Digest(result.digest)
  );
}

function isRepeatedInitPayload(
  observation: CurrentJigwrightCommandObservationV1,
): boolean {
  const error = isRecord(observation.payload.error)
    ? observation.payload.error
    : null;
  return (
    observation.exitCode === 12 &&
    observation.stream === 'stderr' &&
    observation.payload.ok === false &&
    error?.code === 'JIGWRIGHT_INIT_ALREADY_CONFIGURED'
  );
}

function isSuccessfulCommand(
  observation: CurrentJigwrightCommandObservationV1,
  command: string,
  action?: string,
): boolean {
  return (
    observation.exitCode === 0 &&
    observation.stream === 'stdout' &&
    observation.payload.ok === true &&
    observation.payload.command === command &&
    (action === undefined || observation.payload.action === action)
  );
}

function isStateFingerprint(
  value: unknown,
): value is CurrentJigwrightRepositoryStateFingerprintV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['refs', 'tracked', 'privateRuntime']) &&
    isSha256Digest(value.refs) &&
    isSha256Digest(value.tracked) &&
    isSha256Digest(value.privateRuntime)
  );
}

function isGitIdentity(value: unknown): value is GitIdentityV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['commit', 'tree']) &&
    isGitObjectId(value.commit) &&
    isGitObjectId(value.tree)
  );
}

export function verifyCurrentJigwrightAdoptionReportV1(
  value: unknown,
  release: SingleJigwrightPackageArtifactV1,
): CurrentJigwrightAdoptionReportV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'release',
      'install',
      'bootstrap',
      'publicSurfaces',
      'consumer',
      'comparison',
      'currentOnly',
      'operationalGates',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright-current-local-adoption-report.v1' ||
    !sameJson(value.release, release) ||
    !isRecord(value.install) ||
    !isRecord(value.bootstrap) ||
    !isRecord(value.publicSurfaces) ||
    !isRecord(value.consumer) ||
    !isRecord(value.currentOnly) ||
    !isRecord(value.operationalGates)
  ) {
    throw new Error('Current Jigwright adoption report is invalid.');
  }
  const installedPackage = isRecord(value.install.package)
    ? value.install.package
    : null;
  const lockfile = isRecord(value.install.lockfile)
    ? value.install.lockfile
    : null;
  const init = isRecord(value.bootstrap.init) ? value.bootstrap.init : null;
  const repeatedInit = isRecord(value.bootstrap.repeatedInit)
    ? value.bootstrap.repeatedInit
    : null;
  if (
    !hasExactKeys(value.install, [
      'networkPolicy',
      'packageManager',
      'lifecycleScriptsDenied',
      'lockfileVerified',
      'publicPackageIdentities',
      'package',
      'lockfile',
    ]) ||
    value.install.networkPolicy !== 'offline-exact-local-tarball' ||
    value.install.packageManager !== 'npm' ||
    value.install.lifecycleScriptsDenied !== true ||
    value.install.lockfileVerified !== true ||
    !sameJson(value.install.publicPackageIdentities, ['jigwright']) ||
    installedPackage === null ||
    !hasExactKeys(installedPackage, ['name', 'version', 'digest']) ||
    installedPackage.name !== 'jigwright' ||
    installedPackage.version !== release.version ||
    installedPackage.digest !== release.digest ||
    lockfile === null ||
    !hasExactKeys(lockfile, [
      'path',
      'digest',
      'resolved',
      'integrity',
      'integrityVerified',
    ]) ||
    lockfile.path !== 'package-lock.json' ||
    !isSha256Digest(lockfile.digest) ||
    typeof lockfile.resolved !== 'string' ||
    typeof lockfile.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockfile.integrity) ||
    lockfile.integrityVerified !== true ||
    !hasExactKeys(value.bootstrap, [
      'init',
      'repeatedInit',
      'policyUnchanged',
      'guide',
    ]) ||
    init === null ||
    !hasExactKeys(init, ['kind', 'status', 'path', 'digest']) ||
    init.kind !== 'jigwright-init-result.v1' ||
    init.status !== 'initialized' ||
    init.path !== 'workflow/jigwright-profile.json' ||
    !isSha256Digest(init.digest) ||
    repeatedInit === null ||
    !sameJson(repeatedInit, {
      exitCode: 12,
      errorClass: 'JIGWRIGHT_INIT_ALREADY_CONFIGURED',
    }) ||
    value.bootstrap.policyUnchanged !== true ||
    value.bootstrap.guide !== 'workflow-command-guide.v1' ||
    !sameJson(value.publicSurfaces, {
      manifestV3: true,
      planReview: true,
      centralGrant: true,
    }) ||
    !isCurrentConsumerEvidence(value.consumer) ||
    !sameJson(value.currentOnly, {
      historicalRuntimeState: 'unsupported',
      dualRun: 'retired',
      rollback: 'revert-consumer-cutover-commit',
    }) ||
    !sameJson(value.operationalGates, {
      implementation: 'implementation-ready',
      realPilot: 'real-pilot-pending',
      fullGate: 'full-gate-pending',
    })
  ) {
    throw new Error('Current Jigwright adoption report is invalid.');
  }
  const consumer =
    value.consumer as unknown as CurrentJigwrightAdoptionReportV1['consumer'];
  verifyCurrentJigwrightAdoptionComparisonV1(value.comparison, {
    releaseDigest: release.digest,
    source: { commit: release.source.commit, tree: release.source.tree },
    consumer: { commit: consumer.commit, tree: consumer.tree },
  });
  return value as unknown as CurrentJigwrightAdoptionReportV1;
}

function isCurrentConsumerEvidence(value: JsonRecord): boolean {
  if (
    !hasExactKeys(value, ['commit', 'tree', 'clean', 'history', 'rollback']) ||
    !isGitObjectId(value.commit) ||
    !isGitObjectId(value.tree) ||
    value.clean !== true ||
    !isRecord(value.history) ||
    !hasExactKeys(value.history, ['baseline', 'dependency', 'cutover']) ||
    !isGitIdentity(value.history.baseline) ||
    !isGitIdentity(value.history.dependency) ||
    !isGitIdentity(value.history.cutover) ||
    value.commit !== value.history.cutover.commit ||
    value.tree !== value.history.cutover.tree ||
    !isRecord(value.rollback) ||
    !hasExactKeys(value.rollback, [
      'kind',
      'revertedCommits',
      'commit',
      'tree',
      'baselineTreeMatched',
      'clean',
    ]) ||
    value.rollback.kind !== 'jigwright-consumer-rollback-rehearsal.v1' ||
    !Array.isArray(value.rollback.revertedCommits) ||
    value.rollback.revertedCommits.length !== 2 ||
    value.rollback.revertedCommits[0] !== value.history.cutover.commit ||
    value.rollback.revertedCommits[1] !== value.history.dependency.commit ||
    !isGitObjectId(value.rollback.commit) ||
    !isGitObjectId(value.rollback.tree) ||
    value.rollback.tree !== value.history.baseline.tree ||
    value.rollback.baselineTreeMatched !== true ||
    value.rollback.clean !== true
  ) {
    return false;
  }
  return true;
}

export function verifyCurrentJigwrightAdoptionArtifacts(
  requestedAdoptionRoot: string,
  report: CurrentJigwrightAdoptionReportV1,
): CurrentJigwrightAdoptionReportV1 {
  const adoptionRoot = fs.realpathSync(requestedAdoptionRoot);
  verifyCurrentJigwrightAdoptionReportV1(report, report.release);
  const consumerRoot = fs.realpathSync(path.join(adoptionRoot, 'consumer'));
  const sourceProbeRoot = fs.realpathSync(
    path.join(adoptionRoot, 'source-probe'),
  );
  const rollbackRoot = fs.realpathSync(
    path.join(adoptionRoot, 'rollback-consumer'),
  );
  if (
    !sameJson(gitIdentity(consumerRoot), {
      commit: report.consumer.commit,
      tree: report.consumer.tree,
    }) ||
    git(consumerRoot, ['status', '--porcelain']).length !== 0 ||
    !sameJson(gitIdentity(sourceProbeRoot), report.consumer.history.cutover) ||
    git(sourceProbeRoot, ['status', '--porcelain']).length !== 0 ||
    !sameJson(gitIdentity(rollbackRoot), {
      commit: report.consumer.rollback.commit,
      tree: report.consumer.rollback.tree,
    }) ||
    git(rollbackRoot, ['status', '--porcelain']).length !== 0 ||
    report.consumer.rollback.tree !== report.consumer.history.baseline.tree
  ) {
    throw new Error('Current Jigwright consumer history is invalid.');
  }
  assertCommitTree(consumerRoot, report.consumer.history.baseline, 'baseline');
  assertCommitTree(
    consumerRoot,
    report.consumer.history.dependency,
    'dependency',
  );
  assertCommitTree(consumerRoot, report.consumer.history.cutover, 'cutover');
  assertAncestor(
    consumerRoot,
    report.consumer.history.baseline.commit,
    report.consumer.history.dependency.commit,
  );
  assertAncestor(
    consumerRoot,
    report.consumer.history.dependency.commit,
    report.consumer.history.cutover.commit,
  );
  const consumerProfileDigest = digestBytes(
    fs.readFileSync(path.join(consumerRoot, report.bootstrap.init.path)),
  );
  const sourceProfileDigest = digestBytes(
    fs.readFileSync(path.join(sourceProbeRoot, report.bootstrap.init.path)),
  );
  if (
    consumerProfileDigest !== report.bootstrap.init.digest ||
    sourceProfileDigest !== report.bootstrap.init.digest ||
    report.comparison.source.init.profileDigest !==
      report.bootstrap.init.digest ||
    report.comparison.installed.init.profileDigest !==
      report.bootstrap.init.digest
  ) {
    throw new Error('Current Jigwright init profile evidence is invalid.');
  }

  const lockfilePath = path.join(consumerRoot, report.install.lockfile.path);
  const adoptionTarballPath = path.join(
    adoptionRoot,
    'release',
    report.release.tarball,
  );
  const expectedResolved = `file:${path
    .relative(consumerRoot, adoptionTarballPath)
    .split(path.sep)
    .join('/')}`;
  if (
    report.install.lockfile.resolved !== expectedResolved ||
    digestBytes(fs.readFileSync(adoptionTarballPath)) !== report.release.digest
  ) {
    throw new Error('Current Jigwright lockfile evidence is invalid.');
  }
  const observedLockfile = inspectInstalledLockfile(
    lockfilePath,
    expectedResolved,
    adoptionTarballPath,
  );
  if (!sameJson(observedLockfile, report.install.lockfile)) {
    throw new Error('Current Jigwright lockfile evidence is invalid.');
  }

  const vectorPath = path.join(
    adoptionRoot,
    report.comparison.bindings.vectors.path,
  );
  const vectorDocument = loadWorkflowConformanceVectorsV2({ vectorPath });
  const centralVector = vectorDocument.domains['central-grant'][0];
  if (
    digestBytes(fs.readFileSync(vectorPath)) !==
      report.comparison.bindings.vectors.fileDigest ||
    vectorDocument.vectorSetDigest !==
      report.comparison.bindings.vectors.vectorSetDigest ||
    !isRecord(centralVector) ||
    centralVector.grantRecordDigest !==
      report.comparison.source.centralGrant.recordDigest ||
    centralVector.challengeDigest !==
      report.comparison.source.centralGrant.challengeDigest
  ) {
    throw new Error('Current Jigwright vector evidence is invalid.');
  }
  const currentState = repositoryStateFingerprint(consumerRoot);
  if (
    !sameJson(currentState, report.comparison.source.state.after) ||
    !sameJson(currentState, report.comparison.installed.state.after)
  ) {
    throw new Error('Current Jigwright state fingerprint is invalid.');
  }
  return report;
}

function assertCommitTree(
  repositoryRoot: string,
  identity: GitIdentityV1,
  label: string,
): void {
  if (
    git(repositoryRoot, ['rev-parse', `${identity.commit}^{tree}`]) !==
    identity.tree
  ) {
    throw new Error(`Current Jigwright ${label} tree is invalid.`);
  }
}

function assertAncestor(
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): void {
  const result = runCommand(
    'git',
    ['merge-base', '--is-ancestor', ancestor, descendant],
    repositoryRoot,
  );
  if (result.status !== 0) {
    throw new Error('Current Jigwright consumer history is not linear.');
  }
}

function rehearseConsumerRollback(
  adoptionRoot: string,
  consumerRoot: string,
  baseline: GitIdentityV1,
  dependency: GitIdentityV1,
  cutover: GitIdentityV1,
): CurrentJigwrightAdoptionReportV1['consumer']['rollback'] {
  const rollbackRoot = path.join(adoptionRoot, 'rollback-consumer');
  runRequired(
    'git',
    ['clone', '--quiet', '--no-hardlinks', consumerRoot, rollbackRoot],
    adoptionRoot,
  );
  configureConsumerRepository(rollbackRoot);
  git(rollbackRoot, ['revert', '--no-edit', cutover.commit], {
    GIT_AUTHOR_DATE: COMMIT_DATES.rollbackCutover,
    GIT_COMMITTER_DATE: COMMIT_DATES.rollbackCutover,
  });
  git(rollbackRoot, ['revert', '--no-edit', dependency.commit], {
    GIT_AUTHOR_DATE: COMMIT_DATES.rollbackDependency,
    GIT_COMMITTER_DATE: COMMIT_DATES.rollbackDependency,
  });
  const rolledBack = gitIdentity(rollbackRoot);
  if (
    rolledBack.tree !== baseline.tree ||
    git(rollbackRoot, ['status', '--porcelain']).length !== 0
  ) {
    throw new Error('Current Jigwright consumer rollback rehearsal failed.');
  }
  return Object.freeze({
    kind: 'jigwright-consumer-rollback-rehearsal.v1' as const,
    revertedCommits: Object.freeze([
      cutover.commit,
      dependency.commit,
    ]) as readonly [string, string],
    ...rolledBack,
    baselineTreeMatched: true as const,
    clean: true as const,
  });
}

function assertEmptyDirectory(root: string): void {
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (
    stats !== undefined &&
    (!stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.readdirSync(root).length > 0)
  ) {
    throw new Error('Current Jigwright adoption output must be empty.');
  }
  fs.mkdirSync(root, { recursive: true });
}

function runCommand(executable: string, args: string[], cwd: string) {
  return spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runRequired(
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function parseJsonOutput(value: string): JsonRecord {
  const parsed: unknown = JSON.parse(value.trim());
  if (!isRecord(parsed))
    throw new Error('Jigwright command output is invalid.');
  return parsed;
}

function readJson(filePath: string): JsonRecord {
  return parseJsonOutput(fs.readFileSync(filePath, 'utf8'));
}

function git(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
): string {
  return runRequired('git', args, repository, environment);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isGitObjectId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
  );
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  return sameJson(Object.keys(value).sort(), [...expected].sort());
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function digestJson(value: unknown): Sha256Digest {
  return digestBytes(canonicalJson(value));
}

function digestBytes(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        'Current Jigwright evidence contains a non-finite number.',
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('Current Jigwright evidence is not JSON.');
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || process.argv[outputIndex + 1] === undefined) {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/run-current-jigwright-adoption.ts --output <directory>',
    );
  }
  const report = runCurrentJigwrightAdoption(
    process.cwd(),
    process.argv[outputIndex + 1]!,
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
