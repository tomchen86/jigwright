/**
 * Supplies fixed repository text snapshots to system document and import readers.
 *
 * Invariants:
 * - Pinned reads use Git objects; working reads never follow a symlink outside the tree.
 * - Missing, binary, and unsupported source bytes remain unavailable to projections.
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeExactRepositoryPath } from '../../foundation/repository-path/repository-path.ts';
import type { SystemDescriptionSnapshot } from '../../modules/source/spec-ownership.ts';
import { runGit } from './git.ts';
import { readPinnedTrackedTree } from './tracked-tree-reader.ts';
import { snapshotFromTrackedTree } from '../../modules/source/system-description-snapshot.ts';
export { snapshotFromTrackedTree } from '../../modules/source/system-description-snapshot.ts';

export function readSystemDescriptionSnapshot(
  repositoryRoot: string,
  treeOid?: string,
): SystemDescriptionSnapshot {
  if (treeOid !== undefined)
    return snapshotFromTrackedTree(
      readPinnedTrackedTree({ repositoryRoot, treeOid }),
    );
  const files = [
    ...new Set(
      runGit(repositoryRoot, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ])
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const root = fs.realpathSync(repositoryRoot);
  const raw = new Map<string, Buffer | undefined>();
  const readBytes = (file: string): Buffer | undefined => {
    normalizeExactRepositoryPath(file);
    if (!raw.has(file)) {
      const absolute = path.join(repositoryRoot, file);
      const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
      let bytes: Buffer | undefined;
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        const relative = path.relative(root, fs.realpathSync(absolute));
        if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
          bytes = fs.readFileSync(absolute);
      }
      raw.set(file, bytes);
    }
    return raw.get(file);
  };
  const entries = new Map<string, string | undefined>();
  for (const file of files) {
    normalizeExactRepositoryPath(file);
    // Only document and source formats consumed by this feature are read.
    if (
      !/\.(?:[cm]?[jt]sx?|json|md)$/.test(file) ||
      /(?:^|\/)(?:node_modules|\.git|dist|coverage)\//.test(file) ||
      /(?:^|\/)\.env(?:\.|$)/.test(file)
    )
      continue;
    const absolute = path.join(repositoryRoot, file);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
      continue;
    const relative = path.relative(root, fs.realpathSync(absolute));
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      continue;
    const bytes = readBytes(file)!;
    const text = bytes.toString('utf8');
    if (!bytes.includes(0) && Buffer.from(text).equals(bytes))
      entries.set(file, text);
  }
  return {
    listPaths: () => files,
    readText: (file) => entries.get(file),
    readBytes,
  };
}
