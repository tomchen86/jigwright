import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  buildLocalJigwrightRelease,
  type LocalJigwrightReleaseMatrixV1,
} from './build-local-jigwright-release.ts';

type JsonRecord = Record<string, unknown>;

export type LocalJigwrightAdoptionClassificationV1 = Readonly<{
  validation: 'accepted' | 'rejected';
  resultClass: string | null;
  errorClass: string | null;
}>;

type LocalJigwrightAdoptionObservationV1 = Readonly<{
  exitCode: number;
  payload: JsonRecord;
  classification: LocalJigwrightAdoptionClassificationV1;
}>;

type DualRunScenarioV1 = Readonly<{
  id: string;
  domain:
    | 'routing'
    | 'planning'
    | 'task-history'
    | 'archive-history'
    | 'concurrency-history'
    | 'execution-history'
    | 'intake-history'
    | 'historical-ci-replay';
  argv: readonly string[];
  embedded: LocalJigwrightAdoptionObservationV1;
  installed: LocalJigwrightAdoptionObservationV1;
  equal: boolean;
}>;

export type LocalJigwrightAdoptionReportV1 = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-local-adoption-report.v1';
  release: LocalJigwrightReleaseMatrixV1;
  fixture: Readonly<{
    baselineCommit: string;
    dependencyCommit: string;
    cutoverCommit: string;
    tree: string;
  }>;
  install: Readonly<{
    networkPolicy: 'offline-local-tarballs';
    packageManager: 'pnpm@11.12.0';
    frozenLockfileVerified: true;
    lifecycleScriptsDenied: true;
    packages: readonly Readonly<{ name: string; version: string }>[];
    omittedOptionalPackages: readonly string[];
  }>;
  parity: Readonly<{
    schemaVersion: 1;
    kind: 'jigwright-read-only-dual-run.v1';
    scenarios: readonly DualRunScenarioV1[];
    equal: boolean;
    reportDigest: `sha256:${string}`;
    reportPath: string;
  }>;
  grantBoundary: Readonly<{
    command: 'maintainer collaboration-grant --json';
    singleExecution: true;
    humanInteractions: 0;
    grantEffects: 0;
    installed: LocalJigwrightAdoptionObservationV1;
  }>;
  cutover: Readonly<{
    entrypoint: 'pnpm workflow';
    observation: LocalJigwrightAdoptionObservationV1;
  }>;
  downgrade: Readonly<{
    revertedCommits: readonly [string, string];
    exactDependencyRemoved: true;
    observation: LocalJigwrightAdoptionObservationV1;
  }>;
  deferred: Readonly<{
    externalEffects: 'canonical-record-read-only-replay';
    operationalGates: readonly ['full-gate', 'real-protected-pilot'];
    embeddedRemoval: 'separate-explicit-task';
  }>;
}>;

type ScenarioDefinition = Readonly<{
  id: string;
  domain: DualRunScenarioV1['domain'];
  argv: readonly string[];
}>;

