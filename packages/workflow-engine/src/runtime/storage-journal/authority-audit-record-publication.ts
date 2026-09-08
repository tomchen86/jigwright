/**
 * Publishes and recovers event records while preserving the retained canonical audit chain.
 *
 * Invariants:
 * - Prepared publication bytes and final records retain exact sequence and digest identity.
 * - Recovery validates the checkpoint boundary and predecessor chain before accepting an orphan.
 * - Publication hooks, descriptor fsync, linking, cleanup, and directory fsync keep their order.
 *
 * Depends on: record codecs, retention checkpoints, and private publication primitives.
 * Failure modes: unrecoverable orphan records, duplicate sequence publication, or a broken audit chain.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AuthorityAuditLedgerScope,
  type AuthorityAuditLedgerPaths,
  type AuthorityAuditProfile,
  type AuthorityAuditLedgerScan,
  deepFreeze,
  type Sha256Digest,
  PUBLICATION_RECORD_NAME,
  FINAL_RECORD_NAME,
  type AuthorityAuditRetentionCheckpoint,
  type AuthorityAuditLedgerEntry,
  type AuthorityAuditRecord,
  UUID_V4,
  type AuthorityAuditAppendOptions,
} from './authority-audit-contracts.ts';
import { readRetentionCheckpoint } from './authority-audit-maintenance.ts';
import {
  invalidLedger,
  unsafeFilesystem,
  isNodeError,
  sha256Digest,
} from './authority-audit-values.ts';
import {
  readRecordPath,
  fsyncDirectory,
} from './authority-audit-private-files.ts';
import {
  parseCanonicalRecord,
  freezeEntry,
  recordFileName,
} from './authority-audit-record-codec.ts';

export function scanLedgerUnderLock(
  prepared: Readonly<{
    scope: AuthorityAuditLedgerScope;
    paths: AuthorityAuditLedgerPaths;
    profile: AuthorityAuditProfile;
  }>,
): AuthorityAuditLedgerScan {
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
  return deepFreeze({
    repositoryId: prepared.scope.repositoryId,
    profile: prepared.profile,
    recordCount: records.length,
    prunedRecordCount: checkpoint?.prunedThroughSequence ?? 0,
    headSequence:
      head?.record.sequence ?? checkpoint?.prunedThroughSequence ?? 0,
    headRecordDigest:
      head?.recordDigest ?? checkpoint?.prunedThroughRecordDigest ?? null,
    records,
  });
}

export function recoverRecordPublications(
  paths: AuthorityAuditLedgerPaths,
  repositoryId: Sha256Digest,
  profile: AuthorityAuditProfile,
): void {
  const entries = fs.readdirSync(paths.records).sort();
  const publications = entries.filter((entry) =>
    PUBLICATION_RECORD_NAME.test(entry),
  );
  for (const entry of entries) {
    if (
      !FINAL_RECORD_NAME.test(entry) &&
      !PUBLICATION_RECORD_NAME.test(entry)
    ) {
      throw invalidLedger();
    }
  }

  // First remove publication aliases whose final content-addressed record is
  // already present. This restores each final file to nlink=1 before scanning.
  for (const publication of publications) {
    const parsed = parsePublication(paths, publication, repositoryId);
    const finalPath = path.join(paths.records, parsed.finalName);
    const finalStats = fs.lstatSync(finalPath, { throwIfNoEntry: false });
    if (finalStats === undefined) {
      continue;
    }
    const final = readRecordPath(finalPath, [1, 2]);
    if (
      final.content !== parsed.content ||
      (parsed.stats.nlink === 2 &&
        (parsed.stats.dev !== final.stats.dev ||
          parsed.stats.ino !== final.stats.ino))
    ) {
      throw invalidLedger();
    }
    fs.unlinkSync(parsed.path);
    fsyncDirectory(paths.records);
  }

  const checkpoint = readRetentionCheckpoint(paths, repositoryId, profile);
  let records = scanRecords(paths, repositoryId, true, checkpoint);
  for (const publication of publications) {
    const publicationPath = path.join(paths.records, publication);
    if (!fs.existsSync(publicationPath)) {
      continue;
    }
    const parsed = parsePublication(paths, publication, repositoryId);
    const finalPath = path.join(paths.records, parsed.finalName);
    const existing = fs.lstatSync(finalPath, { throwIfNoEntry: false });
    if (existing !== undefined) {
      const final = readRecordPath(finalPath, [1]);
      if (final.content !== parsed.content) {
        throw invalidLedger();
      }
      fs.unlinkSync(parsed.path);
      fsyncDirectory(paths.records);
      continue;
    }
    if (parsed.stats.nlink !== 1) {
      throw unsafeFilesystem();
    }
    const head = records.at(-1);
    const expectedPreviousSequence =
      head?.record.sequence ?? checkpoint?.prunedThroughSequence ?? 0;
    const expectedPreviousDigest =
      head?.recordDigest ?? checkpoint?.prunedThroughRecordDigest ?? null;
    if (
      parsed.record.repositoryId !== repositoryId ||
      parsed.record.sequence !== expectedPreviousSequence + 1 ||
      parsed.record.previousRecordDigest !== expectedPreviousDigest
    ) {
      throw invalidLedger();
    }
    try {
      fs.linkSync(parsed.path, finalPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
      throw invalidLedger();
    }
    fsyncDirectory(paths.records);
    fs.unlinkSync(parsed.path);
    fsyncDirectory(paths.records);
    records = scanRecords(paths, repositoryId, true, checkpoint);
  }
}

export function scanRecords(
  paths: AuthorityAuditLedgerPaths,
  repositoryId: Sha256Digest,
  allowPublications = false,
  checkpoint: AuthorityAuditRetentionCheckpoint | null = null,
): AuthorityAuditLedgerEntry[] {
  const observedNames = fs.readdirSync(paths.records).sort();
  if (
    observedNames.some(
      (name) =>
        !FINAL_RECORD_NAME.test(name) &&
        !(allowPublications && PUBLICATION_RECORD_NAME.test(name)),
    )
  ) {
    throw invalidLedger();
  }
  const names = observedNames.filter((name) => FINAL_RECORD_NAME.test(name));
  const records: AuthorityAuditLedgerEntry[] = [];
  const idempotencyKeys = new Set<string>();
  let expectedPrevious: Sha256Digest | null =
    checkpoint?.prunedThroughRecordDigest ?? null;
  let expectedSequence = (checkpoint?.prunedThroughSequence ?? 0) + 1;
  for (const name of names) {
    const match = FINAL_RECORD_NAME.exec(name);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw invalidLedger();
    }
    const sequence = Number(match[1]);
    const recordPath = path.join(paths.records, name);
    const stored = readRecordPath(recordPath, [1]);
    const record = parseCanonicalRecord(stored.content);
    const recordDigest = sha256Digest(stored.content);
    if (
      sequence !== expectedSequence ||
      record.sequence !== expectedSequence ||
      record.repositoryId !== repositoryId ||
      record.previousRecordDigest !== expectedPrevious ||
      match[2] !== recordDigest.slice('sha256:'.length) ||
      idempotencyKeys.has(record.idempotencyKey)
    ) {
      throw invalidLedger();
    }
    idempotencyKeys.add(record.idempotencyKey);
    records.push(freezeEntry({ recordDigest, record }));
    expectedPrevious = recordDigest;
    expectedSequence += 1;
  }
  return records;
}

function parsePublication(
  paths: AuthorityAuditLedgerPaths,
  name: string,
  repositoryId: Sha256Digest,
): Readonly<{
  path: string;
  finalName: string;
  content: string;
  record: AuthorityAuditRecord;
  stats: fs.Stats;
}> {
  const match = PUBLICATION_RECORD_NAME.exec(name);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    !UUID_V4.test(match[3])
  ) {
    throw invalidLedger();
  }
  const publicationPath = path.join(paths.records, name);
  const stored = readRecordPath(publicationPath, [1, 2]);
  const record = parseCanonicalRecord(stored.content);
  const digest = sha256Digest(stored.content).slice('sha256:'.length);
  if (
    record.repositoryId !== repositoryId ||
    record.sequence !== Number(match[1]) ||
    digest !== match[2]
  ) {
    throw invalidLedger();
  }
  return Object.freeze({
    path: publicationPath,
    finalName: `${match[1]}-${match[2]}.json`,
    content: stored.content,
    record,
    stats: stored.stats,
  });
}

export function publishRecord(
  paths: AuthorityAuditLedgerPaths,
  entry: AuthorityAuditLedgerEntry,
  content: string,
  options: AuthorityAuditAppendOptions,
): void {
  const digest = entry.recordDigest.slice('sha256:'.length);
  const baseName = recordFileName(entry.record.sequence, digest);
  const finalPath = path.join(paths.records, baseName);
  const publicationPath = path.join(
    paths.records,
    `.${baseName}.${crypto.randomUUID()}.publish.tmp`,
  );
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = fs.openSync(
      publicationPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor);
    if (
      !written.isFile() ||
      written.nlink !== 1 ||
      (written.mode & 0o777) !== 0o600 ||
      written.size !== Buffer.byteLength(content)
    ) {
      throw unsafeFilesystem();
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    options.testAfterRecordPreparation?.();
    fs.linkSync(publicationPath, finalPath);
    published = true;
    fsyncDirectory(paths.records);
    fs.unlinkSync(publicationPath);
    fsyncDirectory(paths.records);
    const final = readRecordPath(finalPath, [1]);
    if (final.content !== content) {
      throw invalidLedger();
    }
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    // A fully written publication file is deliberately retained. On the next
    // locked scan it is either completed as the unique valid next record or
    // rejected fail-closed. Once the hard link exists, it is an orphaned
    // durable record and must never be deleted as rollback cleanup.
    if (!published) {
      fsyncDirectory(paths.records);
    }
    throw error;
  }
}
