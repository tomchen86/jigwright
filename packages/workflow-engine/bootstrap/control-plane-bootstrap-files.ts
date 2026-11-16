/** Exact private filesystem reads/publication and confined executable validation. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import type { BootstrapPaths } from './control-plane-bootstrap-types.ts';
import {
  MAX_CLOSURE_FILE_BYTES,
  MAX_STATE_BYTES,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  builtInClosureMismatch,
  localBindingMismatch,
  trustError,
} from './control-plane-bootstrap-values.ts';

/** Derive the intervention store without reading retired engine state. */
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
    checkpoints: path.join(storageRoot, 'checkpoints'),
    interventions: path.join(storageRoot, 'interventions'),
  };
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
  corrupt: () => Error,
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
