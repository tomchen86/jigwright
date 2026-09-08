/** Exact private filesystem reads/publication and confined executable validation. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import {
  trustError,
  PRIVATE_DIRECTORY_MODE,
  bootstrapArtifactMismatch,
  isRecord,
  hasExactKeys,
  verifyRecordDigest,
  supervisorCorrupt,
  isNonEmptyTrimmed,
  isDigest,
  isCanonicalIso,
  validTransition,
  PRIVATE_EXECUTABLE_MODE,
  MAX_EXECUTABLE_BYTES,
  rawDigest,
  MAX_CLOSURE_FILE_BYTES,
  builtInClosureMismatch,
  MAX_STATE_BYTES,
  PRIVATE_FILE_MODE,
  localBindingMismatch,
} from './control-plane-bootstrap-values.ts';
import type {
  BootstrapPaths,
  BootstrapControlPlaneSupervisorState,
} from './control-plane-bootstrap-types.ts';

/** Derive the updater state location without consulting the swappable engine. */
export function bootstrapInterventionStateRoot(
  gitCommonDirectory: string,
): string {
  if (
    typeof gitCommonDirectory !== 'string' ||
    !path.isAbsolute(gitCommonDirectory) ||
    path.resolve(gitCommonDirectory) !== gitCommonDirectory ||
    fs.realpathSync(gitCommonDirectory) !== gitCommonDirectory
  ) {
    throw trustError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNSAFE',
      'Git common directory is not an exact real path.',
      12,
    );
  }
  return path.join(
    gitCommonDirectory,
    'workflow-engine',
    'intervention-control',
  );
}

export function bootstrapPaths(storageRoot: string): BootstrapPaths {
  if (
    typeof storageRoot !== 'string' ||
    !path.isAbsolute(storageRoot) ||
    path.resolve(storageRoot) !== storageRoot ||
    storageRoot === path.parse(storageRoot).root
  ) {
    throw trustError(
      'CONTROL_PLANE_STATE_ROOT_INVALID',
      'Control-plane state root must be an exact absolute path.',
      12,
    );
  }
  return {
    root: storageRoot,
    supervisor: path.join(storageRoot, 'control-plane-supervisor.json'),
    initialBootstrapJournal: path.join(
      storageRoot,
      'initial-supervisor-bootstrap',
    ),
    bundles: path.join(storageRoot, 'control-plane-promotion-bundles'),
    artifacts: path.join(storageRoot, 'control-plane-artifacts'),
    approvalCandidates: path.join(
      storageRoot,
      'control-plane-approval-candidates',
    ),
    controlUpdates: path.join(storageRoot, 'control-updates'),
    supervisorHistory: path.join(
      storageRoot,
      'control-plane-supervisor-history',
    ),
    checkpoints: path.join(storageRoot, 'checkpoints'),
    interventions: path.join(storageRoot, 'interventions'),
    sidecarSessions: path.join(storageRoot, 'sidecar-sessions'),
    adoptions: path.join(storageRoot, 'adoptions'),
    operations: path.join(storageRoot, 'operations'),
    localSessions: path.join(storageRoot, 'local-parent-sessions'),
    localArtifacts: path.join(storageRoot, 'local-engine-artifacts'),
  };
}

export function ensurePrivateArtifactDirectory(directory: string): void {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing === undefined) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch {
      throw bootstrapArtifactMismatch();
    }
    fsyncDirectory(path.dirname(directory));
  }
  assertPrivateDirectory(
    directory,
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
  );
}

export function ensurePrivateDescendantDirectories(
  root: string,
  target: string,
): void {
  const relative = path.relative(root, target);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw bootstrapArtifactMismatch();
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined) ensurePrivateArtifactDirectory(current);
    else
      assertPrivateDirectory(
        current,
        'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
      );
  }
}

