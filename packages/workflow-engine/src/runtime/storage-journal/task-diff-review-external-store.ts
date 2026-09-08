/**
 * Persists and reads external review contributions with complete inventory validation.
 *
 * Invariants:
 * - Each operation retains its preflight inventory check and create-only conflict behavior.
 * - Bindings are read against the exact reservation that authorized their contribution.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createPrivateCanonicalJson,
  assertPrivateInvestigationDirectory,
  readPrivateCanonicalJson,
  privatePathExists,
} from './investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  type PrepareTaskDiffExternalReviewReservationInput,
  type TaskDiffExternalReviewReservation,
  storeInvalid,
  type PrepareTaskDiffExternalReviewBindingInput,
  type TaskDiffExternalReviewBinding,
  type PrepareTaskDiffExternalContinuationReservationInput,
  type TaskDiffExternalContinuationReservation,
  type PrepareTaskDiffExternalContinuationBindingInput,
  type TaskDiffExternalContinuationBinding,
  type PrepareTaskDiffExternalChallengeResponseInput,
  type TaskDiffExternalChallengeResponse,
  type PrepareTaskDiffExternalReviewSubmissionInput,
  type TaskDiffExternalReviewSubmission,
  type PrepareTaskDiffExternalClosureSubmissionInput,
  type TaskDiffExternalClosureSubmission,
  assertDigest,
} from './task-diff-external-store-contracts.ts';
import { assertTaskDiffExternalReviewStoreInventory } from './task-diff-external-store-inventory.ts';
import {
  prepareTaskDiffExternalReviewReservation,
  prepareTaskDiffExternalReviewBinding,
  reviewBindingMatchesReservation,
  prepareTaskDiffExternalContinuationReservation,
  prepareTaskDiffExternalContinuationBinding,
  continuationBindingMatchesReservation,
  parseTaskDiffExternalReviewReservation,
  parseTaskDiffExternalReviewBinding,
  parseTaskDiffExternalContinuationReservation,
  parseTaskDiffExternalContinuationBinding,
} from './task-diff-external-authority-records.ts';
import {
  taskDiffExternalReviewReservationPath,
  taskDiffExternalReviewBindingPath,
  taskDiffExternalContinuationReservationPath,
  taskDiffExternalContinuationBindingPath,
  taskDiffExternalChallengeResponsePath,
  taskDiffExternalReviewSubmissionPath,
  taskDiffExternalClosureSubmissionPath,
  taskDiffExternalStoreRoot,
  ATTEMPT_FILE,
  DIGEST_FILE,
  SCOPED_FILE,
} from './task-diff-external-store-paths.ts';
import {
  prepareTaskDiffExternalChallengeResponse,
  prepareTaskDiffExternalReviewSubmission,
  prepareTaskDiffExternalClosureSubmission,
  parseTaskDiffExternalChallengeResponse,
  parseTaskDiffExternalReviewSubmission,
  parseTaskDiffExternalClosureSubmission,
} from './task-diff-external-content-records.ts';

export {
  type TaskDiffExternalDegradedForm,
  type TaskDiffExternalGrantReference,
  type TaskDiffExternalReviewReservation,
  type TaskDiffExternalReviewBinding,
  type TaskDiffExternalContinuationReservation,
  type TaskDiffExternalContinuationBinding,
  type TaskDiffExternalChallengeResponse,
  type TaskDiffExternalReviewSubmission,
  type TaskDiffExternalClosureSubmission,
  type PrepareTaskDiffExternalReviewReservationInput,
  type PrepareTaskDiffExternalReviewBindingInput,
  type PrepareTaskDiffExternalContinuationReservationInput,
  type PrepareTaskDiffExternalContinuationBindingInput,
  type PrepareTaskDiffExternalChallengeResponseInput,
  type PrepareTaskDiffExternalReviewSubmissionInput,
  type PrepareTaskDiffExternalClosureSubmissionInput,
} from './task-diff-external-store-contracts.ts';

export {
  taskDiffExternalContinuationTargetDigest,
  prepareTaskDiffExternalReviewReservation,
  prepareTaskDiffExternalReviewBinding,
  prepareTaskDiffExternalContinuationReservation,
  prepareTaskDiffExternalContinuationBinding,
  parseTaskDiffExternalReviewReservation,
  parseTaskDiffExternalReviewBinding,
  parseTaskDiffExternalContinuationReservation,
  parseTaskDiffExternalContinuationBinding,
} from './task-diff-external-authority-records.ts';

export {
  taskDiffExternalReviewReservationPath,
  taskDiffExternalReviewBindingPath,
  taskDiffExternalContinuationReservationPath,
  taskDiffExternalContinuationBindingPath,
  taskDiffExternalChallengeResponsePath,
  taskDiffExternalReviewSubmissionPath,
  taskDiffExternalClosureSubmissionPath,
} from './task-diff-external-store-paths.ts';

export {
  prepareTaskDiffExternalChallengeResponse,
  prepareTaskDiffExternalReviewSubmission,
  prepareTaskDiffExternalClosureSubmission,
  parseTaskDiffExternalChallengeResponse,
  parseTaskDiffExternalReviewSubmission,
  parseTaskDiffExternalClosureSubmission,
} from './task-diff-external-content-records.ts';

export { assertTaskDiffExternalReviewStoreInventory } from './task-diff-external-store-inventory.ts';

export function createTaskDiffExternalReviewReservation(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalReviewReservationInput,
): TaskDiffExternalReviewReservation {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalReviewReservation(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalReviewReservationPath(
      paths,
      prepared.subjectDigest,
      prepared.grant.grantEnvelopeDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_REVIEW_RESERVATION_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalReviewReservation(
    paths,
    prepared.subjectDigest,
    prepared.grant.grantEnvelopeDigest,
  )!;
}

export function createTaskDiffExternalReviewBinding(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalReviewBindingInput,
): TaskDiffExternalReviewBinding {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalReviewBinding(input);
  const reservation = readTaskDiffExternalReviewReservationInternal(
    paths,
    prepared.subjectDigest,
    prepared.grant.grantEnvelopeDigest,
  );
  if (
    reservation === null ||
    !reviewBindingMatchesReservation(prepared, reservation)
  ) {
    throw storeInvalid();
  }
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalReviewBindingPath(paths, prepared.subjectDigest),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_REVIEW_BINDING_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalReviewBinding(paths, prepared.subjectDigest)!;
}

export function createTaskDiffExternalContinuationReservation(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalContinuationReservationInput,
): TaskDiffExternalContinuationReservation {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalContinuationReservation(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalContinuationReservationPath(
      paths,
      prepared.targetDigest,
      prepared.grant.grantEnvelopeDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_CONTINUATION_RESERVATION_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalContinuationReservation(
    paths,
    prepared.targetDigest,
    prepared.grant.grantEnvelopeDigest,
  )!;
}

export function createTaskDiffExternalContinuationBinding(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalContinuationBindingInput,
): TaskDiffExternalContinuationBinding {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalContinuationBinding(input);
  const reservation = readTaskDiffExternalContinuationReservationInternal(
    paths,
    prepared.targetDigest,
    prepared.grant.grantEnvelopeDigest,
  );
  if (
    reservation === null ||
    !continuationBindingMatchesReservation(prepared, reservation)
  ) {
    throw storeInvalid();
  }
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalContinuationBindingPath(paths, prepared.targetDigest),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_CONTINUATION_BINDING_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalContinuationBinding(paths, prepared.targetDigest)!;
}

export function createTaskDiffExternalChallengeResponse(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalChallengeResponseInput,
): TaskDiffExternalChallengeResponse {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalChallengeResponse(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalChallengeResponsePath(
      paths,
      prepared.reviewRecordDigest,
      prepared.responseDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_CHALLENGE_RESPONSE_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalChallengeResponse(
    paths,
    prepared.subjectDigest,
    prepared.reviewRecordDigest,
    prepared.responseDigest,
  )!;
}

export function createTaskDiffExternalReviewSubmission(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalReviewSubmissionInput,
): TaskDiffExternalReviewSubmission {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalReviewSubmission(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalReviewSubmissionPath(
      paths,
      prepared.subjectDigest,
      prepared.inputDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_REVIEW_SUBMISSION_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalReviewSubmission(
    paths,
    prepared.subjectDigest,
    prepared.reviewScopeDigest,
    prepared.inputDigest,
  )!;
}

export function createTaskDiffExternalClosureSubmission(
  paths: InvestigationRuntimePaths,
  input: PrepareTaskDiffExternalClosureSubmissionInput,
): TaskDiffExternalClosureSubmission {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const prepared = prepareTaskDiffExternalClosureSubmission(input);
  createPrivateCanonicalJson(
    paths,
    taskDiffExternalClosureSubmissionPath(
      paths,
      prepared.targetDigest,
      prepared.inputDigest,
    ),
    prepared,
    storeInvalid,
    'TASK_DIFF_EXTERNAL_CLOSURE_SUBMISSION_CONFLICT',
  );
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalClosureSubmission(
    paths,
    prepared.targetDigest,
    prepared.inputDigest,
  )!;
}

export function readTaskDiffExternalReviewReservation(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedGrantEnvelopeDigest: string,
): TaskDiffExternalReviewReservation | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalReviewReservationInternal(
    paths,
    requestedSubjectDigest,
    requestedGrantEnvelopeDigest,
  );
}

export function listTaskDiffExternalReviewReservations(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): readonly TaskDiffExternalReviewReservation[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'review-reservations',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const records = fs
    .readdirSync(directory)
    .sort()
    .flatMap((fileName) => {
      const match = ATTEMPT_FILE.exec(fileName);
      if (!match || match[1] !== subjectDigest) return [];
      return [
        parseTaskDiffExternalReviewReservation(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        ),
      ];
    });
  return Object.freeze(records);
}

export function readTaskDiffExternalReviewBinding(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): TaskDiffExternalReviewBinding | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const target = taskDiffExternalReviewBindingPath(paths, subjectDigest);
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const binding = parseTaskDiffExternalReviewBinding(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  const reservation = readTaskDiffExternalReviewReservationInternal(
    paths,
    subjectDigest,
    binding.grant.grantEnvelopeDigest,
  );
  if (
    binding.subjectDigest !== subjectDigest ||
    reservation === null ||
    !reviewBindingMatchesReservation(binding, reservation)
  ) {
    throw storeInvalid();
  }
  return binding;
}

/** List only canonical successful review bindings, never grant attempts. */
export function listTaskDiffExternalReviewBindings(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffExternalReviewBinding[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'review-bindings',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  return Object.freeze(
    fs
      .readdirSync(directory)
      .sort()
      .map((fileName) => {
        const match = DIGEST_FILE.exec(fileName);
        if (!match) throw storeInvalid();
        const binding = parseTaskDiffExternalReviewBinding(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        );
        if (binding.subjectDigest !== match[1]) throw storeInvalid();
        return binding;
      }),
  );
}

export function readTaskDiffExternalContinuationReservation(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedGrantEnvelopeDigest: string,
): TaskDiffExternalContinuationReservation | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  return readTaskDiffExternalContinuationReservationInternal(
    paths,
    requestedTargetDigest,
    requestedGrantEnvelopeDigest,
  );
}

