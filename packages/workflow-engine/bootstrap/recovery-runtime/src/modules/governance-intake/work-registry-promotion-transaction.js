/**
 * Work Registry promotion transaction protocol. Journal publication, the shared
 * registry lock, exact receipts, tracked-file CAS, and rollback/recovery remain
 * together so their durable ordering has one owner.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { repositoryWorkRegistryConfiguration } from "../repository-consumer/repository-consumer-config.js";
import { WORK_ITEM_FILE_MODE, changeIdentity, exactDigest, hasExactKeys, isNodeError, isRecord, parseOrigin, parseWorkItem, workItemDigest, workRegistryTextDigest, } from "./work-registry-record.js";
const WORK_REGISTRY_PRIVATE_FILE_MODE = 0o600;
const WORK_REGISTRY_PRIVATE_DIRECTORY_MODE = 0o700;
const WORK_REGISTRY_PROMOTION_TRANSACTION_KIND = 'work-registry-promotion-transaction.v1';
const MAX_WORK_REGISTRY_PROMOTION_TRANSACTION_BYTES = 512 * 1024;
const activeWorkRegistryPromotionRoots = new Set();
export class WorkRegistryPromotionCasMismatch extends Error {
}
export function createWorkItemPromotionTransaction(repositoryRoot, itemPath, originPath, itemBefore, originBefore, promoted, origin, grantBinding) {
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
export function recoverWorkItemPromotionTransactionsUnlocked(runtime) {
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
/** Bind the existing registry runtime edge once; lock and recovery remain synchronous. */
export function createWorkRegistryPromotionLocks({ publishPreparedExclusiveLock, reclaimDeadPreparedLock, runGit, }) {
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
    return {
        withWorkRegistryPromotionLock,
        withWorkRegistryPromotionLockWhenAvailable,
        withWorkRegistryPromotionReadLockWhenAvailable,
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
export function publishWorkItemPromotionTransaction(runtime, requested) {
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
export function publishRecoveredWorkItemPromotion(runtime, transaction) {
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
export function replayRecoveredWorkItemPromotion(runtime, workItemId, changeId, requestedExpectedDigest, grantBinding) {
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
export function findExactRecoveredWorkItemPromotion(runtime, workItemId, changeId, requestedExpectedDigest, grantBinding) {
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
export function applyWorkItemPromotionTransaction(runtime, transaction, testHooks) {
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
export function abortWorkItemPromotionTransaction(runtime, transaction, testHooks) {
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
export function readStablePromotionTarget(filePath, allowAbsent, allowLinked = false) {
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
export function markWorkItemPromotionRollback(runtime, transaction) {
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
export function removeWorkItemPromotionJournal(runtime, transaction) {
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
export function parsePromotionItemContent(content) {
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
export function workRegistryTransactionConflict(message) {
    return workflowError('WORK_REGISTRY_TRANSACTION_CONFLICT', message, ExitCode.conflict);
}
