/** Pure Work Registry selection, search, inventory and relationship rules. */
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';
import {
  registryInvalid,
  boundedText,
  changeIdentity,
} from './work-registry-record.ts';
import type {
  WorkItemV1,
  WorkItemPriorityRecommendationV1,
  WorkRegistryInventoryV1,
  WorkItemStageV1,
  WorkItemLaneV1,
  ChangeOriginV1,
} from './work-registry-contracts.ts';
export function recommendWorkItemPriorities(
  items: readonly WorkItemV1[],
): WorkItemPriorityRecommendationV1[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return items.map((item) => {
    const unresolved = item.blockedBy.filter(
      (blockerId) => byId.get(blockerId)?.stage !== 'closed',
    );
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
        reasons: unresolved.map(
          (blockerId) => `unresolved-blocker:${blockerId}`,
        ),
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
export function buildWorkRegistryInventory(
  items: readonly WorkItemV1[],
  validated: { itemCount: number; sourceCount: number },
): WorkRegistryInventoryV1 {
  const byId = new Map(items.map((item) => [item.id, item]));
  const stages: Record<WorkItemStageV1, number> = {
    inbox: 0,
    backlog: 0,
    active: 0,
    closed: 0,
  };
  const lanes: Record<Exclude<WorkItemLaneV1, null> | 'unprioritized', number> =
    { now: 0, next: 0, later: 0, icebox: 0, unprioritized: 0 };
  for (const item of items) {
    stages[item.stage] += 1;
    lanes[item.lane ?? 'unprioritized'] += 1;
  }
  const isOpen = (item: WorkItemV1) => item.stage !== 'closed';
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
      .filter(
        (item) =>
          isOpen(item) &&
          item.blockedBy.some(
            (blockerId) => byId.get(blockerId)?.stage !== 'closed',
          ),
      )
      .map((item) => item.id),
  };
}
export function assertNoCycles(items: readonly WorkItemV1[]): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<`WORK-${string}`>();
  const visited = new Set<`WORK-${string}`>();
  const visit = (id: `WORK-${string}`): void => {
    if (visiting.has(id)) {
      throw registryInvalid('Work Item blocking graph contains a cycle.');
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const blocker of byId.get(id)?.blockedBy ?? []) visit(blocker);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id);
}
export function assertWorkItemLookup(requestedId: string): void {
  if (
    !/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(requestedId) &&
    !/^ISS-[0-9]+$/.test(requestedId)
  ) {
    throw registryInvalid('Work Item identity or alias is invalid.');
  }
}
export function selectWorkItem(
  items: readonly WorkItemV1[],
  requestedId: string,
): WorkItemV1 {
  const matches = items.filter(
    (item) => item.id === requestedId || item.aliases.includes(requestedId),
  );
  if (matches.length !== 1) {
    throw registryInvalid(
      'Work Item identity or alias must resolve to exactly one stable path.',
    );
  }
  return matches[0]!;
}
export function normalizeWorkItemSearch(requestedQuery: string): string {
  return boundedText(requestedQuery, 256, 'search query').toLowerCase();
}
export function workItemMatchesSearch(
  item: WorkItemV1,
  query: string,
  citedWording: readonly string[],
): boolean {
  return [
    item.id,
    item.title,
    item.interpretation.summary,
    ...item.aliases,
    ...item.sourceRefs,
    ...item.changeRefs,
    ...citedWording,
  ].some((value) => value.toLowerCase().includes(query));
}
export function assertSourceRelations(
  sources: readonly GovernanceSourceV1[],
): ReadonlySet<string> {
  const sourceIds = new Set<string>();
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
  return sourceIds;
}
export function assertWorkItemRelations(
  items: readonly WorkItemV1[],
  sourceIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const itemIds = new Set<string>();
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
  return itemIds;
}
export function assertOriginRelations(
  origin: ChangeOriginV1,
  changeId: string,
  sourceIds: ReadonlySet<string>,
  items: readonly WorkItemV1[],
  itemIds: ReadonlySet<string>,
): void {
  for (const sourceRef of origin.sourceRefs) {
    if (!sourceIds.has(sourceRef)) {
      throw registryInvalid('Change origin references a missing Source.');
    }
  }
  for (const workItemRef of origin.workItemRefs) {
    if (!itemIds.has(workItemRef)) {
      throw registryInvalid('Change origin references a missing Work Item.');
    }
    const item = items.find((candidate) => candidate.id === workItemRef)!;
    if (!item.changeRefs.includes(changeId)) {
      throw registryInvalid('Change origin and Work Item links differ.');
    }
  }
}
export function assertItemOriginLink(
  item: WorkItemV1,
  origin: ChangeOriginV1,
): void {
  if (!origin.workItemRefs.includes(item.id))
    throw registryInvalid('Work Item and change origin links differ.');
}
export function originChangeIdentity(relative: string): string {
  const segments = relative.split('/');
  if (segments.length === 2) return changeIdentity(segments[0]!);
  if (segments.length === 3 && segments[0] === 'archive') {
    return changeIdentity(segments[1]!.replace(/^\d{4}-\d{2}-\d{2}-/, ''));
  }
  throw registryInvalid('Change origin path is invalid.');
}
