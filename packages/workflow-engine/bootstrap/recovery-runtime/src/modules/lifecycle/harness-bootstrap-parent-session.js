/** Complete durable parent observations and lifecycle admission decisions. */
import path from 'node:path';
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
export function admitHarnessBootstrapParent(observation, parentChangeId, stateRoot) {
    const { repository, runtime, candidates } = observation;
    if (candidates.length === 0) {
        throw workflowError('HARNESS_BOOTSTRAP_PARENT_SESSION_NOT_FOUND', 'No active durable workflow session exists for the requested parent change.', ExitCode.staleState);
    }
    if (candidates.length !== 1) {
        throw workflowError('HARNESS_BOOTSTRAP_PARENT_SESSION_AMBIGUOUS', 'More than one active durable workflow session claims the parent change.', ExitCode.staleState);
    }
    const { session } = candidates[0];
    const expectedBranch = `work/${parentChangeId}`;
    if (session.state !== 'active' ||
        session.repositoryRoot !== repository.repositoryRealPath ||
        session.gitCommonDirectory !== repository.gitCommonDirectory ||
        session.branch !== expectedBranch ||
        repository.branch !== expectedBranch ||
        session.baseline.head !== repository.head ||
        session.baseline.tree !== repository.tree) {
        throw workflowError('HARNESS_BOOTSTRAP_PARENT_SESSION_STALE', 'Durable parent session identity, branch, or baseline differs from the current worktree.', ExitCode.staleState);
    }
    const expectedStateRoot = path.join(runtime.root, 'intervention-control');
    if (stateRoot !== expectedStateRoot) {
        throw workflowError('HARNESS_BOOTSTRAP_STATE_ROOT_MISMATCH', 'Bootstrap dispatcher state root differs from the durable workflow runtime.', ExitCode.verification);
    }
    return { session, expectedBranch };
}
