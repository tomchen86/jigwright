/**
 * Implements private audit file publication and recovery with exact durability boundaries.
 *
 * Invariants:
 * - Reads retain no-follow, mode, link-count, size, and complete-descriptor validation.
 * - Immutable publication preserves prepared bytes, linking, fsync, and alias cleanup order.
 * - Recovered private publications retain the same filename and content-digest agreement.
 *
 * Depends on: Node filesystem primitives, audit contracts, and canonical digest validation.
 * Failure modes: unsafe records accepted, partially durable publications, or lost prepared-file recovery.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_RECORD_BYTES,
  MAX_METADATA_BYTES,
  PRIVATE_PUBLICATION_NAME,
} from './authority-audit-contracts.ts';
import {
  unsafeFilesystem,
  sha256Digest,
  isNodeError,
} from './authority-audit-values.ts';

export function readRecordPath(
  filePath: string,
  allowedLinks: readonly number[],
): { content: string; stats: fs.Stats } {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    !allowedLinks.includes(before.nlink) ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 1 ||
    before.size > MAX_RECORD_BYTES
  ) {
    throw unsafeFilesystem();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !opened.isFile() ||
      !allowedLinks.includes(opened.nlink) ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size !== before.size
    ) {
      throw unsafeFilesystem();
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      Buffer.byteLength(content) !== opened.size
    ) {
      throw unsafeFilesystem();
    }
    return { content, stats: after };
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function readExactPrivateFile(
  filePath: string,
  maximumBytes: number,
  makeError: () => Error,
): string {
  return readPrivateFileWithAllowedLinks(
    filePath,
    maximumBytes,
    [1],
    makeError,
  );
}

function readPrivateFileWithAllowedLinks(
  filePath: string,
  maximumBytes: number,
  allowedLinks: readonly number[],
  makeError: () => Error,
): string {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    !allowedLinks.includes(before.nlink) ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 1 ||
    before.size > maximumBytes
  ) {
    throw makeError();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !allowedLinks.includes(opened.nlink) ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size !== before.size
    ) {
      throw makeError();
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      Buffer.byteLength(content) !== opened.size
    ) {
      throw makeError();
    }
    return content;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writePreparedPrivateFile(
  filePath: string,
  content: string,
  makeError: () => Error,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size !== Buffer.byteLength(content)
    ) {
      throw makeError();
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeExclusivePrivateFile(
  filePath: string,
  content: string,
  makeError: () => Error,
  testAfterPreparation?: () => void,
): void {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const contentDigest = sha256Digest(content).slice('sha256:'.length);
  const preparationPath = path.join(
    directory,
    `.${baseName}.${contentDigest}.${crypto.randomUUID()}.publish.tmp`,
  );
  writePreparedPrivateFile(preparationPath, content, makeError);
  fsyncDirectory(directory);
  testAfterPreparation?.();
  try {
    fs.linkSync(preparationPath, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    if (
      readExactPrivateFile(filePath, MAX_METADATA_BYTES, makeError) !== content
    ) {
      throw makeError();
    }
  }
  fs.unlinkSync(preparationPath);
  fsyncDirectory(directory);
  if (
    readExactPrivateFile(filePath, MAX_METADATA_BYTES, makeError) !== content
  ) {
    throw makeError();
  }
}

export function publishImmutableObject(
  filePath: string,
  content: string,
  makeError: () => Error,
  testAfterPreparation?: () => void,
): void {
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (
      readExactPrivateFile(filePath, MAX_METADATA_BYTES, makeError) !== content
    ) {
      throw makeError();
    }
    return;
  }
  try {
    writeExclusivePrivateFile(
      filePath,
      content,
      makeError,
      testAfterPreparation,
    );
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    if (
      readExactPrivateFile(filePath, MAX_METADATA_BYTES, makeError) !== content
    ) {
      throw makeError();
    }
  }
}

export function recoverPrivateFilePublications(
  directory: string,
  isAllowedFinalName: (name: string) => boolean,
  makeError: () => Error,
): void {
  const recoveredFinalPaths = new Set<string>();
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.publish.tmp')) continue;
    const match = PRIVATE_PUBLICATION_NAME.exec(name);
    if (
      match === null ||
      match[1] === undefined ||
      match[2] === undefined ||
      !isAllowedFinalName(match[1])
    ) {
      throw makeError();
    }
    const preparationPath = path.join(directory, name);
    const stats = fs.lstatSync(preparationPath, { throwIfNoEntry: false });
    if (
      stats === undefined ||
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (stats.nlink !== 1 && stats.nlink !== 2) ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > MAX_METADATA_BYTES
    ) {
      throw makeError();
    }
    if (stats.size === 0) {
      if (stats.nlink !== 1) throw makeError();
      fs.unlinkSync(preparationPath);
      fsyncDirectory(directory);
      continue;
    }
    const content = readPrivateFileWithAllowedLinks(
      preparationPath,
      MAX_METADATA_BYTES,
      [1, 2],
      makeError,
    );
    if (sha256Digest(content).slice('sha256:'.length) !== match[2]) {
      if (stats.nlink !== 1) throw makeError();
      fs.unlinkSync(preparationPath);
      fsyncDirectory(directory);
      continue;
    }
    const finalPath = path.join(directory, match[1]);
    let finalStats = fs.lstatSync(finalPath, { throwIfNoEntry: false });
    if (finalStats === undefined) {
      const currentPreparationStats = fs.lstatSync(preparationPath);
      if (currentPreparationStats.nlink !== 1) throw makeError();
      try {
        fs.linkSync(preparationPath, finalPath);
        fsyncDirectory(directory);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      }
      finalStats = fs.lstatSync(finalPath, { throwIfNoEntry: false });
    }
    if (
      finalStats === undefined ||
      readPrivateFileWithAllowedLinks(
        finalPath,
        MAX_METADATA_BYTES,
        [1, 2],
        makeError,
      ) !== content
    ) {
      throw makeError();
    }
    const currentPreparationStats = fs.lstatSync(preparationPath);
    if (
      currentPreparationStats.nlink === 2 &&
      (currentPreparationStats.dev !== finalStats.dev ||
        currentPreparationStats.ino !== finalStats.ino)
    ) {
      throw makeError();
    }
    fs.unlinkSync(preparationPath);
    fsyncDirectory(directory);
    recoveredFinalPaths.add(finalPath);
  }
  for (const finalPath of recoveredFinalPaths) {
    readExactPrivateFile(finalPath, MAX_METADATA_BYTES, makeError);
  }
}

export function ensurePrivateRoot(directory: string): void {
  const parent = path.dirname(directory);
  assertPlainDirectory(parent);
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing === undefined) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    fsyncDirectory(parent);
  }
  assertPrivateDirectory(directory);
}

export function ensurePrivateDirectory(directory: string): void {
  assertPrivateDirectory(path.dirname(directory));
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing === undefined) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    fsyncDirectory(path.dirname(directory));
  }
  assertPrivateDirectory(directory);
}

export function assertRepositoryRoot(directory: string): void {
  assertPlainDirectory(directory);
}

function assertPlainDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  ) {
    throw unsafeFilesystem();
  }
}

export function assertPrivateDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    fs.realpathSync(directory) !== directory
  ) {
    throw unsafeFilesystem();
  }
}

export function assertExactDirectoryEntries(
  directory: string,
  expected: readonly string[],
): void {
  const observed = fs.readdirSync(directory).sort();
  const sortedExpected = [...expected].sort();
  if (
    observed.length !== sortedExpected.length ||
    observed.some((entry, index) => entry !== sortedExpected[index])
  ) {
    throw unsafeFilesystem();
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

export function readDescriptorContent(
  descriptor: number,
  byteLength: number,
): string {
  const bytes = Buffer.alloc(byteLength);
  const count = fs.readSync(descriptor, bytes, 0, byteLength, 0);
  return bytes.subarray(0, count).toString('utf8');
}
