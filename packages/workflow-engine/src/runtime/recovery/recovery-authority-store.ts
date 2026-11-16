/**
 * Imports and reads the private recovery authority descriptor with exact
 * replay and interrupted-write recovery.
 *
 * Invariants:
 * - Import is exact-replay idempotent: any stored or prepared descriptor
 *   that differs from the external one is rejected as replacementForbidden,
 *   never treated as a rotation.
 * - The external descriptor path must resolve outside both the repository
 *   worktree and the Git common directory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode } from '../../foundation/errors/errors.ts';
import {
  verifyRecoveryAuthorityDescriptor,
  isNodeCode,
  storeUnsafe,
  authorityError,
  PREPARED_DESCRIPTOR_NAME,
  storeCorrupt,
  replacementForbidden,
  PRIVATE_FILE_MODE,
  parseRecoveryAuthorityDescriptor,
  preparationIncomplete,
  hasWorkflowCode,
  PREPARATION_FILE,
  isRecord,
  hasExactKeys,
  descriptorInvalid,
  IMPORT_BOUNDARY_KEYS,
  MAX_RECOVERY_AUTHORITY_DESCRIPTOR_BYTES,
  PRIVATE_DIRECTORY_MODE,
} from '../../modules/authority/recovery-authority-contract.ts';
import type {
  RecoveryAuthorityExpectations,
  RecoveryAuthorityImportBoundary,
  RecoveryAuthorityImportHooks,
  RecoveryAuthorityDescriptorV1,
} from '../../modules/authority/recovery-authority-contract.ts';

/**
 * Import one externally pinned descriptor into an empty private store. Exact
 * replay is idempotent. A different descriptor is never treated as a rotation,
 * even when it names the existing recovery signer; rotation needs a distinct
 * higher-order/out-of-band protocol that phase 1 deliberately does not expose.
 * The private store is only a repository-local durable copy beneath the Git
 * common directory; trust still comes from the separately supplied expected
 * descriptor digest and signer fingerprint, never from this stored copy.
 */
export function importRecoveryAuthorityDescriptor(
  externalDescriptorPath: string,
  privateStoreRoot: string,
  expected: RecoveryAuthorityExpectations,
  boundary: RecoveryAuthorityImportBoundary,
  hooks?: RecoveryAuthorityImportHooks,
): RecoveryAuthorityDescriptorV1 {
  assertImportHooks(hooks);
  assertExternalDescriptorSource(externalDescriptorPath, boundary);
  assertPrivateStoreBoundary(privateStoreRoot, boundary);
  const external = verifyRecoveryAuthorityDescriptor(
    readExternalDescriptor(externalDescriptorPath),
    expected,
  );
  const directory = recoveryAuthorityStoreDirectory(privateStoreRoot, true);
  const target = path.join(directory, 'descriptor.json');
  if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    return reconcilePublishedDescriptor(directory, target, external, expected);
  }

  const prepared = ensureDurablePreparation(directory, external, hooks);
  try {
    fs.linkSync(prepared, target);
  } catch (error) {
    if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    return reconcilePublishedDescriptor(directory, target, external, expected);
  }
  assertExactHardLinkPair(prepared, target);
  assertSameDescriptor(readPreparedDescriptor(target, [2]), external);
  fsyncDirectory(directory);
  hooks?.afterPhase('published');
  return reconcilePublishedDescriptor(directory, target, external, expected);
}

export function readRecoveryAuthorityDescriptor(
  privateStoreRoot: string,
  expected: RecoveryAuthorityExpectations,
  boundary: RecoveryAuthorityImportBoundary,
): RecoveryAuthorityDescriptorV1 {
  assertPrivateStoreBoundary(privateStoreRoot, boundary);
  const directory = recoveryAuthorityStoreDirectory(privateStoreRoot, false);
  const target = path.join(directory, 'descriptor.json');
  if (fs.lstatSync(target, { throwIfNoEntry: false }) === undefined) {
    throw authorityError(
      'RECOVERY_AUTHORITY_NOT_PROVISIONED',
      'No external Recovery Authority Descriptor has been provisioned.',
      ExitCode.unsafeEnvironment,
    );
  }
  return verifyRecoveryAuthorityDescriptor(
    readStoredDescriptor(target),
    expected,
  );
}

