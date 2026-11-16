/** Pinned workspace source closure validation and materialized artifact verification. */
import fs from 'node:fs';
import path from 'node:path';
import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from './built-in-engine-closure-pin.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  assertExactPackageRoot,
  readClosureFile,
} from './control-plane-bootstrap-files.ts';
import type {
  BuiltInClosureManifest,
  BuiltInClosureManifestV2,
  BuiltInClosurePackageV2,
  VerifiedBuiltInEngineClosure,
} from './control-plane-bootstrap-types.ts';
import {
  builtInClosureMismatch,
  hasExactKeys,
  isDigest,
  isRecord,
  rawDigest,
  safeClosurePath,
} from './control-plane-bootstrap-values.ts';

/** Verify and return the pinned pristine E1 entrypoint. */
export function verifyBuiltInEngineClosure(packageRoot: string): string {
  const closure = verifiedBuiltInEngineClosure(packageRoot);
  return path.join(packageRoot, ...closure.manifest.entrypoint.split('/'));
}

export function verifiedBuiltInEngineClosure(
  packageRoot: string,
): VerifiedBuiltInEngineClosure {
  assertExactPackageRoot(packageRoot);
  const manifestPath = path.join(
    packageRoot,
    'bootstrap',
    'built-in-engine-closure.json',
  );
  const manifestBytes = readClosureFile(manifestPath, 0o644);
  if (rawDigest(manifestBytes) !== BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST) {
    throw builtInClosureMismatch();
  }

  let value: unknown;
  try {
    value = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw builtInClosureMismatch();
  }
  if (
    `${JSON.stringify(value, null, 2)}\n` !== manifestBytes.toString('utf8')
  ) {
    throw builtInClosureMismatch();
  }
  const manifest = verifyClosureManifest(value);
  assertLiveClosureInventory(packageRoot, manifest);

  const repositoryRoot = repositoryRootForWorkspaceClosure(packageRoot);
  const files = manifest.files.map((entry) => {
    const repositoryPath = closureRepositoryPath(manifest, entry.path);
    const absolute = path.join(repositoryRoot, ...repositoryPath.split('/'));
    const expectedMode = entry.mode === '100755' ? 0o755 : 0o644;
    const bytes = readClosureFile(absolute, expectedMode);
    if (rawDigest(bytes) !== entry.digest) throw builtInClosureMismatch();
    return { ...entry, repositoryPath, bytes };
  });
  assertWorkspaceDependencyClosure(manifest, files);
  return {
    manifest,
    manifestBytes,
    manifestDigest: BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
    files,
  };
}

export function verifyClosureManifest(value: unknown): BuiltInClosureManifest {
  if (isRecord(value) && value.kind === 'built-in-engine-closure-manifest.v2') {
    return verifyClosureManifestV2(value);
  }
  throw builtInClosureMismatch();
}

