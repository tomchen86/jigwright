/**
 * Names the object-id lookups the engine performs against a revision.
 *
 * Invariants:
 * - Every lookup returns the trimmed object id exactly as Git printed it.
 * - A lookup that may legitimately find nothing says so in its name and
 *   returns null rather than throwing.
 */
import { runGit } from "./git.js";
/** Object id of the commit a revision names. */
export function resolveCommitOid(repositoryRoot, revision) {
    return runGit(repositoryRoot, ['rev-parse', `${revision}^{commit}`]).trim();
}
/** Object id of the tree a revision points at. */
export function resolveTreeOid(repositoryRoot, revision) {
    return runGit(repositoryRoot, ['rev-parse', `${revision}^{tree}`]).trim();
}
/** Object id of the blob at `path` in a revision. */
export function resolveBlobOid(repositoryRoot, revision, path) {
    return runGit(repositoryRoot, ['rev-parse', `${revision}:${path}`]).trim();
}
/** Object id of the annotated tag a ref names, or null when the ref is absent. */
export function resolveTagOid(repositoryRoot, ref) {
    const oid = runGit(repositoryRoot, ['rev-parse', `${ref}^{tag}`], true).trim();
    return oid === '' ? null : oid;
}
/** Object id of a revision's first parent. */
export function resolveParentCommitOid(repositoryRoot, revision) {
    return runGit(repositoryRoot, ['rev-parse', `${revision}^`]).trim();
}