export function listTaskDiffExternalContinuationReservations(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
): readonly TaskDiffExternalContinuationReservation[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const targetDigest = assertDigest(requestedTargetDigest);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-reservations',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const records = fs
    .readdirSync(directory)
    .sort()
    .flatMap((fileName) => {
      const match = ATTEMPT_FILE.exec(fileName);
      if (!match || match[1] !== targetDigest) return [];
      return [
        parseTaskDiffExternalContinuationReservation(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        ),
      ];
    });
  return Object.freeze(records);
}

/** List every immutable external continuation attempt, sorted by store key. */
export function listAllTaskDiffExternalContinuationReservations(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffExternalContinuationReservation[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-reservations',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  return Object.freeze(
    fs
      .readdirSync(directory)
      .sort()
      .map((fileName) => {
        const match = ATTEMPT_FILE.exec(fileName);
        if (!match) throw storeInvalid();
        const reservation = parseTaskDiffExternalContinuationReservation(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        );
        if (
          reservation.targetDigest !== match[1] ||
          reservation.grant.grantEnvelopeDigest !== match[2]
        ) {
          throw storeInvalid();
        }
        return reservation;
      }),
  );
}

export function readTaskDiffExternalContinuationBinding(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
): TaskDiffExternalContinuationBinding | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const targetDigest = assertDigest(requestedTargetDigest);
  const target = taskDiffExternalContinuationBindingPath(paths, targetDigest);
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const binding = parseTaskDiffExternalContinuationBinding(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  const reservation = readTaskDiffExternalContinuationReservationInternal(
    paths,
    targetDigest,
    binding.grant.grantEnvelopeDigest,
  );
  if (
    binding.targetDigest !== targetDigest ||
    reservation === null ||
    !continuationBindingMatchesReservation(binding, reservation)
  ) {
    throw storeInvalid();
  }
  return binding;
}

