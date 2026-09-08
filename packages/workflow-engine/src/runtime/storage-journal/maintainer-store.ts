/**
 * Coordinates available, reserved, and terminal maintainer grant transitions.
 *
 * Invariants:
 * - Lifecycle locking and terminal record publication precede cleanup of nonterminal copies.
 * - Reserve, release, consume, and revoke preserve their distinct replay and conflict rules.
 */
import fs from 'node:fs';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  type MaintainerGrantV2Envelope,
  canonicalMaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2-codec.ts';
import { assertMaintainerGrantId } from '../../modules/authority/maintainer-grant.ts';
import {
  listConflictingActiveWorkflowSessionIds,
  withRepositoryLifecycleOperation,
} from '../session-workspace/session-store.ts';
import {
  assertNoGrantState,
  createPrivateFileAtomic,
  ensureStoreDirectories,
  existingStateDirectories,
  fsyncDirectory,
  grantPath,
  listGrantIds,
  maintainerGrantStorePaths,
  replacePrivateFileAtomic,
} from './maintainer-grant-files.ts';
import {
  type MaintainerGrantInspection,
  type MaintainerGrantV2RevocationTarget,
  type MaintainerReservationRecord,
  type MaintainerTerminalRecord,
  type ReservationRequest,
  inspectOne,
  inspectTerminal,
  readAvailableGrant,
  readReservation,
  readReservationOrInterrupted,
  readTerminal,
  serializeRecord,
} from './maintainer-grant-records.ts';
import {
  ambiguousGrant,
  canonicalRoot,
  exactDate,
  grantNotFound,
  nonEmpty,
  unavailableGrant,
} from './maintainer-grant-values.ts';

export { maintainerGrantStorePaths } from './maintainer-grant-files.ts';
export type {
  MaintainerGrantInspection,
  MaintainerGrantV2RevocationTarget,
  MaintainerReservationRecord,
  MaintainerTerminalRecord,
} from './maintainer-grant-records.ts';

/**
 * Stores a canonical envelope that has already been fully parsed, verified,
 * and signed by its version-specific grant service. Keeping the byte-oriented
 * primitive here lets new envelope versions share the same exclusive local
 * grant state without teaching the store how to interpret authority.
 */
export function storeCanonicalAvailableMaintainerGrantUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  canonicalEnvelope: string,
  assertOwned: () => void,
): string {
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const grantId = assertMaintainerGrantId(requestedGrantId);
  if (
    typeof canonicalEnvelope !== 'string' ||
    canonicalEnvelope.length === 0 ||
    canonicalEnvelope.length > 1_048_576 ||
    !canonicalEnvelope.endsWith('\n')
  ) {
    throw workflowError(
      'MAINTAINER_GRANT_INVALID',
      'Canonical maintainer grant envelope bytes are invalid.',
      ExitCode.guard,
    );
  }
  assertOwned();
  ensureStoreDirectories(paths);
  assertOwned();
  assertNoGrantState(paths, grantId);
  const target = grantPath(paths.available, grantId);
  createPrivateFileAtomic(target, canonicalEnvelope);
  assertOwned();
  return target;
}

export function reserveMaintainerGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
  request: ReservationRequest,
): MaintainerReservationRecord {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    ensureStoreDirectories(paths);
    assertOwned();
    const availablePath = grantPath(paths.available, grantId);
    const reservedPath = grantPath(paths.reserved, grantId);
    const terminalPath = grantPath(paths.terminal, grantId);
    if (fs.existsSync(reservedPath)) {
      readReservationOrInterrupted(reservedPath, grantId);
      throw unavailableGrant(grantId);
    }
    if (fs.existsSync(terminalPath)) {
      readTerminal(terminalPath, grantId);
      throw unavailableGrant(grantId);
    }
    const envelope = readAvailableGrant(availablePath, grantId);
    if (envelope.payload.candidateBundle === null) {
      throw workflowError(
        'MAINTAINER_GRANT_INVALID',
        'Executable maintainer authority has no exact target ref.',
        ExitCode.guard,
      );
    }
    const repositoryRoot = canonicalRoot(request.repositoryRoot);
    const activeSessions = listConflictingActiveWorkflowSessionIds(
      paths.runtime,
      {
        changeId: envelope.payload.changeId,
        repositoryRoot,
        targetRef: envelope.payload.candidateBundle.targetRef,
      },
    );
    if (activeSessions.length > 0) {
      throw workflowError(
        'ACTIVE_SESSION_CONFLICT',
        'Maintainer authority conflicts with an active change, workspace, or target ref.',
        ExitCode.conflict,
        { details: { activeSessionIds: activeSessions } },
      );
    }
    const now = exactDate(request.now ?? new Date());
    const record: MaintainerReservationRecord = {
      schemaVersion: 1,
      state: 'reserved',
      grantId,
      sessionId: nonEmpty(request.sessionId, 'reservation session ID'),
      repositoryRoot,
      reservedAt: now.toISOString(),
      envelope,
    };
    fs.renameSync(availablePath, reservedPath);
    fsyncDirectory(paths.available);
    fsyncDirectory(paths.reserved);
    replacePrivateFileAtomic(reservedPath, serializeRecord(record));
    return record;
  });
}

