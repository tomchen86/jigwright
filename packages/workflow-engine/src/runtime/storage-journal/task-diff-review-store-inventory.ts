/**
 * Enumerates private review record names and provider session namespaces.
 *
 * Invariants:
 * - Global namespaces remain excluded from provider sessions.
 * - Directory validation and filename ordering remain unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { assertPrivateInvestigationDirectory } from './investigation-private-files.ts';
import {
  type InvestigationRuntimePaths,
  assertSessionId,
} from '../session-workspace/paths.ts';
import {
  storeUnsafe,
  TASK_DIFF_REVIEW_GLOBAL_NAMESPACES,
} from './task-diff-review-store-contracts.ts';

export function listTaskDiffReviewProviderSessionIds(
  paths: InvestigationRuntimePaths,
): readonly string[] {
  const root = path.join(paths.refs, 'task-diff-reviews');
  const observed = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!observed) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, root, storeUnsafe);
  return Object.freeze(
    fs
      .readdirSync(root)
      .filter((name) => !TASK_DIFF_REVIEW_GLOBAL_NAMESPACES.has(name))
      .sort()
      .map(assertSessionId),
  );
}

export function listPrivateDigestJson(
  paths: InvestigationRuntimePaths,
  directory: string,
): readonly string[] {
  const observed = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!observed) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeUnsafe);
  const names = fs.readdirSync(directory).sort();
  const digests = names.map((name) => {
    const match = /^([0-9a-f]{64})\.json$/.exec(name);
    if (!match) throw storeUnsafe();
    return match[1]!;
  });
  if (
    new Set(digests).size !== digests.length ||
    canonicalJson(fs.readdirSync(directory).sort()) !== canonicalJson(names)
  ) {
    throw storeUnsafe();
  }
  return Object.freeze(digests);
}
