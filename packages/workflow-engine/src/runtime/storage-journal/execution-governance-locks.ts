import { parseDurableGovernanceLockOwner } from '../../modules/authority/execution-governance-store-contracts.ts';
/**
 * Serializes grant and workflow mutations with their distinct private lock protocols.
 *
 * Invariants:
 * - Grant locks retain exclusive-create ownership and their existing conflict semantics.
 * - Workflow locks retain owner records, dead-owner recovery, inode checks, and directory durability.
 * - Operation failures retain precedence over failures while releasing the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type DurableGovernancePaths,
  unsafeDurableGovernanceStore,
} from '../../modules/authority/execution-governance-store-contracts.ts';
import { workflowStorageKey } from './execution-governance-store-objects.ts';
import {
  fsyncDirectory,
  readPrivateFile,
} from './execution-governance-private-files.ts';
import { isNodeError } from '../../modules/authority/execution-governance-values.ts';

export function withDurableGovernanceLock<T>(
  paths: DurableGovernancePaths,
  workflowId: string,
  operation: () => T,
): T {
  const lockPath = path.join(
    paths.locks,
    `${workflowStorageKey(workflowId)}.lock`,
  );
  let descriptor: number | undefined;
  let ownedStats: fs.Stats | undefined;
  for (let attempt = 0; attempt < 3 && descriptor === undefined; attempt += 1) {
    let createdThisAttempt = false;
    try {
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      createdThisAttempt = true;
      fs.fchmodSync(descriptor, 0o600);
      const lockRecord = {
        schemaVersion: 1,
        workflowId,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(descriptor, `${canonicalJson(lockRecord)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      ownedStats = fs.fstatSync(descriptor);
      fsyncDirectory(paths.locks);
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      ownedStats = undefined;
      if (createdThisAttempt) {
        try {
          fs.unlinkSync(lockPath);
          fsyncDirectory(paths.locks);
        } catch (cleanupError) {
          if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
            throw unsafeDurableGovernanceStore();
          }
        }
      }
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      if (!reclaimDeadDurableGovernanceLock(lockPath, workflowId)) {
        throw workflowError(
          'EXECUTION_GOVERNANCE_OPERATION_CONFLICT',
          `Workflow ${workflowId} already has a governance operation in progress.`,
          ExitCode.conflict,
        );
      }
    }
  }
  if (descriptor === undefined || ownedStats === undefined) {
    throw workflowError(
      'EXECUTION_GOVERNANCE_OPERATION_CONFLICT',
      `Workflow ${workflowId} already has a governance operation in progress.`,
      ExitCode.conflict,
    );
  }
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  fs.closeSync(descriptor);
  let releaseError: unknown;
  try {
    const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      current === undefined ||
      current.dev !== ownedStats.dev ||
      current.ino !== ownedStats.ino
    ) {
      throw unsafeDurableGovernanceStore();
    }
    fs.unlinkSync(lockPath);
    fsyncDirectory(paths.locks);
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

function reclaimDeadDurableGovernanceLock(
  lockPath: string,
  workflowId: string,
): boolean {
  const raw = readPrivateFile(lockPath, 4_096);
  const value = parseDurableGovernanceLockOwner(raw, workflowId);

  try {
    process.kill(value.pid as number, 0);
    return false;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ESRCH') return false;
  }
  try {
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return true;
    throw error;
  }
}

export function withExecutionGrantLock<T>(
  paths: { locks: string },
  grantId: string,
  operation: () => T,
): T {
  const lockPath = path.join(paths.locks, `${grantId}.lock`);
  let descriptor: number | undefined;
  let ownsLock = false;
  let result: T | undefined;
  let operationError: unknown;
  try {
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      ownsLock = true;
      fs.writeFileSync(
        descriptor,
        `${canonicalJson({ grantId, pid: process.pid })}\n`,
        'utf8',
      );
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          'EXECUTION_BUDGET_GRANT_OPERATION_CONFLICT',
          `Execution-budget grant ${grantId} already has an operation in progress.`,
          ExitCode.conflict,
        );
      }
      throw error;
    }
    result = operation();
  } catch (error) {
    operationError = error;
  }
  if (descriptor !== undefined) fs.closeSync(descriptor);
  let releaseError: unknown;
  if (ownsLock) {
    try {
      fs.unlinkSync(lockPath);
      fsyncDirectory(paths.locks);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') releaseError = error;
    }
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}
