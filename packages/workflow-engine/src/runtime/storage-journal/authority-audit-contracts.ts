import { MAX_REPOSITORY_ID_BYTES } from '../../modules/authority/authority-audit-contract.ts';
export { MAX_REPOSITORY_ID_BYTES } from '../../modules/authority/authority-audit-contract.ts';
/**
 * Defines authority audit schemas, policy constants, and immutable evidence types.
 *
 * Invariants:
 * - Field names, policy values, and public discriminants retain their persisted meaning.
 * - Frozen policy objects retain their existing recursive immutability.
 */

export const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PREPARED_LOCK_ALIAS =
  /^append\.lock\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export const LOCK_RECLAIM_CLAIM =
  /^append\.lock\.reclaim\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const CANONICAL_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export const FINAL_RECORD_NAME = /^([0-9]{16})-([0-9a-f]{64})\.json$/;

export const PUBLICATION_RECORD_NAME =
  /^\.([0-9]{16})-([0-9a-f]{64})\.json\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/;

export const PRIVATE_PUBLICATION_NAME =
  /^\.(.+)\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/;

export const MAX_PATH_BYTES = 4_096;

export const MAX_RECORD_BYTES = 4_096;

export const MAX_METADATA_BYTES = 32_768;

export const MAX_ANCHOR_BACKEND_RECEIPT_BYTES = 16_384;

export const MAX_DESTRUCTION_SIGNATURE_BYTES = 8_192;

export const AUDIT_DESTRUCTION_GRANT_MAX_TTL_MS = 10 * 60 * 1_000;

export const AUDIT_EVENT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export const LOCK_NAME = 'append.lock';

export const PROFILE_STATE_NAME = 'profile.json';

export const PROTECTED_CONFIGURATION_NAME = 'protected-configuration.json';

export const RETENTION_CHECKPOINT_NAME = 'retention-checkpoint.json';

export const RETENTION_CHECKPOINT_NEXT_NAME = 'retention-checkpoint.next.json';

export const MAINTENANCE_JOURNAL_NAME = 'maintenance-journal.json';

export const RECORD_KEYS = [
  'candidateBundleDigest',
  'eventType',
  'grantDigest',
  'idempotencyKey',
  'kind',
  'occurredAt',
  'poststateDigest',
  'prestateDigest',
  'previousRecordDigest',
  'repositoryId',
  'result',
  'resultDigest',
  'schemaVersion',
  'sequence',
] as const;

export const APPEND_INPUT_KEYS = [
  'candidateBundleDigest',
  'eventType',
  'grantDigest',
  'idempotencyKey',
  'occurredAt',
  'poststateDigest',
  'prestateDigest',
  'result',
  'resultDigest',
] as const;

export const SCOPE_KEYS = [
  'externalAuditRoot',
  'repositoryId',
  'repositoryRoot',
] as const;

export const PROFILE_STATE_KEYS = [
  'kind',
  'policyDigest',
  'policyVersion',
  'profile',
  'repositoryId',
  'schemaVersion',
] as const;

export const PROTECTED_CONFIGURATION_KEYS = [
  'backendId',
  'backendRoot',
  'configurationDigest',
  'destructionPublicKeyDigest',
  'destructionPublicKeyPem',
  'kind',
  'repositoryId',
  'schemaVersion',
] as const;

export const FILESYSTEM_WORM_RECEIPT_KEYS = [
  'backendId',
  'kind',
  'objectName',
  'payloadDigest',
  'repositoryId',
  'schemaVersion',
] as const;

export const RETENTION_CHECKPOINT_KEYS = [
  'grantDigest',
  'kind',
  'policyDigest',
  'previousCheckpointDigest',
  'profile',
  'prunedAt',
  'prunedThroughRecordDigest',
  'prunedThroughSequence',
  'reason',
  'repositoryId',
  'schemaVersion',
  'tombstoneDigest',
] as const;

export const MAINTENANCE_JOURNAL_KEYS = [
  'checkpoint',
  'checkpointDigest',
  'kind',
  'repositoryId',
  'schemaVersion',
  'tombstone',
  'tombstoneDigest',
] as const;

export const ANCHOR_RECEIPT_KEYS = [
  'anchoredAt',
  'backendId',
  'backendReceipt',
  'headRecordDigest',
  'headSequence',
  'kind',
  'policyDigest',
  'profile',
  'repositoryId',
  'schemaVersion',
] as const;

export const DESTRUCTION_PAYLOAD_KEYS = [
  'domain',
  'expectedHeadRecordDigest',
  'expectedHeadSequence',
  'expiresAt',
  'grantId',
  'issuedAt',
  'kind',
  'profile',
  'reasonDigest',
  'remoteAnchorDisposition',
  'repositoryId',
  'schemaVersion',
  'signerIdentity',
  'throughRecordDigest',
  'throughSequence',
  'uses',
] as const;

export const DESTRUCTION_ENVELOPE_KEYS = [
  'kind',
  'payload',
  'schemaVersion',
  'signature',
] as const;

export const DESTRUCTION_TOMBSTONE_KEYS = [
  'destroyedAt',
  'destroyedThroughRecordDigest',
  'destroyedThroughSequence',
  'expectedHeadRecordDigest',
  'expectedHeadSequence',
  'grantDigest',
  'grantEnvelope',
  'kind',
  'previousCheckpointDigest',
  'reasonDigest',
  'remoteAnchorDisposition',
  'repositoryId',
  'schemaVersion',
  'signerIdentity',
] as const;

export const LOCK_KEYS = [
  'kind',
  'ownerToken',
  'pid',
  'repositoryId',
  'schemaVersion',
] as const;

