/**
 * Exposes bounded Git commands, repository fingerprints, and post-approval admission budgets.
 *
 * Invariants:
 * - Existing Git APIs preserve their signatures, errors, output bytes, and shared budget state.
 * - Repository and governed fingerprints retain their exact framing and category order.
 */
export { publishPreparedExclusiveLock, reclaimDeadPreparedLock, } from "./filesystem-safety.js";
export { protectedBranchRef, readFileAtCommit, resolveGitExecutable, runGit, runGitBuffer, runGitWithEnvironment, } from "./git-command.js";
export { discoverRepository, fingerprintRepositoryProjection, fingerprintRepositoryProjectionExcludingPaths, fingerprintRepositoryWorktree, fingerprintUnstagedRepositoryProjection, fingerprintWorkingState, listChangedPaths, } from "./git-working-state.js";
export { LOCAL_PROTECTED_BASE_REF, resolveProtectedBaseRef, } from "./protected-base.js";
export { captureGovernedProviderProjection, compareGovernedProviderProjections, } from "./governed-provider-projection.js";
export { POST_APPROVAL_ADMISSION_LIMIT_MS, armPostApprovalAdmissionDeadline, assertPostApprovalAdmissionDeadline, assertPostApprovalAdmissionPhase, createPostApprovalAdmissionDeadline, enterActivePostApprovalTerminalCleanup, enterPostApprovalCompletionObligation, enterPostApprovalTerminalCleanup, isPostApprovalAdmissionFailure, normalizePostApprovalSubprocessError, postApprovalSubprocessBudget, withPostApprovalAdmissionDeadline, } from "./post-approval-budget.js";
