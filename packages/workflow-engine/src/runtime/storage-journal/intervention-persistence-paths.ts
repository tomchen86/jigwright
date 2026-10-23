/**
 * Resolves and prepares the private namespaces that own intervention persistence records.
 *
 * Invariants:
 * - Storage roots and derived filenames retain their canonical identity and path validation.
 * - Record and operation namespaces remain distinct and preserve existing directory permissions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import {
  type InterventionControlPersistencePaths,
  PRIVATE_DIRECTORY_MODE,
} from './intervention-persistence-contracts.ts';
import {
  identityFileName,
  isPathInside,
} from './intervention-persistence-values.ts';

export function interventionControlPersistencePaths(
  requestedRoot: string,
): InterventionControlPersistencePaths {
  const root = assertStorageRoot(requestedRoot);
  return {
    root,
    checkpoints: path.join(root, 'checkpoints'),
    interventions: path.join(root, 'interventions'),
    sidecarSessions: path.join(root, 'sidecar-sessions'),
    operations: path.join(root, 'operations'),
  };
}

export function interventionRecordPath(
  storageRoot: string,
  parentChangeId: string,
): string {
  return path.join(
    interventionControlPersistencePaths(storageRoot).interventions,
    `${identityFileName('intervention', parentChangeId)}.json`,
  );
}

export function persistedBootstrapSidecarSessionPath(
  storageRoot: string,
  parentChangeId: string,
): string {
  return path.join(
    interventionControlPersistencePaths(storageRoot).sidecarSessions,
    `${identityFileName('sidecar-session', parentChangeId)}.json`,
  );
}

export function ensurePersistenceDirectories(storageRoot: string): void {
  const paths = interventionControlPersistencePaths(storageRoot);
  for (const directory of [
    paths.root,
    paths.checkpoints,
    paths.interventions,
    paths.sidecarSessions,
    paths.operations,
  ]) {
    ensurePlainDirectory(directory);
    const stats = fs.statSync(directory);
    if ((stats.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
      } catch {
        throw workflowError(
          'INTERVENTION_PERSISTENCE_DIRECTORY_UNSAFE',
          'Persistence directory permissions are not private.',
          ExitCode.unsafeEnvironment,
        );
      }
    }
  }
}

function assertStorageRoot(requestedRoot: string): string {
  if (typeof requestedRoot !== 'string' || !path.isAbsolute(requestedRoot)) {
    throw workflowError(
      'INTERVENTION_PERSISTENCE_ROOT_INVALID',
      'Persistence root must be an explicit absolute path.',
      ExitCode.usage,
    );
  }
  const root = path.resolve(requestedRoot);
  if (root === path.parse(root).root) {
    throw workflowError(
      'INTERVENTION_PERSISTENCE_ROOT_INVALID',
      'Filesystem root cannot be used as intervention persistence.',
      ExitCode.guard,
    );
  }
  return root;
}
export function canonicalAbsolutePath(requestedPath: string): string {
  if (
    typeof requestedPath !== 'string' ||
    !path.isAbsolute(requestedPath) ||
    path.resolve(requestedPath) !== requestedPath ||
    requestedPath === path.parse(requestedPath).root
  ) {
    throw workflowError(
      'BOOTSTRAP_PATH_INVALID',
      'Bootstrap path must be an explicit normalized absolute path.',
      ExitCode.usage,
    );
  }
  return requestedPath;
}
export function assertPersistenceOwnedPath(
  storageRoot: string,
  requestedPath: string,
  code: string,
): string {
  const root = interventionControlPersistencePaths(storageRoot).root;
  const absolute = canonicalAbsolutePath(requestedPath);
  if (!isPathInside(root, absolute)) {
    throw workflowError(
      code,
      'Bootstrap mutable state must stay inside the persistence root.',
      ExitCode.guard,
    );
  }
  return absolute;
}
