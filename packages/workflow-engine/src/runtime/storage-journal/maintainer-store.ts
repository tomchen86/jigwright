import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import { assertMaintainerGrantId } from '../../modules/authority/maintainer-grant.ts';
import {
  canonicalMaintainerGrantV2Envelope,
  parseMaintainerGrantV2Envelope,
  type MaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2.ts';
import {
  listConflictingActiveWorkflowSessionIds,
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../session-workspace/session-store.ts';
export type MaintainerReservationRecord = {
  schemaVersion: 1;
  state: 'reserved';
  grantId: string;
  sessionId: string;
  repositoryRoot: string;
  reservedAt: string;
  envelope: MaintainerGrantV2Envelope;
};

export type MaintainerTerminalRecord = {
  schemaVersion: 1;
  state: 'revoked' | 'consumed' | 'expired' | 'invalidated' | 'failed';
  grantId: string;
  sessionId: string | null;
  commitHash: string | null;
  reason: string;
  recordedAt: string;
  envelope: MaintainerGrantV2Envelope;
};

export type MaintainerGrantInspection = {
  grantId: string;
  state:
    | 'available'
    | 'reserved'
    | 'revoked'
    | 'consumed'
    | 'expired'
    | 'invalidated'
    | 'failed';
  changeId: string;
  baseCommit: string;
  allowedPaths: string[];
  issuedAt: string;
  expiresAt: string;
  signer: string;
  reservationSessionId?: string;
  terminalReason?: string;
  commitHash?: string;
};

export type MaintainerGrantV2RevocationTarget = {
  state: 'available' | 'reserved' | MaintainerTerminalRecord['state'];
  envelope: MaintainerGrantV2Envelope;
  sessionId: string | null;
  terminalReason: string | null;
  terminalRecordedAt: string | null;
};

type ReservationRequest = {
  sessionId: string;
  repositoryRoot: string;
  now?: Date;
};

export function maintainerGrantStorePaths(gitCommonDirectory: string) {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  const root = path.join(runtime.root, 'maintainer-grants');
  return {
    runtime,
    root,
    available: path.join(root, 'available'),
    reserved: path.join(root, 'reserved'),
    terminal: path.join(root, 'terminal'),
    journals: path.join(root, 'journals'),
    sessions: path.join(root, 'sessions'),
  };
}

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

function inspectOne(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
  grantId: string,
): MaintainerGrantInspection | undefined {
  const existing = [
    fs.existsSync(grantPath(paths.available, grantId)) && 'available',
    fs.existsSync(grantPath(paths.reserved, grantId)) && 'reserved',
    fs.existsSync(grantPath(paths.terminal, grantId)) && 'terminal',
  ].filter(Boolean);
  if (existing.length === 0) {
    return undefined;
  }
  if (existing.length !== 1) {
    throw ambiguousGrant(grantId);
  }
  if (existing[0] === 'available') {
    return inspectEnvelope(
      readAvailableGrant(grantPath(paths.available, grantId), grantId),
      'available',
    );
  }
  if (existing[0] === 'reserved') {
    const reservation = readReservation(
      grantPath(paths.reserved, grantId),
      grantId,
    );
    return {
      ...inspectEnvelope(reservation.envelope, 'reserved'),
      reservationSessionId: reservation.sessionId,
    };
  }
  return inspectTerminal(
    readTerminal(grantPath(paths.terminal, grantId), grantId),
  );
}

function inspectEnvelope(
  envelope: MaintainerGrantV2Envelope,
  state: 'available' | 'reserved',
): MaintainerGrantInspection {
  const { payload } = envelope;
  return {
    grantId: payload.grantId,
    state,
    changeId: payload.changeId,
    baseCommit: payload.baseCommit,
    allowedPaths: [...payload.allowedPaths],
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    signer: payload.signer,
  };
}

function inspectTerminal(
  terminal: MaintainerTerminalRecord,
): MaintainerGrantInspection {
  return {
    ...inspectEnvelope(terminal.envelope, 'available'),
    state: terminal.state,
    ...(terminal.sessionId ? { reservationSessionId: terminal.sessionId } : {}),
    terminalReason: terminal.reason,
    ...(terminal.commitHash ? { commitHash: terminal.commitHash } : {}),
  };
}

function readAvailableGrant(
  filePath: string,
  grantId: string,
): MaintainerGrantV2Envelope {
  const envelope = parseMaintainerGrantV2Envelope(readPrivateFile(filePath));
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  return envelope;
}

function readReservation(
  filePath: string,
  grantId: string,
): MaintainerReservationRecord {
  const value = parseRecord(readPrivateFile(filePath));
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'grantId',
      'sessionId',
      'repositoryRoot',
      'reservedAt',
      'envelope',
    ]) ||
    value.schemaVersion !== 1 ||
    value.state !== 'reserved' ||
    value.grantId !== grantId ||
    typeof value.sessionId !== 'string' ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.reservedAt !== 'string'
  ) {
    throw ambiguousGrant(grantId);
  }
  const envelope = parseMaintainerGrantV2Envelope(
    serializeEmbeddedEnvelope(value.envelope),
  );
  if (
    envelope.payload.grantId !== grantId ||
    !path.isAbsolute(value.repositoryRoot) ||
    !isExactTimestamp(value.reservedAt)
  ) {
    throw ambiguousGrant(grantId);
  }
  return { ...value, envelope } as MaintainerReservationRecord;
}

