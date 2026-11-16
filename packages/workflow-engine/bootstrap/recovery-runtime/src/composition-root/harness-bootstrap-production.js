import { createInteractiveSshSigner, verifySshSignatureWithPublicKey, } from "../adapters/signing/ssh/maintainer-signer.js";
import { createHarnessBootstrapAudit } from "../application/control-plane/harness-bootstrap-audit.js";
import { createHarnessBootstrapRecoveryCommands } from "../application/control-plane/harness-bootstrap-recovery-commands.js";
import { parseMaintainerPolicy } from "../modules/authority/maintainer-policy.js";
import { verifyRecoveryAuthorityDescriptor, } from "../modules/authority/recovery-authority-contract.js";
import { ensureRecoveryAuthorityStateRoot, hasRecoveryOperationalTrustRootFence, readExternalRecoveryEnvelope, readExternalRecoveryExpectations, readExternalRecoveryInput, readExternalRecoveryTrustRootAuditRoot, readOptionalRecoveryQuarantineMarker, requireRecoveryAuthorityStateRoot, } from "../runtime/recovery/harness-bootstrap-external-input.js";
import { RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE } from "../modules/authority/recovery-trust-root-values.js";
import { importRecoveryAuthorityDescriptor, readRecoveryAuthorityDescriptor, } from "../runtime/recovery/recovery-authority-store.js";
import { executeRecoveryQuarantineEnter, executeRecoveryQuarantineRelease, readRecoveryQuarantineMarker, } from "../runtime/recovery/recovery-quarantine.js";
import { executeRecoveryOperationalTrustRootRestore } from "../runtime/recovery/recovery-trust-root-restore.js";
import { readFileAtRevision } from "../runtime/repository-transaction/git-command.js";
import { discoverRepository } from "../runtime/repository-transaction/git.js";
import { deriveAuthorityAuditRepositoryId } from "../runtime/storage-journal/authority-audit-ledger.js";
import { recordAuthorityAuditEvent } from "../runtime/storage-journal/authority-audit-service.js";
import { recordAuthorityRefusal } from "../runtime/storage-journal/authority-refusal-audit.js";
/** Assemble recovery capabilities around the independently trusted built-in engine identity. */
export function createHarnessBootstrapProduction() {
    function createHarnessBootstrapDependencies(cwd, overrides = {}) {
        let resolvedSigner = overrides.maintenanceSigner;
        const resolveSigner = () => {
            if (resolvedSigner === undefined) {
                const repository = discoverRepository(cwd);
                const policy = parseMaintainerPolicy(JSON.parse(readFileAtRevision(repository.repositoryRoot, repository.head, 'workflow/maintainer-policy.json')));
                resolvedSigner = createInteractiveSshSigner(repository.repositoryRoot, policy);
            }
            return resolvedSigner;
        };
        return {
            now: overrides.now ?? (() => new Date()),
            maintenanceSigner: {
                assertHumanPresent: () => resolveSigner().assertHumanPresent(),
                identity: () => resolveSigner().identity(),
                sign: (payload, namespace) => resolveSigner().sign(payload, namespace),
                verify: (payload, signature, identity, namespace) => resolveSigner().verify(payload, signature, identity, namespace),
            },
            verifyHumanSignature(payload, signature, signerIdentity, namespace) {
                if (overrides.verifyHumanSignature) {
                    return overrides.verifyHumanSignature(payload, signature, signerIdentity, namespace);
                }
                try {
                    resolveSigner().verify(payload, signature, signerIdentity, namespace);
                    return true;
                }
                catch {
                    return false;
                }
            },
        };
    }
    const { auditHarnessRecoveryRefusal, productionRecoveryTrustRootAuditSink, productionRecoveryQuarantineAuditSink, } = createHarnessBootstrapAudit({
        recordAuthorityRefusal,
        deriveAuthorityAuditRepositoryId,
        recordAuthorityAuditEvent,
    });
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
    function createHarnessBootstrapCommandDispatcher({ bootstrapInterventionUsage, }) {
        return createHarnessBootstrapRecoveryCommands({
            discoverRepository,
            bootstrapInterventionUsage,
            importRecoveryAuthorityDescriptor,
            readRecoveryAuthorityDescriptor,
            verifyRecoveryAuthorityDescriptor,
            executeRecoveryOperationalTrustRootRestore,
            executeRecoveryQuarantineEnter,
            executeRecoveryQuarantineRelease,
            input: {
                readExternalRecoveryExpectations,
                readExternalRecoveryInput,
                readExternalRecoveryEnvelope,
                readExternalRecoveryTrustRootAuditRoot,
                ensureRecoveryAuthorityStateRoot,
                requireRecoveryAuthorityStateRoot,
                readOptionalRecoveryQuarantineMarker,
                hasRecoveryOperationalTrustRootFence,
                readRecoveryQuarantineMarker,
            },
            recoveryOperationalTrustRootDependencies,
            recoveryQuarantineDependencies,
        });
    }
    return {
        createHarnessBootstrapDependencies,
        auditHarnessRecoveryRefusal,
        productionRecoveryTrustRootAuditSink,
        productionRecoveryQuarantineAuditSink,
        recoveryOperationalTrustRootDependencies,
        recoveryQuarantineDependencies,
        createHarnessBootstrapCommandDispatcher,
    };
}
