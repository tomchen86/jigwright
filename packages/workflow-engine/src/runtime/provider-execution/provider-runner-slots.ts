/**
 * Acquire, reclaim, and release private provider concurrency slots under the exact slot guard.
 *
 * Invariants:
 * - Owner identity, no-follow reads, lock scope, and directory fsync order stay unchanged.
 * - Only a proven dead owner can have its slot reclaimed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_AI_ADAPTER_LIMITS } from './ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  withPrivateRuntimeLock,
  ensurePrivateInvestigationDirectory,
} from '../storage-journal/investigation-private-files.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  concurrencySlotFailed,
  concurrencyLimitExceeded,
  isRecord,
  isNodeError,
} from './provider-runner-values.ts';
import { noFollowFlag } from './provider-runner-files.ts';

// The maximum number of concurrency slot files the engine ever inspects. Policy
// may lower the effective limit, but every code-max slot is always counted so a
// lowered limit still observes a slot held above it.
const CODE_MAX_CONCURRENCY = MAX_AI_ADAPTER_LIMITS.maxConcurrent;

// --- Repository-wide concurrency slots ------------------------------------

type ProviderSlot = { release(): void };

type SlotOwner = {
  pid: number;
  device: bigint;
  inode: bigint;
  marker: string;
};

/**
 * Acquire one of the repository-wide concurrency slots under the configured
 * Git-common runtime root. All code-max slots are inspected — so a lowered
 * policy limit still counts a slot held above it — dead owners are safely
 * reclaimed, and the returned handle releases only the exact inode/token it owns.
 */
export function acquireProviderSlot(
  paths: InvestigationRuntimePaths,
  policyMaxConcurrent: number,
  invocationId: string,
): ProviderSlot {
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, 'provider-slot-acquire.lock'),
    () =>
      acquireProviderSlotUnderGuard(paths, policyMaxConcurrent, invocationId),
    'PROVIDER_CONCURRENCY_SLOT_GUARD_CONFLICT',
    concurrencySlotFailed,
  );
}

function acquireProviderSlotUnderGuard(
  paths: InvestigationRuntimePaths,
  policyMaxConcurrent: number,
  invocationId: string,
): ProviderSlot {
  const slotsDirectory = path.join(paths.root, 'provider-slots');
  ensurePrivateInvestigationDirectory(
    paths,
    slotsDirectory,
    concurrencySlotFailed,
  );
  const limit =
    Number.isInteger(policyMaxConcurrent) && policyMaxConcurrent > 0
      ? Math.min(policyMaxConcurrent, CODE_MAX_CONCURRENCY)
      : 1;
  const freeSlotPaths: string[] = [];
  let occupied = 0;
  for (let index = 0; index < CODE_MAX_CONCURRENCY; index += 1) {
    const slotPath = path.join(slotsDirectory, `slot-${index}.lock`);
    const owner = readSlotOwner(slotPath);
    if (owner === 'free') {
      freeSlotPaths.push(slotPath);
    } else if (owner === 'opaque') {
      occupied += 1;
    } else if (isProcessAlive(owner.pid)) {
      occupied += 1;
    } else if (reclaimDeadSlot(slotPath, owner)) {
      freeSlotPaths.push(slotPath);
    } else {
      occupied += 1;
    }
  }
  if (occupied >= limit) {
    throw concurrencyLimitExceeded();
  }
  for (const slotPath of freeSlotPaths) {
    const claimed = claimProviderSlot(slotPath, invocationId);
    if (claimed) {
      return claimed;
    }
  }
  throw concurrencyLimitExceeded();
}

function readSlotOwner(slotPath: string): SlotOwner | 'free' | 'opaque' {
  const linkStats = fs.lstatSync(slotPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!linkStats) {
    return 'free';
  }
  if (
    !linkStats.isFile() ||
    linkStats.isSymbolicLink() ||
    linkStats.nlink !== 1n ||
    (Number(linkStats.mode) & 0o777) !== 0o600
  ) {
    return 'opaque';
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(slotPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    return 'opaque';
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== linkStats.dev || opened.ino !== linkStats.ino) {
      return 'opaque';
    }
    const marker = fs.readFileSync(descriptor, 'utf8');
    const value = JSON.parse(marker);
    if (
      isRecord(value) &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.ownerToken === 'string'
    ) {
      return {
        pid: value.pid,
        device: opened.dev,
        inode: opened.ino,
        marker,
      };
    }
    return 'opaque';
  } catch {
    return 'opaque';
  } finally {
    fs.closeSync(descriptor);
  }
}

function reclaimDeadSlot(slotPath: string, owner: SlotOwner): boolean {
  const stats = fs.lstatSync(slotPath, { bigint: true, throwIfNoEntry: false });
  if (!stats) {
    return true;
  }
  if (stats.dev !== owner.device || stats.ino !== owner.inode) {
    return false;
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(slotPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    return false;
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== owner.device ||
      opened.ino !== owner.inode ||
      fs.readFileSync(descriptor, 'utf8') !== owner.marker
    ) {
      return false;
    }
    const observed = fs.lstatSync(slotPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      !observed ||
      observed.dev !== owner.device ||
      observed.ino !== owner.inode
    ) {
      return false;
    }
    fs.unlinkSync(slotPath);
    fsyncDirectory(path.dirname(slotPath));
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(descriptor);
  }
}

function claimProviderSlot(
  slotPath: string,
  invocationId: string,
): ProviderSlot | null {
  const marker = `${canonicalJson({
    schemaVersion: 1,
    ownerToken: crypto.randomUUID(),
    invocationId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      slotPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return null;
    }
    throw concurrencySlotFailed();
  }
  let owned: fs.BigIntStats;
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, marker);
    fs.fsyncSync(descriptor);
    owned = fs.fstatSync(descriptor, { bigint: true });
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(slotPath));
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      releaseOwnedSlot(slotPath, owned, marker);
    },
  };
}

function releaseOwnedSlot(
  slotPath: string,
  owned: fs.BigIntStats,
  marker: string,
): void {
  const linkStats = fs.lstatSync(slotPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    !linkStats ||
    linkStats.dev !== owned.dev ||
    linkStats.ino !== owned.ino
  ) {
    throw concurrencySlotFailed();
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(slotPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    throw concurrencySlotFailed();
  }
  let owns = false;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev === owned.dev && opened.ino === owned.ino) {
      owns = fs.readFileSync(descriptor, 'utf8') === marker;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (owns) {
    try {
      fs.unlinkSync(slotPath);
      fsyncDirectory(path.dirname(slotPath));
    } catch {
      throw concurrencySlotFailed();
    }
  } else {
    throw concurrencySlotFailed();
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
}
