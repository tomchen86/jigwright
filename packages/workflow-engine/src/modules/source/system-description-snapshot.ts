/**
 * Projects an already-read tracked tree into system document snapshot
 * accessors.
 *
 * Invariants:
 * - Paths without UTF-8 names are omitted, and object identities are
 *   returned only for regular file modes.
 */
import type { SystemDescriptionSnapshot } from './spec-ownership.ts';

export type SystemTrackedTree = Readonly<{
  entries: readonly Readonly<{
    path: Readonly<{ utf8: string | null }>;
    content?: Buffer;
    objectId: string;
    mode: string;
  }>[];
}>;

export function snapshotFromTrackedTree(
  snapshot: SystemTrackedTree,
): SystemDescriptionSnapshot {
  const entries = new Map(
    snapshot.entries.flatMap((entry) =>
      entry.path.utf8 === null
        ? []
        : [[entry.path.utf8, entry.content?.toString('utf8')] as const],
    ),
  );
  return {
    listPaths: () => [...entries.keys()],
    readText: (file) => entries.get(file),
    readBytes: (file) =>
      snapshot.entries.find((entry) => entry.path.utf8 === file)?.content ??
      undefined,
    readObjectId: (file) => {
      const entry = snapshot.entries.find((entry) => entry.path.utf8 === file);
      return entry && ['100644', '100755'].includes(entry.mode)
        ? entry.objectId
        : undefined;
    },
  };
}