function ensureDurablePreparation(
  directory: string,
  external: RecoveryAuthorityDescriptorV1,
  hooks: RecoveryAuthorityImportHooks | undefined,
): string {
  const prepared = path.join(directory, PREPARED_DESCRIPTOR_NAME);
  if (fs.lstatSync(prepared, { throwIfNoEntry: false }) !== undefined) {
    return reconcilePreparedDescriptor(directory, prepared, external);
  }

  const reusable = selectExactPreparation(directory, external);
  const preparation =
    reusable ?? writePrivatePreparation(directory, external, hooks);
  assertSameDescriptor(readPreparedDescriptor(preparation, [1]), external);
  fsyncPrivateFile(preparation, [1]);
  assertSameDescriptor(readPreparedDescriptor(preparation, [1]), external);
  try {
    fs.linkSync(preparation, prepared);
  } catch (error) {
    if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    return reconcilePreparedDescriptor(directory, prepared, external);
  }
  assertExactHardLinkPair(preparation, prepared);
  assertSameDescriptor(readPreparedDescriptor(prepared, [2]), external);
  fsyncDirectory(directory);
  hooks?.afterPhase('prepared');
  unlinkExactAlias(preparation, prepared);
  fsyncDirectory(directory);
  assertSameDescriptor(readPreparedDescriptor(prepared, [1]), external);
  return prepared;
}

function reconcilePreparedDescriptor(
  directory: string,
  prepared: string,
  external: RecoveryAuthorityDescriptorV1,
): string {
  const preparedStats = fs.lstatSync(prepared, { throwIfNoEntry: false });
  if (preparedStats === undefined) throw storeUnsafe();
  if (preparedStats.nlink === 1) {
    assertSameDescriptor(readPreparedDescriptor(prepared, [1]), external);
    return prepared;
  }
  if (preparedStats.nlink !== 2) throw storeCorrupt();

  const target = path.join(directory, 'descriptor.json');
  const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStats && sameInode(preparedStats, targetStats)) {
    assertExactHardLinkPair(prepared, target);
    assertSameDescriptor(readPreparedDescriptor(prepared, [2]), external);
    assertSameDescriptor(readPreparedDescriptor(target, [2]), external);
    return prepared;
  }

  const aliases = listPreparationPaths(directory).filter((candidate) => {
    const candidateStats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    return (
      candidateStats !== undefined && sameInode(preparedStats, candidateStats)
    );
  });
  if (aliases.length !== 1) throw storeCorrupt();
  const alias = aliases[0]!;
  assertPreparationNameMatches(alias, external);
  assertExactHardLinkPair(alias, prepared);
  assertSameDescriptor(readPreparedDescriptor(alias, [2]), external);
  assertSameDescriptor(readPreparedDescriptor(prepared, [2]), external);
  unlinkExactAlias(alias, prepared);
  fsyncDirectory(directory);
  assertSameDescriptor(readPreparedDescriptor(prepared, [1]), external);
  return prepared;
}

function reconcilePublishedDescriptor(
  directory: string,
  target: string,
  external: RecoveryAuthorityDescriptorV1,
  expected: RecoveryAuthorityExpectations,
): RecoveryAuthorityDescriptorV1 {
  const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStats === undefined) throw storeCorrupt();
  if (targetStats.nlink === 1) {
    const existing = readStoredDescriptor(target);
    assertSameDescriptor(existing, external);
    return verifyRecoveryAuthorityDescriptor(existing, expected);
  }
  if (targetStats.nlink !== 2) throw storeCorrupt();

  const prepared = path.join(directory, PREPARED_DESCRIPTOR_NAME);
  const preparedStats = fs.lstatSync(prepared, { throwIfNoEntry: false });
  if (!preparedStats || !sameInode(targetStats, preparedStats)) {
    throw storeCorrupt();
  }
  assertExactHardLinkPair(prepared, target);
  assertSameDescriptor(readPreparedDescriptor(prepared, [2]), external);
  assertSameDescriptor(readPreparedDescriptor(target, [2]), external);
  unlinkExactAlias(prepared, target);
  fsyncDirectory(directory);
  const existing = readStoredDescriptor(target);
  assertSameDescriptor(existing, external);
  return verifyRecoveryAuthorityDescriptor(existing, expected);
}

