/**
 * Reads collaboration state records and projects inspections across active and terminal copies.
 *
 * Invariants:
 * - Records retain exact grant, envelope, transition, and revocation-authorization bindings.
 * - Residual cleanup removes only copies matching the already durable terminal record.
 */
import { withRepositoryLifecycleOperation } from '../session-workspace/repository-lifecycle-lock.ts';
import type {
  CollaborationGrantInspection,
  CollaborationTerminalRecord,
  CollaborationReservationRecord,
  CollaborationGrantUseProjection,
} from './collaboration-grant-store-types.ts';
import {
  collaborationGrantStorePaths,
  assertExistingStoreReadOnlySafe,
  existingStateDirectories,
  listGrantIds,
  statePath,
  assertNonterminalUnambiguous,
  readPrivateFile,
  fsyncDirectory,
} from './collaboration-grant-private-files.ts';
import {
  assertCollaborationGrantId,
  type CollaborationGrantEnvelope,
  collaborationGrantSignatureNamespace,
  collaborationGrantEnvelopeDigest,
  parseCollaborationGrantEnvelope,
  canonicalCollaborationGrantEnvelope,
} from '../../modules/authority/collaboration-grant-codec.ts';
import {
  grantNotFound,
  deepFreeze,
  ambiguousGrant,
  parseRecord,
  hasExactKeys,
  DIGEST,
  isExactTimestamp,
} from './collaboration-grant-store-values.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  type HumanRevocationAuthorization,
  assertHumanRevocationAuthorization,
} from '../../modules/authority/human-revocation-contract.ts';
import { assertStoredUse } from './collaboration-grant-use-contract.ts';

export function inspectCollaborationGrants(
  gitCommonDirectory: string,
  requestedGrantId?: string,
): CollaborationGrantInspection[] {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    inspectCollaborationGrantsUnderLifecycleLock(
      gitCommonDirectory,
      requestedGrantId,
      assertOwned,
    ),
  );
}

/**
 * Read one durable grant state without acquiring a lifecycle lock or creating,
 * chmodding, repairing, or otherwise changing the collaboration store. This is
 * the status/replay surface; transition callers use the locked APIs above.
 */
export function readCollaborationGrantInspection(
  gitCommonDirectory: string,
  requestedGrantId: string,
): CollaborationGrantInspection | null {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  if (!assertExistingStoreReadOnlySafe(paths)) return null;
  return (
    inspectOne(paths, assertCollaborationGrantId(requestedGrantId)) ?? null
  );
}

/**
 * List every durable grant state through the same strict, mutation-free reader
 * used by status replay. This deliberately does not acquire the repository
 * lifecycle lock or create/repair any store directory.
 */
export function listCollaborationGrantInspections(
  gitCommonDirectory: string,
): readonly CollaborationGrantInspection[] {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  if (!assertExistingStoreReadOnlySafe(paths)) return Object.freeze([]);
  const grantIds = [
    ...new Set(
      existingStateDirectories(paths).flatMap(({ directory }) =>
        listGrantIds(directory),
      ),
    ),
  ].sort();
  return Object.freeze(
    grantIds.flatMap((grantId) => {
      const inspection = inspectOne(paths, grantId);
      return inspection === undefined ? [] : [inspection];
    }),
  );
}

export function inspectCollaborationGrantsUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string | undefined,
  assertOwned: () => void,
): CollaborationGrantInspection[] {
  assertOwned();
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  if (!assertExistingStoreReadOnlySafe(paths)) {
    if (requestedGrantId !== undefined) throw grantNotFound(requestedGrantId);
    return [];
  }
  assertOwned();
  const grantId = requestedGrantId
    ? assertCollaborationGrantId(requestedGrantId)
    : undefined;
  const directories = existingStateDirectories(paths);
  const grantIds = grantId
    ? [grantId]
    : [
        ...new Set(
          directories.flatMap(({ directory }) => listGrantIds(directory)),
        ),
      ].sort();
  const inspected = grantIds.map((id) => inspectOne(paths, id));
  if (grantId && inspected[0] === undefined) {
    throw grantNotFound(grantId);
  }
  const results = inspected.filter(
    (entry): entry is CollaborationGrantInspection => entry !== undefined,
  );
  assertOwned();
  return results;
}

