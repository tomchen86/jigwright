/**
 * Publishes and resumes investigation manifests through the journal and current-ref commit point.
 *
 * Invariants:
 * - Candidates and journals become durable before the current ref publishes authority.
 * - Post-ref replay completes publication without reverting the committed manifest.
 */
import { validateForAuthority, } from "../../../modules/investigation/manifest/investigation-manifest.js";
import fs from 'node:fs';
import { assertPublicationSourceLifecycleBinding, lifecycleIdentity, authorityExpected, currentRefFor, assertSnapshot, publishedResult, assertLifecycleIdentity, assertSnapshotIdentity, parseCurrentManifestRef, } from "./investigation-publication-contracts.js";
import { normalizePaths, candidateRelativePath, assertPublicationRolePathsDistinct, readJournal, assertInstalledState, assertManifestTargetPreservesCurrentAuthority, installCandidate, validatedCandidateResidue, assertPublicationJournalRolePaths, currentRefMatches, assertManifestMatchesJournal, } from "./investigation-publication-records.js";
import { publicationBlockedWithCode, publicationBlocked, } from "./investigation-publication-observation.js";
import { digest, publicationFailure, } from "./investigation-publication-values.js";
import { publicationRefDigest, writeCanonical, removeAbandonedCandidateTemporaries, readJson, readStablePublicationFile, } from "./investigation-publication-files.js";
import path from 'node:path';
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import crypto from 'node:crypto';
export { investigationManifestPublicationNamespace, investigationManifestPublicationSourceMatchesLifecycle, assertInvestigationManifestPublicationFailure, investigationManifestPublicationFailureEmissionDigest, } from "./investigation-publication-contracts.js";
export { observeInvestigationManifestPublicationState, investigationManifestPublicationStateDigest, investigationManifestPublicationGitStateDigest, } from "./investigation-publication-observation.js";
/**
 * Low-level, lock-scoped Manifest publication transaction. It neither requests
 * nor consumes a human grant. Once the central transition registry exists, a
 * registered transition definition is the only authority surface that may
 * invoke this executor for a protected recovery choice.
 */
