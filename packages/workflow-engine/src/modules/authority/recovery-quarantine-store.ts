/**
 * Publishes immutable private quarantine records and reconciles interrupted
 * publications.
 *
 * Invariants:
 * - ensureImmutable is write-once: an already-present target must be
 *   byte-canonically equal to the value being written.
 * - reconcileTemporaries promotes a residue file only when its embedded
 *   content digest matches its canonical bytes, otherwise it is
 *   state-corrupt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  GRANT_ID,
  grantInvalid,
  digestHex,
  assertCanonicalEqual,
  MAX_RECORD_BYTES,
  stateCorrupt,
  isNodeCode,
  storeUnsafe,
  TEMPORARY,
  PRIVATE_FILE_MODE,
  hasWorkflowCode,
  isExactAbsolutePath,
  normalizeMarker,
  normalizeReservation,
  normalizeReceipt,
  normalizeTerminal,
  normalizeAudit,
  normalizeAuditAcknowledgement,
  normalizeReleaseClaim,
  PRIVATE_DIRECTORY_MODE,
} from './recovery-quarantine-contract.ts';
import type {
  QuarantinePaths,
  RecoveryQuarantineGrantPayload,
  QuarantineGrantPaths,
  RecoveryQuarantineDependencies,
  RecoveryQuarantineFaultPhase,
  RecoveryQuarantineMarker,
} from './recovery-quarantine-contract.ts';

export function quarantinePaths(
  storageRoot: string,
  create: boolean,
): QuarantinePaths | null {
  assertPrivateDirectory(storageRoot);
  const state = path.join(storageRoot, 'recovery-quarantine');
  if (create) {
    ensurePrivateDirectory(storageRoot, state);
  } else if (fs.lstatSync(state, { throwIfNoEntry: false }) === undefined) {
    return null;
  } else {
    assertPrivateDirectory(state);
  }

  const grants = path.join(state, 'grants');
  const releaseClaims = path.join(state, 'release-claims');
  if (create) {
    ensurePrivateDirectory(state, grants);
    ensurePrivateDirectory(state, releaseClaims);
  } else {
    assertDirectoryWhenPresent(grants);
    assertDirectoryWhenPresent(releaseClaims);
  }
  return {
    state,
    grants,
    releaseClaims,
    marker: path.join(state, 'active-marker.json'),
  };
}

export function grantPaths(
  storageRoot: string,
  grant: string | RecoveryQuarantineGrantPayload,
  create: boolean,
): QuarantineGrantPaths | null {
  const grantIdValue = typeof grant === 'string' ? grant : grant.grantId;
  if (!GRANT_ID.test(grantIdValue)) throw grantInvalid();
  const paths = quarantinePaths(storageRoot, create);
  if (paths === null) return null;
  if (!create) {
    if (fs.lstatSync(paths.grants, { throwIfNoEntry: false }) === undefined) {
      return null;
    }
    assertPrivateDirectory(paths.grants);
  }
  const grantDirectory = path.join(paths.grants, digestHex(grantIdValue));
  if (create) {
    ensurePrivateDirectory(paths.grants, grantDirectory);
  } else if (
    fs.lstatSync(grantDirectory, { throwIfNoEntry: false }) === undefined
  ) {
    return null;
  } else {
    assertPrivateDirectory(grantDirectory);
  }
  const claimKey =
    typeof grant !== 'string' && grant.operation === 'release-quarantine'
      ? grant.activeMarkerDigest.slice('sha256:'.length)
      : digestHex(grantIdValue);
  return {
    ...paths,
    grantDirectory,
    reservation: path.join(grantDirectory, 'reservation.json'),
    receipt: path.join(grantDirectory, 'receipt.json'),
    terminal: path.join(grantDirectory, 'terminal.json'),
    audit: path.join(grantDirectory, 'audit.json'),
    auditAcknowledgement: path.join(grantDirectory, 'audit-ack.json'),
    releaseClaim: path.join(paths.releaseClaims, `${claimKey}.json`),
  };
}

export function ensureImmutable(
  filePath: string,
  value: unknown,
  dependencies: RecoveryQuarantineDependencies,
  publishedPhase: RecoveryQuarantineFaultPhase,
): void {
  const directory = path.dirname(filePath);
  assertPrivateDirectory(directory);
  assertAllowedTarget(directory, path.basename(filePath));
  reconcileTemporaries(directory);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
    assertCanonicalEqual(readCanonicalFile(filePath, [1]), value);
    return;
  }

  const text = `${canonicalJson(value)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_RECORD_BYTES) throw stateCorrupt();
  const digest = digestHex(text.slice(0, -1));
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${digest}.${crypto.randomUUID()}.tmp`,
  );
  writePrivateFile(temporary, bytes);
  fsyncDirectory(directory);
  try {
    fs.linkSync(temporary, filePath);
  } catch (error) {
    if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    reconcileTemporaries(directory);
    if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
      throw stateCorrupt();
    }
    assertCanonicalEqual(readCanonicalFile(filePath, [1]), value);
    return;
  }
  assertExactHardLinkPair(temporary, filePath);
  assertCanonicalEqual(readCanonicalFile(filePath, [2]), value);
  fsyncDirectory(directory);
  dependencies.hooks?.afterPhase(publishedPhase);
  unlinkExactAlias(temporary, filePath);
  fsyncDirectory(directory);
  assertCanonicalEqual(readCanonicalFile(filePath, [1]), value);
}

/**
 * Reconcile only the exact hard-link publish window. Unlinked preparations,
 * incomplete files, and unrelated residue are preserved and never promoted.
 */
