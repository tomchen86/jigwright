/**
 * Digests unsafe evidence paths without treating their content as trusted records.
 *
 * Invariants:
 * - Observations preserve path bytes, stable file identities, and exact bounded content digests.
 * - Changes during observation retain the original ambiguity markers.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { sha256 } from './evidence-store-values.ts';

type UnsafeObservationBytePath = string | Buffer;

type UnsafeObservationStableStats = {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export function exactUnsafePathObservationDigest(
  filePath: string,
  object: string,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: 2,
      object,
      node: observeUnsafeNode(Buffer.from(filePath)),
    }),
  );
}

function observeUnsafeNode(
  filePath: UnsafeObservationBytePath,
): Record<string, unknown> {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) {
    return { exists: false };
  }
  const stableBefore = unsafeObservationStableStats(before);
  const common = {
    exists: true,
    mode: before.mode & 0o777,
    nlink: before.nlink,
    size: before.size,
  };
  let observation: Record<string, unknown>;
  if (before.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(filePath, {
      encoding: 'buffer',
    }) as Buffer;
    observation = {
      ...common,
      kind: 'symlink',
      linkTargetBase64: linkTarget.toString('base64'),
    };
  } else if (before.isDirectory()) {
    const names = (
      fs.readdirSync(filePath, { encoding: 'buffer' }) as Buffer[]
    ).sort(Buffer.compare);
    observation = {
      ...common,
      kind: 'directory',
      entries: names.map((name) => ({
        nameBase64: name.toString('base64'),
        node: observeUnsafeNode(unsafeObservationChildPath(filePath, name)),
      })),
    };
  } else if (before.isFile()) {
    observation = {
      ...common,
      kind: 'file',
      contentDigest: digestUnsafeRegularFile(filePath, stableBefore),
    };
  } else {
    observation = {
      ...common,
      kind: 'other',
      rdev: before.rdev,
    };
  }
  const after = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !after ||
    !sameUnsafeObservationStableStats(
      stableBefore,
      unsafeObservationStableStats(after),
    )
  ) {
    throw new Error('Unsafe path changed while it was being observed.');
  }
  return observation;
}

function digestUnsafeRegularFile(
  filePath: UnsafeObservationBytePath,
  expected: UnsafeObservationStableStats,
): string {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !sameUnsafeObservationStableStats(
        expected,
        unsafeObservationStableStats(opened),
      )
    ) {
      throw new Error('Unsafe file changed before it was read.');
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const closedOver = fs.fstatSync(descriptor);
    if (
      !sameUnsafeObservationStableStats(
        expected,
        unsafeObservationStableStats(closedOver),
      )
    ) {
      throw new Error('Unsafe file changed while it was being read.');
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function unsafeObservationChildPath(
  parent: UnsafeObservationBytePath,
  name: Buffer,
): Buffer {
  const parentBytes = Buffer.isBuffer(parent) ? parent : Buffer.from(parent);
  return Buffer.concat([parentBytes, Buffer.from(path.sep), name]);
}

function unsafeObservationStableStats(
  stats: fs.Stats,
): UnsafeObservationStableStats {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameUnsafeObservationStableStats(
  left: UnsafeObservationStableStats,
  right: UnsafeObservationStableStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
