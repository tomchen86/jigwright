/** Derived Work Registry projections, rendering, and drift validation. Canonical reads and locks are bound by the registry facade. */
import { createProjectionService } from "../projection/projection-service.js";
import { repositoryWorkRegistryConfiguration, repositoryConsumerPath, } from "../repository-consumer/repository-consumer-config.js";
import { canonicalJson } from '@jigwright/core/canonical-json';
import path from 'node:path';
import fs from 'node:fs';
import { GOVERNANCE_SOURCE_LEDGER_ROOT } from '@jigwright/core/repository-consumer-port';
import crypto from 'node:crypto';
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
export function createWorkRegistryProjectionOperations(bindings) {
    const { withWorkRegistryPromotionLockWhenAvailable, validateWorkRegistryUnlocked, listWorkItemsUnlocked, inspectWorkRegistryUnlocked, readOptionalPlainFile, validateWorkRegistry, } = bindings;
    function renderWorkRegistry(repositoryRoot) {
        return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => renderWorkRegistryUnlocked(repositoryRoot));
    }
    function renderWorkRegistryUnlocked(repositoryRoot) {
        const service = workRegistryProjectionService(repositoryRoot);
        const backlogPath = service.project('registry.backlog')[0].path;
        const inventoryPath = service.project('registry.inventory')[0].path;
        const historyPaths = service
            .project('registry.work-history')
            .map(({ path }) => path);
        return { backlogPath, inventoryPath, historyPaths };
    }
    /** Sources are snapshots of validated records; the service owns projection IO. */
    function workRegistryProjectionBindings(repositoryRoot) {
        validateWorkRegistryUnlocked(repositoryRoot, {});
        const registry = repositoryWorkRegistryConfiguration(repositoryRoot);
        const items = listWorkItemsUnlocked(repositoryRoot);
        const backlog = [
            {
                path: repositoryConsumerPath(repositoryRoot, registry.backlogPath),
                content: renderBacklogProjection(repositoryRoot, items),
            },
        ];
        const inventory = [
            {
                path: repositoryConsumerPath(repositoryRoot, registry.inventoryPath),
                content: `${canonicalJson(inspectWorkRegistryUnlocked(repositoryRoot))}\n`,
            },
        ];
        const history = [...closedWorkItemsByYear(items).entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([year, closed]) => ({
            path: path.join(repositoryConsumerPath(repositoryRoot, registry.historyRoot), `${year}.md`),
            content: renderHistoryProjection(year, closed),
        }));
        return [
            {
                id: 'registry.backlog',
                targetPaths: backlog.map(({ path }) => path),
                source: () => backlog,
            },
            {
                id: 'registry.inventory',
                targetPaths: inventory.map(({ path }) => path),
                source: () => inventory,
            },
            {
                id: 'registry.work-history',
                targetPaths: history.map(({ path }) => path),
                source: () => history,
            },
        ];
    }
    function workRegistryProjectionService(repositoryRoot, bindings = workRegistryProjectionBindings(repositoryRoot)) {
        return createProjectionService(bindings, {
            read: readOptionalPlainFile,
            write: replaceTextFile,
        });
    }
    function inspectWorkRegistryProjectionStatus(repositoryRoot) {
        const statuses = workRegistryProjectionService(repositoryRoot).status();
        const historyRoot = repositoryConsumerPath(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).historyRoot);
        const stats = fs.lstatSync(historyRoot, { throwIfNoEntry: false });
        if (stats !== undefined) {
            if (!stats.isDirectory() || stats.isSymbolicLink())
                throw projectionDrift('Work Registry history root is unsafe.');
            const expected = new Set(statuses
                .filter(({ id }) => id === 'registry.work-history')
                .map(({ path }) => path));
            for (const entry of fs.readdirSync(historyRoot)) {
                const target = path.join(historyRoot, entry);
                if (!expected.has(target))
                    statuses.push({
                        id: 'registry.work-history',
                        path: target,
                        state: 'unexpected',
                        version: null,
                        expectedVersion: 1,
                        digest: null,
                        expectedDigest: null,
                    });
            }
        }
        return statuses;
    }
    /**
     * Verify deterministic registry views after a consumer has activated them.
     * A consumer may omit generated Markdown entirely; once any projection exists,
     * the whole current projection set must be complete and byte-current.
     */
    function validateWorkRegistryProjections(repositoryRoot) {
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
        const bindings = workRegistryProjectionBindings(repositoryRoot);
        const expected = new Map(bindings.flatMap((binding) => binding.source().map(({ path, content }) => [path, content])));
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
        for (const status of workRegistryProjectionService(repositoryRoot, bindings).status()) {
            if (status.state !== 'current') {
                throw projectionDrift(`Work Registry projection is stale: ${path.relative(repositoryRoot, status.path).replaceAll(path.sep, '/')}`);
            }
        }
        return { projectionCount: expected.size };
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
    function projectionDrift(message) {
        return workflowError('WORK_REGISTRY_PROJECTION_DRIFT', message, ExitCode.verification, { recovery: 'Run `pnpm workflow work-item render --json`.' });
    }
    return {
        renderWorkRegistry,
        workRegistryProjectionBindings,
        inspectWorkRegistryProjectionStatus,
        validateWorkRegistryProjections,
    };
}
