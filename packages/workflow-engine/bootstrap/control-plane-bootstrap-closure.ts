/** Pinned workspace source closure validation and materialized artifact verification. */
import fs from 'node:fs';
import path from 'node:path';
import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from './built-in-engine-closure-pin.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  bootstrapArtifactMismatch,
  deepFreeze,
  rawDigest,
  builtInClosureMismatch,
  bootstrapPackageRootInvalid,
  BUILT_IN_PROTOCOL_VERSION,
  BUILT_IN_SESSION_SCHEMA,
  BUILT_IN_POLICY_SCHEMA_VERSION,
  canonicalDigest,
  PRIVATE_FILE_MODE,
  PRIVATE_EXECUTABLE_MODE,
  MAX_STATE_BYTES,
  MAX_CLOSURE_FILE_BYTES,
  MAX_EXECUTABLE_BYTES,
  isRecord,
  hasExactKeys,
  isNonEmptyTrimmed,
  isDigest,
  supervisorNotTerminal,
  safeClosurePath,
} from './control-plane-bootstrap-values.ts';
import type {
  BootstrapControlPlaneEngineArtifact,
  VerifiedBuiltInEngineClosure,
  InitialSupervisorProvenance,
  Sha256Digest,
  BootstrapPaths,
  VerifiedProtectedCapabilityManifest,
  BootstrapControlPlaneSupervisorState,
  BuiltInClosureManifest,
  BuiltInClosureManifestV2,
  BuiltInClosurePackageV2,
  BootstrapProtectedTreeEntry,
} from './control-plane-bootstrap-types.ts';
import {
  bootstrapPaths,
  assertPrivateDirectory,
  readSupervisor,
  assertExactPackageRoot,
  readClosureFile,
  ensurePrivateArtifactDirectory,
  publishExactPrivateFile,
  ensurePrivateDescendantDirectories,
  readExactPrivateFile,
  listPrivateClosureFiles,
  readCanonicalPrivateRecord,
} from './control-plane-bootstrap-files.ts';
import {
  readBootstrapHeadTree,
  readBootstrapGitBlob,
} from './control-plane-bootstrap-provenance.ts';
import {
  validEngineArtifactV2,
  canonicalBase64Bytes,
} from './control-plane-bootstrap-promotion-records.ts';
import { builtInSupervisorExecutableSource } from './control-plane-bootstrap-executable.ts';

/** Read the exact full EngineArtifact needed by a first recovery bundle. */
export function readBuiltInControlPlaneEngineArtifact(
  storageRoot: string,
): BootstrapControlPlaneEngineArtifact {
  const paths = bootstrapPaths(storageRoot);
  assertPrivateDirectory(paths.root, 'CONTROL_PLANE_STATE_UNSAFE');
  const supervisor = readSupervisor(paths);
  const artifact = readBuiltInEngineArtifactRecord(
    path.join(
      paths.artifacts,
      supervisor.activeArtifact.artifactId.slice('sha256:'.length),
      'engine-artifact.json',
    ),
  );
  if (
    artifact.artifactId !== supervisor.activeArtifact.artifactId ||
    artifact.executableDigest !== supervisor.activeArtifact.executableDigest
  ) {
    throw bootstrapArtifactMismatch();
  }
  return deepFreeze(structuredClone(artifact));
}

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

export function assertBuiltInClosureTrackedAtProvenance(
  worktreeRoot: string,
  provenance: InitialSupervisorProvenance,
  closure: VerifiedBuiltInEngineClosure,
): void {
  const tree = readBootstrapHeadTree(worktreeRoot, provenance.headOid);
  const expected = [
    {
      path: 'bootstrap/built-in-engine-closure.json',
      mode: '100644' as const,
      bytes: closure.manifestBytes,
    },
    ...closure.files.map(({ path: filePath, mode, bytes }) => ({
      path: closureRepositoryPath(closure.manifest, filePath),
      mode,
      bytes,
    })),
  ];
  for (const entry of expected) {
    const repositoryPath =
      entry.path === 'bootstrap/built-in-engine-closure.json'
        ? `packages/workflow-engine/${entry.path}`
        : entry.path;
    const tracked = tree.find((candidate) => candidate.path === repositoryPath);
    if (
      tracked?.type !== 'blob' ||
      tracked.mode !== entry.mode ||
      !readBootstrapGitBlob(
        worktreeRoot,
        provenance.headOid,
        repositoryPath,
      ).equals(entry.bytes)
    ) {
      throw bootstrapPackageRootInvalid();
    }
  }
  assertTrackedClosureInventory(closure.manifest, tree);
}

export function createBuiltInControlPlaneEngineArtifact(
  sourceDigest: Sha256Digest,
  controlPlaneClosureDigest: Sha256Digest,
  executableDigest: Sha256Digest,
): BootstrapControlPlaneEngineArtifact {
  const selfTest = {
    kind: 'control-plane-self-test.v1',
    healthy: true,
    closureDigest: controlPlaneClosureDigest,
  };
  const payload = {
    kind: 'engine-artifact.v1' as const,
    sourceChangeId: 'repository-default-built-in',
    sourceDigest,
    executableDigest,
    protocolVersion: BUILT_IN_PROTOCOL_VERSION,
    canReadSessionSchemas: [BUILT_IN_SESSION_SCHEMA],
    writesSessionSchema: BUILT_IN_SESSION_SCHEMA,
    policySchemaVersion: BUILT_IN_POLICY_SCHEMA_VERSION,
    smokeReportDigest: canonicalDigest(selfTest),
  };
  return { ...payload, artifactId: canonicalDigest(payload) };
}

