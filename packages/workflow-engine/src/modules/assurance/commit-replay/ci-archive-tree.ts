/** Canonical commit replay contracts and pure predicates. */
import path from 'node:path';
import { ExitCode } from '../../../foundation/errors/errors.ts';
import { workflowError } from '../../../foundation/errors/errors.ts';

export type TreeEntry = {
  mode: string;
  type: string;
  object: string;
  path: string;
};

export function normalizeArchivePaths(
  paths: string[],
  changeId: string,
): string[] {
  return paths
    .map((filePath) =>
      filePath.replace(
        new RegExp(
          `^(openspec/changes/archive/)\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(changeId)}(?=/|$)`,
        ),
        `$1<UTC-DATE>-${changeId}`,
      ),
    )
    .sort();
}

export function sameRelativeTree(
  before: TreeEntry[],
  beforeRoot: string,
  after: TreeEntry[],
  afterRoot: string,
): boolean {
  return (
    JSON.stringify(
      before.map(({ mode, type, object, path: filePath }) => ({
        mode,
        type,
        object,
        path: filePath.slice(beforeRoot.length + 1),
      })),
    ) ===
    JSON.stringify(
      after.map(({ mode, type, object, path: filePath }) => ({
        mode,
        type,
        object,
        path: filePath.slice(afterRoot.length + 1),
      })),
    )
  );
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replayMismatch() {
  return workflowError(
    'CI_ARCHIVE_REPLAY_MISMATCH',
    'Archive commit differs from the independently replayed transformation.',
    ExitCode.verification,
  );
}
