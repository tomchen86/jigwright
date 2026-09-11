/** Coordinates validated registry snapshots and the shared projection grammar/CAS service. */
import path from 'node:path';
import { canonicalJson } from '@jigwright/core/canonical-json';
import type { RepositoryWorkRegistryConfigurationV1 } from '@jigwright/core/repository-consumer-port';
import {
  createProjectionService,
  type ProjectionBinding,
  type ProjectionStatus,
  type ProjectionIO,
} from '../../modules/projection/projection-service.ts';
import {
  renderBacklogProjection,
  renderHistoryProjection,
  closedWorkItemsByYear,
  backlogWorkItems,
  projectionDrift,
} from '../../modules/governance-intake/work-registry-projections.ts';
import type { WorkItemV1 } from '../../modules/governance-intake/work-registry-contracts.ts';
import type {
  createWorkRegistryQueries,
  WorkRegistryReadCapabilities,
} from './work-registry-queries.ts';
export type WorkRegistryProjectionStorage = Pick<
  ProjectionIO,
  'read' | 'write'
> &
  Readonly<{
    readLayout(root: string): RepositoryWorkRegistryConfigurationV1;
    resolvePath(root: string, relativePath: string): string;
    exists(target: string): boolean;
    historyState(target: string): 'absent' | 'directory' | 'unsafe';
    listHistoryPaths(historyRoot: string, strict: boolean): string[];
  }>;
export type WorkRegistryProjectionQueries = Pick<
  ReturnType<typeof createWorkRegistryQueries>,
  | 'validateWorkRegistryUnlocked'
  | 'listWorkItemsUnlocked'
  | 'inspectWorkRegistryUnlocked'
  | 'validateWorkRegistry'
>;
export function createWorkRegistryProjectionOperations(
  queries: WorkRegistryProjectionQueries,
  storage: WorkRegistryProjectionStorage,
  withWorkRegistryPromotionLockWhenAvailable: WorkRegistryReadCapabilities['withWorkRegistryPromotionLockWhenAvailable'],
  readSourceText: (root: string, id: string) => string,
) {
  const {
    validateWorkRegistryUnlocked,
    listWorkItemsUnlocked,
    inspectWorkRegistryUnlocked,
    validateWorkRegistry,
  } = queries;
  const readOptionalPlainFile = storage.read;
  const repositoryConsumerPath = storage.resolvePath;
  function renderBacklogForRepository(
    root: string,
    items: readonly WorkItemV1[],
  ): string {
    const sourceTexts = new Map(
      backlogWorkItems(items).map(
        (item) =>
          [
            item.id,
            item.sourceRefs.map((id) => readSourceText(root, id)),
          ] as const,
      ),
    );
    return renderBacklogProjection(sourceTexts, items);
  }
  function renderWorkRegistry(repositoryRoot: string): {
    backlogPath: string;
    inventoryPath: string;
    historyPaths: string[];
  } {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      renderWorkRegistryUnlocked(repositoryRoot),
    );
  }

  function renderWorkRegistryUnlocked(repositoryRoot: string): {
    backlogPath: string;
    inventoryPath: string;
    historyPaths: string[];
  } {
    const service = workRegistryProjectionService(repositoryRoot);
    const backlogPath = service.project('registry.backlog')[0]!.path;
    const inventoryPath = service.project('registry.inventory')[0]!.path;
    const historyPaths = service
      .project('registry.work-history')
      .map(({ path }) => path);
    return { backlogPath, inventoryPath, historyPaths };
  }

  /** Sources are snapshots of validated records; the service owns projection IO. */
  function workRegistryProjectionBindings(
    repositoryRoot: string,
  ): ProjectionBinding[] {
    validateWorkRegistryUnlocked(repositoryRoot, {});
    const registry = storage.readLayout(repositoryRoot);
    const items = listWorkItemsUnlocked(repositoryRoot);
    const backlog = [
      {
        path: repositoryConsumerPath(repositoryRoot, registry.backlogPath),
        content: renderBacklogForRepository(repositoryRoot, items),
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
        path: path.join(
          repositoryConsumerPath(repositoryRoot, registry.historyRoot),
          `${year}.md`,
        ),
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

  function workRegistryProjectionService(
    repositoryRoot: string,
    bindings = workRegistryProjectionBindings(repositoryRoot),
  ) {
    return createProjectionService(bindings, {
      read: readOptionalPlainFile,
      write: storage.write,
    });
  }

  function inspectWorkRegistryProjectionStatus(
    repositoryRoot: string,
  ): ProjectionStatus[] {
    const statuses = workRegistryProjectionService(repositoryRoot).status();
    const historyRoot = repositoryConsumerPath(
      repositoryRoot,
      storage.readLayout(repositoryRoot).historyRoot,
    );
    const state = storage.historyState(historyRoot);
    if (state !== 'absent') {
      if (state === 'unsafe')
        throw projectionDrift('Work Registry history root is unsafe.');
      const expected = new Set(
        statuses
          .filter(({ id }) => id === 'registry.work-history')
          .map(({ path }) => path),
      );
      for (const target of storage.listHistoryPaths(historyRoot, false)) {
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
  function validateWorkRegistryProjections(repositoryRoot: string): {
    projectionCount: number;
  } {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      validateWorkRegistryProjectionsUnlocked(repositoryRoot),
    );
  }

  function validateWorkRegistryProjectionsUnlocked(repositoryRoot: string): {
    projectionCount: number;
  } {
    validateWorkRegistry(repositoryRoot);
    const registry = storage.readLayout(repositoryRoot);
    const backlogPath = repositoryConsumerPath(
      repositoryRoot,
      registry.backlogPath,
    );
    const inventoryPath = repositoryConsumerPath(
      repositoryRoot,
      registry.inventoryPath,
    );
    const historyRoot = repositoryConsumerPath(
      repositoryRoot,
      registry.historyRoot,
    );
    const historyState = storage.historyState(historyRoot);
    const activated =
      storage.exists(backlogPath) ||
      storage.exists(inventoryPath) ||
      historyState !== 'absent';
    if (!activated) return { projectionCount: 0 };
    if (historyState === 'unsafe') {
      throw projectionDrift('Work Registry history root is unsafe.');
    }

    const bindings = workRegistryProjectionBindings(repositoryRoot);
    const expected = new Map(
      bindings.flatMap((binding) =>
        binding.source().map(({ path, content }) => [path, content] as const),
      ),
    );
    const actualHistoryPaths =
      historyState === 'absent'
        ? []
        : storage.listHistoryPaths(historyRoot, true);
    const expectedHistoryPaths = [...expected.keys()].filter((filePath) =>
      filePath.startsWith(`${historyRoot}${path.sep}`),
    );
    if (
      actualHistoryPaths.length !== expectedHistoryPaths.length ||
      actualHistoryPaths.some((filePath) => !expected.has(filePath))
    ) {
      throw projectionDrift('Work Registry history projection is stale.');
    }
    for (const status of workRegistryProjectionService(
      repositoryRoot,
      bindings,
    ).status()) {
      if (status.state !== 'current') {
        throw projectionDrift(
          `Work Registry projection is stale: ${path.relative(repositoryRoot, status.path).replaceAll(path.sep, '/')}`,
        );
      }
    }
    return { projectionCount: expected.size };
  }

  return {
    renderWorkRegistry,
    workRegistryProjectionBindings,
    inspectWorkRegistryProjectionStatus,
    validateWorkRegistryProjections,
  };
}
