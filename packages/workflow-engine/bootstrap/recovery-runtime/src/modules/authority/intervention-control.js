/** Local intervention contracts and permitted workflow replacement reasons. */
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
export { HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE } from "./intervention-control-values.js";
export { advanceEngineAdoption, beginHarnessIntervention, canonicalHarnessMaintenanceGrantPayload, createEngineArtifact, createWipCheckpoint, decideEngineAdoptionRecovery, finalizeEngineAdoption, prepareEngineAdoption, verifyHarnessMaintenanceGrant, verifyWipCheckpoint, } from "./intervention-control-adoption.js";
export { createProtectedCapabilityManifest, protectedCapabilityClosureDigest, REQUIRED_PROTECTED_CAPABILITIES, } from "./intervention-control-protected-manifest.js";
export const WORKFLOW_SUPERSEDE_REASONS = [
    'semantic-decision-no-continuing-value',
    'user-abandoned-goal-for-different-workflow',
    'workflow-replaced',
    'workflows-merged',
];
const EXECUTION_FAILURE_REASONS = new Set([
    'environment-drift',
    'execution-limit-change',
    'network-error',
    'provider-adapter-upgrade',
    'provider-process-failure',
    'provider-timeout',
    'rate-limit',
    'retry-policy-change',
    'schema-invalid',
    'validator-repair',
    'worker-crash',
]);
export function validateWorkflowSupersedeReason(reason) {
    if (WORKFLOW_SUPERSEDE_REASONS.includes(reason)) {
        return { allowed: true, reason: reason };
    }
    if (EXECUTION_FAILURE_REASONS.has(reason)) {
        throw workflowError('SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN', 'Execution failures must use retry, repair, grant, or recovery; they cannot supersede a workflow.', ExitCode.guard);
    }
    if (reason === 'contract-or-baseline-change') {
        throw workflowError('SUPERSEDE_REQUIRES_EPOCH_ROLLOVER', 'Contract or baseline changes require an epoch rollover, not supersede.', ExitCode.guard);
    }
    throw workflowError('SUPERSEDE_REASON_UNSUPPORTED', 'Supersede requires an explicit workflow-replacement reason.', ExitCode.usage);
}
