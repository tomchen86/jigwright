/**
 * Read and create runner files while preserving private paths and exact file identities.
 *
 * Invariants:
 * - No-follow opens, exclusive creation, identity rechecks, and durability stay unchanged.
 * - Baseline file digests continue to describe the exact tracked or private bytes.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import { runGit } from '../repository-transaction/git.ts';
import { type ProviderExecutableIdentity } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  sha256,
  runtimeDirectoryUnsafe,
  runtimePathUnsafe,
  nativeOutputInvalid,
  nativeOutputRepair,
} from './provider-runner-values.ts';

export function fileDigestAtBaseline(
  repositoryRoot: string,
  baseCommit: string,
  repositoryPath: string,
): string {
  const committed = runGit(repositoryRoot, [
    'show',
    `${baseCommit}:${repositoryPath}`,
  ]);
  return sha256(committed);
}

export function readPlainFileDigest(
  filePath: string,
  makeError: () => WorkflowError,
): string {
  const before = fs.lstatSync(filePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw makeError();
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    throw makeError();
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw makeError();
    }
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(descriptor))
      .digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

export function canonicalDirectoryOrThrow(directory: string): string {
  try {
    const absolute = path.resolve(directory);
    const real = fs.realpathSync(absolute);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      !path.isAbsolute(directory) ||
      directory !== absolute ||
      real !== absolute ||
      !stats?.isDirectory() ||
      stats.isSymbolicLink()
    ) {
      throw new Error('not a directory');
    }
    return absolute;
  } catch {
    throw runtimeDirectoryUnsafe(directory);
  }
}

export function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

export function createExclusiveRuntimeDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== 0o700 ||
      fs.realpathSync(directory) !== path.resolve(directory)
    ) {
      throw runtimePathUnsafe(directory);
    }
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw runtimePathUnsafe(directory);
  }
}

type RuntimeFileIdentity = {
  device: bigint;
  inode: bigint;
};

export function createExclusiveRuntimeFile(
  filePath: string,
  content: string,
): RuntimeFileIdentity {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
  } catch {
    // A preplanted symlink, hardlink, or any other existing entry (EEXIST/ELOOP)
    // is rejected without following or truncating its target.
    throw runtimePathUnsafe(filePath);
  }
  try {
    const stats = fs.fstatSync(descriptor, { bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n) {
      throw runtimePathUnsafe(filePath);
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor, { bigint: true });
    return { device: written.dev, inode: written.ino };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertExclusiveRuntimeFile(
  filePath: string,
  identity: RuntimeFileIdentity,
  expectedContent: string,
): void {
  const linked = fs.lstatSync(filePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    !linked?.isFile() ||
    linked.isSymbolicLink() ||
    linked.nlink !== 1n ||
    linked.dev !== identity.device ||
    linked.ino !== identity.inode ||
    (linked.mode & 0o777n) !== 0o600n
  ) {
    throw runtimePathUnsafe(filePath);
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    throw runtimePathUnsafe(filePath);
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== identity.device ||
      opened.ino !== identity.inode ||
      (opened.mode & 0o777n) !== 0o600n ||
      !fs.readFileSync(descriptor).equals(Buffer.from(expectedContent, 'utf8'))
    ) {
      throw runtimePathUnsafe(filePath);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function openNoFollowRead(filePath: string): number {
  try {
    return fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  } catch {
    throw nativeOutputInvalid(
      nativeOutputRepair(
        'NATIVE_OUTPUT_FILE_MISSING_OR_UNSAFE',
        'Provider native output file was missing or unsafe; return one complete object matching the target schema.',
      ),
    );
  }
}

export function noFollowFlag(): number {
  return process.platform !== 'win32' &&
    typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0;
}

export function isRegularExecutable(mode: number): boolean {
  return (mode & 0o170000) === 0o100000 && (mode & 0o111) !== 0;
}

export function sameIdentity(
  before: ProviderExecutableIdentity,
  after: ProviderExecutableIdentity,
): boolean {
  return canonicalJson(before) === canonicalJson(after);
}