function verifyClosureManifestV2(
  value: Record<string, unknown>,
): BuiltInClosureManifestV2 {
  if (
    !hasExactKeys(value, [
      'entrypoint',
      'files',
      'kind',
      'packages',
      'scope',
    ]) ||
    value.kind !== 'built-in-engine-closure-manifest.v2' ||
    value.entrypoint !== 'src/entrypoints/cli/workflow-cli.ts' ||
    value.scope !== 'workspace-runtime-source-closure' ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    throw builtInClosureMismatch();
  }

  const packages: BuiltInClosurePackageV2[] = [];
  for (const descriptor of value.packages) {
    if (
      !isRecord(descriptor) ||
      !hasExactKeys(descriptor, ['closureRoot', 'name', 'sourceRoot']) ||
      !safeWorkspacePackageName(descriptor.name) ||
      !safeClosurePath(descriptor.sourceRoot) ||
      !String(descriptor.sourceRoot).startsWith('packages/') ||
      String(descriptor.sourceRoot).split('/').length !== 2 ||
      (descriptor.closureRoot !== '.' &&
        !safeClosurePath(descriptor.closureRoot))
    ) {
      throw builtInClosureMismatch();
    }
    const name = String(descriptor.name);
    const sourceRoot = String(descriptor.sourceRoot);
    const closureRoot = String(descriptor.closureRoot);
    if (
      (name === 'jigwright' &&
        (sourceRoot !== 'packages/workflow-engine' || closureRoot !== '.')) ||
      (name !== 'jigwright' &&
        (!name.startsWith('@jigwright/') ||
          closureRoot !== `node_modules/${name}`))
    ) {
      throw builtInClosureMismatch();
    }
    packages.push({ name, sourceRoot, closureRoot });
  }
  const packageOrder = packages.map((entry) => entry.closureRoot);
  if (
    canonicalJson(packageOrder) !==
      canonicalJson(
        [...new Set(packageOrder)].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ) ||
    new Set(packages.map((entry) => entry.name)).size !== packages.length ||
    new Set(packages.map((entry) => entry.sourceRoot)).size !==
      packages.length ||
    packages.filter((entry) => entry.closureRoot === '.').length !== 1
  ) {
    throw builtInClosureMismatch();
  }

  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['digest', 'mode', 'path']) ||
      !safeClosurePath(entry.path) ||
      closurePackageForPath(packages, String(entry.path)) === null ||
      (entry.mode !== '100644' && entry.mode !== '100755') ||
      !isDigest(entry.digest)
    ) {
      throw builtInClosureMismatch();
    }
  }
  const filePaths = value.files.map((entry) => String(entry.path));
  const sortedPaths = [...new Set(filePaths)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const rootEntrypoint = String(value.entrypoint);
  if (
    canonicalJson(filePaths) !== canonicalJson(sortedPaths) ||
    !filePaths.includes(rootEntrypoint) ||
    packages.some(
      (descriptor) =>
        !filePaths.includes(
          descriptor.closureRoot === '.'
            ? 'package.json'
            : `${descriptor.closureRoot}/package.json`,
        ),
    )
  ) {
    throw builtInClosureMismatch();
  }
  return value as unknown as BuiltInClosureManifestV2;
}

function safeWorkspacePackageName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === 'jigwright' || /^@jigwright\/[a-z0-9][a-z0-9._-]*$/.test(value))
  );
}

