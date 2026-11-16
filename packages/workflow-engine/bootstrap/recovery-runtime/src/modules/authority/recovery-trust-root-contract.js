/**
 * Encodes trust-root restoration records and checks replacement
 * generations, grant windows and pointer state.
 *
 * Invariants:
 * - A restore grant's replacementGeneration must be exactly
 *   expectedGeneration + 1.
 * - assertPointerCas admits the restore only when the active pointer's
 *   generation and digest equal the grant's expectedGeneration and
 *   expectedActivePointerDigest (generation 0 / null when no pointer is
 *   active).
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode } from "../../foundation/errors/errors.js";
import { normalizeRoot } from "./recovery-operational-trust-root.js";
import { digestHex, canonicalDigest, isRecord, hasExactKeys, ENVELOPE_KEYS, grantInvalid, deepFreeze, GRANT_KEYS, GRANT_ID, UNSIGNED_GRANT_KEYS, isIdentifier, isDigest, isPositiveInteger, isExactAbsolutePath, FINGERPRINT, isNonNegativeInteger, exactIso, RECOVERY_TRUST_ROOT_RESTORE_TTL_MS, POINTER_KEYS, stateCorrupt, RESERVATION_KEYS, RECEIPT_KEYS, TERMINAL_KEYS, AUDIT_KEYS, AUDIT_ACK_KEYS, restoreError, exactDate, } from "./recovery-trust-root-values.js";
export function recoveryOperationalTrustRootRestoreGrantId(value) {
    return `trust-root-restore-${digestHex(canonicalJson(normalizeUnsignedGrant(value)))}`;
}
export function canonicalRecoveryOperationalTrustRootRestoreStatement(payloadValue, replacementValue) {
    const payload = normalizeGrant(payloadValue);
    const replacement = normalizeRoot(replacementValue);
    assertReplacementBinding(payload, replacement);
    return canonicalJson({
        kind: 'recovery-operational-trust-root-restore-statement.v1',
        payload,
        replacement,
    });
}
export function createReservation(envelope, envelopeDigest) {
    const payload = {
        kind: 'recovery-operational-trust-root-restore-reservation.v1',
        grantId: envelope.payload.grantId,
        envelope,
        envelopeDigest,
        reservedAt: envelope.payload.issuedAt,
    };
    return normalizeReservation({
        ...payload,
        reservationDigest: canonicalDigest(payload),
    });
}
export function createPointer(payload, envelopeDigest, reservation) {
    const value = {
        kind: 'recovery-operational-trust-root-pointer.v1',
        repositoryId: payload.repositoryId,
        authorityDescriptorDigest: payload.authorityDescriptorDigest,
        authorityGeneration: payload.authorityGeneration,
        generation: payload.replacementGeneration,
        rootDigest: payload.replacementRootDigest,
        previousPointerDigest: payload.expectedActivePointerDigest,
        grantId: payload.grantId,
        envelopeDigest,
        activatedAt: reservation.reservedAt,
    };
    return normalizePointer({ ...value, pointerDigest: canonicalDigest(value) });
}
export function createReceipt(payload, pointer, completedAt) {
    const value = {
        kind: 'recovery-operational-trust-root-restore-receipt.v1',
        grantId: payload.grantId,
        repositoryId: payload.repositoryId,
        generation: payload.replacementGeneration,
        rootDigest: payload.replacementRootDigest,
        previousPointerDigest: payload.expectedActivePointerDigest,
        newPointerDigest: pointer.pointerDigest,
        completedAt,
    };
    return normalizeReceipt({ ...value, receiptDigest: canonicalDigest(value) });
}
export function createTerminal(payload, envelopeDigest, receipt, consumedAt) {
    const value = {
        kind: 'recovery-operational-trust-root-restore-terminal.v1',
        state: 'consumed',
        grantId: payload.grantId,
        envelopeDigest,
        receiptDigest: receipt.receiptDigest,
        consumedAt,
    };
    return normalizeTerminal({
        ...value,
        terminalDigest: canonicalDigest(value),
    });
}
export function createAuditRecord(payload, envelopeDigest, receipt, terminal, recordedAt) {
    const recordId = canonicalDigest({
        kind: 'recovery-operational-trust-root-restore-audit-identity.v1',
        grantId: payload.grantId,
        envelopeDigest,
        receiptDigest: receipt.receiptDigest,
        terminalDigest: terminal.terminalDigest,
    });
    const value = {
        kind: 'recovery-operational-trust-root-restore-audit.v1',
        recordId,
        grantId: payload.grantId,
        repositoryId: payload.repositoryId,
        authorityDescriptorDigest: payload.authorityDescriptorDigest,
        authorityGeneration: payload.authorityGeneration,
        recoveryRuntimeDigest: payload.recoveryRuntimeDigest,
        externalAuditRoot: payload.externalAuditRoot,
        humanSigner: payload.humanSigner,
        signerFingerprint: payload.signerFingerprint,
        generation: payload.replacementGeneration,
        rootDigest: payload.replacementRootDigest,
        previousPointerDigest: payload.expectedActivePointerDigest,
        newPointerDigest: receipt.newPointerDigest,
        envelopeDigest,
        terminalDigest: terminal.terminalDigest,
        recordedAt,
    };
    return normalizeAudit({ ...value, recordDigest: canonicalDigest(value) });
}
export function createAuditAcknowledgement(audit, acknowledgedAt) {
    const value = {
        kind: 'recovery-operational-trust-root-restore-audit-ack.v1',
        grantId: audit.grantId,
        recordId: audit.recordId,
        recordDigest: audit.recordDigest,
        acknowledgedAt,
    };
    return normalizeAuditAcknowledgement({
        ...value,
        acknowledgementDigest: canonicalDigest(value),
    });
}
export function normalizeEnvelope(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ENVELOPE_KEYS) ||
        typeof value.signature !== 'string' ||
        value.signature.length === 0 ||
        value.signature.length > 64 * 1024) {
        throw grantInvalid();
    }
    const payload = normalizeGrant(value.payload);
    const replacement = normalizeRoot(value.replacement);
    assertReplacementBinding(payload, replacement);
    return deepFreeze({ payload, replacement, signature: value.signature });
}
function normalizeGrant(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, GRANT_KEYS) ||
        typeof value.grantId !== 'string' ||
        !GRANT_ID.test(value.grantId)) {
        throw grantInvalid();
    }
    const { grantId, ...rawUnsigned } = value;
    const unsigned = normalizeUnsignedGrant(rawUnsigned);
    const expectedId = recoveryOperationalTrustRootRestoreGrantId(unsigned);
    if (grantId !== expectedId)
        throw grantInvalid();
    return deepFreeze({ ...unsigned, grantId: expectedId });
}
function normalizeUnsignedGrant(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, UNSIGNED_GRANT_KEYS) ||
        value.kind !== 'recovery-operational-trust-root-restore-grant.v1' ||
        value.operation !== 'restore-operational-trust-root' ||
        !isIdentifier(value.repositoryId) ||
        !isDigest(value.authorityDescriptorDigest) ||
        !isPositiveInteger(value.authorityGeneration) ||
        !isDigest(value.recoveryRuntimeDigest) ||
        !isExactAbsolutePath(value.externalAuditRoot) ||
        !isIdentifier(value.humanSigner) ||
        typeof value.signerFingerprint !== 'string' ||
        !FINGERPRINT.test(value.signerFingerprint) ||
        !isNonNegativeInteger(value.expectedGeneration) ||
        (value.expectedActivePointerDigest !== null &&
            !isDigest(value.expectedActivePointerDigest)) ||
        !isDigest(value.replacementRootDigest) ||
        !isPositiveInteger(value.replacementGeneration) ||
        value.replacementGeneration !== value.expectedGeneration + 1 ||
        (value.expectedGeneration === 0) !==
            (value.expectedActivePointerDigest === null) ||
        value.uses !== 1 ||
        value.oneShot !== true) {
        throw grantInvalid();
    }
    const issuedAt = exactIso(value.issuedAt);
    const expiresAt = exactIso(value.expiresAt);
    const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
    if (lifetime <= 0 || lifetime > RECOVERY_TRUST_ROOT_RESTORE_TTL_MS) {
        throw grantInvalid();
    }
    return deepFreeze({
        kind: 'recovery-operational-trust-root-restore-grant.v1',
        operation: 'restore-operational-trust-root',
        repositoryId: value.repositoryId,
        authorityDescriptorDigest: value.authorityDescriptorDigest,
        authorityGeneration: value.authorityGeneration,
        recoveryRuntimeDigest: value.recoveryRuntimeDigest,
        externalAuditRoot: value.externalAuditRoot,
        humanSigner: value.humanSigner,
        signerFingerprint: value.signerFingerprint,
        expectedGeneration: value.expectedGeneration,
        expectedActivePointerDigest: value.expectedActivePointerDigest,
        replacementRootDigest: value.replacementRootDigest,
        replacementGeneration: value.replacementGeneration,
        issuedAt,
        expiresAt,
        uses: 1,
        oneShot: true,
    });
}
export function normalizePointer(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, POINTER_KEYS) ||
        value.kind !== 'recovery-operational-trust-root-pointer.v1' ||
        !isIdentifier(value.repositoryId) ||
        !isDigest(value.authorityDescriptorDigest) ||
        !isPositiveInteger(value.authorityGeneration) ||
        !isPositiveInteger(value.generation) ||
        !isDigest(value.rootDigest) ||
        (value.previousPointerDigest !== null &&
            !isDigest(value.previousPointerDigest)) ||
        typeof value.grantId !== 'string' ||
        !GRANT_ID.test(value.grantId) ||
        !isDigest(value.envelopeDigest) ||
        !isDigest(value.pointerDigest)) {
        throw stateCorrupt();
    }
    const payload = {
        kind: 'recovery-operational-trust-root-pointer.v1',
        repositoryId: value.repositoryId,
        authorityDescriptorDigest: value.authorityDescriptorDigest,
        authorityGeneration: value.authorityGeneration,
        generation: value.generation,
        rootDigest: value.rootDigest,
        previousPointerDigest: value.previousPointerDigest,
        grantId: value.grantId,
        envelopeDigest: value.envelopeDigest,
        activatedAt: exactIso(value.activatedAt),
    };
    const pointerDigest = canonicalDigest(payload);
    if (value.pointerDigest !== pointerDigest)
        throw stateCorrupt();
    return deepFreeze({ ...payload, pointerDigest });
}
export function normalizeReservation(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, RESERVATION_KEYS) ||
        value.kind !== 'recovery-operational-trust-root-restore-reservation.v1' ||
        typeof value.grantId !== 'string' ||
        !GRANT_ID.test(value.grantId) ||
        !isDigest(value.envelopeDigest) ||
        !isDigest(value.reservationDigest)) {
        throw stateCorrupt();
    }
    const envelope = normalizeEnvelope(value.envelope);
    const payload = {
        kind: 'recovery-operational-trust-root-restore-reservation.v1',
        grantId: value.grantId,
        envelope,
        envelopeDigest: value.envelopeDigest,
        reservedAt: exactIso(value.reservedAt),
    };
    if (envelope.payload.grantId !== value.grantId ||
        canonicalDigest(envelope) !== value.envelopeDigest ||
        payload.reservedAt !== envelope.payload.issuedAt ||
        value.reservationDigest !== canonicalDigest(payload)) {
        throw stateCorrupt();
    }
    return deepFreeze({
        ...payload,
        reservationDigest: value.reservationDigest,
    });
}
export function normalizeReceipt(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, RECEIPT_KEYS) ||
        value.kind !== 'recovery-operational-trust-root-restore-receipt.v1' ||
        typeof value.grantId !== 'string' ||
        !GRANT_ID.test(value.grantId) ||
        !isIdentifier(value.repositoryId) ||
        !isPositiveInteger(value.generation) ||
        !isDigest(value.rootDigest) ||
        (value.previousPointerDigest !== null &&
            !isDigest(value.previousPointerDigest)) ||
        !isDigest(value.newPointerDigest) ||
        !isDigest(value.receiptDigest)) {
        throw stateCorrupt();
    }
    const payload = {
        kind: 'recovery-operational-trust-root-restore-receipt.v1',
        grantId: value.grantId,
        repositoryId: value.repositoryId,
        generation: value.generation,
        rootDigest: value.rootDigest,
        previousPointerDigest: value.previousPointerDigest,
        newPointerDigest: value.newPointerDigest,
        completedAt: exactIso(value.completedAt),
    };
    if (value.receiptDigest !== canonicalDigest(payload))
        throw stateCorrupt();
    return deepFreeze({ ...payload, receiptDigest: value.receiptDigest });
}
export function normalizeTerminal(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, TERMINAL_KEYS) ||
        value.kind !== 'recovery-operational-trust-root-restore-terminal.v1' ||
        value.state !== 'consumed' ||
        typeof value.grantId !== 'string' ||
        !GRANT_ID.test(value.grantId) ||
        !isDigest(value.envelopeDigest) ||
        !isDigest(value.receiptDigest) ||
        !isDigest(value.terminalDigest)) {
        throw stateCorrupt();
    }
    const payload = {
        kind: 'recovery-operational-trust-root-restore-terminal.v1',
        state: 'consumed',
        grantId: value.grantId,
        envelopeDigest: value.envelopeDigest,
        receiptDigest: value.receiptDigest,
        consumedAt: exactIso(value.consumedAt),
    };
    if (value.terminalDigest !== canonicalDigest(payload))
        throw stateCorrupt();
    return deepFreeze({ ...payload, terminalDigest: value.terminalDigest });
}
export function normalizeAudit(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, AUDIT_KEYS) ||
        value.kind !== 'recovery-operational-trust-root-restore-audit.v1' ||
        !isDigest(value.recordId) ||
        typeof value.grantId !== 'string' ||
        !GRANT_ID.test(value.grantId) ||
        !isIdentifier(value.repositoryId) ||
        !isDigest(value.authorityDescriptorDigest) ||
        !isPositiveInteger(value.authorityGeneration) ||
        !isDigest(value.recoveryRuntimeDigest) ||
        !isExactAbsolutePath(value.externalAuditRoot) ||
        !isIdentifier(value.humanSigner) ||
        typeof value.signerFingerprint !== 'string' ||
        !FINGERPRINT.test(value.signerFingerprint) ||
        !isPositiveInteger(value.generation) ||
        !isDigest(value.rootDigest) ||
        (value.previousPointerDigest !== null &&
            !isDigest(value.previousPointerDigest)) ||
        !isDigest(value.newPointerDigest) ||
        !isDigest(value.envelopeDigest) ||
        !isDigest(value.terminalDigest) ||
        !isDigest(value.recordDigest)) {
        throw stateCorrupt();
    }
    const payload = {
        kind: 'recovery-operational-trust-root-restore-audit.v1',
        recordId: value.recordId,
        grantId: value.grantId,
        repositoryId: value.repositoryId,
        authorityDescriptorDigest: value.authorityDescriptorDigest,
        authorityGeneration: value.authorityGeneration,
        recoveryRuntimeDigest: value.recoveryRuntimeDigest,
        externalAuditRoot: value.externalAuditRoot,
        humanSigner: value.humanSigner,
        signerFingerprint: value.signerFingerprint,
        generation: value.generation,
        rootDigest: value.rootDigest,
        previousPointerDigest: value.previousPointerDigest,
        newPointerDigest: value.newPointerDigest,
        envelopeDigest: value.envelopeDigest,
        terminalDigest: value.terminalDigest,
        recordedAt: exactIso(value.recordedAt),
    };
    // recordId also binds the receipt digest and is therefore checked once the
    // complete durable record chain is available in assertRecordChain().
    if (value.recordDigest !== canonicalDigest(payload))
        throw stateCorrupt();
    return deepFreeze({ ...payload, recordDigest: value.recordDigest });
}
export function normalizeAuditAcknowledgement(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, AUDIT_ACK_KEYS) ||
        value.kind !== 'recovery-operational-trust-root-restore-audit-ack.v1' ||
        typeof value.grantId !== 'string' ||
        !GRANT_ID.test(value.grantId) ||
        !isDigest(value.recordId) ||
        !isDigest(value.recordDigest) ||
        !isDigest(value.acknowledgementDigest)) {
        throw stateCorrupt();
    }
    const payload = {
        kind: 'recovery-operational-trust-root-restore-audit-ack.v1',
        grantId: value.grantId,
        recordId: value.recordId,
        recordDigest: value.recordDigest,
        acknowledgedAt: exactIso(value.acknowledgedAt),
    };
    if (value.acknowledgementDigest !== canonicalDigest(payload)) {
        throw stateCorrupt();
    }
    return deepFreeze({
        ...payload,
        acknowledgementDigest: value.acknowledgementDigest,
    });
}
function assertReplacementBinding(payload, replacement) {
    if (replacement.repositoryId !== payload.repositoryId ||
        replacement.generation !== payload.replacementGeneration ||
        replacement.rootDigest !== payload.replacementRootDigest ||
        replacement.createdAt !== payload.issuedAt) {
        throw grantInvalid();
    }
}
export function assertRecordChain(reservation, receipt, terminal, audit, acknowledgement) {
    const payload = reservation.envelope.payload;
    if (receipt !== null) {
        if (receipt.grantId !== payload.grantId ||
            receipt.repositoryId !== payload.repositoryId ||
            receipt.generation !== payload.replacementGeneration ||
            receipt.rootDigest !== payload.replacementRootDigest ||
            receipt.previousPointerDigest !== payload.expectedActivePointerDigest ||
            receipt.completedAt !== reservation.reservedAt) {
            throw stateCorrupt();
        }
    }
    if (terminal !== null) {
        if (receipt === null ||
            terminal.grantId !== payload.grantId ||
            terminal.envelopeDigest !== reservation.envelopeDigest ||
            terminal.receiptDigest !== receipt.receiptDigest ||
            terminal.consumedAt !== reservation.reservedAt) {
            throw stateCorrupt();
        }
    }
    if (audit !== null) {
        if (receipt === null ||
            terminal === null ||
            audit.grantId !== payload.grantId ||
            audit.repositoryId !== payload.repositoryId ||
            audit.authorityDescriptorDigest !== payload.authorityDescriptorDigest ||
            audit.authorityGeneration !== payload.authorityGeneration ||
            audit.recoveryRuntimeDigest !== payload.recoveryRuntimeDigest ||
            audit.externalAuditRoot !== payload.externalAuditRoot ||
            audit.humanSigner !== payload.humanSigner ||
            audit.signerFingerprint !== payload.signerFingerprint ||
            audit.generation !== payload.replacementGeneration ||
            audit.rootDigest !== payload.replacementRootDigest ||
            audit.previousPointerDigest !== payload.expectedActivePointerDigest ||
            audit.newPointerDigest !== receipt.newPointerDigest ||
            audit.envelopeDigest !== reservation.envelopeDigest ||
            audit.terminalDigest !== terminal.terminalDigest ||
            audit.recordedAt !== reservation.reservedAt ||
            audit.recordId !==
                canonicalDigest({
                    kind: 'recovery-operational-trust-root-restore-audit-identity.v1',
                    grantId: payload.grantId,
                    envelopeDigest: reservation.envelopeDigest,
                    receiptDigest: receipt.receiptDigest,
                    terminalDigest: terminal.terminalDigest,
                })) {
            throw stateCorrupt();
        }
    }
    if (acknowledgement !== null &&
        (audit === null ||
            acknowledgement.grantId !== payload.grantId ||
            acknowledgement.recordId !== audit.recordId ||
            acknowledgement.recordDigest !== audit.recordDigest ||
            acknowledgement.acknowledgedAt !== reservation.reservedAt)) {
        throw stateCorrupt();
    }
}
export function assertPointerCas(active, payload) {
    const generation = active?.pointer.generation ?? 0;
    const digest = active?.pointer.pointerDigest ?? null;
    if (generation !== payload.expectedGeneration ||
        digest !== payload.expectedActivePointerDigest) {
        throw restoreError('RECOVERY_TRUST_ROOT_POINTER_CAS_MISMATCH', 'Trust-root restore does not match the exact active generation and pointer digest.', ExitCode.staleState);
    }
}
export function assertGrantWindow(payload, nowValue) {
    const now = exactDate(nowValue).getTime();
    if (now < Date.parse(payload.issuedAt)) {
        throw restoreError('RECOVERY_TRUST_ROOT_GRANT_NOT_YET_VALID', 'Trust-root restore Grant is not yet valid.', ExitCode.staleState);
    }
    if (now >= Date.parse(payload.expiresAt)) {
        throw restoreError('RECOVERY_TRUST_ROOT_GRANT_EXPIRED', 'Trust-root restore Grant has expired.', ExitCode.staleState);
    }
}
export function pointerFileName(generation) {
    if (!isPositiveInteger(generation) ||
        generation > 99_999_999_999_999_999_999) {
        throw stateCorrupt();
    }
    return `${String(generation).padStart(20, '0')}.json`;
}
export function prepareRecoveryTrustRootRestoreEnvelope(value, dependencies) {
    const envelope = normalizeEnvelope(value);
    const payload = envelope.payload;
    const replacement = envelope.replacement;
    const descriptor = dependencies.authorityDescriptor;
    if (payload.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
        payload.authorityDescriptorDigest !== descriptor.descriptorDigest ||
        payload.authorityGeneration !== descriptor.generation ||
        payload.recoveryRuntimeDigest !== descriptor.sealedRuntime.closureDigest ||
        payload.externalAuditRoot !== dependencies.externalAuditRoot ||
        payload.humanSigner !== descriptor.signer.identity ||
        payload.signerFingerprint !== descriptor.signer.fingerprint) {
        throw restoreError('RECOVERY_TRUST_ROOT_AUTHORITY_BINDING_MISMATCH', 'Trust-root restore does not bind the exact loaded Recovery Authority, runtime, and audit root.', ExitCode.verification);
    }
    assertRecoveryAuthorityDomain(descriptor, dependencies.authorityExpectations, RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE, payload.signerFingerprint);
    return { envelope, payload, replacement };
}
export function assertRecoveryTrustRootRestoreDependencies(dependencies) {
    if (!isRecord(dependencies) ||
        !isExactAbsolutePath(dependencies.externalAuditRoot) ||
        !(dependencies.now instanceof Date) ||
        !Number.isFinite(dependencies.now.getTime()) ||
        typeof dependencies.verifyHumanSignature !== 'function' ||
        typeof dependencies.appendAudit !== 'function' ||
        (dependencies.hooks !== undefined &&
            (!isRecord(dependencies.hooks) ||
                !hasExactKeys(dependencies.hooks, ['afterPhase']) ||
                typeof dependencies.hooks.afterPhase !== 'function'))) {
        throw restoreError('RECOVERY_TRUST_ROOT_DEPENDENCIES_INVALID', 'Trust-root restore requires exact out-of-band authority, time, signature, and audit dependencies.', ExitCode.unsafeEnvironment);
    }
}
import { assertRecoveryAuthorityDomain } from "./recovery-authority-contract.js";
import { RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE } from "./recovery-trust-root-values.js";