export function reconcileTemporaries(directory: string): void {
  assertPrivateDirectory(directory);
  for (const name of fs.readdirSync(directory).sort()) {
    const match = TEMPORARY.exec(name);
    if (match === null) continue;
    const targetName = match[1]!;
    const temporary = path.join(directory, name);
    assertAllowedTarget(directory, targetName);
    const inspected = inspectTemporary(temporary);
    if (inspected === null) continue;
    const { value, stats } = inspected;
    if (digestHex(canonicalJson(value)) !== match[2]) throw stateCorrupt();
    validateTargetRecord(targetName, value);
    const target = path.join(directory, targetName);
    const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (targetStats === undefined) {
      if (stats.nlink !== 1) throw stateCorrupt();
      continue;
    }
    if (sameInode(stats, targetStats)) {
      assertExactHardLinkPair(temporary, target);
      assertCanonicalEqual(readCanonicalFile(target, [2]), value);
      unlinkExactAlias(temporary, target);
      fsyncDirectory(directory);
      continue;
    }
    if (stats.nlink !== 1) throw stateCorrupt();
    if (targetStats.nlink === 1) {
      const targetValue = readCanonicalFile(target, [1]);
      if (canonicalJson(targetValue) === canonicalJson(value)) {
        fs.unlinkSync(temporary);
        fsyncDirectory(directory);
      }
    }
  }
}

function inspectTemporary(
  filePath: string,
): { value: unknown; stats: fs.Stats } | null {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (before === undefined) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    ![1, 2].includes(before.nlink) ||
    (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
    !ownedByCurrentUser(before) ||
    safeRealpath(filePath) !== filePath ||
    before.size > MAX_RECORD_BYTES
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
    if (!sameFileSnapshot(before, openedBefore, [1, 2])) throw stateCorrupt();
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(openedBefore, openedAfter, [1, 2])) {
      throw stateCorrupt();
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.endsWith('\n')) return null;
      const value = JSON.parse(text) as unknown;
      if (`${canonicalJson(value)}\n` !== text) return null;
      return { value, stats: openedAfter };
    } catch (error) {
      if (hasWorkflowCode(error, 'RECOVERY_QUARANTINE_STATE_CORRUPT')) {
        throw error;
      }
      return null;
    }
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw stateCorrupt();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readCanonicalFile(
  filePath: string,
  allowedLinkCounts: readonly number[],
): unknown {
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
    before.size > MAX_RECORD_BYTES
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
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) throw stateCorrupt();
    const value = JSON.parse(text) as unknown;
    if (`${canonicalJson(value)}\n` !== text) throw stateCorrupt();
    return value;
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw stateCorrupt();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readOptional<T>(
  filePath: string,
  normalize: (raw: unknown) => T,
): T | null {
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  return normalize(readCanonicalFile(filePath, [1]));
}