export function publishInvestigationManifestV3(input) {
    let mutationPhase = null;
    let failureCandidate = {
        paths: input.paths,
        expected: input.expected,
        manifestDigest: input.manifest.manifestDigest,
    };
    try {
        assertPublicationSourceLifecycleBinding({ operation: 'publish', paths: input.paths }, lifecycleIdentity(input.expected));
        const paths = normalizePaths(input.repositoryRoot, input.privateRoot, input.paths);
        const validated = validateForAuthority({
            repositoryRoot: input.repositoryRoot,
            manifest: input.manifest,
            expected: authorityExpected(input.expected),
        });
        if (validated.outcome !== 'verified') {
            return publicationBlockedWithCode({
                repositoryRoot: input.repositoryRoot,
                privateRoot: input.privateRoot,
                lifecycle: lifecycleIdentity(input.expected),
                source: { operation: 'publish', paths: input.paths },
                candidate: {
                    expected: input.expected,
                    manifestDigest: input.manifest.manifestDigest,
                    validationFailureIdentity: validated.blocker.failureIdentity,
                },
                failureCode: validated.blocker.failureCode,
                message: 'Manifest failed authority validation before publication.',
            });
        }
        const currentRef = currentRefFor(input.paths.manifestPath, input.manifest);
        const transactionId = digest({
            schema: 'investigation-manifest-publication-transaction.v1',
            expected: input.expected,
            currentRef,
        });
        const candidatePath = candidateRelativePath(input.paths, transactionId);
        const candidate = paths.repositoryAbsolute(candidatePath);
        assertPublicationRolePathsDistinct([
            paths.manifest,
            paths.currentRef,
            paths.journal,
            candidate,
        ]);
        const journal = {
            schemaVersion: 1,
            kind: 'investigation-manifest-publication',
            state: 'prepared',
            transactionId,
            paths: { ...input.paths, candidatePath },
            expected: structuredClone(input.expected),
            manifestDigest: input.manifest.manifestDigest,
            investigationTargetDigest: input.manifest.investigationApproval.investigationTargetDigest,
            manifest: structuredClone(input.manifest),
            currentRef,
        };
        failureCandidate = journal;
        return input.withTransitionLock((snapshot) => {
            assertSnapshot(snapshot, input.expected);
            if (publicationRefDigest(paths.privateRoot, input.paths.currentRefPath) !==
                input.expected.currentRefDigest) {
                throw publicationFailure('REVIEW_TARGET_STALE', 'Current investigation authority ref changed before publication.');
            }
            if (fs.existsSync(paths.journal)) {
                const prior = readJournal(paths.journal, input.paths, paths.privateRoot, paths.repositoryRoot);
                if (prior.state === 'prepared') {
                    throw publicationFailure('PUBLICATION_RECOVERY_REQUIRED', 'A prepared Manifest publication must resume before a replacement starts.');
                }
                assertInstalledState(paths, prior);
            }
            assertManifestTargetPreservesCurrentAuthority(paths.currentRef, currentRef, paths.privateRoot);
            mutationPhase = 'journal-prepared';
            writeCanonical(paths.journal, journal, paths.privateRoot);
            input.observePhase?.('journal-prepared');
            mutationPhase = 'candidate-written';
            writeCanonical(candidate, input.manifest, paths.repositoryRoot, 0o644);
            input.observePhase?.('candidate-written');
            mutationPhase = 'manifest-installed';
            installCandidate(candidate, paths.manifest, journal, paths);
            input.observePhase?.('manifest-installed');
            mutationPhase = 'current-ref-published';
            if (publicationRefDigest(paths.privateRoot, input.paths.currentRefPath) !==
                input.expected.currentRefDigest) {
                throw publicationFailure('REVIEW_TARGET_STALE', 'Current investigation authority ref changed before CAS publication.');
            }
            writeCanonical(paths.currentRef, currentRef, paths.privateRoot);
            input.observePhase?.('current-ref-published');
            mutationPhase = 'journal-committed';
            writeCanonical(paths.journal, { ...journal, state: 'committed' }, paths.privateRoot);
            input.observePhase?.('journal-committed');
            return publishedResult(journal);
        });
    }
    catch (error) {
        return publicationBlocked({
            repositoryRoot: input.repositoryRoot,
            privateRoot: input.privateRoot,
            lifecycle: lifecycleIdentity(input.expected),
            source: { operation: 'publish', paths: input.paths },
            candidate: failureCandidate,
            mutationPhase,
            error,
        });
    }
}
export function inspectInvestigationManifestPublication(input) {
    try {
        assertPublicationSourceLifecycleBinding({ operation: 'inspect', paths: input.paths }, input.lifecycle);
        const paths = normalizePaths(input.repositoryRoot, input.privateRoot, input.paths);
        if (!fs.existsSync(paths.journal)) {
            const candidate = validatedCandidateResidue(paths.repositoryRoot, paths.privateRoot, input.paths, input.lifecycle);
            if (candidate === null)
                return { outcome: 'none' };
            return publicationBlockedWithCode({
                repositoryRoot: input.repositoryRoot,
                privateRoot: input.privateRoot,
                lifecycle: input.lifecycle,
                source: { operation: 'inspect', paths: input.paths },
                candidate: {
                    paths: input.paths,
                    candidatePath: candidate.candidatePath,
                    transactionId: candidate.transactionId,
                },
                failureCode: 'PUBLICATION_RECOVERY_REQUIRED',
                message: 'Manifest publication stopped after candidate creation and before its journal was durable.',
            });
        }
        const journal = readJournal(paths.journal, input.paths, paths.privateRoot, paths.repositoryRoot);
        assertLifecycleIdentity(journal.expected, input.lifecycle);
        assertPublicationJournalRolePaths(paths, journal);
        if (journal.state === 'committed') {
            assertInstalledState(paths, journal);
            return {
                outcome: 'committed',
                transactionId: journal.transactionId,
                manifestDigest: journal.manifestDigest,
                investigationTargetDigest: journal.investigationTargetDigest,
            };
        }
        if (currentRefMatches(paths.currentRef, journal.currentRef, paths.privateRoot)) {
            assertInstalledState(paths, journal);
            return {
                outcome: 'recoverable',
                transactionId: journal.transactionId,
                recoveryKind: 'post-ref',
                manifestDigest: journal.manifestDigest,
                investigationTargetDigest: journal.investigationTargetDigest,
            };
        }
        const failure = publicationBlockedWithCode({
            repositoryRoot: input.repositoryRoot,
            privateRoot: input.privateRoot,
            lifecycle: input.lifecycle,
            source: { operation: 'inspect', paths: input.paths },
            candidate: { journal, recoveryKind: 'pre-ref' },
            failureCode: 'PUBLICATION_RECOVERY_REQUIRED',
            message: 'Manifest publication stopped before its current authority ref was installed.',
        });
        return {
            outcome: 'recoverable',
            transactionId: journal.transactionId,
            recoveryKind: 'pre-ref',
            manifestDigest: journal.manifestDigest,
            investigationTargetDigest: journal.investigationTargetDigest,
            blocker: failure.blocker,
            failure: failure.failure,
        };
    }
    catch (error) {
        return publicationBlocked({
            repositoryRoot: input.repositoryRoot,
            privateRoot: input.privateRoot,
            lifecycle: input.lifecycle,
            source: { operation: 'inspect', paths: input.paths },
            candidate: input.paths,
            error,
        });
    }
}
export function resumeInvestigationManifestPublication(input) {
    let paths;
    let journal;
    let mutationPhase = null;
    try {
        assertPublicationSourceLifecycleBinding({ operation: 'resume', paths: input.paths }, input.lifecycle);
        paths = normalizePaths(input.repositoryRoot, input.privateRoot, input.paths);
        journal = readJournal(paths.journal, input.paths, paths.privateRoot, paths.repositoryRoot);
        assertLifecycleIdentity(journal.expected, input.lifecycle);
        assertPublicationJournalRolePaths(paths, journal);
        if (journal.state === 'committed') {
            assertInstalledState(paths, journal);
            return publishedResult(journal);
        }
    }
    catch (error) {
        return publicationBlocked({
            repositoryRoot: input.repositoryRoot,
            privateRoot: input.privateRoot,
            lifecycle: input.lifecycle,
            source: { operation: 'resume', paths: input.paths },
            candidate: input.paths,
            error,
        });
    }
    try {
        return input.withTransitionLock((snapshot) => {
            assertSnapshotIdentity(snapshot, journal.expected);
            const desiredRefInstalled = currentRefMatches(paths.currentRef, journal.currentRef, paths.privateRoot);
            const currentRefDigest = publicationRefDigest(paths.privateRoot, input.paths.currentRefPath);
            if (currentRefDigest !== journal.expected.currentRefDigest &&
                !desiredRefInstalled) {
                throw publicationFailure('REVIEW_TARGET_STALE', 'Current investigation authority ref changed during recovery.');
            }
            const candidate = paths.repositoryAbsolute(journal.paths.candidatePath);
            removeAbandonedCandidateTemporaries(paths.repositoryRoot, candidate);
            let source = fs.existsSync(candidate) ? candidate : null;
            if (source === null && fs.existsSync(paths.manifest)) {
                try {
                    assertManifestMatchesJournal(paths.manifest, journal, paths.repositoryRoot);
                    source = paths.manifest;
                }
                catch (error) {
                    if (desiredRefInstalled)
                        throw error;
                    // Before the ref switches, a revision-stable tracked path may still
                    // contain the prior authoritative Manifest. The journal owns the
                    // exact replacement bytes used to rebuild its candidate.
                }
            }
            if (desiredRefInstalled && source !== paths.manifest) {
                throw publicationFailure('RECONSTRUCTION_MISMATCH', 'Published authority cannot be reconstructed from pre-ref recovery bytes.');
            }
            const rawManifest = source === null
                ? journal.manifest
                : readJson(source, paths.repositoryRoot);
            const validated = validateForAuthority({
                repositoryRoot: input.repositoryRoot,
                manifest: rawManifest,
                expected: authorityExpected(journal.expected),
            });
            if (validated.outcome !== 'verified' ||
                validated.manifestDigest !== journal.manifestDigest ||
                validated.investigationTargetDigest !==
                    journal.investigationTargetDigest) {
                throw publicationFailure('RECONSTRUCTION_MISMATCH', 'Prepared publication Manifest no longer matches its journal.');
            }
            if (!desiredRefInstalled) {
                assertManifestTargetPreservesCurrentAuthority(paths.currentRef, journal.currentRef, paths.privateRoot);
            }
            if (source === null) {
                mutationPhase = 'candidate-written';
                writeCanonical(candidate, validated.manifest, paths.repositoryRoot, 0o644);
                input.observePhase?.('candidate-written');
            }
            if (source === candidate || source === null) {
                mutationPhase = 'manifest-installed';
                installCandidate(candidate, paths.manifest, journal, paths);
                input.observePhase?.('manifest-installed');
            }
            else {
                assertManifestMatchesJournal(paths.manifest, journal, paths.repositoryRoot);
            }
            if (desiredRefInstalled)
                mutationPhase = 'current-ref-published';
            if (!desiredRefInstalled) {
                mutationPhase = 'current-ref-published';
                if (publicationRefDigest(paths.privateRoot, input.paths.currentRefPath) !== journal.expected.currentRefDigest) {
                    throw publicationFailure('REVIEW_TARGET_STALE', 'Current investigation authority ref changed before recovery CAS publication.');
                }
                writeCanonical(paths.currentRef, journal.currentRef, paths.privateRoot);
                input.observePhase?.('current-ref-published');
            }
            mutationPhase = 'journal-committed';
            writeCanonical(paths.journal, { ...journal, state: 'committed' }, paths.privateRoot);
            input.observePhase?.('journal-committed');
            return publishedResult(journal);
        });
    }
    catch (error) {
        return publicationBlocked({
            repositoryRoot: input.repositoryRoot,
            privateRoot: input.privateRoot,
            lifecycle: input.lifecycle,
            source: { operation: 'resume', paths: input.paths },
            candidate: journal,
            mutationPhase,
            error,
        });
    }
}
export function readInvestigationPublicationRefState(input) {
    try {
        assertPublicationSourceLifecycleBinding({ operation: 'read-ref', currentRefPath: input.currentRefPath }, input.lifecycle);
        return {
            outcome: 'read',
            currentRefDigest: publicationRefDigest(input.privateRoot ?? input.repositoryRoot, input.currentRefPath),
        };
    }
    catch (error) {
        return publicationBlocked({
            repositoryRoot: input.repositoryRoot,
            privateRoot: input.privateRoot,
            lifecycle: input.lifecycle,
            source: { operation: 'read-ref', currentRefPath: input.currentRefPath },
            candidate: { currentRefPath: input.currentRefPath },
            error,
        });
    }
}
/**
 * Read the private current ref that authorizes one exact tracked Manifest.
 * Unlike the CAS snapshot reader above, this boundary rejects a missing,
 * malformed, or merely prior ref instead of returning a digest for it.
 */
