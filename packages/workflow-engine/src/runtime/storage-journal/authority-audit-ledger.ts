/**
 * Appends and scans the canonical authority audit chain with bounded development retention.
 *
 * Invariants:
 * - Idempotent appends retain exact event bytes and predecessor-chain identity.
 * - Recovery and retention execute under the same ledger lock before a new append.
 *
 * Depends on: ledger layout, record publication, maintenance, and lock protocols.
 * Failure modes: duplicate events, broken chain order, or an append that bypasses pending recovery.
 */
import {
  type AuthorityAuditLedgerScope,
  type AuthorityAuditAppendInput,
  type AuthorityAuditAppendOptions,
  type AuthorityAuditLedgerEntry,
  AUDIT_EVENT_MAX_FUTURE_SKEW_MS,
  type AuthorityAuditLedgerScan,
  type AuthorityAuditMaintenanceHooks,
  type AuthorityAuditCompactionResult,
  type AuthorityAuditLedgerPaths,
  type AuthorityAuditProfile,
  AUTHORITY_AUDIT_PROFILE_POLICIES,
} from './authority-audit-contracts.ts';
import {
  assertAppendInput,
  recordMatchesInput,
  freezeRecord,
  canonicalRecordContent,
  freezeEntry,
} from './authority-audit-record-codec.ts';
import {
  maintenanceInvalid,
  assertMaintenanceTimestamp,
  invalidRecord,
  idempotencyConflict,
  sha256Digest,
  protectedProfile,
} from './authority-audit-values.ts';
import { prepareLedger } from './authority-audit-layout.ts';
import { withLedgerLock } from './authority-audit-locks.ts';
import {
  recoverAuditMaintenance,
  readRetentionCheckpoint,
  compactionResult,
  createRetentionCheckpoint,
  createMaintenanceJournal,
  executeAuditMaintenance,
} from './authority-audit-maintenance.ts';
import {
  recoverRecordPublications,
  scanRecords,
  publishRecord,
} from './authority-audit-record-publication.ts';

export {
  AUTHORITY_AUDIT_EVENT_TYPES,
  AUTHORITY_AUDIT_RESULTS,
  type Sha256Digest,
  type AuthorityAuditProfile,
  type AuthorityAuditEventType,
  type AuthorityAuditResult,
  type AuthorityAuditLedgerScope,
  AUTHORITY_AUDIT_PROFILE_POLICIES,
  type AuthorityAuditProfilePolicy,
  type AuthorityAuditAppendInput,
  type AuthorityAuditRecord,
  type AuthorityAuditLedgerEntry,
  type AuthorityAuditLedgerScan,
  type AuthorityAuditLedgerPaths,
  type AuthorityAuditAppendOptions,
  type AuthorityAuditMaintenanceHooks,
  type AuthorityAuditCompactionResult,
  type AuthorityAuditAnchorBackend,
  type AuthorityAuditAnchorReceipt,
  type AuthorityAuditAnchorPublication,
  type AuthorityAuditAnchorVerification,
  type AuditDestructionGrantPayload,
  type AuditDestructionGrantEnvelope,
  type AuditDestructionSignatureVerifier,
  type AuthorityAuditProtectedConfiguration,
} from './authority-audit-contracts.ts';

export {
  deriveAuthorityAuditRepositoryId,
  authorityAuditLedgerPaths,
} from './authority-audit-layout.ts';

export {
  configureProtectedAuthorityAuditLedger,
  readProtectedAuthorityAuditConfiguration,
  createPinnedAuthorityAuditAnchorBackend,
  createPinnedAuditDestructionSignatureVerifier,
  anchorProtectedAuthorityAuditLedger,
  verifyProtectedAuthorityAuditAnchors,
  destroyProtectedAuthorityAuditLedger,
} from './authority-audit-protected.ts';

export {
  canonicalAuditDestructionGrantPayload,
  canonicalAuditDestructionGrantEnvelope,
} from './authority-audit-destruction-records.ts';

export function appendAuthorityAuditRecord(
  scope: AuthorityAuditLedgerScope,
  rawInput: AuthorityAuditAppendInput,
  options: AuthorityAuditAppendOptions = {},
): AuthorityAuditLedgerEntry {
  const input = assertAppendInput(rawInput);
  const maintenanceDate = options.now?.() ?? new Date();
  if (
    !(maintenanceDate instanceof Date) ||
    !Number.isFinite(maintenanceDate.getTime())
  ) {
    throw maintenanceInvalid();
  }
  const maintenanceNow = assertMaintenanceTimestamp(
    maintenanceDate.toISOString(),
  );
  if (
    Date.parse(input.occurredAt) >
    Date.parse(maintenanceNow) + AUDIT_EVENT_MAX_FUTURE_SKEW_MS
  ) {
    throw invalidRecord();
  }
  const prepared = prepareLedger(scope);
  return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
    recoverAuditMaintenance(prepared.paths, prepared.profile);
    recoverRecordPublications(
      prepared.paths,
      prepared.scope.repositoryId,
      prepared.profile,
    );
    const checkpoint = readRetentionCheckpoint(
      prepared.paths,
      prepared.scope.repositoryId,
      prepared.profile,
    );
    const records = scanRecords(
      prepared.paths,
      prepared.scope.repositoryId,
      false,
      checkpoint,
    );
    const duplicate = records.find(
      ({ record }) => record.idempotencyKey === input.idempotencyKey,
    );
    if (duplicate !== undefined) {
      if (!recordMatchesInput(duplicate.record, input)) {
        throw idempotencyConflict();
      }
      return duplicate;
    }

    const previous = records.at(-1);
    const previousSequence =
      previous?.record.sequence ?? checkpoint?.prunedThroughSequence ?? 0;
    const previousDigest =
      previous?.recordDigest ?? checkpoint?.prunedThroughRecordDigest ?? null;
    const record = freezeRecord({
      schemaVersion: 1,
      kind: 'authority-audit-record.v1',
      repositoryId: prepared.scope.repositoryId,
      sequence: previousSequence + 1,
      occurredAt: input.occurredAt,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      previousRecordDigest: previousDigest,
      grantDigest: input.grantDigest,
      candidateBundleDigest: input.candidateBundleDigest,
      prestateDigest: input.prestateDigest,
      poststateDigest: input.poststateDigest,
      result: input.result,
      resultDigest: input.resultDigest,
    });
    const content = canonicalRecordContent(record);
    const entry = freezeEntry({
      recordDigest: sha256Digest(content),
      record,
    });
    publishRecord(prepared.paths, entry, content, options);
    if (prepared.profile === 'development') {
      compactDevelopmentUnderLock(prepared, maintenanceNow);
    }
    return entry;
  });
}