export function unlinkExactMarker(
  markerPath: string,
  expected: RecoveryQuarantineMarker,
): void {
  const before = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (before === undefined) return;
  const observed = normalizeMarker(readCanonicalFile(markerPath, [1]));
  if (canonicalJson(observed) !== canonicalJson(expected)) throw stateCorrupt();
  const immediatelyBefore = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (
    immediatelyBefore === undefined ||
    !sameFileSnapshot(before, immediatelyBefore, [1])
  ) {
    throw stateCorrupt();
  }
  fs.unlinkSync(markerPath);
  fsyncDirectory(path.dirname(markerPath));
}

function assertAllowedTarget(directory: string, targetName: string): void {
  const parent = path.basename(directory);
  const grandparent = path.basename(path.dirname(directory));
  const allowed =
    parent === 'recovery-quarantine'
      ? targetName === 'active-marker.json'
      : grandparent === 'grants'
        ? [
            'audit-ack.json',
            'audit.json',
            'receipt.json',
            'reservation.json',
            'terminal.json',
          ].includes(targetName)
        : parent === 'release-claims'
          ? /^[0-9a-f]{64}\.json$/.test(targetName)
          : false;
  if (!allowed) throw stateCorrupt();
}

function validateTargetRecord(targetName: string, value: unknown): void {
  if (targetName === 'active-marker.json') {
    normalizeMarker(value);
  } else if (targetName === 'reservation.json') {
    normalizeReservation(value);
  } else if (targetName === 'receipt.json') {
    normalizeReceipt(value);
  } else if (targetName === 'terminal.json') {
    normalizeTerminal(value);
  } else if (targetName === 'audit.json') {
    normalizeAudit(value);
  } else if (targetName === 'audit-ack.json') {
    normalizeAuditAcknowledgement(value);
  } else if (/^[0-9a-f]{64}\.json$/.test(targetName)) {
    const claim = normalizeReleaseClaim(value);
    if (`${claim.markerDigest.slice('sha256:'.length)}.json` !== targetName) {
      throw stateCorrupt();
    }
  } else {
    throw stateCorrupt();
  }
}

function writePrivateFile(filePath: string, bytes: Buffer): void {
  let descriptor: number | undefined;
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
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (hasWorkflowCode(error)) throw error;
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensurePrivateDirectory(parent: string, directory: string): void {
  assertPrivateDirectory(parent);
  if (path.dirname(directory) !== parent) throw storeUnsafe();
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
      fsyncDirectory(parent);
    } catch (error) {
      if (!isNodeCode(error, 'EEXIST')) throw storeUnsafe();
    }
  }
  assertPrivateDirectory(directory);
}

function assertDirectoryWhenPresent(directory: string): void {
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
    assertPrivateDirectory(directory);
  }
}

function assertPrivateDirectory(directory: string): void {
  if (!isExactAbsolutePath(directory)) throw storeUnsafe();
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    !ownedByCurrentUser(stats) ||
    safeRealpath(directory) !== directory
  ) {
    throw storeUnsafe();
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

function unlinkExactAlias(alias: string, anchor: string): void {
  assertExactHardLinkPair(alias, anchor);
  fs.unlinkSync(alias);
  const anchorStats = fs.lstatSync(anchor, { throwIfNoEntry: false });
  if (anchorStats === undefined || anchorStats.nlink !== 1)
    throw stateCorrupt();
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
