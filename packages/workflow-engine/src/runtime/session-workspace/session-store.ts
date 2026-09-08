/**
 * Exposes workflow session storage, admission, and operation-lock APIs to runtime callers.
 *
 * Invariants:
 * - Existing public types and functions keep their original signatures and durable semantics.
 * - Session records, repository serialization, and worktree isolation retain separate ownership.
 */

export {
  type RepositoryLifecycleOperationOptions,
  assertRepositoryLifecyclePreflightAdmission,
  withRepositoryLifecycleOperation,
  withRepositoryLifecycleOperationAsync,
} from './repository-lifecycle-lock.ts';
export {
  type TaskSessionResourceLease,
  type TaskSessionIsolationBinding,
  type WorkflowSession,
  runtimePaths,
  readSessionFile,
  writeJsonAtomic,
  createSessionId,
} from './workflow-session-records.ts';
export {
  type OwnedRuntimeFilePublication,
  type TaskSessionIsolationLeaseAcquisitionHooks,
  type TaskSessionIsolationLeaseAcquisition,
  acquireTaskSessionIsolationLeases,
  closeTaskSessionIsolationLeaseAcquisition,
  rollbackTaskSessionIsolationLeaseAcquisition,
  closeOwnedRuntimeFilePublication,
  assertOwnedRuntimeFilePublication,
  rollbackOwnedRuntimeFilePublication,
  releaseTaskSessionIsolationLeases,
  assertTaskSessionIsolationLeasesOwned,
} from './workflow-session-isolation.ts';
export {
  withSessionOperation,
  releaseOwnedLock,
  assertOwnedLock,
} from './session-operation-locks.ts';
export {
  type TaskWorktreeRegistration,
  assertTaskSessionWorktreeRegistration,
  parseTaskWorktreeRegistrations,
  createTaskSessionIsolationBinding,
} from './workflow-session-worktrees.ts';
export {
  listActiveWorkflowSessionIds,
  assertTaskSessionAdmission,
  listConflictingActiveWorkflowSessionIds,
} from './workflow-session-admission.ts';
