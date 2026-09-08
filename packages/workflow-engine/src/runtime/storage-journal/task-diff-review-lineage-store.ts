/**
 * Persists and replays immutable review lineage supersession edges.
 *
 * Invariants:
 * - Both complete subjects and reviews remain bound to the successor scope.
 * - Lineage records carry no independent closure or freshness authority.
 */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
} from './investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { parseTaskDiffReviewRecord } from '../../modules/assurance/task-diff-review-artifact.ts';
import {
  parseTaskDiffReviewSubject,
  parseTaskDiffReviewScope,
} from '../../modules/assurance/task-diff-review.ts';
import {
  type CreateTaskDiffReviewLineageSupersessionInput,
  type TaskDiffReviewLineageSupersessionRecord,
  assertDigest,
  sha256,
  storeUnsafe,
  isRecord,
  hasExactKeys,
  isDigest,
  withoutDigest,
  deepFreeze,
} from './task-diff-review-store-contracts.ts';
import { listPrivateDigestJson } from './task-diff-review-store-inventory.ts';

export function createTaskDiffReviewLineageSupersession(
  paths: InvestigationRuntimePaths,
  input: CreateTaskDiffReviewLineageSupersessionInput,
): TaskDiffReviewLineageSupersessionRecord {
  const predecessorSubject = parseTaskDiffReviewSubject(
    input.predecessorSubject,
  );
  const predecessorReview = parseTaskDiffReviewRecord(input.predecessorReview);
  const successorSubject = parseTaskDiffReviewSubject(input.successorSubject);
  const successorReview = parseTaskDiffReviewRecord(input.successorReview);
  const successorReviewScope = parseTaskDiffReviewScope(
    input.successorReviewScope,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-lineage-supersession.v1' as const,
    predecessorSubject,
    predecessorSubjectDigest: predecessorSubject.subjectDigest,
    predecessorReview,
    predecessorReviewRecordDigest: predecessorReview.recordDigest,
    successorSubject,
    successorSubjectDigest: successorSubject.subjectDigest,
    successorReview,
    successorReviewRecordDigest: successorReview.recordDigest,
    successorReviewScope,
    successorReviewScopeDigest: assertDigest(input.successorReviewScopeDigest),
  };
  const record = parseTaskDiffReviewLineageSupersession({
    ...body,
    supersessionDigest: sha256(canonicalJson(body)),
  });
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

function parseTaskDiffReviewLineageSupersession(
  value: unknown,
): TaskDiffReviewLineageSupersessionRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'supersessionDigest',
      'predecessorSubject',
      'predecessorSubjectDigest',
      'predecessorReview',
      'predecessorReviewRecordDigest',
      'successorSubject',
      'successorSubjectDigest',
      'successorReview',
      'successorReviewRecordDigest',
      'successorReviewScope',
      'successorReviewScopeDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-lineage-supersession.v1' ||
    !isDigest(value.supersessionDigest) ||
    !isDigest(value.predecessorSubjectDigest) ||
    !isDigest(value.predecessorReviewRecordDigest) ||
    !isDigest(value.successorSubjectDigest) ||
    !isDigest(value.successorReviewRecordDigest) ||
    !isDigest(value.successorReviewScopeDigest)
  ) {
    throw storeUnsafe();
  }
  const predecessorSubject = parseTaskDiffReviewSubject(
    value.predecessorSubject,
  );
  const predecessorReview = parseTaskDiffReviewRecord(value.predecessorReview);
  const successorSubject = parseTaskDiffReviewSubject(value.successorSubject);
  const successorReview = parseTaskDiffReviewRecord(value.successorReview);
  const successorReviewScope = parseTaskDiffReviewScope(
    value.successorReviewScope,
  );
  const record: TaskDiffReviewLineageSupersessionRecord = {
    schemaVersion: 1,
    kind: 'task-diff-review-lineage-supersession.v1',
    supersessionDigest: value.supersessionDigest,
    predecessorSubject,
    predecessorSubjectDigest: value.predecessorSubjectDigest,
    predecessorReview,
    predecessorReviewRecordDigest: value.predecessorReviewRecordDigest,
    successorSubject,
    successorSubjectDigest: value.successorSubjectDigest,
    successorReview,
    successorReviewRecordDigest: value.successorReviewRecordDigest,
    successorReviewScope,
    successorReviewScopeDigest: value.successorReviewScopeDigest,
  };
  const predecessor = successorReviewScope.predecessor;
  if (
    record.predecessorSubjectDigest !== predecessorSubject.subjectDigest ||
    record.predecessorReviewRecordDigest !== predecessorReview.recordDigest ||
    predecessorReview.subjectDigest !== predecessorSubject.subjectDigest ||
    canonicalJson(predecessorReview.subject) !==
      canonicalJson(predecessorSubject) ||
    record.successorSubjectDigest !== successorSubject.subjectDigest ||
    record.successorReviewRecordDigest !== successorReview.recordDigest ||
    successorReview.subjectDigest !== successorSubject.subjectDigest ||
    canonicalJson(successorReview.subject) !==
      canonicalJson(successorSubject) ||
    canonicalJson(successorReview.reviewScope) !==
      canonicalJson(successorReviewScope) ||
    record.successorReviewScopeDigest !== successorReviewScope.scopeDigest ||
    successorReviewScope.currentSubjectDigest !==
      successorSubject.subjectDigest ||
    predecessor === null ||
    predecessor.subjectDigest !== predecessorSubject.subjectDigest ||
    predecessor.reviewRecordDigest !== predecessorReview.recordDigest ||
    predecessorSubject.subjectDigest === successorSubject.subjectDigest ||
    predecessorReview.recordDigest === successorReview.recordDigest ||
    predecessorSubject.repositoryId !== successorSubject.repositoryId ||
    predecessorSubject.changeId !== successorSubject.changeId ||
    predecessorSubject.taskId !== successorSubject.taskId ||
    predecessorSubject.baseCommit !== successorSubject.baseCommit ||
    predecessorSubject.baseTree !== successorSubject.baseTree ||
    record.supersessionDigest !==
      sha256(canonicalJson(withoutDigest(record, 'supersessionDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(record);
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