function closurePackageForPath(
  packages: BuiltInClosurePackageV2[],
  artifactPath: string,
): { descriptor: BuiltInClosurePackageV2; relativePath: string } | null {
  const matches = packages.flatMap((descriptor) => {
    const relativePath =
      descriptor.closureRoot === '.'
        ? artifactPath
        : artifactPath.startsWith(`${descriptor.closureRoot}/`)
          ? artifactPath.slice(descriptor.closureRoot.length + 1)
          : null;
    if (
      relativePath === null ||
      (relativePath !== 'package.json' &&
        !(relativePath.startsWith('src/') && relativePath.endsWith('.ts')))
    ) {
      return [];
    }
    return [{ descriptor, relativePath }];
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function closureRepositoryPath(
  manifest: BuiltInClosureManifest,
  artifactPath: string,
): string {
  const match = closurePackageForPath(manifest.packages, artifactPath);
  if (match === null) throw builtInClosureMismatch();
  return `${match.descriptor.sourceRoot}/${match.relativePath}`;
}

function repositoryRootForWorkspaceClosure(packageRoot: string): string {
  const repositoryRoot = path.dirname(path.dirname(packageRoot));
  const stats = fs.lstatSync(repositoryRoot, { throwIfNoEntry: false });
  if (
    packageRoot !== path.join(repositoryRoot, 'packages', 'workflow-engine') ||
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(repositoryRoot) !== repositoryRoot
  ) {
    throw builtInClosureMismatch();
  }
  return repositoryRoot;
}

function assertLiveClosureInventory(
  packageRoot: string,
  manifest: BuiltInClosureManifest,
): void {
  const repositoryRoot = repositoryRootForWorkspaceClosure(packageRoot);
  const observed = manifest.packages
    .flatMap((descriptor) => {
      const sourcePackageRoot = path.join(
        repositoryRoot,
        ...descriptor.sourceRoot.split('/'),
      );
      const stats = fs.lstatSync(sourcePackageRoot, {
        throwIfNoEntry: false,
      });
      if (
        !stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(sourcePackageRoot) !== sourcePackageRoot
      ) {
        throw builtInClosureMismatch();
      }
      return [
        'package.json',
        ...listPackageTypescriptFiles(
          sourcePackageRoot,
          path.join(sourcePackageRoot, 'src'),
        ),
      ].map((relativePath) =>
        descriptor.closureRoot === '.'
          ? relativePath
          : `${descriptor.closureRoot}/${relativePath}`,
      );
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    canonicalJson(observed) !==
    canonicalJson(manifest.files.map((entry) => entry.path))
  ) {
    throw builtInClosureMismatch();
  }
}

export function assertWorkspaceDependencyClosure(
  manifest: BuiltInClosureManifest,
  files: VerifiedBuiltInEngineClosure['files'],
): void {
  const byName = new Map(
    manifest.packages.map((descriptor) => [descriptor.name, descriptor]),
  );
  const dependencies = new Map<string, string[]>();
  for (const descriptor of manifest.packages) {
    const artifactPath =
      descriptor.closureRoot === '.'
        ? 'package.json'
        : `${descriptor.closureRoot}/package.json`;
    const packageFile = files.find((entry) => entry.path === artifactPath);
    let packageManifest: unknown;
    try {
      packageManifest = JSON.parse(packageFile?.bytes.toString('utf8') ?? '');
    } catch {
      throw builtInClosureMismatch();
    }
    if (
      !isRecord(packageManifest) ||
      packageManifest.name !== descriptor.name
    ) {
      throw builtInClosureMismatch();
    }
    const packageDependencies = new Set<string>();
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const declared = packageManifest[field];
      if (declared === undefined) continue;
      if (!isRecord(declared)) throw builtInClosureMismatch();
      for (const [dependencyName, specification] of Object.entries(declared)) {
        if (
          !dependencyName.startsWith('@jigwright/') ||
          specification !== 'workspace:*' ||
          !byName.has(dependencyName) ||
          packageDependencies.has(dependencyName)
        ) {
          throw builtInClosureMismatch();
        }
        packageDependencies.add(dependencyName);
      }
    }
    dependencies.set(descriptor.name, [...packageDependencies]);
  }

  const reachable = new Set<string>();
  const visiting = new Set<string>();
  const visit = (packageName: string): void => {
    if (visiting.has(packageName)) throw builtInClosureMismatch();
    if (reachable.has(packageName)) return;
    visiting.add(packageName);
    for (const dependency of dependencies.get(packageName) ?? []) {
      visit(dependency);
    }
    visiting.delete(packageName);
    reachable.add(packageName);
  };
  visit('jigwright');
  if (reachable.size !== manifest.packages.length) {
    throw builtInClosureMismatch();
  }
}

function listPackageTypescriptFiles(
  packageRoot: string,
  directory: string,
): string[] {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  ) {
    throw builtInClosureMismatch();
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw builtInClosureMismatch();
    if (entry.isDirectory()) {
      files.push(...listPackageTypescriptFiles(packageRoot, absolute));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      // macOS may materialize extended attributes as AppleDouble sidecars
      // during npm tarball extraction. They are metadata, not source files,
      // and must not change the authenticated TypeScript closure inventory.
      !entry.name.startsWith('._')
    ) {
      const relative = path.relative(packageRoot, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw builtInClosureMismatch();
      }
      files.push(relative.split(path.sep).join('/'));
    }
  }
  return files.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}
