/**
 * Checks active workflow sessions for task identity, serialized scope, and resource conflicts.
 *
 * Invariants:
 * - Admission retains current worktree, write-scope, and exclusive-resource comparisons.
 * - Lease observations remain tied to the exact active session being admitted or rejected.
 */
import { readSessionFile, } from "./workflow-session-records.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import path from 'node:path';
import { taskSessionIsolationLeasePaths, observeTaskSessionIsolationLease, taskSessionLeaseConflict, } from "./workflow-session-isolation.js";
import { normalizePolicyPath, matchesAllowedPath } from "./paths.js";
import fs from 'node:fs';
import { isBaseSpecificationPath } from "../../modules/source/system-spec-catalog.js";
export function listActiveWorkflowSessionIds(runtime) {
    return listActiveWorkflowSessions(runtime).map((session) => session.sessionId);
}
export function assertTaskSessionAdmission(runtime, candidate) {
    const active = listActiveWorkflowSessions(runtime);
    if (active.length >= 2) {
        throw workflowError('TASK_SESSION_CAPACITY_REACHED', 'At most two write-capable task sessions may be active.', ExitCode.conflict, {
            details: {
                activeSessionIds: active.map((session) => session.sessionId),
            },
        });
    }
    for (const existing of active) {
        if (existing.changeId === candidate.changeId) {
            throw taskSessionIdentityConflict('TASK_SESSION_CHANGE_CONFLICT', 'Concurrent task writers must belong to different changes.', existing);
        }
        if (path.resolve(existing.repositoryRoot) ===
            path.resolve(candidate.repositoryRoot)) {
            throw taskSessionIdentityConflict('TASK_SESSION_WORKTREE_CONFLICT', 'Concurrent task writers must use different worktrees.', existing);
        }
        if (existing.branch === candidate.branch) {
            throw taskSessionIdentityConflict('TASK_SESSION_BRANCH_CONFLICT', 'Concurrent task writers must use different branches.', existing);
        }
        if (taskWriteScopesOverlap(existing.allowedPaths, candidate.allowedPaths)) {
            throw workflowError('TASK_SESSION_SCOPE_CONFLICT', 'Concurrent task writers must declare disjoint write scopes.', ExitCode.conflict, {
                details: {
                    conflictingSessionId: existing.sessionId,
                    conflictingChangeId: existing.changeId,
                    existingAllowedPaths: [...existing.allowedPaths],
                    candidateAllowedPaths: [...candidate.allowedPaths],
                },
            });
        }
        const serializedKinds = taskSerializedScopeKinds(existing.allowedPaths).filter((kind) => taskSerializedScopeKinds(candidate.allowedPaths).includes(kind));
        if (serializedKinds.length > 0 &&
            (existing.isolation.concurrencyEnabled ||
                candidate.isolation.concurrencyEnabled)) {
            throw workflowError('TASK_SESSION_SERIALIZED_SCOPE_CONFLICT', 'Concurrent task writers cannot share a serialized policy, base-spec, generated-document, or remote-effect class.', ExitCode.conflict, {
                details: {
                    conflictingSessionId: existing.sessionId,
                    conflictingChangeId: existing.changeId,
                    serializedKinds,
                },
            });
        }
        const existingResources = new Set(existing.isolation.resources.map(({ digest }) => digest));
        const resourceConflicts = candidate.isolation.resources
            .filter(({ digest }) => existingResources.has(digest))
            .map(({ kind, digest }) => ({ kind, digest }));
        if (resourceConflicts.length > 0) {
            throw workflowError('TASK_SESSION_RESOURCE_CONFLICT', 'Concurrent task writers must own distinct exclusive resources.', ExitCode.conflict, {
                details: {
                    conflictingSessionId: existing.sessionId,
                    conflictingChangeId: existing.changeId,
                    resourceConflicts,
                },
            });
        }
    }
    for (const leasePath of taskSessionIsolationLeasePaths(runtime, candidate)) {
        const observation = observeTaskSessionIsolationLease(runtime, leasePath);
        if (observation.state === 'occupied') {
            throw taskSessionLeaseConflict(leasePath);
        }
    }
}
function taskSerializedScopeKinds(allowedPaths) {
    const definitions = [
        { kind: 'base-spec', root: 'openspec/specs' },
        { kind: 'policy', root: 'workflow' },
        {
            kind: 'generated-document',
            root: 'docs/CURRENT_AND_NEXT_STEPS.md',
        },
        { kind: 'remote-effect', root: '.github' },
    ];
    const kinds = definitions
        .filter(({ root }) => allowedPaths.some((allowedPath) => taskWritePatternsOverlap(allowedPath, `${root}/**`)))
        .map(({ kind }) => kind);
    // Containing an inherited spec does not make ordinary module scope a
    // repository-wide contract operation; only an explicit spec path does.
    if (allowedPaths.some(isBaseSpecificationPath) &&
        !kinds.includes('base-spec'))
        kinds.unshift('base-spec');
    return kinds;
}
function taskSessionIdentityConflict(code, message, existing) {
    return workflowError(code, message, ExitCode.conflict, {
        details: {
            conflictingSessionId: existing.sessionId,
            conflictingChangeId: existing.changeId,
        },
    });
}
function taskWriteScopesOverlap(left, right) {
    return left.some((leftPattern) => right.some((rightPattern) => taskWritePatternsOverlap(leftPattern, rightPattern)));
}
function taskWritePatternsOverlap(left, right) {
    const normalizedLeft = normalizePolicyPath(left);
    const normalizedRight = normalizePolicyPath(right);
    if (normalizedLeft === normalizedRight)
        return true;
    const leftPrefix = normalizedLeft.endsWith('/**');
    const rightPrefix = normalizedRight.endsWith('/**');
    if (!leftPrefix && !rightPrefix)
        return false;
    if (leftPrefix) {
        const rightCandidate = rightPrefix
            ? normalizedRight.slice(0, -3)
            : normalizedRight;
        if (matchesAllowedPath(rightCandidate, normalizedLeft))
            return true;
    }
    if (rightPrefix) {
        const leftCandidate = leftPrefix
            ? normalizedLeft.slice(0, -3)
            : normalizedLeft;
        return matchesAllowedPath(leftCandidate, normalizedRight);
    }
    return false;
}
export function listConflictingActiveWorkflowSessionIds(runtime, scope) {
    const repositoryRoot = scope.repositoryRoot === undefined
        ? undefined
        : path.resolve(scope.repositoryRoot);
    const targetBranch = scope.targetRef?.startsWith('refs/heads/')
        ? scope.targetRef.slice('refs/heads/'.length)
        : undefined;
    return listActiveWorkflowSessions(runtime)
        .filter((session) => session.changeId === scope.changeId ||
        (repositoryRoot !== undefined &&
            path.resolve(session.repositoryRoot) === repositoryRoot) ||
        (targetBranch !== undefined && session.branch === targetBranch))
        .map((session) => session.sessionId);
}
function listActiveWorkflowSessions(runtime) {
    const stats = fs.lstatSync(runtime.sessions, { throwIfNoEntry: false });
    if (!stats) {
        return [];
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw workflowError('SESSION_DIRECTORY_UNSAFE', 'Workflow session directory is unsafe.', ExitCode.staleState);
    }
    return fs
        .readdirSync(runtime.sessions)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => readSessionFile(path.join(runtime.sessions, entry)))
        .filter((session) => session.state === 'active' || session.state === 'revising')
        .sort((left, right) => left.sessionId < right.sessionId
        ? -1
        : left.sessionId > right.sessionId
            ? 1
            : 0);
}
