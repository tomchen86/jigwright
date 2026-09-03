/**
 * The built-in Work Registry: one canonical YAML record per Work Item, the
 * lifecycle inbox, backlog, active, closed, the lanes now, next, later and
 * icebox, reviewed intake and priority, promotion into a change origin, archive
 * reconciliation, and the deterministic backlog, inventory, history and handoff
 * projections.
 *
 * Invariants:
 * - Stage, lane and blockers are independent facts; the interpretation records
 *   whether it is agent-derived or maintainer-confirmed.
 * - Every mutation binds the exact current item digest and uses
 *   compare-and-swap; a retry converges on the same bytes and never overwrites
 *   a concurrent update.
 * - Projections are derived from canonical records and are never authority;
 *   validation rejects a drifted projection.
 * - Always available: a repository may hold zero items, and the registry cannot
 *   be configured off.
 *
 * Depends on: governance-intake.ts for Sources, the repository consumer
 * configuration, and the change origin under the change root.
 * Failure modes: an incoherent relation is rejected without moving or rewriting
 * the record; a stale expected digest fails the reviewed transition.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { GOVERNANCE_SOURCE_LEDGER_ROOT } from '@jigwright/core/repository-consumer-port';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { publishPreparedExclusiveLock, reclaimDeadPreparedLock, runGit, } from "../../runtime/repository-transaction/git.js";
import { repositoryConsumerConfigurationExists, repositoryConsumerPath, repositoryWorkRegistryConfiguration, } from "../repository-consumer/repository-consumer-config.js";
import { listGovernanceSources, readGovernanceSource, } from "./governance-intake.js";
const WORK_ITEM_FILE_MODE = 0o644;
const WORK_REGISTRY_PRIVATE_FILE_MODE = 0o600;
const WORK_REGISTRY_PRIVATE_DIRECTORY_MODE = 0o700;
const WORK_REGISTRY_PROMOTION_TRANSACTION_KIND = 'work-registry-promotion-transaction.v1';
const MAX_WORK_REGISTRY_PROMOTION_TRANSACTION_BYTES = 512 * 1024;
const activeWorkRegistryPromotionRoots = new Set();
class WorkRegistryPromotionCasMismatch extends Error {
}
export function createWorkItem(repositoryRoot, input, dependencies = {}) {
    const createdAt = canonicalTimestamp((dependencies.now ?? (() => new Date().toISOString()))());
    const id = workItemId((dependencies.createId ?? (() => createMonotonicWorkItemId(createdAt)))());
    const sourceRefs = sourceReferences(input.sourceRefs);
    const aliases = workItemAliases(dependencies.aliases ?? []);
    const existingAliases = new Set(listWorkItems(repositoryRoot).flatMap((item) => [item.id, ...item.aliases]));
    if (aliases.some((alias) => existingAliases.has(alias))) {
        throw registryInvalid('Work Item alias already exists.');
    }
    for (const sourceRef of sourceRefs) {
        readSource(repositoryRoot, sourceRef);
    }
    const item = {
        schemaVersion: 1,
        id,
        createdAt,
        kind: workItemKind(input.kind),
        stage: 'inbox',
        lane: workItemLane(input.lane),
        title: boundedText(input.title, 160, 'title'),
        interpretation: {
            summary: boundedText(input.summary, 2_000, 'summary'),
            status: 'agent-derived',
        },
        aliases,
        sourceRefs,
        blockedBy: [],
        changeRefs: [],
        timeline: [{ at: createdAt, event: 'created', changeId: null }],
        closure: null,
    };
    const year = createdAt.slice(0, 4);
    const relativePath = path.posix.join(repositoryWorkRegistryConfiguration(repositoryRoot).itemRoot, year, `${id}.yaml`);
    createCanonicalFile(path.join(repositoryRoot, ...relativePath.split('/')), item);
    return { item, relativePath };
}
export function createWorkItemAfterExactSourceTextRecheck(repositoryRoot, exactText, input, dependencies = {}) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
        const inputSources = sourceReferences(input.sourceRefs).map((sourceRef) => readSourceValue(repositoryRoot, sourceRef));
        if (!inputSources.some(({ text }) => text === exactText)) {
            throw registryInvalid('Work Item exact-wording recheck requires its captured Source.');
        }
        const matches = findWorkItemsByExactSourceText(repositoryRoot, exactText).filter(({ closure, stage }) => closure === null && stage !== 'closed');
        if (matches.length > 0)
            return { created: false, matches };
        return {
            created: true,
            ...createWorkItem(repositoryRoot, input, dependencies),
        };
    });
}
export function ensureFindingConversionWorkItem(repositoryRoot, requestedFindingId, input, createdAt) {
    if (!/^FND-[0-9a-f]{64}$/.test(requestedFindingId)) {
        throw registryInvalid('Governance Finding identity is invalid.');
    }
    const deterministicId = `WORK-${requestedFindingId
        .slice('FND-'.length, 'FND-'.length + 26)
        .toUpperCase()}`;
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
        const existing = listWorkItems(repositoryRoot).find(({ id }) => id === deterministicId);
        const ensured = createWorkItem(repositoryRoot, input, {
            now: () => createdAt,
            createId: () => deterministicId,
        });
        return { ...ensured, created: existing === undefined };
    });
}
export function attachSourceToWorkItem(repositoryRoot, requestedId, requestedSourceRef) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
        const id = workItemId(requestedId);
        const itemPath = findWorkItemPath(repositoryRoot, id);
        const item = readWorkItem(itemPath);
        if (item.closure !== null || item.stage === 'closed') {
            throw registryInvalid('A closed Work Item cannot receive a Source.');
        }
        const sourceRef = sourceReferences([requestedSourceRef])[0];
        readSource(repositoryRoot, sourceRef);
        const sourceRefs = sourceReferences([
            ...new Set([...item.sourceRefs, sourceRef]),
        ]);
        const next = {
            ...item,
            sourceRefs,
            interpretation: {
                summary: linkedSourceInterpretationSummary(sourceRefs),
                status: 'agent-derived',
            },
        };
        if (canonicalJson(next) === canonicalJson(item)) {
            return { item, updated: false };
        }
        replaceCanonicalFile(itemPath, next);
        return { item: next, updated: true };
    });
}
export function prepareWorkItemPromotionSurvey(repositoryRoot, requestedId, requestedChangeId, declaration) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => prepareWorkItemPromotionSurveyUnlocked(repositoryRoot, requestedId, requestedChangeId, declaration));
}
function prepareWorkItemPromotionSurveyUnlocked(repositoryRoot, requestedId, requestedChangeId, declaration) {
    const item = showWorkItem(repositoryRoot, requestedId);
    assertPromotionEligible(repositoryRoot, item);
    if (!workItemRequiresPromotionSurvey(repositoryRoot, item)) {
        throw registryInvalid('Promotion survey is only valid for an agent-authored premise.');
    }
    const changeId = changeIdentity(requestedChangeId);
    const changeDirectory = assertChangeDirectory(repositoryRoot, changeId);
    if (declaration.schemaVersion !== 1 ||
        !Array.isArray(declaration.symbols) ||
        declaration.symbols.some((symbol) => !isSurveySymbol(symbol)) ||
        new Set(declaration.symbols).size !== declaration.symbols.length ||
        (declaration.emptyReason !== null &&
            boundedText(declaration.emptyReason, 500, 'survey reason') !==
                declaration.emptyReason) ||
        (declaration.symbols.length === 0 && declaration.emptyReason === null) ||
        (declaration.symbols.length > 0 && declaration.emptyReason !== null)) {
        throw registryInvalid('Promotion survey declaration is invalid.');
    }
    const surveyedCommit = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{40,64}$/.test(surveyedCommit)) {
        throw registryInvalid('Promotion survey commit is invalid.');
    }
    const symbols = [...declaration.symbols].sort().map((symbol) => ({
        symbol,
        consumerPaths: listSymbolConsumers(repositoryRoot, surveyedCommit, symbol),
    }));
    const survey = {
        schemaVersion: 1,
        workItemId: item.id,
        changeId,
        surveyedCommit,
        symbols,
        emptyReason: declaration.emptyReason,
    };
    const surveyPath = path.join(changeDirectory, 'survey.json');
    replaceCanonicalFile(surveyPath, survey);
    return {
        survey,
        relativePath: path
            .relative(repositoryRoot, surveyPath)
            .replaceAll(path.sep, '/'),
    };
}
export function workItemDigest(item) {
    return `sha256:${crypto.createHash('sha256').update(canonicalJson(item)).digest('hex')}`;
}
export function workRegistryTransitionRequiresGrant(repositoryRoot, transition) {
    return (loadWorkRegistryTransitionPolicy(repositoryRoot).transitions[transition] ===
        'central-grant');
}
export function assertOrdinaryWorkRegistryTransition(repositoryRoot, transition, recovery, details) {
    if (!workRegistryTransitionRequiresGrant(repositoryRoot, transition))
        return;
    throw workflowError('WORK_REGISTRY_GRANT_REQUIRED', `Repository policy requires Central Grant for the ${transition} transition.`, ExitCode.guard, { recovery, ...(details === undefined ? {} : { details }) });
}
export function showWorkItem(repositoryRoot, requestedId) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => showWorkItemUnlocked(repositoryRoot, requestedId));
}
function showWorkItemUnlocked(repositoryRoot, requestedId) {
    if (!/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(requestedId) &&
        !/^ISS-[0-9]+$/.test(requestedId)) {
        throw registryInvalid('Work Item identity or alias is invalid.');
    }
    const matches = listWorkItemPaths(repositoryRoot)
        .map((itemPath) => readWorkItem(itemPath))
        .filter((item) => item.id === requestedId || item.aliases.includes(requestedId));
    if (matches.length !== 1) {
        throw registryInvalid('Work Item identity or alias must resolve to exactly one stable path.');
    }
    return matches[0];
}
export function applyWorkItemReview(repositoryRoot, requestedId, review, now = () => new Date().toISOString()) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => applyWorkItemReviewUnlocked(repositoryRoot, requestedId, review, now));
}
function applyWorkItemReviewUnlocked(repositoryRoot, requestedId, review, now) {
    const id = workItemId(requestedId);
    const itemPath = findWorkItemPath(repositoryRoot, id);
    const item = readWorkItem(itemPath);
    if (workItemDigest(item) !== exactDigest(review.expectedDigest)) {
        throw workflowError('WORK_REGISTRY_STALE', 'Work Item changed after the review was prepared.', ExitCode.conflict);
    }
    const at = canonicalTimestamp(now());
    let next;
    if (review.action === 'accept') {
        if (item.stage !== 'inbox' || item.closure !== null) {
            throw registryInvalid('Only an open inbox item can be accepted.');
        }
        next = {
            ...item,
            stage: 'backlog',
            interpretation: {
                summary: boundedText(review.summary, 2_000, 'summary'),
                status: 'maintainer-confirmed',
            },
            timeline: [...item.timeline, { at, event: 'accepted', changeId: null }],
        };
    }
    else if (review.action === 'prioritize') {
        if (item.stage !== 'backlog' || item.closure !== null) {
            throw registryInvalid('Only an open backlog item can be prioritized.');
        }
        const blockedBy = workItemReferences(review.blockedBy);
        if (blockedBy.includes(item.id)) {
            throw registryInvalid('A Work Item cannot block itself.');
        }
        for (const blocker of blockedBy)
            showWorkItem(repositoryRoot, blocker);
        assertNoProspectiveCycle(repositoryRoot, item.id, blockedBy);
        next = {
            ...item,
            lane: workItemLane(review.lane),
            blockedBy,
            timeline: [
                ...item.timeline,
                { at, event: 'prioritized', changeId: null },
            ],
        };
    }
    else {
        if (item.stage !== 'inbox' && item.stage !== 'backlog') {
            throw registryInvalid('Only an unpromoted Work Item can be declined.');
        }
        next = {
            ...item,
            stage: 'closed',
            closure: { at, outcome: review.outcome, changeId: null },
            timeline: [...item.timeline, { at, event: 'closed', changeId: null }],
        };
    }
    replaceCanonicalFile(itemPath, next);
    return next;
}
export function promoteWorkItem(repositoryRoot, requestedId, requestedChangeId, now = () => new Date().toISOString(), requestedExpectedDigest, testHooks = {}, grantBinding = null) {
    const id = workItemId(requestedId);
    const changeId = changeIdentity(requestedChangeId);
    return withWorkRegistryPromotionLock(repositoryRoot, (runtime) => {
        recoverWorkItemPromotionTransactionsUnlocked(runtime);
        const recovered = replayRecoveredWorkItemPromotion(runtime, id, changeId, requestedExpectedDigest, grantBinding);
        if (recovered !== null)
            return recovered;
        const itemPath = findWorkItemPath(repositoryRoot, id);
        const { item, serialized: itemBefore } = readWorkItemRecord(itemPath);
        if (requestedExpectedDigest !== undefined &&
            workItemDigest(item) !== exactDigest(requestedExpectedDigest)) {
            throw workflowError('WORK_REGISTRY_STALE', 'Work Item changed after promotion was prepared.', ExitCode.conflict);
        }
        assertPromotionEligible(repositoryRoot, item);
        const changeDirectory = assertChangeDirectory(repositoryRoot, changeId);
        const surveyBinding = observePromotionSurveyBinding(repositoryRoot, changeDirectory, item, changeId);
        if (grantBinding !== null &&
            canonicalJson(surveyBinding) !== canonicalJson(grantBinding.surveyBinding)) {
            throw promotionGrantStale('Work Registry promotion survey binding changed after Grant approval.');
        }
        const at = canonicalTimestamp(now());
        const promoted = {
            ...item,
            stage: 'active',
            changeRefs: [...new Set([...item.changeRefs, changeId])].sort(),
            timeline: [...item.timeline, { at, event: 'promoted', changeId }],
        };
        const originPath = path.join(changeDirectory, 'origin.json');
        const originBefore = readStablePromotionTarget(originPath, true)?.content ?? null;
        const origin = mergeOrigin(repositoryRoot, originBefore, promoted.sourceRefs, [promoted.id]);
        const requestedTransaction = createWorkItemPromotionTransaction(repositoryRoot, itemPath, originPath, itemBefore, originBefore, promoted, origin, grantBinding);
        const persisted = publishWorkItemPromotionTransaction(runtime, requestedTransaction);
        if (persisted.created)
            testHooks.afterJournalPersisted?.();
        try {
            applyWorkItemPromotionTransaction(runtime, persisted.transaction, testHooks);
        }
        catch (error) {
            markWorkItemPromotionRollback(runtime, persisted.transaction);
            abortWorkItemPromotionTransaction(runtime, persisted.transaction, testHooks);
            if (error instanceof WorkRegistryPromotionCasMismatch) {
                throw workRegistryTransactionConflict('Work Item promotion inputs changed before compare-and-swap.');
            }
            throw error;
        }
        if (persisted.transaction.grantBinding === null) {
            removeWorkItemPromotionJournal(runtime, persisted.transaction);
        }
        else {
            publishRecoveredWorkItemPromotion(runtime, persisted.transaction);
        }
        testHooks.afterTransactionCommitted?.();
        const committed = parsePromotionItemContent(persisted.transaction.after.itemContent);
        return {
            item: committed,
            originPath: path.join(repositoryRoot, ...persisted.transaction.originRelativePath.split('/')),
        };
    });
}
/**
 * Verifies an exact Grant-bound receipt without projecting historical bytes as
 * current state. The Grant coordinator separately observes the actual current
 * poststate after accepting this durable proof of the completed effect.
 */
