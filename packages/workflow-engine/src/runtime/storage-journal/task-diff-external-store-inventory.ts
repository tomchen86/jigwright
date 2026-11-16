/**
 * Validates the complete external review inventory and its contribution linkage.
 *
 * Invariants:
 * - Bindings, reservations, and content retain exact cross-record identity checks.
 * - Grant identifiers and envelopes remain unique across review and continuation attempts.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  assertPrivateInvestigationDirectory,
  readPrivateCanonicalJson,
} from '../journal-primitives/investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  taskDiffExternalStoreRoot,
  STORE_DIRECTORIES,
  ATTEMPT_FILE,
  SCOPED_FILE,
  DIGEST_FILE,
} from './task-diff-external-store-paths.ts';
import {
  storeInvalid,
  type TaskDiffExternalReviewReservation,
  type TaskDiffExternalReviewBinding,
  type TaskDiffExternalContinuationReservation,
  type TaskDiffExternalContinuationBinding,
  type TaskDiffExternalChallengeResponse,
  type TaskDiffExternalReviewSubmission,
  type TaskDiffExternalClosureSubmission,
} from '../../modules/assurance/task-diff-external-record.ts';
import {
  parseTaskDiffExternalReviewReservation,
  parseTaskDiffExternalReviewBinding,
  parseTaskDiffExternalContinuationReservation,
  parseTaskDiffExternalContinuationBinding,
  reviewBindingMatchesReservation,
  continuationBindingMatchesReservation,
} from '../../modules/assurance/task-diff-external-authority.ts';
import {
  parseTaskDiffExternalChallengeResponse,
  parseTaskDiffExternalReviewSubmission,
  parseTaskDiffExternalClosureSubmission,
} from '../../modules/assurance/task-diff-external-content.ts';

/**
 * Validate the whole external-authority namespace before trusting any entry.
 * Unknown directories/files, malformed keys, symlinks, non-private files,
 * non-canonical JSON, invalid digests, or orphaned bindings all fail closed.
 */
