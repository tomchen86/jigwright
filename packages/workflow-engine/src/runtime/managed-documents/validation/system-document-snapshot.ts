/**
 * Builds system-test input identities from working snapshots or committed
 * trees.
 *
 * Invariants:
 * - The three generated proof-view documents are excluded so they cannot
 *   invalidate their own test evidence.
 */
import crypto from 'node:crypto';
import { runGit } from '../../repository-transaction/git.ts';
import type { SystemDescriptionSnapshot } from '../../../modules/source/spec-ownership.ts';

export { readSystemDescriptionSnapshot as workingSystemDescriptionSnapshot } from '../../repository-transaction/system-description-snapshot.ts';

/** Generated proof views cannot invalidate themselves; contracts remain test inputs. */
export function isSystemTestSource(candidate: string): boolean {
  return ![
    'docs/SPEC_MAP.md',
    'docs/COVERAGE.md',
    'docs/REQUIREMENTS.md',
  ].includes(candidate);
}

export function systemTestSourceBindings(
  snapshot: SystemDescriptionSnapshot,
  algorithm: 'sha1' | 'sha256' = 'sha1',
): Record<string, string> {
  return Object.fromEntries(
    snapshot
      .listPaths()
      .filter(isSystemTestSource)
      .sort()
      .flatMap((file) => {
        if (snapshot.readObjectId) {
          const objectId = snapshot.readObjectId(file);
          return objectId === undefined ? [] : [[file, objectId]];
        }
        const content = snapshot.readBytes
          ? snapshot.readBytes(file)
          : snapshot.readText(file);
        if (content === undefined) return [];
        const bytes =
          typeof content === 'string'
            ? Buffer.from(content)
            : Buffer.from(content);
        return [
          [
            file,
            crypto
              .createHash(algorithm)
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest('hex'),
          ],
        ];
      }),
  );
}

export function committedSystemTestSourceBindings(
  repositoryRoot: string,
  tree: string,
): Record<string, string> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree))
    throw new Error('Invalid evidence source tree.');
  return Object.fromEntries(
    runGit(repositoryRoot, ['ls-tree', '-r', '-z', tree])
      .split('\0')
      .filter(Boolean)
      .flatMap((line) => {
        const entry = /^100(?:644|755) blob ([0-9a-f]+)\t(.+)$/.exec(line);
        return entry && isSystemTestSource(entry[2]!)
          ? [[entry[2]!, entry[1]!]]
          : [];
      }),
  );
}
