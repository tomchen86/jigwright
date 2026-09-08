/**
 * Publishes immutable native session records through recoverable create-only hard links.
 *
 * Invariants:
 * - Temporary bytes are synced before linking and parent syncs retain their order.
 * - Existing targets require exact canonical equality before replay succeeds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ensurePrivateInvestigationDirectory } from './investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { providerNativeSessionStorePathsV1 as storePaths } from '../session-workspace/provider-runtime-authority-paths.ts';
import {
  storeInvalid,
  storeConflict,
  isNodeError,
} from './provider-native-session-values.ts';
import {
  fsyncDirectory,
  readBoundedCanonicalBytes,
  assertPrivateFileStats,
} from './provider-native-session-files.ts';
import {
  publicationRecoveryTarget,
  assertPublicationRecoveryValue,
  publicationRecoveryDirectory,
  recoverScopePublication,
  publicationTemporaryPath,
} from './provider-native-session-publication-recovery.ts';

const NO_FOLLOW_CREATE =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

function normalizePublicationOperationError(error: unknown): Error {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('PROVIDER_NATIVE_SESSION_')
  ) {
    return error;
  }
  return storeInvalid();
}

function cleanupPublicationTemporary(
  descriptor: number | undefined,
  temporaryCreated: boolean,
  temporaryPath: string,
  recoveryDirectory: string,
): Error | null {
  let cleanupFailed = false;
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch {
      cleanupFailed = true;
    }
  }
  if (temporaryCreated) {
    try {
      fs.unlinkSync(temporaryPath);
      fsyncDirectory(recoveryDirectory);
    } catch {
      cleanupFailed = true;
    }
  }
  return cleanupFailed ? storeInvalid() : null;
}

export function publishCanonicalCreateOnly(
  paths: InvestigationRuntimePaths,
  scopeKey: string,
  filePath: string,
  value: unknown,
  maxBytes: number,
): void {
  const content = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (content.length === 0 || content.length > maxBytes) throw storeInvalid();
  const locations = storePaths(paths);
  const recoveryTarget = publicationRecoveryTarget(
    locations,
    scopeKey,
    filePath,
  );
  if (recoveryTarget.maxBytes !== maxBytes) throw storeInvalid();
  assertPublicationRecoveryValue(value, recoveryTarget, scopeKey);
  const recoveryDirectory = publicationRecoveryDirectory(locations, scopeKey);
  ensurePrivateInvestigationDirectory(
    paths,
    path.dirname(filePath),
    storeInvalid,
  );
  ensurePrivateInvestigationDirectory(paths, recoveryDirectory, storeInvalid);
  recoverScopePublication(paths, locations, scopeKey);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
    if (!readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)) {
      throw storeConflict();
    }
    return;
  }

  const temporaryPath = publicationTemporaryPath(locations, scopeKey, filePath);
  let descriptor: number | undefined;
  let temporaryCreated = false;
  let operationError: Error | null = null;
  try {
    descriptor = fs.openSync(temporaryPath, NO_FOLLOW_CREATE, 0o600);
    temporaryCreated = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    assertPrivateFileStats(fs.fstatSync(descriptor), content.length);
    fsyncDirectory(recoveryDirectory);
    try {
      fs.linkSync(temporaryPath, filePath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      if (
        !readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)
      ) {
        throw storeConflict();
      }
    }
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    operationError = normalizePublicationOperationError(error);
  }
  const cleanupError = cleanupPublicationTemporary(
    descriptor,
    temporaryCreated,
    temporaryPath,
    recoveryDirectory,
  );
  if (operationError !== null) throw operationError;
  if (cleanupError !== null) throw cleanupError;
  if (!readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)) {
    throw storeInvalid();
  }
}
