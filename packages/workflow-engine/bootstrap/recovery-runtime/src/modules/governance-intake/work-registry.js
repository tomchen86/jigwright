import { createWorkRegistryQueries } from "./work-registry-queries.js";
import { createWorkRegistryStorage } from "./work-registry-storage.js";
import { createWorkRegistryPromotionPreparation } from "./work-registry-promotion-preparation.js";
import { createWorkRegistryProjectionOperations } from "./work-registry-projections.js";
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
import { canonicalJson } from '@jigwright/core/canonical-json';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { publishPreparedExclusiveLock, reclaimDeadPreparedLock, runGit, } from "../../runtime/repository-transaction/git.js";
import { repositoryConsumerPath, repositoryWorkRegistryConfiguration, } from "../repository-consumer/repository-consumer-config.js";
import { readGovernanceSource } from "./governance-intake.js";
import { ORIGIN_KEYS, boundedText, canonicalTimestamp, changeIdentity, exactDigest, hasExactKeys, isRecord, parseOrigin, registryInvalid, sourceReferences, workItemDigest, workItemId, workItemKind, workItemLane, workItemReferences, } from "./work-registry-record.js";
import { WorkRegistryPromotionCasMismatch, abortWorkItemPromotionTransaction, applyWorkItemPromotionTransaction, createWorkRegistryPromotionLocks, createWorkItemPromotionTransaction, findExactRecoveredWorkItemPromotion, markWorkItemPromotionRollback, parsePromotionItemContent, publishRecoveredWorkItemPromotion, publishWorkItemPromotionTransaction, readStablePromotionTarget, recoverWorkItemPromotionTransactionsUnlocked, removeWorkItemPromotionJournal, replayRecoveredWorkItemPromotion, workRegistryTransactionConflict, } from "./work-registry-promotion-transaction.js";
const { withWorkRegistryPromotionLock, withWorkRegistryPromotionLockWhenAvailable, withWorkRegistryPromotionReadLockWhenAvailable, } = createWorkRegistryPromotionLocks({
    publishPreparedExclusiveLock,
    reclaimDeadPreparedLock,
    runGit,
});
export { workItemDigest } from "./work-registry-record.js";
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
                summary: ['bug', 'chore', 'research'].includes(item.kind)
                    ? item.interpretation.summary
                    : linkedSourceInterpretationSummary(sourceRefs),
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
export function workRegistryTransitionRequiresGrant(repositoryRoot, transition) {
    return (loadWorkRegistryTransitionPolicy(repositoryRoot).transitions[transition] ===
        'central-grant');
}
export function assertOrdinaryWorkRegistryTransition(repositoryRoot, transition, recovery, details) {
    if (!workRegistryTransitionRequiresGrant(repositoryRoot, transition))
        return;
    throw workflowError('WORK_REGISTRY_GRANT_REQUIRED', `Repository policy requires Central Grant for the ${transition} transition.`, ExitCode.guard, { recovery, ...(details === undefined ? {} : { details }) });
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
function readSource(repositoryRoot, sourceRef) {
    readSourceValue(repositoryRoot, sourceRef);
}
function assertChangeDirectory(repositoryRoot, changeId) {
    const changeDirectory = path.join(repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot), changeId);
    const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
        throw registryInvalid('Promotion requires an existing plain change directory.');
    }
    return changeDirectory;
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
function readSourceValue(repositoryRoot, sourceRef) {
    return readGovernanceSource(repositoryRoot, sourceRef);
}
function linkedSourceInterpretationSummary(sourceRefs) {
    return boundedText(`Interpret and disposition linked Sources: ${sourceRefs.join(', ')}.`, 2_000, 'summary');
}
function promotionIneligible(message) {
    return workflowError('WORK_REGISTRY_PROMOTION_INELIGIBLE', message, ExitCode.conflict);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const workRegistryStorage = createWorkRegistryStorage({
    withWorkRegistryPromotionLockWhenAvailable,
});
const createCanonicalFile = workRegistryStorage.createCanonicalFile;
const findWorkItemPath = workRegistryStorage.findWorkItemPath;
const readWorkItem = workRegistryStorage.readWorkItem;
const replaceCanonicalFile = workRegistryStorage.replaceCanonicalFile;
const listWorkItemPaths = workRegistryStorage.listWorkItemPaths;
const readWorkItemRecord = workRegistryStorage.readWorkItemRecord;
const readOptionalPlainFile = workRegistryStorage.readOptionalPlainFile;
const listWorkItemPathsUnlocked = workRegistryStorage.listWorkItemPathsUnlocked;
const workRegistryQueries = createWorkRegistryQueries({
    withWorkRegistryPromotionLockWhenAvailable,
    listWorkItemPaths,
    readWorkItem,
    listWorkItemPathsUnlocked,
    withWorkRegistryPromotionReadLockWhenAvailable,
    readSourceValue,
    readSource,
    readOptionalPlainFile,
});
export const showWorkItem = workRegistryQueries.showWorkItem;
export const listWorkItems = workRegistryQueries.listWorkItems;
export const recommendWorkItemPriorities = workRegistryQueries.recommendWorkItemPriorities;
export const inspectWorkRegistry = workRegistryQueries.inspectWorkRegistry;
export const searchWorkItems = workRegistryQueries.searchWorkItems;
export const findWorkItemsByExactSourceText = workRegistryQueries.findWorkItemsByExactSourceText;
export const traceWorkItem = workRegistryQueries.traceWorkItem;
export const traceGovernanceSource = workRegistryQueries.traceGovernanceSource;
export const validateWorkRegistry = workRegistryQueries.validateWorkRegistry;
export const validateCurrentChangeOrigin = workRegistryQueries.validateCurrentChangeOrigin;
export const readCurrentChangeOrigin = workRegistryQueries.readCurrentChangeOrigin;
const assertNoProspectiveCycle = workRegistryQueries.assertNoProspectiveCycle;
const showWorkItemUnlocked = workRegistryQueries.showWorkItemUnlocked;
const validateWorkRegistryUnlocked = workRegistryQueries.validateWorkRegistryUnlocked;
const listWorkItemsUnlocked = workRegistryQueries.listWorkItemsUnlocked;
const inspectWorkRegistryUnlocked = workRegistryQueries.inspectWorkRegistryUnlocked;
const workRegistryProjectionOperations = createWorkRegistryProjectionOperations({
    withWorkRegistryPromotionLockWhenAvailable,
    validateWorkRegistryUnlocked,
    listWorkItemsUnlocked,
    inspectWorkRegistryUnlocked,
    readOptionalPlainFile,
    validateWorkRegistry,
});
export const renderWorkRegistry = workRegistryProjectionOperations.renderWorkRegistry;
export const workRegistryProjectionBindings = workRegistryProjectionOperations.workRegistryProjectionBindings;
export const inspectWorkRegistryProjectionStatus = workRegistryProjectionOperations.inspectWorkRegistryProjectionStatus;
export const validateWorkRegistryProjections = workRegistryProjectionOperations.validateWorkRegistryProjections;
const workRegistryPromotionPreparation = createWorkRegistryPromotionPreparation({
    withWorkRegistryPromotionLockWhenAvailable,
    showWorkItem,
    assertPromotionEligible,
    assertChangeDirectory,
    runGit,
    replaceCanonicalFile,
    readOptionalPlainFile,
    showWorkItemUnlocked,
    readSourceValue,
});
export const prepareWorkItemPromotionSurvey = workRegistryPromotionPreparation.prepareWorkItemPromotionSurvey;
export const ensureWorkItemPromotionSurveyBinding = workRegistryPromotionPreparation.ensureWorkItemPromotionSurveyBinding;
export const ensureWorkItemPromotionChangeDirectory = workRegistryPromotionPreparation.ensureWorkItemPromotionChangeDirectory;
export const observeWorkItemPromotionPreparationBinding = workRegistryPromotionPreparation.observeWorkItemPromotionPreparationBinding;
export const prepareWorkItemPromotionFromBinding = workRegistryPromotionPreparation.prepareWorkItemPromotionFromBinding;
export const workItemPromotionPreparationMatches = workRegistryPromotionPreparation.workItemPromotionPreparationMatches;
export const observeWorkItemPromotionSurveyBinding = workRegistryPromotionPreparation.observeWorkItemPromotionSurveyBinding;
export const readWorkItemPromotionSurveyBinding = workRegistryPromotionPreparation.readWorkItemPromotionSurveyBinding;
const observePromotionSurveyBinding = workRegistryPromotionPreparation.observePromotionSurveyBinding;
const promotionGrantStale = workRegistryPromotionPreparation.promotionGrantStale;
