import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';

const RAW_DIGEST = /^[0-9a-f]{64}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ArchivePublicationPreparationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'archive-publication-preparation.v1';
  preparationIdentity: `sha256:${string}`;
  repositoryId: string;
  changeId: string;
  candidateIdentity: string;
  protectedBase: Readonly<{
    branch: string;
    remoteName: 'origin';
    trackingRef: string;
    commit: string;
    tree: string;
  }>;
  archive: Readonly<{
    branch: string;
    headCommit: string;
    reportId: string;
  }>;
  assurance: Readonly<{
    reportIdentity: string;
    baseCommit: string;
    headCommit: string;
  }>;
}>;

export function createArchivePublicationPreparation(
  input: Omit<
    ArchivePublicationPreparationV1,
    'schemaVersion' | 'kind' | 'preparationIdentity'
  >,
): ArchivePublicationPreparationV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: 'archive-publication-preparation.v1' as const,
    ...input,
  };
  return assertArchivePublicationPreparation({
    ...body,
    preparationIdentity: digest(canonicalJson(body)),
  });
}

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
  if (!SHA256_DIGEST.test(preparationIdentity)) throw preparationInvalid();
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

export function assertArchivePublicationPreparation(
  value: unknown,
): ArchivePublicationPreparationV1 {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          'schemaVersion',
          'kind',
          'preparationIdentity',
          'repositoryId',
          'changeId',
          'candidateIdentity',
          'protectedBase',
          'archive',
          'assurance',
        ].sort(),
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'archive-publication-preparation.v1' ||
    typeof value.preparationIdentity !== 'string' ||
    !SHA256_DIGEST.test(value.preparationIdentity) ||
    typeof value.repositoryId !== 'string' ||
    !/^[A-Za-z0-9_.:/-]{1,200}$/.test(value.repositoryId) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.candidateIdentity !== 'string' ||
    !RAW_DIGEST.test(value.candidateIdentity) ||
    !isRecord(value.protectedBase) ||
    !exactKeys(value.protectedBase, [
      'branch',
      'remoteName',
      'trackingRef',
      'commit',
      'tree',
    ]) ||
    typeof value.protectedBase.branch !== 'string' ||
    value.protectedBase.remoteName !== 'origin' ||
    value.protectedBase.trackingRef !==
      `refs/remotes/origin/${value.protectedBase.branch}` ||
    typeof value.protectedBase.commit !== 'string' ||
    !COMMIT_OID.test(value.protectedBase.commit) ||
    typeof value.protectedBase.tree !== 'string' ||
    !COMMIT_OID.test(value.protectedBase.tree) ||
    !isRecord(value.archive) ||
    !exactKeys(value.archive, ['branch', 'headCommit', 'reportId']) ||
    value.archive.branch !== `work/archive-${value.changeId}` ||
    typeof value.archive.headCommit !== 'string' ||
    !COMMIT_OID.test(value.archive.headCommit) ||
    typeof value.archive.reportId !== 'string' ||
    !RAW_DIGEST.test(value.archive.reportId) ||
    !isRecord(value.assurance) ||
    !exactKeys(value.assurance, [
      'reportIdentity',
      'baseCommit',
      'headCommit',
    ]) ||
    typeof value.assurance.reportIdentity !== 'string' ||
    !RAW_DIGEST.test(value.assurance.reportIdentity) ||
    value.assurance.baseCommit !== value.protectedBase.commit ||
    value.assurance.headCommit !== value.archive.headCommit
  ) {
    throw preparationInvalid();
  }
  const { preparationIdentity, ...body } = value;
  if (preparationIdentity !== digest(canonicalJson(body))) {
    throw preparationInvalid();
  }
  return Object.freeze(
    structuredClone(value),
  ) as ArchivePublicationPreparationV1;
}

function preparationDirectory(runtimeRoot: string): string {
  const root = path.resolve(runtimeRoot);
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) throw storeUnsafe();
  return path.join(fs.realpathSync(root), 'archive-publication-preparations');
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function preparationInvalid() {
  return workflowError(
    'ARCHIVE_PR_PREPARATION_INVALID',
    'Archive publication preparation is malformed or stale.',
    ExitCode.guard,
  );
}

function storeUnsafe() {
  return workflowError(
    'ARCHIVE_PR_PREPARATION_STORE_UNSAFE',
    'Archive publication preparation storage is unsafe or conflicts with its exact identity.',
    ExitCode.unsafeEnvironment,
  );
}