function inspectOne(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
): CollaborationGrantInspection | undefined {
  const availablePath = statePath(paths.available, grantId);
  const reservedPath = statePath(paths.reserved, grantId);
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    assertResidualCopiesMatch(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    return inspectTerminal(terminal);
  }
  assertNonterminalUnambiguous(paths, grantId);
  if (fs.existsSync(availablePath)) {
    return inspectEnvelope(readAvailable(availablePath, grantId), 'available');
  }
  if (fs.existsSync(reservedPath)) {
    const reservation = readReservation(reservedPath, grantId);
    return {
      ...inspectEnvelope(reservation.envelope, 'reserved'),
      transitionDigest: reservation.transitionDigest,
    };
  }
  return undefined;
}

function inspectEnvelope(
  envelope: CollaborationGrantEnvelope,
  state: 'available' | 'reserved',
): CollaborationGrantInspection {
  return deepFreeze({
    grantId: envelope.payload.grantId,
    version: envelope.payload.version,
    signatureNamespace: collaborationGrantSignatureNamespace(envelope.payload),
    authorizedEffect: envelope.payload.authorizedEffect,
    state,
    changeId: envelope.payload.changeId,
    taskId: envelope.payload.taskId,
    lifecyclePhase: envelope.payload.lifecyclePhase,
    targetDigest: envelope.payload.targetDigest,
    degradedForm: envelope.payload.degradedForm,
    issuedAt: envelope.payload.issuedAt,
    expiresAt: envelope.payload.expiresAt,
    signer: envelope.payload.signer,
    signedEnvelopeDigest: collaborationGrantEnvelopeDigest(envelope),
  });
}

export function inspectTerminal(
  terminal: CollaborationTerminalRecord,
): CollaborationGrantInspection {
  return deepFreeze({
    ...inspectEnvelope(terminal.envelope, 'available'),
    state: terminal.state,
    ...(terminal.transitionDigest
      ? { transitionDigest: terminal.transitionDigest }
      : {}),
    terminalReason: terminal.reason,
    ...(terminal.use ? { use: terminal.use } : {}),
  });
}

export function readAvailable(
  filePath: string,
  grantId: string,
): CollaborationGrantEnvelope {
  const envelope = parseCollaborationGrantEnvelope(readPrivateFile(filePath));
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  return envelope;
}

export function readReservation(
  filePath: string,
  grantId: string,
): CollaborationReservationRecord {
  const value = parseRecord(readPrivateFile(filePath));
  const envelope = parseCollaborationGrantEnvelope(
    `${JSON.stringify(value.envelope)}\n`,
  );
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'grantId',
      'transitionDigest',
      'repositoryRoot',
      'reservedAt',
      'envelope',
    ]) ||
    value.schemaVersion !== 1 ||
    value.state !== 'reserved' ||
    value.grantId !== grantId ||
    typeof value.transitionDigest !== 'string' ||
    !DIGEST.test(value.transitionDigest) ||
    typeof value.reservedAt !== 'string' ||
    !isExactTimestamp(value.reservedAt) ||
    Date.parse(value.reservedAt) < Date.parse(envelope.payload.issuedAt) ||
    Date.parse(value.reservedAt) > Date.parse(envelope.payload.expiresAt) ||
    typeof value.repositoryRoot !== 'string' ||
    !path.isAbsolute(value.repositoryRoot)
  ) {
    throw ambiguousGrant(grantId);
  }
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  return deepFreeze({
    ...value,
    envelope,
  } as CollaborationReservationRecord);
}

export function readReservationOrInterrupted(
  filePath: string,
  grantId: string,
): {
  envelope: CollaborationGrantEnvelope;
  transitionDigest?: string;
} {
  try {
    return readReservation(filePath, grantId);
  } catch {
    try {
      return { envelope: readAvailable(filePath, grantId) };
    } catch {
      throw ambiguousGrant(grantId);
    }
  }
}