function selectExactPreparation(
  directory: string,
  external: RecoveryAuthorityDescriptorV1,
): string | undefined {
  let selected: string | undefined;
  for (const candidate of listPreparationPaths(directory)) {
    assertPreparationNameMatches(candidate, external);
    const inspected = inspectPreparation(candidate);
    if (inspected === null) continue;
    if (canonicalJson(inspected) !== canonicalJson(external)) {
      throw replacementForbidden();
    }
    selected ??= candidate;
  }
  return selected;
}

function inspectPreparation(
  filePath: string,
): RecoveryAuthorityDescriptorV1 | null {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(stats) ||
    safeRealpath(filePath) !== filePath
  ) {
    throw storeCorrupt();
  }
  try {
    return parseRecoveryAuthorityDescriptor(
      readPrivateCanonicalFile(
        filePath,
        {
          missingCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          missingMessage: 'Recovery Authority preparation disappeared.',
          unsafeCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          unsafeMessage: 'Recovery Authority preparation is unsafe.',
          oversizedCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          oversizedMessage: 'Recovery Authority preparation is unsafe.',
          malformed: preparationIncomplete,
        },
        [1],
      ),
    );
  } catch (error) {
    if (
      hasWorkflowCode(error, 'RECOVERY_AUTHORITY_PREPARATION_INCOMPLETE') ||
      hasWorkflowCode(error, 'RECOVERY_AUTHORITY_DESCRIPTOR_INVALID')
    ) {
      return null;
    }
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_STORE_CORRUPT')) throw error;
    throw storeCorrupt();
  }
}

function listPreparationPaths(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((name) => PREPARATION_FILE.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function writePrivatePreparation(
  directory: string,
  external: RecoveryAuthorityDescriptorV1,
  hooks: RecoveryAuthorityImportHooks | undefined,
): string {
  const filePath = path.join(
    directory,
    `descriptor.prepare.${external.descriptorDigest.slice('sha256:'.length)}.${process.pid}.${crypto.randomUUID()}.json`,
  );
  const bytes = Buffer.from(`${canonicalJson(external)}\n`, 'utf8');
  let descriptor: number | undefined;
  let invokingHook = false;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const prefixLength = Math.max(1, Math.min(32, bytes.length));
    writeAll(descriptor, bytes.subarray(0, prefixLength));
    invokingHook = true;
    hooks?.afterPhase('prepare-prefix-written');
    invokingHook = false;
    writeAll(descriptor, bytes.subarray(prefixLength));
    fs.fsyncSync(descriptor);
    invokingHook = true;
    hooks?.afterPhase('prepare-fsynced');
    invokingHook = false;
  } catch (error) {
    if (invokingHook || hasWorkflowCode(error)) throw error;
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return filePath;
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
    );
    if (written < 1) throw storeUnsafe();
    offset += written;
  }
}

function readPreparedDescriptor(
  filePath: string,
  allowedLinkCounts: readonly number[],
): RecoveryAuthorityDescriptorV1 {
  try {
    return parseRecoveryAuthorityDescriptor(
      readPrivateCanonicalFile(
        filePath,
        {
          missingCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          missingMessage: 'Recovery Authority preparation is incomplete.',
          unsafeCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          unsafeMessage: 'Recovery Authority preparation is unsafe.',
          oversizedCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
          oversizedMessage: 'Recovery Authority preparation is corrupt.',
          malformed: storeCorrupt,
        },
        allowedLinkCounts,
      ),
    );
  } catch (error) {
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_REPLACEMENT_FORBIDDEN')) {
      throw error;
    }
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_STORE_CORRUPT')) throw error;
    throw storeCorrupt();
  }
}

function assertSameDescriptor(
  observed: RecoveryAuthorityDescriptorV1,
  expected: RecoveryAuthorityDescriptorV1,
): void {
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw replacementForbidden();
  }
}

function assertExactHardLinkPair(leftPath: string, rightPath: string): void {
  const left = fs.lstatSync(leftPath, { throwIfNoEntry: false });
  const right = fs.lstatSync(rightPath, { throwIfNoEntry: false });
  if (
    !left ||
    !right ||
    !sameInode(left, right) ||
    left.nlink !== 2 ||
    right.nlink !== 2
  ) {
    throw storeCorrupt();
  }
}

