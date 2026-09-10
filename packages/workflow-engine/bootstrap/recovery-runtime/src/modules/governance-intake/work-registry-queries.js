/**
 * Discovers Work Items, traces provenance, and validates registry
 * relationships.
 *
 * Invariants:
 * - Canonical validation rejects duplicate Governance Source identities.
 */
import { registryInvalid, boundedText, parseOrigin, changeIdentity, } from "./work-registry-record.js";
import fs from 'node:fs';
import path from 'node:path';
import { readGovernanceSource, listGovernanceSources, } from "./governance-intake.js";
import { repositoryConsumerConfigurationExists, repositoryWorkRegistryConfiguration, repositoryConsumerPath, } from "../repository-consumer/repository-consumer-config.js";
export function createWorkRegistryQueries(bindings) {
    const { withWorkRegistryPromotionLockWhenAvailable, listWorkItemPaths, readWorkItem, listWorkItemPathsUnlocked, withWorkRegistryPromotionReadLockWhenAvailable, readSourceValue, readSource, readOptionalPlainFile, } = bindings;
    function showWorkItem(repositoryRoot, requestedId) {
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
    function listWorkItems(repositoryRoot) {
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
    function recommendWorkItemPriorities(repositoryRoot) {
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
    function inspectWorkRegistry(repositoryRoot) {
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
    function searchWorkItems(repositoryRoot, requestedQuery) {
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
    function findWorkItemsByExactSourceText(repositoryRoot, exactText) {
        return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => listWorkItems(repositoryRoot).filter((item) => item.sourceRefs.some((sourceRef) => readSourceValue(repositoryRoot, sourceRef).text === exactText)));
    }
    function traceWorkItem(repositoryRoot, requestedId, testHooks = {}) {
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
    function traceGovernanceSource(repositoryRoot, requestedSourceId) {
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
    function validateWorkRegistry(repositoryRoot, testHooks = {}) {
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
    function validateCurrentChangeOrigin(repositoryRoot, requestedChangeId) {
        readCurrentChangeOrigin(repositoryRoot, requestedChangeId);
    }
    function readCurrentChangeOrigin(repositoryRoot, requestedChangeId) {
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
    return {
        showWorkItem,
        listWorkItems,
        recommendWorkItemPriorities,
        inspectWorkRegistry,
        searchWorkItems,
        findWorkItemsByExactSourceText,
        traceWorkItem,
        traceGovernanceSource,
        validateWorkRegistry,
        validateCurrentChangeOrigin,
        readCurrentChangeOrigin,
        assertNoProspectiveCycle,
        showWorkItemUnlocked,
        validateWorkRegistryUnlocked,
        listWorkItemsUnlocked,
        inspectWorkRegistryUnlocked,
    };
}