export function runLocalJigwrightAdoption(
  requestedRepositoryRoot: string,
  requestedAdoptionRoot: string,
  options: Readonly<{ allowDirty?: boolean }> = {},
): LocalJigwrightAdoptionReportV1 {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const adoptionRoot = path.resolve(requestedAdoptionRoot);
  const releaseRoot = path.join(adoptionRoot, 'release');
  const consumerRoot = path.join(adoptionRoot, 'consumer');
  fs.mkdirSync(consumerRoot, { recursive: true });

  const release = buildLocalJigwrightRelease(
    repositoryRoot,
    releaseRoot,
    options,
  );
  assertExactLocalRelease(release);
  const embeddedCli = path.join(
    repositoryRoot,
    'packages',
    'workflow-engine',
    'bootstrap',
    'jigwright-cli.mjs',
  );
  writeBaselineConsumer(consumerRoot, repositoryRoot, embeddedCli);
  initializeConsumerRepository(consumerRoot);
  const baselineCommit = git(consumerRoot, ['rev-parse', 'HEAD']);

  const localTarballs = localTarballReferences(
    consumerRoot,
    releaseRoot,
    release,
  );
  writeExternalDependencyCandidate(consumerRoot, localTarballs);
  installLocalTarballs(consumerRoot);
  commitConsumerPaths(
    consumerRoot,
    'Pin exact local Jigwright 0.1.0 artifacts',
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  );
  const dependencyCommit = git(consumerRoot, ['rev-parse', 'HEAD']);
  verifyFrozenLocalInstall(consumerRoot);

  const engineManifest = readJson(
    path.join(repositoryRoot, 'packages', 'workflow-engine', 'package.json'),
  );
  const optionalDependencies = isRecord(engineManifest.optionalDependencies)
    ? Object.keys(engineManifest.optionalDependencies).sort()
    : [];
  const installPackages = inspectInstalledPackages(consumerRoot, release);
  for (const name of optionalDependencies) {
    if (installPackages.some((entry) => entry.name === name)) {
      throw new Error(`Optional package was not omitted: ${name}`);
    }
  }

  const scenarios = runReadOnlyDualRun(
    consumerRoot,
    embeddedCli,
    baselineCommit,
    dependencyCommit,
  );
  const parityEqual = scenarios.every(({ equal }) => equal);
  const parityArtifact = writeParityReport(adoptionRoot, {
    schemaVersion: 1,
    kind: 'jigwright-read-only-dual-run.v1',
    facts: repositoryFacts(consumerRoot),
    release: {
      commit: release.source.commit,
      tree: release.source.tree,
      packages: release.packages.map(({ name, version, digest }) => ({
        name,
        version,
        digest,
      })),
    },
    scenarios,
    equal: parityEqual,
  });
  if (!parityEqual) {
    throw new Error('Embedded and installed Jigwright dual-run diverged.');
  }

  const grantBoundary = observeCommand(
    installedExecutable(consumerRoot),
    ['maintainer', 'collaboration-grant', '--json'],
    consumerRoot,
  );
  if (
    grantBoundary.classification.errorClass !==
    'JIGWRIGHT_OPTIONAL_GRANTS_UNAVAILABLE'
  ) {
    throw new Error(
      `Optional Grants boundary did not fail closed: ${JSON.stringify(grantBoundary.classification)}`,
    );
  }

  switchConsumerEntrypoint(consumerRoot);
  commitConsumerPaths(consumerRoot, 'Cut over to external Jigwright', [
    'package.json',
  ]);
  const cutoverCommit = git(consumerRoot, ['rev-parse', 'HEAD']);
  const cutover = observeCommand(
    'pnpm',
    ['--silent', 'workflow', 'guide', '--json'],
    consumerRoot,
  );
  if (cutover.classification.validation !== 'accepted') {
    throw new Error('External Jigwright cutover entrypoint failed.');
  }

  const downgrade = rehearseDowngrade(
    adoptionRoot,
    consumerRoot,
    cutoverCommit,
    dependencyCommit,
  );
  return {
    schemaVersion: 1,
    kind: 'jigwright-local-adoption-report.v1',
    release,
    fixture: {
      baselineCommit,
      dependencyCommit,
      cutoverCommit,
      tree: git(consumerRoot, ['rev-parse', 'HEAD^{tree}']),
    },
    install: {
      networkPolicy: 'offline-local-tarballs',
      packageManager: 'pnpm@11.12.0',
      frozenLockfileVerified: true,
      lifecycleScriptsDenied: true,
      packages: installPackages,
      omittedOptionalPackages: optionalDependencies,
    },
    parity: {
      schemaVersion: 1,
      kind: 'jigwright-read-only-dual-run.v1',
      scenarios,
      equal: parityEqual,
      reportDigest: parityArtifact.digest,
      reportPath: parityArtifact.relativePath,
    },
    grantBoundary: {
      command: 'maintainer collaboration-grant --json',
      singleExecution: true,
      humanInteractions: 0,
      grantEffects: 0,
      installed: grantBoundary,
    },
    cutover: {
      entrypoint: 'pnpm workflow',
      observation: cutover,
    },
    downgrade,
    deferred: {
      externalEffects: 'canonical-record-read-only-replay',
      operationalGates: ['full-gate', 'real-protected-pilot'],
      embeddedRemoval: 'separate-explicit-task',
    },
  };
}

function assertExactLocalRelease(release: LocalJigwrightReleaseMatrixV1): void {
  if (
    release.packages.length !== 6 ||
    release.packages.some(({ version }) => version !== '0.1.0')
  ) {
    throw new Error('Local adoption requires six exact 0.1.0 tarballs.');
  }
}

