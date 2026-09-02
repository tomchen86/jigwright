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
const CURRENT_HOOKS = Object.freeze([
  'pre-commit',
  'commit-msg',
  'pre-push',
  'post-merge',
] as const);
const CURRENT_ADOPTION_IGNORED_OUTPUT_ROOTS = Object.freeze([
  'node_modules',
] as const);
const CURRENT_OPENSPEC_INTEGRATION_ASSET_PATHS = Object.freeze([
  '.agents/skills/openspec-explore/SKILL.md',
  '.agents/skills/openspec-propose/SKILL.md',
  '.agents/skills/workflow-engine/SKILL.md',
  '.claude/skills/openspec-explore/SKILL.md',
  '.claude/skills/openspec-propose/SKILL.md',
  '.claude/skills/workflow-engine/SKILL.md',
  '.codex/skills/openspec-explore/SKILL.md',
  '.codex/skills/openspec-propose/SKILL.md',
  '.codex/skills/workflow-engine/SKILL.md',
  'workflow/openspec-assets/manifest.json',
  'workflow/openspec-assets/prompts/opsx-explore.md',
  'workflow/openspec-assets/prompts/opsx-propose.md',
  'workflow/openspec-assets/sources/workflow-engine/SKILL.md',
] as const);
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
  localGitConfig: Sha256Digest;
  ignoredWorkingState: Sha256Digest;
  privateRuntime: Sha256Digest;
}>;

type CurrentJigwrightHookName = (typeof CURRENT_HOOKS)[number];