export function readReservedMaintainerGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
): MaintainerReservationRecord {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return readReservation(grantPath(paths.reserved, grantId), grantId);
}

export function inspectMaintainerGrants(
  gitCommonDirectory: string,
  requestedGrantId?: string,
): MaintainerGrantInspection[] {
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const grantId = requestedGrantId
    ? assertMaintainerGrantId(requestedGrantId)
    : undefined;
  const states = existingStateDirectories(paths);
  const grantIds = grantId
    ? [grantId]
    : [
        ...new Set(states.flatMap(({ directory }) => listGrantIds(directory))),
      ].sort();
  const inspected = grantIds.map((id) => inspectOne(paths, id));
  if (grantId && inspected[0] === undefined) {
    throw grantNotFound(grantId);
  }
  return inspected.filter(
    (value): value is MaintainerGrantInspection => value !== undefined,
  );
}

export function readTerminalMaintainerGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
): MaintainerTerminalRecord {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return readTerminal(grantPath(paths.terminal, grantId), grantId);
}

export function readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  assertOwned: () => void,
): MaintainerGrantV2RevocationTarget {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  assertOwned();
  ensureStoreDirectories(paths);
  assertOwned();
  const availablePath = grantPath(paths.available, grantId);
  const reservedPath = grantPath(paths.reserved, grantId);
  const terminalPath = grantPath(paths.terminal, grantId);
  const present = [availablePath, reservedPath, terminalPath].filter((entry) =>
    fs.existsSync(entry),
  );
  if (present.length === 0) throw grantNotFound(grantId);
  if (present.length !== 1) throw ambiguousGrant(grantId);
  if (present[0] === availablePath) {
    const envelope = readAvailableGrant(availablePath, grantId);
    return {
      state: 'available',
      envelope,
      sessionId: null,
      terminalReason: null,
      terminalRecordedAt: null,
    };
  }
  if (present[0] === reservedPath) {
    const reservation = readReservation(reservedPath, grantId);
    return {
      state: 'reserved',
      envelope: reservation.envelope,
      sessionId: reservation.sessionId,
      terminalReason: null,
      terminalRecordedAt: null,
    };
  }
  const terminal = readTerminal(terminalPath, grantId);
  return {
    state: terminal.state,
    envelope: terminal.envelope,
    sessionId: terminal.sessionId,
    terminalReason: terminal.reason,
    terminalRecordedAt: terminal.recordedAt,
  };
}

export function terminallyRevokeAvailableMaintainerGrantV2UnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  reason: string,
  now: Date,
  assertOwned: () => void,
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const target = readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
    gitCommonDirectory,
    grantId,
    assertOwned,
  );
  if (target.state === 'revoked') {
    if (target.terminalReason !== reason) {
      throw workflowError(
        'MAINTAINER_GRANT_REVOCATION_CONFLICT',
        'Apply Grant v2 was already revoked with a different exact reason.',
        ExitCode.conflict,
      );
    }
    return inspectTerminal(
      readTerminal(grantPath(paths.terminal, grantId), grantId),
    );
  }
  if (target.state !== 'available') {
    throw workflowError(
      'MAINTAINER_GRANT_REVOCATION_STATE_INVALID',
      'Apply Grant v2 revocation only terminalizes an available unused grant.',
      ExitCode.guard,
    );
  }
  const terminal: MaintainerTerminalRecord = {
    schemaVersion: 1,
    state: 'revoked',
    grantId,
    sessionId: null,
    commitHash: null,
    reason,
    recordedAt: exactDate(now).toISOString(),
    envelope: target.envelope,
  };
  const terminalPath = grantPath(paths.terminal, grantId);
  createPrivateFileAtomic(terminalPath, serializeRecord(terminal));
  cleanupNonterminalCopies(paths, grantId, target.envelope);
  assertOwned();
  return inspectTerminal(terminal);
}

