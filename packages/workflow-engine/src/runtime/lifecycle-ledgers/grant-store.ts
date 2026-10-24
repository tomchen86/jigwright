/** File-backed Grant persistence: private files, compare-and-replace and durability. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import {
  createGrantRecordStore,
  type GrantRecordStore,
} from '../../modules/authority/grant-record-store.ts';
import {
  assertAllowedGrantChallengeIds,
  assertNoBlockingPreparedGrants,
  assertGrantRecord,
  assertChallengeId,
  storeUnsafe,
  challengeUnavailable,
  MAX_GRANT_RECORD_BYTES,
  type GrantRecord,
} from '../../modules/authority/grant-records.ts';

const RECORD_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

export type GrantStorePaths = Readonly<{
  root: string;
  records: string;
}>;

export function grantStorePaths(runtimeRoot: string): GrantStorePaths {
  const requestedRoot = path.resolve(runtimeRoot);
  const runtimeStats = fs.lstatSync(requestedRoot, { throwIfNoEntry: false });
  if (!runtimeStats?.isDirectory() || runtimeStats.isSymbolicLink()) {
    throw storeUnsafe();
  }
  const root = path.join(fs.realpathSync(requestedRoot), 'grants-v2');
  return Object.freeze({ root, records: path.join(root, 'records') });
}

export function assertGrantLifecycleBarrier(
  runtimeRoot: string,
  allowedChallengeIds: readonly string[] = [],
): void {
  const allowed = assertAllowedGrantChallengeIds(allowedChallengeIds);
  const root = path.join(path.resolve(runtimeRoot), 'grants-v2');
  const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (rootStats === undefined) return;
  const paths = grantStorePaths(runtimeRoot);
  assertNoBlockingPreparedGrants(
    createFileGrantRecordStore(paths).listPreparedGrantRecords(),
    allowed,
  );
}

function initializeGrantStore(paths: GrantStorePaths): void {
  for (const directory of [paths.root, paths.records]) {
    try {
      ensurePlainDirectory(directory);
    } catch {
      throw storeUnsafe();
    }
  }
  assertGrantStore(paths);
}

function assertGrantStore(paths: GrantStorePaths): void {
  try {
    if (
      path.dirname(paths.records) !== paths.root ||
      path.basename(paths.records) !== 'records'
    ) {
      throw storeUnsafe();
    }
    for (const directory of [paths.root, paths.records]) {
      const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (
        !stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(directory) !== path.resolve(directory)
      ) {
        throw storeUnsafe();
      }
    }
  } catch {
    throw storeUnsafe();
  }
}

function createCanonicalFile(filePath: string, value: unknown): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${canonicalJson(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } catch {
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(filePath));
}

function replaceCanonicalRecord(
  filePath: string,
  expected: GrantRecord,
  replacement: GrantRecord,
  challengeId: string,
): void {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    createCanonicalFile(temporary, replacement);
    const current = readCanonicalFile(filePath, assertGrantRecord);
    if (canonicalJson(current) !== canonicalJson(expected)) {
      throw challengeUnavailable(challengeId);
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    removeTemporaryFile(temporary);
    if (error instanceof Error && 'code' in error) throw error;
    throw storeUnsafe();
  }
}

function readOptionalCanonicalFile<T>(
  filePath: string,
  validate: (value: unknown) => T,
): T | null {
  if (!fs.lstatSync(filePath, { throwIfNoEntry: false })) return null;
  return readCanonicalFile(filePath, validate);
}

function readCanonicalFile<T>(
  filePath: string,
  validate: (value: unknown) => T,
): T {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!isPrivatePlainFile(before) || before.size > MAX_GRANT_RECORD_BYTES) {
      throw storeUnsafe();
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !isPrivatePlainFile(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_GRANT_RECORD_BYTES
    ) {
      throw storeUnsafe();
    }
    const document = fs.readFileSync(descriptor, 'utf8');
    const validated = validate(JSON.parse(document) as unknown);
    if (document !== `${canonicalJson(validated)}\n`) throw storeUnsafe();
    return validated;
  } catch {
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isPrivatePlainFile(stats: fs.Stats | undefined): stats is fs.Stats {
  return Boolean(
    stats?.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1 &&
    (stats.mode & 0o777) === 0o600,
  );
}

function removeTemporaryFile(filePath: string): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) return;
  if (!isPrivatePlainFile(stats)) throw storeUnsafe();
  fs.unlinkSync(filePath);
}

function grantRecordPath(paths: GrantStorePaths, challengeId: string): string {
  assertChallengeId(challengeId);
  return path.join(paths.records, `${challengeId}.json`);
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Bind paths only; all filesystem observations occur when an operation runs. */
export function createFileGrantRecordStore(
  paths: GrantStorePaths,
): GrantRecordStore {
  return createGrantRecordStore({
    initialize() {
      initializeGrantStore(paths);
    },
    assertAccessible() {
      assertGrantStore(paths);
    },
    read(challengeId) {
      return readOptionalCanonicalFile(
        grantRecordPath(paths, challengeId),
        assertGrantRecord,
      );
    },
    list() {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(paths.records, { withFileTypes: true });
      } catch {
        throw storeUnsafe();
      }
      const records: GrantRecord[] = [];
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw storeUnsafe();
        if (!RECORD_FILE.test(entry.name)) {
          if (/\.tmp$/.test(entry.name)) continue;
          throw storeUnsafe();
        }
        const record = readCanonicalFile(
          path.join(paths.records, entry.name),
          assertGrantRecord,
        );
        if (entry.name !== `${record.challenge.challengeId}.json`) {
          throw storeUnsafe();
        }
        records.push(record);
      }
      return Object.freeze(records);
    },
    create(challengeId, record) {
      createCanonicalFile(grantRecordPath(paths, challengeId), record);
    },
    replace(challengeId, expected, replacement) {
      replaceCanonicalRecord(
        grantRecordPath(paths, challengeId),
        expected,
        replacement,
        challengeId,
      );
    },
  });
}
