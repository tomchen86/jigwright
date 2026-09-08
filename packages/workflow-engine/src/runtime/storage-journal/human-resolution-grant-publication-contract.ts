/**
 * Defines and validates exact grant-publication observations and quarantine receipts.
 *
 * Invariants:
 * - File names, digests, audit identities, and phase shapes retain their current exact checks.
 * - Recovery receipts bind every observed artifact and its intended quarantine destination.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  GIT_OBJECT_ID,
  humanResolutionGrantPublicationRecoveryStale,
  isBoundedResolutionText,
} from './investigation-resolution-values.ts';
import {
  hasExactKeys,
  isDigest,
  isRecord,
  isTimestamp,
  sha256,
} from './investigation-store-values.ts';

export const HUMAN_RESOLUTION_GRANT_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

export const HUMAN_RESOLUTION_GRANT_TEMPORARY =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export type HumanResolutionGrantPublicationTemporary = {
  temporaryName: string;
  rawSha256: string;
  unsafeObservationDigest: string;
  byteLength: number;
  parsedEnvelopeGrantId: string | null;
};

export type HumanResolutionGrantPublicationStoreState = {
  grantId: string;
  temporaries: HumanResolutionGrantPublicationTemporary[];
  durable: {
    availableDigest: string | null;
    reservedDigest: string | null;
    terminalDigest: string | null;
  };
  sameGrantJournalDigest: string | null;
  sameGrantActiveJournalDigest: string | null;
  sameGrantReceiptDigest: string | null;
};

export type HumanResolutionGrantPublicationAuditTag = {
  status: 'absent' | 'present';
  tagRef: string | null;
  refObjectOid: string | null;
  objectType: string | null;
};

export type HumanResolutionGrantPublicationStateBinding = {
  auditTag: HumanResolutionGrantPublicationAuditTag;
  publicationStateDigest: string;
};

export type HumanResolutionGrantPublicationStoreInspection = {
  storeState: HumanResolutionGrantPublicationStoreState;
  preparedBinding: HumanResolutionGrantPublicationStateBinding | null;
};

export type QuarantinedHumanResolutionGrantPublication = {
  action: 'quarantined';
  grantId: string;
  publicationStateDigest: string;
};

type HumanResolutionGrantPublicationQuarantineArtifact = {
  temporaryName: string;
  rawSha256: string;
  unsafeObservationDigest: string;
  byteLength: number;
  quarantineArtifact: string;
};

export type HumanResolutionGrantPublicationQuarantineReceipt = {
  schemaVersion: 1;
  kind: 'human-resolution-grant-publication-recovery';
  recoveryId: string;
  action: 'quarantined';
  phase: 'prepared' | 'quarantined';
  grantId: string;
  publicationStateDigest: string;
  auditTag: HumanResolutionGrantPublicationAuditTag;
  publicationStoreState: HumanResolutionGrantPublicationStoreState;
  artifacts: HumanResolutionGrantPublicationQuarantineArtifact[];
  reason: string;
  recordedAt: string;
};

export function assertHumanResolutionGrantPublicationQuarantineReceipt(
  value: unknown,
  grantId: string,
): HumanResolutionGrantPublicationQuarantineReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recoveryId',
      'action',
      'phase',
      'grantId',
      'publicationStateDigest',
      'auditTag',
      'publicationStoreState',
      'artifacts',
      'reason',
      'recordedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'human-resolution-grant-publication-recovery' ||
    !isDigest(value.recoveryId) ||
    value.action !== 'quarantined' ||
    !['prepared', 'quarantined'].includes(String(value.phase)) ||
    value.grantId !== grantId ||
    !isDigest(value.publicationStateDigest) ||
    !isBoundedResolutionText(value.reason, 1024) ||
    !isTimestamp(value.recordedAt)
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const recoveryId = value.recoveryId as string;
  const publicationStateDigest = value.publicationStateDigest as string;
  if (
    recoveryId !==
    sha256(
      canonicalJson({
        schema: 'human-resolution-grant-publication-quarantine.v1',
        grantId,
        publicationStateDigest,
      }),
    )
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const publicationStoreState = assertHumanResolutionGrantPublicationStoreState(
    value.publicationStoreState,
    grantId,
  );
  const auditTag = assertHumanResolutionGrantPublicationAuditTag(
    value.auditTag,
    grantId,
  );
  if (
    sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'human-resolution-grant-publication-state',
        ...publicationStoreState,
        auditTag,
      }),
    ) !== publicationStateDigest
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length === 0 ||
    value.artifacts.length !== publicationStoreState.temporaries.length
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const artifacts = value.artifacts.map((artifact, index) =>
    assertHumanResolutionGrantPublicationQuarantineArtifact(
      artifact,
      grantId,
      recoveryId,
      index,
      publicationStoreState.temporaries[index],
    ),
  );
  if (
    artifacts.some(
      (artifact, index) =>
        index > 0 &&
        artifact.temporaryName <= artifacts[index - 1]!.temporaryName,
    )
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationQuarantineReceipt;
}

function assertHumanResolutionGrantPublicationAuditTag(
  value: unknown,
  grantId: string,
): HumanResolutionGrantPublicationAuditTag {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['status', 'tagRef', 'refObjectOid', 'objectType']) ||
    !['absent', 'present'].includes(String(value.status)) ||
    (value.tagRef !== null && typeof value.tagRef !== 'string') ||
    (value.refObjectOid !== null &&
      (typeof value.refObjectOid !== 'string' ||
        !GIT_OBJECT_ID.test(value.refObjectOid))) ||
    (value.objectType !== null && typeof value.objectType !== 'string') ||
    (value.status === 'absent' &&
      (value.tagRef !== null ||
        value.refObjectOid !== null ||
        value.objectType !== null)) ||
    (value.status === 'present' &&
      (value.tagRef === null ||
        value.refObjectOid === null ||
        value.objectType !== 'tag' ||
        !value.tagRef.endsWith(`/resolution-${grantId}`)))
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationAuditTag;
}

function assertHumanResolutionGrantPublicationQuarantineArtifact(
  value: unknown,
  grantId: string,
  recoveryId: string,
  index: number,
  temporary: HumanResolutionGrantPublicationTemporary | undefined,
): HumanResolutionGrantPublicationQuarantineArtifact {
  if (
    !temporary ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'temporaryName',
      'rawSha256',
      'unsafeObservationDigest',
      'byteLength',
      'quarantineArtifact',
    ]) ||
    typeof value.temporaryName !== 'string' ||
    HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(value.temporaryName)?.[1] !==
      grantId ||
    value.temporaryName !== temporary.temporaryName ||
    value.rawSha256 !== temporary.rawSha256 ||
    value.unsafeObservationDigest !== temporary.unsafeObservationDigest ||
    value.byteLength !== temporary.byteLength ||
    value.quarantineArtifact !==
      `${recoveryId}.${index + 1}.grant-publication.artifact`
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationQuarantineArtifact;
}

function assertHumanResolutionGrantPublicationStoreState(
  value: unknown,
  grantId: string,
): HumanResolutionGrantPublicationStoreState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'grantId',
      'temporaries',
      'durable',
      'sameGrantJournalDigest',
      'sameGrantActiveJournalDigest',
      'sameGrantReceiptDigest',
    ]) ||
    value.grantId !== grantId ||
    !Array.isArray(value.temporaries) ||
    !isRecord(value.durable) ||
    !hasExactKeys(value.durable, [
      'availableDigest',
      'reservedDigest',
      'terminalDigest',
    ]) ||
    ![
      value.durable.availableDigest,
      value.durable.reservedDigest,
      value.durable.terminalDigest,
      value.sameGrantJournalDigest,
      value.sameGrantActiveJournalDigest,
      value.sameGrantReceiptDigest,
    ].every((candidate) => candidate === null || isDigest(candidate))
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const temporaries = value.temporaries.map((temporary) =>
    assertHumanResolutionGrantPublicationTemporary(temporary, grantId),
  );
  if (
    temporaries.length === 0 ||
    temporaries.some(
      (temporary, index) =>
        index > 0 &&
        temporary.temporaryName <= temporaries[index - 1]!.temporaryName,
    )
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationStoreState;
}

function assertHumanResolutionGrantPublicationTemporary(
  value: unknown,
  grantId: string,
): HumanResolutionGrantPublicationTemporary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'temporaryName',
      'rawSha256',
      'unsafeObservationDigest',
      'byteLength',
      'parsedEnvelopeGrantId',
    ]) ||
    typeof value.temporaryName !== 'string' ||
    HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(value.temporaryName)?.[1] !==
      grantId ||
    !isDigest(value.rawSha256) ||
    !isDigest(value.unsafeObservationDigest) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    (value.parsedEnvelopeGrantId !== null &&
      (typeof value.parsedEnvelopeGrantId !== 'string' ||
        HUMAN_RESOLUTION_GRANT_FILE.exec(
          `${value.parsedEnvelopeGrantId}.json`,
        )?.[1] !== value.parsedEnvelopeGrantId))
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationTemporary;
}
