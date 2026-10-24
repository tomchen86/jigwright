/**
 * Reads and publishes private runtime files while preserving canonical bytes and lock ownership.
 *
 * Invariants:
 * - Reads reject aliases, links, permission drift, and files that change across descriptor checks.
 * - Creation, replacement, and lock release retain their distinct rename and fsync order.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
} from '../repository-transaction/filesystem-safety.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  hasExactKeys,
  isNodeError,
  isRecord,
  isTimestamp,
} from '../../modules/investigation/domain/investigation-store-values.ts';

export const MAX_HUMAN_RESOLUTION_BYTES = 1_048_576;

const NO_FOLLOW_CREATE =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

export function canonicalPrivateContent(
  content: string,
  newlineRequired: boolean,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return false;
  }
  const canonical = canonicalJson(value);
  return content === (newlineRequired ? `${canonical}\n` : canonical);
}

export function ensurePrivateInvestigationDirectory(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
): void {
  walkPrivateDirectory(paths, directory, makeError, true);
}

export function assertPrivateInvestigationDirectory(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
): void {
  walkPrivateDirectory(paths, directory, makeError, false);
}

export function readPrivateCanonicalJson(
  paths: InvestigationRuntimePaths,
  filePath: string,
  makeError: () => WorkflowError,
  maxBytes = MAX_HUMAN_RESOLUTION_BYTES,
): unknown {
  walkPrivateDirectory(paths, path.dirname(filePath), makeError, false);
  const content = readPrivateFile(filePath, makeError, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw makeError();
  }
  if (`${canonicalJson(value)}\n` !== content) {
    throw makeError();
  }
  return value;
}

export function createPrivateCanonicalJson(
  paths: InvestigationRuntimePaths,
  filePath: string,
  value: unknown,
  makeError: () => WorkflowError,
  collisionCode: string,
  maxBytes = MAX_HUMAN_RESOLUTION_BYTES,
): void {
  const content = `${canonicalJson(value)}\n`;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    Buffer.byteLength(content, 'utf8') > maxBytes
  ) {
    throw makeError();
  }
  ensurePrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing) {
    if (readPrivateFile(filePath, makeError, maxBytes) === content) {
      return;
    }
    throw workflowError(
      collisionCode,
      'A different durable investigation record already exists.',
      ExitCode.conflict,
    );
  }
  const temporary = writePrivateTemporary(filePath, content);
  try {
    const raced = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (raced) {
      if (readPrivateFile(filePath, makeError, maxBytes) === content) {
        return;
      }
      throw workflowError(
        collisionCode,
        'A different durable investigation record already exists.',
        ExitCode.conflict,
      );
    }
    // Every caller holds the appropriate short store/change lock. Renaming a
    // fully fsynced private temp is atomic and avoids the crash window where a
    // temp-to-final hardlink would leave the durable target with nlink=2.
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    assertPrivateFile(fs.lstatSync(filePath), makeError);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function writePrivateCanonicalJsonAtomic(
  paths: InvestigationRuntimePaths,
  filePath: string,
  value: unknown,
  makeError: () => WorkflowError,
): void {
  const content = `${canonicalJson(value)}\n`;
  ensurePrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing) {
    assertPrivateFile(existing, makeError);
  }
  const temporary = writePrivateTemporary(filePath, content);
  try {
    const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (current) {
      assertPrivateFile(current, makeError);
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    assertPrivateFile(fs.lstatSync(filePath), makeError);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function withPrivateRuntimeLock<T>(
  paths: InvestigationRuntimePaths,
  lockPath: string,
  operation: () => T,
  conflictCode: string,
  invalidLock: () => WorkflowError,
): T {
  ensurePrivateInvestigationDirectory(
    paths,
    path.dirname(lockPath),
    invalidLock,
  );
  const ownerToken = crypto.randomUUID();
  const marker = `${canonicalJson({
    schemaVersion: 1,
    ownerToken,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = publishPreparedExclusiveLock(
        lockPath,
        marker,
        ownerToken,
        invalidLock,
      );
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      if (
        isNodeError(error) &&
        error.code === 'EEXIST' &&
        attempt === 0 &&
        reclaimDeadPrivateRuntimeLock(lockPath, invalidLock)
      ) {
        continue;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          conflictCode,
          'A durable investigation operation is already in progress.',
          ExitCode.conflict,
        );
      }
      throw error;
    }
  }
  if (descriptor === undefined) {
    throw invalidLock();
  }
  const owned = fs.fstatSync(descriptor);
  let result: T;
  try {
    result = operation();
  } catch (error) {
    releasePrivateRuntimeLock(lockPath, descriptor, owned, marker, invalidLock);
    throw error;
  }
  releasePrivateRuntimeLock(lockPath, descriptor, owned, marker, invalidLock);
  return result;
}

export function privatePathExists(
  paths: InvestigationRuntimePaths,
  filePath: string,
  makeError: () => WorkflowError,
): boolean {
  if (!walkPrivateDirectory(paths, path.dirname(filePath), makeError, false)) {
    return false;
  }
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    return false;
  }
  assertPrivateFile(stats, makeError);
  return true;
}

function writePrivateTemporary(filePath: string, content: string): string {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function readPrivateFile(
  filePath: string,
  makeError: () => WorkflowError,
  maxBytes = MAX_HUMAN_RESOLUTION_BYTES,
): string {
  return readPrivateBuffer(filePath, makeError, maxBytes).toString('utf8');
}

export function readPrivateBuffer(
  filePath: string,
  makeError: () => WorkflowError,
  maxBytes = MAX_HUMAN_RESOLUTION_BYTES,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw makeError();
  }
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before || before.size > maxBytes) {
    throw makeError();
  }
  assertPrivateFile(before, makeError);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch {
    throw makeError();
  }
  try {
    const opened = fs.fstatSync(descriptor);
    assertPrivateFile(opened, makeError);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > maxBytes
    ) {
      throw makeError();
    }
    const content = Buffer.alloc(opened.size + 1);
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
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      offset !== opened.size ||
      !afterPath ||
      !sameStablePrivateFile(opened, afterDescriptor) ||
      !sameStablePrivateFile(opened, afterPath)
    ) {
      throw makeError();
    }
    return content.subarray(0, offset);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function walkPrivateDirectory(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
  create: boolean,
): boolean {
  const relative = path.relative(paths.base, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw makeError();
  }
  let current = paths.base;
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
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(current) !== path.resolve(current) ||
      (isInsideOrEqual(paths.root, current) && (stats.mode & 0o777) !== 0o700)
    ) {
      throw makeError();
    }
  }
  return true;
}

function releasePrivateRuntimeLock(
  lockPath: string,
  descriptor: number,
  owned: fs.Stats,
  marker: string,
  invalidLock: () => WorkflowError,
): void {
  const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  let content: string | undefined;
  try {
    const bytes = Buffer.alloc(Buffer.byteLength(marker));
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    content = bytes.subarray(0, count).toString('utf8');
  } catch {
    content = undefined;
  }
  fs.closeSync(descriptor);
  if (
    !owned.isFile() ||
    owned.nlink !== 1 ||
    (owned.mode & 0o777) !== 0o600 ||
    !observed?.isFile() ||
    observed.isSymbolicLink() ||
    observed.nlink !== 1 ||
    (observed.mode & 0o777) !== 0o600 ||
    observed.dev !== owned.dev ||
    observed.ino !== owned.ino ||
    content !== marker
  ) {
    throw invalidLock();
  }
  fs.unlinkSync(lockPath);
  fsyncDirectory(path.dirname(lockPath));
}

function reclaimDeadPrivateRuntimeLock(
  lockPath: string,
  invalidLock: () => WorkflowError,
): boolean {
  const result = reclaimDeadPreparedLock(lockPath, (content) => {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return null;
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'ownerToken',
        'pid',
        'createdAt',
      ]) ||
      value.schemaVersion !== 1 ||
      typeof value.ownerToken !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      !isTimestamp(value.createdAt) ||
      `${canonicalJson(value)}\n` !== content
    ) {
      return null;
    }
    return {
      pid: value.pid as number,
      ownerToken: value.ownerToken,
    };
  });
  if (result === 'unsafe') {
    throw invalidLock();
  }
  return result === 'absent' || result === 'reclaimed';
}

export function assertPrivateFile(
  stats: fs.Stats,
  makeError: () => WorkflowError,
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

export function sameStablePrivateFile(
  left: fs.Stats,
  right: fs.Stats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function createPrivateRawFile(
  paths: InvestigationRuntimePaths,
  filePath: string,
  content: string,
  makeError: () => WorkflowError,
): void {
  ensurePrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
    throw makeError();
  }
  const temporary = writePrivateTemporary(filePath, content);
  try {
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
      throw makeError();
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    assertPrivateFile(fs.lstatSync(filePath), makeError);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
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
