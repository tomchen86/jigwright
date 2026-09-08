/**
 * Persists immutable provider review reservations, result bindings, and final assurance.
 *
 * Invariants:
 * - Create-only writes retain conflict codes and the verifying read after publication.
 * - Inventory reads preserve session validation and deterministic record ordering.
 *
 * Depends on: Review record codecs, private canonical storage, and session workspace paths.
 * Failure modes: Conflicting review authority is accepted or persisted results cannot be replayed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  assertPrivateInvestigationDirectory,
} from './investigation-private-files.ts';
import {
  type InvestigationRuntimePaths,
  assertSessionId,
} from '../session-workspace/paths.ts';
import {
  type TaskDiffReviewReservationRecord,
  sha256,
  storeUnsafe,
  assertDigest,
  type TaskDiffReviewResultBinding,
  type TaskDiffReviewContinuationReservationRecord,
  type TaskDiffReviewContinuationResultBinding,
  type TaskDiffFinalAssuranceBinding,
  DIGEST,
} from './task-diff-review-store-contracts.ts';
import {
  parseTaskDiffReviewReservation,
  parseTaskDiffReviewResultBinding,
  parseTaskDiffReviewContinuationReservation,
  parseTaskDiffReviewContinuationResultBinding,
  parseTaskDiffFinalAssuranceBinding,
} from './task-diff-review-record-codec.ts';
import {
  listPrivateDigestJson,
  listTaskDiffReviewProviderSessionIds,
} from './task-diff-review-store-inventory.ts';

export {
  type TaskDiffReviewManifestSnapshot,
  type TaskDiffReviewReservationRecord,
  type TaskDiffReviewResultBinding,
  type TaskDiffReviewContinuationManifestSnapshot,
  type TaskDiffReviewContinuationReservationRecord,
  type TaskDiffReviewContinuationResultBinding,
  type TaskDiffFinalAssuranceBinding,
  type TaskDiffReviewLineageSupersessionRecord,
  type CreateTaskDiffReviewLineageSupersessionInput,
} from './task-diff-review-store-contracts.ts';

export {
  createTaskDiffReviewLineageSupersession,
  readTaskDiffReviewLineageSupersession,
  listTaskDiffReviewLineageSupersessions,
  taskDiffReviewLineageSupersessionPath,
} from './task-diff-review-lineage-store.ts';

export function createTaskDiffReviewReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffReviewReservationRecord,
    'schemaVersion' | 'kind' | 'reservationDigest'
  >,
): TaskDiffReviewReservationRecord {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-reservation.v1' as const,
    ...input,
  };
  const reservation = parseTaskDiffReviewReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewReservationPath(
      paths,
      reservation.sessionId,
      reservation.subject.subjectDigest,
    ),
    reservation,
    storeUnsafe,
    'TASK_DIFF_REVIEW_RESERVATION_CONFLICT',
  );
  return readTaskDiffReviewReservation(
    paths,
    reservation.sessionId,
    reservation.subject.subjectDigest,
  )!;
}

export function readTaskDiffReviewReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedSubjectDigest: string,
): TaskDiffReviewReservationRecord | null {
  const sessionId = assertSessionId(requestedSessionId);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const target = taskDiffReviewReservationPath(paths, sessionId, subjectDigest);
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const reservation = parseTaskDiffReviewReservation(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (
    reservation.sessionId !== sessionId ||
    reservation.subject.subjectDigest !== subjectDigest
  ) {
    throw storeUnsafe();
  }
  return reservation;
}

export function createTaskDiffReviewResultBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffReviewResultBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskDiffReviewResultBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-result-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskDiffReviewResultBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewResultPath(paths, binding.sessionId, binding.subjectDigest),
    binding,
    storeUnsafe,
    'TASK_DIFF_REVIEW_RESULT_CONFLICT',
  );
  return readTaskDiffReviewResultBinding(
    paths,
    binding.sessionId,
    binding.subjectDigest,
  )!;
}

export function readTaskDiffReviewResultBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedSubjectDigest: string,
): TaskDiffReviewResultBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const target = taskDiffReviewResultPath(paths, sessionId, subjectDigest);
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const binding = parseTaskDiffReviewResultBinding(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (
    binding.sessionId !== sessionId ||
    binding.subjectDigest !== subjectDigest
  ) {
    throw storeUnsafe();
  }
  return binding;
}

export function taskDiffReviewReservationPath(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedSubjectDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    assertSessionId(requestedSessionId),
    'reservations',
    `${assertDigest(requestedSubjectDigest)}.json`,
  );
}

export function taskDiffReviewResultPath(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedSubjectDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    assertSessionId(requestedSessionId),
    'results',
    `${assertDigest(requestedSubjectDigest)}.json`,
  );
}

export function createTaskDiffReviewContinuationReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffReviewContinuationReservationRecord,
    'schemaVersion' | 'kind' | 'reservationDigest'
  >,
): TaskDiffReviewContinuationReservationRecord {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-continuation-reservation.v1' as const,
    ...input,
  };
  const reservation = parseTaskDiffReviewContinuationReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewContinuationReservationPath(
      paths,
      reservation.sessionId,
      reservation.review.recordDigest,
    ),
    reservation,
    storeUnsafe,
    'TASK_DIFF_REVIEW_CONTINUATION_RESERVATION_CONFLICT',
  );
  return readTaskDiffReviewContinuationReservation(
    paths,
    reservation.sessionId,
    reservation.review.recordDigest,
  )!;
}

export function readTaskDiffReviewContinuationReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedReviewRecordDigest: string,
): TaskDiffReviewContinuationReservationRecord | null {
  const sessionId = assertSessionId(requestedSessionId);
  const reviewRecordDigest = assertDigest(requestedReviewRecordDigest);
  const target = taskDiffReviewContinuationReservationPath(
    paths,
    sessionId,
    reviewRecordDigest,
  );
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const reservation = parseTaskDiffReviewContinuationReservation(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (
    reservation.sessionId !== sessionId ||
    reservation.review.recordDigest !== reviewRecordDigest
  ) {
    throw storeUnsafe();
  }
  return reservation;
}

export function createTaskDiffReviewContinuationResultBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffReviewContinuationResultBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskDiffReviewContinuationResultBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-continuation-result-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskDiffReviewContinuationResultBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffReviewContinuationResultPath(
      paths,
      binding.sessionId,
      binding.reviewRecordDigest,
    ),
    binding,
    storeUnsafe,
    'TASK_DIFF_REVIEW_CONTINUATION_RESULT_CONFLICT',
  );
  return readTaskDiffReviewContinuationResultBinding(
    paths,
    binding.sessionId,
    binding.reviewRecordDigest,
  )!;
}

export function readTaskDiffReviewContinuationResultBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedReviewRecordDigest: string,
): TaskDiffReviewContinuationResultBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  const reviewRecordDigest = assertDigest(requestedReviewRecordDigest);
  const target = taskDiffReviewContinuationResultPath(
    paths,
    sessionId,
    reviewRecordDigest,
  );
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const binding = parseTaskDiffReviewContinuationResultBinding(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (
    binding.sessionId !== sessionId ||
    binding.reviewRecordDigest !== reviewRecordDigest
  ) {
    throw storeUnsafe();
  }
  return binding;
}

export function taskDiffReviewContinuationReservationPath(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedReviewRecordDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    assertSessionId(requestedSessionId),
    'continuations',
    assertDigest(requestedReviewRecordDigest),
    'reservation.json',
  );
}

export function taskDiffReviewContinuationResultPath(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedReviewRecordDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    assertSessionId(requestedSessionId),
    'continuation-results',
    `${assertDigest(requestedReviewRecordDigest)}.json`,
  );
}

export function createTaskDiffFinalAssuranceBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskDiffFinalAssuranceBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskDiffFinalAssuranceBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-final-assurance-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskDiffFinalAssuranceBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    paths,
    taskDiffFinalAssurancePath(paths, binding.subjectDigest),
    binding,
    storeUnsafe,
    'TASK_DIFF_FINAL_ASSURANCE_CONFLICT',
  );
  return readTaskDiffFinalAssuranceBinding(paths, binding.subjectDigest)!;
}

export function readTaskDiffFinalAssuranceBinding(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): TaskDiffFinalAssuranceBinding | null {
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const target = taskDiffFinalAssurancePath(paths, subjectDigest);
  if (!privatePathExists(paths, target, storeUnsafe)) return null;
  const binding = parseTaskDiffFinalAssuranceBinding(
    readPrivateCanonicalJson(paths, target, storeUnsafe),
  );
  if (binding.subjectDigest !== subjectDigest) throw storeUnsafe();
  return binding;
}

export function taskDiffFinalAssurancePath(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-diff-reviews',
    'final-assurance',
    `${assertDigest(requestedSubjectDigest)}.json`,
  );
}

export function listTaskDiffReviewResultBindings(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
): readonly TaskDiffReviewResultBinding[] {
  const sessionId = assertSessionId(requestedSessionId);
  const directory = path.join(
    paths.refs,
    'task-diff-reviews',
    sessionId,
    'results',
  );
  return listPrivateDigestJson(paths, directory).map((subjectDigest) => {
    const binding = readTaskDiffReviewResultBinding(
      paths,
      sessionId,
      subjectDigest,
    );
    if (binding === null) throw storeUnsafe();
    return binding;
  });
}

/** List every legacy provider review binding across sessions, strictly. */
export function listAllTaskDiffReviewResultBindings(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffReviewResultBinding[] {
  return Object.freeze(
    listTaskDiffReviewProviderSessionIds(paths).flatMap((sessionId) =>
      listTaskDiffReviewResultBindings(paths, sessionId),
    ),
  );
}

/** List every legacy provider review reservation across sessions, strictly. */
export function listAllTaskDiffReviewReservations(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffReviewReservationRecord[] {
  const root = path.join(paths.refs, 'task-diff-reviews');
  return Object.freeze(
    listTaskDiffReviewProviderSessionIds(paths).flatMap((sessionId) => {
      const directory = path.join(root, sessionId, 'reservations');
      return listPrivateDigestJson(paths, directory).map((subjectDigest) => {
        const reservation = readTaskDiffReviewReservation(
          paths,
          sessionId,
          subjectDigest,
        );
        if (reservation === null) throw storeUnsafe();
        return reservation;
      });
    }),
  );
}

/** List every legacy provider continuation reservation across sessions. */
export function listAllTaskDiffReviewContinuationReservations(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffReviewContinuationReservationRecord[] {
  const root = path.join(paths.refs, 'task-diff-reviews');
  return Object.freeze(
    listTaskDiffReviewProviderSessionIds(paths).flatMap((sessionId) => {
      const directory = path.join(root, sessionId, 'continuations');
      const observed = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (!observed) return [];
      assertPrivateInvestigationDirectory(paths, directory, storeUnsafe);
      return fs
        .readdirSync(directory)
        .sort()
        .map((reviewRecordDigest) => {
          if (!DIGEST.test(reviewRecordDigest)) throw storeUnsafe();
          const reservationDirectory = path.join(directory, reviewRecordDigest);
          assertPrivateInvestigationDirectory(
            paths,
            reservationDirectory,
            storeUnsafe,
          );
          if (
            canonicalJson(fs.readdirSync(reservationDirectory).sort()) !==
            canonicalJson(['reservation.json'])
          ) {
            throw storeUnsafe();
          }
          const reservation = readTaskDiffReviewContinuationReservation(
            paths,
            sessionId,
            reviewRecordDigest,
          );
          if (reservation === null) throw storeUnsafe();
          return reservation;
        });
    }),
  );
}

/** List every legacy provider continuation result across sessions. */
export function listAllTaskDiffReviewContinuationResultBindings(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffReviewContinuationResultBinding[] {
  const root = path.join(paths.refs, 'task-diff-reviews');
  return Object.freeze(
    listTaskDiffReviewProviderSessionIds(paths).flatMap((sessionId) => {
      const directory = path.join(root, sessionId, 'continuation-results');
      return listPrivateDigestJson(paths, directory).map(
        (reviewRecordDigest) => {
          const binding = readTaskDiffReviewContinuationResultBinding(
            paths,
            sessionId,
            reviewRecordDigest,
          );
          if (binding === null) throw storeUnsafe();
          return binding;
        },
      );
    }),
  );
}
