/**
 * Reserves, publishes, and reads correction rounds for one failed RED lineage.
 *
 * Invariants:
 * - The same per-lineage lock protects publication, exact replay, and contiguous round checks.
 * - Failure validation precedes publication and imported rounds preserve their predecessor bindings.
 */
import {
  type InvestigationRuntimePaths,
  assertSessionId,
} from '../session-workspace/paths.ts';
import {
  parseTaskStrategyCorrectionPolicy,
  parseTaskStrategyGreenFailureRecord,
  type TaskStrategyGreenFailureRecord,
  type TaskStrategyCorrectionPolicy,
} from './task-strategy-correction-store.ts';
import {
  createPrivateCanonicalJson,
  assertPrivateInvestigationDirectory,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
} from './investigation-private-files.ts';
import {
  type ReserveTaskStrategyCorrectionRoundInput,
  type TaskStrategyCorrectionRoundReservation,
  prepareReservation,
  assertStoredFailure,
  assertRoundCanFollow,
  type PublishTaskStrategyCorrectionRoundResultInput,
  type TaskStrategyCorrectionRoundResult,
  prepareResult,
  type PublishTaskStrategyCorrectionRoundImportInput,
  type TaskStrategyCorrectionRoundImport,
  prepareImport,
  type TaskStrategyCorrectionRound,
  parseReservation,
  parseResult,
  parseImport,
  assertSnapshotLinks,
  assertContiguousRoundLineage,
  type TaskStrategyCorrectionState,
  policyDigest,
  failureIdentityMatches,
} from './task-strategy-correction-round-contract.ts';
import {
  isPositiveInteger,
  correctionRoundExhausted,
  correctionRoundStateInvalid,
  sameExceptAudit,
  correctionRoundReservationConflict,
  correctionRoundSequenceInvalid,
  assertDigest,
  assertRound,
  correctionRoundResultConflict,
  correctionRoundImportConflict,
  deepFreeze,
  ROUND_DIRECTORY,
} from './task-strategy-correction-round-values.ts';
import fs from 'node:fs';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import path from 'node:path';

export {
  type TaskStrategyCorrectionFailureIdentity,
  type TaskStrategyCorrectionProviderRequestIdentity,
  type TaskStrategyCorrectionProviderReservationIdentity,
  type TaskStrategyCorrectionProviderResultIdentity,
  type TaskStrategyCorrectionProviderAttemptIdentity,
  type TaskStrategyCorrectionCallerReservationIdentity,
  type TaskStrategyCorrectionCallerResultIdentity,
  type TaskStrategyCorrectionPatchResult,
  type TaskStrategyCorrectionReservationAuthority,
  type TaskStrategyCorrectionResultAuthority,
  type TaskStrategyCorrectionImportReceiptIdentity,
  type TaskStrategyCorrectionRoundReservation,
  type TaskStrategyCorrectionRoundResult,
  type TaskStrategyCorrectionRoundImport,
  type TaskStrategyCorrectionRound,
  type TaskStrategyCorrectionState,
  type ReserveTaskStrategyCorrectionRoundInput,
  type PublishTaskStrategyCorrectionRoundResultInput,
  type PublishTaskStrategyCorrectionRoundImportInput,
} from './task-strategy-correction-round-contract.ts';

