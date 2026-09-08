/**
 * Exposes workflow identifiers and repository-boundary checks for runtime workspaces.
 *
 * Invariants:
 * - Identifier errors and runtime directory layouts retain their exact contracts.
 * - Policy paths cannot escape the repository or cross symbolic-link aliases.
 *
 * Depends on: the core runtime-path kernel and foundation repository-path validation.
 * Failure modes: invalid workspace identities, changed recovery errors, or unsafe policy paths.
 */
import { RepositoryBoundaryError, assertInvestigationId as assertCoreInvestigationId, assertInvocationId as assertCoreInvocationId, assertPolicyPathInsideRepository as assertCorePolicyPathInsideRepository, assertSessionId as assertCoreSessionId, assertTaskId as assertCoreTaskId, investigationRuntimePaths, } from '@jigwright/core/runtime-path-kernel';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertChangeId, matchesAllowedPath, normalizeChangedPath, normalizeExactRepositoryPath, normalizePolicyPath, } from "../../foundation/repository-path/repository-path.js";
export { assertChangeId, investigationRuntimePaths, matchesAllowedPath, normalizeChangedPath, normalizeExactRepositoryPath, normalizePolicyPath, };
export function assertTaskId(value) {
    return assertCoreTaskId(value, () => workflowError('INVALID_TASK_ID', `Invalid task ID: ${value}`, ExitCode.usage, { recovery: 'Use a dotted numeric task ID, for example 1.1.' }));
}
export function assertSessionId(value) {
    return assertCoreSessionId(value, () => workflowError('INVALID_SESSION_ID', `Invalid session ID: ${value}`, ExitCode.usage));
}
export function assertInvestigationId(value) {
    return assertCoreInvestigationId(value, () => workflowError('INVALID_INVESTIGATION_ID', `Invalid investigation ID: ${value}`, ExitCode.usage));
}
export function assertInvocationId(value) {
    return assertCoreInvocationId(value, () => workflowError('INVALID_INVOCATION_ID', `Invalid provider invocation ID: ${value}`, ExitCode.usage));
}
export function assertPolicyPathInsideRepository(repositoryRoot, policyPath) {
    const normalized = normalizePolicyPath(policyPath);
    try {
        assertCorePolicyPathInsideRepository(repositoryRoot, normalized);
    }
    catch (error) {
        if (!(error instanceof RepositoryBoundaryError))
            throw error;
        if (error.code === 'PATH_ESCAPES_REPOSITORY') {
            throw workflowError('PATH_ESCAPES_REPOSITORY', `Policy path escapes the repository: ${policyPath}`, ExitCode.guard, { details: { policyPath } });
        }
        throw workflowError('SYMLINK_POLICY_PATH', `Policy path crosses a symbolic link: ${policyPath}`, ExitCode.guard, {
            details: { policyPath, symlinkPath: error.symlinkPath },
            recovery: 'Use a direct repository path without symbolic-link aliases.',
        });
    }
}
