/**
 * Stores immutable archive publication preparations with their protected
 * base and assurance bindings.
 *
 * Invariants:
 * - Assurance must cover the preparation protected base and archive head
 *   exactly.
 */
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';

export function persistArchivePublicationPreparation(
  runtimeRoot: string,
  preparation: ArchivePublicationPreparationV1,
): string {
  const parsed = assertArchivePublicationPreparation(preparation);
  const directory = preparationDirectory(runtimeRoot);
  ensurePlainDirectory(directory);
  const filePath = path.join(
    directory,
    `${parsed.preparationIdentity.slice('sha256:'.length)}.json`,
  );
  const bytes = `${canonicalJson(parsed)}\n`;
  try {
    fs.writeFileSync(filePath, bytes, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !isNodeError(error) ||
      error.code !== 'EEXIST' ||
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      fs.realpathSync(filePath) !== filePath ||
      fs.readFileSync(filePath, 'utf8') !== bytes
    ) {
      throw storeUnsafe();
    }
  }
  return filePath;
}

export function readArchivePublicationPreparation(
  runtimeRoot: string,
  preparationIdentity: string,
): ArchivePublicationPreparationV1 {
  if (!ARCHIVE_PUBLICATION_PREPARATION_IDENTITY.test(preparationIdentity))
    throw preparationInvalid();
  const directory = preparationDirectory(runtimeRoot);
  const filePath = path.join(
    directory,
    `${preparationIdentity.slice('sha256:'.length)}.json`,
  );
  try {
    const stats = fs.lstatSync(filePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 64 * 1024 ||
      fs.realpathSync(filePath) !== filePath
    ) {
      throw storeUnsafe();
    }
    const bytes = fs.readFileSync(filePath, 'utf8');
    const parsed = assertArchivePublicationPreparation(
      JSON.parse(bytes) as unknown,
    );
    if (
      parsed.preparationIdentity !== preparationIdentity ||
      bytes !== `${canonicalJson(parsed)}\n`
    ) {
      throw storeUnsafe();
    }
    return parsed;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw storeUnsafe();
  }
}

function preparationDirectory(runtimeRoot: string): string {
  const root = path.resolve(runtimeRoot);
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) throw storeUnsafe();
  return path.join(fs.realpathSync(root), 'archive-publication-preparations');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function storeUnsafe() {
  return workflowError(
    'ARCHIVE_PR_PREPARATION_STORE_UNSAFE',
    'Archive publication preparation storage is unsafe or conflicts with its exact identity.',
    ExitCode.unsafeEnvironment,
  );
}

import {
  ARCHIVE_PUBLICATION_PREPARATION_IDENTITY,
  assertArchivePublicationPreparation,
  archivePublicationPreparationInvalid as preparationInvalid,
  type ArchivePublicationPreparationV1,
} from '../../modules/authority/archive-publication-preparation.ts';