export function hasExactWorkItemPromotionReceipt(repositoryRoot, requestedId, requestedChangeId, requestedExpectedDigest, grantBinding) {
    const id = workItemId(requestedId);
    const changeId = changeIdentity(requestedChangeId);
    const expectedDigest = exactDigest(requestedExpectedDigest);
    return withWorkRegistryPromotionLock(repositoryRoot, (runtime) => {
        recoverWorkItemPromotionTransactionsUnlocked(runtime);
        return (findExactRecoveredWorkItemPromotion(runtime, id, changeId, expectedDigest, grantBinding) !== null);
    });
}
export function hasExactCurrentWorkItemPromotion(repositoryRoot, requestedId, requestedChangeId) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
        const item = showWorkItemUnlocked(repositoryRoot, requestedId);
        const changeId = changeIdentity(requestedChangeId);
        if (item.stage !== 'active' ||
            item.closure !== null ||
            canonicalJson(item.changeRefs) !== canonicalJson([changeId])) {
            return false;
        }
        const changeDirectory = assertChangeDirectory(repositoryRoot, changeId);
        const originSource = readOptionalPlainFile(path.join(changeDirectory, 'origin.json'));
        if (originSource === null)
            return false;
        const origin = parseOrigin(originSource);
        return (item.sourceRefs.every((sourceRef) => origin.sourceRefs.includes(sourceRef)) && origin.workItemRefs.includes(item.id));
    });
}
export function ensureWorkItemPromotionSurveyBinding(repositoryRoot, requestedId, requestedChangeId) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => ensureWorkItemPromotionSurveyBindingUnlocked(repositoryRoot, requestedId, requestedChangeId));
}
export function ensureWorkItemPromotionChangeDirectory(repositoryRoot, requestedChangeId) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => ensureWorkItemPromotionChangeDirectoryUnlocked(repositoryRoot, changeIdentity(requestedChangeId)));
}
export function observeWorkItemPromotionPreparationBinding(repositoryRoot, requestedId, requestedChangeId) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => observeWorkItemPromotionPreparationBindingUnlocked(repositoryRoot, requestedId, requestedChangeId));
}
export function prepareWorkItemPromotionFromBinding(repositoryRoot, requestedId, requestedChangeId, expected) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
        const actual = observeWorkItemPromotionPreparationBindingUnlocked(repositoryRoot, requestedId, requestedChangeId);
        if (!promotionPreparationMatches(expected, actual)) {
            throw promotionGrantStale('Work Registry promotion preparation changed after authorization.');
        }
        const changeId = changeIdentity(requestedChangeId);
        const changeDirectory = ensureWorkItemPromotionChangeDirectoryUnlocked(repositoryRoot, changeId);
        if (expected.surveyPreparation.kind === 'create-current-survey') {
            const surveyPath = path.join(changeDirectory, 'survey.json');
            const existing = readOptionalPlainFile(surveyPath);
            const expectedBytes = `${canonicalJson(expected.surveyPreparation.survey)}\n`;
            if (existing === null) {
                replaceCanonicalFile(surveyPath, expected.surveyPreparation.survey);
            }
            else if (existing !== expectedBytes) {
                throw promotionGrantStale('Work Registry promotion survey changed after authorization.');
            }
        }
        const item = showWorkItemUnlocked(repositoryRoot, requestedId);
        return observePromotionSurveyBinding(repositoryRoot, changeDirectory, item, changeId);
    });
}
export function workItemPromotionPreparationMatches(expected, actual) {
    return promotionPreparationMatches(expected, actual);
}
function observeWorkItemPromotionPreparationBindingUnlocked(repositoryRoot, requestedId, requestedChangeId) {
    const item = showWorkItemUnlocked(repositoryRoot, requestedId);
    assertPromotionEligible(repositoryRoot, item);
    const changeId = changeIdentity(requestedChangeId);
    const sourceRefsDigest = promotionSourceRefsDigest(item);
    const changeDirectory = promotionChangeDirectory(repositoryRoot, changeId);
    const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
    if (stats !== undefined && (!stats.isDirectory() || stats.isSymbolicLink())) {
        throw registryInvalid('Promotion change directory is unsafe.');
    }
    const existingEntries = stats === undefined
        ? null
        : snapshotPromotionChangeEntries(changeDirectory);
    const stableStats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
    if ((stats === undefined) !== (stableStats === undefined) ||
        (stats !== undefined &&
            stableStats !== undefined &&
            (!stableStats.isDirectory() ||
                stableStats.isSymbolicLink() ||
                stats.dev !== stableStats.dev ||
                stats.ino !== stableStats.ino ||
                stats.mode !== stableStats.mode ||
                stats.mtimeMs !== stableStats.mtimeMs))) {
        throw registryInvalid('Promotion change directory changed during inspection.');
    }
    const originEntry = existingEntries?.find((entry) => entry.path === 'origin.json');
    if (originEntry?.kind === 'directory') {
        throw registryInvalid('Promotion change origin is unsafe.');
    }
    const changeTarget = stats === undefined
        ? { kind: 'absent-change' }
        : {
            kind: 'existing-change',
            directoryMode: stableStats.mode & 0o777,
            entries: existingEntries,
            originDigest: originEntry?.digest ?? null,
        };
    if (!workItemRequiresPromotionSurvey(repositoryRoot, item)) {
        return {
            schemaVersion: 1,
            changeTarget,
            sourceRefsDigest,
            surveyPreparation: {
                kind: 'not-required',
                binding: promotionNotRequiredBinding(item),
            },
        };
    }
    if (stats !== undefined) {
        const source = readOptionalPlainFile(path.join(changeDirectory, 'survey.json'));
        if (source !== null) {
            return {
                schemaVersion: 1,
                changeTarget,
                sourceRefsDigest,
                surveyPreparation: {
                    kind: 'current-survey',
                    binding: {
                        schemaVersion: 1,
                        kind: 'current-survey',
                        digest: assertPromotionSurveyCurrent(repositoryRoot, changeDirectory, item, changeId),
                    },
                },
            };
        }
    }
    const survey = projectEmptyPromotionSurvey(repositoryRoot, item, changeId);
    return {
        schemaVersion: 1,
        changeTarget,
        sourceRefsDigest,
        surveyPreparation: {
            kind: 'create-current-survey',
            binding: {
                schemaVersion: 1,
                kind: 'current-survey',
                digest: workRegistryTextDigest(`${canonicalJson(survey)}\n`),
            },
            survey,
        },
    };
}
function promotionPreparationMatches(expected, actual) {
    if (expected.schemaVersion !== actual.schemaVersion ||
        expected.sourceRefsDigest !== actual.sourceRefsDigest) {
        return false;
    }
    const exact = canonicalJson(expected) === canonicalJson(actual);
    if (exact)
        return true;
    if (expected.changeTarget.kind === 'existing-change' &&
        actual.changeTarget.kind === 'existing-change' &&
        expected.surveyPreparation.kind === 'create-current-survey' &&
        (actual.surveyPreparation.kind === 'create-current-survey' ||
            actual.surveyPreparation.kind === 'current-survey') &&
        expected.changeTarget.directoryMode === actual.changeTarget.directoryMode &&
        expected.changeTarget.originDigest === actual.changeTarget.originDigest &&
        canonicalJson(expected.surveyPreparation.binding) ===
            canonicalJson(actual.surveyPreparation.binding)) {
        const preparedEntries = [
            ...expected.changeTarget.entries,
            {
                path: 'survey.json',
                kind: 'file',
                mode: WORK_ITEM_FILE_MODE,
                digest: expected.surveyPreparation.binding.digest,
            },
        ].sort((left, right) => left.path.localeCompare(right.path));
        if (canonicalJson(actual.changeTarget.entries) ===
            canonicalJson(preparedEntries)) {
            return true;
        }
    }
    if (expected.changeTarget.kind !== 'absent-change' ||
        actual.changeTarget.kind !== 'existing-change' ||
        actual.changeTarget.directoryMode !== 0o755 ||
        actual.changeTarget.originDigest !== null) {
        return false;
    }
    if (expected.surveyPreparation.kind === 'not-required') {
        return (actual.changeTarget.entries.length === 0 &&
            actual.surveyPreparation.kind === 'not-required' &&
            canonicalJson(expected.surveyPreparation.binding) ===
                canonicalJson(actual.surveyPreparation.binding));
    }
    if (expected.surveyPreparation.kind !== 'create-current-survey')
        return false;
    const expectedSurveyEntry = {
        path: 'survey.json',
        kind: 'file',
        mode: WORK_ITEM_FILE_MODE,
        digest: expected.surveyPreparation.binding.digest,
    };
    if (canonicalJson(actual.changeTarget.entries) !== canonicalJson([]) &&
        canonicalJson(actual.changeTarget.entries) !==
            canonicalJson([expectedSurveyEntry])) {
        return false;
    }
    return ((actual.surveyPreparation.kind === 'create-current-survey' ||
        actual.surveyPreparation.kind === 'current-survey') &&
        canonicalJson(expected.surveyPreparation.binding) ===
            canonicalJson(actual.surveyPreparation.binding));
}
function snapshotPromotionChangeEntries(changeDirectory) {
    const entries = [];
    const visit = (directory, prefix) => {
        const beforeDirectory = fs.lstatSync(directory);
        if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) {
            throw registryInvalid('Promotion change entry is unsafe.');
        }
        const names = fs.readdirSync(directory).sort();
        for (const name of names) {
            const entryPath = path.join(directory, name);
            const relativePath = prefix ? `${prefix}/${name}` : name;
            const stats = fs.lstatSync(entryPath);
            if (stats.isSymbolicLink()) {
                throw registryInvalid('Promotion change entry is unsafe.');
            }
            if (stats.isDirectory()) {
                entries.push({
                    path: relativePath,
                    kind: 'directory',
                    mode: stats.mode & 0o777,
                });
                visit(entryPath, relativePath);
            }
            else if (stats.isFile()) {
                if (stats.nlink !== 1) {
                    throw registryInvalid('Promotion change entry is unsafe.');
                }
                entries.push({
                    path: relativePath,
                    kind: 'file',
                    mode: stats.mode & 0o777,
                    digest: stablePromotionFileDigest(entryPath, stats),
                });
            }
            else {
                throw registryInvalid('Promotion change entry is unsafe.');
            }
        }
        const afterDirectory = fs.lstatSync(directory);
        if (!afterDirectory.isDirectory() ||
            afterDirectory.isSymbolicLink() ||
            beforeDirectory.dev !== afterDirectory.dev ||
            beforeDirectory.ino !== afterDirectory.ino ||
            beforeDirectory.mode !== afterDirectory.mode ||
            beforeDirectory.mtimeMs !== afterDirectory.mtimeMs ||
            canonicalJson(fs.readdirSync(directory).sort()) !== canonicalJson(names)) {
            throw registryInvalid('Promotion change directory changed during inspection.');
        }
    };
    visit(changeDirectory, '');
    return entries.sort((left, right) => left.path.localeCompare(right.path));
}
function stablePromotionFileDigest(filePath, before) {
    const bytes = fs.readFileSync(filePath);
    const after = fs.lstatSync(filePath);
    if (!after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1 ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mode !== after.mode ||
        before.mtimeMs !== after.mtimeMs ||
        bytes.byteLength !== after.size) {
        throw registryInvalid('Promotion change entry changed during inspection.');
    }
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}
function projectEmptyPromotionSurvey(repositoryRoot, item, changeId) {
    const surveyedCommit = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{40,64}$/.test(surveyedCommit)) {
        throw registryInvalid('Promotion survey commit is invalid.');
    }
    return {
        schemaVersion: 1,
        workItemId: item.id,
        changeId,
        surveyedCommit,
        symbols: [],
        emptyReason: 'The agent-authored premise declares no structured repository symbols.',
    };
}
function promotionChangeDirectory(repositoryRoot, changeId) {
    return path.join(repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot), changeId);
}
function ensureWorkItemPromotionChangeDirectoryUnlocked(repositoryRoot, changeId) {
    const changeDirectory = promotionChangeDirectory(repositoryRoot, changeId);
    const parent = path.dirname(changeDirectory);
    const parentStats = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
        throw registryInvalid('Promotion change root is unsafe or unavailable.');
    }
    const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
    if (stats === undefined) {
        fs.mkdirSync(changeDirectory, { mode: 0o755 });
        fs.chmodSync(changeDirectory, 0o755);
    }
    else if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw registryInvalid('Promotion change directory is unsafe.');
    }
    return changeDirectory;
}
function promotionSourceRefsDigest(item) {
    return workRegistryTextDigest(canonicalJson({
        schemaVersion: 1,
        kind: 'work-registry-promotion-source-refs.v1',
        sourceRefs: item.sourceRefs,
    }));
}
function promotionNotRequiredBinding(item) {
    return {
        schemaVersion: 1,
        kind: 'not-required',
        reason: 'pure-maintainer-sources',
        sourceRefsDigest: promotionSourceRefsDigest(item),
    };
}
function ensureWorkItemPromotionSurveyBindingUnlocked(repositoryRoot, requestedId, requestedChangeId) {
    const item = showWorkItem(repositoryRoot, requestedId);
    assertPromotionEligible(repositoryRoot, item);
    const changeId = changeIdentity(requestedChangeId);
    const changeDirectory = assertChangeDirectory(repositoryRoot, changeId);
    if (workItemRequiresPromotionSurvey(repositoryRoot, item) &&
        readOptionalPlainFile(path.join(changeDirectory, 'survey.json')) === null) {
        prepareWorkItemPromotionSurveyUnlocked(repositoryRoot, item.id, changeId, {
            schemaVersion: 1,
            symbols: [],
            emptyReason: 'The agent-authored premise declares no structured repository symbols.',
        });
    }
    return observePromotionSurveyBinding(repositoryRoot, changeDirectory, item, changeId);
}
export function observeWorkItemPromotionSurveyBinding(repositoryRoot, requestedId, requestedChangeId) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => observeWorkItemPromotionSurveyBindingUnlocked(repositoryRoot, requestedId, requestedChangeId));
}
function observeWorkItemPromotionSurveyBindingUnlocked(repositoryRoot, requestedId, requestedChangeId) {
    const item = showWorkItem(repositoryRoot, requestedId);
    assertPromotionEligible(repositoryRoot, item);
    const changeId = changeIdentity(requestedChangeId);
    return observePromotionSurveyBinding(repositoryRoot, assertChangeDirectory(repositoryRoot, changeId), item, changeId);
}
export function readWorkItemPromotionSurveyBinding(repositoryRoot, requestedId, requestedChangeId) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
        const item = showWorkItem(repositoryRoot, requestedId);
        const changeId = changeIdentity(requestedChangeId);
        return observePromotionSurveyBinding(repositoryRoot, assertChangeDirectory(repositoryRoot, changeId), item, changeId);
    });
}
/**
 * Immediate work may cite an immutable Source without manufacturing a parking
 * Work Item. This only records provenance on an already-existing change; it
 * creates no planning, lifecycle, priority, or transition authority.
 */
export function linkSourceToChange(repositoryRoot, requestedSourceId, requestedChangeId) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => linkSourceToChangeUnlocked(repositoryRoot, requestedSourceId, requestedChangeId));
}
function linkSourceToChangeUnlocked(repositoryRoot, requestedSourceId, requestedChangeId) {
    const [sourceRef] = sourceReferences([requestedSourceId]);
    readSource(repositoryRoot, sourceRef);
    const changeId = changeIdentity(requestedChangeId);
    const changeDirectory = path.join(repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot), changeId);
    const changeStats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
    if (!changeStats?.isDirectory() || changeStats.isSymbolicLink()) {
        throw registryInvalid('Source linking requires an existing plain change directory.');
    }
    const originPath = path.join(changeDirectory, 'origin.json');
    const before = readOptionalPlainFile(originPath);
    const origin = mergeOrigin(repositoryRoot, before, [sourceRef], []);
    const content = `${canonicalJson(origin)}\n`;
    if (before === content) {
        return { origin, originPath, created: false };
    }
    replaceCanonicalFile(originPath, origin);
    return { origin, originPath, created: true };
}
export function listWorkItems(repositoryRoot) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => listWorkItemsUnlocked(repositoryRoot));
}
function listWorkItemsUnlocked(repositoryRoot) {
    return listWorkItemPathsUnlocked(repositoryRoot)
        .map((itemPath) => readWorkItem(itemPath))
        .sort((left, right) => left.id.localeCompare(right.id));
}
/**
 * Explain one transparent priority suggestion per Work Item. The recommendation
 * never mutates registry bytes and deliberately retains an explicit maintainer
 * lane unless an unresolved blocker makes starting the item unsafe.
 */
