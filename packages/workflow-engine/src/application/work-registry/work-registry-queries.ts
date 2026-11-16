/** Coordinates registry reads, preserving lock/revalidation and composite-read hook boundaries. */
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';
import type {
  WorkItemV1,
  WorkItemPriorityRecommendationV1,
  WorkRegistryInventoryV1,
  ChangeOriginV1,
} from '../../modules/governance-intake/work-registry-contracts.ts';
import { registryInvalid } from '../../modules/governance-intake/work-registry-record.ts';
import {
  recommendWorkItemPriorities as recommendPriorities,
  buildWorkRegistryInventory,
  assertNoCycles,
  assertWorkItemLookup,
  selectWorkItem,
  normalizeWorkItemSearch,
  workItemMatchesSearch,
  assertSourceRelations,
  assertWorkItemRelations,
  assertOriginRelations,
  assertItemOriginLink,
} from '../../modules/governance-intake/work-registry-queries.ts';
export type WorkRegistryReadTestHooks = Readonly<{
  afterItemSnapshot?: () => void;
}>;
export type WorkRegistryReadCapabilities = Readonly<{
  withWorkRegistryPromotionLockWhenAvailable<T>(
    root: string,
    operation: () => T,
  ): T;
  withWorkRegistryPromotionReadLockWhenAvailable<T>(
    root: string,
    operation: () => T,
  ): T;
  readItems(root: string): WorkItemV1[];
  readItemsUnlocked(root: string): WorkItemV1[];
  readSource(root: string, id: string): GovernanceSourceV1;
  listSources(root: string): GovernanceSourceV1[];
  canonicalRoot(root: string): string;
  hasConsumerConfiguration(root: string): boolean;
  listOriginReferences(root: string): string[];
  readOrigin(reference: string): ChangeOriginV1;
  originChangeId(root: string, reference: string): string;
  relativeOriginPath(root: string, reference: string): string;
  readCurrentOrigin(root: string, changeId: string): ChangeOriginV1 | null;
}>;
export function createWorkRegistryQueries(ports: WorkRegistryReadCapabilities) {
  const {
    withWorkRegistryPromotionLockWhenAvailable,
    withWorkRegistryPromotionReadLockWhenAvailable,
  } = ports;
  const readSourceValue = ports.readSource;
  const readSource = ports.readSource;
  const listGovernanceSources = ports.listSources;
  const readGovernanceSource = ports.readSource;
  const repositoryConsumerConfigurationExists = ports.hasConsumerConfiguration;
  const listOriginPaths = ports.listOriginReferences;
  const originChangeId = ports.originChangeId;

  function showWorkItem(
    repositoryRoot: string,
    requestedId: string,
  ): WorkItemV1 {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      showWorkItemUnlocked(repositoryRoot, requestedId),
    );
  }

  function showWorkItemUnlocked(
    repositoryRoot: string,
    requestedId: string,
  ): WorkItemV1 {
    assertWorkItemLookup(requestedId);
    return selectWorkItem(ports.readItems(repositoryRoot), requestedId);
  }

  function listWorkItems(repositoryRoot: string): WorkItemV1[] {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      listWorkItemsUnlocked(repositoryRoot),
    );
  }

  function listWorkItemsUnlocked(repositoryRoot: string): WorkItemV1[] {
    return ports
      .readItemsUnlocked(repositoryRoot)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * Explain one transparent priority suggestion per Work Item. The recommendation
   * never mutates registry bytes and deliberately retains an explicit maintainer
   * lane unless an unresolved blocker makes starting the item unsafe.
   */
  function recommendWorkItemPriorities(
    repositoryRoot: string,
  ): WorkItemPriorityRecommendationV1[] {
    return recommendPriorities(listWorkItems(repositoryRoot));
  }

  function inspectWorkRegistry(
    repositoryRoot: string,
  ): WorkRegistryInventoryV1 {
    return withWorkRegistryPromotionReadLockWhenAvailable(repositoryRoot, () =>
      inspectWorkRegistryUnlocked(repositoryRoot),
    );
  }

  function inspectWorkRegistryUnlocked(
    repositoryRoot: string,
  ): WorkRegistryInventoryV1 {
    const validated = validateWorkRegistryUnlocked(repositoryRoot, {});
    const items = listWorkItemsUnlocked(repositoryRoot);
    return buildWorkRegistryInventory(items, validated);
  }

  function searchWorkItems(
    repositoryRoot: string,
    requestedQuery: string,
  ): WorkItemV1[] {
    const query = normalizeWorkItemSearch(requestedQuery);
    const sourceText = new Map<`SRC-${string}`, string>();
    return listWorkItems(repositoryRoot).filter((item) => {
      const citedWording = item.sourceRefs.map((sourceRef) => {
        const cached = sourceText.get(sourceRef);
        if (cached !== undefined) return cached;
        const text = readSourceValue(repositoryRoot, sourceRef).text;
        sourceText.set(sourceRef, text);
        return text;
      });
      return workItemMatchesSearch(item, query, citedWording);
    });
  }

  function findWorkItemsByExactSourceText(
    repositoryRoot: string,
    exactText: string,
  ): WorkItemV1[] {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      listWorkItems(repositoryRoot).filter((item) =>
        item.sourceRefs.some(
          (sourceRef) =>
            readSourceValue(repositoryRoot, sourceRef).text === exactText,
        ),
      ),
    );
  }

  function traceWorkItem(
    repositoryRoot: string,
    requestedId: string,
    testHooks: WorkRegistryReadTestHooks = {},
  ): {
    item: WorkItemV1;
    origins: string[];
    sources: unknown[];
  } {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      traceWorkItemUnlocked(repositoryRoot, requestedId, testHooks),
    );
  }

  function traceWorkItemUnlocked(
    repositoryRoot: string,
    requestedId: string,
    testHooks: WorkRegistryReadTestHooks,
  ): {
    item: WorkItemV1;
    origins: string[];
    sources: unknown[];
  } {
    const item = showWorkItem(repositoryRoot, requestedId);
    testHooks.afterItemSnapshot?.();
    const origins = listOriginPaths(repositoryRoot)
      .filter((originPath) =>
        ports.readOrigin(originPath).workItemRefs.includes(item.id),
      )
      .map((originPath) => ports.relativeOriginPath(repositoryRoot, originPath))
      .sort();
    const sources = item.sourceRefs.map((sourceRef) =>
      readSourceValue(repositoryRoot, sourceRef),
    );
    return { item, origins, sources };
  }

  function traceGovernanceSource(
    repositoryRoot: string,
    requestedSourceId: string,
  ): {
    source: GovernanceSourceV1;
    supersedes: GovernanceSourceV1 | null;
    supersededBy: GovernanceSourceV1[];
    workItems: WorkItemV1[];
    origins: string[];
  } {
    return traceGovernanceSourceUnlocked(repositoryRoot, requestedSourceId);
  }

  function traceGovernanceSourceUnlocked(
    repositoryRoot: string,
    requestedSourceId: string,
  ): {
    source: GovernanceSourceV1;
    supersedes: GovernanceSourceV1 | null;
    supersededBy: GovernanceSourceV1[];
    workItems: WorkItemV1[];
    origins: string[];
  } {
    const canonicalRepositoryRoot = ports.canonicalRoot(repositoryRoot);
    const source = readGovernanceSource(repositoryRoot, requestedSourceId);
    const supersedes =
      source.supersedes === null
        ? null
        : readGovernanceSource(repositoryRoot, source.supersedes);
    const supersededBy = listGovernanceSources(repositoryRoot)
      .filter((candidate) => candidate.supersedes === source.id)
      .sort((left, right) => left.id.localeCompare(right.id));
    const coreTrace = {
      source,
      supersedes,
      supersededBy,
      workItems: [] as WorkItemV1[],
      origins: [] as string[],
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
          const origin = ports.readOrigin(originPath);
          if (!origin.sourceRefs.includes(source.id)) return [];
          for (const originSourceRef of origin.sourceRefs) {
            readSource(repositoryRoot, originSourceRef);
          }
          return [
            ports.relativeOriginPath(canonicalRepositoryRoot, originPath),
          ];
        })
        .sort();
      return { source, supersedes, supersededBy, workItems, origins };
    });
  }

  function validateWorkRegistry(
    repositoryRoot: string,
    testHooks: WorkRegistryReadTestHooks = {},
  ): {
    itemCount: number;
    sourceCount: number;
  } {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      validateWorkRegistryUnlocked(repositoryRoot, testHooks),
    );
  }

  function validateWorkRegistryUnlocked(
    repositoryRoot: string,
    testHooks: WorkRegistryReadTestHooks,
  ): { itemCount: number; sourceCount: number } {
    const sources = listGovernanceSources(repositoryRoot);
    const sourceIds = assertSourceRelations(sources);
    const items = listWorkItemsUnlocked(repositoryRoot);
    const itemIds = assertWorkItemRelations(items, sourceIds);
    testHooks.afterItemSnapshot?.();
    for (const originPath of listOriginPaths(repositoryRoot)) {
      const origin = ports.readOrigin(originPath);
      const changeId = originChangeId(repositoryRoot, originPath);
      assertOriginRelations(origin, changeId, sourceIds, items, itemIds);
    }
    for (const item of items)
      for (const changeRef of item.changeRefs) {
        const originPath = findOriginForChange(repositoryRoot, changeRef);
        assertItemOriginLink(item, ports.readOrigin(originPath));
      }
    return { itemCount: itemIds.size, sourceCount: sourceIds.size };
  }

  /**
   * Validate a current change origin when present through the same citation and
   * bidirectional-link validation used by the public registry validator. The
   * current planning contract calls this boundary for both its live checkout and
   * its immutable detached-worktree replay.
   */
  function validateCurrentChangeOrigin(
    repositoryRoot: string,
    requestedChangeId: string,
  ): void {
    readCurrentChangeOrigin(repositoryRoot, requestedChangeId);
  }

  function readCurrentChangeOrigin(
    repositoryRoot: string,
    requestedChangeId: string,
  ): ChangeOriginV1 | null {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      readCurrentChangeOriginUnlocked(repositoryRoot, requestedChangeId),
    );
  }

  function readCurrentChangeOriginUnlocked(
    repositoryRoot: string,
    requestedChangeId: string,
  ): ChangeOriginV1 | null {
    const origin = ports.readCurrentOrigin(repositoryRoot, requestedChangeId);
    if (origin === null) return null;
    validateWorkRegistry(repositoryRoot);
    return origin;
  }

  function assertNoProspectiveCycle(
    repositoryRoot: string,
    itemId: `WORK-${string}`,
    blockedBy: readonly `WORK-${string}`[],
  ): void {
    const items = listWorkItems(repositoryRoot).map((item) =>
      item.id === itemId ? { ...item, blockedBy } : item,
    );
    assertNoCycles(items);
  }

  function findOriginForChange(
    repositoryRoot: string,
    changeId: string,
  ): string {
    const matches = listOriginPaths(repositoryRoot).filter(
      (originPath) => originChangeId(repositoryRoot, originPath) === changeId,
    );
    if (matches.length !== 1) {
      throw registryInvalid('Linked change must resolve to one origin file.');
    }
    return matches[0]!;
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
