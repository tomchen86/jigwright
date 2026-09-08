import { candidateResidue, normalizePaths, readJournal, assertInstalledState, currentRefMatches, } from "./investigation-publication-records.js";
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveRelative, readStablePublicationFile, } from "./investigation-publication-files.js";
import { PublicationFailure, prefixedDigest, deepFreeze, } from "./investigation-publication-values.js";
import { createInvestigationV3Blocker, } from "../../../modules/investigation/manifest/investigation-manifest.js";
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { fingerprintRepositoryProjection, discoverRepository, } from "../../repository-transaction/git.js";
import path from 'node:path';
/**
 * Read-only, source-owned observation used by the central Grant adapter. It
 * contains no Grant state and never follows a symlink or trusts journal bytes.
 */
export function observeInvestigationManifestPublicationState(input) {
    let artifacts;
    let recoveryKind;
    try {
        artifacts =
            input.source.operation === 'read-ref'
                ? [
                    observePublicationArtifact(input.privateRoot ?? input.repositoryRoot, input.source.currentRefPath),
                ]
                : observePublicationArtifacts(input.repositoryRoot, input.privateRoot ?? input.repositoryRoot, input.source.paths);
        recoveryKind = publicationRecoveryKind(input.repositoryRoot, input.privateRoot ?? input.repositoryRoot, input.source);
    }
    catch {
        const declared = input.source.operation === 'read-ref'
            ? [input.source.currentRefPath]
            : [
                input.source.paths.manifestPath,
                input.source.paths.currentRefPath,
                input.source.paths.journalPath,
            ];
        artifacts = Object.freeze([...new Set(declared)].sort().map((artifactPath) => Object.freeze({
            path: artifactPath,
            state: 'unsafe',
            contentSha256: null,
        })));
        recoveryKind = 'blocked';
    }
    return Object.freeze({
        schemaVersion: 1,
        kind: 'investigation-manifest-publication-state',
        source: structuredClone(input.source),
        recoveryKind,
        artifacts: Object.freeze(artifacts),
    });
}
function observePublicationArtifacts(repositoryRoot, privateRoot, paths) {
    const declared = [
        { root: repositoryRoot, relativePath: paths.manifestPath },
        { root: privateRoot, relativePath: paths.currentRefPath },
        { root: privateRoot, relativePath: paths.journalPath },
    ];
    let candidates = [];
    try {
        candidates = candidateResidue(repositoryRoot, paths);
    }
    catch {
        // The declared artifact observations below retain the unsafe state.
    }
    const journalCandidate = observedJournalCandidatePath(repositoryRoot, privateRoot, paths);
    if (journalCandidate !== null)
        candidates.push(journalCandidate);
    for (const candidatePath of candidates) {
        declared.push({ root: repositoryRoot, relativePath: candidatePath });
    }
    return declared
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .map(({ root, relativePath }) => observePublicationArtifact(root, relativePath));
}
function observePublicationArtifact(repositoryRoot, relativePath) {
    let absolute;
    try {
        absolute = resolveRelative(repositoryRoot, relativePath);
    }
    catch {
        return Object.freeze({
            path: relativePath,
            state: 'unsafe',
            contentSha256: null,
        });
    }
    const stats = fs.lstatSync(absolute, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!stats) {
        return Object.freeze({
            path: relativePath,
            state: 'missing',
            contentSha256: null,
        });
    }
    if (stats.isSymbolicLink()) {
        return Object.freeze({
            path: relativePath,
            state: 'symlink',
            contentSha256: null,
        });
    }
    if (stats.isDirectory()) {
        return Object.freeze({
            path: relativePath,
            state: 'directory',
            contentSha256: null,
        });
    }
    if (!stats.isFile()) {
        return Object.freeze({
            path: relativePath,
            state: 'other',
            contentSha256: null,
        });
    }
    let bytes;
    try {
        bytes =
            readStablePublicationFile(repositoryRoot, relativePath) ??
                Buffer.alloc(0);
    }
    catch {
        return Object.freeze({
            path: relativePath,
            state: 'unsafe',
            contentSha256: null,
        });
    }
    return Object.freeze({
        path: relativePath,
        state: 'file',
        contentSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
}
function publicationRecoveryKind(repositoryRoot, privateRoot, source) {
    if (source.operation === 'read-ref') {
        const state = observePublicationArtifact(privateRoot, source.currentRefPath).state;
        return state === 'missing' || state === 'file' ? 'none' : 'blocked';
    }
    try {
        const paths = normalizePaths(repositoryRoot, privateRoot, source.paths);
        if (!fs.existsSync(paths.journal)) {
            return candidateResidue(repositoryRoot, source.paths).length > 0
                ? 'blocked'
                : 'none';
        }
        const journal = readJournal(paths.journal, source.paths, paths.privateRoot, paths.repositoryRoot);
        if (journal.state === 'committed') {
            assertInstalledState(paths, journal);
            return 'committed';
        }
        if (currentRefMatches(paths.currentRef, journal.currentRef, paths.privateRoot)) {
            assertInstalledState(paths, journal);
            return 'post-ref';
        }
        return 'pre-ref';
    }
    catch {
        return 'blocked';
    }
}
function observedJournalCandidatePath(repositoryRoot, privateRoot, paths) {
    let journalPath;
    try {
        journalPath = resolveRelative(privateRoot, paths.journalPath);
    }
    catch {
        return null;
    }
    try {
        return readJournal(journalPath, paths, privateRoot, repositoryRoot).paths
            .candidatePath;
    }
    catch {
        return null;
    }
}
export function publicationBlocked(input) {
    const recoveryRequired = input.mutationPhase === 'candidate-written' ||
        input.mutationPhase === 'journal-prepared' ||
        input.mutationPhase === 'manifest-installed' ||
        input.mutationPhase === 'current-ref-published' ||
        input.mutationPhase === 'journal-committed';
    const recoveryPolicy = input.mutationPhase === 'current-ref-published' ||
        input.mutationPhase === 'journal-committed'
        ? 'idempotent-post-ref'
        : 'central-grant';
    return publicationBlockedWithCode({
        ...input,
        failureCode: input.error instanceof PublicationFailure
            ? input.error.code
            : recoveryRequired
                ? 'PUBLICATION_RECOVERY_REQUIRED'
                : 'RECONSTRUCTION_MISMATCH',
        recoveryPolicy,
        message: input.error instanceof Error
            ? input.error.message
            : 'Unknown Manifest publication failure.',
    });
}
export function publicationBlockedWithCode(input) {
    const blocker = createInvestigationV3Blocker({
        attemptedTransition: 'publication',
        candidate: input.candidate,
        failureCode: input.failureCode,
        message: input.message,
    });
    const publication = observeInvestigationManifestPublicationState({
        repositoryRoot: input.repositoryRoot,
        privateRoot: input.privateRoot,
        source: input.source,
    });
    const emittedPublicationStateDigest = prefixedDigest(canonicalJson({
        schema: 'investigation-v3-publication-emitted-state.v1',
        publication,
    }));
    const sourceWithoutEmission = {
        schemaVersion: 1,
        observation: structuredClone(input.source),
        failureIdentity: blocker.failureIdentity,
        emittedPublicationStateDigest,
        emittedGitStateDigest: safePublicationGitStateDigest(input.repositoryRoot),
        recoveryPolicy: input.recoveryPolicy ?? 'central-grant',
    };
    const failure = deepFreeze({
        schemaVersion: 1,
        kind: 'investigation-manifest-publication-failure',
        lifecycle: structuredClone(input.lifecycle),
        blocker,
        source: {
            ...sourceWithoutEmission,
            emissionDigest: prefixedDigest(canonicalJson({
                schema: 'investigation-v3-publication-failure-emission.v1',
                lifecycle: input.lifecycle,
                blocker,
                source: sourceWithoutEmission,
            })),
        },
    });
    return deepFreeze({ outcome: 'blocked', blocker, failure });
}
export function investigationManifestPublicationStateDigest(publication) {
    return prefixedDigest(canonicalJson({
        schema: 'investigation-v3-publication-emitted-state.v1',
        publication,
    }));
}
export function investigationManifestPublicationGitStateDigest(git) {
    let worktreeFingerprint;
    try {
        worktreeFingerprint = fingerprintRepositoryProjection(git.repositoryRoot, git.head, git.statusEntries);
    }
    catch (error) {
        return prefixedDigest(canonicalJson({
            schema: 'investigation-v3-publication-git-state-unavailable.v1',
            repositoryRealPath: git.repositoryRealPath,
            gitCommonDirectory: git.gitCommonDirectory,
            branch: git.branch,
            head: git.head,
            tree: git.tree,
            statusEntries: [...git.statusEntries].sort(),
            errorCode: boundedObservationErrorCode(error),
        }));
    }
    return prefixedDigest(canonicalJson({
        schema: 'investigation-v3-publication-git-state.v2',
        repositoryRealPath: git.repositoryRealPath,
        gitCommonDirectory: git.gitCommonDirectory,
        branch: git.branch,
        head: git.head,
        tree: git.tree,
        statusEntries: [...git.statusEntries].sort(),
        worktreeFingerprint,
    }));
}
function safePublicationGitStateDigest(repositoryRoot) {
    try {
        return investigationManifestPublicationGitStateDigest(discoverRepository(repositoryRoot));
    }
    catch (error) {
        return prefixedDigest(canonicalJson({
            schema: 'investigation-v3-publication-git-discovery-unavailable.v1',
            repositoryRoot: path.resolve(repositoryRoot),
            errorCode: boundedObservationErrorCode(error),
        }));
    }
}
function boundedObservationErrorCode(error) {
    if (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^[A-Z][A-Z0-9_]{0,255}$/.test(error.code)) {
        return error.code;
    }
    return 'OBSERVATION_UNAVAILABLE';
}
