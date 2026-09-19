/**
 * Persists subject-scoped task implementation reservations and result bindings.
 *
 * Invariants:
 * - Immutable publication precedes exact stored session and subject revalidation.
 * - Provider and caller records retain distinct paths, collision errors, and replay checks.
 */
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type TaskStrategyImplementationReservation,
  parseTaskStrategyImplementationReservation,
  type TaskStrategyImplementationResultBinding,
  parseTaskStrategyImplementationResultBinding,
  type TaskStrategyCallerImplementationBinding,
  parseTaskStrategyCallerImplementationBinding,
  type TaskStrategyCallerImplementationReservation,
  parseTaskStrategyCallerImplementationReservation,
} from './task-strategy-provider-record-contract.ts';
import {
  sha256,
  assertDigest,
  stateCorrupt,
} from './task-strategy-provider-store-values.ts';
import path from 'node:path';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from '../journal-primitives/investigation-private-files.ts';

export {
  type TaskStrategyImplementationReservation,
  type TaskStrategyImplementationProviderAttempt,
  type TaskStrategyImplementationResultBinding,
  type TaskStrategyCallerImplementationBinding,
  type TaskStrategyCallerImplementationReservation,
} from './task-strategy-provider-record-contract.ts';
export {
  assertTaskStrategyImplementationProviderAuthorityCurrent,
  assertTaskStrategyCallerImplementationReservationAuthorityCurrent,
  assertTaskStrategyCallerImplementationAuthorityCurrent,
} from './task-strategy-provider-authority.ts';
export {
  readTaskStrategyImplementationProviderAttempt,
  readCurrentTaskStrategyImplementationProviderAttempt,
  taskStrategyImplementationReservationForAttempt,
  taskStrategyImplementationProviderAttemptReservationDigest,
} from './task-strategy-provider-attempts.ts';

export function createTaskStrategyImplementationReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyImplementationReservation,
    'schemaVersion' | 'kind' | 'recordDigest'
  >,
): TaskStrategyImplementationReservation {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-implementation-reservation.v1' as const,
    ...input,
  };
  const reservation = parseTaskStrategyImplementationReservation({
    ...body,
    recordDigest: sha256(canonicalJson(body)),
  });
  return createSubjectScopedRecord(
    paths,
    subjectReservationPath(
      paths,
      reservation.sessionId,
      reservation.subject.subjectDigest,
    ),
    reservation,
    parseTaskStrategyImplementationReservation,
    (value) => value.subject.subjectDigest,
    reservation.sessionId,
    (value) => value.sessionId,
    'TASK_STRATEGY_IMPLEMENTATION_RESERVATION_CONFLICT',
  );
}

export function readTaskStrategyImplementationReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSubjectDigest: string,
): TaskStrategyImplementationReservation | null {
  const sessionId = assertSessionId(requestedSessionId);
  return readSubjectScopedRecord(
    paths,
    expectedSubjectDigest,
    (subjectDigest) => subjectReservationPath(paths, sessionId, subjectDigest),
    parseTaskStrategyImplementationReservation,
    (value) => value.subject.subjectDigest,
    sessionId,
    (value) => value.sessionId,
  );
}

export function createTaskStrategyImplementationResultBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyImplementationResultBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskStrategyImplementationResultBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-implementation-result-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskStrategyImplementationResultBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  return createSubjectScopedRecord(
    paths,
    subjectResultPath(paths, binding.sessionId, binding.subjectDigest),
    binding,
    parseTaskStrategyImplementationResultBinding,
    (value) => value.subjectDigest,
    binding.sessionId,
    (value) => value.sessionId,
    'TASK_STRATEGY_IMPLEMENTATION_RESULT_CONFLICT',
  );
}

export function readTaskStrategyImplementationResultBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSubjectDigest: string,
): TaskStrategyImplementationResultBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  return readSubjectScopedRecord(
    paths,
    expectedSubjectDigest,
    (subjectDigest) => subjectResultPath(paths, sessionId, subjectDigest),
    parseTaskStrategyImplementationResultBinding,
    (value) => value.subjectDigest,
    sessionId,
    (value) => value.sessionId,
  );
}

