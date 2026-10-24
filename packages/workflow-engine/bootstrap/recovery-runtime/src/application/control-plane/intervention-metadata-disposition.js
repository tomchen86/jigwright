/** Inspect retained intervention metadata and coordinate its authorized disposition. */
import crypto from 'node:crypto';
import path from 'node:path';
import { ExitCode, WorkflowError, workflowError, } from "../../foundation/errors/errors.js";
export function createInterventionMetadataDisposition({ discoverRepository, runtimePaths, readMaintenanceGrantForParent, assertPersistedInterventionAbandonable, verifyAuthorityAuditEvents, revokeMaintenanceGrantForParent, authorizeHumanRevocation, abandonPersistedIntervention, readPersistedIntervention, readLocalEngineBinding, }) {
    function inspect(cwd, parentChangeId) {
        const repository = discoverRepository(cwd);
        const stateRoot = interventionStateRoot(repository.gitCommonDirectory);
        const intervention = readPersistedIntervention(stateRoot, parentChangeId);
        const bindingPath = parentBindingPath(stateRoot, parentChangeId);
        return {
            stateRoot,
            bindingPath,
            parentChangeId,
            checkpointId: intervention.checkpoint.checkpointId,
            workspaceId: intervention.childWorkspace.workspaceId,
            intervention,
            parentSession: readOptionalParentSession(bindingPath),
            effectsPerformed: false,
        };
    }
    function revoke(cwd, parentChangeId, reason, dependencies) {
        const repository = discoverRepository(cwd);
        const stateRoot = interventionStateRoot(repository.gitCommonDirectory);
        const before = readMaintenanceGrantForParent(stateRoot, parentChangeId);
        if (!dependencies.verifyHumanSignature) {
            throw workflowError('INTERVENTION_MAINTENANCE_APPROVAL_UI_REQUIRED', 'Maintenance revocation requires a trusted historical signature verifier.', ExitCode.unsafeEnvironment);
        }
        const bindingPath = parentBindingPath(stateRoot, parentChangeId);
        assertPersistedInterventionAbandonable(stateRoot, bindingPath, {
            parentChangeId,
            interventionChangeId: before.interventionChangeId,
            checkpointId: before.checkpointId,
            grantId: before.envelope.payload.grantId,
        });
        verifyAuthorityAuditEvents({
            externalAuditRoot: before.authorityAudit.externalAuditRoot,
            repositoryRoot: repository.repositoryRoot,
            repositoryId: before.authorityAudit.repositoryId,
        });
        const revoked = revokeMaintenanceGrantForParent(authorizeHumanRevocation, repository.repositoryRoot, stateRoot, parentChangeId, {
            reason,
            now: dispositionNow(dependencies),
            signer: dependencies.maintenanceSigner,
            verifyHumanSignature: dependencies.verifyHumanSignature,
            testAfterAudit: dependencies.testHooks?.afterAuthorityAuditRecorded,
        });
        const abandoned = abandonPersistedIntervention(stateRoot, bindingPath, {
            parentChangeId,
            interventionChangeId: revoked.interventionChangeId,
            checkpointId: revoked.checkpointId,
            grantId: revoked.envelope.payload.grantId,
            grantRecordDigest: revoked.recordDigest,
            reason: revoked.revocationReason,
            at: revoked.revokedAt,
            testAfterIntentPersisted: dependencies.testHooks?.afterAbandonmentIntentPersisted,
        });
        return {
            stateRoot,
            bindingPath,
            parentChangeId,
            checkpointId: revoked.checkpointId,
            effectsPerformed: before.state !== 'revoked' || abandoned.effectsPerformed,
        };
    }
    function interventionStateRoot(gitCommonDirectory) {
        return path.join(runtimePaths(gitCommonDirectory, 'workflow-engine').root, 'intervention-control');
    }
    function readOptionalParentSession(bindingPath) {
        try {
            return readLocalEngineBinding(bindingPath);
        }
        catch (error) {
            if (error instanceof WorkflowError &&
                error.code === 'BOOTSTRAP_BINDING_NOT_FOUND') {
                return null;
            }
            throw error;
        }
    }
    return { inspect, revoke };
}
function parentBindingPath(stateRoot, parentChangeId) {
    const identity = crypto
        .createHash('sha256')
        .update(`parent-session\0${parentChangeId}`)
        .digest('hex');
    return path.join(stateRoot, 'local-parent-sessions', `${identity}.json`);
}
function dispositionNow(dependencies) {
    const now = dependencies.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw workflowError('INTERVENTION_BOOTSTRAP_CLOCK_INVALID', 'Bootstrap CLI clock returned an invalid date.', ExitCode.unsafeEnvironment);
    }
    return new Date(now.getTime());
}