function unlinkExactAlias(alias: string, anchor: string): void {
  assertExactHardLinkPair(alias, anchor);
  try {
    fs.unlinkSync(alias);
  } catch (error) {
    if (!isNodeCode(error, 'ENOENT')) throw storeUnsafe();
  }
  const anchorStats = fs.lstatSync(anchor, { throwIfNoEntry: false });
  if (!anchorStats || anchorStats.nlink !== 1) throw storeCorrupt();
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPreparationNameMatches(
  filePath: string,
  external: RecoveryAuthorityDescriptorV1,
): void {
  const match = PREPARATION_FILE.exec(path.basename(filePath));
  if (`sha256:${match?.[1] ?? ''}` !== external.descriptorDigest) {
    throw replacementForbidden();
  }
}

function assertImportHooks(
  hooks: RecoveryAuthorityImportHooks | undefined,
): void {
  if (
    hooks !== undefined &&
    (!isRecord(hooks) ||
      !hasExactKeys(hooks, ['afterPhase']) ||
      typeof hooks.afterPhase !== 'function')
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_HOOK_INVALID',
      'Recovery Authority import hook is malformed.',
      ExitCode.usage,
    );
  }
}

function readExternalDescriptor(filePath: string): unknown {
  return readPrivateCanonicalFile(filePath, {
    missingCode: 'RECOVERY_AUTHORITY_DESCRIPTOR_MISSING',
    missingMessage: 'External Recovery Authority Descriptor is missing.',
    unsafeCode: 'RECOVERY_AUTHORITY_DESCRIPTOR_FILE_UNSAFE',
    unsafeMessage:
      'External Recovery Authority Descriptor must be one exact private regular file.',
    oversizedCode: 'RECOVERY_AUTHORITY_DESCRIPTOR_TOO_LARGE',
    oversizedMessage: 'External Recovery Authority Descriptor is too large.',
    malformed: descriptorInvalid,
  });
}

function assertExternalDescriptorSource(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  if (!isRecord(boundary) || !hasExactKeys(boundary, IMPORT_BOUNDARY_KEYS)) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID',
      'Recovery authority import requires exact repository source boundaries.',
      ExitCode.unsafeEnvironment,
    );
  }
  const roots = [
    exactDirectoryPath(boundary.repositoryWorktreeRoot),
    exactDirectoryPath(boundary.gitCommonDirectory),
  ];
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath ||
    roots.some((root) => pathIsWithin(root, filePath))
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_DESCRIPTOR_SOURCE_FORBIDDEN',
      'Recovery Authority Descriptor must come from outside the repository worktree and Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function assertPrivateStoreBoundary(
  privateStoreRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
): void {
  if (!isRecord(boundary) || !hasExactKeys(boundary, IMPORT_BOUNDARY_KEYS)) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID',
      'Recovery authority import requires exact repository source boundaries.',
      ExitCode.unsafeEnvironment,
    );
  }
  exactDirectoryPath(boundary.repositoryWorktreeRoot);
  const gitCommonDirectory = exactDirectoryPath(boundary.gitCommonDirectory);
  assertPrivateDirectory(privateStoreRoot, 'RECOVERY_AUTHORITY_STORE_UNSAFE');
  const relative = path.relative(gitCommonDirectory, privateStoreRoot);
  if (
    relative.length === 0 ||
    !pathIsWithin(gitCommonDirectory, privateStoreRoot)
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_STORE_BOUNDARY_MISMATCH',
      'Recovery Authority private store must be an exact private descendant of the Git common directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function exactDirectoryPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID',
      'Recovery authority import boundary must be an exact absolute directory.',
      ExitCode.unsafeEnvironment,
    );
  }
  const stats = fs.lstatSync(value, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    safeRealpath(value) !== value
  ) {
    throw authorityError(
      'RECOVERY_AUTHORITY_IMPORT_BOUNDARY_INVALID',
      'Recovery authority import boundary must be an exact real directory.',
      ExitCode.unsafeEnvironment,
    );
  }
  return value;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function readStoredDescriptor(filePath: string): RecoveryAuthorityDescriptorV1 {
  try {
    return parseRecoveryAuthorityDescriptor(
      readPrivateCanonicalFile(filePath, {
        missingCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
        missingMessage: 'Recovery Authority private store is incomplete.',
        unsafeCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
        unsafeMessage: 'Recovery Authority private store is unsafe.',
        oversizedCode: 'RECOVERY_AUTHORITY_STORE_CORRUPT',
        oversizedMessage: 'Recovery Authority private store is corrupt.',
        malformed: storeCorrupt,
      }),
    );
  } catch (error) {
    if (hasWorkflowCode(error, 'RECOVERY_AUTHORITY_STORE_CORRUPT')) throw error;
    throw storeCorrupt();
  }
}

