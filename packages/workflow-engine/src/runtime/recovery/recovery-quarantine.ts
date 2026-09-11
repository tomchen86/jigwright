import { prepareRecoveryQuarantineEnvelope } from '../../modules/authority/recovery-quarantine-contract.ts';
import { assertGrantWindow } from '../../modules/authority/recovery-quarantine-contract.ts';
import { assertDependencies } from '../../modules/authority/recovery-quarantine-contract.ts';
/**
 * Enters and releases recovery quarantine with verified grants and durable
 * audit ordering.
 *
 * Invariants:
 * - A different active quarantine marker cannot be replaced by an enter
 *   operation.
 */
import fs from 'node:fs';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import { ExitCode } from '../../foundation/errors/errors.ts';

import {
  createMarker,
  quarantineError,
  createReceipt,
  stateCorrupt,
  createTerminal,
  deepFreeze,
  createReleaseClaim,
  normalizeMarker,
  GRANT_ID,
  grantInvalid,
  normalizeReservation,
  normalizeReceipt,
  normalizeTerminal,
  normalizeAudit,
  normalizeAuditAcknowledgement,
  assertRecordChain,
  alreadyConsumed,
  exactDate,
  createReservation,
  createAuditRecord,
  createAuditAcknowledgement,
} from '../../modules/authority/recovery-quarantine-contract.ts';

import type {
  RecoveryQuarantineEnvelope,
  RecoveryQuarantineDependencies,
  RecoveryQuarantineEnterResult,
  RecoveryQuarantineEnterGrantPayload,
  RecoveryQuarantineReleaseResult,
  RecoveryQuarantineReleaseGrantPayload,
  RecoveryQuarantineMarker,
  RecoveryQuarantineGrantRecord,
  RecoveryQuarantineGrantPayload,
  BegunOperation,
} from '../../modules/authority/recovery-quarantine-contract.ts';

import {
  ensureImmutable,
  unlinkExactMarker,
  quarantinePaths,
  reconcileTemporaries,
  readCanonicalFile,
  grantPaths,
  readOptional,
} from './recovery-quarantine-store.ts';

export function executeRecoveryQuarantineEnter(
  storageRoot: string,
  envelope: RecoveryQuarantineEnvelope,
  dependencies: RecoveryQuarantineDependencies,
): RecoveryQuarantineEnterResult {
  const operation = beginOperation(
    storageRoot,
    envelope,
    dependencies,
    'enter-quarantine',
  );
  const payload = operation.payload as RecoveryQuarantineEnterGrantPayload;
  let record = operation.record;
  const marker = createMarker(payload, operation.reservation.envelopeDigest);

  if (record.terminal === null) {
    const observed = readRecoveryQuarantineMarker(storageRoot);
    if (observed !== null && observed.markerDigest !== marker.markerDigest) {
      throw quarantineError(
        'RECOVERY_QUARANTINE_ALREADY_ACTIVE',
        'A different Recovery Quarantine marker is already active.',
        ExitCode.conflict,
      );
    }
    if (observed === null) {
      ensureImmutable(
        operation.paths.marker,
        marker,
        dependencies,
        'marker-published',
      );
    }
    dependencies.hooks?.afterPhase('marker-durable');
    record = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);

    if (record.receipt === null) {
      const receipt = createReceipt(
        payload,
        marker.markerDigest,
        operation.reservation.reservedAt,
      );
      ensureImmutable(
        operation.paths.receipt,
        receipt,
        dependencies,
        'receipt-published',
      );
    }
    dependencies.hooks?.afterPhase('receipt-durable');
    record = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
    if (record.receipt === null) throw stateCorrupt();

    if (record.terminal === null) {
      const terminal = createTerminal(
        payload,
        operation.reservation.envelopeDigest,
        record.receipt,
      );
      ensureImmutable(
        operation.paths.terminal,
        terminal,
        dependencies,
        'terminal-published',
      );
    }
    dependencies.hooks?.afterPhase('terminal-durable');
  }

  record = finishAudit(operation, dependencies);
  if (record.receipt === null) throw stateCorrupt();
  return deepFreeze({
    marker,
    markerPath: operation.paths.marker,
    receipt: record.receipt,
    record,
  });
}

