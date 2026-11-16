/**
 * Publishes and inspects private collaboration grant directories and state files.
 *
 * Invariants:
 * - No-overwrite creation and replacement keep their distinct link, rename, and fsync sequences.
 * - Read-only inspection never creates directories and rejects unsafe file or directory metadata.
 */
import { runtimePaths } from '../session-workspace/workflow-session-records.ts';
import path from 'node:path';
import fs from 'node:fs';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import {
  unsafeStore,
  STATE_FILE,
  unavailableGrant,
  ambiguousGrant,
  isNodeError,
} from '../../modules/authority/collaboration-grant-values.ts';
import { assertCollaborationGrantId } from '../../modules/authority/collaboration-grant-codec.ts';

export function collaborationGrantStorePaths(gitCommonDirectory: string) {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  const root = path.join(runtime.root, 'collaboration-grants');
  return {
    runtime,
    root,
    available: path.join(root, 'available'),
    reserved: path.join(root, 'reserved'),
    terminal: path.join(root, 'terminal'),
    revocationAuthorizations: path.join(root, 'revocation-authorizations'),
  };
}

export function ensureStoreDirectories(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
): void {
  for (const directory of [
    paths.root,
    paths.available,
    paths.reserved,
    paths.terminal,
    paths.revocationAuthorizations,
  ]) {
    const existed = fs.existsSync(directory);
    ensurePlainDirectory(directory);
    fs.chmodSync(directory, 0o700);
    const stats = fs.lstatSync(directory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory) ||
      (stats.mode & 0o777) !== 0o700
    ) {
      throw unsafeStore();
    }
    if (!existed) {
      fsyncDirectory(path.dirname(directory));
    }
    if (directory !== paths.root) {
      for (const entry of fs.readdirSync(directory)) {
        if (!STATE_FILE.test(entry)) {
          throw unsafeStore();
        }
      }
    }
  }
}

export function existingStateDirectories(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
): Array<{ directory: string }> {
  return [paths.available, paths.reserved, paths.terminal].flatMap(
    (directory) => {
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
    },
  );
}

export function assertExistingStoreReadOnlySafe(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
): boolean {
  const rootStats = fs.lstatSync(paths.root, { throwIfNoEntry: false });
  if (!rootStats) return false;
  assertExistingPrivateDirectory(paths.root, rootStats);
  const allowed = new Set([
    path.basename(paths.available),
    path.basename(paths.reserved),
    path.basename(paths.terminal),
    path.basename(paths.revocationAuthorizations),
  ]);
  for (const entry of fs.readdirSync(paths.root)) {
    if (!allowed.has(entry)) throw unsafeStore();
    const directory = path.join(paths.root, entry);
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats) throw unsafeStore();
    assertExistingPrivateDirectory(directory, stats);
    for (const name of fs.readdirSync(directory)) {
      if (!STATE_FILE.test(name)) throw unsafeStore();
      const filePath = path.join(directory, name);
      const fileStats = fs.lstatSync(filePath, { throwIfNoEntry: false });
      if (
        !fileStats ||
        !fileStats.isFile() ||
        fileStats.isSymbolicLink() ||
        fileStats.nlink !== 1 ||
        (fileStats.mode & 0o777) !== 0o600
      ) {
        throw unsafeStore();
      }
    }
  }
  return true;
}

function assertExistingPrivateDirectory(
  directory: string,
  stats: fs.Stats,
): void {
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(directory) !== path.resolve(directory) ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw unsafeStore();
  }
}

export function assertNoState(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
): void {
  if (
    [paths.available, paths.reserved, paths.terminal].some((directory) =>
      fs.existsSync(statePath(directory, grantId)),
    )
  ) {
    throw unavailableGrant(grantId);
  }
}

export function assertNonterminalUnambiguous(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
): void {
  const states = [paths.available, paths.reserved].filter((directory) =>
    fs.existsSync(statePath(directory, grantId)),
  );
  if (states.length > 1) {
    throw ambiguousGrant(grantId);
  }
}

export function listGrantIds(directory: string): string[] {
  return fs.readdirSync(directory).map((entry) => {
    if (!STATE_FILE.test(entry)) {
      throw unsafeStore();
    }
    return assertCollaborationGrantId(entry.slice(0, -'.json'.length));
  });
}

export function statePath(directory: string, grantId: string): string {
  return path.join(directory, `${assertCollaborationGrantId(grantId)}.json`);
}

export function createPrivateFileAtomic(
  filePath: string,
  content: string,
): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
    assertPrivateDescriptor(descriptor);
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
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
    assertPrivateDescriptor(descriptor);
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
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
    assertPrivateDescriptor(descriptor);
    return fs.readFileSync(descriptor, 'utf8');
  } catch {
    throw unsafeStore();
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function assertPrivateDescriptor(descriptor: number): void {
  const stats = fs.fstatSync(descriptor);
  if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o777) !== 0o600) {
    throw unsafeStore();
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0;
}

export function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
