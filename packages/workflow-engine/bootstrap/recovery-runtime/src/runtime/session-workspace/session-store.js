/**
 * Exposes workflow session storage, admission, and operation-lock APIs to runtime callers.
 *
 * Invariants:
 * - Existing public types and functions keep their original signatures and durable semantics.
 * - Session records, repository serialization, and worktree isolation retain separate ownership.
 */
export { assertRepositoryLifecyclePreflightAdmission, withRepositoryLifecycleOperation, withRepositoryLifecycleOperationAsync, } from "./repository-lifecycle-lock.js";
export { runtimePaths, readSessionFile, writeJsonAtomic, createSessionId, } from "./workflow-session-records.js";
export { acquireTaskSessionIsolationLeases, closeTaskSessionIsolationLeaseAcquisition, rollbackTaskSessionIsolationLeaseAcquisition, closeOwnedRuntimeFilePublication, assertOwnedRuntimeFilePublication, rollbackOwnedRuntimeFilePublication, releaseTaskSessionIsolationLeases, assertTaskSessionIsolationLeasesOwned, } from "./workflow-session-isolation.js";
export { withSessionOperation, releaseOwnedLock, assertOwnedLock, } from "./session-operation-locks.js";
export { assertTaskSessionWorktreeRegistration, parseTaskWorktreeRegistrations, createTaskSessionIsolationBinding, } from "./workflow-session-worktrees.js";
export { listActiveWorkflowSessionIds, assertTaskSessionAdmission, listConflictingActiveWorkflowSessionIds, } from "./workflow-session-admission.js";