export function scanAuthorityAuditLedger(
  scope: AuthorityAuditLedgerScope,
): AuthorityAuditLedgerScan {
  const prepared = prepareLedger(scope);
  return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
    recoverAuditMaintenance(prepared.paths, prepared.profile);
    recoverRecordPublications(
      prepared.paths,
      prepared.scope.repositoryId,
      prepared.profile,
    );
    const checkpoint = readRetentionCheckpoint(
      prepared.paths,
      prepared.scope.repositoryId,
      prepared.profile,
    );
    const records = scanRecords(
      prepared.paths,
      prepared.scope.repositoryId,
      false,
      checkpoint,
    );
    const head = records.at(-1);
    return Object.freeze({
      repositoryId: prepared.scope.repositoryId,
      profile: prepared.profile,
      recordCount: records.length,
      prunedRecordCount: checkpoint?.prunedThroughSequence ?? 0,
      headSequence:
        head?.record.sequence ?? checkpoint?.prunedThroughSequence ?? 0,
      headRecordDigest:
        head?.recordDigest ?? checkpoint?.prunedThroughRecordDigest ?? null,
      records: Object.freeze(records),
    });
  });
}

/**
 * Runs the code-owned development retention policy. The live suffix remains
 * hash-linked to a compact checkpoint; expired event objects and records are
 * physically removed. A durable journal makes every crash window converge to
 * that same checkpoint before normal append/scan work resumes.
 */
export function compactDevelopmentAuthorityAuditLedger(
  scope: AuthorityAuditLedgerScope,
  input: Readonly<{ now: string }>,
  hooks: AuthorityAuditMaintenanceHooks = {},
): AuthorityAuditCompactionResult {
  const now = assertMaintenanceTimestamp(input.now);
  const prepared = prepareLedger(scope);
  if (prepared.profile !== 'development') throw protectedProfile();
  return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
    recoverAuditMaintenance(prepared.paths, prepared.profile);
    recoverRecordPublications(
      prepared.paths,
      prepared.scope.repositoryId,
      prepared.profile,
    );
    return compactDevelopmentUnderLock(prepared, now, hooks);
  });
}

function compactDevelopmentUnderLock(
  prepared: Readonly<{
    scope: AuthorityAuditLedgerScope;
    paths: AuthorityAuditLedgerPaths;
    profile: AuthorityAuditProfile;
  }>,
  now: string,
  hooks: AuthorityAuditMaintenanceHooks = {},
): AuthorityAuditCompactionResult {
  if (prepared.profile !== 'development') throw protectedProfile();
  const previousCheckpoint = readRetentionCheckpoint(
    prepared.paths,
    prepared.scope.repositoryId,
    prepared.profile,
  );
  const records = scanRecords(
    prepared.paths,
    prepared.scope.repositoryId,
    false,
    previousCheckpoint,
  );
  const policy = AUTHORITY_AUDIT_PROFILE_POLICIES.development;
  const maximumPrunable = Math.max(
    0,
    records.length - policy.minimumRecentRecords,
  );
  const cutoff = Date.parse(now) - policy.maxAgeMs;
  let count = 0;
  while (
    count < maximumPrunable &&
    Date.parse(records[count]!.record.occurredAt) <= cutoff
  ) {
    count += 1;
  }
  if (count === 0) {
    return compactionResult(
      'development',
      0,
      records.length,
      previousCheckpoint,
    );
  }
  const target = records[count - 1]!;
  const checkpoint = createRetentionCheckpoint({
    repositoryId: prepared.scope.repositoryId,
    profile: 'development',
    prunedThroughSequence: target.record.sequence,
    prunedThroughRecordDigest: target.recordDigest,
    prunedAt: now,
    reason: 'development-retention',
    grantDigest: null,
    tombstoneDigest: null,
    previousCheckpoint,
  });
  const journal = createMaintenanceJournal(checkpoint, null);
  executeAuditMaintenance(prepared.paths, journal, hooks);
  return compactionResult(
    'development',
    count,
    records.length - count,
    checkpoint,
  );
}