export function reserveTaskStrategyCorrectionRound(
  paths: InvestigationRuntimePaths,
  input: ReserveTaskStrategyCorrectionRoundInput,
): TaskStrategyCorrectionRoundReservation {
  const sessionId = assertSessionId(input.sessionId);
  const policy = parseTaskStrategyCorrectionPolicy(input.policy);
  if (
    !isPositiveInteger(input.round) ||
    input.round > policy.maxRepairAttempts
  ) {
    throw correctionRoundExhausted();
  }
  const failure = parseTaskStrategyGreenFailureRecord(input.predecessorFailure);
  if (
    failure.sessionId !== sessionId ||
    failure.currentRedTransactionDigest.length !== 64
  ) {
    throw correctionRoundStateInvalid();
  }
  const prepared = prepareReservation({
    ...input,
    sessionId,
    policy,
    predecessorFailure: failure,
  });
  return withCorrectionRoundLock(
    paths,
    sessionId,
    failure.currentRedTransactionDigest,
    () => {
      assertStoredFailure(paths, failure);
      const rounds = listTaskStrategyCorrectionRounds(
        paths,
        sessionId,
        failure.currentRedTransactionDigest,
      );
      const existing = rounds[input.round - 1]?.reservation ?? null;
      if (existing !== null) {
        if (
          sameExceptAudit(existing, prepared, [
            'reservationDigest',
            'createdAt',
          ])
        ) {
          return existing;
        }
        throw correctionRoundReservationConflict();
      }
      if (input.round !== rounds.length + 1) {
        throw correctionRoundSequenceInvalid();
      }
      assertRoundCanFollow(rounds, prepared);
      if (
        rounds.filter(
          ({ reservation }) =>
            reservation.predecessorFailure.failureFingerprint ===
            failure.failingCheck.failureFingerprint,
        ).length >= policy.maxSameFailureFingerprint
      ) {
        throw correctionRoundExhausted();
      }
      createPrivateCanonicalJson(
        paths,
        reservationPath(
          paths,
          sessionId,
          failure.currentRedTransactionDigest,
          input.round,
        ),
        prepared,
        correctionRoundStateInvalid,
        'TASK_STRATEGY_CORRECTION_ROUND_RESERVATION_CONFLICT',
      );
      const stored = readTaskStrategyCorrectionRound(
        paths,
        sessionId,
        failure.currentRedTransactionDigest,
        input.round,
      )?.reservation;
      if (stored === undefined) throw correctionRoundStateInvalid();
      return stored;
    },
  );
}

export function publishTaskStrategyCorrectionRoundResult(
  paths: InvestigationRuntimePaths,
  input: PublishTaskStrategyCorrectionRoundResultInput,
): TaskStrategyCorrectionRoundResult {
  const sessionId = assertSessionId(input.sessionId);
  const redTransactionDigest = assertDigest(input.currentRedTransactionDigest);
  const round = assertRound(input.round);
  return withCorrectionRoundLock(paths, sessionId, redTransactionDigest, () => {
    const snapshot = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      round,
    );
    if (snapshot === null || snapshot.importRecord !== null) {
      throw correctionRoundSequenceInvalid();
    }
    const prepared = prepareResult(snapshot.reservation, input);
    if (snapshot.result !== null) {
      if (
        sameExceptAudit(snapshot.result, prepared, [
          'resultDigest',
          'createdAt',
        ])
      ) {
        return snapshot.result;
      }
      throw correctionRoundResultConflict();
    }
    createPrivateCanonicalJson(
      paths,
      resultPath(paths, sessionId, redTransactionDigest, round),
      prepared,
      correctionRoundStateInvalid,
      'TASK_STRATEGY_CORRECTION_ROUND_RESULT_CONFLICT',
    );
    const stored = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      round,
    )?.result;
    if (stored === undefined || stored === null) {
      throw correctionRoundStateInvalid();
    }
    return stored;
  });
}

