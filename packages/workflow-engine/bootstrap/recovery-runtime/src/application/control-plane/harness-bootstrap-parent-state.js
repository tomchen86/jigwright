/** Resolve an admitted durable parent and publish its trusted bootstrap snapshot. */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { WorkflowError } from "../../foundation/errors/errors.js";
import { canonicalDigest as digestCanonical } from "../../modules/authority/intervention-control-values.js";
import { assertHarnessBootstrapParentBinding, } from "../../modules/authority/harness-bootstrap-parent-contract.js";
import { admitHarnessBootstrapParent, } from "../../modules/lifecycle/harness-bootstrap-parent-session.js";
export function createHarnessBootstrapParentState(bindings) {
    const { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST, observeParentSessions, observeParentBindingPath, readLocalEngineBinding, readControlPlaneSupervisorState, persistTrustedBootstrapSessionSnapshot, } = bindings;
    function resolveHarnessBootstrapParentState(cwd, parentChangeId, stateRoot) {
        const observation = observeParentSessions(cwd, parentChangeId);
        const { repository } = observation;
        const { session, expectedBranch } = admitHarnessBootstrapParent(observation, parentChangeId, stateRoot);
        const localBinding = readOptionalParentBinding(stateRoot, parentChangeId);
        let engineBinding = BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST;
        let sessionSchema = `workflow-session.v${session.schemaVersion}`;
        if (localBinding !== null) {
            assertHarnessBootstrapParentBinding(localBinding, parentChangeId, repository, expectedBranch);
            engineBinding = localBinding.engineDigest;
            sessionSchema = localBinding.sessionSchema;
        }
        else {
            const supervisor = readOptionalSupervisor(stateRoot);
            if (supervisor !== null) {
                engineBinding = supervisor.activeArtifact.executableDigest;
            }
        }
        return {
            parent: {
                changeId: parentChangeId,
                status: 'active',
                engineBinding,
                sessionSchema,
                blocker: null,
            },
            sessionSnapshotPath: persistTrustedBootstrapSessionSnapshot(stateRoot, session),
            pendingIntent: canonicalJson({
                kind: 'harness-bootstrap-parent-resume-intent.v1',
                sessionId: session.sessionId,
                changeId: session.changeId,
                taskId: session.taskId,
                branch: session.branch,
                baseline: session.baseline,
            }),
            policyDigest: digestCanonical({
                kind: 'harness-bootstrap-parent-policy-binding.v1',
                changeId: session.changeId,
                taskId: session.taskId,
                artifacts: session.artifacts,
                allowedPaths: session.allowedPaths,
                requiredChecks: session.requiredChecks,
                requiredCheckDigests: session.requiredCheckDigests,
                planningAssurance: session.planningAssurance ?? null,
                mandateBinding: session.mandateBinding ?? null,
            }),
        };
    }
    function readOptionalParentBinding(stateRoot, parentChangeId) {
        const bindingPath = observeParentBindingPath(stateRoot, parentChangeId);
        if (bindingPath === null)
            return null;
        return readLocalEngineBinding(bindingPath);
    }
    function readOptionalSupervisor(stateRoot) {
        try {
            return readControlPlaneSupervisorState(stateRoot);
        }
        catch (error) {
            if (error instanceof WorkflowError &&
                error.code === 'CONTROL_PLANE_SUPERVISOR_NOT_FOUND') {
                return null;
            }
            throw error;
        }
    }
    return { resolveHarnessBootstrapParentState };
}