export function readTerminal(
  filePath: string,
  grantId: string,
): CollaborationTerminalRecord {
  const value = parseRecord(readPrivateFile(filePath));
  const requiresAuthorization = value.state === 'revoked';
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'grantId',
      'transitionDigest',
      'reason',
      'recordedAt',
      'envelope',
      'use',
      ...(requiresAuthorization ? ['revocationAuthorization'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    !['revoked', 'consumed', 'failed', 'expired'].includes(
      String(value.state),
    ) ||
    value.grantId !== grantId ||
    (value.transitionDigest !== null &&
      (typeof value.transitionDigest !== 'string' ||
        !DIGEST.test(value.transitionDigest))) ||
    typeof value.reason !== 'string' ||
    value.reason.trim().length === 0 ||
    typeof value.recordedAt !== 'string' ||
    !isExactTimestamp(value.recordedAt)
  ) {
    throw ambiguousGrant(grantId);
  }
  const envelope = parseCollaborationGrantEnvelope(
    `${JSON.stringify(value.envelope)}\n`,
  );
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  let use: CollaborationGrantUseProjection | null = null;
  if (value.state === 'consumed') {
    use = assertStoredUse(value.use, envelope);
    if (
      value.transitionDigest === null ||
      value.transitionDigest !== use.transitionDigest
    ) {
      throw ambiguousGrant(grantId);
    }
  } else {
    if (
      value.use !== null ||
      (value.state !== 'revoked' && value.transitionDigest === null)
    ) {
      throw ambiguousGrant(grantId);
    }
  }
  let revocationAuthorization: HumanRevocationAuthorization | undefined;
  if (requiresAuthorization) {
    revocationAuthorization = assertHumanRevocationAuthorization(
      value.revocationAuthorization,
    );
    if (
      value.state !== 'revoked' ||
      revocationAuthorization.payload.subjectKind !== 'collaboration-grant' ||
      revocationAuthorization.payload.grantId !== grantId ||
      revocationAuthorization.payload.reason !== value.reason ||
      revocationAuthorization.payload.revokedAt !== value.recordedAt
    ) {
      throw ambiguousGrant(grantId);
    }
  }
  return deepFreeze({
    ...value,
    envelope,
    use,
    ...(requiresAuthorization ? { revocationAuthorization } : {}),
  } as CollaborationTerminalRecord);
}

export function cleanupNonterminal(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
  expected: CollaborationGrantEnvelope,
  expectedTransitionDigest: string | null,
): void {
  for (const directory of [paths.available, paths.reserved]) {
    const target = statePath(directory, grantId);
    if (!fs.existsSync(target)) {
      continue;
    }
    const residual =
      directory === paths.available
        ? { envelope: readAvailable(target, grantId) }
        : readReservationOrInterrupted(target, grantId);
    const observed = residual.envelope;
    if (
      canonicalCollaborationGrantEnvelope(observed) !==
        canonicalCollaborationGrantEnvelope(expected) ||
      (directory === paths.reserved &&
        (residual.transitionDigest === undefined
          ? expectedTransitionDigest !== null
          : residual.transitionDigest !== expectedTransitionDigest))
    ) {
      throw ambiguousGrant(grantId);
    }
    fs.unlinkSync(target);
    fsyncDirectory(directory);
  }
}

export function assertResidualCopiesMatch(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
  expected: CollaborationGrantEnvelope,
  expectedTransitionDigest: string | null,
): void {
  for (const directory of [paths.available, paths.reserved]) {
    const target = statePath(directory, grantId);
    if (!fs.existsSync(target)) {
      continue;
    }
    const residual =
      directory === paths.available
        ? { envelope: readAvailable(target, grantId) }
        : readReservationOrInterrupted(target, grantId);
    const observed = residual.envelope;
    if (
      canonicalCollaborationGrantEnvelope(observed) !==
        canonicalCollaborationGrantEnvelope(expected) ||
      (directory === paths.reserved &&
        (residual.transitionDigest === undefined
          ? expectedTransitionDigest !== null
          : residual.transitionDigest !== expectedTransitionDigest))
    ) {
      throw ambiguousGrant(grantId);
    }
  }
}