function writeBaselineConsumer(
  consumerRoot: string,
  repositoryRoot: string,
  embeddedCli: string,
): void {
  writeJson(path.join(consumerRoot, 'package.json'), {
    name: 'jigwright-local-adoption-consumer',
    version: '0.0.0',
    private: true,
    packageManager: 'pnpm@11.12.0',
    scripts: { workflow: 'node embedded-jigwright.mjs' },
  });
  fs.writeFileSync(
    path.join(consumerRoot, 'embedded-jigwright.mjs'),
    [
      "import childProcess from 'node:child_process';",
      `const result = childProcess.spawnSync(process.execPath, [${JSON.stringify(
        embeddedCli,
      )}, ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });`,
      'if (result.error !== undefined) throw result.error;',
      'process.exit(result.status ?? 1);',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o644 },
  );
  const consumerWorkflowConfigPath = path.join(
    consumerRoot,
    'workflow/config.json',
  );
  fs.mkdirSync(path.dirname(consumerWorkflowConfigPath), { recursive: true });
  fs.copyFileSync(
    path.join(repositoryRoot, 'workflow/config.json'),
    consumerWorkflowConfigPath,
  );
  fs.writeFileSync(
    path.join(consumerRoot, '.gitignore'),
    ['node_modules/', '.pnpm-store/', ''].join('\n'),
    'utf8',
  );
}

function initializeConsumerRepository(consumerRoot: string): void {
  git(consumerRoot, ['init', '-b', 'main']);
  git(consumerRoot, ['add', '--', '.gitignore', 'embedded-jigwright.mjs']);
  git(consumerRoot, ['add', '--', 'package.json', 'workflow/config.json']);
  gitCommit(consumerRoot, 'Initialize embedded Jigwright consumer');
}

function localTarballReferences(
  consumerRoot: string,
  releaseRoot: string,
  release: LocalJigwrightReleaseMatrixV1,
): Record<string, string> {
  return Object.fromEntries(
    release.packages.map(({ name, tarball }) => [
      name,
      localFileReference(consumerRoot, path.join(releaseRoot, tarball)),
    ]),
  );
}

function writeExternalDependencyCandidate(
  consumerRoot: string,
  localTarballs: Readonly<Record<string, string>>,
): void {
  const main = localTarballs.jigwright;
  if (main === undefined) {
    throw new Error('Local Jigwright main tarball is missing.');
  }
  const manifest = readJson(path.join(consumerRoot, 'package.json'));
  writeJson(path.join(consumerRoot, 'package.json'), {
    ...manifest,
    dependencies: { jigwright: main },
  });
  writeJson(path.join(consumerRoot, 'pnpm-workspace.yaml'), {
    overrides: localTarballs,
  });
}

function localFileReference(fromDirectory: string, target: string): string {
  const relative = path
    .relative(fromDirectory, target)
    .split(path.sep)
    .join('/');
  return `file:${relative.startsWith('.') ? relative : `./${relative}`}`;
}

function installLocalTarballs(consumerRoot: string): void {
  runRequired(
    'pnpm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      '--no-optional',
    ],
    consumerRoot,
    {
      CI: 'true',
      COREPACK_ENABLE_NETWORK: '0',
      NPM_CONFIG_OFFLINE: 'true',
      NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
    },
  );
}

function verifyFrozenLocalInstall(consumerRoot: string): void {
  runRequired(
    'pnpm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--frozen-lockfile',
      '--no-optional',
    ],
    consumerRoot,
    {
      CI: 'true',
      COREPACK_ENABLE_NETWORK: '0',
      NPM_CONFIG_OFFLINE: 'true',
      NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
    },
  );
}

function inspectInstalledPackages(
  consumerRoot: string,
  release: LocalJigwrightReleaseMatrixV1,
): readonly Readonly<{ name: string; version: string }>[] {
  return release.packages.flatMap(({ name }) => {
    const manifestPath = installedPackageManifestPath(consumerRoot, name);
    if (manifestPath === null) return [];
    const manifest = readJson(manifestPath);
    if (manifest.name !== name || manifest.version !== '0.1.0') {
      throw new Error(`Installed local package identity mismatch: ${name}`);
    }
    return [{ name, version: manifest.version } as const];
  });
}

