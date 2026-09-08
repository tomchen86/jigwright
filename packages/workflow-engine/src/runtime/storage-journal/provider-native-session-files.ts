/**
 * Reads bounded native session files while checking canonical bytes and file identity.
 *
 * Invariants:
 * - Reads retain size, mode, link count, and no-follow checks.
 * - Stable snapshots compare both pathname and opened descriptor identities.
 *
 * Depends on: Private investigation directories, filesystem metadata, and canonical JSON.
 * Failure modes: Swapped files, hard links, or oversized records become accepted authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { assertPrivateInvestigationDirectory } from './investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { MAX_REF_BYTES } from './provider-native-session-contracts.ts';
import { storeInvalid } from './provider-native-session-values.ts';

export const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function assertRefUnchanged(
  paths: InvestigationRuntimePaths,
  filePath: string,
  before: Readonly<{ value: unknown; bytes: Buffer; identity: fs.Stats }>,
  maxBytes = MAX_REF_BYTES,
): void {
  const after = readBoundedCanonicalSnapshot(paths, filePath, maxBytes);
  if (
    !sameStableFile(before.identity, after.identity) ||
    !before.bytes.equals(after.bytes) ||
    canonicalJson(before.value) !== canonicalJson(after.value)
  ) {
    throw storeInvalid();
  }
}

export function readBoundedCanonicalJson(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
): unknown {
  return readBoundedCanonicalSnapshot(paths, filePath, maxBytes).value;
}

export function readBoundedCanonicalSnapshot(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
): Readonly<{ value: unknown; bytes: Buffer; identity: fs.Stats }> {
  return readBoundedCanonicalSnapshotWithLinkCount(
    paths,
    filePath,
    maxBytes,
    1,
  );
}

export function readBoundedCanonicalSnapshotWithLinkCount(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
  expectedLinks: 1 | 2,
): Readonly<{ value: unknown; bytes: Buffer; identity: fs.Stats }> {
  const snapshot = readBoundedFileSnapshotWithLinkCount(
    paths,
    filePath,
    maxBytes,
    expectedLinks,
  );
  let source: string;
  let value: unknown;
  try {
    source = UTF8.decode(snapshot.bytes);
    value = JSON.parse(source) as unknown;
  } catch {
    throw storeInvalid();
  }
  if (`${canonicalJson(value)}\n` !== source) throw storeInvalid();
  return Object.freeze({
    value,
    bytes: snapshot.bytes,
    identity: snapshot.identity,
  });
}

export function readBoundedCanonicalBytes(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
): Buffer {
  return readBoundedFileSnapshot(paths, filePath, maxBytes).bytes;
}

function readBoundedFileSnapshot(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
): Readonly<{ bytes: Buffer; identity: fs.Stats }> {
  return readBoundedFileSnapshotWithLinkCount(paths, filePath, maxBytes, 1);
}

function readBoundedFileSnapshotWithLinkCount(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
  expectedLinks: 1 | 2,
): Readonly<{ bytes: Buffer; identity: fs.Stats }> {
  assertPrivateInvestigationDirectory(
    paths,
    path.dirname(filePath),
    storeInvalid,
  );
  const absolute = path.resolve(filePath);
  if (absolute !== filePath) throw storeInvalid();
  const before = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (before === undefined) throw storeInvalid();
  assertPrivateFileStats(before, maxBytes, expectedLinks);
  let descriptor: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    const nonBlock = fs.constants.O_NONBLOCK;
    if (typeof noFollow !== 'number' || typeof nonBlock !== 'number') {
      throw storeInvalid();
    }
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | noFollow | nonBlock,
    );
    const opened = fs.fstatSync(descriptor);
    assertPrivateFileStats(opened, maxBytes, expectedLinks);
    if (!sameFile(before, opened)) throw storeInvalid();

    const expectedBytes = opened.size;
    const buffer = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const afterRead = fs.fstatSync(descriptor);
    const current = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      offset !== expectedBytes ||
      current === undefined ||
      !sameStableFile(opened, afterRead) ||
      !sameStableFile(opened, current) ||
      fs.realpathSync(absolute) !== absolute
    ) {
      throw storeInvalid();
    }
    return Object.freeze({
      bytes: buffer.subarray(0, offset),
      identity: opened,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID'
    ) {
      throw error;
    }
    throw storeInvalid();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function assertPrivateFileStats(
  stats: fs.Stats,
  maxBytes: number,
  expectedLinks: 1 | 2 = 1,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== expectedLinks ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.size < 1 ||
    stats.size > maxBytes
  ) {
    throw storeInvalid();
  }
}

export function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return (
    sameFile(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
