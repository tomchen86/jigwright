/**
 * Serializes intervention operations and parent transitions with exact private lock ownership.
 *
 * Invariants:
 * - Acquire retries and dead-owner reclamation retain the canonical operation-key owner record.
 * - CAS checks and their mutations remain inside the same locked callback.
 * - Release preserves exact owner checks and its existing cleanup error behavior.
 *
 * Depends on: prepared-lock filesystem safety, persistence paths, and private file durability.
 * Failure modes: concurrent parent mutation, stale operation locks, or release of another process lock.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
} from '../repository-transaction/filesystem-safety.ts';
import {
  ensurePersistenceDirectories,
  interventionControlPersistencePaths,
} from './intervention-persistence-paths.ts';
import {
  identityFileName,
  unsafePersistenceLock,
  isNodeError,
  isRecord,
} from './intervention-persistence-values.ts';
import { PRIVATE_FILE_MODE } from './intervention-persistence-contracts.ts';
import { fsyncDirectory } from './intervention-persistence-files.ts';

export function withPersistenceOperation<T>(
  storageRoot: string,
  operationKey: string,
  operation: () => T,
): T {
  ensurePersistenceDirectories(storageRoot);
  const paths = interventionControlPersistencePaths(storageRoot);
  const lockPath = path.join(
    paths.operations,
    `${identityFileName('operation', operationKey)}.lock`,
  );
  const ownerToken = crypto.randomUUID();
  const content = `${canonicalJson({ operationKey, ownerToken, pid: process.pid })}\n`;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = publishPreparedExclusiveLock(
        lockPath,
        content,
        ownerToken,
        unsafePersistenceLock,
      );
      break;
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST' && attempt === 0) {
        const reclaimed = reclaimDeadPreparedLock(lockPath, (raw) => {
          let value: unknown;
          try {
            value = JSON.parse(raw);
          } catch {
            return null;
          }
          if (
            !isRecord(value) ||
            value.operationKey !== operationKey ||
            typeof value.ownerToken !== 'string' ||
            !Number.isSafeInteger(value.pid) ||
            `${canonicalJson(value)}\n` !== raw
          ) {
            return null;
          }
          return {
            pid: value.pid as number,
            ownerToken: value.ownerToken,
          };
        });
        if (reclaimed === 'absent' || reclaimed === 'reclaimed') {
          continue;
        }
        if (reclaimed === 'unsafe') {
          throw unsafePersistenceLock();
        }
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          'INTERVENTION_PERSISTENCE_OPERATION_CONFLICT',
          'A persistence operation is already in progress.',
          ExitCode.conflict,
        );
      }
      throw error;
    }
  }
  if (descriptor === undefined) {
    throw unsafePersistenceLock();
  }
  try {
    return operation();
  } finally {
    releasePersistenceLock(lockPath, descriptor, content);
  }
}

export function withInterventionParentOperation<T>(
  storageRoot: string,
  parentChangeId: string,
  operation: () => T,
): T {
  if (
    typeof parentChangeId !== 'string' ||
    parentChangeId.length === 0 ||
    parentChangeId.trim() !== parentChangeId
  ) {
    throw workflowError(
      'INTERVENTION_PARENT_OPERATION_INVALID',
      'Parent lifecycle operation requires an exact parent change id.',
      ExitCode.usage,
    );
  }
  return withPersistenceOperation(
    storageRoot,
    `parent-lifecycle:${parentChangeId}`,
    operation,
  );
}

function releasePersistenceLock(
  lockPath: string,
  descriptor: number,
  content: string,
): void {
  try {
    const owned = fs.fstatSync(descriptor);
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    const buffer = Buffer.alloc(Buffer.byteLength(content));
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (
      !owned.isFile() ||
      owned.nlink !== 1 ||
      (owned.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !observed?.isFile() ||
      observed.isSymbolicLink() ||
      observed.dev !== owned.dev ||
      observed.ino !== owned.ino ||
      bytes !== buffer.length ||
      buffer.toString('utf8') !== content
    ) {
      throw unsafePersistenceLock();
    }
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
  } finally {
    fs.closeSync(descriptor);
  }
}
