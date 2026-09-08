/**
 * Parses and inspects available, reserved, and terminal maintainer grant records.
 *
 * Invariants:
 * - Embedded envelope bytes, timestamps, and exact state shapes keep current validation rules.
 * - Interrupted reservations remain distinguishable from canonical reserved records.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type MaintainerGrantV2Envelope,
  parseMaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2-codec.ts';
import {
  grantPath,
  maintainerGrantStorePaths,
  readPrivateFile,
} from './maintainer-grant-files.ts';
import {
  ambiguousGrant,
  isExactTimestamp,
  unsafeStore,
} from './maintainer-grant-values.ts';

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

export type ReservationRequest = {
  sessionId: string;
  repositoryRoot: string;
  now?: Date;
};

export function inspectOne(
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

export function inspectTerminal(
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

export function readAvailableGrant(
  filePath: string,
  grantId: string,
): MaintainerGrantV2Envelope {
  const envelope = parseMaintainerGrantV2Envelope(readPrivateFile(filePath));
  if (envelope.payload.grantId !== grantId) {
    throw ambiguousGrant(grantId);
  }
  return envelope;
}

export function readReservation(
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

export function readReservationOrInterrupted(
  filePath: string,
  grantId: string,
): { envelope: MaintainerGrantV2Envelope; sessionId?: string } {
  try {
    return readReservation(filePath, grantId);
  } catch {
    return { envelope: readAvailableGrant(filePath, grantId) };
  }
}

export function readTerminal(
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

export function serializeRecord(value: unknown): string {
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