function runReadOnlyDualRun(
  consumerRoot: string,
  embeddedCli: string,
  baselineCommit: string,
  dependencyCommit: string,
): readonly DualRunScenarioV1[] {
  const definitions: readonly ScenarioDefinition[] = [
    { id: 'guidance-catalog', domain: 'routing', argv: ['guide', '--json'] },
    {
      id: 'current-task-history-list',
      domain: 'task-history',
      argv: ['status', '--json'],
    },
    {
      id: 'missing-current-task-history',
      domain: 'task-history',
      argv: [
        'status',
        'session-20260824000000000-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '--json',
      ],
    },
    {
      id: 'missing-current-change-validation',
      domain: 'planning',
      argv: ['validate-change', 'local-adoption-fixture', '--json'],
    },
    {
      id: 'archived-change-namespace',
      domain: 'archive-history',
      argv: ['validate-change', 'archive', '--json'],
    },
    {
      id: 'execution-history-list',
      domain: 'execution-history',
      argv: ['job', 'list', '--json'],
    },
    {
      id: 'intake-history-list',
      domain: 'intake-history',
      argv: ['work-item', 'list', '--json'],
    },
    {
      id: 'concurrency-history-list',
      domain: 'concurrency-history',
      argv: ['status', '--json'],
    },
    {
      id: 'historical-ci-dependency-range',
      domain: 'historical-ci-replay',
      argv: [
        'ci',
        '--base',
        baselineCommit,
        '--head',
        dependencyCommit,
        '--json',
      ],
    },
  ];
  return definitions.map(({ id, domain, argv }) => {
    const embedded = observeCommand(
      process.execPath,
      [embeddedCli, ...argv],
      consumerRoot,
    );
    const installed = observeCommand(
      installedExecutable(consumerRoot),
      [...argv],
      consumerRoot,
    );
    return {
      id,
      domain,
      argv,
      embedded,
      installed,
      equal:
        isDeepStrictEqual(installed.classification, embedded.classification) &&
        isDeepStrictEqual(installed.payload, embedded.payload),
    };
  });
}

