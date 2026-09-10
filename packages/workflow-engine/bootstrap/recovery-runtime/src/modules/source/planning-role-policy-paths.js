/**
 * Separates the change-bound role policy path from planning provider
 * changes.
 *
 * Invariants:
 * - Changed and deleted paths must be canonical and unique, and every
 *   deletion must also be a changed path.
 */
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { normalizeChangedPath } from "../../foundation/repository-path/repository-path.js";
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/**
 * The agent-role override follows one managed change but is engine policy, not
 * a planning-provider artifact. Keep its path and transition partition in one
 * provider-neutral owner so OpenSpec and future adapters never learn this
 * execution-policy vocabulary.
 */
export function agentRolePlanV2Path(changeId) {
    if (!CHANGE_ID.test(changeId) || changeId === 'archive') {
        throw invalidPlanningRolePolicyPaths();
    }
    return `workflow/agent-plans/${changeId}.json`;
}
/** Split repository-owned role policy from the provider-owned planning diff. */
export function partitionPlanningRolePolicyPaths(changeId, changedPaths, deletedPaths = []) {
    const policyPath = agentRolePlanV2Path(changeId);
    const changed = assertCanonicalUniquePaths(changedPaths);
    const deleted = assertCanonicalUniquePaths(deletedPaths);
    const changedSet = new Set(changed);
    if (deleted.some((candidate) => !changedSet.has(candidate))) {
        throw invalidPlanningRolePolicyPaths();
    }
    return Object.freeze({
        policyPath,
        policyChanged: changed.includes(policyPath),
        policyDeleted: deleted.includes(policyPath),
        providerChangedPaths: Object.freeze(changed.filter((candidate) => candidate !== policyPath)),
        providerDeletedPaths: Object.freeze(deleted.filter((candidate) => candidate !== policyPath)),
    });
}
function assertCanonicalUniquePaths(paths) {
    const normalized = paths.map((candidate) => normalizeChangedPath(candidate));
    if (normalized.some((candidate, index) => candidate !== paths[index]) ||
        new Set(normalized).size !== normalized.length) {
        throw invalidPlanningRolePolicyPaths();
    }
    return normalized;
}
function invalidPlanningRolePolicyPaths() {
    return workflowError('PLANNING_ROLE_POLICY_PATHS_INVALID', 'Planning role-policy paths must be canonical, unique, and change-bound.', ExitCode.guard);
}
