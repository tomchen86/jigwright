import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
export function createHarnessBootstrapRecoveryProduction(bindings) {
    const { RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE, verifySshSignatureWithPublicKey, createHarnessBootstrapDependencies, productionRecoveryTrustRootAuditSink, productionRecoveryQuarantineAuditSink, productionControlPlaneAuditSink, productionRecoveryAuditSink, } = bindings;
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
    function createHarnessRecoveryDependencies(cwd, repositoryRoot, overrides) {
        const bootstrapDependencies = createHarnessBootstrapDependencies(cwd, {
            ...overrides,
            maintenanceSigner: overrides.recoverySigner ?? overrides.maintenanceSigner,
        });
        const signer = overrides.recoverySigner ?? bootstrapDependencies.maintenanceSigner;
        if (signer === undefined) {
            throw workflowError('HARNESS_RECOVERY_SIGNER_REQUIRED', 'Sealed recovery requires a controlling-terminal human signer.', ExitCode.unsafeEnvironment);
        }
        const verifyHumanSignature = bootstrapDependencies.verifyHumanSignature;
        if (verifyHumanSignature === undefined) {
            throw workflowError('HARNESS_RECOVERY_VERIFIER_REQUIRED', 'Sealed recovery requires the trusted root signature verifier.', ExitCode.unsafeEnvironment);
        }
        return {
            signer,
            dependencies: {
                now: overrides.now ?? (() => new Date()),
                consumedGrantIds: new Set(),
                verifyHumanSignature,
                auditSink: overrides.controlPlaneAuditSink ??
                    productionControlPlaneAuditSink(repositoryRoot),
                recoveryAuditSink: overrides.recoveryAuditSink ??
                    productionRecoveryAuditSink(repositoryRoot),
            },
        };
    }
    return {
        recoveryOperationalTrustRootDependencies,
        recoveryQuarantineDependencies,
        createHarnessRecoveryDependencies,
    };
}