type CurrentJigwrightLocalCutoverV1 = Readonly<{
  kind: 'jigwright-synthetic-local-cutover.v1';
  environment: 'synthetic-local';
  realPilot: false;
  notEvaluated: readonly [
    'managed-lifecycle',
    'grant-transitions',
    'human-gates',
    'expense-app-consumer',
    'publication',
    'full-gate',
  ];
  rootWorkflow: Readonly<{
    script: 'jigwright';
    invocation: 'npm run --silent workflow --';
    packageName: 'jigwright';
    packageExecutable: 'node_modules/jigwright/bin/jigwright.mjs';
    packageExecutableDigest: Sha256Digest;
    bin: 'node_modules/.bin/jigwright';
    binTarget: '../jigwright/bin/jigwright.mjs';
    binDigest: Sha256Digest;
    lockfileDigest: Sha256Digest;
    lockfileIntegrity: `sha512-${string}`;
    guide: CurrentJigwrightCommandObservationV1;
  }>;
  hooks: Readonly<{
    proxies: readonly Readonly<{
      hook: CurrentJigwrightHookName;
      path: `.husky/${CurrentJigwrightHookName}`;
      content: string;
      digest: Sha256Digest;
      executable: true;
    }>[];
    observations: Readonly<{
      preCommit: CurrentJigwrightCommandObservationV1;
      malformedCommitMessage: CurrentJigwrightCommandObservationV1;
      prePushWithoutTransaction: CurrentJigwrightCommandObservationV1;
      postMerge: CurrentJigwrightCommandObservationV1;
    }>;
    state: Readonly<{
      before: CurrentJigwrightRepositoryStateFingerprintV1;
      after: CurrentJigwrightRepositoryStateFingerprintV1;
      unchanged: true;
    }>;
  }>;
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
  planReview: Readonly<{
    subjectSchemaVersion: 1;
    subjectDigest: string;
    manifestDigest: string;
    investigationTargetDigest: string;
    readerOutcome: 'verified';
    negativeOutcome: 'blocked';
    negativeCode: 'PLAN_REVIEW_INVALID';
  }>;
  centralGrant: Readonly<{
    policySchemaVersion: 2;
    policyDigest: Sha256Digest;
    recordKind: 'grant-record.v1';
    recordState: 'pending';
    challengeDigest: Sha256Digest;
    stateDigest: Sha256Digest;
    approvalMethods: readonly ['human-presence', 'ssh'];
    approvalSubjectDigest: Sha256Digest;
    recordDigest: Sha256Digest;
    publicReadKind: 'grant-record.v1';
    negativeOutcome: 'blocked';
    negativeCode: 'GRANT_APPROVAL_SUBJECT_INVALID';
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
    localCutover: CurrentJigwrightLocalCutoverV1;
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

export type CurrentJigwrightAdoptionFreshnessV1 = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-current-local-adoption-freshness.v1';
  status: 'current' | 'stale';
  adoption: CurrentJigwrightAdoptionReportV1['release']['source'];
  current: CurrentJigwrightAdoptionReportV1['release']['source'];
  reasons: readonly (
    | 'adoption-source-dirty'
    | 'current-source-dirty'
    | 'source-commit-mismatch'
    | 'source-tree-mismatch'
  )[];
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
  writeText(
    path.join(consumerRoot, '.gitignore'),
    '.consumer-local/\nnode_modules/\n',
  );
  writeText(
    path.join(consumerRoot, '.consumer-local', 'state.txt'),
    'consumer-owned local state\n',
  );
  writeJson(path.join(consumerRoot, 'workflow', 'config.json'), {
    schemaVersion: 1,
    repositoryName: 'jigwright-current-adoption-consumer',
    consumerNamespace: 'jigwright-current-adoption-consumer',
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
    taskAuthorization: {
      pathRoleRegistry: 'workflow/path-roles.json',
      mandateRequiredRoles: ['control-plane'],
    },
    allowedPathModes: ['exact', 'directory-prefix'],
  });
  writeJson(path.join(consumerRoot, 'workflow', 'path-roles.json'), {
    schemaVersion: 1,
    kind: 'path-role-registry',
    roles: {
      'control-plane': ['workflow/**'],
      ordinary: ['docs/**', 'openspec/**', 'package.json'],
    },
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
    'workflow/path-roles.json',
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
  materializeCurrentLocalCutover(repositoryRoot, sourceProbeRoot);
  stageCurrentLocalCutover(sourceProbeRoot, sourceInit.path);
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
  materializeCurrentLocalCutover(repositoryRoot, consumerRoot);
  stageCurrentLocalCutover(consumerRoot, init.path);
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
    planReviewSpecifier: pathToFileURL(
      path.join(
        repositoryRoot,
        'packages/workflow-engine/src/composition-root/public/plan-review.ts',
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
    planReviewSpecifier: 'jigwright/plan-review',
    centralGrantSpecifier: 'jigwright/central-grant',
    vectorEvidencePath,
    freshInit: installedFreshInit,
    repeatedInit: installedRepeatedInit,
    profileDigest: digestBytes(profileBytes),
  });
  if (!sameJson(sourceFacts, installedFacts)) {
    throw new Error('Source and installed current-v3 facts differ.');
  }

  const localCutover = collectCurrentLocalCutoverEvidence({
    consumerRoot,
    installedRoot,
    installedManifest,
    lockfile,
    installedGuide: installedFacts.commands.guide,
  });

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
      localCutover,
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
  writeJson(path.join(adoptionRoot, 'report.json'), report);
  verifyCurrentJigwrightAdoptionArtifacts(adoptionRoot, report);
  return report;
}

/**
 * Re-verifies a persisted synthetic adoption rehearsal before reporting whether
 * its recorded source still exactly matches the current repository. This never
 * prepares, refreshes, or persistently changes the adoption artifact.
 */
export function inspectCurrentJigwrightAdoptionFreshness(
  requestedRepositoryRoot: string,
  requestedAdoptionRoot: string,
): CurrentJigwrightAdoptionFreshnessV1 {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const adoptionRoot = fs.realpathSync(requestedAdoptionRoot);
  const reportValue = readJson(path.join(adoptionRoot, 'report.json'));
  const release = isSingleJigwrightPackageArtifactV1(reportValue.release)
    ? reportValue.release
    : null;
  if (release === null) {
    throw new Error('Current Jigwright adoption report is invalid.');
  }
  const report = verifyCurrentJigwrightAdoptionReportV1(reportValue, release);
  verifyCurrentJigwrightAdoptionArtifacts(adoptionRoot, report);
  return assessCurrentJigwrightAdoptionFreshness(
    report.release.source,
    currentSourceIdentity(repositoryRoot),
  );
}

export function assessCurrentJigwrightAdoptionFreshness(
  adoption: CurrentJigwrightAdoptionReportV1['release']['source'],
  current: CurrentJigwrightAdoptionReportV1['release']['source'],
): CurrentJigwrightAdoptionFreshnessV1 {
  const reasons: CurrentJigwrightAdoptionFreshnessV1['reasons'][number][] = [];
  if (adoption.dirty) reasons.push('adoption-source-dirty');
  if (current.dirty) reasons.push('current-source-dirty');
  if (adoption.commit !== current.commit)
    reasons.push('source-commit-mismatch');
  if (adoption.tree !== current.tree) reasons.push('source-tree-mismatch');
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'jigwright-current-local-adoption-freshness.v1' as const,
    status: reasons.length === 0 ? ('current' as const) : ('stale' as const),
    adoption: Object.freeze({ ...adoption }),
    current: Object.freeze({ ...current }),
    reasons: Object.freeze(reasons),
  });
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

function currentSourceIdentity(
  repositoryRoot: string,
): CurrentJigwrightAdoptionReportV1['release']['source'] {
  return Object.freeze({
    ...gitIdentity(repositoryRoot),
    dirty:
      git(repositoryRoot, ['status', '--porcelain', '--untracked-files=all'])
        .length > 0,
  });
}

function materializeCurrentLocalCutover(
  repositoryRoot: string,
  consumerRoot: string,
): void {
  const manifestPath = path.join(consumerRoot, 'package.json');
  const manifest = readJson(manifestPath);
  if (
    !isRecord(manifest.dependencies) ||
    typeof manifest.dependencies.jigwright !== 'string'
  ) {
    throw new Error('Current local cutover requires the installed dependency.');
  }
  writeJson(manifestPath, {
    ...manifest,
    scripts: { workflow: 'jigwright' },
  });
  writeJson(path.join(consumerRoot, 'workflow', 'document-policy.json'), {
    schemaVersion: 1,
    enforcementMode: 'active',
    documents: {},
  });
  writeJson(path.join(consumerRoot, 'workflow', 'repository-consumer.json'), {
    schemaVersion: 1,
    adapterId: 'configured-repository-v1',
    consumerId: 'jigwright-current-adoption-consumer',
    planning: {
      providerId: 'openspec',
      packageSchemaNames: ['spec-driven'],
      requiredSchemaNames: ['spec-driven', 'jigwright'],
      supportedSchemaNames: ['spec-driven', 'jigwright'],
      managedSchemaNames: ['jigwright'],
      currentSchemaName: 'jigwright',
    },
    documents: {
      adapterId: 'filesystem-documents-v1',
      handoffPath: 'docs/CURRENT_AND_NEXT_STEPS.md',
    },
    databasePolicy: { adapterId: 'disabled-v1' },
  });
  writeText(path.join(consumerRoot, 'openspec', 'changes', '.gitkeep'), '');

  for (const relativePath of CURRENT_OPENSPEC_INTEGRATION_ASSET_PATHS) {
    const source = path.join(repositoryRoot, relativePath);
    const stats = fs.lstatSync(source, { throwIfNoEntry: false });
    if (
      stats === undefined ||
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1
    ) {
      throw new Error(`Current integration asset is unsafe: ${relativePath}.`);
    }
    writeText(
      path.join(consumerRoot, relativePath),
      fs.readFileSync(source, 'utf8'),
    );
  }
  for (const hook of CURRENT_HOOKS) {
    const hookPath = path.join(consumerRoot, '.husky', hook);
    writeText(hookPath, currentHookProxyContent(hook));
    fs.chmodSync(hookPath, 0o755);
  }
}

function stageCurrentLocalCutover(
  consumerRoot: string,
  profilePath: string,
): void {
  git(consumerRoot, [
    'add',
    '--',
    profilePath,
    'package.json',
    'workflow/document-policy.json',
    'workflow/repository-consumer.json',
    'workflow/openspec-assets',
    'openspec/changes/.gitkeep',
    '.agents/skills',
    '.claude/skills',
    '.codex/skills',
    '.husky',
  ]);
}

function currentHookProxyContent(hook: CurrentJigwrightHookName): string {
  return `#!/usr/bin/env sh\nexec npm run --silent workflow -- hook ${hook} "$@"\n`;
}

function collectCurrentLocalCutoverEvidence(
  input: Readonly<{
    consumerRoot: string;
    installedRoot: string;
    installedManifest: JsonRecord;
    lockfile: CurrentJigwrightAdoptionReportV1['install']['lockfile'];
    installedGuide: CurrentJigwrightCommandObservationV1;
  }>,
): CurrentJigwrightLocalCutoverV1 {
  const packageExecutable = path.join(
    input.installedRoot,
    'bin',
    'jigwright.mjs',
  );
  const bin = path.join(
    input.consumerRoot,
    'node_modules',
    '.bin',
    'jigwright',
  );
  const executableStats = fs.lstatSync(packageExecutable, {
    throwIfNoEntry: false,
  });
  const binStats = fs.lstatSync(bin, { throwIfNoEntry: false });
  const binTarget = binStats?.isSymbolicLink() ? fs.readlinkSync(bin) : null;
  if (
    !sameJson(input.installedManifest.bin, {
      jigwright: './bin/jigwright.mjs',
    }) ||
    !executableStats?.isFile() ||
    executableStats.isSymbolicLink() ||
    executableStats.nlink !== 1 ||
    (executableStats.mode & 0o111) === 0 ||
    !binStats?.isSymbolicLink() ||
    binTarget !== '../jigwright/bin/jigwright.mjs' ||
    fs.realpathSync(bin) !== fs.realpathSync(packageExecutable)
  ) {
    throw new Error(
      'Current root workflow does not resolve the installed bin.',
    );
  }
  const packageExecutableDigest = digestBytes(
    fs.readFileSync(packageExecutable),
  );
  const binDigest = digestBytes(fs.readFileSync(bin));
  if (packageExecutableDigest !== binDigest) {
    throw new Error('Current root workflow bin bytes are not exact.');
  }

  const guide = observeRootWorkflowCommand(input.consumerRoot, ['guide']);
  requireReadOnlyCommand(guide, 'guide');
  if (!sameJson(guide, input.installedGuide)) {
    throw new Error(
      'Root workflow did not route to the installed Jigwright CLI.',
    );
  }

  const proxies = Object.freeze(
    CURRENT_HOOKS.map((hook) => {
      const relativePath = `.husky/${hook}` as const;
      const hookPath = path.join(input.consumerRoot, relativePath);
      const stats = fs.lstatSync(hookPath, { throwIfNoEntry: false });
      const content = currentHookProxyContent(hook);
      if (
        !stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o111) === 0 ||
        fs.readFileSync(hookPath, 'utf8') !== content
      ) {
        throw new Error(`Current ${hook} hook proxy is invalid.`);
      }
      return Object.freeze({
        hook,
        path: relativePath,
        content,
        digest: digestBytes(content),
        executable: true as const,
      });
    }),
  );

  const before = inspectCurrentJigwrightRepositoryStateFingerprintV1(
    input.consumerRoot,
  );
  const preCommit = observeHookProxy(input.consumerRoot, 'pre-commit', []);
  requireSuccessfulHook(preCommit, 'pre-commit');
  const malformedCommitMessage = observeMalformedCommitMessageHook(
    input.consumerRoot,
  );
  requireFailedHook(
    malformedCommitMessage,
    'COMMIT_MESSAGE_INVALID',
    'commit-msg',
  );
  const prePushWithoutTransaction = observeHookProxy(
    input.consumerRoot,
    'pre-push',
    ['origin', 'ssh://example.test/jigwright-current-adoption-consumer.git'],
  );
  requireFailedHook(
    prePushWithoutTransaction,
    'PUBLISH_TRANSACTION_REQUIRED',
    'pre-push',
  );
  const postMerge = observeHookProxy(input.consumerRoot, 'post-merge', ['0']);
  requireSuccessfulHook(postMerge, 'post-merge');
  const after = inspectCurrentJigwrightRepositoryStateFingerprintV1(
    input.consumerRoot,
  );
  if (!sameJson(before, after)) {
    throw new Error('Current hook probes changed repository state.');
  }

  return Object.freeze({
    kind: 'jigwright-synthetic-local-cutover.v1' as const,
    environment: 'synthetic-local' as const,
    realPilot: false as const,
    notEvaluated: Object.freeze([
      'managed-lifecycle',
      'grant-transitions',
      'human-gates',
      'expense-app-consumer',
      'publication',
      'full-gate',
    ] as const),
    rootWorkflow: Object.freeze({
      script: 'jigwright' as const,
      invocation: 'npm run --silent workflow --' as const,
      packageName: 'jigwright' as const,
      packageExecutable: 'node_modules/jigwright/bin/jigwright.mjs' as const,
      packageExecutableDigest,
      bin: 'node_modules/.bin/jigwright' as const,
      binTarget: '../jigwright/bin/jigwright.mjs' as const,
      binDigest,
      lockfileDigest: input.lockfile.digest,
      lockfileIntegrity: input.lockfile.integrity,
      guide,
    }),
    hooks: Object.freeze({
      proxies,
      observations: Object.freeze({
        preCommit,
        malformedCommitMessage,
        prePushWithoutTransaction,
        postMerge,
      }),
      state: Object.freeze({ before, after, unchanged: true as const }),
    }),
  });
}

function observeRootWorkflowCommand(
  repositoryRoot: string,
  args: string[],
): CurrentJigwrightCommandObservationV1 {
  return observeJsonCommand(
    'npm',
    ['run', '--silent', 'workflow', '--', ...args, '--json'],
    repositoryRoot,
    `root workflow ${args.join(' ')}`,
  );
}

function observeHookProxy(
  repositoryRoot: string,
  hook: CurrentJigwrightHookName,
  args: string[],
): CurrentJigwrightCommandObservationV1 {
  return observeJsonCommand(
    path.join(repositoryRoot, '.husky', hook),
    args,
    repositoryRoot,
    `${hook} hook`,
  );
}

function observeMalformedCommitMessageHook(
  repositoryRoot: string,
): CurrentJigwrightCommandObservationV1 {
  const requestedPath = git(repositoryRoot, [
    'rev-parse',
    '--git-path',
    'COMMIT_EDITMSG',
  ]);
  const messagePath = path.resolve(repositoryRoot, requestedPath);
  const existingStats = fs.lstatSync(messagePath, { throwIfNoEntry: false });
  if (
    existingStats !== undefined &&
    (!existingStats.isFile() ||
      existingStats.isSymbolicLink() ||
      existingStats.nlink !== 1)
  ) {
    throw new Error('Current commit message probe target is unsafe.');
  }
  const existingBytes = existingStats
    ? fs.readFileSync(messagePath)
    : undefined;
  const existingMode = existingStats ? existingStats.mode & 0o777 : undefined;
  try {
    fs.writeFileSync(messagePath, 'wip.\n', 'utf8');
    return observeHookProxy(repositoryRoot, 'commit-msg', [requestedPath]);
  } finally {
    if (existingBytes === undefined) {
      fs.rmSync(messagePath, { force: true });
    } else {
      fs.writeFileSync(messagePath, existingBytes);
      fs.chmodSync(messagePath, existingMode!);
    }
  }
}

function observeJsonCommand(
  executable: string,
  args: string[],
  repositoryRoot: string,
  label: string,
): CurrentJigwrightCommandObservationV1 {
  const result = runCommand(executable, args, repositoryRoot);
  if (result.status === null) throw new Error(`${label} was interrupted.`);
  const stream = result.status === 0 ? 'stdout' : 'stderr';
  const output = stream === 'stdout' ? result.stdout : result.stderr;
  if (typeof output !== 'string' || output.trim().length === 0) {
    throw new Error(`${label} returned no JSON payload.`);
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

function requireSuccessfulHook(
  observation: CurrentJigwrightCommandObservationV1,
  hook: CurrentJigwrightHookName,
): void {
  const result = isRecord(observation.payload.result)
    ? observation.payload.result
    : null;
  if (
    observation.exitCode !== 0 ||
    observation.stream !== 'stdout' ||
    observation.payload.ok !== true ||
    observation.payload.command !== 'hook' ||
    result?.hook !== hook ||
    !Array.isArray(result.changes) ||
    !Array.isArray(result.documents)
  ) {
    throw new Error(`Current ${hook} hook did not complete read-only.`);
  }
}

function requireFailedHook(
  observation: CurrentJigwrightCommandObservationV1,
  code: string,
  hook: CurrentJigwrightHookName,
): void {
  const error = isRecord(observation.payload.error)
    ? observation.payload.error
    : null;
  if (
    observation.exitCode === 0 ||
    observation.stream !== 'stderr' ||
    observation.payload.ok !== false ||
    error?.code !== code
  ) {
    throw new Error(`Current ${hook} hook did not fail closed with ${code}.`);
  }
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

export function inspectCurrentJigwrightRepositoryStateFingerprintV1(
  repositoryRoot: string,
): CurrentJigwrightRepositoryStateFingerprintV1 {
  const commonDirectory = path.resolve(
    repositoryRoot,
    git(repositoryRoot, ['rev-parse', '--git-common-dir']),
  );
  return Object.freeze({
    refs: digestBytes(git(repositoryRoot, ['show-ref', '--head'])),
    tracked: digestBytes(git(repositoryRoot, ['ls-files', '-s', '-z'])),
    localGitConfig: digestBytes(
      gitRaw(repositoryRoot, [
        'config',
        '--local',
        '--no-includes',
        '--null',
        '--list',
      ]),
    ),
    ignoredWorkingState: fingerprintIgnoredWorkingState(repositoryRoot),
    privateRuntime: fingerprintFilesystemTree(
      path.join(commonDirectory, 'workflow-engine'),
    ),
  });
}

function fingerprintIgnoredWorkingState(repositoryRoot: string): Sha256Digest {
  const ignoredPaths = gitRaw(repositoryRoot, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--no-empty-directory',
    '-z',
  ])
    .toString('utf8')
    .split('\0')
    .filter((relativePath) => relativePath.length > 0)
    .filter((relativePath) => {
      const normalized = relativePath.replace(/\/+$/u, '');
      return !CURRENT_ADOPTION_IGNORED_OUTPUT_ROOTS.some(
        (outputRoot) =>
          normalized === outputRoot || normalized.startsWith(`${outputRoot}/`),
      );
    })
    .sort();
  return digestBytes(
    ignoredPaths
      .map(
        (relativePath) =>
          `${relativePath}\0${fingerprintFilesystemTree(
            path.join(repositoryRoot, relativePath),
          )}`,
      )
      .join('\n'),
  );
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
    planReviewSpecifier: string;
    centralGrantSpecifier: string;
    vectorEvidencePath: string;
    freshInit: CurrentJigwrightCommandObservationV1;
    repeatedInit: CurrentJigwrightCommandObservationV1;
    profileDigest: Sha256Digest;
  }>,
): CurrentJigwrightV3ComparisonFactsV1 {
  const before = inspectCurrentJigwrightRepositoryStateFingerprintV1(
    input.consumerRoot,
  );
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
  const planReview = isRecord(publicFacts.planReview)
    ? publicFacts.planReview
    : null;
  const centralGrant = isRecord(publicFacts.centralGrant)
    ? publicFacts.centralGrant
    : null;
  if (!isManifestV3ComparisonFacts(manifestV3)) {
    throw new Error('Current Manifest V3 comparison facts are invalid.');
  }
  if (!isPlanReviewComparisonFacts(planReview, manifestV3)) {
    throw new Error('Current PlanReview comparison facts are invalid.');
  }
  if (!isCentralGrantComparisonFacts(centralGrant)) {
    throw new Error('Current Central Grant comparison facts are invalid.');
  }

  const after = inspectCurrentJigwrightRepositoryStateFingerprintV1(
    input.consumerRoot,
  );
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
    planReview,
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
    planReviewSpecifier: string;
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
        JIGWRIGHT_ADOPTION_PLAN_REVIEW_SPECIFIER: input.planReviewSpecifier,
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
const planReview = await import(
  required('JIGWRIGHT_ADOPTION_PLAN_REVIEW_SPECIFIER')
);
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
    sourceRefs: [],
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

const planReviewFields = {
  planningGenerationId: sha256('current-v3-plan-review-generation'),
  planTargetDigest: sha256('current-v3-plan-review-target'),
  manifestDigest: verified.manifestDigest,
  investigationTargetDigest: verified.investigationTargetDigest,
  reviewPolicyDigest: sha256('current-v3-plan-review-policy'),
  requiredIndependence: 'provider-independent',
  investigationBaseline: { head, tree },
  investigationDependencies: [],
  investigationRequirements: [],
};
const planReviewSubject = {
  schemaVersion: 1,
  subjectDigest: planReview.planReviewSubjectDigest(planReviewFields),
  ...planReviewFields,
};
const replayedPlanReviewSubject =
  planReview.assertPlanReviewSubject(planReviewSubject);
let planReviewNegativeCode = null;
try {
  planReview.assertPlanReviewSubject({
    ...planReviewSubject,
    subjectDigest: '0'.repeat(64),
  });
} catch (error) {
  planReviewNegativeCode =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : null;
}
if (
  replayedPlanReviewSubject.manifestDigest !== verified.manifestDigest ||
  replayedPlanReviewSubject.investigationTargetDigest !==
    verified.investigationTargetDigest ||
  planReviewNegativeCode !== 'PLAN_REVIEW_INVALID'
) {
  throw new Error('Current PlanReview public replay facts are invalid.');
}

const { candidate: vectorCandidate, ...vectorRequest } = centralVector.request;
const grantStateBinding = centralVector.request.stateBinding;
const grantRegistry = grant.createTransitionRegistry([
  {
    transitionId: vectorCandidate.transitionId,
    parameterSchemaDigest: centralVector.registry.parameterSchemaDigest,
    consequenceDigest: centralVector.registry.consequenceDigest,
    resolutionKind: centralVector.registry.resolutionKind,
    allowedApprovalMethods: centralVector.registry.allowedApprovalMethods,
    validateParameters(value) {
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        value.resume !== true
      ) {
        throw new Error('Current adoption Grant vector parameters are invalid.');
      }
      return { resume: true };
    },
    renderTrustedChoice() {
      return {
        title: 'Continue current adoption parity',
        consequences: ['The canonical read-only transition remains bound.'],
      };
    },
    observeState() {
      return grantStateBinding;
    },
    async execute() {
      throw new Error('Current adoption probe never executes Grant transitions.');
    },
  },
]);
const grantChallenge = grant.createGrantChallenge(
  {
    ...vectorRequest,
    candidates: [vectorCandidate],
  },
  grantRegistry,
  {
    challengeId: centralVector.challengeId,
    now: new Date(centralVector.issuedAt),
    expiresAt: centralVector.expiresAt,
  },
);
if (
  grantChallenge.challengeDigest !== centralVector.challengeDigest ||
  grantChallenge.choices.length !== 1 ||
  grantChallenge.choices[0].choiceId !== centralVector.choiceId
) {
  throw new Error('Current Central Grant challenge vector is invalid.');
}
const approvalSubject = grant.createApprovalSubject(
  grantChallenge,
  {
    choiceId: grantChallenge.choices[0].choiceId,
    approvalMethod: 'human-presence',
    reasonCode: 'approved-for-vector',
    reason: 'Verify current source and installed Grant public parity.',
    sessionNonce: 'current-adoption-grant-subject-0001',
  },
  { now: new Date(centralVector.issuedAt) },
);
const approvalSubjectDigest = grant.approvalSubjectDigest(approvalSubject);
let grantNegativeCode = null;
try {
  grant.approvalSubjectDigest({
    ...approvalSubject,
    reason: 'Tamper the canonical read-only Grant subject.',
  });
} catch (error) {
  grantNegativeCode =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : null;
}
if (grantNegativeCode !== 'GRANT_APPROVAL_SUBJECT_INVALID') {
  throw new Error('Current Central Grant public rejection facts are invalid.');
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
    planReview: {
      subjectSchemaVersion: replayedPlanReviewSubject.schemaVersion,
      subjectDigest: replayedPlanReviewSubject.subjectDigest,
      manifestDigest: replayedPlanReviewSubject.manifestDigest,
      investigationTargetDigest:
        replayedPlanReviewSubject.investigationTargetDigest,
      readerOutcome: 'verified',
      negativeOutcome: 'blocked',
      negativeCode: planReviewNegativeCode,
    },
    centralGrant: {
      policySchemaVersion: policy.policy.schemaVersion,
      policyDigest: 'sha256:' + policy.digest,
      recordKind: record.kind,
      recordState: record.state,
      challengeDigest: grantChallenge.challengeDigest,
      stateDigest: grantChallenge.stateBinding.digest,
      approvalMethods: grantChallenge.choices[0].allowedApprovalMethods,
      approvalSubjectDigest,
      recordDigest,
      publicReadKind: publicRecord.kind,
      negativeOutcome: 'blocked',
      negativeCode: grantNegativeCode,
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

function isPlanReviewComparisonFacts(
  value: JsonRecord | null,
  manifestV3: CurrentJigwrightV3ComparisonFactsV1['manifestV3'],
): value is CurrentJigwrightV3ComparisonFactsV1['planReview'] {
  return (
    value !== null &&
    hasExactKeys(value, [
      'subjectSchemaVersion',
      'subjectDigest',
      'manifestDigest',
      'investigationTargetDigest',
      'readerOutcome',
      'negativeOutcome',
      'negativeCode',
    ]) &&
    value.subjectSchemaVersion === 1 &&
    isDigest(value.subjectDigest) &&
    value.manifestDigest === manifestV3.manifestDigest &&
    value.investigationTargetDigest === manifestV3.investigationTargetDigest &&
    value.readerOutcome === 'verified' &&
    value.negativeOutcome === 'blocked' &&
    value.negativeCode === 'PLAN_REVIEW_INVALID'
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
      'stateDigest',
      'approvalMethods',
      'approvalSubjectDigest',
      'recordDigest',
      'publicReadKind',
      'negativeOutcome',
      'negativeCode',
    ]) &&
    value.policySchemaVersion === 2 &&
    isSha256Digest(value.policyDigest) &&
    value.recordKind === 'grant-record.v1' &&
    value.recordState === 'pending' &&
    isSha256Digest(value.challengeDigest) &&
    isSha256Digest(value.stateDigest) &&
    sameJson(value.approvalMethods, ['human-presence', 'ssh']) &&
    isSha256Digest(value.approvalSubjectDigest) &&
    isSha256Digest(value.recordDigest) &&
    value.publicReadKind === 'grant-record.v1' &&
    value.negativeOutcome === 'blocked' &&
    value.negativeCode === 'GRANT_APPROVAL_SUBJECT_INVALID'
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
      'planReview',
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
    !isRecord(value.planReview) ||
    !isPlanReviewComparisonFacts(value.planReview, value.manifestV3) ||
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
    hasExactKeys(value, [
      'refs',
      'tracked',
      'localGitConfig',
      'ignoredWorkingState',
      'privateRuntime',
    ]) &&
    isSha256Digest(value.refs) &&
    isSha256Digest(value.tracked) &&
    isSha256Digest(value.localGitConfig) &&
    isSha256Digest(value.ignoredWorkingState) &&
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

function isSingleJigwrightPackageArtifactV1(
  value: unknown,
): value is SingleJigwrightPackageArtifactV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'name',
      'version',
      'tarball',
      'digest',
      'source',
    ]) &&
    value.schemaVersion === 1 &&
    value.kind === 'jigwright-single-package.v1' &&
    value.name === 'jigwright' &&
    typeof value.version === 'string' &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u.test(value.version) &&
    value.tarball === `jigwright-${value.version}.tgz` &&
    isSha256Digest(value.digest) &&
    isRecord(value.source) &&
    hasExactKeys(value.source, ['commit', 'tree', 'dirty']) &&
    isGitObjectId(value.source.commit) &&
    isGitObjectId(value.source.tree) &&
    typeof value.source.dirty === 'boolean'
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
    !isSingleJigwrightPackageArtifactV1(value.release) ||
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
  if (
    consumer.localCutover.rootWorkflow.lockfileDigest !== lockfile.digest ||
    consumer.localCutover.rootWorkflow.lockfileIntegrity !== lockfile.integrity
  ) {
    throw new Error('Current Jigwright adoption report is invalid.');
  }
  verifyCurrentJigwrightAdoptionComparisonV1(value.comparison, {
    releaseDigest: release.digest,
    source: { commit: release.source.commit, tree: release.source.tree },
    consumer: { commit: consumer.commit, tree: consumer.tree },
  });
  return value as unknown as CurrentJigwrightAdoptionReportV1;
}

function isCurrentConsumerEvidence(value: JsonRecord): boolean {
  if (
    !hasExactKeys(value, [
      'commit',
      'tree',
      'clean',
      'history',
      'localCutover',
      'rollback',
    ]) ||
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
    !isCurrentLocalCutoverEvidence(value.localCutover) ||
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

function isCurrentLocalCutoverEvidence(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'environment',
      'realPilot',
      'notEvaluated',
      'rootWorkflow',
      'hooks',
    ]) ||
    value.kind !== 'jigwright-synthetic-local-cutover.v1' ||
    value.environment !== 'synthetic-local' ||
    value.realPilot !== false ||
    !sameJson(value.notEvaluated, [
      'managed-lifecycle',
      'grant-transitions',
      'human-gates',
      'expense-app-consumer',
      'publication',
      'full-gate',
    ]) ||
    !isRecord(value.rootWorkflow) ||
    !hasExactKeys(value.rootWorkflow, [
      'script',
      'invocation',
      'packageName',
      'packageExecutable',
      'packageExecutableDigest',
      'bin',
      'binTarget',
      'binDigest',
      'lockfileDigest',
      'lockfileIntegrity',
      'guide',
    ]) ||
    value.rootWorkflow.script !== 'jigwright' ||
    value.rootWorkflow.invocation !== 'npm run --silent workflow --' ||
    value.rootWorkflow.packageName !== 'jigwright' ||
    value.rootWorkflow.packageExecutable !==
      'node_modules/jigwright/bin/jigwright.mjs' ||
    !isSha256Digest(value.rootWorkflow.packageExecutableDigest) ||
    value.rootWorkflow.bin !== 'node_modules/.bin/jigwright' ||
    value.rootWorkflow.binTarget !== '../jigwright/bin/jigwright.mjs' ||
    !isSha256Digest(value.rootWorkflow.binDigest) ||
    value.rootWorkflow.binDigest !==
      value.rootWorkflow.packageExecutableDigest ||
    !isSha256Digest(value.rootWorkflow.lockfileDigest) ||
    typeof value.rootWorkflow.lockfileIntegrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(
      value.rootWorkflow.lockfileIntegrity,
    ) ||
    !isCommandObservation(value.rootWorkflow.guide) ||
    !isSuccessfulCommand(value.rootWorkflow.guide, 'guide') ||
    !isRecord(value.rootWorkflow.guide.payload.guide) ||
    value.rootWorkflow.guide.payload.guide.kind !==
      'workflow-command-guide.v1' ||
    !isRecord(value.hooks) ||
    !hasExactKeys(value.hooks, ['proxies', 'observations', 'state']) ||
    !Array.isArray(value.hooks.proxies) ||
    value.hooks.proxies.length !== CURRENT_HOOKS.length ||
    !value.hooks.proxies.every((entry, index) => {
      const hook = CURRENT_HOOKS[index]!;
      const content = currentHookProxyContent(hook);
      return (
        isRecord(entry) &&
        hasExactKeys(entry, [
          'hook',
          'path',
          'content',
          'digest',
          'executable',
        ]) &&
        entry.hook === hook &&
        entry.path === `.husky/${hook}` &&
        entry.content === content &&
        entry.digest === digestBytes(content) &&
        entry.executable === true
      );
    }) ||
    !isRecord(value.hooks.observations) ||
    !hasExactKeys(value.hooks.observations, [
      'preCommit',
      'malformedCommitMessage',
      'prePushWithoutTransaction',
      'postMerge',
    ]) ||
    !isSuccessfulHookObservation(
      value.hooks.observations.preCommit,
      'pre-commit',
    ) ||
    !isFailedHookObservation(
      value.hooks.observations.malformedCommitMessage,
      'COMMIT_MESSAGE_INVALID',
    ) ||
    !isFailedHookObservation(
      value.hooks.observations.prePushWithoutTransaction,
      'PUBLISH_TRANSACTION_REQUIRED',
    ) ||
    !isSuccessfulHookObservation(
      value.hooks.observations.postMerge,
      'post-merge',
    ) ||
    !isRecord(value.hooks.state) ||
    !hasExactKeys(value.hooks.state, ['before', 'after', 'unchanged']) ||
    !isStateFingerprint(value.hooks.state.before) ||
    !isStateFingerprint(value.hooks.state.after) ||
    value.hooks.state.unchanged !== true ||
    !sameJson(value.hooks.state.before, value.hooks.state.after)
  ) {
    return false;
  }
  return true;
}

