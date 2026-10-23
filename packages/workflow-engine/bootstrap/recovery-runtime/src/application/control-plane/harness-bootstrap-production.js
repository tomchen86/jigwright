export function createHarnessBootstrapRecoveryProduction(bindings) {
    const { RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE, verifySshSignatureWithPublicKey, productionRecoveryTrustRootAuditSink, productionRecoveryQuarantineAuditSink, } = bindings;
    function recoveryOperationalTrustRootDependencies(descriptor, expectations, externalAuditRoot, repositoryRoot, overrides) {
        return {
            authorityDescriptor: descriptor,
            authorityExpectations: expectations,
            externalAuditRoot,
            now: overrides.now?.() ?? new Date(),
            verifyHumanSignature(payload, signature, identity, namespace) {
                if (namespace !== RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE ||
                    identity !== descriptor.signer.identity ||
                    descriptor.signer.fingerprint !== expectations.signerFingerprint) {
                    return false;
                }
                try {
                    verifySshSignatureWithPublicKey(payload, signature, identity, descriptor.signer.publicKey, namespace);
                    return true;
                }
                catch {
                    return false;
                }
            },
            appendAudit: overrides.recoveryTrustRootAuditSink?.append ??
                productionRecoveryTrustRootAuditSink(repositoryRoot).append,
        };
    }
    function recoveryQuarantineDependencies(descriptor, expectations, envelope, repositoryRoot, overrides) {
        const externalAuditRoot = envelope.payload.externalAuditRoot;
        return {
            authorityDescriptor: descriptor,
            authorityExpectations: expectations,
            externalAuditRoot,
            now: overrides.now?.() ?? new Date(),
            verifyHumanSignature(payload, signature, identity, namespace) {
                if (identity !== descriptor.signer.identity ||
                    descriptor.signer.fingerprint !== expectations.signerFingerprint) {
                    return false;
                }
                try {
                    verifySshSignatureWithPublicKey(payload, signature, identity, descriptor.signer.publicKey, namespace);
                    return true;
                }
                catch {
                    return false;
                }
            },
            appendAudit: overrides.recoveryQuarantineAuditSink?.append ??
                productionRecoveryQuarantineAuditSink(repositoryRoot).append,
        };
    }
    return {
        recoveryOperationalTrustRootDependencies,
        recoveryQuarantineDependencies,
    };
}