export function readBoundInvestigationManifestPublicationRef(input) {
    try {
        const source = {
            operation: 'read-ref',
            currentRefPath: input.currentRefPath,
        };
        assertPublicationSourceLifecycleBinding(source, input.lifecycle);
        const privateRoot = fs.realpathSync(path.resolve(input.privateRoot ?? input.repositoryRoot));
        const observed = readStablePublicationFile(privateRoot, input.currentRefPath);
        if (observed === null) {
            throw publicationFailure('REVIEW_TARGET_STALE', 'Current investigation Manifest has no published private authority ref.');
        }
        let raw;
        try {
            raw = JSON.parse(observed.toString('utf8'));
        }
        catch {
            throw publicationFailure('MANIFEST_UNREPRESENTABLE', 'Investigation current ref is not JSON.');
        }
        if (observed.toString('utf8') !== `${canonicalJson(raw)}\n`) {
            throw publicationFailure('MANIFEST_UNREPRESENTABLE', 'Investigation current ref is not canonical JSON.');
        }
        const current = parseCurrentManifestRef(raw);
        const expected = {
            schemaVersion: 1,
            kind: 'investigation-manifest-current',
            repositoryId: input.lifecycle.repositoryId,
            changeId: input.lifecycle.changeId,
            investigationId: input.lifecycle.investigationId,
            manifestDigest: input.expected.manifestDigest,
            investigationTargetDigest: input.expected.investigationTargetDigest,
            manifestPath: input.expected.manifestPath,
        };
        if (canonicalJson(current) !== canonicalJson(expected)) {
            throw publicationFailure('REVIEW_TARGET_STALE', 'Private investigation current ref does not bind the tracked Manifest bytes.');
        }
        return {
            outcome: 'read',
            currentRefDigest: digest({
                schema: 'investigation-publication-ref-state.v1',
                exists: true,
                contentSha256: crypto
                    .createHash('sha256')
                    .update(observed)
                    .digest('hex'),
            }),
        };
    }
    catch (error) {
        return publicationBlocked({
            repositoryRoot: input.repositoryRoot,
            privateRoot: input.privateRoot,
            lifecycle: input.lifecycle,
            source: {
                operation: 'read-ref',
                currentRefPath: input.currentRefPath,
            },
            candidate: {
                currentRefPath: input.currentRefPath,
                expected: input.expected,
            },
            error,
        });
    }
}