function isSuccessfulHookObservation(
  value: unknown,
  hook: CurrentJigwrightHookName,
): boolean {
  if (!isCommandObservation(value) || !isRecord(value.payload.result)) {
    return false;
  }
  return (
    value.exitCode === 0 &&
    value.stream === 'stdout' &&
    value.payload.ok === true &&
    value.payload.command === 'hook' &&
    value.payload.result.hook === hook &&
    Array.isArray(value.payload.result.changes) &&
    Array.isArray(value.payload.result.documents)
  );
}

function isFailedHookObservation(value: unknown, code: string): boolean {
  if (!isCommandObservation(value) || !isRecord(value.payload.error)) {
    return false;
  }
  return (
    value.exitCode > 0 &&
    value.stream === 'stderr' &&
    value.payload.ok === false &&
    value.payload.error.code === code
  );
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
  assertCurrentLocalCutoverHistory(consumerRoot, report, expectedResolved);

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
  const currentState =
    inspectCurrentJigwrightRepositoryStateFingerprintV1(consumerRoot);
  if (
    !sameJson(currentState, report.comparison.source.state.after) ||
    !sameJson(currentState, report.comparison.installed.state.after) ||
    !sameJson(currentState, report.consumer.localCutover.hooks.state.after)
  ) {
    throw new Error('Current Jigwright state fingerprint is invalid.');
  }
  const installedRoot = fs.realpathSync(
    path.join(consumerRoot, 'node_modules', 'jigwright'),
  );
  const observedLocalCutover = collectCurrentLocalCutoverEvidence({
    consumerRoot,
    installedRoot,
    installedManifest: readJson(path.join(installedRoot, 'package.json')),
    lockfile: report.install.lockfile,
    installedGuide: report.comparison.installed.commands.guide,
  });
  if (!sameJson(observedLocalCutover, report.consumer.localCutover)) {
    throw new Error('Current Jigwright local cutover evidence is invalid.');
  }
  return report;
}

