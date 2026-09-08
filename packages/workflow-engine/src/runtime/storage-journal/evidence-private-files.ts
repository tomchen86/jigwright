/**
 * Reads and traverses private evidence paths with stable descriptor checks.
 *
 * Invariants:
 * - Symlinks, hard links, permission drift, and directory escapes remain rejected.
 * - Creation, replacement, bounded reads, and fsync retain their existing filesystem semantics.
 *
 * Depends on: filesystem descriptors, path containment, and caller-provided errors.
 * Failure modes: unsafe or changing files are trusted as immutable evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { workflowError } from '../../foundation/errors/errors.ts';

export const NO_FOLLOW_CREATE =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

export function ensureNoFollowDirectory(
  base: string,
  privateRoot: string,
  directory: string,
  makeError: () => ReturnType<typeof workflowError>,
): void {
  walkNoFollowDirectory(base, privateRoot, directory, makeError, true);
}

export function assertNoFollowDirectory(
  base: string,
  privateRoot: string,
  directory: string,
  makeError: () => ReturnType<typeof workflowError>,
): boolean {
  return walkNoFollowDirectory(base, privateRoot, directory, makeError, false);
}

function walkNoFollowDirectory(
  base: string,
  privateRoot: string,
  directory: string,
  makeError: () => ReturnType<typeof workflowError>,
  create: boolean,
): boolean {
  const relative = path.relative(base, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw makeError();
  }
  let current = base;
  for (const segment of relative.split(path.sep)) {
    if (!segment) {
      continue;
    }
    current = path.join(current, segment);
    let stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stats) {
      if (!create) {
        return false;
      }
      fs.mkdirSync(current, { mode: 0o700 });
      fs.chmodSync(current, 0o700);
      stats = fs.lstatSync(current);
      fsyncDirectory(path.dirname(current));
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      fs.realpathSync(current) !== path.resolve(current)
    ) {
      throw makeError();
    }
    if (
      isInsideOrEqual(privateRoot, current) &&
      (stats.mode & 0o777) !== 0o700
    ) {
      throw makeError();
    }
  }
  return true;
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function readStablePrivateFile(
  filePath: string,
  allowedLinkCounts: number[],
  makeError: () => ReturnType<typeof workflowError>,
): { bytes: Buffer; stats: fs.Stats } {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !before ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    !allowedLinkCounts.includes(before.nlink) ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw makeError();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !after ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      !allowedLinkCounts.includes(opened.nlink) ||
      !allowedLinkCounts.includes(after.nlink) ||
      (opened.mode & 0o777) !== 0o600 ||
      (after.mode & 0o777) !== 0o600 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      opened.size !== before.size ||
      after.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      after.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      bytes.byteLength !== before.size
    ) {
      throw makeError();
    }
    return { bytes, stats: after };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EVIDENCE_OBJECT_UNSAFE'
    ) {
      throw error;
    }
    throw makeError();
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function readNoFollow(
  filePath: string,
  makeError: () => ReturnType<typeof workflowError>,
): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    throw makeError();
  }
  assertPrivateFileStats(stats, makeError);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw makeError();
  }
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino
    ) {
      throw makeError();
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertPrivateFileStats(
  stats: fs.Stats,
  makeError: () => ReturnType<typeof workflowError>,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw makeError();
  }
}

export function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
