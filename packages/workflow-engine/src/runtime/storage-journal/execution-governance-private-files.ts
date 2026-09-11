import { isNodeError } from '../../modules/authority/execution-governance-values.ts';
/**
 * Preserves private file reads and the distinct atomic publication primitives used by governance.
 *
 * Invariants:
 * - Grant creation uses a no-overwrite hard link; workflow creation keeps its lock-bound rename.
 * - Replacement, fsync, descriptor cleanup, and temporary cleanup retain their exact sequence.
 * - Private reads preserve no-follow, mode, size, and link-count validation.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isWorkflowError } from '../../modules/authority/execution-governance-values.ts';
import { unsafeDurableGovernanceStore } from '../../modules/authority/execution-governance-store-contracts.ts';

export function ensurePrivateDirectory(
  directory: string,
  create: boolean,
): void {
  if (create) {
    try {
      fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw unsafeDurableGovernanceStore();
      }
    }
  }
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0
  ) {
    throw unsafeDurableGovernanceStore();
  }
}

export function readPrivateFile(
  filePath: string,
  maximumBytes: number,
): string {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > maximumBytes
    ) {
      throw unsafeDurableGovernanceStore();
    }
    return fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (
      isWorkflowError(error) &&
      error.code === 'EXECUTION_GOVERNANCE_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw unsafeDurableGovernanceStore();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createPrivateFileAtomic(
  filePath: string,
  content: string,
): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, filePath);
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

// Durable-governance callers hold the workflow lock, so a no-overwrite check
// followed by rename avoids the hard-link alias window of the cross-process
// grant publisher while preserving atomic visibility to unlocked readers.
export function createDurablePrivateFileAtomic(
  filePath: string,
  content: string,
): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
      const error = new Error(`File ${filePath} already exists.`);
      Object.assign(error, { code: 'EEXIST' });
      throw error;
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

export function replacePrivateFileAtomic(
  filePath: string,
  content: string,
): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
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
