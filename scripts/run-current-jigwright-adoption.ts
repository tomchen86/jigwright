import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  buildSingleJigwrightPackage,
  type SingleJigwrightPackageArtifactV1,
} from './build-single-jigwright-package.ts';

type JsonRecord = Record<string, unknown>;

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
  }>;
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

  const consumerRoot = path.join(adoptionRoot, 'consumer');
  fs.mkdirSync(consumerRoot, { recursive: true });
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
  fs.writeFileSync(
    path.join(consumerRoot, '.gitignore'),
    'node_modules/\n',
    'utf8',
  );
  initializeConsumerRepository(consumerRoot);

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

  const executable = path.join(installedRoot, 'bin', 'jigwright.mjs');
  const initialized = parseSuccess(
    runCommand(process.execPath, [executable, 'init', '--json'], consumerRoot),
    'Current Jigwright init failed.',
  );
  if (!isRecord(initialized.result)) {
    throw new Error('Current Jigwright init result is invalid.');
  }
  const init = initialized.result;
  if (
    init.kind !== 'jigwright-init-result.v1' ||
    init.status !== 'initialized' ||
    typeof init.path !== 'string' ||
    !isSha256Digest(init.digest)
  ) {
    throw new Error('Current Jigwright init result is invalid.');
  }
  const profilePath = path.join(consumerRoot, init.path);
  const policyBefore = fs.readFileSync(profilePath);
  const repeated = runCommand(
    process.execPath,
    [executable, 'init', '--json'],
    consumerRoot,
  );
  const repeatedPayload = parseJsonOutput(repeated.stderr);
  const repeatedError = isRecord(repeatedPayload.error)
    ? repeatedPayload.error
    : null;
  if (
    repeated.status !== 12 ||
    repeatedError?.code !== 'JIGWRIGHT_INIT_ALREADY_CONFIGURED' ||
    !fs.readFileSync(profilePath).equals(policyBefore)
  ) {
    throw new Error(
      'Current Jigwright init did not preserve repository policy.',
    );
  }

  const guidance = parseSuccess(
    runCommand(process.execPath, [executable, 'guide', '--json'], consumerRoot),
    'Installed current Jigwright guide failed.',
  );
  const guide = isRecord(guidance.guide) ? guidance.guide : null;
  if (guide?.kind !== 'workflow-command-guide.v1') {
    throw new Error('Installed current Jigwright guide contract is invalid.');
  }

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

  git(consumerRoot, [
    'add',
    '--',
    '.gitignore',
    'package.json',
    'package-lock.json',
    init.path,
  ]);
  git(consumerRoot, ['commit', '-m', 'Adopt exact current Jigwright package']);
  const clean = git(consumerRoot, ['status', '--porcelain']).length === 0;
  if (!clean) throw new Error('Current Jigwright adoption consumer is dirty.');

  return Object.freeze({
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
      commit: git(consumerRoot, ['rev-parse', 'HEAD']),
      tree: git(consumerRoot, ['rev-parse', 'HEAD^{tree}']),
      clean: true as const,
    }),
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
}

function initializeConsumerRepository(consumerRoot: string): void {
  git(consumerRoot, ['init', '-b', 'main']);
  git(consumerRoot, ['config', 'user.email', 'jigwright@example.test']);
  git(consumerRoot, ['config', 'user.name', 'Jigwright Adoption']);
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

function parseSuccess(
  result: ReturnType<typeof spawnSync>,
  failureMessage: string,
): JsonRecord {
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error(`${failureMessage} ${String(result.stderr).trim()}`);
  }
  return parseJsonOutput(result.stdout);
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

function git(repository: string, args: string[]): string {
  return runRequired('git', args, repository);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