export function materializeBuiltInClosure(
  paths: BootstrapPaths,
  closure: VerifiedBuiltInEngineClosure,
  protectedManifest: VerifiedProtectedCapabilityManifest,
  artifact: BootstrapControlPlaneEngineArtifact,
  executableBytes: Buffer,
): void {
  const artifactDirectory = path.join(
    paths.artifacts,
    artifact.artifactId.slice('sha256:'.length),
  );
  const closureDirectory = path.join(artifactDirectory, 'closure');
  ensurePrivateArtifactDirectory(paths.artifacts);
  ensurePrivateArtifactDirectory(artifactDirectory);
  ensurePrivateArtifactDirectory(closureDirectory);
  publishExactPrivateFile(
    path.join(artifactDirectory, 'built-in-engine-closure.json'),
    closure.manifestBytes,
    PRIVATE_FILE_MODE,
    bootstrapArtifactMismatch,
  );
  for (const entry of closure.files) {
    const target = path.join(closureDirectory, ...entry.path.split('/'));
    ensurePrivateDescendantDirectories(closureDirectory, path.dirname(target));
    publishExactPrivateFile(
      target,
      entry.bytes,
      PRIVATE_FILE_MODE,
      bootstrapArtifactMismatch,
    );
  }
  for (const entry of protectedManifest.bootstrapRuntimeFiles) {
    const target = path.join(closureDirectory, ...entry.path.split('/'));
    ensurePrivateDescendantDirectories(closureDirectory, path.dirname(target));
    publishExactPrivateFile(
      target,
      entry.bytes,
      PRIVATE_FILE_MODE,
      bootstrapArtifactMismatch,
    );
  }
  publishExactPrivateFile(
    path.join(artifactDirectory, 'engine-artifact.json'),
    `${canonicalJson(artifact)}\n`,
    PRIVATE_FILE_MODE,
    bootstrapArtifactMismatch,
  );
  publishExactPrivateFile(
    path.join(artifactDirectory, 'engine'),
    executableBytes,
    PRIVATE_EXECUTABLE_MODE,
    bootstrapArtifactMismatch,
  );
  assertMaterializedBuiltInClosure(
    paths,
    closure,
    protectedManifest.bootstrapRuntimeFiles,
    artifact,
    executableBytes,
  );
}

