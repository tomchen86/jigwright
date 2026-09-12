/** Pure persisted recovery record validation and one-use state transitions.
 * Accepted replay returns the same record before any later CAS/input checks. */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode } from "../../foundation/errors/errors.js";
import { verifyRecordDigest, hasExactKeys, exactIso, isNonEmpty, isDigest, canonicalDigest, isRecord, deepFreeze, recoveryAlreadyConsumed, recoveryAlreadyFailed, recoveryRecordCorrupt, recoveryError, } from "./control-plane-recovery-grant-values.js";
import { controlPlaneRecoveryPrestateDigest, normalizePayload, normalizeReceipt, normalizeFailure, } from "./control-plane-recovery-grant-records.js";
export function createControlPlaneRecoveryReservation(envelope, payload) {
    const createdAt = payload.issuedAt;
    const envelopeDigest = canonicalDigest(envelope);
    const recordPayload = {
        kind: 'persisted-control-plane-recovery-grant.v1',
        state: 'reserved',
        envelope: structuredClone(envelope),
        envelopeDigest,
        prestateDigest: controlPlaneRecoveryPrestateDigest(payload),
        receipt: null,
        failure: null,
        createdAt,
        updatedAt: createdAt,
    };
    const record = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    return deepFreeze(record);
}
export function acceptControlPlaneRecoveryReservation(existing, envelope) {
    if (canonicalJson(existing.envelope) !== canonicalJson(envelope)) {
        throw recoveryRecordCorrupt();
    }
    if (existing.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (existing.state === 'failed')
        throw recoveryAlreadyFailed();
    if (existing.state === 'expired') {
        throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Recovery Grant is an expired one-shot tombstone.', ExitCode.staleState);
    }
    return existing;
}
export function consumeControlPlaneRecoveryGrant(current, input) {
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'failed')
        throw recoveryAlreadyFailed();
    if (current.state === 'expired') {
        throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Expired Recovery Grant cannot be consumed.', ExitCode.staleState);
    }
    if (current.state !== 'completion-pending' || current.receipt === null) {
        throw recoveryError('HARNESS_RECOVERY_CONSUMPTION_NOT_PREPARED', 'Recovery Grant consumption requires a durable completion receipt before terminalization.', ExitCode.conflict);
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before consumption.', ExitCode.staleState);
    }
    const receipt = current.receipt;
    const recordPayload = {
        kind: current.kind,
        state: 'consumed',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt,
        failure: null,
        createdAt: current.createdAt,
        updatedAt: receipt.completedAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    return deepFreeze(next);
}
export function prepareControlPlaneRecoveryGrantConsumption(current, input) {
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'failed')
        throw recoveryAlreadyFailed();
    if (current.state === 'expired') {
        throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Expired Recovery Grant cannot prepare consumption.', ExitCode.staleState);
    }
    const receipt = normalizeReceipt(input.receipt);
    if (receipt.recoveryGrantId !== current.envelope.payload.grantId ||
        receipt.prestateDigest !== current.prestateDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Recovery receipt does not consume the exact reserved prestate.');
    }
    if (current.state === 'completion-pending') {
        if (canonicalJson(current.receipt) !== canonicalJson(receipt)) {
            throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Prepared Recovery Grant completion differs from the exact durable receipt.');
        }
        return current;
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before completion preparation.', ExitCode.staleState);
    }
    const recordPayload = {
        kind: current.kind,
        state: 'completion-pending',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt,
        failure: null,
        createdAt: current.createdAt,
        updatedAt: receipt.completedAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    return deepFreeze(next);
}
export function failControlPlaneRecoveryGrant(current, input) {
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'failed')
        return current;
    if (current.state !== 'reserved') {
        throw recoveryError('HARNESS_RECOVERY_FAILURE_STATE_INVALID', 'Only a reserved Recovery Grant can terminalize after restart verification failure.', ExitCode.conflict);
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before failure terminalization.', ExitCode.staleState);
    }
    const failure = normalizeFailure(input.failure);
    if (failure.recoveryGrantId !== current.envelope.payload.grantId ||
        failure.sourceControlPlaneGrantId !==
            current.envelope.payload.sourceControlPlaneGrantId) {
        throw recoveryError('HARNESS_RECOVERY_FAILURE_INVALID', 'Recovery failure does not bind the exact reserved Grant.');
    }
    const recordPayload = {
        kind: current.kind,
        state: 'failed',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt: null,
        failure,
        createdAt: current.createdAt,
        updatedAt: failure.failedAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    return deepFreeze(next);
}
export function expireControlPlaneRecoveryGrant(current, input) {
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'expired')
        return current;
    if (current.state !== 'reserved') {
        throw recoveryError('HARNESS_RECOVERY_COMPLETION_OBLIGATORY', 'A Recovery Grant with a durable completion receipt cannot expire before terminal audit completion.', ExitCode.conflict);
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before expiry terminalization.', ExitCode.staleState);
    }
    const expiredAt = exactIso(input.expiredAt, 'HARNESS_RECOVERY_RECORD_INVALID');
    if (Date.parse(expiredAt) < Date.parse(current.envelope.payload.expiresAt)) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_NOT_EXPIRED', 'Recovery Grant cannot terminalize before its activation window ends.', ExitCode.conflict);
    }
    const recordPayload = {
        kind: current.kind,
        state: 'expired',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt: null,
        failure: null,
        createdAt: current.createdAt,
        updatedAt: expiredAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    return deepFreeze(next);
}
export function validatePersistedControlPlaneRecoveryGrant(value, recoveryGrantId) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'createdAt',
            'envelope',
            'envelopeDigest',
            'failure',
            'kind',
            'prestateDigest',
            'receipt',
            'recordDigest',
            'state',
            'updatedAt',
        ]) ||
        value.kind !== 'persisted-control-plane-recovery-grant.v1' ||
        !verifyRecordDigest(value) ||
        !isRecord(value.envelope) ||
        !hasExactKeys(value.envelope, ['payload', 'signature']) ||
        !isRecord(value.envelope.payload) ||
        !isNonEmpty(value.envelope.signature) ||
        !isDigest(value.envelopeDigest) ||
        canonicalDigest(value.envelope) !== value.envelopeDigest ||
        !isDigest(value.prestateDigest) ||
        ![
            'reserved',
            'completion-pending',
            'consumed',
            'expired',
            'failed',
        ].includes(String(value.state))) {
        throw recoveryRecordCorrupt();
    }
    const payload = normalizePayload(value.envelope.payload);
    if (payload.grantId !== recoveryGrantId ||
        value.prestateDigest !== controlPlaneRecoveryPrestateDigest(payload)) {
        throw recoveryRecordCorrupt();
    }
    const createdAt = exactIso(value.createdAt, 'HARNESS_RECOVERY_RECORD_CORRUPT');
    const updatedAt = exactIso(value.updatedAt, 'HARNESS_RECOVERY_RECORD_CORRUPT');
    if (Date.parse(updatedAt) < Date.parse(createdAt))
        throw recoveryRecordCorrupt();
    const receipt = value.receipt === null ? null : normalizeReceipt(value.receipt);
    const failure = value.failure === null ? null : normalizeFailure(value.failure);
    if (((value.state === 'reserved' || value.state === 'expired') &&
        (receipt !== null || failure !== null)) ||
        ((value.state === 'completion-pending' || value.state === 'consumed') &&
            (receipt === null || failure !== null)) ||
        (value.state === 'failed' && (receipt !== null || failure === null)) ||
        (receipt !== null &&
            (receipt.recoveryGrantId !== payload.grantId ||
                receipt.sourceControlPlaneGrantId !==
                    payload.sourceControlPlaneGrantId ||
                receipt.repositoryId !== payload.repositoryId ||
                receipt.operation !== payload.operation ||
                receipt.previousClosureDigest !== payload.previousClosureDigest ||
                receipt.currentClosureDigest !== payload.currentClosureDigest ||
                receipt.controlPlaneJournalDigestBefore !==
                    payload.controlPlaneJournalDigest ||
                receipt.supervisorStateDigestBefore !== payload.supervisorStateDigest ||
                receipt.prestateDigest !== value.prestateDigest)) ||
        (failure !== null &&
            (failure.recoveryGrantId !== payload.grantId ||
                failure.sourceControlPlaneGrantId !==
                    payload.sourceControlPlaneGrantId ||
                failure.selectedClosureDigest !== payload.previousClosureDigest ||
                Date.parse(failure.failedAt) < Date.parse(createdAt)))) {
        throw recoveryRecordCorrupt();
    }
    return deepFreeze(structuredClone(value));
}
export function selectControlPlaneRecoveryGrantForSource(records, sourceControlPlaneGrantId) {
    const matches = records.filter((record) => record.envelope.payload.sourceControlPlaneGrantId ===
        sourceControlPlaneGrantId);
    const active = matches.filter(({ state }) => state !== 'expired' && state !== 'failed');
    if (active.length > 1)
        throw recoveryRecordCorrupt();
    if (active.length === 1)
        return active[0];
    return (matches.sort((left, right) => left.updatedAt < right.updatedAt
        ? 1
        : left.updatedAt > right.updatedAt
            ? -1
            : left.envelope.payload.grantId < right.envelope.payload.grantId
                ? 1
                : left.envelope.payload.grantId > right.envelope.payload.grantId
                    ? -1
                    : 0)[0] ?? null);
}
export function throwControlPlaneRecoveryAlreadyConsumed() {
    throw recoveryAlreadyConsumed();
}
export function throwControlPlaneRecoveryFailed() {
    throw recoveryAlreadyFailed();
}