function assertCurrentLocalCutoverHistory(
  consumerRoot: string,
  report: CurrentJigwrightAdoptionReportV1,
  expectedResolved: string,
): void {
  const { baseline, dependency, cutover } = report.consumer.history;
  if (
    git(consumerRoot, ['rev-parse', `${dependency.commit}^`]) !==
      baseline.commit ||
    git(consumerRoot, ['rev-parse', `${cutover.commit}^`]) !== dependency.commit
  ) {
    throw new Error('Current Jigwright consumer cutover history is invalid.');
  }
  const baselineManifest = readGitJson(
    consumerRoot,
    baseline.commit,
    'package.json',
  );
  const dependencyManifest = readGitJson(
    consumerRoot,
    dependency.commit,
    'package.json',
  );
  const cutoverManifest = readGitJson(
    consumerRoot,
    cutover.commit,
    'package.json',
  );
  if (
    'dependencies' in baselineManifest ||
    'scripts' in baselineManifest ||
    !isRecord(dependencyManifest.dependencies) ||
    dependencyManifest.dependencies.jigwright !== expectedResolved ||
    'scripts' in dependencyManifest ||
    !isRecord(cutoverManifest.dependencies) ||
    cutoverManifest.dependencies.jigwright !== expectedResolved ||
    !sameJson(cutoverManifest.scripts, { workflow: 'jigwright' }) ||
    digestBytes(
      gitFileBytes(
        consumerRoot,
        dependency.commit,
        report.install.lockfile.path,
      ),
    ) !== report.install.lockfile.digest ||
    digestBytes(
      gitFileBytes(consumerRoot, cutover.commit, report.install.lockfile.path),
    ) !== report.install.lockfile.digest
  ) {
    throw new Error('Current Jigwright root workflow binding is invalid.');
  }

  for (const proxy of report.consumer.localCutover.hooks.proxies) {
    const bytes = gitFileBytes(consumerRoot, cutover.commit, proxy.path);
    const treeEntry = git(consumerRoot, [
      'ls-tree',
      cutover.commit,
      '--',
      proxy.path,
    ]);
    if (
      bytes.toString('utf8') !== proxy.content ||
      digestBytes(bytes) !== proxy.digest ||
      !treeEntry.startsWith('100755 blob ') ||
      gitFileExists(consumerRoot, dependency.commit, proxy.path)
    ) {
      throw new Error(`Current ${proxy.hook} cutover binding is invalid.`);
    }
  }
}