function writeParityReport(
  adoptionRoot: string,
  report: JsonRecord,
): { digest: `sha256:${string}`; relativePath: string } {
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  const digest = `sha256:${crypto
    .createHash('sha256')
    .update(bytes)
    .digest('hex')}` as const;
  const relativePath = path.join(
    'reports',
    `${digest.slice('sha256:'.length)}.json`,
  );
  const reportPath = path.join(adoptionRoot, relativePath);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  try {
    fs.writeFileSync(reportPath, bytes, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (
      !isRecord(error) ||
      error.code !== 'EEXIST' ||
      fs.readFileSync(reportPath, 'utf8') !== bytes
    ) {
      throw error;
    }
  }
  return { digest, relativePath: relativePath.split(path.sep).join('/') };
}

function repositoryFacts(repository: string): JsonRecord {
  return {
    head: git(repository, ['rev-parse', 'HEAD']),
    tree: git(repository, ['rev-parse', 'HEAD^{tree}']),
    status: git(repository, ['status', '--porcelain', '--untracked-files=all']),
  };
}

function switchConsumerEntrypoint(consumerRoot: string): void {
  const manifest = readJson(path.join(consumerRoot, 'package.json'));
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  writeJson(path.join(consumerRoot, 'package.json'), {
    ...manifest,
    scripts: { ...scripts, workflow: 'jigwright' },
  });
}

function rehearseDowngrade(
  adoptionRoot: string,
  consumerRoot: string,
  cutoverCommit: string,
  dependencyCommit: string,
): LocalJigwrightAdoptionReportV1['downgrade'] {
  const downgradeRoot = path.join(adoptionRoot, 'downgrade');
  runRequired(
    'git',
    ['clone', '--no-local', consumerRoot, downgradeRoot],
    adoptionRoot,
  );
  git(downgradeRoot, ['config', 'user.name', 'Jigwright Adoption']);
  git(downgradeRoot, [
    'config',
    'user.email',
    'jigwright-adoption@example.invalid',
  ]);
  git(downgradeRoot, ['revert', '--no-edit', cutoverCommit]);
  git(downgradeRoot, ['revert', '--no-edit', dependencyCommit]);
  const manifest = readJson(path.join(downgradeRoot, 'package.json'));
  if (
    (isRecord(manifest.dependencies) && 'jigwright' in manifest.dependencies) ||
    fs.existsSync(path.join(downgradeRoot, 'pnpm-lock.yaml')) ||
    fs.existsSync(path.join(downgradeRoot, 'pnpm-workspace.yaml'))
  ) {
    throw new Error('Local Jigwright downgrade retained external dependency.');
  }
  const observation = observeCommand(
    'pnpm',
    ['--silent', 'workflow', 'guide', '--json'],
    downgradeRoot,
  );
  if (observation.classification.validation !== 'accepted') {
    throw new Error('Embedded Jigwright downgrade entrypoint failed.');
  }
  return {
    revertedCommits: [cutoverCommit, dependencyCommit],
    exactDependencyRemoved: true,
    observation,
  };
}

function commitConsumerPaths(
  repository: string,
  message: string,
  paths: readonly string[],
): void {
  git(repository, ['add', '--', ...paths]);
  gitCommit(repository, message);
}

function gitCommit(repository: string, message: string): void {
  git(repository, [
    '-c',
    'user.name=Jigwright Adoption',
    '-c',
    'user.email=jigwright-adoption@example.invalid',
    'commit',
    '-m',
    message,
  ]);
}

function installedExecutable(consumerRoot: string): string {
  return path.join(consumerRoot, 'node_modules', '.bin', 'jigwright');
}

function installedPackageManifestPath(
  consumerRoot: string,
  name: string,
): string | null {
  if (name === 'jigwright') {
    const direct = path.join(
      consumerRoot,
      'node_modules',
      name,
      'package.json',
    );
    return fs.existsSync(direct) ? direct : null;
  }
  const probes: Readonly<Record<string, string>> = {
    '@jigwright/agent-runtime': '@jigwright/agent-runtime',
    '@jigwright/core': '@jigwright/core/canonical-json',
    '@jigwright/github-adapter': '@jigwright/github-adapter',
    '@jigwright/grants': '@jigwright/grants/grant-envelope-verifier',
    '@jigwright/openspec-adapter': '@jigwright/openspec-adapter',
  };
  const probe = probes[name];
  if (probe === undefined) return null;
  const mainManifest = path.join(
    fs.realpathSync(path.join(consumerRoot, 'node_modules', 'jigwright')),
    'package.json',
  );
  try {
    let current = path.dirname(createRequire(mainManifest).resolve(probe));
    while (current !== path.dirname(current)) {
      const candidate = path.join(current, 'package.json');
      if (fs.existsSync(candidate) && readJson(candidate).name === name) {
        return candidate;
      }
      current = path.dirname(current);
    }
    return null;
  } catch {
    return null;
  }
}

function observeCommand(
  executable: string,
  args: string[],
  cwd: string,
): LocalJigwrightAdoptionObservationV1 {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) throw result.error;
  const exitCode = result.status ?? 1;
  const payload = parseCommandPayload(result.stdout, result.stderr);
  return {
    exitCode,
    payload,
    classification: classifyObservation(exitCode, payload),
  };
}

function parseCommandPayload(stdout: string, stderr: string): JsonRecord {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) return value;
    } catch {
      // Continue until the final structured command result is found.
    }
  }
  throw new Error('Local adoption command did not return one JSON object.');
}

function classifyObservation(
  exitCode: number,
  payload: JsonRecord,
): LocalJigwrightAdoptionClassificationV1 {
  const guide = isRecord(payload.guide) ? payload.guide : null;
  const result = isRecord(payload.result) ? payload.result : null;
  const error = isRecord(payload.error) ? payload.error : payload;
  const command = typeof payload.command === 'string' ? payload.command : null;
  return {
    validation: exitCode === 0 && payload.ok === true ? 'accepted' : 'rejected',
    resultClass:
      typeof guide?.kind === 'string'
        ? guide.kind
        : typeof result?.kind === 'string'
          ? result.kind
          : command !== null && payload.ok === true
            ? `${command}-result`
            : null,
    errorClass: typeof error.code === 'string' ? error.code : null,
  };
}

function readJson(filePath: string): JsonRecord {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isRecord(value)) throw new Error(`Invalid JSON object: ${filePath}`);
  return value;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function git(repository: string, args: string[]): string {
  return runRequired('git', args, repository);
}

function runRequired(
  executable: string,
  args: string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || process.argv[outputIndex + 1] === undefined) {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/run-local-jigwright-adoption.ts --output <directory>',
    );
  }
  const report = runLocalJigwrightAdoption(
    process.cwd(),
    process.argv[outputIndex + 1]!,
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
