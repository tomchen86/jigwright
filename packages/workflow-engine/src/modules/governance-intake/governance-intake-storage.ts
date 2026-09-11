/**
 * Publishes canonical governance intake records and reads them with file
 * identity checks.
 *
 * Invariants:
 * - Create-only publication accepts an existing record only when its
 *   canonical bytes match.
 */
import { canonicalJson } from '@jigwright/core/canonical-json';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FINDING_FILE_MODE = 0o600;

export function publishCreateOnlyCanonical(
  filePath: string,
  value: unknown,
  mode: number,
  collisionCode: string,
): boolean {
  const content = `${canonicalJson(value)}\n`;
  const contentBytes = Buffer.from(content, 'utf8');
  const collision = () =>
    workflowError(
      collisionCode,
      'A different immutable governance record already owns this identity.',
      ExitCode.conflict,
    );
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
    mode: mode === FINDING_FILE_MODE ? 0o700 : 0o755,
  });
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  } catch {
    throw collision();
  }
  if (existing) {
    const observed = readStableGovernanceBytes(filePath, mode, collision);
    if (observed.equals(contentBytes)) {
      return false;
    }
    throw collision();
  }

  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporaryPath, filePath);
    } catch (error) {
      if (
        isNodeError(error) &&
        error.code === 'EEXIST' &&
        readStableGovernanceBytes(filePath, mode, collision).equals(
          contentBytes,
        )
      ) {
        return false;
      }
      throw error;
    }
    fsyncDirectory(path.dirname(filePath));
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function readStableGovernanceBytes(
  filePath: string,
  expectedMode: number,
  unsafe: () => Error,
): Buffer {
  let before: fs.BigIntStats | undefined;
  try {
    before = fs.lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
  } catch {
    throw unsafe();
  }
  if (before === undefined || !isSafeGovernanceFile(before, expectedMode)) {
    throw unsafe();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
    );
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !isSafeGovernanceFile(openedBefore, expectedMode) ||
      !sameGovernanceFileSnapshot(before, openedBefore)
    ) {
      throw unsafe();
    }
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      after === undefined ||
      !isSafeGovernanceFile(openedAfter, expectedMode) ||
      !isSafeGovernanceFile(after, expectedMode) ||
      BigInt(bytes.byteLength) !== openedBefore.size ||
      !sameGovernanceFileSnapshot(openedBefore, openedAfter) ||
      !sameGovernanceFileSnapshot(openedAfter, after)
    ) {
      throw unsafe();
    }
    return bytes;
  } catch {
    throw unsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isSafeGovernanceFile(
  stats: fs.BigIntStats,
  expectedMode: number,
): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1n &&
    (process.platform === 'win32' ||
      (stats.mode & 0o777n) === BigInt(expectedMode)) &&
    (typeof process.getuid !== 'function' ||
      stats.uid === BigInt(process.getuid()))
  );
}

export function sameGovernanceFileSnapshot(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
