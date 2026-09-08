/** Private recovery-trust-root-restore storage, immutable publication, and crash residue recovery. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode } from '../../foundation/errors/errors.ts';
import type { RecoveryAuthorityImportBoundary } from './recovery-authority-contract.ts';
import type {
  StatePaths,
  OperationPaths,
  RecoveryOperationalTrustRootRestoreDependencies,
  RecoveryOperationalTrustRootRestoreFaultPhase,
} from './recovery-trust-root-contract.ts';
import {
  storeUnsafe,
  GRANT_ID,
  grantInvalid,
  digestHex,
  ROOT_FILE,
  POINTER_FILE,
  OPERATION_DIRECTORY,
  stateCorrupt,
  PREPARATION,
  assertCanonicalEqual,
  isBufferPrefix,
  MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES,
  isNodeCode,
  PRIVATE_FILE_MODE,
  hasWorkflowCode,
  parseCanonicalBytes,
  isExactAbsolutePath,
  externalFileUnsafe,
  isRecord,
  hasExactKeys,
  boundaryInvalid,
  pathIsWithin,
  restoreError,
  PRIVATE_DIRECTORY_MODE,
} from './recovery-trust-root-values.ts';

export function statePaths(
  privateStoreRoot: string,
  create: boolean,
): StatePaths | null {
  assertPrivateDirectory(privateStoreRoot, storeUnsafe);
  const state = path.join(privateStoreRoot, 'recovery-operational-trust-root');
  if (create) {
    ensurePrivateDirectory(privateStoreRoot, state);
  } else if (fs.lstatSync(state, { throwIfNoEntry: false }) === undefined) {
    return null;
  } else {
    assertPrivateDirectory(state, storeUnsafe);
  }
  const roots = path.join(state, 'roots');
  const pointers = path.join(state, 'pointers');
  const operations = path.join(state, 'operations');
  if (create) {
    ensurePrivateDirectory(state, roots);
    ensurePrivateDirectory(state, pointers);
    ensurePrivateDirectory(state, operations);
  } else {
    assertPrivateDirectory(roots, storeUnsafe);
    assertPrivateDirectory(pointers, storeUnsafe);
    assertPrivateDirectory(operations, storeUnsafe);
  }
  return { state, roots, pointers, operations };
}

export function operationPaths(
  privateStoreRoot: string,
  grantIdValue: string,
  create: boolean,
): OperationPaths | null {
  if (!GRANT_ID.test(grantIdValue)) throw grantInvalid();
  const paths = statePaths(privateStoreRoot, create);
  if (paths === null) return null;
  const operationDirectory = path.join(
    paths.operations,
    digestHex(grantIdValue),
  );
  if (create) {
    ensurePrivateDirectory(paths.operations, operationDirectory);
  } else if (
    fs.lstatSync(operationDirectory, { throwIfNoEntry: false }) === undefined
  ) {
    return null;
  } else {
    assertPrivateDirectory(operationDirectory, storeUnsafe);
  }
  return {
    ...paths,
    operationDirectory,
    reservation: path.join(operationDirectory, 'reservation.json'),
    receipt: path.join(operationDirectory, 'receipt.json'),
    terminal: path.join(operationDirectory, 'terminal.json'),
    audit: path.join(operationDirectory, 'audit.json'),
    auditAcknowledgement: path.join(operationDirectory, 'audit-ack.json'),
  };
}

export function assertStateClosure(paths: StatePaths): void {
  assertExactDirectoryEntries(paths.state, ['operations', 'pointers', 'roots']);
  assertPreparedDirectoryClosure(paths.roots, (name) => ROOT_FILE.test(name));
  assertPreparedDirectoryClosure(paths.pointers, (name) =>
    POINTER_FILE.test(name),
  );
  for (const entry of fs.readdirSync(paths.operations, {
    withFileTypes: true,
  })) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !OPERATION_DIRECTORY.test(entry.name)
    ) {
      throw stateCorrupt();
    }
    assertPrivateDirectory(
      path.join(paths.operations, entry.name),
      stateCorrupt,
    );
  }
}

export function assertOperationClosure(paths: OperationPaths): void {
  assertStateClosure(paths);
  assertPreparedDirectoryClosure(paths.operationDirectory, (name) =>
    [
      'audit-ack.json',
      'audit.json',
      'receipt.json',
      'reservation.json',
      'terminal.json',
    ].includes(name),
  );
}

function assertPreparedDirectoryClosure(
  directory: string,
  allowedTarget: (name: string) => boolean,
): void {
  assertPrivateDirectory(directory, stateCorrupt);
  for (const name of fs.readdirSync(directory).sort()) {
    if (allowedTarget(name)) {
      const value = readPublished(path.join(directory, name));
      void value;
      continue;
    }
    const match = PREPARATION.exec(name);
    if (match === null || !allowedTarget(match[1]!)) throw stateCorrupt();
    const preparation = path.join(directory, name);
    const inspected = readPreparation(preparation);
    if (inspected.stats.nlink === 2) {
      const target = path.join(directory, match[1]!);
      const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
      if (
        targetStats === undefined ||
        !sameInode(inspected.stats, targetStats)
      ) {
        throw stateCorrupt();
      }
    } else if (
      fs.lstatSync(path.join(directory, match[1]!), {
        throwIfNoEntry: false,
      }) !== undefined
    ) {
      throw stateCorrupt();
    }
  }
}

export function hasExactPublicationEvidence(
  directory: string,
  targetName: string,
  value: unknown,
): boolean {
  assertPrivateDirectory(directory, stateCorrupt);
  const target = path.join(directory, targetName);
  if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    assertCanonicalEqual(readPublished(target), value);
    return true;
  }
  const expected = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  const preparations = matchingPreparations(directory, targetName);
  if (preparations.length === 0) return false;
  if (preparations.length !== 1) throw stateCorrupt();
  const match = PREPARATION.exec(path.basename(preparations[0]!));
  if (match?.[2] !== digestHex(expected)) throw stateCorrupt();
  const observed = readPreparation(preparations[0]!);
  if (observed.stats.nlink !== 1 || !isBufferPrefix(observed.bytes, expected)) {
    throw stateCorrupt();
  }
  return true;
}

export function ensureImmutable(
  filePath: string,
  value: unknown,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
  publishedPhase: RecoveryOperationalTrustRootRestoreFaultPhase,
): void {
  const directory = path.dirname(filePath);
  const targetName = path.basename(filePath);
  assertPrivateDirectory(directory, storeUnsafe);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
    assertCanonicalEqual(readPublished(filePath), value);
    return;
  }
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (bytes.length > MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES) {
    throw stateCorrupt();
  }
  const digest = digestHex(bytes);
  const existing = matchingPreparations(directory, targetName);
  if (existing.length > 1) throw stateCorrupt();
  let preparation: string;
  if (existing.length === 1) {
    preparation = existing[0]!;
    const match = PREPARATION.exec(path.basename(preparation));
    if (match?.[2] !== digest) throw stateCorrupt();
  } else {
    preparation = path.join(
      directory,
      `.${targetName}.${digest}.${crypto.randomUUID()}.prepare`,
    );
  }
  completePreparation(preparation, bytes, dependencies, targetName);
  assertExactPreparation(preparation, bytes, [1]);
  try {
    fs.linkSync(preparation, filePath);
  } catch (error) {
    if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    throw stateCorrupt();
  }
  assertExactHardLinkPair(preparation, filePath);
  assertCanonicalEqual(readPublished(filePath), value);
  fsyncDirectory(directory);
  dependencies.hooks?.afterPhase(publishedPhase, targetName);
  assertCanonicalEqual(readPublished(filePath), value);
}

function completePreparation(
  preparation: string,
  expected: Buffer,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
  targetName: string,
): void {
  const observed = fs.lstatSync(preparation, { throwIfNoEntry: false });
  let descriptor: number | undefined;
  try {
    if (observed === undefined) {
      descriptor = fs.openSync(
        preparation,
        fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      );
      fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    } else {
      descriptor = fs.openSync(
        preparation,
        fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const opened = fs.fstatSync(descriptor);
      if (!sameFileSnapshot(observed, opened, [1])) throw stateCorrupt();
    }
    const openedBefore = fs.fstatSync(descriptor);
    if (
      !openedBefore.isFile() ||
      openedBefore.isSymbolicLink() ||
      openedBefore.nlink !== 1 ||
      (openedBefore.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !ownedByCurrentUser(openedBefore) ||
      openedBefore.size > expected.length
    ) {
      throw stateCorrupt();
    }
    const existing = Buffer.alloc(openedBefore.size);
    if (existing.length > 0) {
      const read = fs.readSync(descriptor, existing, 0, existing.length, 0);
      if (read !== existing.length) throw stateCorrupt();
    }
    if (!isBufferPrefix(existing, expected)) throw stateCorrupt();
    let offset = existing.length;
    if (offset === 0) {
      const written = fs.writeSync(descriptor, expected, 0, 1, 0);
      if (written !== 1) throw storeUnsafe();
      offset = 1;
      dependencies.hooks?.afterPhase('prepare-prefix-written', targetName);
    }
    while (offset < expected.length) {
      const written = fs.writeSync(
        descriptor,
        expected,
        offset,
        expected.length - offset,
        offset,
      );
      if (written < 1) throw storeUnsafe();
      offset += written;
    }
    fs.fsyncSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (
      !sameInode(openedBefore, openedAfter) ||
      openedAfter.nlink !== 1 ||
      openedAfter.size !== expected.length ||
      (openedAfter.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !ownedByCurrentUser(openedAfter)
    ) {
      throw stateCorrupt();
    }
    fsyncDirectory(path.dirname(preparation));
    dependencies.hooks?.afterPhase('prepare-fsynced', targetName);
    const pathAfterHook = fs.lstatSync(preparation, {
      throwIfNoEntry: false,
    });
    if (
      pathAfterHook === undefined ||
      !sameFileSnapshot(openedAfter, pathAfterHook, [1])
    ) {
      throw stateCorrupt();
    }
  } catch (error) {
    if (hasWorkflowCode(error) || error instanceof Error) throw error;
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readPublished(filePath: string): unknown {
  const bytes = readPrivateFile(filePath, [2]);
  const value = parseCanonicalBytes(bytes);
  const directory = path.dirname(filePath);
  const targetName = path.basename(filePath);
  const digest = digestHex(bytes);
  const targetStats = fs.lstatSync(filePath);
  const anchors = matchingPreparations(directory, targetName).filter(
    (candidate) => {
      const match = PREPARATION.exec(path.basename(candidate));
      const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
      return (
        match?.[2] === digest &&
        stats !== undefined &&
        sameInode(stats, targetStats)
      );
    },
  );
  if (anchors.length !== 1) throw stateCorrupt();
  assertExactHardLinkPair(anchors[0]!, filePath);
  assertExactPreparation(anchors[0]!, bytes, [2]);
  return value;
}

export function readOptionalPublished<T>(
  filePath: string,
  normalize: (value: unknown) => T,
): T | null {
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  return normalize(readPublished(filePath));
}

function matchingPreparations(directory: string, targetName: string): string[] {
  const matches: string[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const match = PREPARATION.exec(name);
    if (match?.[1] === targetName) matches.push(path.join(directory, name));
  }
  return matches;
}

export function readPreparation(filePath: string): {
  bytes: Buffer;
  stats: fs.Stats;
} {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    ![1, 2].includes(before.nlink) ||
    (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(before) ||
    safeRealpath(filePath) !== filePath ||
    before.size > MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES
  ) {
    throw stateCorrupt();
  }
  const bytes = readPrivateFile(filePath, [1, 2]);
  return { bytes, stats: fs.lstatSync(filePath) };
}

function assertExactPreparation(
  filePath: string,
  expected: Buffer,
  allowedLinkCounts: readonly number[],
): void {
  const observed = readPrivateFile(filePath, allowedLinkCounts);
  if (!observed.equals(expected)) throw stateCorrupt();
}

function readPrivateFile(
  filePath: string,
  allowedLinkCounts: readonly number[],
): Buffer {
  if (!isExactAbsolutePath(filePath)) throw stateCorrupt();
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    !allowedLinkCounts.includes(before.nlink) ||
    (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(before) ||
    safeRealpath(filePath) !== filePath ||
    before.size > MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES
  ) {
    throw stateCorrupt();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(before, openedBefore, allowedLinkCounts)) {
      throw stateCorrupt();
    }
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(openedBefore, openedAfter, allowedLinkCounts)) {
      throw stateCorrupt();
    }
    return bytes;
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw stateCorrupt();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readExternalEnvelope(filePath: string): unknown {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(before) ||
    safeRealpath(filePath) !== filePath ||
    before.size > MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES
  ) {
    throw externalFileUnsafe();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(before, openedBefore, [1])) {
      throw externalFileUnsafe();
    }
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(openedBefore, openedAfter, [1])) {
      throw externalFileUnsafe();
    }
    return parseCanonicalBytes(bytes, grantInvalid);
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw grantInvalid();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function assertBoundaries(
  externalEnvelopePath: string,
  privateStoreRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  if (
    !isRecord(boundary) ||
    !hasExactKeys(boundary, ['gitCommonDirectory', 'repositoryWorktreeRoot'])
  ) {
    throw boundaryInvalid();
  }
  const worktree = exactDirectoryPath(boundary.repositoryWorktreeRoot);
  const gitCommon = exactDirectoryPath(boundary.gitCommonDirectory);
  assertPrivateStoreBoundary(privateStoreRoot, boundary);
  if (
    !isExactAbsolutePath(externalEnvelopePath) ||
    pathIsWithin(worktree, externalEnvelopePath) ||
    pathIsWithin(gitCommon, externalEnvelopePath)
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_EXTERNAL_SOURCE_FORBIDDEN',
      'Pre-signed trust-root replacement must come from outside the repository worktree and Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

export function assertPrivateStoreBoundary(
  privateStoreRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  if (
    !isRecord(boundary) ||
    !hasExactKeys(boundary, ['gitCommonDirectory', 'repositoryWorktreeRoot'])
  ) {
    throw boundaryInvalid();
  }
  exactDirectoryPath(boundary.repositoryWorktreeRoot);
  const gitCommon = exactDirectoryPath(boundary.gitCommonDirectory);
  assertPrivateDirectory(privateStoreRoot, storeUnsafe);
  if (
    privateStoreRoot === gitCommon ||
    !pathIsWithin(gitCommon, privateStoreRoot)
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_STORE_BOUNDARY_MISMATCH',
      'Trust-root restore store must be an exact private descendant of the Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

export function assertExternalAuditBoundary(
  externalAuditRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  const worktree = exactDirectoryPath(boundary.repositoryWorktreeRoot);
  const gitCommon = exactDirectoryPath(boundary.gitCommonDirectory);
  if (
    pathIsWithin(worktree, externalAuditRoot) ||
    pathIsWithin(gitCommon, externalAuditRoot)
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_AUDIT_ROOT_UNSAFE',
      'Trust-root restore audit root must remain outside the repository worktree and Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function exactDirectoryPath(value: unknown): string {
  if (!isExactAbsolutePath(value)) throw boundaryInvalid();
  const stats = fs.lstatSync(value, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    safeRealpath(value) !== value
  ) {
    throw boundaryInvalid();
  }
  return value;
}

function assertExactDirectoryEntries(
  directory: string,
  expected: readonly string[],
): void {
  const actual = fs.readdirSync(directory).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((value, index) => value !== sorted[index])
  ) {
    throw stateCorrupt();
  }
}

function ensurePrivateDirectory(parent: string, directory: string): void {
  assertPrivateDirectory(parent, storeUnsafe);
  if (path.dirname(directory) !== parent) throw storeUnsafe();
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
      fsyncDirectory(parent);
    } catch (error) {
      if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    }
  }
  assertPrivateDirectory(directory, storeUnsafe);
}

export function assertPrivateDirectory(
  directory: unknown,
  errorFactory: () => Error,
): asserts directory is string {
  if (!isExactAbsolutePath(directory)) throw errorFactory();
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    !ownedByCurrentUser(stats) ||
    safeRealpath(directory) !== directory
  ) {
    throw errorFactory();
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertExactHardLinkPair(leftPath: string, rightPath: string): void {
  const left = fs.lstatSync(leftPath, { throwIfNoEntry: false });
  const right = fs.lstatSync(rightPath, { throwIfNoEntry: false });
  if (
    left === undefined ||
    right === undefined ||
    !sameInode(left, right) ||
    left.nlink !== 2 ||
    right.nlink !== 2
  ) {
    throw stateCorrupt();
  }
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(
  left: fs.Stats,
  right: fs.Stats,
  allowedLinkCounts: readonly number[],
): boolean {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    allowedLinkCounts.includes(right.nlink) &&
    (right.mode & 0o777) === PRIVATE_FILE_MODE &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    ownedByCurrentUser(right)
  );
}

function ownedByCurrentUser(stats: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || stats.uid === process.getuid();
}

function safeRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}