/** List only canonical successful continuation bindings, never grant attempts. */
export function listAllTaskDiffExternalContinuationBindings(
  paths: InvestigationRuntimePaths,
): readonly TaskDiffExternalContinuationBinding[] {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const directory = path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-bindings',
  );
  if (!fs.existsSync(directory)) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  return Object.freeze(
    fs
      .readdirSync(directory)
      .sort()
      .map((fileName) => {
        const match = DIGEST_FILE.exec(fileName);
        if (!match) throw storeInvalid();
        const binding = parseTaskDiffExternalContinuationBinding(
          readPrivateCanonicalJson(
            paths,
            path.join(directory, fileName),
            storeInvalid,
          ),
        );
        if (binding.targetDigest !== match[1]) throw storeInvalid();
        return binding;
      }),
  );
}

export function readTaskDiffExternalChallengeResponse(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedReviewRecordDigest: string,
  requestedResponseDigest?: string,
): TaskDiffExternalChallengeResponse | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const reviewRecordDigest = assertDigest(requestedReviewRecordDigest);
  if (requestedResponseDigest !== undefined) {
    const responseDigest = assertDigest(requestedResponseDigest);
    const target = taskDiffExternalChallengeResponsePath(
      paths,
      reviewRecordDigest,
      responseDigest,
    );
    if (!privatePathExists(paths, target, storeInvalid)) return null;
    const response = parseTaskDiffExternalChallengeResponse(
      readPrivateCanonicalJson(paths, target, storeInvalid),
    );
    if (
      response.subjectDigest !== subjectDigest ||
      response.reviewRecordDigest !== reviewRecordDigest ||
      response.responseDigest !== responseDigest
    ) {
      throw storeInvalid();
    }
    return response;
  }
  const directory = path.join(taskDiffExternalStoreRoot(paths), 'responses');
  if (!fs.existsSync(directory)) return null;
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const matches = fs
    .readdirSync(directory)
    .sort()
    .flatMap((fileName) => {
      const match = SCOPED_FILE.exec(fileName);
      if (!match || match[1] !== reviewRecordDigest) return [];
      const response = parseTaskDiffExternalChallengeResponse(
        readPrivateCanonicalJson(
          paths,
          path.join(directory, fileName),
          storeInvalid,
        ),
      );
      return response.subjectDigest === subjectDigest ? [response] : [];
    });
  if (matches.length > 1) throw storeInvalid();
  return matches[0] ?? null;
}

