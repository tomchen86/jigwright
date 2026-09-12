/** Assemble recovery capabilities around the independently trusted built-in engine identity. */
import { controlPlaneRecoveryGrantPersistence } from "../runtime/storage-journal/control-plane-recovery-grant.js";
import { createHarnessBootstrapAudit } from "../application/control-plane/harness-bootstrap-audit.js";
import { createHarnessBootstrapRecoveryProduction } from "../application/control-plane/harness-bootstrap-production.js";
import { createHarnessBootstrapRecoveryCommands, } from "../application/control-plane/harness-bootstrap-recovery-commands.js";
import { deriveAuthorityAuditRepositoryId } from "../runtime/storage-journal/authority-audit-ledger.js";
import { recordAuthorityAuditEvent } from "../runtime/storage-journal/authority-audit-service.js";
import { discoverRepository, runGit, } from "../runtime/repository-transaction/git.js";
import { parseMaintainerPolicy } from "../modules/authority/maintainer-policy.js";
import { createInteractiveSshSigner, verifySshSignatureWithPublicKey, } from "../adapters/signing/ssh/maintainer-signer.js";
import { importRecoveryAuthorityDescriptor, readRecoveryAuthorityDescriptor, } from "../runtime/recovery/recovery-authority-store.js";
import { verifyRecoveryAuthorityDescriptor } from "../modules/authority/recovery-authority-contract.js";
import { executeRecoveryQuarantineEnter, executeRecoveryQuarantineRelease, readRecoveryQuarantineMarker, } from "../runtime/recovery/recovery-quarantine.js";
import { RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE } from "../modules/authority/recovery-trust-root-values.js";
import { executeRecoveryOperationalTrustRootRestore } from "../runtime/recovery/recovery-trust-root-restore.js";
import { createHarnessBootstrapParentState } from "../application/control-plane/harness-bootstrap-parent-state.js";
import { observeParentSessions, observeParentBindingPath, } from "../runtime/repository-observation/harness-bootstrap-parent-state.js";
import { readLocalEngineBinding, persistTrustedBootstrapSessionSnapshot, } from "../application/control-plane/intervention-control-bootstrap.js";
import { readControlPlaneSupervisorState } from "../application/control-plane/intervention-control-updater.js";
export function createHarnessBootstrapProduction(BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST) {
    const { resolveHarnessBootstrapParentState } = createHarnessBootstrapParentState({
        BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
        observeParentSessions,
        observeParentBindingPath,
        readLocalEngineBinding,
        persistTrustedBootstrapSessionSnapshot,
        readControlPlaneSupervisorState,
    });
    function createHarnessBootstrapDependencies(cwd, overrides = {}) {
        let resolvedSigner = overrides.maintenanceSigner;
        const resolveSigner = () => {
            if (resolvedSigner === undefined) {
                const repository = discoverRepository(cwd);
                const policy = parseMaintainerPolicy(JSON.parse(runGit(repository.repositoryRoot, [
                    'show',
                    `${repository.head}:workflow/maintainer-policy.json`,
                ])));
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
            presentMaintenanceSummary: overrides.presentMaintenanceSummary ??
                ((summary) => {
                    process.stderr.write(`\n${summary.humanReadable}\n\n`);
                }),
            resolveParentDurableState: ({ parentChangeId, stateRoot }) => resolveHarnessBootstrapParentState(cwd, parentChangeId, stateRoot),
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
    const { auditHarnessRecoveryRefusal, productionRecoveryTrustRootAuditSink, productionRecoveryQuarantineAuditSink, productionControlPlaneAuditSink, productionRecoveryAuditSink, } = createHarnessBootstrapAudit({
        deriveAuthorityAuditRepositoryId,
        recordAuthorityAuditEvent,
    });
    const { recoveryOperationalTrustRootDependencies, recoveryQuarantineDependencies, createHarnessRecoveryDependencies, } = createHarnessBootstrapRecoveryProduction({
        recoveryGrants: controlPlaneRecoveryGrantPersistence,
        RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
        verifySshSignatureWithPublicKey,
        createHarnessBootstrapDependencies,
        productionRecoveryTrustRootAuditSink,
        productionRecoveryQuarantineAuditSink,
        productionControlPlaneAuditSink,
        productionRecoveryAuditSink,
    });
    function createHarnessBootstrapCommandDispatcher({ bootstrapInterventionStateRoot, bootstrapInterventionUsage, }) {
        return createHarnessBootstrapRecoveryCommands({
            discoverRepository,
            bootstrapInterventionStateRoot,
            bootstrapInterventionUsage,
            importRecoveryAuthorityDescriptor,
            readRecoveryAuthorityDescriptor,
            verifyRecoveryAuthorityDescriptor,
            executeRecoveryOperationalTrustRootRestore,
            executeRecoveryQuarantineEnter,
            executeRecoveryQuarantineRelease,
            readRecoveryQuarantineMarker,
            recoveryOperationalTrustRootDependencies,
            recoveryQuarantineDependencies,
            createHarnessRecoveryDependencies,
        });
    }
    return {
        resolveHarnessBootstrapParentState,
        createHarnessBootstrapDependencies,
        auditHarnessRecoveryRefusal,
        productionRecoveryTrustRootAuditSink,
        productionRecoveryQuarantineAuditSink,
        productionControlPlaneAuditSink,
        productionRecoveryAuditSink,
        recoveryOperationalTrustRootDependencies,
        recoveryQuarantineDependencies,
        createHarnessRecoveryDependencies,
        createHarnessBootstrapCommandDispatcher,
    };
}