export function publishTaskStrategyCorrectionRoundImport(
  paths: InvestigationRuntimePaths,
  input: PublishTaskStrategyCorrectionRoundImportInput,
): TaskStrategyCorrectionRoundImport {
  const sessionId = assertSessionId(input.sessionId);
  const redTransactionDigest = assertDigest(input.currentRedTransactionDigest);
  const round = assertRound(input.round);
  return withCorrectionRoundLock(paths, sessionId, redTransactionDigest, () => {
    const snapshot = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      round,
    );
    if (snapshot === null || snapshot.result === null) {
      throw correctionRoundSequenceInvalid();
    }
    const prepared = prepareImport(
      snapshot.reservation,
      snapshot.result,
      input,
    );
    if (snapshot.importRecord !== null) {
      if (
        sameExceptAudit(snapshot.importRecord, prepared, [
          'importDigest',
          'importedAt',
        ])
      ) {
        return snapshot.importRecord;
      }
      throw correctionRoundImportConflict();
    }
    createPrivateCanonicalJson(
      paths,
      importPath(paths, sessionId, redTransactionDigest, round),
      prepared,
      correctionRoundStateInvalid,
      'TASK_STRATEGY_CORRECTION_ROUND_IMPORT_CONFLICT',
    );
    const stored = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      round,
    )?.importRecord;
    if (stored === undefined || stored === null) {
      throw correctionRoundStateInvalid();
    }
    return stored;
  });
}

export function readTaskStrategyCorrectionRound(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedRedTransactionDigest: string,
  requestedRound: number,
): TaskStrategyCorrectionRound | null {
  const sessionId = assertSessionId(requestedSessionId);
  const redTransactionDigest = assertDigest(requestedRedTransactionDigest);
  const round = assertRound(requestedRound);
  const target = roundDirectory(paths, sessionId, redTransactionDigest, round);
  const observed = fs.lstatSync(target, { throwIfNoEntry: false });
  if (observed === undefined) return null;
  assertPrivateInvestigationDirectory(
    paths,
    target,
    correctionRoundStateInvalid,
  );
  const names = listRoundArtifactNames(target);
  const reservation = parseReservation(
    readPrivateCanonicalJson(
      paths,
      reservationPath(paths, sessionId, redTransactionDigest, round),
      correctionRoundStateInvalid,
    ),
  );
  const result = names.includes('result.json')
    ? parseResult(
        readPrivateCanonicalJson(
          paths,
          resultPath(paths, sessionId, redTransactionDigest, round),
          correctionRoundStateInvalid,
        ),
      )
    : null;
  const importRecord = names.includes('import.json')
    ? parseImport(
        readPrivateCanonicalJson(
          paths,
          importPath(paths, sessionId, redTransactionDigest, round),
          correctionRoundStateInvalid,
        ),
      )
    : null;
  assertSnapshotLinks(
    { reservation, result, importRecord },
    sessionId,
    redTransactionDigest,
    round,
  );
  return deepFreeze({ reservation, result, importRecord });
}

export function listTaskStrategyCorrectionRounds(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedRedTransactionDigest: string,
): readonly TaskStrategyCorrectionRound[] {
  const sessionId = assertSessionId(requestedSessionId);
  const redTransactionDigest = assertDigest(requestedRedTransactionDigest);
  const directory = lineageDirectory(paths, sessionId, redTransactionDigest);
  const observed = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (observed === undefined) return Object.freeze([]);
  assertPrivateInvestigationDirectory(
    paths,
    directory,
    correctionRoundStateInvalid,
  );
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    entries.some(
      (entry) =>
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        !ROUND_DIRECTORY.test(entry.name),
    )
  ) {
    throw correctionRoundStateInvalid();
  }
  const rounds = entries.map((entry, index) => {
    const observedRound = Number(ROUND_DIRECTORY.exec(entry.name)?.[1]);
    if (observedRound !== index + 1) throw correctionRoundStateInvalid();
    const snapshot = readTaskStrategyCorrectionRound(
      paths,
      sessionId,
      redTransactionDigest,
      observedRound,
    );
    if (snapshot === null) throw correctionRoundStateInvalid();
    return snapshot;
  });
  assertContiguousRoundLineage(rounds);
  return deepFreeze(rounds);
}