export function readTaskDiffExternalReviewSubmission(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedReviewScopeDigest: string,
  requestedInputDigest?: string,
): TaskDiffExternalReviewSubmission | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const reviewScopeDigest = assertDigest(requestedReviewScopeDigest);
  if (requestedInputDigest !== undefined) {
    const inputDigest = assertDigest(requestedInputDigest);
    const target = taskDiffExternalReviewSubmissionPath(
      paths,
      subjectDigest,
      inputDigest,
    );
    if (!privatePathExists(paths, target, storeInvalid)) return null;
    const submission = parseTaskDiffExternalReviewSubmission(
      readPrivateCanonicalJson(paths, target, storeInvalid),
    );
    if (
      submission.subjectDigest !== subjectDigest ||
      submission.reviewScopeDigest !== reviewScopeDigest ||
      submission.inputDigest !== inputDigest
    ) {
      throw storeInvalid();
    }
    return submission;
  }
  const directory = path.join(taskDiffExternalStoreRoot(paths), 'submissions');
  if (!fs.existsSync(directory)) return null;
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const matches = fs
    .readdirSync(directory)
    .sort()
    .flatMap((fileName) => {
      const match = SCOPED_FILE.exec(fileName);
      if (!match || match[1] !== subjectDigest) return [];
      const submission = parseTaskDiffExternalReviewSubmission(
        readPrivateCanonicalJson(
          paths,
          path.join(directory, fileName),
          storeInvalid,
        ),
      );
      return submission.reviewScopeDigest === reviewScopeDigest
        ? [submission]
        : [];
    });
  if (matches.length > 1) throw storeInvalid();
  return matches[0] ?? null;
}