export function terminallyFailAvailableMaintainerGrantV2UnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  reason: string,
  now: Date,
  assertOwned: () => void,
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  const target = readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
    gitCommonDirectory,
    grantId,
    assertOwned,
  );
  if (target.state === 'failed') {
    return inspectTerminal(
      readTerminal(grantPath(paths.terminal, grantId), grantId),
    );
  }
  if (target.state !== 'available') {
    throw workflowError(
      'MAINTAINER_GRANT_FAILURE_STATE_INVALID',
      'Only an available Apply Grant v2 may fail before reservation.',
      ExitCode.guard,
    );
  }
  const terminal: MaintainerTerminalRecord = {
    schemaVersion: 1,
    state: 'failed',
    grantId,
    sessionId: null,
    commitHash: null,
    reason,
    recordedAt: exactDate(now).toISOString(),
    envelope: target.envelope,
  };
  createPrivateFileAtomic(
    grantPath(paths.terminal, grantId),
    serializeRecord(terminal),
  );
  cleanupNonterminalCopies(paths, grantId, target.envelope);
  assertOwned();
  return inspectTerminal(terminal);
}

export function terminallyFailSignedMaintainerGrantV2UnderLifecycleLock(
  gitCommonDirectory: string,
  envelope: MaintainerGrantV2Envelope,
  reason: string,
  now: Date,
  assertOwned: () => void,
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(envelope.payload.grantId);
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  assertOwned();
  ensureStoreDirectories(paths);
  const availablePath = grantPath(paths.available, grantId);
  const reservedPath = grantPath(paths.reserved, grantId);
  const terminalPath = grantPath(paths.terminal, grantId);
  if (fs.existsSync(reservedPath)) {
    throw workflowError(
      'MAINTAINER_GRANT_FAILURE_STATE_INVALID',
      'An in-flight signed grant cannot become reserved during publication cleanup.',
      ExitCode.guard,
    );
  }
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    if (
      terminal.state !== 'failed' ||
      canonicalMaintainerGrantV2Envelope(terminal.envelope) !==
        canonicalMaintainerGrantV2Envelope(envelope)
    ) {
      throw ambiguousGrant(grantId);
    }
    cleanupNonterminalCopies(paths, grantId, terminal.envelope);
    return inspectTerminal(terminal);
  }
  if (fs.existsSync(availablePath)) {
    const available = readAvailableGrant(availablePath, grantId);
    if (
      canonicalMaintainerGrantV2Envelope(available) !==
      canonicalMaintainerGrantV2Envelope(envelope)
    ) {
      throw ambiguousGrant(grantId);
    }
  }
  const terminal: MaintainerTerminalRecord = {
    schemaVersion: 1,
    state: 'failed',
    grantId,
    sessionId: null,
    commitHash: null,
    reason,
    recordedAt: exactDate(now).toISOString(),
    envelope,
  };
  createPrivateFileAtomic(terminalPath, serializeRecord(terminal));
  cleanupNonterminalCopies(paths, grantId, envelope);
  assertOwned();
  return inspectTerminal(terminal);
}

export function terminallyRevokeMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservation(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'revoked',
    reason,
    now,
  );
}

export function terminallyExpireMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservation(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'expired',
    reason,
    now,
  );
}

export function terminallyInvalidateMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservation(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'invalidated',
    reason,
    now,
  );
}

export function terminallyFailMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservation(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'failed',
    reason,
    now,
  );
}

export function terminallyInvalidateMaintainerReservationUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservationState(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'invalidated',
    reason,
    now,
  );
}

export function terminallyExpireMaintainerReservationUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservationState(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'expired',
    reason,
    now,
  );
}

export function terminallyFailMaintainerReservationUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  reason: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  return terminalizeMaintainerReservationState(
    gitCommonDirectory,
    requestedGrantId,
    requestedSessionId,
    'failed',
    reason,
    now,
  );
}

function terminalizeMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  terminalState: 'revoked' | 'expired' | 'invalidated' | 'failed',
  reason: string,
  now: Date,
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const terminalReason = nonEmpty(reason, 'terminal reason');
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      assertOwned();
      return terminalizeMaintainerReservationState(
        gitCommonDirectory,
        grantId,
        sessionId,
        terminalState,
        terminalReason,
        now,
      );
    },
    { allowMaintainerGrantId: grantId },
  );
}