export function recommendWorkItemPriorities(repositoryRoot) {
    const items = listWorkItems(repositoryRoot);
    const byId = new Map(items.map((item) => [item.id, item]));
    return items.map((item) => {
        const unresolved = item.blockedBy.filter((blockerId) => byId.get(blockerId)?.stage !== 'closed');
        if (item.stage === 'inbox') {
            return {
                workItemId: item.id,
                currentLane: item.lane,
                suggestedLane: null,
                reasons: ['intake-review-required'],
            };
        }
        if (item.stage === 'closed') {
            return {
                workItemId: item.id,
                currentLane: item.lane,
                suggestedLane: item.lane,
                reasons: ['closed-item'],
            };
        }
        if (item.stage === 'active') {
            return {
                workItemId: item.id,
                currentLane: item.lane,
                suggestedLane: item.lane,
                reasons: ['active-change-retained'],
            };
        }
        if (unresolved.length > 0) {
            return {
                workItemId: item.id,
                currentLane: item.lane,
                suggestedLane: 'later',
                reasons: unresolved.map((blockerId) => `unresolved-blocker:${blockerId}`),
            };
        }
        return {
            workItemId: item.id,
            currentLane: item.lane,
            suggestedLane: item.lane ?? 'next',
            reasons: [
                item.lane === null
                    ? 'accepted-backlog-default'
                    : 'maintainer-lane-retained',
            ],
        };
    });
}
export function inspectWorkRegistry(repositoryRoot) {
    return withWorkRegistryPromotionReadLockWhenAvailable(repositoryRoot, () => inspectWorkRegistryUnlocked(repositoryRoot));
}
function inspectWorkRegistryUnlocked(repositoryRoot) {
    const validated = validateWorkRegistryUnlocked(repositoryRoot, {});
    const items = listWorkItemsUnlocked(repositoryRoot);
    const byId = new Map(items.map((item) => [item.id, item]));
    const stages = {
        inbox: 0,
        backlog: 0,
        active: 0,
        closed: 0,
    };
    const lanes = { now: 0, next: 0, later: 0, icebox: 0, unprioritized: 0 };
    for (const item of items) {
        stages[item.stage] += 1;
        lanes[item.lane ?? 'unprioritized'] += 1;
    }
    const isOpen = (item) => item.stage !== 'closed';
    return {
        schemaVersion: 1,
        itemCount: validated.itemCount,
        sourceCount: validated.sourceCount,
        items: items.map((item) => ({
            id: item.id,
            title: item.title,
            stage: item.stage,
            lane: item.lane,
            aliases: [...item.aliases],
            blockedBy: [...item.blockedBy],
        })),
        stages,
        lanes,
        currentItemIds: items
            .filter((item) => isOpen(item) && item.lane === 'now')
            .map((item) => item.id),
        blockedItemIds: items
            .filter((item) => isOpen(item) &&
            item.blockedBy.some((blockerId) => byId.get(blockerId)?.stage !== 'closed'))
            .map((item) => item.id),
    };
}
export function searchWorkItems(repositoryRoot, requestedQuery) {
    const query = boundedText(requestedQuery, 256, 'search query').toLowerCase();
    const sourceText = new Map();
    return listWorkItems(repositoryRoot).filter((item) => {
        const citedWording = item.sourceRefs.map((sourceRef) => {
            const cached = sourceText.get(sourceRef);
            if (cached !== undefined)
                return cached;
            const text = readSourceValue(repositoryRoot, sourceRef).text;
            sourceText.set(sourceRef, text);
            return text;
        });
        return [
            item.id,
            item.title,
            item.interpretation.summary,
            ...item.aliases,
            ...item.sourceRefs,
            ...item.changeRefs,
            ...citedWording,
        ].some((value) => value.toLowerCase().includes(query));
    });
}
export function findWorkItemsByExactSourceText(repositoryRoot, exactText) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => listWorkItems(repositoryRoot).filter((item) => item.sourceRefs.some((sourceRef) => readSourceValue(repositoryRoot, sourceRef).text === exactText)));
}
export function traceWorkItem(repositoryRoot, requestedId, testHooks = {}) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => traceWorkItemUnlocked(repositoryRoot, requestedId, testHooks));
}
function traceWorkItemUnlocked(repositoryRoot, requestedId, testHooks) {
    const item = showWorkItem(repositoryRoot, requestedId);
    testHooks.afterItemSnapshot?.();
    const origins = listOriginPaths(repositoryRoot)
        .filter((originPath) => parseOrigin(fs.readFileSync(originPath, 'utf8')).workItemRefs.includes(item.id))
        .map((originPath) => path.relative(repositoryRoot, originPath).replaceAll(path.sep, '/'))
        .sort();
    const sources = item.sourceRefs.map((sourceRef) => readSourceValue(repositoryRoot, sourceRef));
    return { item, origins, sources };
}
export function traceGovernanceSource(repositoryRoot, requestedSourceId) {
    return traceGovernanceSourceUnlocked(repositoryRoot, requestedSourceId);
}
function traceGovernanceSourceUnlocked(repositoryRoot, requestedSourceId) {
    const canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
    const source = readGovernanceSource(repositoryRoot, requestedSourceId);
    const supersedes = source.supersedes === null
        ? null
        : readGovernanceSource(repositoryRoot, source.supersedes);
    const supersededBy = listGovernanceSources(repositoryRoot)
        .filter((candidate) => candidate.supersedes === source.id)
        .sort((left, right) => left.id.localeCompare(right.id));
    const coreTrace = {
        source,
        supersedes,
        supersededBy,
        workItems: [],
        origins: [],
    };
    if (!repositoryConsumerConfigurationExists(repositoryRoot)) {
        return coreTrace;
    }
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
        const workItems = listWorkItems(repositoryRoot)
            .filter((item) => item.sourceRefs.includes(source.id))
            .map((item) => {
            for (const itemSourceRef of item.sourceRefs) {
                readSource(repositoryRoot, itemSourceRef);
            }
            return item;
        });
        const origins = listOriginPaths(repositoryRoot)
            .flatMap((originPath) => {
            const origin = parseOrigin(fs.readFileSync(originPath, 'utf8'));
            if (!origin.sourceRefs.includes(source.id))
                return [];
            for (const originSourceRef of origin.sourceRefs) {
                readSource(repositoryRoot, originSourceRef);
            }
            return [
                path
                    .relative(canonicalRepositoryRoot, originPath)
                    .replaceAll(path.sep, '/'),
            ];
        })
            .sort();
        return { source, supersedes, supersededBy, workItems, origins };
    });
}
export function renderWorkRegistry(repositoryRoot) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => renderWorkRegistryUnlocked(repositoryRoot));
}
function renderWorkRegistryUnlocked(repositoryRoot) {
    validateWorkRegistry(repositoryRoot);
    const items = listWorkItems(repositoryRoot);
    const registry = repositoryWorkRegistryConfiguration(repositoryRoot);
    const backlogPath = repositoryConsumerPath(repositoryRoot, registry.backlogPath);
    replaceTextFile(backlogPath, renderBacklogProjection(repositoryRoot, items));
    const inventoryPath = repositoryConsumerPath(repositoryRoot, registry.inventoryPath);
    replaceCanonicalFile(inventoryPath, inspectWorkRegistry(repositoryRoot));
    const historyPaths = [...closedWorkItemsByYear(items).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([year, closed]) => {
        const historyPath = path.join(repositoryConsumerPath(repositoryRoot, registry.historyRoot), `${year}.md`);
        replaceTextFile(historyPath, renderHistoryProjection(year, closed));
        return historyPath;
    });
    return { backlogPath, inventoryPath, historyPaths };
}
/**
 * Verify deterministic registry views after a consumer has activated them.
 * A consumer may omit generated Markdown entirely; once any projection exists,
 * the whole current projection set must be complete and byte-current.
 */
export function validateWorkRegistryProjections(repositoryRoot) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => validateWorkRegistryProjectionsUnlocked(repositoryRoot));
}
function validateWorkRegistryProjectionsUnlocked(repositoryRoot) {
    validateWorkRegistry(repositoryRoot);
    const registry = repositoryWorkRegistryConfiguration(repositoryRoot);
    const backlogPath = repositoryConsumerPath(repositoryRoot, registry.backlogPath);
    const inventoryPath = repositoryConsumerPath(repositoryRoot, registry.inventoryPath);
    const historyRoot = repositoryConsumerPath(repositoryRoot, registry.historyRoot);
    const historyStats = fs.lstatSync(historyRoot, { throwIfNoEntry: false });
    const activated = fs.existsSync(backlogPath) ||
        fs.existsSync(inventoryPath) ||
        historyStats !== undefined;
    if (!activated)
        return { projectionCount: 0 };
    if (historyStats !== undefined &&
        (!historyStats.isDirectory() || historyStats.isSymbolicLink())) {
        throw projectionDrift('Work Registry history root is unsafe.');
    }
    const items = listWorkItems(repositoryRoot);
    const expected = new Map([
        [backlogPath, renderBacklogProjection(repositoryRoot, items)],
        [inventoryPath, `${canonicalJson(inspectWorkRegistry(repositoryRoot))}\n`],
    ]);
    for (const [year, closed] of closedWorkItemsByYear(items)) {
        expected.set(path.join(historyRoot, `${year}.md`), renderHistoryProjection(year, closed));
    }
    const actualHistoryPaths = historyStats === undefined
        ? []
        : fs.readdirSync(historyRoot, { withFileTypes: true }).map((entry) => {
            if (!entry.isFile() ||
                entry.isSymbolicLink() ||
                !/^\d{4}\.md$/.test(entry.name)) {
                throw projectionDrift('Work Registry history contains an unexpected path.');
            }
            return path.join(historyRoot, entry.name);
        });
    const expectedHistoryPaths = [...expected.keys()].filter((filePath) => filePath.startsWith(`${historyRoot}${path.sep}`));
    if (actualHistoryPaths.length !== expectedHistoryPaths.length ||
        actualHistoryPaths.some((filePath) => !expected.has(filePath))) {
        throw projectionDrift('Work Registry history projection is stale.');
    }
    for (const [filePath, content] of expected) {
        if (readOptionalPlainFile(filePath) !== content) {
            throw projectionDrift(`Work Registry projection is stale: ${path.relative(repositoryRoot, filePath).replaceAll(path.sep, '/')}`);
        }
    }
    return { projectionCount: expected.size };
}
/**
 * Project Work Registry delivery into the same disposable tree as the public
 * OpenSpec archive. The caller supplies a timestamp derived from the immutable
 * archive parent so the projection can be replayed independently in CI.
 */
export function reconcileArchivedWorkItems(repositoryRoot, requestedChangeId, archivedChangeRoot, requestedClosedAt) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => reconcileArchivedWorkItemsUnlocked(repositoryRoot, requestedChangeId, archivedChangeRoot, requestedClosedAt));
}
function reconcileArchivedWorkItemsUnlocked(repositoryRoot, requestedChangeId, archivedChangeRoot, requestedClosedAt) {
    const changeId = changeIdentity(requestedChangeId);
    const closedAt = canonicalTimestamp(requestedClosedAt);
    const workRegistry = repositoryWorkRegistryConfiguration(repositoryRoot);
    const changeOriginRoot = workRegistry.changeOriginRoot;
    if (!new RegExp(`^${escapeRegExp(changeOriginRoot)}/archive/\\d{4}-\\d{2}-\\d{2}-${changeId}$`).test(archivedChangeRoot)) {
        throw registryInvalid('Archived change root is invalid.');
    }
    const originPath = path.join(repositoryRoot, ...archivedChangeRoot.split('/'), 'origin.json');
    const originText = readOptionalPlainFile(originPath);
    if (originText === null) {
        return { closedItemIds: [], outputPaths: [] };
    }
    const origin = parseOrigin(originText);
    if (origin.workItemRefs.length === 0) {
        return { closedItemIds: [], outputPaths: [] };
    }
    validateWorkRegistry(repositoryRoot);
    const itemPaths = origin.workItemRefs.map((workItemRef) => {
        const itemPath = findWorkItemPath(repositoryRoot, workItemRef);
        const item = readWorkItem(itemPath);
        if (item.stage !== 'active' ||
            item.closure !== null ||
            !item.changeRefs.includes(changeId)) {
            throw registryInvalid('Archived change must reference an active, bidirectionally linked Work Item.');
        }
        const closed = {
            ...item,
            stage: 'closed',
            timeline: [...item.timeline, { at: closedAt, event: 'closed', changeId }],
            closure: { at: closedAt, outcome: 'delivered', changeId },
        };
        replaceCanonicalFile(itemPath, closed);
        return itemPath;
    });
    const rendered = renderWorkRegistry(repositoryRoot);
    const historyPath = path.join(repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).historyRoot), `${closedAt.slice(0, 4)}.md`);
    if (!rendered.historyPaths.includes(historyPath)) {
        throw registryInvalid('Archived Work Item history was not rendered.');
    }
    validateWorkRegistry(repositoryRoot);
    return {
        closedItemIds: [...origin.workItemRefs],
        outputPaths: [
            ...itemPaths,
            rendered.backlogPath,
            rendered.inventoryPath,
            historyPath,
        ]
            .map((outputPath) => path.relative(repositoryRoot, outputPath).replaceAll(path.sep, '/'))
            .sort(),
    };
}
export function validateWorkRegistry(repositoryRoot, testHooks = {}) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => validateWorkRegistryUnlocked(repositoryRoot, testHooks));
}
function validateWorkRegistryUnlocked(repositoryRoot, testHooks) {
    const sourceIds = new Set();
    const sources = listGovernanceSources(repositoryRoot);
    for (const source of sources) {
        if (sourceIds.has(source.id)) {
            throw registryInvalid('Governance Source identity is duplicated.');
        }
        sourceIds.add(source.id);
    }
    for (const source of sources) {
        if (source.supersedes !== null && !sourceIds.has(source.supersedes)) {
            throw registryInvalid('Governance Source supersedes a missing Source.');
        }
    }
    const itemIds = new Set();
    const items = listWorkItemsUnlocked(repositoryRoot);
    for (const item of items) {
        if (itemIds.has(item.id)) {
            throw registryInvalid('Work Item identity is duplicated.');
        }
        itemIds.add(item.id);
        for (const sourceRef of item.sourceRefs) {
            if (!sourceIds.has(sourceRef)) {
                throw registryInvalid('Work Item references a missing Source.');
            }
        }
    }
    for (const item of items) {
        for (const blocker of item.blockedBy) {
            if (!itemIds.has(blocker)) {
                throw registryInvalid('Work Item references a missing blocker.');
            }
        }
    }
    assertNoCycles(items);
    testHooks.afterItemSnapshot?.();
    for (const originPath of listOriginPaths(repositoryRoot)) {
        const origin = parseOrigin(fs.readFileSync(originPath, 'utf8'));
        const changeId = originChangeId(repositoryRoot, originPath);
        for (const sourceRef of origin.sourceRefs) {
            if (!sourceIds.has(sourceRef)) {
                throw registryInvalid('Change origin references a missing Source.');
            }
        }
        for (const workItemRef of origin.workItemRefs) {
            if (!itemIds.has(workItemRef)) {
                throw registryInvalid('Change origin references a missing Work Item.');
            }
            const item = items.find((candidate) => candidate.id === workItemRef);
            if (!item.changeRefs.includes(changeId)) {
                throw registryInvalid('Change origin and Work Item links differ.');
            }
        }
    }
    for (const item of items) {
        for (const changeRef of item.changeRefs) {
            const originPath = findOriginForChange(repositoryRoot, changeRef);
            const origin = parseOrigin(fs.readFileSync(originPath, 'utf8'));
            if (!origin.workItemRefs.includes(item.id)) {
                throw registryInvalid('Work Item and change origin links differ.');
            }
        }
    }
    return { itemCount: itemIds.size, sourceCount: sourceIds.size };
}
/**
 * Validate a current change origin when present through the same citation and
 * bidirectional-link validation used by the public registry validator. The
 * current planning contract calls this boundary for both its live checkout and
 * its immutable detached-worktree replay.
 */
