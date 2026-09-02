import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { writeDeterministicTarball } from './deterministic-tarball.ts';

type Sha256Digest = `sha256:${string}`;

export type SingleJigwrightPackageArtifactV1 = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-single-package.v1';
  name: 'jigwright';
  version: string;
  tarball: string;
  digest: Sha256Digest;
  source: Readonly<{
    commit: string;
    tree: string;
    dirty: boolean;
  }>;
}>;

type PackageManifest = Record<string, unknown> &
  Readonly<{
    name: string;
    version: string;
    files: readonly string[];
    exports?: Readonly<Record<string, string>>;
  }>;

const ENGINE_DIRECTORY = 'packages/workflow-engine';
const INTERNAL_PACKAGE_DIRECTORIES = [
  'packages/agent-runtime',
  'packages/core',
  'packages/github-adapter',
  'packages/grants',
  'packages/openspec-adapter',
] as const;
const PUBLIC_EXPORTS = Object.freeze({
  './central-grant': Object.freeze({
    types: './runtime/composition-root/public/central-grant.ts',
    import: './dist/runtime/composition-root/public/central-grant.js',
  }),
  './execution-job': Object.freeze({
    types: './runtime/composition-root/public/execution-job.ts',
    import: './dist/runtime/composition-root/public/execution-job.js',
  }),
  './manifest-v3': Object.freeze({
    types: './runtime/composition-root/public/manifest-v3.ts',
    import: './dist/runtime/composition-root/public/manifest-v3.js',
  }),
  './plan-review': Object.freeze({
    types: './runtime/composition-root/public/plan-review.ts',
    import: './dist/runtime/composition-root/public/plan-review.js',
  }),
});
const TEXT_SOURCE = /\.(?:[cm]?[jt]s)$/u;
const packageRequire = createRequire(import.meta.url);
const typescript = packageRequire('typescript') as typeof import('typescript');

export function buildSingleJigwrightPackage(
  requestedRepositoryRoot: string,
  requestedOutputRoot: string,
  options: Readonly<{ allowDirty?: boolean }> = {},
): SingleJigwrightPackageArtifactV1 {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const outputRoot = path.resolve(requestedOutputRoot);
  const status = run(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    {
      cwd: repositoryRoot,
    },
  );
  const dirty = status.length > 0;
  if (dirty && options.allowDirty !== true) {
    throw new Error('Single Jigwright package requires a clean source tree.');
  }
  assertEmptyOutputDirectory(outputRoot);

  const engineRoot = path.join(repositoryRoot, ENGINE_DIRECTORY);
  const engineManifest = readPackageManifest(
    path.join(engineRoot, 'package.json'),
    ENGINE_DIRECTORY,
  );
  if (engineManifest.name !== 'jigwright') {
    throw new Error('Single Jigwright package root identity is invalid.');
  }
  const internalPackages = INTERNAL_PACKAGE_DIRECTORIES.map(
    (relativeDirectory) => {
      const packageRoot = path.join(repositoryRoot, relativeDirectory);
      return {
        relativeDirectory,
        packageRoot,
        manifest: readPackageManifest(
          path.join(packageRoot, 'package.json'),
          relativeDirectory,
        ),
      };
    },
  ).sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
  const specifierMap = packageSpecifierMap(internalPackages);
  const packageImports = packageImportMap(internalPackages);

  fs.mkdirSync(outputRoot, { recursive: true });
  const stagingRoot = path.join(
    outputRoot,
    `.staging-${process.pid}-${crypto.randomUUID()}`,
  );
  const stageParent = path.join(stagingRoot, 'jigwright');
  const stagedPackage = path.join(stageParent, 'package');
  const tarball = `jigwright-${engineManifest.version}.tgz`;
  const tarballPath = path.join(outputRoot, tarball);
  try {
    fs.mkdirSync(stagedPackage, { recursive: true });
    copyEngineRuntime(engineRoot, stagedPackage);
    copyFile(
      path.join(repositoryRoot, 'README.md'),
      path.join(stagedPackage, 'README.md'),
    );
    copyFile(
      path.join(repositoryRoot, 'LICENSE'),
      path.join(stagedPackage, 'LICENSE'),
    );
    writeBin(stagedPackage);
    writeEmbeddedRuntime(stagedPackage, engineRoot, internalPackages);
    writePublicRuntimeProjection(
      stagedPackage,
      engineRoot,
      internalPackages,
      specifierMap,
    );
    writePackageManifest(
      stagedPackage,
      engineManifest,
      packageImports,
      repositoryRoot,
    );
    writeDeterministicTarball(stageParent, tarballPath);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: 'jigwright-single-package.v1',
    name: 'jigwright',
    version: engineManifest.version,
    tarball,
    digest: digestFile(tarballPath),
    source: Object.freeze({
      commit: run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
      tree: run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryRoot }),
      dirty,
    }),
  });
}

