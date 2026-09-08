/**
 * Resolves external review record paths and the permitted inventory filenames.
 *
 * Invariants:
 * - Digest validation and namespace names retain their exact representation.
 */
import path from 'node:path';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { assertDigest } from './task-diff-external-store-contracts.ts';

export const DIGEST_FILE = /^([0-9a-f]{64})\.json$/u;

export const ATTEMPT_FILE = /^([0-9a-f]{64})\.([0-9a-f]{64})\.json$/u;

export const SCOPED_FILE = /^([0-9a-f]{64})\.([0-9a-f]{64})\.json$/u;

export const STORE_DIRECTORIES = Object.freeze([
  'review-reservations',
  'review-bindings',
  'continuation-reservations',
  'continuation-bindings',
  'responses',
  'submissions',
  'closure-submissions',
] as const);

export function taskDiffExternalReviewReservationPath(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedGrantEnvelopeDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'review-reservations',
    `${assertDigest(requestedSubjectDigest)}.${assertDigest(requestedGrantEnvelopeDigest)}.json`,
  );
}

export function taskDiffExternalReviewBindingPath(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'review-bindings',
    `${assertDigest(requestedSubjectDigest)}.json`,
  );
}

export function taskDiffExternalContinuationReservationPath(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedGrantEnvelopeDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-reservations',
    `${assertDigest(requestedTargetDigest)}.${assertDigest(requestedGrantEnvelopeDigest)}.json`,
  );
}

export function taskDiffExternalContinuationBindingPath(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'continuation-bindings',
    `${assertDigest(requestedTargetDigest)}.json`,
  );
}

export function taskDiffExternalChallengeResponsePath(
  paths: InvestigationRuntimePaths,
  requestedReviewRecordDigest: string,
  requestedResponseDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'responses',
    `${assertDigest(requestedReviewRecordDigest)}.${assertDigest(requestedResponseDigest)}.json`,
  );
}

export function taskDiffExternalReviewSubmissionPath(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  requestedInputDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'submissions',
    `${assertDigest(requestedSubjectDigest)}.${assertDigest(requestedInputDigest)}.json`,
  );
}

export function taskDiffExternalClosureSubmissionPath(
  paths: InvestigationRuntimePaths,
  requestedTargetDigest: string,
  requestedInputDigest: string,
): string {
  return path.join(
    taskDiffExternalStoreRoot(paths),
    'closure-submissions',
    `${assertDigest(requestedTargetDigest)}.${assertDigest(requestedInputDigest)}.json`,
  );
}

export function taskDiffExternalStoreRoot(
  paths: InvestigationRuntimePaths,
): string {
  return path.join(paths.refs, 'task-diff-reviews', 'external-authority');
}
