/**
 * Parses repository workflow configuration, namespace choices and task
 * authorization policy.
 *
 * Invariants:
 * - Conditional task authorization must use the reviewed workflow path-role
 *   registry.
 */
import { createWorkflowNamespaceConfig, } from '@jigwright/core/workflow-namespace';
import { isRecord, isStringArray, } from "../../foundation/canonical-json/contract-values.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { normalizePolicyPath } from "../../foundation/repository-path/repository-path.js";
import { PATH_ROLES } from "../source/path-role-registry.js";
const CHECK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function parseWorkflowConfig(value, configPath = 'workflow/config.json') {
    if (!isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.repositoryName !== 'string' ||
        (value.consumerNamespace !== undefined &&
            typeof value.consumerNamespace !== 'string') ||
        Object.hasOwn(value, 'acceptedLegacySchemaPrefixes') ||
        typeof value.changeRoot !== 'string' ||
        typeof value.runtimeDirectory !== 'string' ||
        !isStringArray(value.protectedBranches) ||
        typeof value.branchTemplate !== 'string' ||
        !value.branchTemplate.includes('{changeId}') ||
        (value.allTasksTerminalChecks !== undefined &&
            !isTerminalCheckPolicyArray(value.allTasksTerminalChecks)) ||
        (value.taskAuthorization !== undefined &&
            !isTaskAuthorizationPolicy(value.taskAuthorization))) {
        throw invalidContract('INVALID_WORKFLOW_CONFIG', 'workflow/config.json does not match schema version 1.', configPath);
    }
    normalizePolicyPath(value.changeRoot);
    normalizePolicyPath(value.runtimeDirectory);
    workflowNamespaceConfig(value);
    if (value.taskAuthorization !== undefined) {
        const registryPath = normalizePolicyPath(value.taskAuthorization.pathRoleRegistry);
        if (registryPath !== 'workflow/path-roles.json') {
            throw invalidContract('INVALID_WORKFLOW_CONFIG', 'Task authorization requires the reviewed workflow/path-roles.json registry.', configPath);
        }
    }
    return {
        ...value,
        ...(value.allTasksTerminalChecks === undefined
            ? {}
            : {
                allTasksTerminalChecks: value.allTasksTerminalChecks.map((policy) => ({
                    checkId: policy.checkId,
                    subsumes: [...policy.subsumes],
                })),
            }),
        ...(value.taskAuthorization === undefined
            ? {}
            : {
                taskAuthorization: {
                    pathRoleRegistry: value.taskAuthorization.pathRoleRegistry,
                    mandateRequiredRoles: [
                        ...value.taskAuthorization
                            .mandateRequiredRoles,
                    ],
                },
            }),
    };
}
/** Resolve the consumer-owned namespace for neutral current records. */
export function workflowNamespaceConfig(config) {
    return createWorkflowNamespaceConfig({
        consumerNamespace: config.consumerNamespace ?? config.repositoryName,
    });
}
function isTaskAuthorizationPolicy(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['pathRoleRegistry', 'mandateRequiredRoles']) ||
        typeof value.pathRoleRegistry !== 'string' ||
        !isStringArray(value.mandateRequiredRoles) ||
        value.mandateRequiredRoles.length === 0) {
        return false;
    }
    const knownRoles = new Set(PATH_ROLES);
    return (value.mandateRequiredRoles.every((role) => knownRoles.has(role)) &&
        new Set(value.mandateRequiredRoles).size ===
            value.mandateRequiredRoles.length &&
        JSON.stringify(value.mandateRequiredRoles) ===
            JSON.stringify([...value.mandateRequiredRoles].sort()));
}
function isTerminalCheckPolicyArray(value) {
    if (!Array.isArray(value) || value.length === 0)
        return false;
    const checkIds = new Set();
    for (const policy of value) {
        if (!isRecord(policy) ||
            !hasExactKeys(policy, ['checkId', 'subsumes']) ||
            typeof policy.checkId !== 'string' ||
            !CHECK_ID_PATTERN.test(policy.checkId) ||
            checkIds.has(policy.checkId) ||
            !isStringArray(policy.subsumes) ||
            policy.subsumes.some((checkId) => !CHECK_ID_PATTERN.test(checkId) || checkId === policy.checkId) ||
            new Set(policy.subsumes).size !== policy.subsumes.length) {
            return false;
        }
        checkIds.add(policy.checkId);
    }
    return true;
}
function hasExactKeys(value, expectedKeys) {
    return (Object.keys(value).length === expectedKeys.length &&
        expectedKeys.every((key) => Object.hasOwn(value, key)));
}
function invalidContract(code, message, filePath) {
    return workflowError(code, message, ExitCode.guard, {
        details: { filePath },
    });
}