export function executeRecoveryQuarantineRelease(
  storageRoot: string,
  envelope: RecoveryQuarantineEnvelope,
  dependencies: RecoveryQuarantineDependencies,
): RecoveryQuarantineReleaseResult {
  const operation = beginOperation(
    storageRoot,
    envelope,
    dependencies,
    'release-quarantine',
    true,
  );
  const payload = operation.payload as RecoveryQuarantineReleaseGrantPayload;
  let record = operation.record;
  const claim = createReleaseClaim(
    payload,
    operation.reservation.envelopeDigest,
    operation.reservation.reservedAt,
  );
  ensureImmutable(
    operation.paths.releaseClaim,
    claim,
    dependencies,
    'release-claim-published',
  );
  dependencies.hooks?.afterPhase('release-claim-durable');

  if (record.terminal === null) {
    const marker = requireExactActiveMarker(storageRoot, payload);
    const enterRecord = readRecoveryQuarantineGrantRecord(
      storageRoot,
      marker.enterGrantId,
    );
    if (enterRecord.terminal === null) {
      throw quarantineError(
        'RECOVERY_QUARANTINE_ENTER_NOT_TERMINAL',
        'Recovery Quarantine cannot be released before its enter Grant is consumed.',
        ExitCode.conflict,
      );
    }
    record = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
    if (record.receipt === null) {
      const receipt = createReceipt(
        payload,
        marker.markerDigest,
        operation.reservation.reservedAt,
      );
      ensureImmutable(
        operation.paths.receipt,
        receipt,
        dependencies,
        'receipt-published',
      );
    }
    dependencies.hooks?.afterPhase('receipt-durable');
    record = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
    if (record.receipt === null) throw stateCorrupt();
    if (record.terminal === null) {
      const terminal = createTerminal(
        payload,
        operation.reservation.envelopeDigest,
        record.receipt,
      );
      ensureImmutable(
        operation.paths.terminal,
        terminal,
        dependencies,
        'terminal-published',
      );
    }
    dependencies.hooks?.afterPhase('terminal-durable');
  }

  const active = readRecoveryQuarantineMarker(storageRoot);
  if (active?.markerDigest === payload.activeMarkerDigest) {
    unlinkExactMarker(operation.paths.marker, active);
  }
  dependencies.hooks?.afterPhase('release-durable');
  record = finishAudit(operation, dependencies);
  if (record.receipt === null) throw stateCorrupt();
  return deepFreeze({ receipt: record.receipt, record });
}

export function readRecoveryQuarantineMarker(
  storageRoot: string,
): RecoveryQuarantineMarker | null {
  const paths = quarantinePaths(storageRoot, false);
  if (paths === null) return null;
  reconcileTemporaries(paths.state);
  if (!fs.lstatSync(paths.marker, { throwIfNoEntry: false })) return null;
  return normalizeMarker(readCanonicalFile(paths.marker, [1]));
}

export function readRecoveryQuarantineGrantRecord(
  storageRoot: string,
  grantIdValue: string,
): RecoveryQuarantineGrantRecord {
  if (!GRANT_ID.test(grantIdValue)) throw grantInvalid();
  const paths = grantPaths(storageRoot, grantIdValue, false);
  if (paths === null) throw stateCorrupt();
  reconcileTemporaries(paths.grantDirectory);
  const reservation = normalizeReservation(
    readCanonicalFile(paths.reservation, [1]),
  );
  if (reservation.grantId !== grantIdValue) throw stateCorrupt();
  const receipt = readOptional(paths.receipt, normalizeReceipt);
  const terminal = readOptional(paths.terminal, normalizeTerminal);
  const audit = readOptional(paths.audit, normalizeAudit);
  const auditAcknowledgement = readOptional(
    paths.auditAcknowledgement,
    normalizeAuditAcknowledgement,
  );
  assertRecordChain(
    reservation,
    receipt,
    terminal,
    audit,
    auditAcknowledgement,
  );
  return deepFreeze({
    state:
      auditAcknowledgement !== null
        ? 'audited'
        : terminal !== null
          ? 'consumed'
          : receipt !== null
            ? 'receipt-durable'
            : 'reserved',
    reservation,
    receipt,
    terminal,
    audit,
    auditAcknowledgement,
  });
}