export function assertTaskDiffExternalReviewStoreInventory(
  paths: InvestigationRuntimePaths,
): void {
  const root = taskDiffExternalStoreRoot(paths);
  const observed = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!observed) return;
  assertPrivateInvestigationDirectory(paths, root, storeInvalid);
  const rootNames = fs.readdirSync(root).sort();
  if (
    rootNames.some(
      (name) =>
        !STORE_DIRECTORIES.includes(name as (typeof STORE_DIRECTORIES)[number]),
    )
  ) {
    throw storeInvalid();
  }

  const reviewReservations = new Map<
    string,
    TaskDiffExternalReviewReservation
  >();
  const reviewBindings = new Map<string, TaskDiffExternalReviewBinding>();
  const continuationReservations = new Map<
    string,
    TaskDiffExternalContinuationReservation
  >();
  const continuationBindings = new Map<
    string,
    TaskDiffExternalContinuationBinding
  >();
  const responses = new Map<string, TaskDiffExternalChallengeResponse>();
  const submissions = new Map<string, TaskDiffExternalReviewSubmission>();
  const closureSubmissions = new Map<
    string,
    TaskDiffExternalClosureSubmission
  >();

  for (const directoryName of rootNames) {
    const directory = path.join(root, directoryName);
    assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
    for (const fileName of fs.readdirSync(directory).sort()) {
      const match =
        directoryName === 'review-reservations' ||
        directoryName === 'continuation-reservations'
          ? ATTEMPT_FILE.exec(fileName)
          : directoryName === 'responses' ||
              directoryName === 'submissions' ||
              directoryName === 'closure-submissions'
            ? SCOPED_FILE.exec(fileName)
            : DIGEST_FILE.exec(fileName);
      if (!match) throw storeInvalid();
      const key = match[1]!;
      const value = readPrivateCanonicalJson(
        paths,
        path.join(directory, fileName),
        storeInvalid,
      );
      if (directoryName === 'review-reservations') {
        const record = parseTaskDiffExternalReviewReservation(value);
        const attemptKey = `${key}:${match[2]!}`;
        if (
          record.subjectDigest !== key ||
          record.grant.grantEnvelopeDigest !== match[2] ||
          reviewReservations.has(attemptKey)
        ) {
          throw storeInvalid();
        }
        reviewReservations.set(attemptKey, record);
      } else if (directoryName === 'review-bindings') {
        const record = parseTaskDiffExternalReviewBinding(value);
        if (record.subjectDigest !== key || reviewBindings.has(key)) {
          throw storeInvalid();
        }
        reviewBindings.set(key, record);
      } else if (directoryName === 'continuation-reservations') {
        const record = parseTaskDiffExternalContinuationReservation(value);
        const attemptKey = `${key}:${match[2]!}`;
        if (
          record.targetDigest !== key ||
          record.grant.grantEnvelopeDigest !== match[2] ||
          continuationReservations.has(attemptKey)
        ) {
          throw storeInvalid();
        }
        continuationReservations.set(attemptKey, record);
      } else if (directoryName === 'continuation-bindings') {
        const record = parseTaskDiffExternalContinuationBinding(value);
        if (record.targetDigest !== key || continuationBindings.has(key)) {
          throw storeInvalid();
        }
        continuationBindings.set(key, record);
      } else if (directoryName === 'responses') {
        const record = parseTaskDiffExternalChallengeResponse(value);
        const responseKey = `${key}:${match[2]!}`;
        if (
          record.reviewRecordDigest !== key ||
          record.responseDigest !== match[2] ||
          responses.has(responseKey)
        ) {
          throw storeInvalid();
        }
        responses.set(responseKey, record);
      } else if (directoryName === 'submissions') {
        const record = parseTaskDiffExternalReviewSubmission(value);
        const submissionKey = `${key}:${match[2]!}`;
        if (
          record.subjectDigest !== key ||
          record.inputDigest !== match[2] ||
          submissions.has(submissionKey)
        ) {
          throw storeInvalid();
        }
        submissions.set(submissionKey, record);
      } else if (directoryName === 'closure-submissions') {
        const record = parseTaskDiffExternalClosureSubmission(value);
        const submissionKey = `${key}:${match[2]!}`;
        if (
          record.targetDigest !== key ||
          record.inputDigest !== match[2] ||
          closureSubmissions.has(submissionKey)
        ) {
          throw storeInvalid();
        }
        closureSubmissions.set(submissionKey, record);
      } else {
        throw storeInvalid();
      }
    }
  }

  for (const [key, binding] of reviewBindings) {
    const reservation = reviewReservations.get(
      `${key}:${binding.grant.grantEnvelopeDigest}`,
    );
    if (
      reservation === undefined ||
      !reviewBindingMatchesReservation(binding, reservation)
    ) {
      throw storeInvalid();
    }
  }
  for (const reservation of reviewReservations.values()) {
    const submission = submissions.get(
      `${reservation.subjectDigest}:${reservation.inputDigest}`,
    );
    if (
      submission === undefined ||
      submission.recordDigest !== reservation.submissionRecordDigest ||
      submission.inputDigest !== reservation.inputDigest
    ) {
      throw storeInvalid();
    }
  }
  for (const [key, binding] of continuationBindings) {
    const reservation = continuationReservations.get(
      `${key}:${binding.grant.grantEnvelopeDigest}`,
    );
    if (
      reservation === undefined ||
      !continuationBindingMatchesReservation(binding, reservation)
    ) {
      throw storeInvalid();
    }
  }
  for (const reservation of continuationReservations.values()) {
    const submission = closureSubmissions.get(
      `${reservation.targetDigest}:${reservation.inputDigest}`,
    );
    if (
      submission === undefined ||
      submission.subjectDigest !== reservation.subjectDigest ||
      submission.reviewRecordDigest !== reservation.reviewRecordDigest ||
      submission.responseDigest !== reservation.responseDigest
    ) {
      throw storeInvalid();
    }
  }
  const grantIds = new Set<string>();
  const grantEnvelopeDigests = new Set<string>();
  for (const reservation of [
    ...reviewReservations.values(),
    ...continuationReservations.values(),
  ]) {
    if (
      grantIds.has(reservation.grant.grantId) ||
      grantEnvelopeDigests.has(reservation.grant.grantEnvelopeDigest)
    ) {
      throw storeInvalid();
    }
    grantIds.add(reservation.grant.grantId);
    grantEnvelopeDigests.add(reservation.grant.grantEnvelopeDigest);
  }
}
