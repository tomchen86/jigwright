/**
 * Persists and replays immutable review lineage supersession edges.
 *
 * Invariants:
 * - Both complete subjects and reviews remain bound to the successor scope.
 * - Lineage records carry no independent closure or freshness authority.
 */
import {
  prepareTaskDiffReviewLineageSupersession,
  parseTaskDiffReviewLineageSupersession,
} from '../../modules/assurance/task-diff-review-binding-codec.ts';

import path from 'node:path';

import {
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
} from '../journal-primitives/investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';

import {
  type TaskDiffReviewLineageSupersessionRecord,
  assertDigest,
  storeUnsafe,
} from '../../modules/assurance/task-diff-review-binding-record.ts';
import { listPrivateDigestJson } from './task-diff-review-store-inventory.ts';

export function createTaskDiffReviewLineageSupersession(
  paths: InvestigationRuntimePaths,
  input: Parameters<typeof prepareTaskDiffReviewLineageSupersession>[0],
): TaskDiffReviewLineageSupersessionRecord {
  const record = prepareTaskDiffReviewLineageSupersession(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewLineageSupersessionPath(
      paths,
      record.predecessorReviewRecordDigest,
    ),
    record,
    storeUnsafe,
    'TASK_DIFF_REVIEW_LINEAGE_SUPERSESSION_CONFLICT',
  );
  return readTaskDiffReviewLineageSupersession(
    paths,
    record.predecessorReviewRecordDigest,
  )!;
}

export function readTaskDiffReviewLineageSupersession(
  paths: InvestigationRuntimePaths,
  requestedPredecessorReviewRecordDigest: string,
): TaskDiffReviewLineageSupersessionRecord | null {
  const predecessorReviewRecordDigest = assertDigest(
    requestedPredecessorReviewRecordDigest,
  );
  return (
    readTaskDiffReviewLineageSupersessionInventory(paths).find(
      (record) =>
        record.predecessorReviewRecordDigest === predecessorReviewRecordDigest,
    ) ?? null
  );
}

export function listTaskDiffReviewLineageSupersessions(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffReviewLineageSupersessionRecord[] {
  return readTaskDiffReviewLineageSupersessionInventory(paths);
}

export function taskDiffReviewLineageSupersessionPath(
  paths: InvestigationRuntimePaths,
  requestedPredecessorReviewRecordDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    'lineage-supersessions',
    `${assertDigest(requestedPredecessorReviewRecordDigest)}.json`,
  );
}

function readTaskDiffReviewLineageSupersessionInventory(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffReviewLineageSupersessionRecord[] {
  const directory = path.join(
    paths.refs,
    'task-diff-reviews',
    'lineage-supersessions',
  );
  return Object.freeze(
    listPrivateDigestJson(paths, directory).map(
      (predecessorReviewRecordDigest) => {
        const target = taskDiffReviewLineageSupersessionPath(
          paths,
          predecessorReviewRecordDigest,
        );
        const record = parseTaskDiffReviewLineageSupersession(
          readPrivateCanonicalJson(paths, target, storeUnsafe),
        );
        if (
          record.predecessorReviewRecordDigest !== predecessorReviewRecordDigest
        ) {
          throw storeUnsafe();
        }
        return record;
      },
    ),
  );
}
