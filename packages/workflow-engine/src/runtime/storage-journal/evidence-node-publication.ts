/**
 * Recovers publication aliases and verifies exact final evidence object bytes.
 *
 * Invariants:
 * - Live owners, strict prefixes, linked finals, and collisions keep distinct recovery outcomes.
 * - Alias removal and directory fsync retain their original order and ownership checks.
 *
 * Depends on: stable private reads, publication file names, and process liveness.
 * Failure modes: recovery deletes another writer’s bytes or leaves an ambiguous final object readable.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  fsyncDirectory,
  readStablePrivateFile,
} from './evidence-private-files.ts';
import {
  isNodeError,
  objectCollision,
  objectUnsafe,
} from './evidence-store-values.ts';

const EVIDENCE_PUBLICATION_TEMP_SUFFIX =
  /^([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/;

type EvidenceObjectFinalState = 'absent' | 'exact';

type EvidencePublicationAlias = {
  aliasPath: string;
  kind: 'publish';
  pid: number;
};

export function evidencePublicationAlias(objectPath: string): string {
  return `${objectPath}.${process.pid}.${crypto.randomUUID()}.publish.tmp`;
}

export function inspectEvidenceObjectFinal(
  objectPath: string,
  exactContent: Buffer,
): EvidenceObjectFinalState {
  const stats = fs.lstatSync(objectPath, { throwIfNoEntry: false });
  if (!stats) {
    return 'absent';
  }
  if (stats.nlink === 2) {
    resolveLinkedEvidenceObjectFinal(objectPath, exactContent);
    return inspectEvidenceObjectFinal(objectPath, exactContent);
  }
  if (stats.nlink !== 1) {
    throw objectUnsafe();
  }
  const observed = readStablePrivateFile(objectPath, [1], objectUnsafe);
  if (observed.bytes.equals(exactContent)) {
    return 'exact';
  }
  throw objectCollision(path.basename(objectPath, '.json'));
}

function resolveLinkedEvidenceObjectFinal(
  objectPath: string,
  exactContent: Buffer,
): void {
  const initial = fs.lstatSync(objectPath, { throwIfNoEntry: false });
  if (!initial || initial.nlink === 1) {
    return;
  }
  const final = readStablePrivateFile(
    objectPath,
    [initial.nlink],
    objectUnsafe,
  );
  const linkedAliases: Array<{
    alias: EvidencePublicationAlias;
    stats: fs.Stats;
    bytes: Buffer;
  }> = [];
  for (const alias of listEvidencePublicationAliases(objectPath)) {
    const stats = fs.lstatSync(alias.aliasPath, {
      throwIfNoEntry: false,
    });
    if (
      !stats ||
      stats.dev !== final.stats.dev ||
      stats.ino !== final.stats.ino
    ) {
      continue;
    }
    const observed = readStablePrivateFile(
      alias.aliasPath,
      [initial.nlink],
      objectUnsafe,
    );
    linkedAliases.push({
      alias,
      stats: observed.stats,
      bytes: observed.bytes,
    });
  }
  if (
    initial.nlink !== 2 ||
    linkedAliases.length !== 1 ||
    !final.bytes.equals(exactContent)
  ) {
    throw objectUnsafe();
  }
  if (
    linkedAliases[0]!.alias.kind !== 'publish' ||
    !linkedAliases[0]!.bytes.equals(exactContent)
  ) {
    throw objectUnsafe();
  }
  unlinkValidatedEvidenceAliases(
    linkedAliases.map(({ alias, stats }) => ({ alias, stats })),
    path.dirname(objectPath),
  );
}

export function reclaimEvidencePublicationAliases(
  objectPath: string,
  exactContent: Buffer,
): void {
  const objectDirectory = path.dirname(objectPath);
  const finalStats = fs.lstatSync(objectPath, { throwIfNoEntry: false });
  const finalIsExact =
    finalStats !== undefined &&
    readStablePrivateFile(
      objectPath,
      [finalStats.nlink],
      objectUnsafe,
    ).bytes.equals(exactContent);
  const aliases = listEvidencePublicationAliases(objectPath);
  const observedAliases: Array<{
    alias: EvidencePublicationAlias;
    stats: fs.Stats;
    bytes: Buffer;
    liveOtherOwner: boolean;
  }> = [];
  for (const alias of aliases) {
    const aliasStats = fs.lstatSync(alias.aliasPath, {
      throwIfNoEntry: false,
    });
    if (!aliasStats) {
      continue;
    }
    const observed = readStablePrivateFile(
      alias.aliasPath,
      [aliasStats.nlink],
      objectUnsafe,
    );
    if (
      !observed.bytes.equals(exactContent) &&
      !(
        observed.stats.nlink === 1 &&
        isStrictBufferPrefix(observed.bytes, exactContent)
      )
    ) {
      throw objectUnsafe();
    }
    if (
      observed.stats.nlink > 1 &&
      (!finalStats ||
        !finalIsExact ||
        finalStats.dev !== observed.stats.dev ||
        finalStats.ino !== observed.stats.ino ||
        finalStats.nlink !== observed.stats.nlink)
    ) {
      throw objectUnsafe();
    }
    observedAliases.push({
      alias,
      stats: observed.stats,
      bytes: observed.bytes,
      liveOtherOwner: alias.pid !== process.pid && isProcessAlive(alias.pid),
    });
  }

  const reclaimable: Array<{
    alias: EvidencePublicationAlias;
    stats: fs.Stats;
  }> = [];
  for (const observed of observedAliases) {
    if (observed.stats.nlink > 1 || !observed.liveOtherOwner) {
      reclaimable.push(observed);
    }
  }
  unlinkValidatedEvidenceAliases(reclaimable, objectDirectory);
}

function unlinkValidatedEvidenceAliases(
  reclaimable: Array<{
    alias: EvidencePublicationAlias;
    stats: fs.Stats;
  }>,
  objectDirectory: string,
): void {
  let removed = false;
  for (const { alias, stats } of reclaimable) {
    const current = fs.lstatSync(alias.aliasPath, {
      throwIfNoEntry: false,
    });
    if (!current) {
      continue;
    }
    if (
      current.dev !== stats.dev ||
      current.ino !== stats.ino ||
      current.nlink !== stats.nlink ||
      (current.mode & 0o777) !== 0o600 ||
      !current.isFile() ||
      current.isSymbolicLink()
    ) {
      throw objectUnsafe();
    }
    fs.unlinkSync(alias.aliasPath);
    removed = true;
  }
  if (removed) {
    fsyncDirectory(objectDirectory);
  }
}

function listEvidencePublicationAliases(
  objectPath: string,
): EvidencePublicationAlias[] {
  const objectDirectory = path.dirname(objectPath);
  const prefix = `${path.basename(objectPath)}.`;
  return fs
    .readdirSync(objectDirectory)
    .sort()
    .flatMap((name): EvidencePublicationAlias[] => {
      if (!name.startsWith(prefix)) {
        return [];
      }
      const match = EVIDENCE_PUBLICATION_TEMP_SUFFIX.exec(
        name.slice(prefix.length),
      );
      if (!match) {
        return [];
      }
      return [
        {
          aliasPath: path.join(objectDirectory, name),
          pid: Number(match[1]),
          kind: 'publish',
        },
      ];
    });
}

export function assertExactEvidenceObjectFinal(
  objectPath: string,
  exactContent: Buffer,
): void {
  const observed = readStablePrivateFile(objectPath, [1], objectUnsafe);
  if (!observed.bytes.equals(exactContent)) {
    throw objectCollision(path.basename(objectPath, '.json'));
  }
}

export function assertExactEvidencePublicationAlias(
  aliasPath: string,
  expected: fs.Stats,
  exactContent: Buffer,
  expectedLinkCount: number,
): void {
  const observed = readStablePrivateFile(
    aliasPath,
    [expectedLinkCount],
    objectUnsafe,
  );
  if (
    observed.stats.dev !== expected.dev ||
    observed.stats.ino !== expected.ino ||
    !observed.bytes.equals(exactContent)
  ) {
    throw objectUnsafe();
  }
}

export function unlinkOwnedEvidencePublicationAlias(
  aliasPath: string,
  expected: fs.Stats,
  objectDirectory: string,
): void {
  const current = fs.lstatSync(aliasPath, { throwIfNoEntry: false });
  if (!current) {
    return;
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    (current.mode & 0o777) !== 0o600 ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw objectUnsafe();
  }
  fs.unlinkSync(aliasPath);
  fsyncDirectory(objectDirectory);
}

function isStrictBufferPrefix(prefix: Buffer, exact: Buffer): boolean {
  return (
    prefix.byteLength < exact.byteLength &&
    exact.subarray(0, prefix.byteLength).equals(prefix)
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
}
