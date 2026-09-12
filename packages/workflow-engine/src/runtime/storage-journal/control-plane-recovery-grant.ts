/** Durable recovery operations apply pure decisions through the private atomic
 * record protocol. Idempotent transitions return without another publication. */
import fs from 'node:fs';
import path from 'node:path';
import {
  exactIso,
  assertIdentifier,
  deepFreeze,
  recoveryRecordCorrupt,
} from '../../modules/authority/control-plane-recovery-grant-values.ts';
import type {
  ControlPlaneRecoveryGrantEnvelope,
  PersistedControlPlaneRecoveryGrant,
  ControlPlaneRecoveryConsumptionInput,
  ControlPlaneRecoveryPreparationInput,
  ControlPlaneRecoveryFailureInput,
  ControlPlaneRecoveryExpiryInput,
  ControlPlaneRecoveryGrantPersistence,
} from '../../modules/authority/control-plane-recovery-grant-values.ts';
import { normalizePayload } from '../../modules/authority/control-plane-recovery-grant-records.ts';
import {
  createControlPlaneRecoveryReservation,
  acceptControlPlaneRecoveryReservation,
  consumeControlPlaneRecoveryGrant,
  prepareControlPlaneRecoveryGrantConsumption,
  failControlPlaneRecoveryGrant,
  expireControlPlaneRecoveryGrant,
  validatePersistedControlPlaneRecoveryGrant,
  selectControlPlaneRecoveryGrantForSource,
} from '../../modules/authority/control-plane-recovery-grant.ts';
import {
  recoveryRecordsDirectory,
  recoveryRecordPath,
  recoveryGrantIdFromRecordPath,
  assertPrivateDirectory,
  readCanonicalRecord,
  replaceAtomic,
  reconcileRecoveryRecordTemporaries,
  serializeRecord,
  RECOVERY_RECORD_NAME,
  RECOVERY_RECORD_TEMPORARY,
} from './control-plane-recovery-grant-storage.ts';

export function reservePersistedControlPlaneRecoveryGrant(
  storageRoot: string,
  envelope: ControlPlaneRecoveryGrantEnvelope,
  at: string,
): PersistedControlPlaneRecoveryGrant {
  const payload = normalizePayload(envelope.payload);
  exactIso(at, 'HARNESS_RECOVERY_RECORD_INVALID');
  const target = recoveryRecordPath(storageRoot, payload.grantId, true);
  const record = createControlPlaneRecoveryReservation(envelope, payload);
  const bytes = serializeRecord(record);
  reconcileRecoveryRecordTemporaries(path.dirname(target), {
    targetName: path.basename(target),
    expectedOldRecordDigest: null,
    nextRecordDigest: record.recordDigest,
    bytes,
  });
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    const existing = readPersistedControlPlaneRecoveryGrant(
      storageRoot,
      payload.grantId,
    );
    return acceptControlPlaneRecoveryReservation(existing, envelope);
  }
  replaceAtomic(target, bytes, null, record.recordDigest);
  return deepFreeze(record);
}

export function consumePersistedControlPlaneRecoveryGrant(
  storageRoot: string,
  input: ControlPlaneRecoveryConsumptionInput,
): PersistedControlPlaneRecoveryGrant {
  const current = readPersistedControlPlaneRecoveryGrant(
    storageRoot,
    input.recoveryGrantId,
  );
  const next = consumeControlPlaneRecoveryGrant(current, input);
  replaceAtomic(
    recoveryRecordPath(storageRoot, input.recoveryGrantId, false),
    serializeRecord(next),
    current.recordDigest,
    next.recordDigest,
  );
  return next;
}

export function preparePersistedControlPlaneRecoveryGrantConsumption(
  storageRoot: string,
  input: ControlPlaneRecoveryPreparationInput,
): PersistedControlPlaneRecoveryGrant {
  const current = readPersistedControlPlaneRecoveryGrant(
    storageRoot,
    input.recoveryGrantId,
  );
  const next = prepareControlPlaneRecoveryGrantConsumption(current, input);
  if (next === current) return current;
  replaceAtomic(
    recoveryRecordPath(storageRoot, input.recoveryGrantId, false),
    serializeRecord(next),
    current.recordDigest,
    next.recordDigest,
  );
  return next;
}

export function failPersistedControlPlaneRecoveryGrant(
  storageRoot: string,
  input: ControlPlaneRecoveryFailureInput,
): PersistedControlPlaneRecoveryGrant {
  const current = readPersistedControlPlaneRecoveryGrant(
    storageRoot,
    input.recoveryGrantId,
  );
  const next = failControlPlaneRecoveryGrant(current, input);
  if (next === current) return current;
  replaceAtomic(
    recoveryRecordPath(storageRoot, input.recoveryGrantId, false),
    serializeRecord(next),
    current.recordDigest,
    next.recordDigest,
  );
  return next;
}

export function expirePersistedControlPlaneRecoveryGrant(
  storageRoot: string,
  input: ControlPlaneRecoveryExpiryInput,
): PersistedControlPlaneRecoveryGrant {
  const current = readPersistedControlPlaneRecoveryGrant(
    storageRoot,
    input.recoveryGrantId,
  );
  const next = expireControlPlaneRecoveryGrant(current, input);
  if (next === current) return current;
  replaceAtomic(
    recoveryRecordPath(storageRoot, input.recoveryGrantId, false),
    serializeRecord(next),
    current.recordDigest,
    next.recordDigest,
  );
  return next;
}

export function readPersistedControlPlaneRecoveryGrant(
  storageRoot: string,
  recoveryGrantId: string,
): PersistedControlPlaneRecoveryGrant {
  const value = readCanonicalRecord(
    recoveryRecordPath(storageRoot, recoveryGrantId, false),
  );
  return validatePersistedControlPlaneRecoveryGrant(value, recoveryGrantId);
}

export function findPersistedControlPlaneRecoveryGrantForSource(
  storageRoot: string,
  sourceControlPlaneGrantId: string,
): PersistedControlPlaneRecoveryGrant | null {
  assertIdentifier(sourceControlPlaneGrantId, 'HARNESS_RECOVERY_GRANT_INVALID');
  const directory = recoveryRecordsDirectory(storageRoot, false);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) return null;
  assertPrivateDirectory(directory);
  reconcileRecoveryRecordTemporaries(directory);
  const entries = fs.readdirSync(directory).sort();
  if (
    entries.some(
      (entry) =>
        !RECOVERY_RECORD_NAME.test(entry) &&
        !RECOVERY_RECORD_TEMPORARY.test(entry),
    )
  ) {
    throw recoveryRecordCorrupt();
  }
  const records = entries
    .filter((entry) => RECOVERY_RECORD_NAME.test(entry))
    .map((entry) =>
      readPersistedControlPlaneRecoveryGrant(
        storageRoot,
        recoveryGrantIdFromRecordPath(directory, entry),
      ),
    );
  return selectControlPlaneRecoveryGrantForSource(
    records,
    sourceControlPlaneGrantId,
  );
}

export const controlPlaneRecoveryGrantPersistence: ControlPlaneRecoveryGrantPersistence =
  {
    findForSource: findPersistedControlPlaneRecoveryGrantForSource,
    reserve: reservePersistedControlPlaneRecoveryGrant,
    consume: consumePersistedControlPlaneRecoveryGrant,
    prepareConsumption: preparePersistedControlPlaneRecoveryGrantConsumption,
    fail: failPersistedControlPlaneRecoveryGrant,
    expire: expirePersistedControlPlaneRecoveryGrant,
  };