export function createTaskStrategyCallerImplementationBinding(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyCallerImplementationBinding,
    'schemaVersion' | 'kind' | 'bindingDigest'
  >,
): TaskStrategyCallerImplementationBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-caller-implementation-binding.v1' as const,
    ...input,
  };
  const binding = parseTaskStrategyCallerImplementationBinding({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
  return createSubjectScopedRecord(
    paths,
    subjectCallerResultPath(paths, binding.sessionId, binding.subjectDigest),
    binding,
    parseTaskStrategyCallerImplementationBinding,
    (value) => value.subjectDigest,
    binding.sessionId,
    (value) => value.sessionId,
    'TASK_STRATEGY_CALLER_IMPLEMENTATION_CONFLICT',
  );
}

export function readTaskStrategyCallerImplementationBinding(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSubjectDigest: string,
): TaskStrategyCallerImplementationBinding | null {
  const sessionId = assertSessionId(requestedSessionId);
  return readSubjectScopedRecord(
    paths,
    expectedSubjectDigest,
    (subjectDigest) => subjectCallerResultPath(paths, sessionId, subjectDigest),
    parseTaskStrategyCallerImplementationBinding,
    (value) => value.subjectDigest,
    sessionId,
    (value) => value.sessionId,
  );
}

export function createTaskStrategyCallerImplementationReservation(
  paths: InvestigationRuntimePaths,
  input: Omit<
    TaskStrategyCallerImplementationReservation,
    'schemaVersion' | 'kind' | 'reservationDigest'
  >,
): TaskStrategyCallerImplementationReservation {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-caller-implementation-reservation.v1' as const,
    ...input,
  };
  const reservation = parseTaskStrategyCallerImplementationReservation({
    ...body,
    reservationDigest: sha256(canonicalJson(body)),
  });
  return createSubjectScopedRecord(
    paths,
    subjectCallerReservationPath(
      paths,
      reservation.sessionId,
      reservation.subjectDigest,
    ),
    reservation,
    parseTaskStrategyCallerImplementationReservation,
    (value) => value.subjectDigest,
    reservation.sessionId,
    (value) => value.sessionId,
    'TASK_STRATEGY_CALLER_IMPLEMENTATION_RESERVATION_CONFLICT',
  );
}

export function readTaskStrategyCallerImplementationReservation(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  expectedSubjectDigest: string,
): TaskStrategyCallerImplementationReservation | null {
  const sessionId = assertSessionId(requestedSessionId);
  return readSubjectScopedRecord(
    paths,
    expectedSubjectDigest,
    (subjectDigest) =>
      subjectCallerReservationPath(paths, sessionId, subjectDigest),
    parseTaskStrategyCallerImplementationReservation,
    (value) => value.subjectDigest,
    sessionId,
    (value) => value.sessionId,
  );
}

function subjectReservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
): string {
  return subjectScopedPath(paths, sessionId, subjectDigest, 'reservation.json');
}

function subjectResultPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
): string {
  return subjectScopedPath(paths, sessionId, subjectDigest, 'result.json');
}

function subjectCallerResultPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
): string {
  return subjectScopedPath(
    paths,
    sessionId,
    subjectDigest,
    'caller-result.json',
  );
}

function subjectCallerReservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
): string {
  return subjectScopedPath(
    paths,
    sessionId,
    subjectDigest,
    'caller-reservation.json',
  );
}

function subjectScopedPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  subjectDigest: string,
  filename: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-implementations',
    sessionId,
    'subjects',
    assertDigest(subjectDigest),
    filename,
  );
}

function createSubjectScopedRecord<T>(
  paths: InvestigationRuntimePaths,
  scopedPath: string,
  value: T,
  parse: (value: unknown) => T,
  subjectDigestOf: (value: T) => string,
  expectedSessionId: string,
  sessionIdOf: (value: T) => string,
  collisionCode: string,
): T {
  const expectedSubjectDigest = assertDigest(subjectDigestOf(value));
  createPrivateCanonicalJson(
    paths,
    scopedPath,
    value,
    stateCorrupt,
    collisionCode,
  );
  const stored = readRecordAt(paths, scopedPath, parse);
  if (
    stored === null ||
    sessionIdOf(stored) !== expectedSessionId ||
    subjectDigestOf(stored) !== expectedSubjectDigest
  ) {
    throw stateCorrupt();
  }
  return stored;
}

function readSubjectScopedRecord<T>(
  paths: InvestigationRuntimePaths,
  requestedSubjectDigest: string,
  scopedPath: (subjectDigest: string) => string,
  parse: (value: unknown) => T,
  subjectDigestOf: (value: T) => string,
  expectedSessionId: string,
  sessionIdOf: (value: T) => string,
): T | null {
  const expectedSubjectDigest = assertDigest(requestedSubjectDigest);
  const scoped = readRecordAt(paths, scopedPath(expectedSubjectDigest), parse);
  if (
    scoped !== null &&
    (sessionIdOf(scoped) !== expectedSessionId ||
      subjectDigestOf(scoped) !== expectedSubjectDigest)
  ) {
    throw stateCorrupt();
  }
  return scoped;
}

function readRecordAt<T>(
  paths: InvestigationRuntimePaths,
  target: string,
  parse: (value: unknown) => T,
): T | null {
  if (!privatePathExists(paths, target, stateCorrupt)) return null;
  return parse(readPrivateCanonicalJson(paths, target, stateCorrupt));
}