function readReservationOrInterrupted(
  filePath: string,
  grantId: string,
): { envelope: MaintainerGrantV2Envelope; sessionId?: string } {
  try {
    return readReservation(filePath, grantId);
  } catch {
    return { envelope: readAvailableGrant(filePath, grantId) };
  }
}

function readTerminal(
  filePath: string,
  grantId: string,
): MaintainerTerminalRecord {
  const value = parseRecord(readPrivateFile(filePath));
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'grantId',
      'sessionId',
      'commitHash',
      'reason',
      'recordedAt',
      'envelope',
    ]) ||
    value.schemaVersion !== 1 ||
    !['revoked', 'consumed', 'expired', 'invalidated', 'failed'].includes(
      String(value.state),
    ) ||
    value.grantId !== grantId ||
    (value.sessionId !== null && typeof value.sessionId !== 'string') ||
    (value.commitHash !== null && typeof value.commitHash !== 'string') ||
    typeof value.reason !== 'string' ||
    typeof value.recordedAt !== 'string' ||
    !isExactTimestamp(value.recordedAt)
  ) {
    throw ambiguousGrant(grantId);
  }
  const envelope = parseMaintainerGrantV2Envelope(
    serializeEmbeddedEnvelope(value.envelope),
  );
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  return { ...value, envelope } as MaintainerTerminalRecord;
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

function ensureStoreDirectories(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
): void {
  for (const directory of [
    paths.root,
    paths.available,
    paths.reserved,
    paths.terminal,
    paths.journals,
    paths.sessions,
  ]) {
    const existed = fs.existsSync(directory);
    ensurePlainDirectory(directory);
    fs.chmodSync(directory, 0o700);
    if ((fs.statSync(directory).mode & 0o777) !== 0o700) {
      throw unsafeStore();
    }
    if (!existed) {
      fsyncDirectory(path.dirname(directory));
    }
  }
}

function existingStateDirectories(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
): Array<{ directory: string }> {
  const directories = [paths.available, paths.reserved, paths.terminal];
  return directories.flatMap((directory) => {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats) {
      return [];
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory) ||
      (stats.mode & 0o777) !== 0o700
    ) {
      throw unsafeStore();
    }
    return [{ directory }];
  });
}

function assertNoGrantState(
  paths: ReturnType<typeof maintainerGrantStorePaths>,
  grantId: string,
): void {
  if (
    [paths.available, paths.reserved, paths.terminal].some((directory) =>
      fs.existsSync(grantPath(directory, grantId)),
    )
  ) {
    throw unavailableGrant(grantId);
  }
}

function listGrantIds(directory: string): string[] {
  return fs.readdirSync(directory).map((entry) => {
    if (!entry.endsWith('.json')) {
      throw unsafeStore();
    }
    return assertMaintainerGrantId(entry.slice(0, -'.json'.length));
  });
}

function grantPath(directory: string, grantId: string): string {
  return path.join(directory, `${assertMaintainerGrantId(grantId)}.json`);
}

function createPrivateFileAtomic(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw unavailableGrant(path.basename(filePath, '.json'));
    }
    throw error;
  }
}

function replacePrivateFileAtomic(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
}

function readPrivateFile(filePath: string): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw unsafeStore();
  }
  return fs.readFileSync(filePath, 'utf8');
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function serializeRecord(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function serializeEmbeddedEnvelope(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      raw !== `${JSON.stringify(value)}\n`
    ) {
      throw new Error('not canonical');
    }
    return value as Record<string, unknown>;
  } catch {
    throw unsafeStore();
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((entry, index) => entry === sorted[index])
  );
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw workflowError(
      'MAINTAINER_GRANT_TIME_INVALID',
      'Maintainer grant state requires an exact timestamp.',
      ExitCode.guard,
    );
  }
  return date;
}

function isExactTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function canonicalRoot(value: string): string {
  if (!path.isAbsolute(value) || fs.realpathSync(value) !== value) {
    throw unsafeStore();
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (!value || value.trim() !== value) {
    throw workflowError(
      'MAINTAINER_RESERVATION_INVALID',
      `Maintainer ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function unavailableGrant(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_UNAVAILABLE',
    `Maintainer grant ${grantId} is not available for this transition.`,
    ExitCode.conflict,
  );
}

function grantNotFound(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_NOT_FOUND',
    `Maintainer grant ${grantId} does not exist in local state.`,
    ExitCode.guard,
  );
}

function ambiguousGrant(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_STATE_AMBIGUOUS',
    `Maintainer grant ${grantId} has ambiguous or malformed local state.`,
    ExitCode.staleState,
  );
}

function unsafeStore() {
  return workflowError(
    'MAINTAINER_GRANT_STORE_UNSAFE',
    'Maintainer grant storage is malformed or unsafe.',
    ExitCode.staleState,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