function readPrivateCanonicalFile(
  filePath: string,
  errors: {
    missingCode: string;
    missingMessage: string;
    unsafeCode: string;
    unsafeMessage: string;
    oversizedCode: string;
    oversizedMessage: string;
    malformed: () => Error;
  },
  allowedLinkCounts: readonly number[] = [1],
): unknown {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath
  ) {
    throw authorityError(
      errors.unsafeCode,
      errors.unsafeMessage,
      ExitCode.unsafeEnvironment,
    );
  }
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw authorityError(
      errors.missingCode,
      errors.missingMessage,
      ExitCode.unsafeEnvironment,
    );
  }
  if (stats.size > MAX_RECOVERY_AUTHORITY_DESCRIPTOR_BYTES) {
    throw authorityError(
      errors.oversizedCode,
      errors.oversizedMessage,
      ExitCode.unsafeEnvironment,
    );
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    !allowedLinkCounts.includes(stats.nlink) ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(stats) ||
    safeRealpath(filePath) !== filePath
  ) {
    throw authorityError(
      errors.unsafeCode,
      errors.unsafeMessage,
      ExitCode.unsafeEnvironment,
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(stats, openedBefore, allowedLinkCounts)) {
      throw authorityError(
        errors.unsafeCode,
        errors.unsafeMessage,
        ExitCode.unsafeEnvironment,
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(openedBefore, openedAfter, allowedLinkCounts)) {
      throw authorityError(
        errors.unsafeCode,
        errors.unsafeMessage,
        ExitCode.unsafeEnvironment,
      );
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) throw errors.malformed();
    const value = JSON.parse(text) as unknown;
    if (`${canonicalJson(value)}\n` !== text) throw errors.malformed();
    return value;
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw errors.malformed();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function recoveryAuthorityStoreDirectory(
  privateStoreRoot: string,
  create: boolean,
): string {
  assertPrivateDirectory(privateStoreRoot, 'RECOVERY_AUTHORITY_STORE_UNSAFE');
  const directory = path.join(privateStoreRoot, 'recovery-authority');
  if (
    create &&
    fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined
  ) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
      fsyncDirectory(privateStoreRoot);
    } catch (error) {
      if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    }
  }
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) {
    throw authorityError(
      'RECOVERY_AUTHORITY_NOT_PROVISIONED',
      'No external Recovery Authority Descriptor has been provisioned.',
      ExitCode.unsafeEnvironment,
    );
  }
  assertPrivateDirectory(directory, 'RECOVERY_AUTHORITY_STORE_UNSAFE');
  return directory;
}

function assertPrivateDirectory(directory: string, code: string): void {
  if (
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory
  ) {
    throw authorityError(
      code,
      'Recovery Authority private store must be one exact absolute directory.',
      ExitCode.unsafeEnvironment,
    );
  }
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    !ownedByCurrentUser(stats) ||
    safeRealpath(directory) !== directory
  ) {
    throw authorityError(
      code,
      'Recovery Authority private store must be one exact private directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncPrivateFile(
  filePath: string,
  allowedLinkCounts: readonly number[],
): void {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (before === undefined) throw storeCorrupt();
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(before, openedBefore, allowedLinkCounts)) {
      throw storeCorrupt();
    }
    fs.fsyncSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(openedBefore, openedAfter, allowedLinkCounts)) {
      throw storeCorrupt();
    }
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameFileSnapshot(
  left: fs.Stats,
  right: fs.Stats,
  allowedLinkCounts: readonly number[],
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
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