function copyEngineRuntime(engineRoot: string, stagedPackage: string): void {
  for (const relativePath of ['bootstrap', 'native', 'src'] as const) {
    copyPath(
      path.join(engineRoot, relativePath),
      path.join(stagedPackage, relativePath),
    );
  }
}

function writeBin(stagedPackage: string): void {
  const binPath = path.join(stagedPackage, 'bin', 'jigwright.mjs');
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(
    binPath,
    "#!/usr/bin/env node\n\nawait import('../bootstrap/jigwright-cli.mjs');\n",
    { encoding: 'utf8', mode: 0o755 },
  );
}

function writeEmbeddedRuntime(
  stagedPackage: string,
  engineRoot: string,
  internalPackages: readonly Readonly<{
    packageRoot: string;
    manifest: PackageManifest;
  }>[],
): void {
  const closure = readJson(
    path.join(engineRoot, 'bootstrap', 'built-in-engine-closure.json'),
  );
  if (!Array.isArray(closure.packages)) {
    throw new Error('Installed Jigwright runtime closure is invalid.');
  }
  const packagesByName = new Map(
    internalPackages.map(({ packageRoot, manifest }) => [
      manifest.name,
      { packageRoot, manifest },
    ]),
  );
  const descriptors = closure.packages.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.name !== 'string' ||
      typeof value.sourceRoot !== 'string'
    ) {
      throw new Error('Installed Jigwright runtime closure is invalid.');
    }
    if (value.name === 'jigwright') {
      return {
        name: value.name,
        sourceRoot: value.sourceRoot,
        embeddedSourceRoot: null,
        sourceManifestBase64: fs
          .readFileSync(path.join(engineRoot, 'package.json'))
          .toString('base64'),
      };
    }
    const source = packagesByName.get(value.name);
    if (source === undefined) {
      throw new Error(`Installed runtime package is missing: ${value.name}`);
    }
    const embeddedSourceRoot = path.posix.join(
      'bootstrap',
      'installed-runtime-sources',
      safePackageName(value.name),
    );
    copyPath(
      path.join(source.packageRoot, 'src'),
      path.join(stagedPackage, embeddedSourceRoot, 'src'),
    );
    return {
      name: value.name,
      sourceRoot: value.sourceRoot,
      embeddedSourceRoot,
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
        packages: descriptors,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function writePublicRuntimeProjection(
  stagedPackage: string,
  engineRoot: string,
  internalPackages: readonly Readonly<{
    packageRoot: string;
    manifest: PackageManifest;
  }>[],
  specifierMap: ReadonlyMap<string, string>,
): void {
  const publicRuntimeRoot = path.join(stagedPackage, 'runtime');
  copyPath(path.join(engineRoot, 'src'), publicRuntimeRoot);
  rewritePackageSpecifiers(publicRuntimeRoot, specifierMap);
  transpileProjection(
    publicRuntimeRoot,
    path.join(stagedPackage, 'dist', 'runtime'),
  );

  for (const { packageRoot, manifest } of internalPackages) {
    const targetRoot = path.join(
      stagedPackage,
      'internal',
      internalDirectoryName(manifest.name),
    );
    for (const relativePath of manifest.files) {
      assertSafeRelativePath(relativePath);
      copyPath(
        path.join(packageRoot, relativePath),
        path.join(targetRoot, relativePath),
      );
    }
    rewritePackageSpecifiers(targetRoot, specifierMap);
    transpileProjection(
      targetRoot,
      path.join(
        stagedPackage,
        'dist',
        'internal',
        internalDirectoryName(manifest.name),
      ),
    );
  }
  copyPath(
    path.join(stagedPackage, 'native'),
    path.join(stagedPackage, 'dist', 'native'),
  );
}

function writePackageManifest(
  stagedPackage: string,
  engineManifest: PackageManifest,
  packageImports: Readonly<
    Record<string, Readonly<{ types: string; default: string }>>
  >,
  repositoryRoot: string,
): void {
  const rootManifest = readJson(path.join(repositoryRoot, 'package.json'));
  const license =
    typeof rootManifest.license === 'string'
      ? rootManifest.license
      : 'UNLICENSED';
  const manifest = {
    name: 'jigwright',
    version: engineManifest.version,
    description: engineManifest.description,
    type: 'module',
    bin: { jigwright: './bin/jigwright.mjs' },
    exports: PUBLIC_EXPORTS,
    imports: packageImports,
    files: [
      'bin',
      'bootstrap',
      'dist',
      'internal',
      'native',
      'runtime',
      'src',
      'README.md',
      'LICENSE',
    ],
    engines: engineManifest.engines,
    jigwrightRelease: {
      schemaVersion: 1,
      installedCliSurface: 'embedded-workspace-typescript-v1',
      publicModuleSurface: 'compiled-package-import-map-v1',
      entrypoint: './bin/jigwright.mjs',
    },
    license,
  };
  fs.writeFileSync(
    path.join(stagedPackage, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function packageSpecifierMap(
  packages: readonly Readonly<{ manifest: PackageManifest }>[],
): ReadonlyMap<string, string> {
  const entries: [string, string][] = [];
  for (const { manifest } of packages) {
    if (!isRecord(manifest.exports)) {
      throw new Error(`Internal package ${manifest.name} has no exports.`);
    }
    const aliasRoot = `#internal/${internalDirectoryName(manifest.name)}`;
    for (const exportName of Object.keys(manifest.exports).sort()) {
      if (exportName !== '.' && !exportName.startsWith('./')) {
        throw new Error(`Internal package export is invalid: ${exportName}`);
      }
      entries.push([
        exportName === '.'
          ? manifest.name
          : `${manifest.name}/${exportName.slice(2)}`,
        exportName === '.' ? aliasRoot : `${aliasRoot}/${exportName.slice(2)}`,
      ]);
    }
  }
  return new Map(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function packageImportMap(
  packages: readonly Readonly<{ manifest: PackageManifest }>[],
): Readonly<Record<string, Readonly<{ types: string; default: string }>>> {
  const entries: [string, Readonly<{ types: string; default: string }>][] = [];
  for (const { manifest } of packages) {
    if (!isRecord(manifest.exports)) {
      throw new Error(`Internal package ${manifest.name} has no exports.`);
    }
    const directory = internalDirectoryName(manifest.name);
    for (const [exportName, target] of Object.entries(manifest.exports).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (
        typeof target !== 'string' ||
        !target.startsWith('./') ||
        (exportName !== '.' && !exportName.startsWith('./'))
      ) {
        throw new Error(`Internal package export is invalid: ${exportName}`);
      }
      const alias =
        exportName === '.'
          ? `#internal/${directory}`
          : `#internal/${directory}/${exportName.slice(2)}`;
      entries.push([
        alias,
        Object.freeze({
          types: `./internal/${directory}/${target.slice(2)}`,
          default: `./dist/internal/${directory}/${target
            .slice(2)
            .replace(/\.ts$/u, '.js')}`,
        }),
      ]);
    }
  }
  return Object.freeze(
    Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))),
  );
}

function transpileProjection(sourceRoot: string, outputRoot: string): void {
  for (const sourcePath of walkFiles(sourceRoot)) {
    const relativePath = path.relative(sourceRoot, sourcePath);
    if (path.isAbsolute(relativePath) || relativePath.startsWith('..')) {
      throw new Error('Single package projection escaped its source root.');
    }
    if (!TEXT_SOURCE.test(sourcePath)) {
      copyFile(sourcePath, path.join(outputRoot, relativePath));
      continue;
    }
    const result = typescript.transpileModule(
      fs.readFileSync(sourcePath, 'utf8'),
      {
        compilerOptions: {
          module: typescript.ModuleKind.ESNext,
          target: typescript.ScriptTarget.ES2023,
          rewriteRelativeImportExtensions: true,
          sourceMap: false,
        },
        fileName: sourcePath,
        reportDiagnostics: true,
      },
    );
    const errors = (result.diagnostics ?? []).filter(
      ({ category }) => category === typescript.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      throw new Error(
        `Single package TypeScript projection failed: ${typescript.formatDiagnostics(
          errors,
          {
            getCanonicalFileName: (value) => value,
            getCurrentDirectory: () => sourceRoot,
            getNewLine: () => '\n',
          },
        )}`,
      );
    }
    const outputPath = path.join(
      outputRoot,
      relativePath.replace(/\.(?:[cm]?ts)$/u, '.js'),
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, result.outputText, 'utf8');
  }
}

function rewritePackageSpecifiers(
  root: string,
  specifierMap: ReadonlyMap<string, string>,
): void {
  for (const filePath of walkFiles(root)) {
    if (!TEXT_SOURCE.test(filePath)) continue;
    const before = fs.readFileSync(filePath, 'utf8');
    let after = before;
    for (const [specifier, replacement] of specifierMap) {
      after = after
        .replaceAll(`'${specifier}'`, `'${replacement}'`)
        .replaceAll(`"${specifier}"`, `"${replacement}"`);
    }
    if (after !== before) fs.writeFileSync(filePath, after, 'utf8');
    const unresolved = [
      /\bfrom\s*['"](@jigwright\/[^'"]+)['"]/u,
      /\bimport\s*\(\s*['"](@jigwright\/[^'"]+)['"]\s*\)/u,
      /\bimport\s+['"](@jigwright\/[^'"]+)['"]/u,
    ].find((pattern) => pattern.test(after));
    if (unresolved !== undefined) {
      throw new Error(
        `Public runtime projection has an unresolved internal import: ${filePath}`,
      );
    }
  }
}

function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return walkFiles(target);
    if (entry.isFile()) return [target];
    throw new Error(`Single package source path is unsupported: ${target}`);
  });
}