function beginOperation(
  storageRoot: string,
  rawEnvelope: RecoveryQuarantineEnvelope,
  dependencies: RecoveryQuarantineDependencies,
  expectedOperation: RecoveryQuarantineGrantPayload['operation'],
  validateReleaseMarkerBeforeReservation = false,
): BegunOperation {
  assertDependencies(dependencies);
  const payload = verifyEnvelope(rawEnvelope, dependencies, expectedOperation);
  const exactEnvelope = deepFreeze({
    payload,
    signature: rawEnvelope.signature,
  });
  const observedPaths = grantPaths(storageRoot, payload, false);
  if (observedPaths !== null) {
    reconcileTemporaries(observedPaths.grantDirectory);
  }
  const reservationExists =
    observedPaths === null
      ? undefined
      : fs.lstatSync(observedPaths.reservation, { throwIfNoEntry: false });
  let existing: RecoveryQuarantineGrantRecord | null = null;
  if (reservationExists) {
    existing = readRecoveryQuarantineGrantRecord(storageRoot, payload.grantId);
    if (
      canonicalJson(existing.reservation.envelope) !==
      canonicalJson(exactEnvelope)
    ) {
      throw stateCorrupt();
    }
    if (existing.auditAcknowledgement !== null) throw alreadyConsumed();
  } else {
    assertGrantWindow(payload, dependencies.now);
    if (validateReleaseMarkerBeforeReservation) {
      requireExactActiveMarker(
        storageRoot,
        payload as RecoveryQuarantineReleaseGrantPayload,
      );
    }
  }

  const paths = grantPaths(storageRoot, payload, true);
  if (paths === null) throw stateCorrupt();
  reconcileTemporaries(paths.grantDirectory);

  const now = exactDate(dependencies.now);
  const reservation =
    existing?.reservation ??
    createReservation(exactEnvelope, now.toISOString());
  if (existing === null) {
    ensureImmutable(
      paths.reservation,
      reservation,
      dependencies,
      'reservation-published',
    );
  }
  dependencies.hooks?.afterPhase('reservation-durable');
  const record = readRecoveryQuarantineGrantRecord(
    storageRoot,
    payload.grantId,
  );
  if (record.auditAcknowledgement !== null) throw alreadyConsumed();
  return {
    storageRoot,
    payload,
    reservation: record.reservation,
    record,
    paths,
  };
}

function verifyEnvelope(
  envelope: unknown,
  dependencies: RecoveryQuarantineDependencies,
  expectedOperation: RecoveryQuarantineGrantPayload['operation'],
): RecoveryQuarantineGrantPayload {
  const { payload, namespace } = prepareRecoveryQuarantineEnvelope(
    envelope,
    dependencies,
    expectedOperation,
  );
  let verified = false;
  try {
    verified = dependencies.verifyHumanSignature(
      canonicalJson(payload),
      (envelope as RecoveryQuarantineEnvelope).signature,
      payload.humanSigner,
      namespace,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw quarantineError(
      'RECOVERY_QUARANTINE_SIGNATURE_INVALID',
      'Recovery Quarantine Grant signature is invalid for its exact operation domain.',
      ExitCode.verification,
    );
  }
  return deepFreeze(payload);
}

function finishAudit(
  operation: BegunOperation,
  dependencies: RecoveryQuarantineDependencies,
): RecoveryQuarantineGrantRecord {
  let record = readRecoveryQuarantineGrantRecord(
    operation.storageRoot,
    operation.payload.grantId,
  );
  if (record.receipt === null || record.terminal === null) throw stateCorrupt();
  if (record.auditAcknowledgement !== null) return record;
  const audit =
    record.audit ??
    createAuditRecord(
      operation.payload,
      operation.reservation.envelopeDigest,
      record.receipt,
      record.terminal,
    );
  if (record.audit === null) {
    ensureImmutable(
      operation.paths.audit,
      audit,
      dependencies,
      'audit-published',
    );
  }
  dependencies.appendAudit(audit);
  dependencies.hooks?.afterPhase('audit-appended');
  const acknowledgement = createAuditAcknowledgement(audit, audit.recordedAt);
  ensureImmutable(
    operation.paths.auditAcknowledgement,
    acknowledgement,
    dependencies,
    'audit-ack-published',
  );
  record = readRecoveryQuarantineGrantRecord(
    operation.storageRoot,
    operation.payload.grantId,
  );
  if (record.auditAcknowledgement === null) throw stateCorrupt();
  return record;
}

function requireExactActiveMarker(
  storageRoot: string,
  payload: RecoveryQuarantineReleaseGrantPayload,
): RecoveryQuarantineMarker {
  const marker = readRecoveryQuarantineMarker(storageRoot);
  if (marker === null || marker.markerDigest !== payload.activeMarkerDigest) {
    throw quarantineError(
      'RECOVERY_QUARANTINE_MARKER_MISMATCH',
      'Release Grant does not bind the exact active Recovery Quarantine marker.',
      ExitCode.staleState,
    );
  }
  return marker;
}
