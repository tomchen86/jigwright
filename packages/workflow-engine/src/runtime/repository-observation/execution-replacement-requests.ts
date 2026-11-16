/**
 * Observes canonical replacement requests in a repository's private store.
 *
 * Invariants:
 * - Enumeration does not create directories or require binding publication.
 * - Sorted entries are validated and read individually in that order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { replacementUnsafe } from '../../modules/provider-orchestration/execution-replacement-records.ts';
import { assertPrivateInvestigationDirectory } from '../journal-primitives/investigation-private-files.ts';
import { readPersistedRequest } from '../storage-journal/execution-replacement-records.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from './investigation-runtime-context.ts';

export function listExecutionReplacementGrantRequestDigests(
  cwd: string,
): readonly string[] {
  const context = loadInvestigationRuntimeContext(cwd);
  const requestsDirectory = path.join(
    context.lifecycleRuntime.root,
    'execution-replacements',
    'requests',
  );
  const stats = fs.lstatSync(requestsDirectory, { throwIfNoEntry: false });
  if (stats === undefined) return Object.freeze([]);
  assertPrivateInvestigationDirectory(
    context.runtime,
    requestsDirectory,
    replacementUnsafe,
  );
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(requestsDirectory) !== requestsDirectory
  ) {
    throw replacementUnsafe();
  }
  const requestDigests = fs
    .readdirSync(requestsDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const match = entry.name.match(/^([0-9a-f]{64})\.json$/);
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        throw replacementUnsafe();
      }
      const requestDigest = `sha256:${match[1]!}`;
      readPersistedRequest(
        context.runtime,
        context.lifecycleRuntime.root,
        requestDigest,
      );
      return requestDigest;
    });
  return Object.freeze(requestDigests);
}
