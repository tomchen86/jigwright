/**
 * Recovers audit maintenance journals and advances retained-prefix checkpoints before pruning.
 *
 * Invariants:
 * - The durable journal and tombstone precede checkpoint publication and prefix deletion.
 * - Checkpoint history remains linked to exact policy, predecessor, and destruction evidence.
 * - Recovery preserves every publication, directory-fsync, and journal-removal boundary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type Sha256Digest,
  type AuthorityAuditProfile,
  type AuthorityAuditRetentionCheckpoint,
  deepFreeze,
  type AuthorityAuditDestructionTombstone,
  type AuthorityAuditMaintenanceJournal,
  type AuthorityAuditLedgerPaths,
  type AuthorityAuditMaintenanceHooks,
  MAX_METADATA_BYTES,
  FINAL_RECORD_NAME,
  MAX_RECORD_BYTES,
  RETENTION_CHECKPOINT_KEYS,
  MAINTENANCE_JOURNAL_KEYS,
  type AuthorityAuditCompactionResult,
} from './authority-audit-contracts.ts';
import {
  maintenanceInvalid,
  sha256Digest,
  destructionTombstoneInvalid,
  invalidLedger,
  unsafeFilesystem,
  parseJson,
  isPlainRecord,
  hasExactKeys,
  isCanonicalTimestamp,
  assertNullableDigest,
  assertDigest,
} from './authority-audit-values.ts';
import {
  authorityAuditPolicyDigest,
  assertAuditProfile,
} from './authority-audit-layout.ts';
import {
  canonicalTombstone,
  readDestructionTombstones,
  parseDestructionTombstone,
  assertDestructionTombstone,
} from './authority-audit-destruction-records.ts';
import {
  writeExclusivePrivateFile,
  fsyncDirectory,
  readExactPrivateFile,
  publishImmutableObject,
  readRecordPath,
} from './authority-audit-private-files.ts';
import { parseCanonicalRecord } from './authority-audit-record-codec.ts';

export function createRetentionCheckpoint(
  input: Readonly<{
    repositoryId: Sha256Digest;
    profile: AuthorityAuditProfile;
    prunedThroughSequence: number;
    prunedThroughRecordDigest: Sha256Digest;
    prunedAt: string;
    reason: 'development-retention' | 'protected-destruction';
    grantDigest: Sha256Digest | null;
    tombstoneDigest: Sha256Digest | null;
    previousCheckpoint: AuthorityAuditRetentionCheckpoint | null;
  }>,
): AuthorityAuditRetentionCheckpoint {
  if (
    input.previousCheckpoint !== null &&
    (input.previousCheckpoint.repositoryId !== input.repositoryId ||
      input.previousCheckpoint.profile !== input.profile ||
      input.prunedThroughSequence <=
        input.previousCheckpoint.prunedThroughSequence ||
      Date.parse(input.prunedAt) <
        Date.parse(input.previousCheckpoint.prunedAt))
  ) {
    throw maintenanceInvalid();
  }
  const checkpoint: AuthorityAuditRetentionCheckpoint = deepFreeze({
    schemaVersion: 1,
    kind: 'authority-audit-retention-checkpoint.v1',
    repositoryId: input.repositoryId,
    profile: input.profile,
    policyDigest: authorityAuditPolicyDigest(input.profile),
    prunedThroughSequence: input.prunedThroughSequence,
    prunedThroughRecordDigest: input.prunedThroughRecordDigest,
    prunedAt: input.prunedAt,
    reason: input.reason,
    grantDigest: input.grantDigest,
    tombstoneDigest: input.tombstoneDigest,
    previousCheckpointDigest: checkpointDigest(input.previousCheckpoint),
  });
  return assertRetentionCheckpoint(checkpoint);
}

export function createMaintenanceJournal(
  checkpoint: AuthorityAuditRetentionCheckpoint,
  tombstone: AuthorityAuditDestructionTombstone | null,
): AuthorityAuditMaintenanceJournal {
  const tombstoneDigest =
    tombstone === null ? null : sha256Digest(canonicalTombstone(tombstone));
  if (checkpoint.tombstoneDigest !== tombstoneDigest) {
    throw maintenanceInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'authority-audit-maintenance-journal.v1',
    repositoryId: checkpoint.repositoryId,
    checkpoint,
    checkpointDigest: sha256Digest(canonicalCheckpoint(checkpoint)),
    tombstone,
    tombstoneDigest,
  });
}

export function executeAuditMaintenance(
  paths: AuthorityAuditLedgerPaths,
  journal: AuthorityAuditMaintenanceJournal,
  hooks: AuthorityAuditMaintenanceHooks,
): void {
  if (fs.lstatSync(paths.maintenanceJournal, { throwIfNoEntry: false })) {
    throw maintenanceInvalid();
  }
  writeExclusivePrivateFile(
    paths.maintenanceJournal,
    canonicalMaintenanceJournal(journal),
    maintenanceInvalid,
    hooks.testAfterJournalPreparation,
  );
  fsyncDirectory(paths.metadata);
  completeAuditMaintenance(paths, journal, hooks);
}

export function recoverAuditMaintenance(
  paths: AuthorityAuditLedgerPaths,
  profile: AuthorityAuditProfile,
): void {
  const journalStats = fs.lstatSync(paths.maintenanceJournal, {
    throwIfNoEntry: false,
  });
  if (journalStats === undefined) {
    if (
      fs.lstatSync(paths.retentionCheckpointNext, { throwIfNoEntry: false })
    ) {
      throw maintenanceInvalid();
    }
    return;
  }
  const journal = parseMaintenanceJournal(
    readExactPrivateFile(
      paths.maintenanceJournal,
      MAX_METADATA_BYTES,
      maintenanceInvalid,
    ),
  );
  if (
    journal.repositoryId !==
      (`sha256:${path.basename(paths.repository)}` as Sha256Digest) ||
    journal.checkpoint.profile !== profile
  ) {
    throw maintenanceInvalid();
  }
  completeAuditMaintenance(paths, journal, {});
}

function completeAuditMaintenance(
  paths: AuthorityAuditLedgerPaths,
  journal: AuthorityAuditMaintenanceJournal,
  hooks: AuthorityAuditMaintenanceHooks,
): void {
  if (journal.tombstone !== null) {
    const tombstonePath = path.join(
      paths.tombstones,
      `${journal.tombstone.grantDigest.slice('sha256:'.length)}.json`,
    );
    publishImmutableObject(
      tombstonePath,
      canonicalTombstone(journal.tombstone),
      destructionTombstoneInvalid,
      hooks.testAfterTombstonePreparation,
    );
    fsyncDirectory(paths.tombstones);
  }
  hooks.testAfterTombstonePublication?.();
  publishRetentionCheckpoint(paths, journal.checkpoint, hooks);
  hooks.testAfterCheckpointPublication?.();
  removePrunedAuditPrefix(paths, journal.checkpoint, hooks);
  fs.unlinkSync(paths.maintenanceJournal);
  fsyncDirectory(paths.metadata);
}

function publishRetentionCheckpoint(
  paths: AuthorityAuditLedgerPaths,
  next: AuthorityAuditRetentionCheckpoint,
  hooks: AuthorityAuditMaintenanceHooks,
): void {
  const nextBytes = canonicalCheckpoint(next);
  const current = readRetentionCheckpoint(
    paths,
    next.repositoryId,
    next.profile,
  );
  if (current !== null && canonicalCheckpoint(current) === nextBytes) {
    if (
      fs.lstatSync(paths.retentionCheckpointNext, { throwIfNoEntry: false })
    ) {
      const prepared = readExactPrivateFile(
        paths.retentionCheckpointNext,
        MAX_METADATA_BYTES,
        maintenanceInvalid,
      );
      if (prepared !== nextBytes) throw maintenanceInvalid();
      fs.unlinkSync(paths.retentionCheckpointNext);
      fsyncDirectory(paths.metadata);
    }
    return;
  }
  if (checkpointDigest(current) !== next.previousCheckpointDigest) {
    throw maintenanceInvalid();
  }
  const preparedStats = fs.lstatSync(paths.retentionCheckpointNext, {
    throwIfNoEntry: false,
  });
  if (preparedStats === undefined) {
    writeExclusivePrivateFile(
      paths.retentionCheckpointNext,
      nextBytes,
      maintenanceInvalid,
      hooks.testAfterCheckpointPreparation,
    );
    fsyncDirectory(paths.metadata);
  } else if (
    readExactPrivateFile(
      paths.retentionCheckpointNext,
      MAX_METADATA_BYTES,
      maintenanceInvalid,
    ) !== nextBytes
  ) {
    throw maintenanceInvalid();
  }
  fs.renameSync(paths.retentionCheckpointNext, paths.retentionCheckpoint);
  fsyncDirectory(paths.metadata);
  if (
    canonicalCheckpoint(
      readRetentionCheckpoint(paths, next.repositoryId, next.profile)!,
    ) !== nextBytes
  ) {
    throw maintenanceInvalid();
  }
}

function removePrunedAuditPrefix(
  paths: AuthorityAuditLedgerPaths,
  checkpoint: AuthorityAuditRetentionCheckpoint,
  hooks: AuthorityAuditMaintenanceHooks,
): void {
  const names = fs.readdirSync(paths.records).sort();
  const retainedResultDigests = new Set<Sha256Digest>();
  for (const name of names) {
    const match = FINAL_RECORD_NAME.exec(name);
    if (match === null || match[1] === undefined) throw invalidLedger();
    if (Number(match[1]) <= checkpoint.prunedThroughSequence) continue;
    retainedResultDigests.add(
      parseCanonicalRecord(
        readRecordPath(path.join(paths.records, name), [1]).content,
      ).resultDigest,
    );
  }
  for (const name of names) {
    const match = FINAL_RECORD_NAME.exec(name);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw invalidLedger();
    }
    const sequence = Number(match[1]);
    if (sequence > checkpoint.prunedThroughSequence) continue;
    const recordPath = path.join(paths.records, name);
    const stored = readRecordPath(recordPath, [1]);
    const record = parseCanonicalRecord(stored.content);
    if (
      record.repositoryId !== checkpoint.repositoryId ||
      record.sequence !== sequence ||
      sha256Digest(stored.content).slice('sha256:'.length) !== match[2]
    ) {
      throw invalidLedger();
    }
    const eventPath = path.join(
      paths.events,
      `${record.resultDigest.slice('sha256:'.length)}.json`,
    );
    if (
      !retainedResultDigests.has(record.resultDigest) &&
      fs.lstatSync(eventPath, { throwIfNoEntry: false })
    ) {
      const eventBytes = readExactPrivateFile(
        eventPath,
        MAX_RECORD_BYTES,
        unsafeFilesystem,
      );
      if (sha256Digest(eventBytes) !== record.resultDigest) {
        throw invalidLedger();
      }
      fs.unlinkSync(eventPath);
      fsyncDirectory(paths.events);
    }
    fs.unlinkSync(recordPath);
    fsyncDirectory(paths.records);
    hooks.testAfterEntryRemoval?.();
  }
  if (
    fs.readdirSync(paths.records).some((name) => {
      const match = FINAL_RECORD_NAME.exec(name);
      return (
        match !== null && Number(match[1]) <= checkpoint.prunedThroughSequence
      );
    })
  ) {
    throw maintenanceInvalid();
  }
}

export function readRetentionCheckpoint(
  paths: AuthorityAuditLedgerPaths,
  repositoryId: Sha256Digest,
  profile: AuthorityAuditProfile,
): AuthorityAuditRetentionCheckpoint | null {
  const stats = fs.lstatSync(paths.retentionCheckpoint, {
    throwIfNoEntry: false,
  });
  if (stats === undefined) {
    if (
      profile === 'protected' &&
      fs.readdirSync(paths.tombstones).length > 0 &&
      !fs.lstatSync(paths.maintenanceJournal, { throwIfNoEntry: false })
    ) {
      throw maintenanceInvalid();
    }
    return null;
  }
  const checkpoint = parseRetentionCheckpoint(
    readExactPrivateFile(
      paths.retentionCheckpoint,
      MAX_METADATA_BYTES,
      maintenanceInvalid,
    ),
  );
  if (
    checkpoint.repositoryId !== repositoryId ||
    checkpoint.profile !== profile ||
    checkpoint.policyDigest !== authorityAuditPolicyDigest(profile)
  ) {
    throw maintenanceInvalid();
  }
  if (profile === 'protected') {
    assertProtectedCheckpointTombstoneBinding(paths, checkpoint);
    if (!fs.lstatSync(paths.maintenanceJournal, { throwIfNoEntry: false })) {
      const reconstructed = reconstructProtectedCheckpointHistory(paths);
      if (
        reconstructed.length === 0 ||
        canonicalCheckpoint(reconstructed.at(-1)!) !==
          canonicalCheckpoint(checkpoint)
      ) {
        throw destructionTombstoneInvalid();
      }
    }
  }
  return checkpoint;
}

function reconstructProtectedCheckpointHistory(
  paths: AuthorityAuditLedgerPaths,
): AuthorityAuditRetentionCheckpoint[] {
  const tombstones = readDestructionTombstones(paths).sort(
    (left, right) =>
      left.destroyedThroughSequence - right.destroyedThroughSequence,
  );
  const grantIds = new Set<string>();
  const checkpoints: AuthorityAuditRetentionCheckpoint[] = [];
  let previous: AuthorityAuditRetentionCheckpoint | null = null;
  for (const tombstone of tombstones) {
    const grantId = tombstone.grantEnvelope.payload.grantId;
    if (
      grantIds.has(grantId) ||
      tombstone.previousCheckpointDigest !== checkpointDigest(previous)
    ) {
      throw destructionTombstoneInvalid();
    }
    grantIds.add(grantId);
    const checkpoint = createRetentionCheckpoint({
      repositoryId: tombstone.repositoryId,
      profile: 'protected',
      prunedThroughSequence: tombstone.destroyedThroughSequence,
      prunedThroughRecordDigest: tombstone.destroyedThroughRecordDigest,
      prunedAt: tombstone.destroyedAt,
      reason: 'protected-destruction',
      grantDigest: tombstone.grantDigest,
      tombstoneDigest: sha256Digest(canonicalTombstone(tombstone)),
      previousCheckpoint: previous,
    });
    checkpoints.push(checkpoint);
    previous = checkpoint;
  }
  return checkpoints;
}

export function protectedCheckpointDigestHistory(
  paths: AuthorityAuditLedgerPaths,
): Map<number, Sha256Digest> {
  return new Map(
    reconstructProtectedCheckpointHistory(paths).map((checkpoint) => [
      checkpoint.prunedThroughSequence,
      checkpoint.prunedThroughRecordDigest,
    ]),
  );
}

function assertProtectedCheckpointTombstoneBinding(
  paths: AuthorityAuditLedgerPaths,
  checkpoint: AuthorityAuditRetentionCheckpoint,
): void {
  if (
    checkpoint.profile !== 'protected' ||
    checkpoint.grantDigest === null ||
    checkpoint.tombstoneDigest === null
  ) {
    throw maintenanceInvalid();
  }
  const tombstonePath = path.join(
    paths.tombstones,
    `${checkpoint.grantDigest.slice('sha256:'.length)}.json`,
  );
  let tombstone: AuthorityAuditDestructionTombstone;
  try {
    tombstone = parseDestructionTombstone(
      readExactPrivateFile(
        tombstonePath,
        MAX_METADATA_BYTES,
        destructionTombstoneInvalid,
      ),
    );
  } catch {
    throw destructionTombstoneInvalid();
  }
  if (
    tombstone.grantDigest !== checkpoint.grantDigest ||
    sha256Digest(canonicalTombstone(tombstone)) !==
      checkpoint.tombstoneDigest ||
    tombstone.repositoryId !== checkpoint.repositoryId ||
    tombstone.destroyedThroughSequence !== checkpoint.prunedThroughSequence ||
    tombstone.destroyedThroughRecordDigest !==
      checkpoint.prunedThroughRecordDigest ||
    tombstone.destroyedAt !== checkpoint.prunedAt ||
    tombstone.previousCheckpointDigest !== checkpoint.previousCheckpointDigest
  ) {
    throw destructionTombstoneInvalid();
  }
}

function parseRetentionCheckpoint(
  bytes: string,
): AuthorityAuditRetentionCheckpoint {
  const raw = parseJson(bytes, maintenanceInvalid);
  const checkpoint = assertRetentionCheckpoint(raw);
  if (bytes !== canonicalCheckpoint(checkpoint)) throw maintenanceInvalid();
  return checkpoint;
}

function assertRetentionCheckpoint(
  raw: unknown,
): AuthorityAuditRetentionCheckpoint {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, RETENTION_CHECKPOINT_KEYS) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== 'authority-audit-retention-checkpoint.v1' ||
    !Number.isSafeInteger(raw.prunedThroughSequence) ||
    typeof raw.prunedThroughSequence !== 'number' ||
    raw.prunedThroughSequence < 1 ||
    !isCanonicalTimestamp(raw.prunedAt) ||
    (raw.reason !== 'development-retention' &&
      raw.reason !== 'protected-destruction')
  ) {
    throw maintenanceInvalid();
  }
  const profile = assertAuditProfile(raw.profile, maintenanceInvalid);
  const grantDigest = assertNullableDigest(raw.grantDigest, maintenanceInvalid);
  const tombstoneDigest = assertNullableDigest(
    raw.tombstoneDigest,
    maintenanceInvalid,
  );
  if (
    (profile === 'development' &&
      (raw.reason !== 'development-retention' ||
        grantDigest !== null ||
        tombstoneDigest !== null)) ||
    (profile === 'protected' &&
      (raw.reason !== 'protected-destruction' ||
        grantDigest === null ||
        tombstoneDigest === null))
  ) {
    throw maintenanceInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'authority-audit-retention-checkpoint.v1',
    repositoryId: assertDigest(raw.repositoryId, maintenanceInvalid),
    profile,
    policyDigest: assertDigest(raw.policyDigest, maintenanceInvalid),
    prunedThroughSequence: raw.prunedThroughSequence,
    prunedThroughRecordDigest: assertDigest(
      raw.prunedThroughRecordDigest,
      maintenanceInvalid,
    ),
    prunedAt: raw.prunedAt,
    reason: raw.reason,
    grantDigest,
    tombstoneDigest,
    previousCheckpointDigest: assertNullableDigest(
      raw.previousCheckpointDigest,
      maintenanceInvalid,
    ),
  });
}

function canonicalCheckpoint(
  checkpoint: AuthorityAuditRetentionCheckpoint,
): string {
  return `${canonicalJson(assertRetentionCheckpoint(checkpoint))}\n`;
}

export function checkpointDigest(
  checkpoint: AuthorityAuditRetentionCheckpoint | null,
): Sha256Digest | null {
  return checkpoint === null
    ? null
    : sha256Digest(canonicalCheckpoint(checkpoint));
}

function parseMaintenanceJournal(
  bytes: string,
): AuthorityAuditMaintenanceJournal {
  const raw = parseJson(bytes, maintenanceInvalid);
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, MAINTENANCE_JOURNAL_KEYS) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== 'authority-audit-maintenance-journal.v1'
  ) {
    throw maintenanceInvalid();
  }
  const checkpoint = assertRetentionCheckpoint(raw.checkpoint);
  const checkpointValueDigest = assertDigest(
    raw.checkpointDigest,
    maintenanceInvalid,
  );
  const tombstone =
    raw.tombstone === null ? null : assertDestructionTombstone(raw.tombstone);
  const tombstoneDigest = assertNullableDigest(
    raw.tombstoneDigest,
    maintenanceInvalid,
  );
  const journal: AuthorityAuditMaintenanceJournal = deepFreeze({
    schemaVersion: 1,
    kind: 'authority-audit-maintenance-journal.v1',
    repositoryId: assertDigest(raw.repositoryId, maintenanceInvalid),
    checkpoint,
    checkpointDigest: checkpointValueDigest,
    tombstone,
    tombstoneDigest,
  });
  if (
    journal.repositoryId !== checkpoint.repositoryId ||
    checkpointValueDigest !== sha256Digest(canonicalCheckpoint(checkpoint)) ||
    tombstoneDigest !==
      (tombstone === null
        ? null
        : sha256Digest(canonicalTombstone(tombstone))) ||
    checkpoint.tombstoneDigest !== tombstoneDigest ||
    bytes !== canonicalMaintenanceJournal(journal)
  ) {
    throw maintenanceInvalid();
  }
  return journal;
}

function canonicalMaintenanceJournal(
  journal: AuthorityAuditMaintenanceJournal,
): string {
  return `${canonicalJson(journal)}\n`;
}

export function compactionResult(
  profile: AuthorityAuditProfile,
  pruned: number,
  retained: number,
  checkpoint: AuthorityAuditRetentionCheckpoint | null,
): AuthorityAuditCompactionResult {
  return deepFreeze({
    schemaVersion: 1,
    kind: 'authority-audit-compaction.v1',
    profile,
    pruned,
    retained,
    prunedThroughSequence: checkpoint?.prunedThroughSequence ?? 0,
    prunedThroughRecordDigest: checkpoint?.prunedThroughRecordDigest ?? null,
    checkpointDigest: checkpointDigest(checkpoint),
  });
}