export const AUTHORITY_AUDIT_PROFILE_POLICIES = deepFreeze({
  development: {
    schemaVersion: 1 as const,
    profile: 'development' as const,
    maxAgeMs: 90 * 24 * 60 * 60 * 1_000,
    minimumRecentRecords: 20,
    anchorMode: 'none' as const,
    destructionMode: 'automatic-retention-only' as const,
  },
  protected: {
    schemaVersion: 1 as const,
    profile: 'protected' as const,
    maxAgeMs: null,
    minimumRecentRecords: null,
    anchorMode: 'backend-receipt' as const,
    destructionMode: 'exact-human-grant-with-tombstone' as const,
  },
});

export type AuthorityAuditProfilePolicy =
  (typeof AUTHORITY_AUDIT_PROFILE_POLICIES)[AuthorityAuditProfile];

export type AuthorityAuditAppendInput = Readonly<{
  eventType: AuthorityAuditEventType;
  occurredAt: string;
  idempotencyKey: Sha256Digest;
  grantDigest: Sha256Digest | null;
  candidateBundleDigest: Sha256Digest | null;
  prestateDigest: Sha256Digest | null;
  poststateDigest: Sha256Digest | null;
  result: AuthorityAuditResult;
  resultDigest: Sha256Digest;
}>;

export type AuthorityAuditLedgerPaths = Readonly<{
  externalAuditRoot: string;
  repositories: string;
  repository: string;
  events: string;
  records: string;
  locks: string;
  appendLock: string;
  metadata: string;
  profileState: string;
  protectedConfiguration: string;
  retentionCheckpoint: string;
  retentionCheckpointNext: string;
  maintenanceJournal: string;
  anchors: string;
  tombstones: string;
}>;

export type AuthorityAuditAppendOptions = Readonly<{
  /** Test seam that models a crash after durable preparation but before publish. */
  testAfterRecordPreparation?: () => void;
  /** Injectable engine clock; production callers omit it. */
  now?: () => Date;
}>;

export type AuthorityAuditProfileState = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-profile.v1';
  repositoryId: Sha256Digest;
  profile: AuthorityAuditProfile;
  policyVersion: 1;
  policyDigest: Sha256Digest;
}>;

export type AuthorityAuditRetentionCheckpoint = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-retention-checkpoint.v1';
  repositoryId: Sha256Digest;
  profile: AuthorityAuditProfile;
  policyDigest: Sha256Digest;
  prunedThroughSequence: number;
  prunedThroughRecordDigest: Sha256Digest;
  prunedAt: string;
  reason: 'development-retention' | 'protected-destruction';
  grantDigest: Sha256Digest | null;
  tombstoneDigest: Sha256Digest | null;
  previousCheckpointDigest: Sha256Digest | null;
}>;

export type AuthorityAuditDestructionTombstone = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-destruction-tombstone.v1';
  repositoryId: Sha256Digest;
  grantDigest: Sha256Digest;
  grantEnvelope: AuditDestructionGrantEnvelope;
  signerIdentity: string;
  expectedHeadSequence: number;
  expectedHeadRecordDigest: Sha256Digest;
  destroyedThroughSequence: number;
  destroyedThroughRecordDigest: Sha256Digest;
  destroyedAt: string;
  reasonDigest: Sha256Digest;
  remoteAnchorDisposition: 'retain' | 'deletion-authorized';
  previousCheckpointDigest: Sha256Digest | null;
}>;

export type AuthorityAuditMaintenanceJournal = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-maintenance-journal.v1';
  repositoryId: Sha256Digest;
  checkpoint: AuthorityAuditRetentionCheckpoint;
  checkpointDigest: Sha256Digest;
  tombstone: AuthorityAuditDestructionTombstone | null;
  tombstoneDigest: Sha256Digest | null;
}>;

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

import {
  AUTHORITY_AUDIT_EVENT_TYPES,
  AUTHORITY_AUDIT_RESULTS,
  type Sha256Digest,
  type AuthorityAuditProfile,
  type AuthorityAuditEventType,
  type AuthorityAuditResult,
  type AuthorityAuditLedgerScope,
  type AuthorityAuditRecord,
  type AuthorityAuditLedgerEntry,
} from '../../modules/authority/authority-audit-contract.ts';
export {
  AUTHORITY_AUDIT_EVENT_TYPES,
  AUTHORITY_AUDIT_RESULTS,
  type Sha256Digest,
  type AuthorityAuditProfile,
  type AuthorityAuditEventType,
  type AuthorityAuditResult,
  type AuthorityAuditLedgerScope,
  type AuthorityAuditRecord,
  type AuthorityAuditLedgerEntry,
} from '../../modules/authority/authority-audit-contract.ts';

import type {
  AuthorityAuditLedgerScan,
  AuthorityAuditMaintenanceHooks,
  AuthorityAuditCompactionResult,
  AuthorityAuditAnchorBackend,
  AuthorityAuditAnchorReceipt,
  AuthorityAuditAnchorPublication,
  AuthorityAuditAnchorVerification,
  AuditDestructionGrantPayload,
  AuditDestructionGrantEnvelope,
  AuditDestructionSignatureVerifier,
  AuthorityAuditProtectedConfiguration,
} from '../../modules/authority/authority-audit-contract.ts';
export type {
  AuthorityAuditLedgerScan,
  AuthorityAuditMaintenanceHooks,
  AuthorityAuditCompactionResult,
  AuthorityAuditAnchorBackend,
  AuthorityAuditAnchorReceipt,
  AuthorityAuditAnchorPublication,
  AuthorityAuditAnchorVerification,
  AuditDestructionGrantPayload,
  AuditDestructionGrantEnvelope,
  AuditDestructionSignatureVerifier,
  AuthorityAuditProtectedConfiguration,
} from '../../modules/authority/authority-audit-contract.ts';
