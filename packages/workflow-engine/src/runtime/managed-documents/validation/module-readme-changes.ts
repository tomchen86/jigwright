/**
 * Finds module changes relative to each README explanation confirmation.
 *
 * Invariants:
 * - README comparisons consider only handwritten explanation text;
 *   generated reference sections do not count as explanation changes.
 */
import crypto from 'node:crypto';
import { readModuleReadmeWhy } from '../../../modules/source/module-readme.ts';
import type { SystemDescriptionSnapshot } from '../../../modules/source/spec-ownership.ts';
import { readSystemDescriptionSnapshot } from '../../repository-transaction/system-description-snapshot.ts';

export function moduleChangesSinceConfirmation(
  repositoryRoot: string,
  current: SystemDescriptionSnapshot,
) {
  const baselines = new Map<string, SystemDescriptionSnapshot>();
  return (directory: string, commit: string): string[] => {
    const before =
      baselines.get(commit) ??
      readSystemDescriptionSnapshot(repositoryRoot, commit);
    baselines.set(commit, before);
    return [...new Set([...before.listPaths(), ...current.listPaths()])]
      .filter((file) => {
        if (!file.startsWith(`${directory}/`)) return false;
        if (file.endsWith('/README.md')) {
          return (
            readModuleReadmeWhy(before.readText(file) ?? '')?.text !==
            readModuleReadmeWhy(current.readText(file) ?? '')?.text
          );
        }
        return (
          objectId(before, file, commit) !== objectId(current, file, commit)
        );
      })
      .sort();
  };
}

function objectId(
  snapshot: SystemDescriptionSnapshot,
  file: string,
  commit: string,
): string | undefined {
  const existing = snapshot.readObjectId?.(file);
  if (existing) return existing;
  const content =
    snapshot.readBytes?.(file) ??
    (snapshot.readText(file) === undefined
      ? undefined
      : Buffer.from(snapshot.readText(file)!));
  return content === undefined
    ? undefined
    : crypto
        .createHash(commit.length === 64 ? 'sha256' : 'sha1')
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest('hex');
}
