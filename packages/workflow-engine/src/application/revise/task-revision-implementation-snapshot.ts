/**
 * Captures exact implementation file, symlink and missing-path observations
 * during task revision.
 *
 * Invariants:
 * - File observations compare descriptor and path metadata after reading
 *   before admitting bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { TaskRevisionRuntimeBindings } from './task-revision.ts';
export type ImplementationSnapshotEntry = Readonly<{
  path: string;
  kind: 'file' | 'symlink' | 'missing';
  mode: '100644' | '100755' | '120000' | '000000';
  digest: string;
}>;

export function createTaskRevisionImplementationSnapshot(
  runtime: TaskRevisionRuntimeBindings,
) {
  const { normalizeChangedPath } = runtime;
  function snapshotImplementationPaths(
    repositoryRoot: string,
    paths: readonly string[],
  ): ImplementationSnapshotEntry[] {
    const root = fs.realpathSync(repositoryRoot);
    return [...paths].sort().map((candidate) => {
      const normalized = normalizeChangedPath(candidate);
      if (normalized !== candidate) throw revisionDrift();
      const absolute = path.resolve(root, normalized);
      if (!absolute.startsWith(`${root}${path.sep}`)) throw revisionDrift();
      const before = fs.lstatSync(absolute, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (!before) {
        return {
          path: normalized,
          kind: 'missing',
          mode: '000000',
          digest: digestBytes(Buffer.alloc(0)),
        };
      }
      if (before.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        const after = fs.lstatSync(absolute, {
          bigint: true,
          throwIfNoEntry: false,
        });
        if (!after || !sameStats(before, after)) throw revisionDrift();
        return {
          path: normalized,
          kind: 'symlink',
          mode: '120000',
          digest: digestBytes(Buffer.from(target)),
        };
      }
      if (!before.isFile()) throw revisionDrift();
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(
          absolute,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const openedBefore = fs.fstatSync(descriptor, { bigint: true });
        const bytes = fs.readFileSync(descriptor);
        const openedAfter = fs.fstatSync(descriptor, { bigint: true });
        const observed = fs.lstatSync(absolute, {
          bigint: true,
          throwIfNoEntry: false,
        });
        if (
          !openedBefore.isFile() ||
          !openedAfter.isFile() ||
          !observed ||
          !sameStats(openedBefore, openedAfter) ||
          !sameStats(openedAfter, observed)
        ) {
          throw revisionDrift();
        }
        return {
          path: normalized,
          kind: 'file',
          mode: (Number(openedAfter.mode) & 0o111) === 0 ? '100644' : '100755',
          digest: digestBytes(bytes),
        };
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    });
  }

  function sameStats(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
    );
  }

  function digestImplementationSnapshot(
    snapshot: readonly ImplementationSnapshotEntry[],
  ): string {
    return crypto
      .createHash('sha256')
      .update('task-revision-implementation-v1\0')
      .update(canonicalJson(snapshot))
      .digest('hex');
  }

  function digestValue(value: unknown): string {
    return crypto
      .createHash('sha256')
      .update(canonicalJson(value))
      .digest('hex');
  }

  function digestBytes(value: Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  function revisionDrift() {
    return workflowError(
      'REVISION_WORKTREE_DRIFT',
      'Implementation, HEAD, index, or repository identity changed during the planning-only revision lease.',
      ExitCode.staleState,
    );
  }

  return {
    snapshotImplementationPaths,
    sameStats,
    digestImplementationSnapshot,
    digestValue,
    revisionDrift,
  };
}