function terminalizeMaintainerReservationState(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  terminalState: 'revoked' | 'expired' | 'invalidated' | 'failed',
  reason: string,
  now: Date,
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const terminalReason = nonEmpty(reason, 'terminal reason');
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  ensureStoreDirectories(paths);
  const terminalPath = grantPath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    if (terminal.sessionId !== sessionId) {
      throw unavailableGrant(grantId);
    }
    cleanupNonterminalCopies(paths, grantId, terminal.envelope);
    return inspectTerminal(terminal);
  }
  const reservedPath = grantPath(paths.reserved, grantId);
  const reservation = readReservation(reservedPath, grantId);
  if (reservation.sessionId !== sessionId) {
    throw unavailableGrant(grantId);
  }
  const terminal: MaintainerTerminalRecord = {
    schemaVersion: 1,
    state: terminalState,
    grantId,
    sessionId,
    commitHash: null,
    reason: terminalReason,
    recordedAt: exactDate(now).toISOString(),
    envelope: reservation.envelope,
  };
  createPrivateFileAtomic(terminalPath, serializeRecord(terminal));
  cleanupNonterminalCopies(paths, grantId, reservation.envelope);
  return inspectTerminal(terminal);
}

/**
 * Returns a reserved grant to the available store. Used when a session fails
 * on a recoverable precondition before any durable session or repository
 * mutation exists; the grant keeps its original envelope, signature, and
 * expiry, so the maintainer does not need to re-sign it.
 */
export function releaseMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
): void {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      ensureStoreDirectories(paths);
      assertOwned();
      if (fs.existsSync(grantPath(paths.terminal, grantId))) {
        throw unavailableGrant(grantId);
      }
      const reservedPath = grantPath(paths.reserved, grantId);
      const reservation = readReservation(reservedPath, grantId);
      if (reservation.sessionId !== sessionId) {
        throw unavailableGrant(grantId);
      }
      createPrivateFileAtomic(
        grantPath(paths.available, grantId),
        canonicalMaintainerGrantV2Envelope(reservation.envelope),
      );
      fs.rmSync(reservedPath, { force: true });
      fsyncDirectory(paths.available);
      fsyncDirectory(paths.reserved);
    },
    { allowMaintainerGrantId: grantId },
  );
}

export function consumeMaintainerReservation(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  requestedCommitHash: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const commitHash = requestedCommitHash.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commitHash)) {
    throw workflowError(
      'MAINTAINER_COMMIT_INVALID',
      'Maintainer consumption requires a full commit object ID.',
      ExitCode.guard,
    );
  }
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) => {
      assertOwned();
      return consumeMaintainerReservationUnderLifecycleLock(
        gitCommonDirectory,
        grantId,
        sessionId,
        commitHash,
        now,
      );
    },
    { allowMaintainerGrantId: grantId },
  );
}

export function consumeMaintainerReservationUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  requestedSessionId: string,
  requestedCommitHash: string,
  now: Date = new Date(),
): MaintainerGrantInspection {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const sessionId = nonEmpty(requestedSessionId, 'reservation session ID');
  const commitHash = requestedCommitHash.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commitHash)) {
    throw workflowError(
      'MAINTAINER_COMMIT_INVALID',
      'Maintainer consumption requires a full commit object ID.',
      ExitCode.guard,
    );
  }
  const paths = maintainerGrantStorePaths(gitCommonDirectory);
  ensureStoreDirectories(paths);
  const terminalPath = grantPath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    if (
      terminal.state !== 'consumed' ||
      terminal.sessionId !== sessionId ||
      terminal.commitHash !== commitHash
    ) {
      throw unavailableGrant(grantId);
    }
    cleanupNonterminalCopies(paths, grantId, terminal.envelope);
    return inspectTerminal(terminal);
  }

  const reservedPath = grantPath(paths.reserved, grantId);
  const reservation = readReservation(reservedPath, grantId);
  if (reservation.sessionId !== sessionId) {
    throw unavailableGrant(grantId);
  }
  const terminal: MaintainerTerminalRecord = {
    schemaVersion: 1,
    state: 'consumed',
    grantId,
    sessionId,
    commitHash,
    reason: 'Signed authority commit accepted',
    recordedAt: exactDate(now).toISOString(),
    envelope: reservation.envelope,
  };
  createPrivateFileAtomic(terminalPath, serializeRecord(terminal));
  cleanupNonterminalCopies(paths, grantId, reservation.envelope);
  return inspectTerminal(terminal);
}

function cleanupNonterminalCopies(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
  grantId: string,
  expected: MaintainerGrantV2Envelope,
): void {
  for (const directory of [paths.available, paths.reserved]) {
    const target = grantPath(directory, grantId);
    if (!fs.existsSync(target)) {
      continue;
    }
    const observed =
      directory === paths.available
        ? readAvailableGrant(target, grantId)
        : readReservationOrInterrupted(target, grantId).envelope;
    if (
      canonicalMaintainerGrantV2Envelope(observed) !==
      canonicalMaintainerGrantV2Envelope(expected)
    ) {
      throw ambiguousGrant(grantId);
    }
    fs.unlinkSync(target);
    fsyncDirectory(directory);
  }
}
