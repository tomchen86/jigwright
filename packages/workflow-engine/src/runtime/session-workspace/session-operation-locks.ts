/**
 * Owns short session-operation locks and the exact managed-session lock protocol.
 *
 * Invariants:
 * - Lock release and recovery verify owner tokens and stable descriptor identity.
 * - A competing process cannot release another session owner or reclaim a live lock.
 *
 * Depends on: prepared filesystem locks, session values, and Node descriptor operations.
 * Failure modes: overlapping session operations, stale locks, or deletion of a competing owner lock.
 */
import {
  ensurePlainDirectory,
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
  withPreparedLockCleanupClaim,
} from '../repository-transaction/filesystem-safety.ts';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { runtimePaths } from './workflow-session-records.ts';
import {
  invalidSessionLock,
  isNodeError,
  readDescriptorContent,
  fsyncDirectory,
  isRecord,
  SESSION_LOCK_OWNER_TOKEN,
} from './session-store-values.ts';

export function withSessionOperation<T>(
  runtime: ReturnType<typeof runtimePaths>,
  sessionId: string,
  operation: () => T,
): T {
  ensurePlainDirectory(runtime.operations);
  const lockPath = path.join(runtime.operations, `${sessionId}.lock`);
  const ownerToken = crypto.randomUUID();
  const content = `${JSON.stringify({
    sessionId,
    ownerToken,
    pid: process.pid,
  })}\n`;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = publishPreparedExclusiveLock(
        lockPath,
        content,
        ownerToken,
        invalidSessionLock,
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
        reclaimDeadSessionOperationLock(lockPath, sessionId)
      ) {
        continue;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          'SESSION_OPERATION_CONFLICT',
          `Session ${sessionId} already has an operation in progress.`,
          ExitCode.conflict,
        );
      }
      throw error;
    }
  }

  try {
    return operation();
  } finally {
    releaseSessionOperationLock(lockPath, descriptor, content);
  }
}

function releaseSessionOperationLock(
  lockPath: string,
  descriptor: number | undefined,
  content: string,
): void {
  if (descriptor === undefined) {
    throw invalidSessionLock();
  }
  try {
    const owned = fs.fstatSync(descriptor);
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    let observedContent: string | undefined;
    try {
      observedContent = fs.readFileSync(lockPath, 'utf8');
    } catch {
      observedContent = undefined;
    }
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
      observedContent !== content ||
      readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content
    ) {
      throw invalidSessionLock();
    }
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
  } finally {
    fs.closeSync(descriptor);
  }
}

function reclaimDeadSessionOperationLock(
  lockPath: string,
  expectedSessionId: string,
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
      Object.keys(value).length !== 3 ||
      value.sessionId !== expectedSessionId ||
      typeof value.ownerToken !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      `${JSON.stringify(value)}\n` !== content
    ) {
      return null;
    }
    return {
      pid: value.pid as number,
      ownerToken: value.ownerToken,
    };
  });
  return result === 'absent' || result === 'reclaimed';
}

export function releaseOwnedLock(lockPath: string, sessionId: string): void {
  withPreparedLockCleanupClaim(lockPath, () => {
    let descriptor: number | undefined;
    try {
      try {
        descriptor = fs.openSync(
          lockPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return;
        }
        throw error;
      }
      const opened = fs.fstatSync(descriptor);
      const content = fs.readFileSync(descriptor, 'utf8');
      const value = parseManagedSessionLock(content);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        (opened.mode & 0o777) !== 0o600 ||
        value === null
      ) {
        throw invalidSessionLock();
      }
      if (value.sessionId !== sessionId) {
        return;
      }
      const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
      if (
        !observed ||
        observed.dev !== opened.dev ||
        observed.ino !== opened.ino
      ) {
        return;
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
      fsyncDirectory(path.dirname(lockPath));
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  });
}

export function assertOwnedLock(
  lockPath: string,
  sessionId: string,
  changeId: string,
  taskId: string,
): void {
  let value: ReturnType<typeof parseManagedSessionLock>;
  try {
    value = parseManagedSessionLock(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    throw invalidSessionLock();
  }

  if (
    value?.sessionId !== sessionId ||
    value.changeId !== changeId ||
    value.taskId !== taskId
  ) {
    throw invalidSessionLock();
  }
}

export function parseManagedSessionLock(content: string): {
  sessionId: string;
  changeId: string;
  taskId: string;
  ownerToken: string;
  pid: number;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    `${JSON.stringify(value)}\n` !== content
  ) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.join('\0') !==
      ['changeId', 'ownerToken', 'pid', 'sessionId', 'taskId'].join('\0') ||
    typeof value.ownerToken !== 'string' ||
    !SESSION_LOCK_OWNER_TOKEN.test(value.ownerToken) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1
  ) {
    return null;
  }
  return value as {
    sessionId: string;
    changeId: string;
    taskId: string;
    ownerToken: string;
    pid: number;
  };
}
