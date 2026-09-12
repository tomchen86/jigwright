/** Observe and admit an existing engine overlay for a parent session. */
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
export function assertHarnessBootstrapParentBinding(localBinding, parentChangeId, repository, expectedBranch) {
    if (localBinding.parentChangeId !== parentChangeId ||
        localBinding.parentWorkspacePath !== repository.repositoryRealPath ||
        localBinding.parentBranch !== `refs/heads/${expectedBranch}` ||
        localBinding.interventionState !== 'adopted' ||
        localBinding.blocker !== null) {
        throw workflowError('HARNESS_BOOTSTRAP_PARENT_BINDING_CONFLICT', 'Existing local engine binding is not a committed parent overlay.', ExitCode.staleState);
    }
}
