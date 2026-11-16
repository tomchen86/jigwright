/**
 * Validates private recovery state directories and imports canonical
 * external recovery inputs.
 *
 * Invariants:
 * - External recovery inputs must lie outside both the repository worktree
 *   and Git common directory.
 */
import path from 'node:path';
import fs from 'node:fs';
import type {
  RecoveryAuthorityImportBoundary,
  RecoveryAuthorityExpectations,
} from '../../modules/authority/recovery-authority-contract.ts';
import {
  isExactAbsolutePath,
  type RecoveryQuarantineEnvelope,
} from '../../modules/authority/recovery-quarantine-contract.ts';
import type { readRecoveryQuarantineMarker } from './recovery-quarantine.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

function recoveryAuthorityStateRoot(gitCommonDirectory: string): string {
  return path.join(
    gitCommonDirectory,
    'workflow-engine',
    'recovery-authority-state',
  );
}

export function ensureRecoveryAuthorityStateRoot(
  gitCommonDirectory: string,
): string {
  const engineRoot = path.join(gitCommonDirectory, 'workflow-engine');
  ensurePrivateDirectory(gitCommonDirectory, engineRoot);
  const stateRoot = recoveryAuthorityStateRoot(gitCommonDirectory);
  ensurePrivateDirectory(engineRoot, stateRoot);
  return stateRoot;
}

export function requireRecoveryAuthorityStateRoot(
  gitCommonDirectory: string,
): string {
  const stateRoot = recoveryAuthorityStateRoot(gitCommonDirectory);
  assertPrivateRecoveryDirectory(stateRoot);
  return stateRoot;
}

export function readOptionalRecoveryQuarantineMarker(
  gitCommonDirectory: string,
  readMarker: typeof readRecoveryQuarantineMarker,
) {
  const storageRoot = recoveryAuthorityStateRoot(gitCommonDirectory);
  if (fs.lstatSync(storageRoot, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  assertPrivateRecoveryDirectory(storageRoot);
  return readMarker(storageRoot);
}

function ensurePrivateDirectory(parent: string, directory: string): void {
  assertExactDirectory(parent, false);
  if (path.dirname(directory) !== parent) throw recoveryExternalInputUnsafe();
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  assertPrivateRecoveryDirectory(directory);
}

function assertPrivateRecoveryDirectory(directory: string): void {
  assertExactDirectory(directory, true);
}

function assertExactDirectory(
  directory: string,
  requirePrivateMode: boolean,
): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  const currentUid = process.getuid?.();
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (requirePrivateMode && (stats.mode & 0o777) !== 0o700) ||
    (currentUid !== undefined && stats.uid !== currentUid) ||
    fs.realpathSync(directory) !== directory
  ) {
    throw recoveryExternalInputUnsafe();
  }
}

export function hasRecoveryOperationalTrustRootFence(
  gitCommonDirectory: string,
): boolean {
  const storageRoot = recoveryAuthorityStateRoot(gitCommonDirectory);
  if (fs.lstatSync(storageRoot, { throwIfNoEntry: false }) === undefined) {
    return false;
  }
  assertPrivateRecoveryDirectory(storageRoot);
  const allowed = new Set([
    'recovery-authority',
    'recovery-quarantine',
    'recovery-operational-trust-root',
  ]);
  let present = false;
  for (const entry of fs.readdirSync(storageRoot, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || !entry.isDirectory()) {
      throw recoveryOperationalTrustStateUnsafe();
    }
    assertPrivateRecoveryDirectory(path.join(storageRoot, entry.name));
    if (entry.name === 'recovery-operational-trust-root') present = true;
  }
  return present;
}

export function readExternalRecoveryExpectations(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): RecoveryAuthorityExpectations {
  return readExternalRecoveryInput(
    filePath,
    boundary,
  ) as RecoveryAuthorityExpectations;
}

export function readExternalRecoveryEnvelope(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): RecoveryQuarantineEnvelope {
  const value = readExternalRecoveryInput(filePath, boundary);
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['payload', 'signature']) ||
    !isRecord(value.payload) ||
    typeof value.payload.externalAuditRoot !== 'string' ||
    !isExactAbsolutePath(value.payload.externalAuditRoot) ||
    typeof value.signature !== 'string' ||
    value.signature.length === 0
  ) {
    throw recoveryExternalInputInvalid();
  }
  return value as unknown as RecoveryQuarantineEnvelope;
}

export function readExternalRecoveryTrustRootAuditRoot(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): string {
  const value = readExternalRecoveryInput(filePath, boundary);
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['payload', 'replacement', 'signature']) ||
    !isRecord(value.payload) ||
    !isRecord(value.replacement) ||
    typeof value.payload.externalAuditRoot !== 'string' ||
    !isExactAbsolutePath(value.payload.externalAuditRoot) ||
    typeof value.signature !== 'string' ||
    value.signature.length === 0
  ) {
    throw workflowError(
      'RECOVERY_TRUST_ROOT_GRANT_INVALID',
      'Operational trust-root restore requires an exact external pre-signed canonical replacement bundle.',
      ExitCode.verification,
    );
  }
  return value.payload.externalAuditRoot;
}

export function readExternalRecoveryInput(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): unknown {
  if (
    !isExactAbsolutePath(filePath) ||
    pathIsWithin(boundary.repositoryWorktreeRoot, filePath) ||
    pathIsWithin(boundary.gitCommonDirectory, filePath)
  ) {
    throw recoveryExternalInputUnsafe();
  }
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const currentUid = process.getuid?.();
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    (currentUid !== undefined && before.uid !== currentUid) ||
    before.size < 1 ||
    before.size > 1024 * 1024 ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw recoveryExternalInputUnsafe();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !sameRecoveryInputSnapshot(before, openedBefore) ||
      !sameRecoveryInputSnapshot(openedBefore, openedAfter) ||
      !afterPath ||
      !sameRecoveryInputSnapshot(openedAfter, afterPath)
    ) {
      throw recoveryExternalInputUnsafe();
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) throw recoveryExternalInputInvalid();
    const value = JSON.parse(text) as unknown;
    if (`${canonicalJson(value)}\n` !== text) {
      throw recoveryExternalInputInvalid();
    }
    return value;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw recoveryExternalInputInvalid();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameRecoveryInputSnapshot(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length === 0 ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..')
  );
}

function recoveryExternalInputUnsafe(): WorkflowError {
  return workflowError(
    'RECOVERY_AUTHORITY_EXTERNAL_INPUT_UNSAFE',
    'Recovery Authority inputs must be exact private canonical files outside the repository and Git common directory.',
    ExitCode.unsafeEnvironment,
  );
}

function recoveryExternalInputInvalid(): WorkflowError {
  return workflowError(
    'RECOVERY_AUTHORITY_EXTERNAL_INPUT_INVALID',
    'Recovery Authority external input is not exact canonical JSON.',
    ExitCode.verification,
  );
}

function recoveryOperationalTrustStateUnsafe(): WorkflowError {
  return workflowError(
    'RECOVERY_OPERATIONAL_TRUST_STATE_UNSAFE',
    'Recovery Authority state contains an unknown or unsafe operational trust-root entry.',
    ExitCode.unsafeEnvironment,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