export function deriveTaskStrategyCorrectionState(
  paths: InvestigationRuntimePaths,
  currentFailureValue: TaskStrategyGreenFailureRecord,
  requestedPolicy: TaskStrategyCorrectionPolicy,
): TaskStrategyCorrectionState {
  const currentFailure =
    parseTaskStrategyGreenFailureRecord(currentFailureValue);
  const policy = parseTaskStrategyCorrectionPolicy(requestedPolicy);
  assertStoredFailure(paths, currentFailure);
  const rounds = listTaskStrategyCorrectionRounds(
    paths,
    currentFailure.sessionId,
    currentFailure.currentRedTransactionDigest,
  );
  if (rounds.length === 0) {
    return deepFreeze({
      state: 'correction-required',
      round: 1,
      nextAction: 'reserve',
    });
  }
  if (
    rounds.some(
      ({ reservation }) => reservation.policyDigest !== policyDigest(policy),
    )
  ) {
    throw correctionRoundStateInvalid();
  }
  const latest = rounds.at(-1)!;
  if (latest.importRecord === null) {
    if (
      !failureIdentityMatches(
        latest.reservation.predecessorFailure,
        currentFailure,
      )
    ) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      state: 'correction-required',
      round: latest.reservation.round,
      nextAction:
        latest.result === null ? 'publish-result' : 'publish-import-receipt',
      correctionSubjectDigest: latest.reservation.correctionSubjectDigest,
    });
  }
  if (
    latest.importRecord.patchResult.targetCandidateTree !==
      currentFailure.candidateTree ||
    canonicalJson(latest.importRecord.currentPatchHead) !==
      canonicalJson(currentFailure.currentPatchHead)
  ) {
    throw correctionRoundStateInvalid();
  }
  const sameFingerprintAttempts = rounds.filter(
    ({ reservation }) =>
      reservation.predecessorFailure.failureFingerprint ===
      currentFailure.failingCheck.failureFingerprint,
  ).length;
  if (sameFingerprintAttempts >= policy.maxSameFailureFingerprint) {
    return deepFreeze({
      state: 'correction-exhausted',
      completedRounds: rounds.length,
      reason: 'same-failure-fingerprint',
      failureRecordDigest: currentFailure.recordDigest,
    });
  }
  if (rounds.length >= policy.maxRepairAttempts) {
    return deepFreeze({
      state: 'correction-exhausted',
      completedRounds: rounds.length,
      reason: 'max-repair-attempts',
      failureRecordDigest: currentFailure.recordDigest,
    });
  }
  return deepFreeze({
    state: 'correction-required',
    round: rounds.length + 1,
    nextAction: 'reserve',
  });
}

function listRoundArtifactNames(directory: string): readonly string[] {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
    throw correctionRoundStateInvalid();
  }
  const names = entries.map(({ name }) => name);
  const valid = [
    ['reservation.json'],
    ['reservation.json', 'result.json'],
    ['import.json', 'reservation.json', 'result.json'],
  ];
  if (
    !valid.some((expected) => canonicalJson(expected) === canonicalJson(names))
  ) {
    throw correctionRoundStateInvalid();
  }
  return Object.freeze(names);
}

function withCorrectionRoundLock<T>(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  operation: () => T,
): T {
  return withPrivateRuntimeLock(
    paths,
    path.join(
      paths.locks,
      'task-strategy-correction-rounds',
      `${sessionId}-${redTransactionDigest}.lock`,
    ),
    operation,
    'TASK_STRATEGY_CORRECTION_ROUND_BUSY',
    correctionRoundStateInvalid,
  );
}

function lineageDirectory(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-correction-rounds',
    sessionId,
    redTransactionDigest,
  );
}

function roundDirectory(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): string {
  return path.join(
    lineageDirectory(paths, sessionId, redTransactionDigest),
    String(round).padStart(4, '0'),
  );
}

function reservationPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): string {
  return path.join(
    roundDirectory(paths, sessionId, redTransactionDigest, round),
    'reservation.json',
  );
}

function resultPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): string {
  return path.join(
    roundDirectory(paths, sessionId, redTransactionDigest, round),
    'result.json',
  );
}

function importPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  redTransactionDigest: string,
  round: number,
): string {
  return path.join(
    roundDirectory(paths, sessionId, redTransactionDigest, round),
    'import.json',
  );
}
