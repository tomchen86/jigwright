/**
 * Defines authority audit schemas, policy constants, and immutable evidence types.
 *
 * Invariants:
 * - Field names, policy values, and public discriminants retain their persisted meaning.
 * - Frozen policy objects retain their existing recursive immutability.
 *
 * Depends on: audit record, profile, anchor, destruction, and maintenance contracts.
 * Failure modes: schema drift, changed policy digests, or incompatible evidence readers.
 */
export const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PREPARED_LOCK_ALIAS = /^append\.lock\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
export const LOCK_RECLAIM_CLAIM = /^append\.lock\.reclaim\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CANONICAL_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
export const FINAL_RECORD_NAME = /^([0-9]{16})-([0-9a-f]{64})\.json$/;
export const PUBLICATION_RECORD_NAME = /^\.([0-9]{16})-([0-9a-f]{64})\.json\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/;
export const PRIVATE_PUBLICATION_NAME = /^\.(.+)\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/;
export const MAX_PATH_BYTES = 4_096;
export const MAX_REPOSITORY_ID_BYTES = 512;
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
];
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
];
export const SCOPE_KEYS = [
    'externalAuditRoot',
    'repositoryId',
    'repositoryRoot',
];
export const PROFILE_STATE_KEYS = [
    'kind',
    'policyDigest',
    'policyVersion',
    'profile',
    'repositoryId',
    'schemaVersion',
];
export const PROTECTED_CONFIGURATION_KEYS = [
    'backendId',
    'backendRoot',
    'configurationDigest',
    'destructionPublicKeyDigest',
    'destructionPublicKeyPem',
    'kind',
    'repositoryId',
    'schemaVersion',
];
export const FILESYSTEM_WORM_RECEIPT_KEYS = [
    'backendId',
    'kind',
    'objectName',
    'payloadDigest',
    'repositoryId',
    'schemaVersion',
];
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
];
export const MAINTENANCE_JOURNAL_KEYS = [
    'checkpoint',
    'checkpointDigest',
    'kind',
    'repositoryId',
    'schemaVersion',
    'tombstone',
    'tombstoneDigest',
];
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
];
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
];
export const DESTRUCTION_ENVELOPE_KEYS = [
    'kind',
    'payload',
    'schemaVersion',
    'signature',
];
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
];
export const LOCK_KEYS = [
    'kind',
    'ownerToken',
    'pid',
    'repositoryId',
    'schemaVersion',
];
export const AUTHORITY_AUDIT_EVENT_TYPES = Object.freeze([
    'abort',
    'apply-grant',
    'branch-update',
    'candidate-bundle',
    'cas',
    'command',
    'control-plane-grant',
    'error',
    'escalation-request',
    'external-effect',
    'file-change',
    'grant-consume',
    'poststate',
    'provider-invocation',
    'recovery',
    'revoke',
    'rollback',
    'supersede',
    'task-mandate',
]);
export const AUTHORITY_AUDIT_RESULTS = Object.freeze([
    'aborted',
    'failed',
    'recorded',
    'revoked',
    'rolled-back',
    'succeeded',
    'superseded',
]);
export const AUTHORITY_AUDIT_PROFILE_POLICIES = deepFreeze({
    development: {
        schemaVersion: 1,
        profile: 'development',
        maxAgeMs: 90 * 24 * 60 * 60 * 1_000,
        minimumRecentRecords: 20,
        anchorMode: 'none',
        destructionMode: 'automatic-retention-only',
    },
    protected: {
        schemaVersion: 1,
        profile: 'protected',
        maxAgeMs: null,
        minimumRecentRecords: null,
        anchorMode: 'backend-receipt',
        destructionMode: 'exact-human-grant-with-tombstone',
    },
});
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}
