/** Reads a working or committed repository snapshot for system descriptions. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeExactRepositoryPath } from '@jigwright/core/repository-path';
import { runGit } from '../../repository-transaction/git.ts';
import type { SystemDescriptionSnapshot } from '../../../modules/source/spec-ownership.ts';

export function workingSystemDescriptionSnapshot(
  repositoryRoot: string,
): SystemDescriptionSnapshot {
  const paths = [
    ...new Set(
      runGit(repositoryRoot, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ])
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const bytes = new Map<string, Buffer | undefined>();
  const readBytes = (candidate: string): Buffer | undefined => {
    normalizeExactRepositoryPath(candidate);
    if (!bytes.has(candidate)) {
      const target = path.join(repositoryRoot, candidate);
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      bytes.set(
        candidate,
        stat?.isFile() && !stat.isSymbolicLink()
          ? fs.readFileSync(target)
          : undefined,
      );
    }
    return bytes.get(candidate);
  };
  return {
    listPaths: () => paths,
    readBytes,
    readText(candidate) {
      return readBytes(candidate)?.toString('utf8');
    },
  };
}

/** Contract metadata and its three outputs do not make their own proof stale. */
export function isSystemTestSource(candidate: string): boolean {
  return (
    !candidate.endsWith('/spec.md') &&
    candidate !== 'spec.md' &&
    !['docs/SPEC_MAP.md', 'docs/COVERAGE.md', 'docs/REQUIREMENTS.md'].includes(
      candidate,
    )
  );
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