export function validateCurrentChangeOrigin(repositoryRoot, requestedChangeId) {
    readCurrentChangeOrigin(repositoryRoot, requestedChangeId);
}
export function readCurrentChangeOrigin(repositoryRoot, requestedChangeId) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => readCurrentChangeOriginUnlocked(repositoryRoot, requestedChangeId));
}
function readCurrentChangeOriginUnlocked(repositoryRoot, requestedChangeId) {
    const configuration = repositoryWorkRegistryConfiguration(repositoryRoot);
    const changeId = changeIdentity(requestedChangeId);
    const originPath = path.join(repositoryConsumerPath(repositoryRoot, configuration.changeOriginRoot), changeId, 'origin.json');
    const source = readOptionalPlainFile(originPath);
    if (source === null)
        return null;
    const origin = parseOrigin(source);
    validateWorkRegistry(repositoryRoot);
    return origin;
}
function parseWorkItem(value) {
    if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) {
        throw registryInvalid('Work Item is invalid.');
    }
    const item = value;
    if (item.schemaVersion !== 1 ||
        !/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(item.id) ||
        canonicalTimestamp(item.createdAt) !== item.createdAt ||
        workItemKind(item.kind) !== item.kind ||
        !['inbox', 'backlog', 'active', 'closed'].includes(item.stage) ||
        workItemLane(item.lane) !== item.lane ||
        boundedText(item.title, 160, 'title') !== item.title ||
        !isRecord(item.interpretation) ||
        !hasExactKeys(item.interpretation, ['status', 'summary']) ||
        boundedText(item.interpretation.summary, 2_000, 'summary') !==
            item.interpretation.summary ||
        !['agent-derived', 'maintainer-confirmed'].includes(item.interpretation.status) ||
        !Array.isArray(item.aliases) ||
        !item.aliases.every((alias) => typeof alias === 'string' &&
            /^(?:ISS-[0-9]+|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(alias)) ||
        new Set(item.aliases).size !== item.aliases.length ||
        !isClosure(item.closure)) {
        throw registryInvalid('Work Item is invalid.');
    }
    const canonicalAliases = [...item.aliases].sort();
    const canonicalSourceRefs = sourceReferences(item.sourceRefs);
    if (!Array.isArray(item.blockedBy) ||
        !item.blockedBy.every((entry) => /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(entry)) ||
        !Array.isArray(item.changeRefs) ||
        !item.changeRefs.every((entry) => changeIdentity(entry) === entry) ||
        !Array.isArray(item.timeline) ||
        item.timeline.length < 1 ||
        !item.timeline.every(isTimelineEntry)) {
        throw registryInvalid('Work Item relations are invalid.');
    }
    const canonicalBlockedBy = workItemReferences(item.blockedBy);
    const canonicalChangeRefs = [...new Set(item.changeRefs)].sort();
    if (JSON.stringify(item.aliases) !== JSON.stringify(canonicalAliases) ||
        JSON.stringify(item.sourceRefs) !== JSON.stringify(canonicalSourceRefs) ||
        JSON.stringify(item.blockedBy) !== JSON.stringify(canonicalBlockedBy) ||
        canonicalChangeRefs.length !== item.changeRefs.length ||
        JSON.stringify(item.changeRefs) !== JSON.stringify(canonicalChangeRefs) ||
        !hasCoherentWorkItemLifecycle(item)) {
        throw registryInvalid('Work Item relations are invalid.');
    }
    return item;
}
function readWorkItem(itemPath) {
    return readWorkItemRecord(itemPath).item;
}
function readWorkItemRecord(itemPath) {
    const bytes = readPlainWorkItemBytes(itemPath);
    let serialized;
    let value;
    try {
        serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        value = JSON.parse(serialized);
    }
    catch {
        throw registryInvalid('Work Item is invalid.');
    }
    const item = parseWorkItem(value);
    if (path.basename(itemPath) !== `${item.id}.yaml` ||
        path.basename(path.dirname(itemPath)) !== item.createdAt.slice(0, 4) ||
        !bytes.equals(Buffer.from(`${canonicalJson(item)}\n`, 'utf8'))) {
        throw registryInvalid('Work Item path and identity differ.');
    }
    return { item, serialized };
}
function readPlainWorkItemBytes(itemPath) {
    let before;
    try {
        before = fs.lstatSync(itemPath, {
            bigint: true,
            throwIfNoEntry: false,
        });
    }
    catch {
        throw registryInvalid('Work Item path is unsafe.');
    }
    if (before === undefined || !isSafeWorkItemFile(before)) {
        throw registryInvalid('Work Item path is unsafe.');
    }
    let descriptor;
    try {
        descriptor = fs.openSync(itemPath, fs.constants.O_RDONLY |
            (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
        const openedBefore = fs.fstatSync(descriptor, { bigint: true });
        if (!isSafeWorkItemFile(openedBefore) ||
            !sameWorkItemFileSnapshot(before, openedBefore)) {
            throw new Error('Work Item changed before descriptor admission.');
        }
        const bytes = fs.readFileSync(descriptor);
        const openedAfter = fs.fstatSync(descriptor, { bigint: true });
        const after = fs.lstatSync(itemPath, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (after === undefined ||
            !isSafeWorkItemFile(openedAfter) ||
            !isSafeWorkItemFile(after) ||
            BigInt(bytes.byteLength) !== openedBefore.size ||
            !sameWorkItemFileSnapshot(openedBefore, openedAfter) ||
            !sameWorkItemFileSnapshot(openedAfter, after)) {
            throw new Error('Work Item changed while it was read.');
        }
        return bytes;
    }
    catch {
        throw registryInvalid('Work Item path could not be read safely.');
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function isSafeWorkItemFile(stats) {
    return (stats.isFile() &&
        !stats.isSymbolicLink() &&
        stats.nlink === 1n &&
        (process.platform === 'win32' ||
            (stats.mode & 511n) === BigInt(WORK_ITEM_FILE_MODE)) &&
        (typeof process.getuid !== 'function' ||
            stats.uid === BigInt(process.getuid())));
}
function sameWorkItemFileSnapshot(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.uid === right.uid &&
        left.gid === right.gid &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs);
}
function hasCoherentWorkItemLifecycle(item) {
    const first = item.timeline[0];
    const last = item.timeline.at(-1);
    const promoted = item.timeline.filter(({ event }) => event === 'promoted');
    if (first.event !== 'created' ||
        first.at !== item.createdAt ||
        first.changeId !== null ||
        item.timeline.filter(({ event }) => event === 'created').length !== 1) {
        return false;
    }
    let observedStage = 'inbox';
    for (const entry of item.timeline.slice(1)) {
        if (entry.event === 'accepted' &&
            observedStage === 'inbox' &&
            entry.changeId === null) {
            observedStage = 'backlog';
        }
        else if (entry.event === 'prioritized' &&
            observedStage === 'backlog' &&
            entry.changeId === null) {
            continue;
        }
        else if (entry.event === 'promoted' &&
            observedStage === 'backlog' &&
            entry.changeId !== null) {
            observedStage = 'active';
        }
        else if (entry.event === 'closed' && observedStage !== 'closed') {
            observedStage = 'closed';
        }
        else {
            return false;
        }
    }
    if (observedStage !== item.stage)
        return false;
    if (observedStage !== 'closed') {
        if (item.closure !== null)
            return false;
        if (observedStage !== 'active')
            return item.changeRefs.length === 0;
        return (promoted.length === 1 &&
            last.event === 'promoted' &&
            last.changeId !== null &&
            item.changeRefs.length === 1 &&
            item.changeRefs[0] === last.changeId);
    }
    if (item.closure === null ||
        last.event !== 'closed' ||
        last.at !== item.closure.at ||
        last.changeId !== item.closure.changeId) {
        return false;
    }
    if (item.closure.outcome === 'delivered') {
        return (item.closure.changeId !== null &&
            promoted.length === 1 &&
            promoted[0].changeId === item.closure.changeId &&
            item.changeRefs.length === 1 &&
            item.changeRefs[0] === item.closure.changeId);
    }
    return (item.closure.changeId === null &&
        promoted.length === 0 &&
        item.changeRefs.length === 0);
}
function isTimelineEntry(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['at', 'changeId', 'event']) &&
        typeof value.at === 'string' &&
        canonicalTimestamp(value.at) === value.at &&
        ['created', 'accepted', 'prioritized', 'promoted', 'closed'].includes(String(value.event)) &&
        (value.changeId === null ||
            (typeof value.changeId === 'string' &&
                changeIdentity(value.changeId) === value.changeId)));
}
const ITEM_KEYS = [
    'aliases',
    'blockedBy',
    'changeRefs',
    'closure',
    'createdAt',
    'id',
    'interpretation',
    'kind',
    'lane',
    'schemaVersion',
    'sourceRefs',
    'stage',
    'timeline',
    'title',
];
function isClosure(value) {
    return (value === null ||
        (isRecord(value) &&
            hasExactKeys(value, ['at', 'changeId', 'outcome']) &&
            typeof value.at === 'string' &&
            canonicalTimestamp(value.at) === value.at &&
            ['delivered', 'declined', 'duplicate', 'obsolete'].includes(String(value.outcome)) &&
            (value.changeId === null ||
                (typeof value.changeId === 'string' &&
                    changeIdentity(value.changeId) === value.changeId))));
}
function mergeOrigin(repositoryRoot, existingText, sourceRefs, workItemRefs) {
    let existing = {
        schemaVersion: 1,
        sourceRefs: [],
        workItemRefs: [],
    };
    if (existingText !== null) {
        const value = JSON.parse(existingText);
        if (!isRecord(value) || !hasExactKeys(value, ORIGIN_KEYS)) {
            throw registryInvalid('Change origin is invalid.');
        }
        if (value.schemaVersion !== 1 ||
            !Array.isArray(value.sourceRefs) ||
            !Array.isArray(value.workItemRefs) ||
            !value.sourceRefs.every((entry) => typeof entry === 'string') ||
            !value.workItemRefs.every((entry) => typeof entry === 'string')) {
            throw registryInvalid('Change origin is invalid.');
        }
        existing = value;
    }
    const merged = {
        schemaVersion: 1,
        sourceRefs: [...new Set([...existing.sourceRefs, ...sourceRefs])].sort(),
        workItemRefs: [
            ...new Set([...existing.workItemRefs, ...workItemRefs]),
        ].sort(),
    };
    for (const sourceRef of merged.sourceRefs) {
        readSource(repositoryRoot, sourceRef);
    }
    return merged;
}
function parseOrigin(existingText) {
    let value;
    try {
        value = JSON.parse(existingText);
    }
    catch {
        throw registryInvalid('Change origin is invalid.');
    }
    if (!isRecord(value) ||
        !hasExactKeys(value, ORIGIN_KEYS) ||
        value.schemaVersion !== 1 ||
        !Array.isArray(value.sourceRefs) ||
        !Array.isArray(value.workItemRefs) ||
        !value.sourceRefs.every((entry) => typeof entry === 'string' && /^SRC-[0-9a-f]{64}$/.test(entry)) ||
        !value.workItemRefs.every((entry) => typeof entry === 'string' &&
            /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(entry))) {
        throw registryInvalid('Change origin is invalid.');
    }
    const origin = value;
    const canonicalSourceRefs = sourceReferences(origin.sourceRefs);
    const canonicalWorkItemRefs = workItemReferences(origin.workItemRefs);
    if (JSON.stringify(origin.sourceRefs) !== JSON.stringify(canonicalSourceRefs) ||
        JSON.stringify(origin.workItemRefs) !==
            JSON.stringify(canonicalWorkItemRefs) ||
        existingText !== `${canonicalJson(origin)}\n`) {
        throw registryInvalid('Change origin is invalid.');
    }
    return origin;
}
const ORIGIN_KEYS = ['schemaVersion', 'sourceRefs', 'workItemRefs'];
function listWorkItemPaths(repositoryRoot) {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => listWorkItemPathsUnlocked(repositoryRoot));
}
function listWorkItemPathsUnlocked(repositoryRoot) {
    const itemsRoot = repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).itemRoot);
    const rootStats = fs.lstatSync(itemsRoot, { throwIfNoEntry: false });
    if (!rootStats)
        return [];
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw registryInvalid('Work Registry item root is unsafe.');
    }
    const itemPaths = [];
    for (const entry of fs.readdirSync(itemsRoot, { withFileTypes: true })) {
        const yearRoot = path.join(itemsRoot, entry.name);
        const yearStats = fs.lstatSync(yearRoot);
        if (entry.isSymbolicLink() ||
            !entry.isDirectory() ||
            !yearStats.isDirectory() ||
            yearStats.isSymbolicLink() ||
            !/^\d{4}$/.test(entry.name)) {
            throw registryInvalid('Work Registry year entry is unsafe or invalid.');
        }
        for (const item of fs.readdirSync(yearRoot, { withFileTypes: true })) {
            const itemPath = path.join(yearRoot, item.name);
            const itemStats = fs.lstatSync(itemPath);
            if (item.isSymbolicLink() ||
                !item.isFile() ||
                !itemStats.isFile() ||
                itemStats.isSymbolicLink() ||
                !/^WORK-[0-9A-HJKMNP-TV-Z]{26}\.yaml$/.test(item.name)) {
                throw registryInvalid('Work Registry item entry is unsafe or invalid.');
            }
            itemPaths.push(itemPath);
        }
    }
    return itemPaths.sort();
}
function readSource(repositoryRoot, sourceRef) {
    readSourceValue(repositoryRoot, sourceRef);
}
function findWorkItemPath(repositoryRoot, id) {
    const matches = listWorkItemPaths(repositoryRoot).filter((itemPath) => path.basename(itemPath, '.yaml') === id);
    if (matches.length !== 1) {
        throw registryInvalid('Work Item must resolve to exactly one stable path.');
    }
    return matches[0];
}
function assertChangeDirectory(repositoryRoot, changeId) {
    const changeDirectory = path.join(repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot), changeId);
    const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
        throw registryInvalid('Promotion requires an existing plain change directory.');
    }
    return changeDirectory;
}
function isSurveySymbol(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        Buffer.byteLength(value, 'utf8') <= 200 &&
        !/[\0\r\n]/u.test(value));
}
function listSymbolConsumers(repositoryRoot, commit, symbol) {
    const output = runGit(repositoryRoot, ['grep', '-l', '-z', '-F', '-e', symbol, commit, '--', '.'], true);
    const prefix = `${commit}:`;
    return output
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
        if (!entry.startsWith(prefix)) {
            throw registryInvalid('Promotion survey returned an invalid consumer path.');
        }
        const relativePath = entry.slice(prefix.length);
        if (path.isAbsolute(relativePath) ||
            path.posix.normalize(relativePath) !== relativePath ||
            relativePath.startsWith('../') ||
            relativePath.includes('\\')) {
            throw registryInvalid('Promotion survey consumer path is invalid.');
        }
        return relativePath;
    })
        .sort();
}
function assertPromotionSurveyCurrent(repositoryRoot, changeDirectory, item, changeId) {
    const surveyPath = path.join(changeDirectory, 'survey.json');
    const source = readOptionalPlainFile(surveyPath);
    if (source === null) {
        throw promotionSurveyRequired('Promotion requires a current premise survey.');
    }
    const survey = parsePromotionSurvey(source);
    if (survey.workItemId !== item.id || survey.changeId !== changeId) {
        throw registryInvalid('Promotion survey is invalid.');
    }
    const currentHead = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    if (survey.surveyedCommit !== currentHead) {
        throw promotionSurveyRequired('Promotion survey is stale for the current repository head.');
    }
    const currentSymbols = survey.symbols.map(({ symbol }) => ({
        symbol,
        consumerPaths: listSymbolConsumers(repositoryRoot, survey.surveyedCommit, symbol),
    }));
    if (canonicalJson(survey.symbols) !== canonicalJson(currentSymbols)) {
        throw promotionSurveyRequired('Promotion survey consumer facts do not match the surveyed Git commit.');
    }
    return workRegistryTextDigest(source);
}
function observePromotionSurveyBinding(repositoryRoot, changeDirectory, item, changeId) {
    if (!workItemRequiresPromotionSurvey(repositoryRoot, item)) {
        return {
            schemaVersion: 1,
            kind: 'not-required',
            reason: 'pure-maintainer-sources',
            sourceRefsDigest: workRegistryTextDigest(canonicalJson({
                schemaVersion: 1,
                kind: 'work-registry-promotion-source-refs.v1',
                sourceRefs: item.sourceRefs,
            })),
        };
    }
    return {
        schemaVersion: 1,
        kind: 'current-survey',
        digest: assertPromotionSurveyCurrent(repositoryRoot, changeDirectory, item, changeId),
    };
}
function workItemRequiresPromotionSurvey(repositoryRoot, item) {
    return item.sourceRefs.some((sourceRef) => readSourceValue(repositoryRoot, sourceRef).semanticAuthor === 'agent');
}
function parsePromotionSurvey(source) {
    let value;
    try {
        value = JSON.parse(source);
    }
    catch {
        throw registryInvalid('Promotion survey is invalid.');
    }
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'changeId',
            'emptyReason',
            'schemaVersion',
            'surveyedCommit',
            'symbols',
            'workItemId',
        ]) ||
        value.schemaVersion !== 1 ||
        typeof value.workItemId !== 'string' ||
        !/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(value.workItemId) ||
        typeof value.changeId !== 'string' ||
        changeIdentity(value.changeId) !== value.changeId ||
        typeof value.surveyedCommit !== 'string' ||
        !/^[0-9a-f]{40,64}$/.test(value.surveyedCommit) ||
        !Array.isArray(value.symbols) ||
        value.symbols.some((entry) => !isRecord(entry) ||
            !hasExactKeys(entry, ['consumerPaths', 'symbol']) ||
            !isSurveySymbol(entry.symbol) ||
            !Array.isArray(entry.consumerPaths) ||
            entry.consumerPaths.some((consumer) => typeof consumer !== 'string')) ||
        (value.emptyReason !== null &&
            (typeof value.emptyReason !== 'string' ||
                boundedText(value.emptyReason, 500, 'survey reason') !==
                    value.emptyReason)) ||
        (value.symbols.length === 0 && value.emptyReason === null) ||
        (value.symbols.length > 0 && value.emptyReason !== null)) {
        throw registryInvalid('Promotion survey is invalid.');
    }
    const survey = value;
    const symbols = survey.symbols.map(({ symbol }) => symbol);
    if (new Set(symbols).size !== symbols.length ||
        JSON.stringify(symbols) !== JSON.stringify([...symbols].sort()) ||
        source !== `${canonicalJson(survey)}\n`) {
        throw registryInvalid('Promotion survey is invalid.');
    }
    return survey;
}
function promotionSurveyRequired(message) {
    return workflowError('WORK_REGISTRY_SURVEY_REQUIRED', message, ExitCode.conflict);
}
function promotionGrantStale(message) {
    return workflowError('WORK_REGISTRY_GRANT_STALE', message, ExitCode.conflict);
}
function assertPromotionEligible(repositoryRoot, item) {
    if (item.stage !== 'backlog' ||
        item.interpretation.status !== 'maintainer-confirmed' ||
        (item.lane !== 'now' && item.lane !== 'next') ||
        item.changeRefs.length !== 0 ||
        item.closure !== null) {
        throw promotionIneligible('Promotion requires one reviewed Now or Next backlog Work Item.');
    }
    for (const blockerId of item.blockedBy) {
        const blocker = showWorkItem(repositoryRoot, blockerId);
        if (blocker.stage !== 'closed') {
            throw promotionIneligible('Promotion requires every blocking Work Item to be closed.');
        }
    }
}
function createWorkItemPromotionTransaction(repositoryRoot, itemPath, originPath, itemBefore, originBefore, promoted, origin, grantBinding) {
    const itemRelativePath = exactRepositoryRelativePath(repositoryRoot, itemPath);
    const originRelativePath = exactRepositoryRelativePath(repositoryRoot, originPath);
    const itemAfter = `${canonicalJson(promoted)}\n`;
    const originAfter = `${canonicalJson(origin)}\n`;
    const parentBindings = {
        item: captureWorkItemPromotionParentBindings(repositoryRoot, itemPath),
        origin: captureWorkItemPromotionParentBindings(repositoryRoot, originPath),
    };
    const before = {
        itemContent: itemBefore,
        itemDigest: workRegistryTextDigest(itemBefore),
        originContent: originBefore,
        originDigest: originBefore === null ? null : workRegistryTextDigest(originBefore),
    };
    const after = {
        itemContent: itemAfter,
        itemDigest: workRegistryTextDigest(itemAfter),
        originContent: originAfter,
        originDigest: workRegistryTextDigest(originAfter),
    };
    const identity = {
        schemaVersion: 1,
        kind: WORK_REGISTRY_PROMOTION_TRANSACTION_KIND,
        workItemId: promoted.id,
        changeId: promoted.changeRefs[0],
        itemRelativePath,
        originRelativePath,
        grantBinding,
        itemBeforeDigest: before.itemDigest,
        originBeforeDigest: before.originDigest,
    };
    const operationId = workRegistryTextDigest(canonicalJson(identity));
    const captureToken = crypto.randomUUID();
    const withoutDigest = {
        schemaVersion: 1,
        kind: WORK_REGISTRY_PROMOTION_TRANSACTION_KIND,
        operationId,
        captureToken,
        workItemId: promoted.id,
        changeId: promoted.changeRefs[0],
        itemRelativePath,
        originRelativePath,
        grantBinding,
        parentBindings,
        before,
        after,
    };
    return {
        ...withoutDigest,
        transactionDigest: workRegistryTextDigest(canonicalJson(withoutDigest)),
    };
}
function recoverWorkItemPromotionTransactionsUnlocked(runtime) {
    ensureWorkRegistryPromotionDirectories(runtime);
    const entries = fs
        .readdirSync(runtime.journals, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        const entryPath = path.join(runtime.journals, entry.name);
        if (entry.isFile() &&
            !entry.isSymbolicLink() &&
            /^sha256-[0-9a-f]{64}\.rollback\.json$/.test(entry.name)) {
            const transaction = readWorkItemPromotionTransaction(runtime, entryPath);
            abortWorkItemPromotionTransaction(runtime, transaction, {});
            continue;
        }
        if (entry.isFile() &&
            !entry.isSymbolicLink() &&
            /^sha256-[0-9a-f]{64}\.json$/.test(entry.name)) {
            const transaction = readWorkItemPromotionTransaction(runtime, entryPath);
            try {
                applyWorkItemPromotionTransaction(runtime, transaction, {});
            }
            catch (error) {
                markWorkItemPromotionRollback(runtime, transaction);
                abortWorkItemPromotionTransaction(runtime, transaction, {});
                if (error instanceof WorkRegistryPromotionCasMismatch) {
                    throw workRegistryTransactionConflict('A pending Work Item promotion no longer matches its tracked inputs.');
                }
                throw error;
            }
            publishRecoveredWorkItemPromotion(runtime, transaction);
            continue;
        }
        if (entry.isFile() &&
            !entry.isSymbolicLink() &&
            /^sha256-[0-9a-f]{64}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) {
            removePrivatePromotionTemporaryFile(entryPath);
            fsyncWorkRegistryDirectory(runtime.journals);
            continue;
        }
        throw workRegistryTransactionInvalid('Work Item promotion journal directory contains an unsafe entry.');
    }
}
function withWorkRegistryPromotionLock(repositoryRoot, operation) {
    const runtime = workRegistryPromotionRuntimePaths(repositoryRoot, true);
    if (activeWorkRegistryPromotionRoots.has(runtime.repositoryRoot)) {
        return operation(runtime);
    }
    ensureWorkRegistryPromotionDirectories(runtime);
    const ownerToken = crypto.randomUUID();
    const marker = `${canonicalJson({
        schemaVersion: 1,
        ownerToken,
        pid: process.pid,
    })}\n`;
    let descriptor;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            descriptor = publishPreparedExclusiveLock(runtime.lock, marker, ownerToken, () => workRegistryTransactionInvalid('Work Item promotion lock publication is unsafe.'));
            break;
        }
        catch (error) {
            if (isNodeError(error) && error.code === 'EEXIST' && attempt === 0) {
                const reclaim = reclaimDeadPreparedLock(runtime.lock, (content) => parseWorkRegistryPromotionLockOwner(content));
                if (reclaim === 'reclaimed' || reclaim === 'absent')
                    continue;
                if (reclaim === 'unsafe') {
                    throw workRegistryTransactionInvalid('Work Item promotion lock is invalid.');
                }
            }
            if (isNodeError(error) && error.code === 'EEXIST') {
                throw workRegistryTransactionConflict('Another Work Item promotion transaction is in progress.');
            }
            throw error;
        }
    }
    if (descriptor === undefined) {
        throw workRegistryTransactionInvalid('Work Item promotion lock could not be acquired.');
    }
    activeWorkRegistryPromotionRoots.add(runtime.repositoryRoot);
    let result;
    let operationError;
    try {
        result = operation(runtime);
    }
    catch (error) {
        operationError = error;
    }
    activeWorkRegistryPromotionRoots.delete(runtime.repositoryRoot);
    try {
        releaseWorkRegistryPromotionLock(runtime.lock, descriptor, marker);
    }
    catch (releaseError) {
        if (operationError === undefined)
            throw releaseError;
        throw workRegistryTransactionInvalid('Work Item promotion failed and its lock could not be released safely.');
    }
    if (operationError !== undefined)
        throw operationError;
    return result;
}
function withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, operation) {
    const runtime = workRegistryPromotionRuntimePaths(repositoryRoot, false);
    if (runtime === null) {
        return operation();
    }
    if (activeWorkRegistryPromotionRoots.has(runtime.repositoryRoot)) {
        return operation();
    }
    return withWorkRegistryPromotionLock(repositoryRoot, (runtime) => {
        recoverWorkItemPromotionTransactionsUnlocked(runtime);
        return operation();
    });
}
function withWorkRegistryPromotionReadLockWhenAvailable(repositoryRoot, operation) {
    const runtime = workRegistryPromotionRuntimePaths(repositoryRoot, false);
    if (runtime === null)
        return operation();
    if (activeWorkRegistryPromotionRoots.has(runtime.repositoryRoot)) {
        return operation();
    }
    if (fs.lstatSync(runtime.root, { throwIfNoEntry: false }) === undefined) {
        const result = operation();
        if (fs.lstatSync(runtime.root, { throwIfNoEntry: false }) === undefined) {
            return result;
        }
    }
    return withWorkRegistryPromotionLock(repositoryRoot, (lockedRuntime) => {
        recoverWorkItemPromotionTransactionsUnlocked(lockedRuntime);
        return operation();
    });
}
function workRegistryPromotionRuntimePaths(repositoryRoot, required) {
    const repositoryRealPath = fs.realpathSync(repositoryRoot);
    const topLevel = runGit(repositoryRealPath, ['rev-parse', '--show-toplevel'], true).trim();
    const gitDirectoryValue = runGit(repositoryRealPath, ['rev-parse', '--git-dir'], true).trim();
    let topLevelRealPath = null;
    let gitDirectory = null;
    try {
        topLevelRealPath = topLevel ? fs.realpathSync(topLevel) : null;
        gitDirectory = gitDirectoryValue
            ? fs.realpathSync(path.isAbsolute(gitDirectoryValue)
                ? gitDirectoryValue
                : path.resolve(repositoryRealPath, gitDirectoryValue))
            : null;
    }
    catch {
        topLevelRealPath = null;
        gitDirectory = null;
    }
    if (topLevelRealPath !== repositoryRealPath || gitDirectory === null) {
        if (!required)
            return null;
        throw workRegistryTransactionInvalid('Work Item promotion requires one canonical Git worktree.');
    }
    const engineRoot = path.join(gitDirectory, 'workflow-engine');
    const root = path.join(engineRoot, 'work-registry');
    const journals = path.join(root, 'promotion-journals');
    const recovered = path.join(root, 'recovered-promotions');
    const locks = path.join(root, 'locks');
    return {
        repositoryRoot: repositoryRealPath,
        gitDirectory,
        engineRoot,
        root,
        journals,
        recovered,
        locks,
        lock: path.join(locks, 'promotion.lock'),
    };
}
function ensureWorkRegistryPromotionDirectories(runtime) {
    assertPlainPromotionDirectory(runtime.gitDirectory, false);
    for (const [directory, requirePrivateMode] of [
        [runtime.engineRoot, false],
        [runtime.root, true],
        [runtime.journals, true],
        [runtime.recovered, true],
        [runtime.locks, true],
    ]) {
        let stats = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!stats) {
            fs.mkdirSync(directory, { mode: WORK_REGISTRY_PRIVATE_DIRECTORY_MODE });
            fs.chmodSync(directory, WORK_REGISTRY_PRIVATE_DIRECTORY_MODE);
            fsyncWorkRegistryDirectory(path.dirname(directory));
            stats = fs.lstatSync(directory);
        }
        assertPlainPromotionDirectory(directory, requirePrivateMode);
    }
}
function assertPlainPromotionDirectory(directory, requirePrivateMode) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(directory) !== path.resolve(directory) ||
        (requirePrivateMode &&
            process.platform !== 'win32' &&
            (stats.mode & 0o777) !== WORK_REGISTRY_PRIVATE_DIRECTORY_MODE) ||
        (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
        throw workRegistryTransactionInvalid('Work Item promotion private directory is unsafe.');
    }
}
function parseWorkRegistryPromotionLockOwner(content) {
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        return null;
    }
    if (!isRecord(value) ||
        !hasExactKeys(value, ['ownerToken', 'pid', 'schemaVersion']) ||
        value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.pid) ||
        Number(value.pid) <= 0 ||
        typeof value.ownerToken !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.ownerToken)) {
        return null;
    }
    return { pid: Number(value.pid), ownerToken: value.ownerToken };
}
function releaseWorkRegistryPromotionLock(lockPath, descriptor, marker) {
    try {
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        const bytes = Buffer.alloc(Buffer.byteLength(marker));
        const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
        if (!owned.isFile() ||
            owned.nlink !== 1 ||
            (process.platform !== 'win32' &&
                (owned.mode & 0o777) !== WORK_REGISTRY_PRIVATE_FILE_MODE) ||
            !observed?.isFile() ||
            observed.isSymbolicLink() ||
            observed.dev !== owned.dev ||
            observed.ino !== owned.ino ||
            bytes.subarray(0, count).toString('utf8') !== marker) {
            throw workRegistryTransactionInvalid('Work Item promotion lock ownership changed.');
        }
        fs.unlinkSync(lockPath);
        fsyncWorkRegistryDirectory(path.dirname(lockPath));
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function publishWorkItemPromotionTransaction(runtime, requested) {
    const journalPath = workItemPromotionJournalPath(runtime, requested);
    if (fs.lstatSync(journalPath, { throwIfNoEntry: false })) {
        return {
            transaction: readWorkItemPromotionTransaction(runtime, journalPath),
            created: false,
        };
    }
    const content = `${canonicalJson(requested)}\n`;
    if (Buffer.byteLength(content, 'utf8') >
        MAX_WORK_REGISTRY_PROMOTION_TRANSACTION_BYTES) {
        throw workRegistryTransactionInvalid('Work Item promotion transaction exceeds the durable journal limit.');
    }
    const temporary = `${journalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_RDWR |
            (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW), WORK_REGISTRY_PRIVATE_FILE_MODE);
        fs.fchmodSync(descriptor, WORK_REGISTRY_PRIVATE_FILE_MODE);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        if (fs.lstatSync(journalPath, { throwIfNoEntry: false })) {
            fs.rmSync(temporary, { force: true });
            return {
                transaction: readWorkItemPromotionTransaction(runtime, journalPath),
                created: false,
            };
        }
        fs.renameSync(temporary, journalPath);
        fsyncWorkRegistryDirectory(runtime.journals);
        return {
            transaction: readWorkItemPromotionTransaction(runtime, journalPath),
            created: true,
        };
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        fs.rmSync(temporary, { force: true });
    }
}
function readWorkItemPromotionTransaction(runtime, journalPath, requireCurrentParentBindings = true) {
    const content = readStablePrivatePromotionFile(journalPath);
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        throw workRegistryTransactionInvalid('Work Item promotion journal is invalid.');
    }
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'after',
            'before',
            'captureToken',
            'changeId',
            'grantBinding',
            'itemRelativePath',
            'kind',
            'operationId',
            'originRelativePath',
            'parentBindings',
            'schemaVersion',
            'transactionDigest',
            'workItemId',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== WORK_REGISTRY_PROMOTION_TRANSACTION_KIND ||
        typeof value.operationId !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(value.operationId) ||
        typeof value.captureToken !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.captureToken) ||
        typeof value.transactionDigest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(value.transactionDigest) ||
        typeof value.workItemId !== 'string' ||
        !/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(value.workItemId) ||
        typeof value.changeId !== 'string' ||
        changeIdentity(value.changeId) !== value.changeId ||
        typeof value.itemRelativePath !== 'string' ||
        typeof value.originRelativePath !== 'string' ||
        !isWorkItemPromotionGrantBinding(value.grantBinding) ||
        !isWorkItemPromotionParentBindings(value.parentBindings) ||
        !isPromotionTransactionBefore(value.before) ||
        !isPromotionTransactionAfter(value.after)) {
        throw workRegistryTransactionInvalid('Work Item promotion journal is invalid.');
    }
    const transaction = value;
    const beforeItem = parsePromotionItemContent(transaction.before.itemContent);
    const afterItem = parsePromotionItemContent(transaction.after.itemContent);
    const beforeOrigin = transaction.before.originContent === null
        ? null
        : parsePromotionOriginContent(transaction.before.originContent);
    const afterOrigin = parsePromotionOriginContent(transaction.after.originContent);
    const expectedItemPath = path.posix.join(repositoryWorkRegistryConfiguration(runtime.repositoryRoot).itemRoot, beforeItem.createdAt.slice(0, 4), `${beforeItem.id}.yaml`);
    const expectedOriginPath = path.posix.join(repositoryWorkRegistryConfiguration(runtime.repositoryRoot)
        .changeOriginRoot, transaction.changeId, 'origin.json');
    const expectedAfterItem = {
        ...beforeItem,
        stage: 'active',
        changeRefs: [transaction.changeId],
        timeline: [...beforeItem.timeline, afterItem.timeline.at(-1)],
    };
    const expectedAfterOrigin = {
        schemaVersion: 1,
        sourceRefs: [
            ...new Set([
                ...(beforeOrigin?.sourceRefs ?? []),
                ...beforeItem.sourceRefs,
            ]),
        ].sort(),
        workItemRefs: [
            ...new Set([...(beforeOrigin?.workItemRefs ?? []), beforeItem.id]),
        ].sort(),
    };
    const identity = {
        schemaVersion: 1,
        kind: WORK_REGISTRY_PROMOTION_TRANSACTION_KIND,
        workItemId: transaction.workItemId,
        changeId: transaction.changeId,
        itemRelativePath: transaction.itemRelativePath,
        originRelativePath: transaction.originRelativePath,
        grantBinding: transaction.grantBinding,
        itemBeforeDigest: transaction.before.itemDigest,
        originBeforeDigest: transaction.before.originDigest,
    };
    const withoutDigest = {
        schemaVersion: transaction.schemaVersion,
        kind: transaction.kind,
        operationId: transaction.operationId,
        captureToken: transaction.captureToken,
        workItemId: transaction.workItemId,
        changeId: transaction.changeId,
        itemRelativePath: transaction.itemRelativePath,
        originRelativePath: transaction.originRelativePath,
        grantBinding: transaction.grantBinding,
        parentBindings: transaction.parentBindings,
        before: transaction.before,
        after: transaction.after,
    };
    if (content !== `${canonicalJson(transaction)}\n` ||
        ![
            `${transaction.operationId.replace(':', '-')}.json`,
            `${transaction.operationId.replace(':', '-')}.rollback.json`,
        ].includes(path.basename(journalPath)) ||
        transaction.workItemId !== beforeItem.id ||
        afterItem.id !== beforeItem.id ||
        beforeItem.stage !== 'backlog' ||
        beforeItem.changeRefs.length !== 0 ||
        afterItem.stage !== 'active' ||
        afterItem.changeRefs.length !== 1 ||
        afterItem.changeRefs[0] !== transaction.changeId ||
        afterItem.timeline.length !== beforeItem.timeline.length + 1 ||
        afterItem.timeline.at(-1)?.event !== 'promoted' ||
        afterItem.timeline.at(-1)?.changeId !== transaction.changeId ||
        canonicalJson(afterItem) !== canonicalJson(expectedAfterItem) ||
        canonicalJson(afterOrigin) !== canonicalJson(expectedAfterOrigin) ||
        !afterOrigin.workItemRefs.includes(beforeItem.id) ||
        beforeItem.sourceRefs.some((sourceRef) => !afterOrigin.sourceRefs.includes(sourceRef)) ||
        !isSafeWorkItemPromotionRelativePath(transaction.itemRelativePath) ||
        !isSafeWorkItemPromotionRelativePath(transaction.originRelativePath) ||
        !transaction.itemRelativePath.endsWith(`/${beforeItem.createdAt.slice(0, 4)}/${beforeItem.id}.yaml`) ||
        !transaction.originRelativePath.endsWith(`/${transaction.changeId}/origin.json`) ||
        canonicalJson(transaction.parentBindings.item.map(({ relativePath }) => relativePath)) !==
            canonicalJson(workItemPromotionParentRelativePaths(transaction.itemRelativePath)) ||
        canonicalJson(transaction.parentBindings.origin.map(({ relativePath }) => relativePath)) !==
            canonicalJson(workItemPromotionParentRelativePaths(transaction.originRelativePath)) ||
        (requireCurrentParentBindings &&
            (transaction.itemRelativePath !== expectedItemPath ||
                transaction.originRelativePath !== expectedOriginPath ||
                canonicalJson(transaction.parentBindings.item) !==
                    canonicalJson(captureWorkItemPromotionParentBindings(runtime.repositoryRoot, path.join(runtime.repositoryRoot, ...transaction.itemRelativePath.split('/')))) ||
                canonicalJson(transaction.parentBindings.origin) !==
                    canonicalJson(captureWorkItemPromotionParentBindings(runtime.repositoryRoot, path.join(runtime.repositoryRoot, ...transaction.originRelativePath.split('/')))))) ||
        transaction.before.itemDigest !==
            workRegistryTextDigest(transaction.before.itemContent) ||
        transaction.before.originDigest !==
            (transaction.before.originContent === null
                ? null
                : workRegistryTextDigest(transaction.before.originContent)) ||
        transaction.after.itemDigest !==
            workRegistryTextDigest(transaction.after.itemContent) ||
        transaction.after.originDigest !==
            workRegistryTextDigest(transaction.after.originContent) ||
        transaction.operationId !==
            workRegistryTextDigest(canonicalJson(identity)) ||
        transaction.transactionDigest !==
            workRegistryTextDigest(canonicalJson(withoutDigest)) ||
        (beforeOrigin !== null && beforeOrigin.schemaVersion !== 1)) {
        throw workRegistryTransactionInvalid('Work Item promotion journal binding is invalid.');
    }
    return transaction;
}
function isPromotionTransactionBefore(value) {
    return (isRecord(value) &&
        hasExactKeys(value, [
            'itemContent',
            'itemDigest',
            'originContent',
            'originDigest',
        ]) &&
        typeof value.itemContent === 'string' &&
        typeof value.itemDigest === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(value.itemDigest) &&
        (value.originContent === null || typeof value.originContent === 'string') &&
        (value.originDigest === null ||
            (typeof value.originDigest === 'string' &&
                /^sha256:[0-9a-f]{64}$/.test(value.originDigest))));
}
function isWorkItemPromotionGrantBinding(value) {
    return (value === null ||
        (isRecord(value) &&
            hasExactKeys(value, [
                'approvalSubjectDigest',
                'challengeId',
                'operationId',
                'schemaVersion',
                'surveyBinding',
            ]) &&
            value.schemaVersion === 1 &&
            typeof value.challengeId === 'string' &&
            value.challengeId.length > 0 &&
            value.challengeId.length <= 200 &&
            !/[\0\r\n]/u.test(value.challengeId) &&
            typeof value.operationId === 'string' &&
            value.operationId.length > 0 &&
            value.operationId.length <= 200 &&
            !/[\0\r\n]/u.test(value.operationId) &&
            typeof value.approvalSubjectDigest === 'string' &&
            /^sha256:[0-9a-f]{64}$/.test(value.approvalSubjectDigest) &&
            isWorkItemPromotionSurveyBinding(value.surveyBinding)));
}
function isWorkItemPromotionSurveyBinding(value) {
    return (isRecord(value) &&
        value.schemaVersion === 1 &&
        ((value.kind === 'current-survey' &&
            hasExactKeys(value, ['digest', 'kind', 'schemaVersion']) &&
            typeof value.digest === 'string' &&
            /^sha256:[0-9a-f]{64}$/.test(value.digest)) ||
            (value.kind === 'not-required' &&
                hasExactKeys(value, [
                    'kind',
                    'reason',
                    'schemaVersion',
                    'sourceRefsDigest',
                ]) &&
                value.reason === 'pure-maintainer-sources' &&
                typeof value.sourceRefsDigest === 'string' &&
                /^sha256:[0-9a-f]{64}$/.test(value.sourceRefsDigest))));
}
function isPromotionTransactionAfter(value) {
    return (isRecord(value) &&
        hasExactKeys(value, [
            'itemContent',
            'itemDigest',
            'originContent',
            'originDigest',
        ]) &&
        typeof value.itemContent === 'string' &&
        typeof value.itemDigest === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(value.itemDigest) &&
        typeof value.originContent === 'string' &&
        typeof value.originDigest === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(value.originDigest));
}
function isWorkItemPromotionParentBindings(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['item', 'origin']) &&
        Array.isArray(value.item) &&
        Array.isArray(value.origin) &&
        value.item.length > 0 &&
        value.origin.length > 0 &&
        [...value.item, ...value.origin].every((entry) => isRecord(entry) &&
            hasExactKeys(entry, ['device', 'inode', 'relativePath']) &&
            typeof entry.relativePath === 'string' &&
            /^(?!\.\.?(?:\/|$))[^\0]+$/.test(entry.relativePath) &&
            path.posix.normalize(entry.relativePath) === entry.relativePath &&
            typeof entry.device === 'string' &&
            /^(?:0|[1-9][0-9]*)$/.test(entry.device) &&
            typeof entry.inode === 'string' &&
            /^[1-9][0-9]*$/.test(entry.inode)));
}
function publishRecoveredWorkItemPromotion(runtime, transaction) {
    const journalPath = workItemPromotionJournalPath(runtime, transaction);
    const receiptPath = path.join(runtime.recovered, path.basename(journalPath));
    const expected = `${canonicalJson(transaction)}\n`;
    const existing = readStablePrivatePromotionFile(receiptPath, true);
    if (existing !== null) {
        if (existing !== expected) {
            throw workRegistryTransactionInvalid('Recovered Work Item promotion receipt conflicts with its journal.');
        }
        removeWorkItemPromotionJournal(runtime, transaction);
        return;
    }
    const current = readStablePrivatePromotionFile(journalPath);
    if (current !== expected) {
        throw workRegistryTransactionInvalid('Work Item promotion journal changed before recovery publication.');
    }
    fs.renameSync(journalPath, receiptPath);
    // The destination entry must be durable before the source-directory removal
    // is acknowledged. A crash can then expose either the journal or its exact
    // recovered receipt, never neither.
    fsyncWorkRegistryDirectory(runtime.recovered);
    fsyncWorkRegistryDirectory(runtime.journals);
}
function replayRecoveredWorkItemPromotion(runtime, workItemId, changeId, requestedExpectedDigest, grantBinding) {
    const match = findExactRecoveredWorkItemPromotion(runtime, workItemId, changeId, requestedExpectedDigest, grantBinding);
    if (match === null)
        return null;
    if (!isWorkItemPromotionTransactionCommitted(runtime, match.transaction)) {
        throw workRegistryTransactionInvalid('Recovered Work Item promotion no longer matches tracked state.');
    }
    return {
        item: parsePromotionItemContent(match.transaction.after.itemContent),
        originPath: path.join(runtime.repositoryRoot, ...match.transaction.originRelativePath.split('/')),
    };
}
function findExactRecoveredWorkItemPromotion(runtime, workItemId, changeId, requestedExpectedDigest, grantBinding) {
    const expectedDigest = requestedExpectedDigest === undefined
        ? null
        : exactDigest(requestedExpectedDigest);
    let match;
    const entries = fs
        .readdirSync(runtime.recovered, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (!entry.isFile() ||
            entry.isSymbolicLink() ||
            !/^sha256-[0-9a-f]{64}\.json$/.test(entry.name)) {
            throw workRegistryTransactionInvalid('Recovered Work Item promotion directory contains an unsafe entry.');
        }
        const receiptPath = path.join(runtime.recovered, entry.name);
        const transaction = readWorkItemPromotionTransaction(runtime, receiptPath, false);
        if (transaction.workItemId !== workItemId ||
            transaction.changeId !== changeId ||
            canonicalJson(transaction.grantBinding) !== canonicalJson(grantBinding) ||
            (expectedDigest !== null &&
                workItemDigest(parsePromotionItemContent(transaction.before.itemContent)) !== expectedDigest)) {
            continue;
        }
        if (match !== undefined) {
            throw workRegistryTransactionInvalid('Multiple recovered Work Item promotions match one exact request.');
        }
        match = { transaction, receiptPath };
    }
    if (match === undefined)
        return null;
    if (readStablePrivatePromotionFile(match.receiptPath) !==
        `${canonicalJson(match.transaction)}\n`) {
        throw workRegistryTransactionInvalid('Recovered Work Item promotion receipt changed before replay.');
    }
    return match;
}
function isWorkItemPromotionTransactionCommitted(runtime, transaction) {
    const itemPath = path.join(runtime.repositoryRoot, ...transaction.itemRelativePath.split('/'));
    const originPath = path.join(runtime.repositoryRoot, ...transaction.originRelativePath.split('/'));
    let item;
    let origin;
    try {
        item = withWorkItemPromotionParentCapability(runtime, itemPath, transaction.parentBindings.item, (itemLeaf) => readStablePromotionTarget(itemLeaf, true));
        origin = withWorkItemPromotionParentCapability(runtime, originPath, transaction.parentBindings.origin, (originLeaf) => readStablePromotionTarget(originLeaf, true));
    }
    catch {
        return false;
    }
    if (item?.content !== transaction.after.itemContent || origin === null) {
        return false;
    }
    let observedOrigin;
    let requiredOrigin;
    try {
        observedOrigin = parsePromotionOriginContent(origin.content);
        requiredOrigin = parsePromotionOriginContent(transaction.after.originContent);
    }
    catch {
        return false;
    }
    return (requiredOrigin.sourceRefs.every((sourceRef) => observedOrigin.sourceRefs.includes(sourceRef)) &&
        requiredOrigin.workItemRefs.every((workItemRef) => observedOrigin.workItemRefs.includes(workItemRef)));
}
function applyWorkItemPromotionTransaction(runtime, transaction, testHooks) {
    const originPath = path.join(runtime.repositoryRoot, ...transaction.originRelativePath.split('/'));
    const itemPath = path.join(runtime.repositoryRoot, ...transaction.itemRelativePath.split('/'));
    withWorkItemPromotionParentCapability(runtime, originPath, transaction.parentBindings.origin, (originLeaf) => {
        transitionTrackedPromotionFile(originLeaf, transaction.before.originContent, transaction.after.originContent, transaction.operationId, transaction.captureToken, 'origin-forward');
    }, testHooks.afterOriginParentCapabilityAcquired);
    testHooks.afterOriginPublished?.();
    withWorkItemPromotionParentCapability(runtime, itemPath, transaction.parentBindings.item, (itemLeaf) => transitionTrackedPromotionFile(itemLeaf, transaction.before.itemContent, transaction.after.itemContent, transaction.operationId, transaction.captureToken, 'item-forward'));
    testHooks.afterItemPublished?.();
    assertExactWorkItemPromotionTrackedState(runtime, transaction);
}
function assertExactWorkItemPromotionTrackedState(runtime, transaction) {
    const itemPath = path.join(runtime.repositoryRoot, ...transaction.itemRelativePath.split('/'));
    const originPath = path.join(runtime.repositoryRoot, ...transaction.originRelativePath.split('/'));
    assertWorkItemPromotionParentBinding(runtime, itemPath, transaction.parentBindings.item);
    assertWorkItemPromotionParentBinding(runtime, originPath, transaction.parentBindings.origin);
    const itemContent = withWorkItemPromotionParentCapability(runtime, itemPath, transaction.parentBindings.item, (itemLeaf) => readStablePromotionTarget(itemLeaf, false).content);
    const originContent = withWorkItemPromotionParentCapability(runtime, originPath, transaction.parentBindings.origin, (originLeaf) => readStablePromotionTarget(originLeaf, false).content);
    if (itemContent !== transaction.after.itemContent ||
        originContent !== transaction.after.originContent) {
        throw new WorkRegistryPromotionCasMismatch();
    }
}
function assertWorkItemPromotionParentBinding(runtime, filePath, expected) {
    if (canonicalJson(captureWorkItemPromotionParentBindings(runtime.repositoryRoot, filePath)) !== canonicalJson(expected)) {
        throw workRegistryTransactionInvalid('Work Item promotion parent directory binding changed.');
    }
}
function withWorkItemPromotionParentCapability(runtime, filePath, expected, operation, afterInitialBinding) {
    assertWorkItemPromotionParentBinding(runtime, filePath, expected);
    const expectedParent = expected.at(-1);
    const relativeFile = path
        .relative(runtime.repositoryRoot, filePath)
        .replaceAll(path.sep, '/');
    const relativeParent = path.posix.dirname(relativeFile);
    if (expectedParent === undefined ||
        relativeParent !== expectedParent.relativePath ||
        !isSafeWorkItemPromotionRelativePath(relativeFile)) {
        throw workRegistryTransactionInvalid('Work Item promotion parent capability path is invalid.');
    }
    const previousWorkingDirectory = process.cwd();
    try {
        process.chdir(runtime.repositoryRoot);
    }
    catch {
        throw workRegistryTransactionInvalid('Work Item promotion repository capability could not be acquired.');
    }
    let result;
    let operationError;
    try {
        afterInitialBinding?.();
        const repositoryStats = fs.lstatSync('.', { bigint: true });
        const repositoryPathStats = fs.lstatSync(runtime.repositoryRoot, {
            bigint: true,
        });
        if (!repositoryStats.isDirectory() ||
            repositoryStats.isSymbolicLink() ||
            !samePromotionInode(repositoryStats, repositoryPathStats) ||
            process.cwd() !== runtime.repositoryRoot) {
            throw workRegistryTransactionInvalid('Work Item promotion repository capability changed before use.');
        }
        // Reacquire the complete parent chain from the held repository root after
        // every caller-controlled test seam. The leaf transition then resolves a
        // repository-relative path instead of retaining a moved parent inode.
        assertWorkItemPromotionParentBinding(runtime, filePath, expected);
        result = operation(relativeFile);
    }
    catch (error) {
        operationError = error;
    }
    try {
        process.chdir(previousWorkingDirectory);
    }
    catch {
        throw workRegistryTransactionInvalid('Work Item promotion repository capability could not be released.');
    }
    if (operationError !== undefined)
        throw operationError;
    return result;
}
function abortWorkItemPromotionTransaction(runtime, transaction, testHooks) {
    const targets = [
        {
            path: path.join(runtime.repositoryRoot, ...transaction.itemRelativePath.split('/')),
            before: transaction.before.itemContent,
            after: transaction.after.itemContent,
            parentBinding: transaction.parentBindings.item,
            role: 'item',
            afterRollbackCaptured: testHooks.afterItemRollbackCaptured,
        },
        {
            path: path.join(runtime.repositoryRoot, ...transaction.originRelativePath.split('/')),
            before: transaction.before.originContent,
            after: transaction.after.originContent,
            parentBinding: transaction.parentBindings.origin,
            role: 'origin',
            afterRollbackCaptured: testHooks.afterOriginRollbackCaptured,
        },
    ];
    try {
        for (const target of targets) {
            withWorkItemPromotionParentCapability(runtime, target.path, target.parentBinding, (targetLeaf) => {
                const rollbackRole = `${target.role}-rollback`;
                const forwardRole = `${target.role}-forward`;
                const rollbackStarted = hasPromotionTransitionAliases(targetLeaf, transaction.operationId, transaction.captureToken, rollbackRole);
                const forwardStarted = hasPromotionTransitionAliases(targetLeaf, transaction.operationId, transaction.captureToken, forwardRole);
                if (!rollbackStarted && !forwardStarted) {
                    const current = readStablePromotionTarget(targetLeaf, true);
                    if ((current?.content ?? null) === target.before)
                        return;
                }
                if (!rollbackStarted) {
                    try {
                        // A forward transition may itself have stopped after capturing
                        // the tracked name. Converge it first, then run the durable
                        // rollback state machine. On restart, rollback aliases are
                        // inspected before forward aliases so either direction resumes.
                        transitionTrackedPromotionFile(targetLeaf, target.before, target.after, transaction.operationId, transaction.captureToken, forwardRole);
                    }
                    catch (forwardError) {
                        if (!(forwardError instanceof WorkRegistryPromotionCasMismatch)) {
                            throw forwardError;
                        }
                        cleanupPromotionTransitionAliases(targetLeaf, transaction.operationId, transaction.captureToken, forwardRole, target.before, target.after);
                        return;
                    }
                }
                try {
                    transitionTrackedPromotionFile(targetLeaf, target.after, target.before, transaction.operationId, transaction.captureToken, rollbackRole, target.afterRollbackCaptured);
                }
                catch (rollbackError) {
                    if (!(rollbackError instanceof WorkRegistryPromotionCasMismatch)) {
                        throw rollbackError;
                    }
                    // A current writer may publish a new canonical target after the
                    // rollback captured the promotion bytes. Preserve that concurrent
                    // name, discard only this transaction's owned aliases, and let the
                    // ordinary domain validators classify the new state.
                    cleanupPromotionTransitionAliases(targetLeaf, transaction.operationId, transaction.captureToken, rollbackRole, target.after, target.before);
                }
                cleanupPromotionTransitionAliases(targetLeaf, transaction.operationId, transaction.captureToken, forwardRole, target.before, target.after);
            });
        }
        removeWorkItemPromotionRollbackJournal(runtime, transaction);
    }
    catch {
        throw workRegistryTransactionInvalid('Work Item promotion rollback could not restore exact tracked state.');
    }
}
function transitionTrackedPromotionFile(filePath, expected, desired, operationId, captureToken, role, afterCapture) {
    const aliases = promotionTransitionAliasPaths(filePath, operationId, captureToken, role);
    recoverPromotionAliasPublication(aliases, desired);
    let target = readStablePromotionTarget(filePath, true, true);
    let desiredAlias = readStablePromotionTarget(aliases.desired, true, true);
    let beforeAlias = readStablePromotionTarget(aliases.before, true, true);
    let captured = readStablePromotionTarget(aliases.capture, true, true);
    if (desiredAlias !== null && desiredAlias.content !== desired) {
        throw workRegistryTransactionInvalid('Work Item promotion desired alias is invalid.');
    }
    if (beforeAlias !== null && beforeAlias.content !== expected) {
        throw workRegistryTransactionInvalid('Work Item promotion prior-state alias is invalid.');
    }
    if (captured !== null && captured.content !== expected) {
        restoreCapturedPromotionTarget(filePath, aliases.capture, aliases.before, captured, beforeAlias, expected);
        throw new WorkRegistryPromotionCasMismatch();
    }
    if (beforeAlias !== null &&
        captured !== null &&
        !samePromotionInode(beforeAlias.stats, captured.stats)) {
        throw workRegistryTransactionInvalid('Work Item promotion prior-state aliases disagree.');
    }
    if (target !== null && target.content === desired) {
        removePromotionAliasIfPresent(aliases.desired, desired);
        removePromotionAliasIfPresent(aliases.before, expected);
        removePromotionAliasIfPresent(aliases.capture, expected);
        fsyncWorkRegistryDirectory(path.dirname(filePath));
        assertStablePromotionTarget(filePath, desired);
        return;
    }
    const continuingAfterCapture = target === null &&
        expected !== null &&
        (beforeAlias !== null || captured !== null);
    if (!continuingAfterCapture && (target?.content ?? null) !== expected) {
        throw new WorkRegistryPromotionCasMismatch();
    }
    if (target !== null &&
        (beforeAlias === null
            ? target.stats.nlink !== 1n
            : !samePromotionInode(target.stats, beforeAlias.stats))) {
        throw workRegistryTransactionInvalid('Work Item promotion target has an unsafe link count.');
    }
    if (desired !== null && desiredAlias === null) {
        createPromotionAliasFile(aliases.desired, aliases.desiredTemporary, desired);
        desiredAlias = readStablePromotionTarget(aliases.desired, false, true);
    }
    if (!continuingAfterCapture && expected !== null) {
        if (target === null)
            throw new WorkRegistryPromotionCasMismatch();
        if (beforeAlias === null) {
            try {
                fs.linkSync(filePath, aliases.before);
            }
            catch (error) {
                if (!isNodeError(error) || error.code !== 'EEXIST')
                    throw error;
            }
        }
        beforeAlias = readStablePromotionTarget(aliases.before, false, true);
        const beforeLinkTarget = readStablePromotionTarget(filePath, false, true);
        if (beforeAlias.content !== expected ||
            beforeLinkTarget.content !== expected ||
            !samePromotionInode(beforeAlias.stats, beforeLinkTarget.stats)) {
            throw new WorkRegistryPromotionCasMismatch();
        }
        // The old bytes must have a durable directory entry before the tracked
        // pathname is atomically captured. Recovery can then converge from either
        // the live name or this exact prior-state alias after power loss.
        fsyncWorkRegistryDirectory(path.dirname(filePath));
        if (fs.lstatSync(aliases.capture, { throwIfNoEntry: false })) {
            throw workRegistryTransactionInvalid('Work Item promotion capture alias already exists.');
        }
        fs.renameSync(filePath, aliases.capture);
        fsyncWorkRegistryDirectory(path.dirname(filePath));
        afterCapture?.();
        captured = readStablePromotionTarget(aliases.capture, false, true);
        beforeAlias = readStablePromotionTarget(aliases.before, false, true);
        if (captured.content !== expected ||
            beforeAlias.content !== expected ||
            !samePromotionInode(captured.stats, beforeAlias.stats)) {
            restoreCapturedPromotionTarget(filePath, aliases.capture, aliases.before, captured, beforeAlias, expected);
            throw new WorkRegistryPromotionCasMismatch();
        }
    }
    if (desired === null) {
        removePromotionAliasIfPresent(aliases.before, expected);
        removePromotionAliasIfPresent(aliases.capture, expected);
        fsyncWorkRegistryDirectory(path.dirname(filePath));
        if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
            throw new WorkRegistryPromotionCasMismatch();
        }
        return;
    }
    if (desiredAlias === null) {
        throw workRegistryTransactionInvalid('Work Item promotion desired alias disappeared.');
    }
    try {
        fs.linkSync(aliases.desired, filePath);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST')
            throw error;
        const current = readStablePromotionTarget(filePath, false, true);
        if (current.content !== desired) {
            throw new WorkRegistryPromotionCasMismatch();
        }
        removePromotionAliasIfPresent(aliases.desired, desired);
        removePromotionAliasIfPresent(aliases.before, expected);
        removePromotionAliasIfPresent(aliases.capture, expected);
        fsyncWorkRegistryDirectory(path.dirname(filePath));
        assertStablePromotionTarget(filePath, desired);
        return;
    }
    fsyncWorkRegistryDirectory(path.dirname(filePath));
    const published = readStablePromotionTarget(filePath, false, true);
    const publishedAlias = readStablePromotionTarget(aliases.desired, false, true);
    if (published.content !== desired ||
        publishedAlias.content !== desired ||
        !samePromotionInode(published.stats, publishedAlias.stats)) {
        throw workRegistryTransactionInvalid('Work Item promotion publication is invalid.');
    }
    removePromotionAliasIfPresent(aliases.desired, desired);
    removePromotionAliasIfPresent(aliases.before, expected);
    removePromotionAliasIfPresent(aliases.capture, expected);
    fsyncWorkRegistryDirectory(path.dirname(filePath));
    assertStablePromotionTarget(filePath, desired);
}
function restoreCapturedPromotionTarget(filePath, capturePath, beforePath, captured, beforeAlias, expected) {
    let target = readStablePromotionTarget(filePath, true, true);
    if (target === null) {
        try {
            fs.linkSync(capturePath, filePath);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
        }
        fsyncWorkRegistryDirectory(path.dirname(filePath));
        target = readStablePromotionTarget(filePath, false, true);
    }
    if (target.content !== captured.content ||
        !samePromotionInode(target.stats, captured.stats)) {
        throw workRegistryTransactionInvalid('Work Item promotion could not restore a concurrently displaced target.');
    }
    removePromotionAliasIfPresent(capturePath, captured.content);
    if (beforeAlias !== null) {
        removePromotionAliasIfPresent(beforePath, expected);
    }
    fsyncWorkRegistryDirectory(path.dirname(filePath));
    assertStablePromotionTarget(filePath, captured.content);
}
function cleanupPromotionTransitionAliases(filePath, operationId, captureToken, role, before, after) {
    const aliases = promotionTransitionAliasPaths(filePath, operationId, captureToken, role);
    removePromotionAliasIfPresent(aliases.desired, after);
    removePromotionAliasTemporaryIfPresent(aliases.desiredTemporary);
    removePromotionAliasIfPresent(aliases.before, before);
    removePromotionAliasIfPresent(aliases.capture, before);
    fsyncWorkRegistryDirectory(path.dirname(filePath));
}
function promotionTransitionAliasPaths(filePath, operationId, captureToken, role) {
    const identity = operationId.replace(':', '-');
    const prefix = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${identity}.${role}`);
    return {
        desired: `${prefix}.desired`,
        desiredTemporary: `${prefix}.desired.publish.tmp`,
        before: `${prefix}.before`,
        capture: `${prefix}.${captureToken}.capture`,
    };
}
function hasPromotionTransitionAliases(filePath, operationId, captureToken, role) {
    return Object.values(promotionTransitionAliasPaths(filePath, operationId, captureToken, role)).some((aliasPath) => fs.lstatSync(aliasPath, { throwIfNoEntry: false }) !== undefined);
}
function recoverPromotionAliasPublication(aliases, desired) {
    const temporary = readStablePromotionFileBytes(aliases.desiredTemporary, true, true, true);
    if (temporary === null)
        return;
    if (desired === null ||
        !temporary.bytes.equals(Buffer.from(desired, 'utf8')) ||
        (process.platform !== 'win32' &&
            (temporary.stats.mode & 511n) !== BigInt(WORK_ITEM_FILE_MODE))) {
        removePromotionAliasTemporaryIfPresent(aliases.desiredTemporary);
        fsyncWorkRegistryDirectory(path.dirname(aliases.desiredTemporary));
        return;
    }
    const published = readStablePromotionTarget(aliases.desired, true, true);
    if (published === null) {
        // Complete bytes are not proof that the writer crossed its inode fsync.
        // Discard a lone recovered temp and let createPromotionAliasFile rebuild
        // it through the normal write -> fsync -> link publication sequence.
        removePromotionAliasTemporaryIfPresent(aliases.desiredTemporary);
        fsyncWorkRegistryDirectory(path.dirname(aliases.desiredTemporary));
        return;
    }
    const exactPublished = readStablePromotionTarget(aliases.desired, false, true);
    const exactTemporary = readStablePromotionTarget(aliases.desiredTemporary, false, true);
    if (exactPublished.content !== desired ||
        exactTemporary.content !== desired ||
        !samePromotionInode(exactPublished.stats, exactTemporary.stats)) {
        throw workRegistryTransactionInvalid('Work Item promotion desired alias publication conflicts.');
    }
    fsyncWorkRegistryDirectory(path.dirname(aliases.desired));
    removePromotionAliasIfPresent(aliases.desiredTemporary, desired);
    fsyncWorkRegistryDirectory(path.dirname(aliases.desired));
}
function createPromotionAliasFile(filePath, temporaryPath, content) {
    removePromotionAliasTemporaryIfPresent(temporaryPath);
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_RDWR |
            (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW), WORK_ITEM_FILE_MODE);
        fs.fchmodSync(descriptor, WORK_ITEM_FILE_MODE);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
    try {
        fs.linkSync(temporaryPath, filePath);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST')
            throw error;
    }
    const published = readStablePromotionTarget(filePath, false, true);
    const temporary = readStablePromotionTarget(temporaryPath, false, true);
    if (published.content !== content ||
        temporary.content !== content ||
        !samePromotionInode(published.stats, temporary.stats)) {
        throw workRegistryTransactionInvalid('Work Item promotion desired alias publication is invalid.');
    }
    fsyncWorkRegistryDirectory(path.dirname(filePath));
    removePromotionAliasIfPresent(temporaryPath, content);
    fsyncWorkRegistryDirectory(path.dirname(filePath));
}
function removePromotionAliasTemporaryIfPresent(filePath) {
    const observed = readStablePromotionFileBytes(filePath, true, true, true);
    if (observed === null)
        return;
    if (observed.stats.nlink !== 1n) {
        throw workRegistryTransactionInvalid('Work Item promotion temporary alias has an unsafe link count.');
    }
    try {
        fs.unlinkSync(filePath);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT')
            throw error;
    }
}
function removePromotionAliasIfPresent(filePath, expectedContent) {
    const observed = readStablePromotionTarget(filePath, true, true);
    if (observed === null)
        return;
    if (expectedContent === null || observed.content !== expectedContent) {
        throw workRegistryTransactionInvalid('Work Item promotion alias content changed.');
    }
    try {
        fs.unlinkSync(filePath);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT')
            throw error;
    }
}
function readStablePromotionTarget(filePath, allowAbsent, allowLinked = false) {
    const observed = readStablePromotionFileBytes(filePath, allowAbsent, allowLinked);
    if (observed === null)
        return null;
    try {
        return {
            content: new TextDecoder('utf-8', { fatal: true }).decode(observed.bytes),
            stats: observed.stats,
        };
    }
    catch {
        throw workRegistryTransactionInvalid('Work Item promotion tracked file is not valid UTF-8.');
    }
}
function readStablePromotionFileBytes(filePath, allowAbsent, allowLinked = false, allowIncompleteMode = false) {
    const before = fs.lstatSync(filePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (before === undefined) {
        if (allowAbsent)
            return null;
        throw workRegistryTransactionInvalid('Work Item promotion file is missing.');
    }
    if (!before.isFile() ||
        before.isSymbolicLink() ||
        (!allowLinked && before.nlink !== 1n) ||
        (allowLinked && before.nlink !== 1n && before.nlink !== 2n) ||
        (process.platform !== 'win32' &&
            (allowIncompleteMode
                ? (before.mode & 511n & ~BigInt(WORK_ITEM_FILE_MODE)) !== 0n
                : (before.mode & 511n) !== BigInt(WORK_ITEM_FILE_MODE))) ||
        (typeof process.getuid === 'function' &&
            before.uid !== BigInt(process.getuid())) ||
        before.size > BigInt(MAX_WORK_REGISTRY_PROMOTION_TRANSACTION_BYTES)) {
        throw workRegistryTransactionInvalid('Work Item promotion tracked file is unsafe.');
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY |
            (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
        const openedBefore = fs.fstatSync(descriptor, { bigint: true });
        const bytes = fs.readFileSync(descriptor);
        const openedAfter = fs.fstatSync(descriptor, { bigint: true });
        const after = fs.lstatSync(filePath, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (after === undefined ||
            !sameStablePromotionSnapshot(before, openedBefore) ||
            !sameStablePromotionSnapshot(openedBefore, openedAfter) ||
            !sameStablePromotionSnapshot(openedAfter, after) ||
            BigInt(bytes.byteLength) !== openedBefore.size) {
            throw workRegistryTransactionInvalid('Work Item promotion tracked file changed while read.');
        }
        return {
            bytes,
            stats: after,
        };
    }
    catch (error) {
        if (error instanceof WorkRegistryPromotionCasMismatch)
            throw error;
        if (error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            String(error.code).startsWith('WORK_REGISTRY_')) {
            throw error;
        }
        throw workRegistryTransactionInvalid('Work Item promotion tracked file could not be read safely.');
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function assertStablePromotionTarget(filePath, expectedContent) {
    const observed = readStablePromotionTarget(filePath, false);
    if (observed.content !== expectedContent) {
        throw workRegistryTransactionInvalid('Work Item promotion target content changed.');
    }
}
function sameStablePromotionSnapshot(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.uid === right.uid &&
        left.gid === right.gid &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs);
}
function samePromotionInode(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function markWorkItemPromotionRollback(runtime, transaction) {
    const journalPath = workItemPromotionJournalPath(runtime, transaction);
    const rollbackPath = workItemPromotionRollbackJournalPath(runtime, transaction);
    const expected = `${canonicalJson(transaction)}\n`;
    const rollback = readStablePrivatePromotionFile(rollbackPath, true);
    const journal = readStablePrivatePromotionFile(journalPath, true);
    if (rollback !== null) {
        if (rollback !== expected || journal !== null) {
            throw workRegistryTransactionInvalid('Work Item promotion rollback intent conflicts with its journal.');
        }
        return;
    }
    if (journal !== expected) {
        throw workRegistryTransactionInvalid('Work Item promotion journal changed before rollback intent publication.');
    }
    fs.renameSync(journalPath, rollbackPath);
    // The durable filename is the transaction direction. Recovery must never
    // resume a forward commit after rollback has crossed this fsync boundary.
    fsyncWorkRegistryDirectory(runtime.journals);
    if (readStablePrivatePromotionFile(rollbackPath) !== expected) {
        throw workRegistryTransactionInvalid('Work Item promotion rollback intent changed during publication.');
    }
}
function removeWorkItemPromotionRollbackJournal(runtime, transaction) {
    removeExactWorkItemPromotionJournal(runtime, transaction, workItemPromotionRollbackJournalPath(runtime, transaction));
}
function removeWorkItemPromotionJournal(runtime, transaction) {
    removeExactWorkItemPromotionJournal(runtime, transaction, workItemPromotionJournalPath(runtime, transaction));
}
function removeExactWorkItemPromotionJournal(runtime, transaction, journalPath) {
    const current = readStablePrivatePromotionFile(journalPath, true);
    if (current === null)
        return;
    if (current !== `${canonicalJson(transaction)}\n`) {
        throw workRegistryTransactionInvalid('Work Item promotion journal changed before cleanup.');
    }
    fs.unlinkSync(journalPath);
    fsyncWorkRegistryDirectory(runtime.journals);
}
function workItemPromotionJournalPath(runtime, transaction) {
    return path.join(runtime.journals, `${transaction.operationId.replace(':', '-')}.json`);
}
function workItemPromotionRollbackJournalPath(runtime, transaction) {
    return path.join(runtime.journals, `${transaction.operationId.replace(':', '-')}.rollback.json`);
}
function readStablePrivatePromotionFile(filePath, allowAbsent = false) {
    const bytes = readStablePrivatePromotionFileBytes(filePath, allowAbsent);
    if (bytes === null)
        return null;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        throw workRegistryTransactionInvalid('Work Item promotion private file could not be read safely.');
    }
}
function readStablePrivatePromotionFileBytes(filePath, allowAbsent = false) {
    const before = fs.lstatSync(filePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (before === undefined) {
        if (allowAbsent)
            return null;
        throw workRegistryTransactionInvalid('Work Item promotion private file is missing.');
    }
    if (!before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        (process.platform !== 'win32' &&
            (before.mode & 511n) !== BigInt(WORK_REGISTRY_PRIVATE_FILE_MODE)) ||
        (typeof process.getuid === 'function' &&
            before.uid !== BigInt(process.getuid())) ||
        before.size > BigInt(MAX_WORK_REGISTRY_PROMOTION_TRANSACTION_BYTES)) {
        throw workRegistryTransactionInvalid('Work Item promotion private file is unsafe.');
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY |
            (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
        const openedBefore = fs.fstatSync(descriptor, { bigint: true });
        const bytes = fs.readFileSync(descriptor);
        const openedAfter = fs.fstatSync(descriptor, { bigint: true });
        const after = fs.lstatSync(filePath, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (after === undefined ||
            !sameStablePromotionSnapshot(before, openedBefore) ||
            !sameStablePromotionSnapshot(openedBefore, openedAfter) ||
            !sameStablePromotionSnapshot(openedAfter, after) ||
            BigInt(bytes.byteLength) !== openedBefore.size) {
            throw new Error('private file changed');
        }
        return bytes;
    }
    catch {
        throw workRegistryTransactionInvalid('Work Item promotion private file could not be read safely.');
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function removePrivatePromotionTemporaryFile(filePath) {
    const before = fs.lstatSync(filePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (before === undefined ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        (process.platform !== 'win32' &&
            (before.mode & 511n & ~BigInt(WORK_REGISTRY_PRIVATE_FILE_MODE)) !==
                0n) ||
        (typeof process.getuid === 'function' &&
            before.uid !== BigInt(process.getuid())) ||
        before.size > BigInt(MAX_WORK_REGISTRY_PROMOTION_TRANSACTION_BYTES)) {
        throw workRegistryTransactionInvalid('Work Item promotion private temporary file is unsafe.');
    }
    if (process.platform !== 'win32' &&
        (before.mode & 511n) !== BigInt(WORK_REGISTRY_PRIVATE_FILE_MODE)) {
        // The publication writer may stop between O_EXCL creation and fchmod.
        // Normalize only this recognized, owner-bound temporary so its raw bytes
        // can be re-observed without interpreting an incomplete UTF-8 payload.
        fs.chmodSync(filePath, WORK_REGISTRY_PRIVATE_FILE_MODE);
    }
    readStablePrivatePromotionFileBytes(filePath);
    fs.unlinkSync(filePath);
}
function parsePromotionItemContent(content) {
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        throw workRegistryTransactionInvalid('Work Item promotion item content is invalid.');
    }
    const item = parseWorkItem(value);
    if (content !== `${canonicalJson(item)}\n`) {
        throw workRegistryTransactionInvalid('Work Item promotion item content is noncanonical.');
    }
    return item;
}
function parsePromotionOriginContent(content) {
    try {
        return parseOrigin(content);
    }
    catch {
        throw workRegistryTransactionInvalid('Work Item promotion origin content is invalid.');
    }
}
function exactRepositoryRelativePath(repositoryRoot, filePath) {
    const relativePath = path
        .relative(fs.realpathSync(repositoryRoot), path.resolve(filePath))
        .replaceAll(path.sep, '/');
    if (!relativePath ||
        relativePath.startsWith('../') ||
        path.posix.normalize(relativePath) !== relativePath) {
        throw workRegistryTransactionInvalid('Work Item promotion path escapes the repository.');
    }
    return relativePath;
}
function isSafeWorkItemPromotionRelativePath(relativePath) {
    return (relativePath.length > 0 &&
        !path.isAbsolute(relativePath) &&
        !relativePath.startsWith('../') &&
        !relativePath.includes('\\') &&
        path.posix.normalize(relativePath) === relativePath);
}
function workItemPromotionParentRelativePaths(relativeFilePath) {
    const segments = path.posix.dirname(relativeFilePath).split('/');
    const parents = [];
    for (let index = 1; index <= segments.length; index += 1) {
        parents.push(segments.slice(0, index).join('/'));
    }
    return parents;
}
function captureWorkItemPromotionParentBindings(repositoryRoot, filePath) {
    const root = fs.realpathSync(repositoryRoot);
    const parent = path.dirname(path.resolve(filePath));
    const relativeParent = path.relative(root, parent).replaceAll(path.sep, '/');
    if (!relativeParent ||
        relativeParent.startsWith('../') ||
        path.posix.normalize(relativeParent) !== relativeParent) {
        throw workRegistryTransactionInvalid('Work Item promotion parent path escapes the repository.');
    }
    const bindings = [];
    let current = root;
    for (const segment of relativeParent.split('/')) {
        current = path.join(current, segment);
        const stats = fs.lstatSync(current, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (stats === undefined ||
            !stats.isDirectory() ||
            stats.isSymbolicLink() ||
            fs.realpathSync(current) !== path.resolve(current) ||
            (typeof process.getuid === 'function' &&
                stats.uid !== BigInt(process.getuid()))) {
            throw workRegistryTransactionInvalid('Work Item promotion parent directory is unsafe.');
        }
        bindings.push({
            relativePath: path.relative(root, current).replaceAll(path.sep, '/'),
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
        });
    }
    return bindings;
}
function workRegistryTextDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function fsyncWorkRegistryDirectory(directory) {
    let descriptor;
    try {
        descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
        fs.fsyncSync(descriptor);
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function workRegistryTransactionInvalid(message) {
    return workflowError('WORK_REGISTRY_TRANSACTION_INVALID', message, ExitCode.guard);
}
function workRegistryTransactionConflict(message) {
    return workflowError('WORK_REGISTRY_TRANSACTION_CONFLICT', message, ExitCode.conflict);
}
function createCanonicalFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = `${canonicalJson(value)}\n`;
    try {
        fs.writeFileSync(filePath, content, {
            encoding: 'utf8',
            flag: 'wx',
            mode: WORK_ITEM_FILE_MODE,
        });
    }
    catch (error) {
        if (isNodeError(error) &&
            error.code === 'EEXIST' &&
            readWorkItemRecord(filePath).serialized === content) {
            return;
        }
        if (isNodeError(error) && error.code === 'EEXIST') {
            throw registryInvalid('A different Work Item already owns this identity.');
        }
        throw error;
    }
}
function replaceCanonicalFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${canonicalJson(value)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: WORK_ITEM_FILE_MODE,
    });
    try {
        fs.renameSync(temporary, filePath);
    }
    finally {
        fs.rmSync(temporary, { force: true });
    }
}
function readOptionalPlainFile(filePath) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats)
        return null;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw registryInvalid('Work Registry path is unsafe.');
    }
    return fs.readFileSync(filePath, 'utf8');
}
function createMonotonicWorkItemId(timestamp) {
    const time = BigInt(new Date(timestamp).valueOf());
    const random = crypto.randomBytes(10);
    let value = (time << 80n) | BigInt(`0x${random.toString('hex')}`);
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let encoded = '';
    for (let index = 0; index < 26; index += 1) {
        encoded = alphabet[Number(value & 31n)] + encoded;
        value >>= 5n;
    }
    return `WORK-${encoded}`;
}
function workItemId(value) {
    if (!/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
        throw registryInvalid('Work Item identity is invalid.');
    }
    return value;
}
function workItemKind(value) {
    if (!['feature', 'bug', 'improvement', 'chore', 'research'].includes(value)) {
        throw registryInvalid('Work Item kind is invalid.');
    }
    return value;
}
function workItemLane(value) {
    if (value !== null &&
        !['now', 'next', 'later', 'icebox'].includes(String(value))) {
        throw registryInvalid('Work Item lane is invalid.');
    }
    return value;
}
function sourceReferences(value) {
    if (!Array.isArray(value))
        throw registryInvalid('Source references are invalid.');
    const refs = value.map((entry) => {
        if (!/^SRC-[0-9a-f]{64}$/.test(entry)) {
            throw registryInvalid('Source reference is invalid.');
        }
        return entry;
    });
    if (new Set(refs).size !== refs.length) {
        throw registryInvalid('Source references are duplicated.');
    }
    return refs.sort();
}
function workItemReferences(value) {
    if (!Array.isArray(value)) {
        throw registryInvalid('Work Item references are invalid.');
    }
    const refs = value.map((entry) => workItemId(entry));
    if (new Set(refs).size !== refs.length) {
        throw registryInvalid('Work Item references are duplicated.');
    }
    return refs.sort();
}
function workItemAliases(value) {
    if (!Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string' || !/^ISS-[0-9]+$/.test(entry))) {
        throw registryInvalid('Work Item aliases are invalid.');
    }
    const aliases = [...value].sort();
    if (new Set(aliases).size !== aliases.length) {
        throw registryInvalid('Work Item aliases are duplicated.');
    }
    return aliases;
}
function exactDigest(value) {
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw registryInvalid('Work Item review digest is invalid.');
    }
    return value;
}
function compareWorkItems(left, right) {
    const lanes = {
        now: 0,
        next: 1,
        later: 2,
        icebox: 3,
        none: 4,
    };
    return (lanes[left.lane ?? 'none'] - lanes[right.lane ?? 'none'] ||
        left.id.localeCompare(right.id));
}
function renderBacklogProjection(repositoryRoot, items) {
    const open = items
        .filter((item) => item.stage !== 'closed')
        .sort(compareWorkItems);
    const body = [
        '# Backlog',
        '',
        '<!-- Generated by jigwright work-item render. -->',
        '',
        ...(open.length === 0
            ? ['No open Work Items.', '']
            : open.flatMap((item) => [
                `- **${item.id} — ${item.title}** (${item.stage}, ${item.lane ?? 'unprioritized'})`,
                `  - ${item.interpretation.summary.replaceAll('\n', ' ')}`,
                ...(item.sourceRefs.length > 0
                    ? [
                        `  - Sources: ${item.sourceRefs.map((sourceRef) => renderBacklogSourceLink(repositoryRoot, sourceRef)).join(', ')}`,
                    ]
                    : []),
                ...(item.blockedBy.length > 0
                    ? [`  - Blocked by: ${item.blockedBy.join(', ')}`]
                    : []),
            ])),
    ].join('\n');
    return `${body.trimEnd()}\n`;
}
function renderBacklogSourceLink(repositoryRoot, sourceRef) {
    const digest = sourceRef.slice('SRC-'.length);
    const registry = repositoryWorkRegistryConfiguration(repositoryRoot);
    const target = path.posix.join(GOVERNANCE_SOURCE_LEDGER_ROOT, digest.slice(0, 2), `${digest}.json`);
    const relative = path.posix.relative(path.posix.dirname(registry.backlogPath), target);
    return `[${sourceRef}](${relative})`;
}
function closedWorkItemsByYear(items) {
    const byYear = new Map();
    for (const item of items.filter((candidate) => candidate.stage === 'closed')) {
        const year = item.closure.at.slice(0, 4);
        byYear.set(year, [...(byYear.get(year) ?? []), item]);
    }
    return byYear;
}
function renderHistoryProjection(year, closed) {
    return [
        `# Work history ${year}`,
        '',
        '<!-- Generated by jigwright work-item render. -->',
        '',
        ...[...closed]
            .sort(compareWorkItems)
            .map((item) => `- **${item.id} — ${item.title}** (${item.closure.outcome}${item.closure.changeId ? `; ${item.closure.changeId}` : ''})`),
        '',
    ].join('\n');
}
function loadWorkRegistryTransitionPolicy(repositoryRoot) {
    const policyPath = repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).transitionPolicyPath);
    const source = readOptionalPlainFile(policyPath);
    if (source === null) {
        return {
            schemaVersion: 1,
            transitions: {
                intake: 'ordinary',
                prioritize: 'ordinary',
                promote: 'ordinary',
            },
        };
    }
    let value;
    try {
        value = JSON.parse(source);
    }
    catch {
        throw registryInvalid('Work Registry transition policy is invalid.');
    }
    if (!isRecord(value) ||
        !hasExactKeys(value, ['schemaVersion', 'transitions']) ||
        value.schemaVersion !== 1 ||
        !isRecord(value.transitions) ||
        !hasExactKeys(value.transitions, ['intake', 'prioritize', 'promote']) ||
        !['ordinary', 'central-grant'].includes(String(value.transitions.intake)) ||
        !['ordinary', 'central-grant'].includes(String(value.transitions.prioritize)) ||
        !['ordinary', 'central-grant'].includes(String(value.transitions.promote))) {
        throw registryInvalid('Work Registry transition policy is invalid.');
    }
    return value;
}
function assertNoProspectiveCycle(repositoryRoot, itemId, blockedBy) {
    const items = listWorkItems(repositoryRoot).map((item) => item.id === itemId ? { ...item, blockedBy } : item);
    assertNoCycles(items);
}
function assertNoCycles(items) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
        if (visiting.has(id)) {
            throw registryInvalid('Work Item blocking graph contains a cycle.');
        }
        if (visited.has(id))
            return;
        visiting.add(id);
        for (const blocker of byId.get(id)?.blockedBy ?? [])
            visit(blocker);
        visiting.delete(id);
        visited.add(id);
    };
    for (const item of items)
        visit(item.id);
}
function listOriginPaths(repositoryRoot) {
    const changesRoot = repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot);
    const stats = fs.lstatSync(changesRoot, { throwIfNoEntry: false });
    if (!stats)
        return [];
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw registryInvalid('OpenSpec change root is unsafe.');
    }
    const paths = [];
    const visit = (directory, depth) => {
        if (depth > 2)
            return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                throw registryInvalid('Change origin tree contains a symbolic link.');
            }
            if (entry.isDirectory()) {
                visit(target, depth + 1);
            }
            else if (entry.isFile() && entry.name === 'origin.json') {
                paths.push(target);
            }
        }
    };
    visit(changesRoot, 0);
    return paths.sort();
}
function originChangeId(repositoryRoot, originPath) {
    const changesRoot = repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot);
    const relative = path
        .relative(changesRoot, originPath)
        .replaceAll(path.sep, '/');
    const segments = relative.split('/');
    if (segments.length === 2)
        return changeIdentity(segments[0]);
    if (segments.length === 3 && segments[0] === 'archive') {
        return changeIdentity(segments[1].replace(/^\d{4}-\d{2}-\d{2}-/, ''));
    }
    throw registryInvalid('Change origin path is invalid.');
}
function findOriginForChange(repositoryRoot, changeId) {
    const matches = listOriginPaths(repositoryRoot).filter((originPath) => originChangeId(repositoryRoot, originPath) === changeId);
    if (matches.length !== 1) {
        throw registryInvalid('Linked change must resolve to one origin file.');
    }
    return matches[0];
}
function readSourceValue(repositoryRoot, sourceRef) {
    return readGovernanceSource(repositoryRoot, sourceRef);
}
function replaceTextFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const before = readOptionalPlainFile(filePath);
    if (before === content)
        return;
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o644,
    });
    try {
        fs.renameSync(temporary, filePath);
    }
    finally {
        fs.rmSync(temporary, { force: true });
    }
}
function boundedText(value, maximum, field) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        Buffer.byteLength(value, 'utf8') > maximum ||
        value.includes('\0')) {
        throw registryInvalid(`Work Item ${field} is invalid.`);
    }
    return value;
}
function linkedSourceInterpretationSummary(sourceRefs) {
    return boundedText(`Interpret and disposition linked Sources: ${sourceRefs.join(', ')}.`, 2_000, 'summary');
}
function changeIdentity(value) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
        throw registryInvalid('Change identity is invalid.');
    }
    return value;
}
function canonicalTimestamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
        throw registryInvalid('Work Item timestamp is invalid.');
    }
    return value;
}
function registryInvalid(message) {
    return workflowError('WORK_REGISTRY_INVALID', message, ExitCode.usage);
}
function projectionDrift(message) {
    return workflowError('WORK_REGISTRY_PROJECTION_DRIFT', message, ExitCode.verification, { recovery: 'Run `pnpm workflow work-item render --json`.' });
}
function promotionIneligible(message) {
    return workflowError('WORK_REGISTRY_PROMOTION_INELIGIBLE', message, ExitCode.conflict);
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    return (actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]));
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