function readGitJson(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
): JsonRecord {
  return parseJsonOutput(
    gitFileBytes(repositoryRoot, commit, relativePath).toString('utf8'),
  );
}

function gitFileBytes(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
): Buffer {
  const result = spawnSync('git', ['show', `${commit}:${relativePath}`], {
    cwd: repositoryRoot,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(
      `Current Jigwright committed file is missing: ${relativePath}.`,
    );
  }
  return result.stdout;
}

function gitFileExists(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
): boolean {
  return (
    runCommand(
      'git',
      ['cat-file', '-e', `${commit}:${relativePath}`],
      repositoryRoot,
    ).status === 0
  );
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

function gitRaw(repository: string, args: string[]): Buffer {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'buffer',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed.`);
  }
  return Buffer.from(result.stdout);
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
  const statusIndex = process.argv.indexOf('--status');
  if (
    outputIndex >= 0 &&
    process.argv[outputIndex + 1] !== undefined &&
    statusIndex < 0
  ) {
    const report = runCurrentJigwrightAdoption(
      process.cwd(),
      process.argv[outputIndex + 1]!,
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (
    statusIndex >= 0 &&
    process.argv[statusIndex + 1] !== undefined &&
    outputIndex < 0
  ) {
    const freshness = inspectCurrentJigwrightAdoptionFreshness(
      process.cwd(),
      process.argv[statusIndex + 1]!,
    );
    process.stdout.write(`${JSON.stringify(freshness)}\n`);
  } else {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/run-current-jigwright-adoption.ts (--output|--status) <directory>',
    );
  }
}
