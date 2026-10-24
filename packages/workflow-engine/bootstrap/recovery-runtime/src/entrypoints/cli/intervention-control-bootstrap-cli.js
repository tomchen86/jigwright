/** Inspect existing interventions and dispose active metadata with human authorization. */
import crypto from 'node:crypto';
import path from 'node:path';
import { abandonPersistedIntervention, assertPersistedInterventionAbandonable, } from "../../runtime/storage-journal/intervention-abandonment.js";
import { readLocalEngineBinding } from "../../runtime/storage-journal/intervention-parent-binding.js";
import { readMaintenanceGrantForParent } from "../../application/control-plane/intervention-maintenance.js";
import { revokeMaintenanceGrantForParent } from "../../composition-root/human-revocation-production.js";
import { ExitCode, WorkflowError, workflowError, } from "../../foundation/errors/errors.js";
import { discoverRepository } from "../../runtime/repository-transaction/git.js";
import { runtimePaths } from "../../runtime/session-workspace/session-store.js";
import { verifyAuthorityAuditEvents } from "../../runtime/storage-journal/authority-audit-service.js";
import { readPersistedIntervention, } from "../../runtime/storage-journal/intervention-control-persistence.js";
export function assertSupportedBootstrapInterventionCommand(argv) {
    if (!(argv[0] === 'status' && argv.length === 2 && isNonEmpty(argv[1])) &&
        !(argv[0] === 'change' &&
            argv[1] === 'revoke-intervention' &&
            argv.length === 5 &&
            isNonEmpty(argv[2]) &&
            argv[3] === '--reason' &&
            isNonEmpty(argv[4]))) {
        throw workflowError('INTERVENTION_BOOTSTRAP_COMMAND_UNSUPPORTED', bootstrapInterventionUsage(), ExitCode.usage);
    }
}
export function dispatchBootstrapInterventionCommand(argv, cwd, dependencies = {}) {
    assertSupportedBootstrapInterventionCommand(argv);
    const repository = discoverRepository(cwd);
    const stateRoot = bootstrapInterventionStateRoot(repository.gitCommonDirectory);
    if (argv[0] === 'change' &&
        argv[1] === 'revoke-intervention' &&
        argv.length === 5 &&
        isNonEmpty(argv[2]) &&
        argv[3] === '--reason' &&
        isNonEmpty(argv[4])) {
        const before = readMaintenanceGrantForParent(stateRoot, argv[2]);
        if (!dependencies.verifyHumanSignature) {
            throw workflowError('INTERVENTION_MAINTENANCE_APPROVAL_UI_REQUIRED', 'Maintenance revocation requires a trusted historical signature verifier.', ExitCode.unsafeEnvironment);
        }
        const bindingPath = parentBindingPath(stateRoot, argv[2]);
        assertPersistedInterventionAbandonable(stateRoot, bindingPath, {
            parentChangeId: argv[2],
            interventionChangeId: before.interventionChangeId,
            checkpointId: before.checkpointId,
            grantId: before.envelope.payload.grantId,
        });
        verifyAuthorityAuditEvents({
            externalAuditRoot: before.authorityAudit.externalAuditRoot,
            repositoryRoot: repository.repositoryRoot,
            repositoryId: before.authorityAudit.repositoryId,
        });
        const revoked = revokeMaintenanceGrantForParent(repository.repositoryRoot, stateRoot, argv[2], {
            reason: argv[4],
            now: cliNow(dependencies),
            signer: dependencies.maintenanceSigner,
            verifyHumanSignature: dependencies.verifyHumanSignature,
            testAfterAudit: dependencies.testHooks?.afterAuthorityAuditRecorded,
        });
        const abandoned = abandonPersistedIntervention(stateRoot, bindingPath, {
            parentChangeId: argv[2],
            interventionChangeId: revoked.interventionChangeId,
            checkpointId: revoked.checkpointId,
            grantId: revoked.envelope.payload.grantId,
            grantRecordDigest: revoked.recordDigest,
            reason: revoked.revocationReason,
            at: revoked.revokedAt,
            testAfterIntentPersisted: dependencies.testHooks?.afterAbandonmentIntentPersisted,
        });
        return result({
            action: 'revoke-intervention',
            stateRoot,
            bindingPath,
            parentChangeId: argv[2],
            checkpointId: revoked.checkpointId,
            effectsPerformed: before.state !== 'revoked' || abandoned.effectsPerformed,
        });
    }
    const parentChangeId = argv[1];
    const intervention = readPersistedIntervention(stateRoot, parentChangeId);
    const bindingPath = parentBindingPath(stateRoot, parentChangeId);
    return result({
        action: 'status',
        stateRoot,
        bindingPath,
        parentChangeId,
        checkpointId: intervention.checkpoint.checkpointId,
        workspaceId: intervention.childWorkspace.workspaceId,
        intervention,
        parentSession: readOptionalParentSession(bindingPath),
        effectsPerformed: false,
    });
}
export function bootstrapInterventionUsage() {
    return [
        'Usage:',
        '  pnpm workflow change revoke-intervention <parent-change-id> --reason <text> [--json]',
        '  pnpm workflow intervention status <parent-change-id> [--json]',
    ].join('\n');
}
export function bootstrapInterventionStateRoot(gitCommonDirectory) {
    return path.join(runtimePaths(gitCommonDirectory, 'workflow-engine').root, 'intervention-control');
}
function result(input) {
    return {
        kind: 'bootstrap-intervention-cli-result.v1',
        bindingPath: null,
        parentChangeId: null,
        checkpointId: null,
        workspaceId: null,
        intervention: null,
        parentSession: null,
        ...input,
    };
}
function parentBindingPath(stateRoot, parentChangeId) {
    const identity = crypto
        .createHash('sha256')
        .update(`parent-session\0${parentChangeId}`)
        .digest('hex');
    return path.join(stateRoot, 'local-parent-sessions', `${identity}.json`);
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
function cliNow(dependencies) {
    const now = dependencies.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw workflowError('INTERVENTION_BOOTSTRAP_CLOCK_INVALID', 'Bootstrap CLI clock returned an invalid date.', ExitCode.unsafeEnvironment);
    }
    return new Date(now.getTime());
}
function isNonEmpty(value) {
    return (typeof value === 'string' && value.trim() === value && value.length > 0);
}