function readPackageManifest(
  manifestPath: string,
  relativeDirectory: string,
): PackageManifest {
  const manifest = readJson(manifestPath);
  if (
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every((entry) => typeof entry === 'string')
  ) {
    throw new Error(`Package ${relativeDirectory} is not package-ready.`);
  }
  return manifest as PackageManifest;
}

function readJson(filePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isRecord(value)) throw new Error(`Invalid JSON object: ${filePath}`);
  return value;
}

function copyPath(source: string, target: string): void {
  const stats = fs.lstatSync(source, { throwIfNoEntry: false });
  if (stats === undefined || stats.isSymbolicLink()) {
    throw new Error(`Single package source path is unsafe: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
}

function copyFile(source: string, target: string): void {
  const stats = fs.lstatSync(source, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Single package file is unsafe: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function assertEmptyOutputDirectory(outputRoot: string): void {
  const stats = fs.lstatSync(outputRoot, { throwIfNoEntry: false });
  if (
    stats !== undefined &&
    (!stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.readdirSync(outputRoot).length > 0)
  ) {
    throw new Error('Single Jigwright package output must be empty.');
  }
}

function assertSafeRelativePath(value: string): void {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid single package path: ${value}`);
  }
}

function internalDirectoryName(name: string): string {
  if (!/^@jigwright\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new Error(`Internal package name is invalid: ${name}`);
  }
  return name.slice('@jigwright/'.length);
}

function safePackageName(name: string): string {
  return name.replace(/^@/u, '').replaceAll('/', '-');
}

function digestFile(filePath: string): Sha256Digest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')}`;
}

function run(
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
      'Usage: node --experimental-strip-types scripts/build-single-jigwright-package.ts --output <directory>',
    );
  }
  const artifact = buildSingleJigwrightPackage(
    process.cwd(),
    process.argv[outputIndex + 1]!,
  );
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}
