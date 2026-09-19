/**
 * Serializes evidence ref transactions and reclaims dead lock owners.
 *
 * Invariants:
 * - Lock acquisition, stale-owner checks, and release preserve exact process and file ownership.
 * - Cleanup never removes a lock whose descriptor or pathname no longer matches.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
} from '../repository-transaction/filesystem-safety.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  ensureNoFollowDirectory,
  fsyncDirectory,
} from './evidence-private-files.ts';
import {
  hasExactKeys,
  isNodeError,
  isPlainRecord,
  refInvalid,
  refLocked,
  refLockInvalid,
  refUnsafe,
} from './evidence-store-values.ts';

export function withRefLock<T>(
  paths: InvestigationRuntimePaths,
  changeId: string,
  operation: () => T,
): T {
  ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
  const lockPath = path.join(paths.refs, `${changeId}.lock`);
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
        refLockInvalid,
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
        reclaimDeadRefLock(lockPath)
      ) {
        continue;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw refLocked(changeId);
      }
      throw error;
    }
  }
  if (descriptor === undefined) {
    throw refInvalid();
  }
  const owned = fs.fstatSync(descriptor);
  try {
    return operation();
  } finally {
    releaseRefLock(lockPath, descriptor, owned, marker);
  }
}

function reclaimDeadRefLock(lockPath: string): boolean {
  try {
    const result = reclaimDeadPreparedLock(lockPath, (content) => {
      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch {
        return null;
      }
      if (
        !isPlainRecord(value) ||
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
        typeof value.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        `${canonicalJson(value)}\n` !== content
      ) {
        return null;
      }
      return {
        pid: value.pid as number,
        ownerToken: value.ownerToken,
      };
    });
    return result === 'absent' || result === 'reclaimed';
  } catch {
    return false;
  }
}

function releaseRefLock(
  lockPath: string,
  descriptor: number,
  owned: fs.Stats,
  marker: string,
): void {
  const stats = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  let observed: string | undefined;
  try {
    const bytes = Buffer.alloc(Buffer.byteLength(marker));
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    observed = bytes.subarray(0, count).toString('utf8');
  } catch {
    observed = undefined;
  }
  fs.closeSync(descriptor);
  // Only remove a lock that is still the exact file we created; ownership that
  // changed under us must not be unlinked.
  if (
    owned.isFile() &&
    owned.nlink === 1 &&
    (owned.mode & 0o777) === 0o600 &&
    stats?.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1 &&
    (stats.mode & 0o777) === 0o600 &&
    stats.dev === owned.dev &&
    stats.ino === owned.ino &&
    observed === marker
  ) {
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
    return;
  }
  throw refLockInvalid();
}
