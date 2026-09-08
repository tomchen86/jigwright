import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode } from "../../foundation/errors/errors.js";
export function createControlPlaneRecoveryGrantRecords({ exactIso, CONTROL_PLANE_RECOVERY_GRANT_TTL_MS, isRecord, hasExactKeys, isNonEmpty, recoveryError, HARNESS_RECOVERY_SIGNATURE_NAMESPACE, exactDate, deepFreeze, canonicalDigest, assertDigest: boundAssertDigest, assertIdentifier: boundAssertIdentifier, PAYLOAD_KEYS, RECOVERY_GRANT_ID, isDigest, isExactAbsolutePath, }) {
    const assertDigest = boundAssertDigest;
    const assertIdentifier = boundAssertIdentifier;
    function createControlPlaneRecoveryGrantPayload(binding) {
        const issuedAt = exactIso(binding.issuedAt, 'HARNESS_RECOVERY_GRANT_INVALID');
        const expiresAt = new Date(Date.parse(issuedAt) + CONTROL_PLANE_RECOVERY_GRANT_TTL_MS).toISOString();
        const grantId = recoveryGrantId({
            repositoryId: binding.repositoryId,
            sourceControlPlaneGrantId: binding.sourceControlPlaneGrantId,
            previousClosureDigest: binding.previousClosureDigest,
            currentClosureDigest: binding.currentClosureDigest,
            promotionBundleDigest: binding.promotionBundleDigest,
            recoveryBundleDigest: binding.recoveryBundleDigest,
            controlPlaneUpdateRecordDigest: binding.controlPlaneUpdateRecordDigest,
            controlPlaneJournalDigest: binding.controlPlaneJournalDigest,
            sourceTransactionState: binding.sourceTransactionState,
            supervisorStateDigest: binding.supervisorStateDigest,
            supervisorGeneration: binding.supervisorGeneration,
            externalAuditRoot: binding.externalAuditRoot,
            issuedAt,
            expiresAt,
            humanSigner: binding.humanSigner,
        });
        return normalizePayload({
            kind: 'harness-recovery-grant.v1',
            grantId,
            repositoryId: binding.repositoryId,
            sourceControlPlaneGrantId: binding.sourceControlPlaneGrantId,
            operation: 'rollback-control-plane',
            previousClosureDigest: binding.previousClosureDigest,
            currentClosureDigest: binding.currentClosureDigest,
            promotionBundleDigest: binding.promotionBundleDigest,
            recoveryBundleDigest: binding.recoveryBundleDigest,
            controlPlaneUpdateRecordDigest: binding.controlPlaneUpdateRecordDigest,
            controlPlaneJournalDigest: binding.controlPlaneJournalDigest,
            sourceTransactionState: binding.sourceTransactionState,
            supervisorStateDigest: binding.supervisorStateDigest,
            supervisorGeneration: binding.supervisorGeneration,
            externalAuditRoot: binding.externalAuditRoot,
            uses: 1,
            oneShot: true,
            issuedAt,
            expiresAt,
            humanSigner: binding.humanSigner,
        });
    }
    function canonicalControlPlaneRecoveryGrantPayload(payload) {
        return canonicalJson(normalizePayload(payload));
    }
    function verifyControlPlaneRecoveryGrant(envelope, input) {
        if (!isRecord(envelope) ||
            !hasExactKeys(envelope, ['payload', 'signature']) ||
            !isRecord(envelope.payload) ||
            !isNonEmpty(envelope.signature) ||
            typeof input.verifyHumanSignature !== 'function') {
            throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant envelope is malformed.');
        }
        const payload = normalizePayload(envelope.payload);
        let verified = false;
        try {
            verified = input.verifyHumanSignature(canonicalJson(payload), envelope.signature, payload.humanSigner, HARNESS_RECOVERY_SIGNATURE_NAMESPACE);
        }
        catch {
            verified = false;
        }
        if (!verified) {
            throw recoveryError('HARNESS_RECOVERY_GRANT_SIGNATURE_INVALID', 'Recovery Grant signature is invalid for HARNESS_RECOVERY_GRANT_V1.');
        }
        const now = exactDate(input.now, 'HARNESS_RECOVERY_GRANT_CLOCK_INVALID');
        if ((input.enforceLive ?? true) &&
            now.getTime() < Date.parse(payload.issuedAt)) {
            throw recoveryError('HARNESS_RECOVERY_GRANT_NOT_YET_VALID', 'Recovery Grant activation window has not started.', ExitCode.staleState);
        }
        if ((input.enforceLive ?? true) &&
            now.getTime() >= Date.parse(payload.expiresAt)) {
            throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Recovery Grant activation window has expired.', ExitCode.staleState);
        }
        return deepFreeze(structuredClone(payload));
    }
    function controlPlaneRecoveryPrestateDigest(payload) {
        const exact = normalizePayload(payload);
        return canonicalDigest({
            kind: 'control-plane-recovery-prestate.v1',
            repositoryId: exact.repositoryId,
            sourceControlPlaneGrantId: exact.sourceControlPlaneGrantId,
            previousClosureDigest: exact.previousClosureDigest,
            currentClosureDigest: exact.currentClosureDigest,
            promotionBundleDigest: exact.promotionBundleDigest,
            recoveryBundleDigest: exact.recoveryBundleDigest,
            controlPlaneUpdateRecordDigest: exact.controlPlaneUpdateRecordDigest,
            controlPlaneJournalDigest: exact.controlPlaneJournalDigest,
            sourceTransactionState: exact.sourceTransactionState,
            supervisorStateDigest: exact.supervisorStateDigest,
            supervisorGeneration: exact.supervisorGeneration,
        });
    }
    function createControlPlaneRecoveryReceipt(input) {
        const payload = normalizePayload(input.payload);
        assertDigest(input.poststateDigest, 'HARNESS_RECOVERY_RECEIPT_INVALID');
        assertDigest(input.controlPlaneJournalDigestAfter, 'HARNESS_RECOVERY_RECEIPT_INVALID');
        assertDigest(input.supervisorStateDigestAfter, 'HARNESS_RECOVERY_RECEIPT_INVALID');
        const receiptPayload = {
            kind: 'control-plane-recovery-receipt.v1',
            recoveryGrantId: payload.grantId,
            sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
            repositoryId: payload.repositoryId,
            operation: payload.operation,
            previousClosureDigest: payload.previousClosureDigest,
            currentClosureDigest: payload.currentClosureDigest,
            prestateDigest: controlPlaneRecoveryPrestateDigest(payload),
            poststateDigest: input.poststateDigest,
            controlPlaneJournalDigestBefore: payload.controlPlaneJournalDigest,
            controlPlaneJournalDigestAfter: input.controlPlaneJournalDigestAfter,
            supervisorStateDigestBefore: payload.supervisorStateDigest,
            supervisorStateDigestAfter: input.supervisorStateDigestAfter,
            result: 'rolled-back',
            completedAt: exactIso(input.completedAt, 'HARNESS_RECOVERY_RECEIPT_INVALID'),
        };
        return deepFreeze({
            ...receiptPayload,
            receiptDigest: canonicalDigest(receiptPayload),
        });
    }
    function createControlPlaneRecoveryFailure(input) {
        const payload = normalizePayload(input.payload);
        assertIdentifier(input.errorCode, 'HARNESS_RECOVERY_FAILURE_INVALID');
        assertIdentifier(input.selectedArtifactId, 'HARNESS_RECOVERY_FAILURE_INVALID');
        assertDigest(input.selectedClosureDigest, 'HARNESS_RECOVERY_FAILURE_INVALID');
        assertDigest(input.supervisorStateDigest, 'HARNESS_RECOVERY_FAILURE_INVALID');
        assertDigest(input.controlPlaneJournalDigest, 'HARNESS_RECOVERY_FAILURE_INVALID');
        if (!Number.isSafeInteger(input.supervisorGeneration) ||
            input.supervisorGeneration < payload.supervisorGeneration) {
            throw recoveryError('HARNESS_RECOVERY_FAILURE_INVALID', 'Recovery failure supervisor generation is invalid.');
        }
        const failurePayload = {
            kind: 'control-plane-recovery-failure.v1',
            recoveryGrantId: payload.grantId,
            sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
            stage: 'restart-verification',
            errorCode: input.errorCode,
            selectedClosureDigest: input.selectedClosureDigest,
            selectedArtifactId: input.selectedArtifactId,
            supervisorStateDigest: input.supervisorStateDigest,
            supervisorGeneration: input.supervisorGeneration,
            controlPlaneJournalDigest: input.controlPlaneJournalDigest,
            failedAt: exactIso(input.failedAt, 'HARNESS_RECOVERY_FAILURE_INVALID'),
        };
        return deepFreeze({
            ...failurePayload,
            failureDigest: canonicalDigest(failurePayload),
        });
    }
    function createControlPlaneRecoveryAuditRecord(input) {
        const payload = normalizePayload(input.payload);
        assertDigest(input.envelopeDigest, 'HARNESS_RECOVERY_AUDIT_INVALID');
        if (input.poststateDigest !== null) {
            assertDigest(input.poststateDigest, 'HARNESS_RECOVERY_AUDIT_INVALID');
        }
        if (input.receiptDigest !== null) {
            assertDigest(input.receiptDigest, 'HARNESS_RECOVERY_AUDIT_INVALID');
        }
        const sequence = input.event === 'authorized'
            ? 0
            : input.event === 'rolled-back' ||
                input.event === 'expired' ||
                input.event === 'failed'
                ? 1
                : 2;
        const identity = {
            kind: 'control-plane-recovery-audit-id.v1',
            recoveryGrantId: payload.grantId,
            event: input.event,
            sequence,
        };
        const recordPayload = {
            kind: 'control-plane-recovery-audit.v1',
            recordId: canonicalDigest(identity),
            repositoryId: payload.repositoryId,
            externalAuditRoot: payload.externalAuditRoot,
            recoveryGrantId: payload.grantId,
            sourceControlPlaneGrantId: payload.sourceControlPlaneGrantId,
            humanSigner: payload.humanSigner,
            operation: payload.operation,
            sequence,
            event: input.event,
            grantEnvelopeDigest: input.envelopeDigest,
            promotionBundleDigest: payload.promotionBundleDigest,
            prestateDigest: controlPlaneRecoveryPrestateDigest(payload),
            poststateDigest: input.poststateDigest,
            receiptDigest: input.receiptDigest,
            recordedAt: exactIso(input.recordedAt, 'HARNESS_RECOVERY_AUDIT_INVALID'),
        };
        return deepFreeze({
            ...recordPayload,
            recordDigest: canonicalDigest(recordPayload),
        });
    }
    function normalizePayload(raw) {
        if (!isRecord(raw) || !hasExactKeys(raw, PAYLOAD_KEYS)) {
            throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant payload has unknown, missing, or malformed fields.');
        }
        if (raw.kind !== 'harness-recovery-grant.v1' ||
            !RECOVERY_GRANT_ID.test(String(raw.grantId)) ||
            !isNonEmpty(raw.repositoryId) ||
            !isNonEmpty(raw.sourceControlPlaneGrantId) ||
            raw.operation !== 'rollback-control-plane' ||
            !isDigest(raw.previousClosureDigest) ||
            !isDigest(raw.currentClosureDigest) ||
            raw.previousClosureDigest === raw.currentClosureDigest ||
            !isDigest(raw.promotionBundleDigest) ||
            !isDigest(raw.recoveryBundleDigest) ||
            !isDigest(raw.controlPlaneUpdateRecordDigest) ||
            !isDigest(raw.controlPlaneJournalDigest) ||
            !['RECOVERY_VERIFIED', 'SWITCHED', 'ROLLBACK_REQUIRED'].includes(String(raw.sourceTransactionState)) ||
            !isDigest(raw.supervisorStateDigest) ||
            !Number.isSafeInteger(raw.supervisorGeneration) ||
            Number(raw.supervisorGeneration) < 2 ||
            !isExactAbsolutePath(raw.externalAuditRoot) ||
            raw.uses !== 1 ||
            raw.oneShot !== true ||
            !isNonEmpty(raw.humanSigner)) {
            throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant payload has invalid authority or state bindings.');
        }
        const issuedAt = exactIso(raw.issuedAt, 'HARNESS_RECOVERY_GRANT_INVALID');
        const expiresAt = exactIso(raw.expiresAt, 'HARNESS_RECOVERY_GRANT_INVALID');
        const ttl = Date.parse(expiresAt) - Date.parse(issuedAt);
        if (ttl <= 0 || ttl > CONTROL_PLANE_RECOVERY_GRANT_TTL_MS) {
            throw recoveryError('HARNESS_RECOVERY_GRANT_TTL_INVALID', 'Recovery Grant must use a positive activation window of at most five minutes.');
        }
        const expectedGrantId = recoveryGrantId({
            repositoryId: raw.repositoryId,
            sourceControlPlaneGrantId: raw.sourceControlPlaneGrantId,
            previousClosureDigest: raw.previousClosureDigest,
            currentClosureDigest: raw.currentClosureDigest,
            promotionBundleDigest: raw.promotionBundleDigest,
            recoveryBundleDigest: raw.recoveryBundleDigest,
            controlPlaneUpdateRecordDigest: raw.controlPlaneUpdateRecordDigest,
            controlPlaneJournalDigest: raw.controlPlaneJournalDigest,
            sourceTransactionState: raw.sourceTransactionState,
            supervisorStateDigest: raw.supervisorStateDigest,
            supervisorGeneration: Number(raw.supervisorGeneration),
            externalAuditRoot: raw.externalAuditRoot,
            issuedAt,
            expiresAt,
            humanSigner: raw.humanSigner,
        });
        if (raw.grantId !== expectedGrantId) {
            throw recoveryError('HARNESS_RECOVERY_GRANT_INVALID', 'Recovery Grant identity does not match its signed activation identity.');
        }
        return {
            kind: raw.kind,
            grantId: raw.grantId,
            repositoryId: raw.repositoryId,
            sourceControlPlaneGrantId: raw.sourceControlPlaneGrantId,
            operation: raw.operation,
            previousClosureDigest: raw.previousClosureDigest,
            currentClosureDigest: raw.currentClosureDigest,
            promotionBundleDigest: raw.promotionBundleDigest,
            recoveryBundleDigest: raw.recoveryBundleDigest,
            controlPlaneUpdateRecordDigest: raw.controlPlaneUpdateRecordDigest,
            controlPlaneJournalDigest: raw.controlPlaneJournalDigest,
            sourceTransactionState: raw.sourceTransactionState,
            supervisorStateDigest: raw.supervisorStateDigest,
            supervisorGeneration: Number(raw.supervisorGeneration),
            externalAuditRoot: raw.externalAuditRoot,
            uses: 1,
            oneShot: true,
            issuedAt,
            expiresAt,
            humanSigner: raw.humanSigner,
        };
    }
    function normalizeReceipt(raw) {
        if (!isRecord(raw) ||
            !hasExactKeys(raw, [
                'completedAt',
                'controlPlaneJournalDigestAfter',
                'controlPlaneJournalDigestBefore',
                'currentClosureDigest',
                'kind',
                'operation',
                'poststateDigest',
                'prestateDigest',
                'previousClosureDigest',
                'receiptDigest',
                'recoveryGrantId',
                'repositoryId',
                'result',
                'sourceControlPlaneGrantId',
                'supervisorStateDigestAfter',
                'supervisorStateDigestBefore',
            ]) ||
            raw.kind !== 'control-plane-recovery-receipt.v1' ||
            !RECOVERY_GRANT_ID.test(String(raw.recoveryGrantId)) ||
            !isNonEmpty(raw.sourceControlPlaneGrantId) ||
            !isNonEmpty(raw.repositoryId) ||
            raw.operation !== 'rollback-control-plane' ||
            !isDigest(raw.previousClosureDigest) ||
            !isDigest(raw.currentClosureDigest) ||
            !isDigest(raw.prestateDigest) ||
            !isDigest(raw.poststateDigest) ||
            !isDigest(raw.controlPlaneJournalDigestBefore) ||
            !isDigest(raw.controlPlaneJournalDigestAfter) ||
            !isDigest(raw.supervisorStateDigestBefore) ||
            !isDigest(raw.supervisorStateDigestAfter) ||
            raw.result !== 'rolled-back' ||
            !isDigest(raw.receiptDigest)) {
            throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Control-plane recovery receipt is malformed.');
        }
        const completedAt = exactIso(raw.completedAt, 'HARNESS_RECOVERY_RECEIPT_INVALID');
        const { receiptDigest, ...payload } = raw;
        if (receiptDigest !== canonicalDigest(payload)) {
            throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Control-plane recovery receipt digest is invalid.');
        }
        return structuredClone(raw);
    }
    function normalizeFailure(raw) {
        if (!isRecord(raw) ||
            !hasExactKeys(raw, [
                'controlPlaneJournalDigest',
                'errorCode',
                'failedAt',
                'failureDigest',
                'kind',
                'recoveryGrantId',
                'selectedArtifactId',
                'selectedClosureDigest',
                'sourceControlPlaneGrantId',
                'stage',
                'supervisorGeneration',
                'supervisorStateDigest',
            ]) ||
            raw.kind !== 'control-plane-recovery-failure.v1' ||
            !RECOVERY_GRANT_ID.test(String(raw.recoveryGrantId)) ||
            !isNonEmpty(raw.sourceControlPlaneGrantId) ||
            raw.stage !== 'restart-verification' ||
            !isNonEmpty(raw.errorCode) ||
            !isDigest(raw.selectedClosureDigest) ||
            !isNonEmpty(raw.selectedArtifactId) ||
            !isDigest(raw.supervisorStateDigest) ||
            !Number.isSafeInteger(raw.supervisorGeneration) ||
            Number(raw.supervisorGeneration) < 2 ||
            !isDigest(raw.controlPlaneJournalDigest) ||
            !isDigest(raw.failureDigest)) {
            throw recoveryError('HARNESS_RECOVERY_FAILURE_INVALID', 'Persisted Recovery Grant failure is malformed.');
        }
        const failedAt = exactIso(raw.failedAt, 'HARNESS_RECOVERY_FAILURE_INVALID');
        const { failureDigest, ...payload } = raw;
        if (failureDigest !== canonicalDigest(payload)) {
            throw recoveryError('HARNESS_RECOVERY_FAILURE_INVALID', 'Persisted Recovery Grant failure digest is invalid.');
        }
        return structuredClone({
            ...raw,
            failedAt,
        });
    }
    function recoveryGrantId(input) {
        assertIdentifier(input.sourceControlPlaneGrantId, 'HARNESS_RECOVERY_GRANT_INVALID');
        assertIdentifier(input.humanSigner, 'HARNESS_RECOVERY_GRANT_INVALID');
        return `recovery-${canonicalDigest({
            kind: 'harness-recovery-grant-identity.v2',
            ...input,
        }).slice('sha256:'.length)}`;
    }
    return {
        createControlPlaneRecoveryGrantPayload,
        canonicalControlPlaneRecoveryGrantPayload,
        verifyControlPlaneRecoveryGrant,
        controlPlaneRecoveryPrestateDigest,
        createControlPlaneRecoveryReceipt,
        createControlPlaneRecoveryFailure,
        createControlPlaneRecoveryAuditRecord,
        normalizePayload,
        normalizeReceipt,
        normalizeFailure,
    };
}