export function publishExactPrivateFile(
  filePath: string,
  content: string | Buffer,
  mode: number,
  corrupt: () => Error,
): void {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const pendingPath = `${filePath}.pending`;
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const pending = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (pending !== undefined) throw corrupt();
    let observed: Buffer;
    try {
      observed = readExactPrivateFile(
        filePath,
        mode,
        Math.max(bytes.length, 1),
      );
    } catch {
      throw corrupt();
    }
    if (!observed.equals(bytes)) throw corrupt();
    return;
  }
  if (pending !== undefined) {
    let observed: Buffer;
    try {
      observed = readExactPrivateFile(
        pendingPath,
        mode,
        Math.max(bytes.length, 1),
      );
    } catch {
      throw corrupt();
    }
    if (!observed.equals(bytes)) throw corrupt();
    try {
      fs.renameSync(pendingPath, filePath);
      fsyncDirectory(path.dirname(filePath));
    } catch {
      throw corrupt();
    }
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      pendingPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      mode,
    );
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== mode ||
      opened.size !== bytes.length
    ) {
      throw corrupt();
    }
  } catch {
    throw corrupt();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(pendingPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch {
    throw corrupt();
  }
}

export function readExactPrivateFile(
  filePath: string,
  mode: number,
  maximumBytes: number,
): Buffer {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== mode ||
    stats.size < 1 ||
    stats.size > maximumBytes ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw bootstrapArtifactMismatch();
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      bytes.length !== stats.size
    ) {
      throw bootstrapArtifactMismatch();
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function listPrivateClosureFiles(
  directory: string,
  root = directory,
): string[] {
  assertPrivateDirectory(
    directory,
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
  );
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw bootstrapArtifactMismatch();
    if (entry.isDirectory()) {
      files.push(...listPrivateClosureFiles(absolute, root));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    } else {
      throw bootstrapArtifactMismatch();
    }
  }
  return files.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readSupervisor(
  paths: BootstrapPaths,
): BootstrapControlPlaneSupervisorState {
  const value = readCanonicalPrivateRecord(paths.supervisor);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'activeArtifact',
      'generation',
      'kind',
      'recordDigest',
      'repositoryId',
      'transition',
      'updatedAt',
    ]) ||
    value.kind !== 'control-plane-supervisor-state.v1' ||
    !verifyRecordDigest(value)
  ) {
    throw supervisorCorrupt();
  }
  const state = value as unknown as BootstrapControlPlaneSupervisorState;
  if (
    !isNonEmptyTrimmed(state.repositoryId) ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    !isRecord(state.activeArtifact) ||
    !hasExactKeys(state.activeArtifact, [
      'artifactId',
      'closureDigest',
      'executableDigest',
      'executablePath',
    ]) ||
    !isDigest(state.activeArtifact.artifactId) ||
    !isDigest(state.activeArtifact.executableDigest) ||
    !isDigest(state.activeArtifact.closureDigest) ||
    !isCanonicalIso(state.updatedAt) ||
    !validTransition(state.transition)
  ) {
    throw supervisorCorrupt();
  }
  assertConfinedExecutable(paths, state);
  return state;
}

export function assertConfinedExecutable(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
): void {
  const active = supervisor.activeArtifact;
  const executablePath = active.executablePath;
  const expectedPath = path.join(
    paths.artifacts,
    active.artifactId.slice('sha256:'.length),
    'engine',
  );
  if (
    typeof executablePath !== 'string' ||
    !path.isAbsolute(executablePath) ||
    path.resolve(executablePath) !== executablePath ||
    executablePath !== expectedPath
  ) {
    throw supervisorCorrupt();
  }
  assertPrivateDirectory(paths.artifacts, 'CONTROL_PLANE_STATE_UNSAFE');
  assertPrivateDirectory(
    path.dirname(executablePath),
    'CONTROL_PLANE_STATE_UNSAFE',
  );
  const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
    stats.size < 1 ||
    stats.size > MAX_EXECUTABLE_BYTES ||
    fs.realpathSync(executablePath) !== executablePath
  ) {
    throw trustError(
      'CONTROL_PLANE_EXECUTABLE_UNSAFE',
      'Materialized control-plane executable is unsafe.',
      12,
    );
  }
  const descriptor = fs.openSync(
    executablePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      rawDigest(bytes) !== active.executableDigest
    ) {
      throw trustError(
        'CONTROL_PLANE_EXECUTABLE_DIGEST_MISMATCH',
        'Materialized control-plane executable digest changed.',
        13,
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readClosureFile(
  filePath: string,
  expectedMode: number,
): Buffer {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== expectedMode ||
    stats.size < 1 ||
    stats.size > MAX_CLOSURE_FILE_BYTES ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw builtInClosureMismatch();
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      bytes.length !== stats.size
    ) {
      throw builtInClosureMismatch();
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readCanonicalPrivateRecord(
  filePath: string,
  corrupt: () => Error = supervisorCorrupt,
  maxBytes = MAX_STATE_BYTES,
): unknown {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    stats.size < 1 ||
    stats.size > maxBytes ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw corrupt();
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const raw = fs.readFileSync(descriptor, 'utf8');
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      Buffer.byteLength(raw) !== stats.size
    ) {
      throw corrupt();
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw corrupt();
    }
    if (`${canonicalJson(value)}\n` !== raw) throw corrupt();
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertPrivateDirectory(directory: string, code: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    fs.realpathSync(directory) !== directory
  ) {
    throw trustError(
      code,
      'Control-plane state directory is missing, indirect, or unsafe.',
      12,
    );
  }
}

export function assertExactPackageRoot(packageRoot: string): void {
  const stats = fs.lstatSync(packageRoot, { throwIfNoEntry: false });
  if (
    typeof packageRoot !== 'string' ||
    !path.isAbsolute(packageRoot) ||
    path.resolve(packageRoot) !== packageRoot ||
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(packageRoot) !== packageRoot
  ) {
    throw builtInClosureMismatch();
  }
}

export function assertExactWorktreeRoot(worktreeRoot: string): void {
  const stats = fs.lstatSync(worktreeRoot, { throwIfNoEntry: false });
  if (
    typeof worktreeRoot !== 'string' ||
    !path.isAbsolute(worktreeRoot) ||
    path.resolve(worktreeRoot) !== worktreeRoot ||
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(worktreeRoot) !== worktreeRoot
  ) {
    throw localBindingMismatch();
  }
}
