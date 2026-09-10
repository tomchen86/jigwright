/**
 * Selects the repository's local protected base or remote-tracking ref.
 *
 * Invariants:
 * - Presence of the canonical local ref explicitly selects local mode.
 * - Selection performs no remote observation or ref mutation.
 */
import { protectedBranchRef, runGit } from "./git-command.js";
export const LOCAL_PROTECTED_BASE_REF = 'refs/jigwright/protected-base';
export function resolveProtectedBaseRef(repositoryRoot, protectedBranch) {
    const localBase = runGit(repositoryRoot, ['show-ref', '--verify', '--hash', LOCAL_PROTECTED_BASE_REF], true).trim();
    return localBase
        ? LOCAL_PROTECTED_BASE_REF
        : protectedBranchRef(protectedBranch);
}