export function readTaskDiffExternalClosureSubmission(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedInputDigest: string,
): TaskDiffExternalClosureSubmission | null {
  assertTaskDiffExternalReviewStoreInventory(paths);
  const targetDigest = assertDigest(requestedTargetDigest);
  const inputDigest = assertDigest(requestedInputDigest);
  const target = taskDiffExternalClosureSubmissionPath(
    paths,
    targetDigest,
    inputDigest,
  );
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const submission = parseTaskDiffExternalClosureSubmission(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  if (
    submission.targetDigest !== targetDigest ||
    submission.inputDigest !== inputDigest
  ) {
    throw storeInvalid();
  }
  return submission;
}

function readTaskDiffExternalReviewReservationInternal(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedGrantEnvelopeDigest: string,
): TaskDiffExternalReviewReservation | null {
  const subjectDigest = assertDigest(requestedSubjectDigest);
  const grantEnvelopeDigest = assertDigest(requestedGrantEnvelopeDigest);
  const target = taskDiffExternalReviewReservationPath(
    paths,
    subjectDigest,
    grantEnvelopeDigest,
  );
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const reservation = parseTaskDiffExternalReviewReservation(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  if (
    reservation.subjectDigest !== subjectDigest ||
    reservation.grant.grantEnvelopeDigest !== grantEnvelopeDigest
  ) {
    throw storeInvalid();
  }
  return reservation;
}

function readTaskDiffExternalContinuationReservationInternal(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedGrantEnvelopeDigest: string,
): TaskDiffExternalContinuationReservation | null {
  const targetDigest = assertDigest(requestedTargetDigest);
  const grantEnvelopeDigest = assertDigest(requestedGrantEnvelopeDigest);
  const target = taskDiffExternalContinuationReservationPath(
    paths,
    targetDigest,
    grantEnvelopeDigest,
  );
  if (!privatePathExists(paths, target, storeInvalid)) return null;
  const reservation = parseTaskDiffExternalContinuationReservation(
    readPrivateCanonicalJson(paths, target, storeInvalid),
  );
  if (
    reservation.targetDigest !== targetDigest ||
    reservation.grant.grantEnvelopeDigest !== grantEnvelopeDigest
  ) {
    throw storeInvalid();
  }
  return reservation;
}
