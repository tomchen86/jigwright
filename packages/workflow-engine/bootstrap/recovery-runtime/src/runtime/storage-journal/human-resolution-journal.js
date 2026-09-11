/**
 * Persists active and historical resolution journals, archives, and receipts.
 *
 * Invariants:
 * - Journal phase advancement and terminal archival retain their exact publication order.
 * - Lifecycle barriers and temporary cleanup reject ambiguous active journal state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertChangeId } from "../../foundation/repository-path/repository-path.js";
import { investigationResolutionStateDigest, } from "../../modules/investigation/domain/human-resolution-contract.js";
import { assertHumanResolutionJournal, humanResolutionJournalPhaseIndex, isTerminalHumanResolutionJournalPhase, } from "../../modules/investigation/domain/human-resolution-journal-contract.js";
import { assertPrivateFile, createPrivateCanonicalJson, fsyncDirectory, privatePathExists, readPrivateCanonicalJson, walkPrivateDirectory, writePrivateCanonicalJsonAtomic, } from "./investigation-private-files.js";
import { activeHumanResolutionJournalPath, humanResolutionArchiveUnsafe, humanResolutionJournalPath, humanResolutionPaths, humanResolutionReceiptUnsafe, humanResolutionRecoveryAmbiguous, humanResolutionStateInvalid, } from "./investigation-resolution-values.js";
import { humanResolutionJournalUnsafe } from "../../modules/investigation/domain/human-resolution-journal-contract.js";
import { assertHumanResolutionGrantId } from "../../modules/investigation/domain/human-resolution-values.js";
import { deepFreeze, hasExactKeys, isDigest, isRecord, sha256, } from "../../modules/investigation/domain/investigation-store-values.js";
export const ACTIVE_HUMAN_RESOLUTION_JOURNAL = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const ACTIVE_HUMAN_RESOLUTION_JOURNAL_TEMPORARY = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
export function writeHumanResolutionJournal(paths, journal) {
    const validated = assertHumanResolutionJournal(journal);
    const activePath = activeHumanResolutionJournalPath(paths, validated.target.changeId);
    const historicalPath = humanResolutionJournalPath(paths, validated.grantId);
    if (isTerminalHumanResolutionJournalPhase(validated.phase)) {
        const active = readActiveHumanResolutionJournal(paths, validated.target.changeId);
        if (active === null ||
            active.journalId !== validated.journalId ||
            active.grantId !== validated.grantId) {
            const historical = readHistoricalHumanResolutionJournal(paths, validated.grantId);
            if (historical !== null &&
                isTerminalHumanResolutionJournalPhase(historical.phase) &&
                historical.journalId === validated.journalId) {
                return;
            }
            throw humanResolutionRecoveryAmbiguous();
        }
        createPrivateCanonicalJson(paths, historicalPath, validated, humanResolutionJournalUnsafe, 'HUMAN_RESOLUTION_JOURNAL_COLLISION');
        fs.unlinkSync(activePath);
        fsyncDirectory(path.dirname(activePath));
        return;
    }
    const active = readActiveHumanResolutionJournal(paths, validated.target.changeId);
    if (active === null) {
        if (validated.phase !== 'prepared') {
            throw humanResolutionRecoveryAmbiguous();
        }
        createPrivateCanonicalJson(paths, activePath, validated, humanResolutionJournalUnsafe, 'HUMAN_RESOLUTION_ACTIVE_CONFLICT');
        return;
    }
    if (active.journalId !== validated.journalId ||
        active.grantId !== validated.grantId) {
        throw workflowError('HUMAN_RESOLUTION_RECOVERY_REQUIRED', 'Another human-resolution transaction must be recovered first.', ExitCode.conflict);
    }
    if (humanResolutionJournalPhaseIndex(validated.phase) <
        humanResolutionJournalPhaseIndex(active.phase)) {
        throw humanResolutionRecoveryAmbiguous();
    }
    writePrivateCanonicalJsonAtomic(paths, activePath, validated, humanResolutionJournalUnsafe);
}
export function readHumanResolutionJournal(paths, requestedGrantId) {
    const grantId = assertHumanResolutionGrantId(requestedGrantId);
    const historical = readHistoricalHumanResolutionJournal(paths, grantId);
    if (historical !== null) {
        return historical;
    }
    const active = scanActiveHumanResolutionJournalDirectory(paths);
    if (active === null) {
        return null;
    }
    let match = null;
    for (const name of active.journalNames) {
        const changeId = ACTIVE_HUMAN_RESOLUTION_JOURNAL.exec(name)?.[1];
        if (!changeId)
            throw humanResolutionJournalUnsafe();
        const candidate = readActiveHumanResolutionJournal(paths, changeId);
        if (candidate?.grantId !== grantId) {
            continue;
        }
        if (match !== null) {
            throw humanResolutionJournalUnsafe();
        }
        match = candidate;
    }
    return match;
}
export function readActiveHumanResolutionJournal(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const journalPath = activeHumanResolutionJournalPath(paths, changeId);
    if (!privatePathExists(paths, journalPath, humanResolutionJournalUnsafe)) {
        return null;
    }
    const journal = assertHumanResolutionJournal(readPrivateCanonicalJson(paths, journalPath, humanResolutionJournalUnsafe));
    if (journal.target.changeId !== changeId) {
        throw humanResolutionJournalUnsafe();
    }
    return journal;
}
function readHistoricalHumanResolutionJournal(paths, grantId) {
    const journalPath = humanResolutionJournalPath(paths, grantId);
    if (!privatePathExists(paths, journalPath, humanResolutionJournalUnsafe)) {
        return null;
    }
    const journal = assertHumanResolutionJournal(readPrivateCanonicalJson(paths, journalPath, humanResolutionJournalUnsafe));
    if (journal.grantId !== grantId ||
        !isTerminalHumanResolutionJournalPhase(journal.phase)) {
        throw humanResolutionJournalUnsafe();
    }
    return journal;
}
export function assertHumanResolutionLifecycleBarrier(runtimeRoot, allowedGrantId = null, allowedChangeId = null) {
    if ((allowedGrantId === null) !== (allowedChangeId === null)) {
        throw humanResolutionJournalUnsafe();
    }
    const paths = investigationPathsFromLifecycleRoot(runtimeRoot);
    if (paths === null) {
        return;
    }
    const scanned = scanActiveHumanResolutionJournalDirectory(paths);
    if (scanned === null) {
        return;
    }
    const active = scanned.journalNames.map((name) => {
        const match = ACTIVE_HUMAN_RESOLUTION_JOURNAL.exec(name);
        if (!match?.[1]) {
            throw humanResolutionJournalUnsafe();
        }
        const changeId = assertChangeId(match[1]);
        const journal = readActiveHumanResolutionJournal(paths, changeId);
        if (journal === null || journal.target.changeId !== changeId) {
            throw humanResolutionJournalUnsafe();
        }
        return journal;
    });
    if (active.length === 0 ||
        (allowedGrantId !== null &&
            allowedChangeId !== null &&
            active.length === 1 &&
            active[0]?.grantId === allowedGrantId &&
            active[0]?.target.changeId === allowedChangeId)) {
        return;
    }
    throw workflowError('HUMAN_RESOLUTION_RECOVERY_REQUIRED', 'An active human-resolution transaction blocks repository lifecycle changes.', ExitCode.conflict);
}
export function reclaimHumanResolutionJournalTemporaries(runtimeRoot, assertRepositoryLifecycleOwned) {
    assertRepositoryLifecycleOwned();
    const paths = investigationPathsFromLifecycleRoot(runtimeRoot);
    if (paths === null) {
        return;
    }
    const scanned = scanActiveHumanResolutionJournalDirectory(paths);
    if (scanned === null || scanned.temporaryPaths.length === 0) {
        return;
    }
    let removed = false;
    for (const temporaryPath of scanned.temporaryPaths) {
        assertRepositoryLifecycleOwned();
        const stats = fs.lstatSync(temporaryPath, { throwIfNoEntry: false });
        if (!stats) {
            continue;
        }
        assertPrivateFile(stats, humanResolutionJournalUnsafe);
        fs.unlinkSync(temporaryPath);
        removed = true;
    }
    if (removed) {
        fsyncDirectory(scanned.activeDirectory);
    }
    assertRepositoryLifecycleOwned();
}
function investigationPathsFromLifecycleRoot(runtimeRoot) {
    const resolvedRoot = path.resolve(runtimeRoot);
    const runtimeStats = fs.lstatSync(resolvedRoot, { throwIfNoEntry: false });
    if (!runtimeStats) {
        return null;
    }
    if (!runtimeStats.isDirectory() || runtimeStats.isSymbolicLink()) {
        throw humanResolutionJournalUnsafe();
    }
    const base = fs.realpathSync(resolvedRoot);
    const root = path.join(base, 'investigations');
    return {
        base,
        root,
        objects: path.join(root, 'objects', 'sha256'),
        refs: path.join(root, 'refs'),
        sessions: path.join(root, 'sessions'),
        invocations: path.join(root, 'invocations'),
        locks: path.join(root, 'locks'),
    };
}
export function scanActiveHumanResolutionJournalDirectory(paths) {
    const activeDirectory = humanResolutionPaths(paths).active;
    if (!walkPrivateDirectory(paths, activeDirectory, humanResolutionJournalUnsafe, false)) {
        return null;
    }
    const journalNames = [];
    const temporaryPaths = [];
    for (const name of fs.readdirSync(activeDirectory).sort()) {
        if (ACTIVE_HUMAN_RESOLUTION_JOURNAL.test(name)) {
            journalNames.push(name);
            continue;
        }
        if (!ACTIVE_HUMAN_RESOLUTION_JOURNAL_TEMPORARY.test(name)) {
            throw humanResolutionJournalUnsafe();
        }
        const temporaryPath = path.join(activeDirectory, name);
        const stats = fs.lstatSync(temporaryPath, { throwIfNoEntry: false });
        if (!stats) {
            continue;
        }
        assertPrivateFile(stats, humanResolutionJournalUnsafe);
        temporaryPaths.push(temporaryPath);
    }
    if (journalNames.length > 4096) {
        throw humanResolutionJournalUnsafe();
    }
    return { activeDirectory, journalNames, temporaryPaths };
}
export function writeHumanResolutionArchive(paths, currentStateDigest, state) {
    if (!isDigest(currentStateDigest) ||
        state.currentStateDigest !== currentStateDigest) {
        throw humanResolutionStateInvalid();
    }
    const archive = {
        schemaVersion: 1,
        kind: 'human-resolution-evidence-archive',
        currentStateDigest,
        state,
    };
    const archiveDigest = sha256(canonicalJson(archive));
    createPrivateCanonicalJson(paths, path.join(humanResolutionPaths(paths).archives, `${archiveDigest}.json`), archive, humanResolutionArchiveUnsafe, 'HUMAN_RESOLUTION_ARCHIVE_COLLISION');
    return archiveDigest;
}
export function readHumanResolutionArchive(paths, requestedArchiveDigest) {
    if (!isDigest(requestedArchiveDigest)) {
        throw humanResolutionArchiveUnsafe();
    }
    const value = readPrivateCanonicalJson(paths, path.join(humanResolutionPaths(paths).archives, `${requestedArchiveDigest}.json`), humanResolutionArchiveUnsafe);
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'currentStateDigest',
            'state',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'human-resolution-evidence-archive' ||
        !isDigest(value.currentStateDigest) ||
        !isRecord(value.state)) {
        throw humanResolutionArchiveUnsafe();
    }
    const archiveDigest = sha256(canonicalJson(value));
    const state = value.state;
    if (archiveDigest !== requestedArchiveDigest ||
        state.currentStateDigest !== value.currentStateDigest ||
        investigationResolutionStateDigest(state.envelope) !==
            state.currentStateDigest) {
        throw humanResolutionArchiveUnsafe();
    }
    return deepFreeze(structuredClone(state));
}
export function writeHumanResolutionReceipt(paths, requestedGrantId, receipt) {
    const grantId = assertHumanResolutionGrantId(requestedGrantId);
    const digest = sha256(canonicalJson(receipt));
    createPrivateCanonicalJson(paths, path.join(humanResolutionPaths(paths).receipts, `${grantId}.json`), receipt, humanResolutionReceiptUnsafe, 'HUMAN_RESOLUTION_RECEIPT_COLLISION');
    return digest;
}
