/**
 * Perform bounded private retention file reads, atomic writes, and deterministic artifact paths.
 *
 * Invariants:
 * - No-follow reads, inode rechecks, private permissions, and directory fsync stay unchanged.
 * - Artifact paths and per-kind byte limits preserve their original meaning.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  type ProviderRetentionArtifactName,
  providerRetentionRoot,
  assertRetentionDirectories,
  PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
} from '../storage-journal/provider-retention-receipt.ts';
import {
  runtimeUnsafe,
  receiptUnsafe,
  sha256,
} from './provider-retention-values.ts';

export const MAX_RAW_ARTIFACT_BYTES = 16 * 1_048_576;

export const MAX_HOST_WRAPPER_PROBE_BYTES = 64 * 1_024;

export const MAX_HOST_WRAPPER_TURN_REQUEST_BYTES = 1_048_576;

export const HOST_WRAPPER_PROBE_DIRECTORY = 'host-wrapper-probe-runtime';

export const HOST_WRAPPER_TURN_DIRECTORY = 'host-wrapper-runtime';

export function readPrivateFile(
  filePath: string,
  maxBytes = MAX_RAW_ARTIFACT_BYTES,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw runtimeUnsafe();
  }
  const absolute = path.resolve(filePath);
  if (absolute !== filePath) throw runtimeUnsafe();
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) throw runtimeUnsafe();
  assertPrivateRegularFile(before);
  if (before.size > maxBytes) throw runtimeUnsafe();
  let descriptor: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    const nonBlock = fs.constants.O_NONBLOCK;
    if (typeof noFollow !== 'number' || typeof nonBlock !== 'number') {
      throw runtimeUnsafe();
    }
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | noFollow | nonBlock,
    );
    const opened = fs.fstatSync(descriptor);
    assertPrivateRegularFile(opened);
    if (!sameIdentity(before, opened) || opened.size > maxBytes) {
      throw runtimeUnsafe();
    }

    const expectedBytes = opened.size;
    const content = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(
        descriptor,
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const afterRead = fs.fstatSync(descriptor);
    const current = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      offset !== expectedBytes ||
      !current ||
      !sameStableFile(opened, afterRead) ||
      !sameStableFile(opened, current) ||
      fs.realpathSync(absolute) !== absolute
    ) {
      throw runtimeUnsafe();
    }
    return content.subarray(0, offset);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw runtimeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function sourcePathForArtifact(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  name: ProviderRetentionArtifactName,
): string {
  if (name === 'review-root') throw receiptUnsafe();
  if (name === 'completion-candidate') {
    return providerCompletionCandidatePath(paths, invocationId);
  }
  return path.join(paths.invocations, invocationId, name);
}

export function maxBytesForRetentionArtifact(
  name: ProviderRetentionArtifactName,
  aggregateOutputBytes: number,
): number {
  switch (name) {
    case 'host-wrapper-probe-runtime/request.json':
    case 'host-wrapper-probe-runtime/probe-result.json':
      return MAX_HOST_WRAPPER_PROBE_BYTES;
    case 'host-wrapper-runtime/request.json':
      return MAX_HOST_WRAPPER_TURN_REQUEST_BYTES;
    case 'host-wrapper-runtime/semantic-output.json':
      return Math.min(
        MAX_HOST_WRAPPER_TURN_REQUEST_BYTES,
        aggregateOutputBytes,
      );
    default:
      return MAX_RAW_ARTIFACT_BYTES;
  }
}

export function providerCompletionCandidatePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(
    paths.root,
    'execution',
    'completion-candidates',
    `${sha256(Buffer.from(invocationId))}.json`,
  );
}

export function stagingName(name: ProviderRetentionArtifactName): string {
  switch (name) {
    case 'review-root':
      throw receiptUnsafe();
    case 'completion-candidate':
      return 'completion-candidate.json';
    case 'runtime/prompt.json':
      return 'runtime-prompt.json';
    case 'runtime/schema.json':
      return 'runtime-schema.json';
    case 'runtime/semantic-output.json':
      return 'runtime-semantic-output.json';
    case 'host-wrapper-probe-runtime/request.json':
      return 'host-wrapper-probe-request.json';
    case 'host-wrapper-probe-runtime/probe-result.json':
      return 'host-wrapper-probe-result.json';
    case 'host-wrapper-runtime/request.json':
      return 'host-wrapper-turn-request.json';
    case 'host-wrapper-runtime/semantic-output.json':
      return 'host-wrapper-semantic-output.json';
  }
}

export function ensureRetentionDirectories(
  paths: InvestigationRuntimePaths,
): void {
  const retention = providerRetentionRoot(paths);
  if (assertRetentionDirectories(paths, false)) return;
  ensurePrivateDirectory(retention.root);
  ensurePrivateDirectory(retention.receipts);
  ensurePrivateDirectory(retention.staging);
  assertRetentionDirectories(paths, true);
}

export function ensurePrivateDirectory(directory: string): void {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing) {
    assertPrivateDirectory(existing);
    if (fs.realpathSync(directory) !== path.resolve(directory)) {
      throw runtimeUnsafe();
    }
    return;
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  fsyncDirectory(path.dirname(directory));
  assertPrivateDirectory(fs.lstatSync(directory));
  if (fs.realpathSync(directory) !== path.resolve(directory)) {
    throw runtimeUnsafe();
  }
}

export function createPrivateFileAtomic(
  filePath: string,
  content: string,
): void {
  if (Buffer.byteLength(content) >= PROVIDER_RETENTION_MAX_RECEIPT_BYTES) {
    throw receiptUnsafe();
  }
  if (fs.lstatSync(filePath, { throwIfNoEntry: false })) throw receiptUnsafe();
  writePrivateFileAtomic(filePath, content);
}

export function replacePrivateFileAtomic(
  filePath: string,
  content: string,
): void {
  if (Buffer.byteLength(content) >= PROVIDER_RETENTION_MAX_RECEIPT_BYTES) {
    throw receiptUnsafe();
  }
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!existing) throw receiptUnsafe();
  assertPrivateRegularFile(existing);
  writePrivateFileAtomic(filePath, content);
}

function writePrivateFileAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
      0o600,
    );
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (current) assertPrivateRegularFile(current);
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temp either was never created or has already been atomically moved.
    }
    throw error;
  }
}

export function assertPrivateDirectory(stats: fs.Stats): void {
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)
  ) {
    throw runtimeUnsafe();
  }
}

function assertPrivateRegularFile(stats: fs.Stats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600)
  ) {
    throw runtimeUnsafe();
  }
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
