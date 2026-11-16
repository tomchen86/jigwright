/** Canonical archive preparation identity, validation and readonly data. */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

const RAW_DIGEST = /^[0-9a-f]{64}$/;
export const ARCHIVE_PUBLICATION_PREPARATION_IDENTITY = /^sha256:[0-9a-f]{64}$/;
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
    !ARCHIVE_PUBLICATION_PREPARATION_IDENTITY.test(value.preparationIdentity) ||
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
    throw archivePublicationPreparationInvalid();
  }
  const { preparationIdentity, ...body } = value;
  if (preparationIdentity !== digest(canonicalJson(body))) {
    throw archivePublicationPreparationInvalid();
  }
  return Object.freeze(
    structuredClone(value),
  ) as ArchivePublicationPreparationV1;
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

export function archivePublicationPreparationInvalid() {
  return workflowError(
    'ARCHIVE_PR_PREPARATION_INVALID',
    'Archive publication preparation is malformed or stale.',
    ExitCode.guard,
  );
}
