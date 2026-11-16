/**
 * Publishes private maintainer grant files and reconciles their state directories.
 *
 * Invariants:
 * - Create and replace retain distinct publication and fsync semantics.
 * - Directory inventory and exact grant paths preserve the existing state checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertMaintainerGrantId } from '../../modules/authority/maintainer-grant-contracts.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import {
  isNodeError,
  unavailableGrant,
  unsafeStore,
} from './maintainer-grant-values.ts';

export function maintainerGrantStorePaths(gitCommonDirectory: string) {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  const root = path.join(runtime.root, 'maintainer-grants');
  return {
    runtime,
    root,
    available: path.join(root, 'available'),
    reserved: path.join(root, 'reserved'),
    terminal: path.join(root, 'terminal'),
    journals: path.join(root, 'journals'),
    sessions: path.join(root, 'sessions'),
  };
}

export function ensureStoreDirectories(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
): void {
  for (const directory of [
    paths.root,
    paths.available,
    paths.reserved,
    paths.terminal,
    paths.journals,
    paths.sessions,
  ]) {
    const existed = fs.existsSync(directory);
    ensurePlainDirectory(directory);
    fs.chmodSync(directory, 0o700);
    if ((fs.statSync(directory).mode & 0o777) !== 0o700) {
      throw unsafeStore();
    }
    if (!existed) {
      fsyncDirectory(path.dirname(directory));
    }
  }
}

export function existingStateDirectories(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
): Array<{ directory: string }> {
  const directories = [paths.available, paths.reserved, paths.terminal];
  return directories.flatMap((directory) => {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats) {
      return [];
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory) ||
      (stats.mode & 0o777) !== 0o700
    ) {
      throw unsafeStore();
    }
    return [{ directory }];
  });
}

export function assertNoGrantState(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
  grantId: string,
): void {
  if (
    [paths.available, paths.reserved, paths.terminal].some((directory) =>
      fs.existsSync(grantPath(directory, grantId)),
    )
  ) {
    throw unavailableGrant(grantId);
  }
}

export function listGrantIds(directory: string): string[] {
  return fs.readdirSync(directory).map((entry) => {
    if (!entry.endsWith('.json')) {
      throw unsafeStore();
    }
    return assertMaintainerGrantId(entry.slice(0, -'.json'.length));
  });
}

export function grantPath(directory: string, grantId: string): string {
  return path.join(directory, `${assertMaintainerGrantId(grantId)}.json`);
}

export function createPrivateFileAtomic(
  filePath: string,
  content: string,
): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw unavailableGrant(path.basename(filePath, '.json'));
    }
    throw error;
  }
}

export function replacePrivateFileAtomic(
  filePath: string,
  content: string,
): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function readPrivateFile(filePath: string): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw unsafeStore();
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