export function assertMaterializedBuiltInClosure(
  paths: BootstrapPaths,
  closure: VerifiedBuiltInEngineClosure,
  bootstrapRuntimeFiles: VerifiedProtectedCapabilityManifest['bootstrapRuntimeFiles'],
  artifact: BootstrapControlPlaneEngineArtifact,
  executableBytes: Buffer,
): void {
  assertPrivateDirectory(
    paths.artifacts,
    'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE',
  );
  const artifactDirectory = path.join(
    paths.artifacts,
    artifact.artifactId.slice('sha256:'.length),
  );
  const closureDirectory = path.join(artifactDirectory, 'closure');
  assertPrivateDirectory(
    artifactDirectory,
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
  );
  assertPrivateDirectory(
    closureDirectory,
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
  );
  const topLevel = fs.readdirSync(artifactDirectory).sort();
  if (
    canonicalJson(topLevel) !==
    canonicalJson(
      [
        'built-in-engine-closure.json',
        'closure',
        'engine',
        'engine-artifact.json',
      ].sort(),
    )
  ) {
    throw bootstrapArtifactMismatch();
  }
  const manifestBytes = readExactPrivateFile(
    path.join(artifactDirectory, 'built-in-engine-closure.json'),
    PRIVATE_FILE_MODE,
    MAX_STATE_BYTES,
  );
  if (!manifestBytes.equals(closure.manifestBytes)) {
    throw bootstrapArtifactMismatch();
  }
  const observedFiles = listPrivateClosureFiles(closureDirectory);
  const expectedFiles = [
    ...closure.manifest.files.map((entry) => entry.path),
    ...bootstrapRuntimeFiles.map((entry) => entry.path),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (canonicalJson(observedFiles) !== canonicalJson(expectedFiles)) {
    throw bootstrapArtifactMismatch();
  }
  for (const entry of closure.manifest.files) {
    const copiedBytes = readExactPrivateFile(
      path.join(closureDirectory, ...entry.path.split('/')),
      PRIVATE_FILE_MODE,
      MAX_CLOSURE_FILE_BYTES,
    );
    if (rawDigest(copiedBytes) !== entry.digest) {
      throw bootstrapArtifactMismatch();
    }
  }
  for (const entry of bootstrapRuntimeFiles) {
    const copiedBytes = readExactPrivateFile(
      path.join(closureDirectory, ...entry.path.split('/')),
      PRIVATE_FILE_MODE,
      MAX_CLOSURE_FILE_BYTES,
    );
    if (rawDigest(copiedBytes) !== entry.digest) {
      throw bootstrapArtifactMismatch();
    }
  }
  const persistedArtifact = readBuiltInEngineArtifactRecord(
    path.join(artifactDirectory, 'engine-artifact.json'),
  );
  if (canonicalJson(persistedArtifact) !== canonicalJson(artifact)) {
    throw bootstrapArtifactMismatch();
  }
  const persistedExecutable = readExactPrivateFile(
    path.join(artifactDirectory, 'engine'),
    PRIVATE_EXECUTABLE_MODE,
    MAX_EXECUTABLE_BYTES,
  );
  if (!persistedExecutable.equals(executableBytes)) {
    throw bootstrapArtifactMismatch();
  }
}

export function assertBuiltInControlPlaneEngineArtifact(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
  artifact: BootstrapControlPlaneEngineArtifact,
  closure: VerifiedBuiltInEngineClosure,
  protectedManifest: VerifiedProtectedCapabilityManifest,
): void {
  const executableBytes = Buffer.from(
    builtInSupervisorExecutableSource(
      closure.manifestDigest,
      supervisor.activeArtifact.closureDigest,
      closure.manifest,
      protectedManifest.bootstrapRuntimeFiles,
    ),
  );
  assertMaterializedBuiltInClosure(
    paths,
    closure,
    protectedManifest.bootstrapRuntimeFiles,
    artifact,
    executableBytes,
  );
}

function readBuiltInEngineArtifactRecord(
  filePath: string,
): BootstrapControlPlaneEngineArtifact {
  const value = readCanonicalPrivateRecord(filePath, bootstrapArtifactMismatch);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactId',
      'canReadSessionSchemas',
      'executableDigest',
      'kind',
      'policySchemaVersion',
      'protocolVersion',
      'smokeReportDigest',
      'sourceChangeId',
      'sourceDigest',
      'writesSessionSchema',
    ]) ||
    value.kind !== 'engine-artifact.v1' ||
    !isNonEmptyTrimmed(value.sourceChangeId) ||
    !isDigest(value.sourceDigest) ||
    !isDigest(value.executableDigest) ||
    !Number.isSafeInteger(value.protocolVersion) ||
    Number(value.protocolVersion) < 1 ||
    !Array.isArray(value.canReadSessionSchemas) ||
    !value.canReadSessionSchemas.every(isNonEmptyTrimmed) ||
    canonicalJson(value.canReadSessionSchemas) !==
      canonicalJson(
        [...new Set(value.canReadSessionSchemas)].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ) ||
    !isNonEmptyTrimmed(value.writesSessionSchema) ||
    !value.canReadSessionSchemas.includes(value.writesSessionSchema) ||
    !Number.isSafeInteger(value.policySchemaVersion) ||
    Number(value.policySchemaVersion) < 1 ||
    !isDigest(value.smokeReportDigest) ||
    !isDigest(value.artifactId)
  ) {
    throw bootstrapArtifactMismatch();
  }
  const { artifactId, ...payload } = value;
  if (artifactId !== canonicalDigest(payload))
    throw bootstrapArtifactMismatch();
  return value as unknown as BootstrapControlPlaneEngineArtifact;
}

export function assertMaterializedPromotionArtifact(
  paths: BootstrapPaths,
  artifact: Record<string, unknown>,
  executableBase64: unknown,
): void {
  if (!validEngineArtifactV2(artifact)) throw supervisorNotTerminal();
  const bytes = canonicalBase64Bytes(
    executableBase64,
    MAX_EXECUTABLE_BYTES,
    false,
  );
  const executablePath = path.join(
    paths.artifacts,
    artifact.artifactId.slice('sha256:'.length),
    'engine',
  );
  const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
  if (
    bytes === null ||
    rawDigest(bytes) !== artifact.executableDigest ||
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
    stats.size !== bytes.length ||
    fs.realpathSync(executablePath) !== executablePath
  ) {
    throw supervisorNotTerminal();
  }
  const descriptor = fs.openSync(
    executablePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const observed = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      !observed.equals(bytes)
    ) {
      throw supervisorNotTerminal();
    }
  } finally {
    fs.closeSync(descriptor);
  }
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

export function assertTrackedClosureInventory(
  manifest: BuiltInClosureManifest,
  tree: BootstrapProtectedTreeEntry[],
): void {
  const observed = manifest.packages
    .flatMap((descriptor) => {
      const packageJson = `${descriptor.sourceRoot}/package.json`;
      const sourcePrefix = `${descriptor.sourceRoot}/src/`;
      return tree
        .map((entry) => entry.path)
        .filter(
          (entryPath) =>
            entryPath === packageJson ||
            (entryPath.startsWith(sourcePrefix) && entryPath.endsWith('.ts')),
        );
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const expected = manifest.files
    .map((entry) => closureRepositoryPath(manifest, entry.path))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (canonicalJson(observed) !== canonicalJson(expected)) {
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
