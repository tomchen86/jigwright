import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { canonicalJson } from '@jigwright/core/canonical-json';
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { runGit } from '../../runtime/repository-transaction/git.ts';
import {
  repositoryConsumerConfigurationExists,
  repositoryConsumerPath,
  repositoryWorkRegistryConfiguration,
  repositoryWorkRegistryConfigurationOrNull,
} from '../repository-consumer/repository-consumer-config.ts';
import {
  listGovernanceSources,
  readGovernanceSource,
} from './governance-intake.ts';

export type WorkItemKindV1 =
  'feature' | 'bug' | 'improvement' | 'chore' | 'research';
export type WorkItemLaneV1 = 'now' | 'next' | 'later' | 'icebox' | null;
export type WorkItemStageV1 = 'inbox' | 'backlog' | 'active' | 'closed';

export type WorkItemAuthoringV1 = Readonly<{
  schemaVersion: 1;
  kind: WorkItemKindV1;
  lane: WorkItemLaneV1;
  title: string;
  summary: string;
  sourceRefs: readonly string[];
}>;

export type WorkItemV1 = Readonly<{
  schemaVersion: 1;
  id: `WORK-${string}`;
  createdAt: string;
  kind: WorkItemKindV1;
  stage: WorkItemStageV1;
  lane: WorkItemLaneV1;
  title: string;
  interpretation: Readonly<{
    summary: string;
    status: 'agent-derived' | 'maintainer-confirmed';
  }>;
  aliases: readonly string[];
  sourceRefs: readonly `SRC-${string}`[];
  blockedBy: readonly `WORK-${string}`[];
  changeRefs: readonly string[];
  timeline: readonly Readonly<{
    at: string;
    event: 'created' | 'accepted' | 'prioritized' | 'promoted' | 'closed';
    changeId: string | null;
  }>[];
  closure: null | Readonly<{
    at: string;
    outcome: 'delivered' | 'declined' | 'duplicate' | 'obsolete';
    changeId: string | null;
  }>;
}>;

export type WorkItemReviewV1 =
  | Readonly<{
      action: 'accept';
      expectedDigest: string;
      summary: string;
    }>
  | Readonly<{
      action: 'prioritize';
      expectedDigest: string;
      lane: Exclude<WorkItemLaneV1, null>;
      blockedBy: readonly string[];
    }>
  | Readonly<{
      action: 'decline';
      expectedDigest: string;
      outcome: 'declined' | 'duplicate' | 'obsolete';
    }>;

export type ChangeOriginV1 = Readonly<{
  schemaVersion: 1;
  sourceRefs: readonly `SRC-${string}`[];
  workItemRefs: readonly `WORK-${string}`[];
}>;

export type WorkItemPromotionSurveyDeclarationV1 = Readonly<{
  schemaVersion: 1;
  symbols: readonly string[];
  emptyReason: string | null;
}>;

export type WorkItemPromotionSurveyV1 = Readonly<{
  schemaVersion: 1;
  workItemId: `WORK-${string}`;
  changeId: string;
  surveyedCommit: string;
  symbols: readonly Readonly<{
    symbol: string;
    consumerPaths: readonly string[];
  }>[];
  emptyReason: string | null;
}>;

export type WorkItemPriorityRecommendationV1 = Readonly<{
  workItemId: `WORK-${string}`;
  currentLane: WorkItemLaneV1;
  suggestedLane: WorkItemLaneV1;
  reasons: readonly string[];
}>;

export type WorkRegistryInventoryV1 = Readonly<{
  schemaVersion: 1;
  itemCount: number;
  sourceCount: number;
  items: readonly Readonly<{
    id: `WORK-${string}`;
    title: string;
    stage: WorkItemStageV1;
    lane: WorkItemLaneV1;
    aliases: readonly string[];
    blockedBy: readonly `WORK-${string}`[];
  }>[];
  stages: Readonly<Record<WorkItemStageV1, number>>;
  lanes: Readonly<
    Record<Exclude<WorkItemLaneV1, null> | 'unprioritized', number>
  >;
  currentItemIds: readonly `WORK-${string}`[];
  blockedItemIds: readonly `WORK-${string}`[];
}>;

export type WorkRegistryGovernedTransition =
  'intake' | 'prioritize' | 'promote';

const WORK_ITEM_FILE_MODE = 0o644;

type WorkRegistryTransitionPolicyV1 = Readonly<{
  schemaVersion: 1;
  transitions: Readonly<
    Record<WorkRegistryGovernedTransition, 'ordinary' | 'central-grant'>
  >;
}>;

export function createWorkItem(
  repositoryRoot: string,
  input: WorkItemAuthoringV1,
  dependencies: Readonly<{
    now?: () => string;
    createId?: () => string;
    aliases?: readonly string[];
  }> = {},
): { item: WorkItemV1; relativePath: string } {
  const createdAt = canonicalTimestamp(
    (dependencies.now ?? (() => new Date().toISOString()))(),
  );
  const id = workItemId(
    (dependencies.createId ?? (() => createMonotonicWorkItemId(createdAt)))(),
  );
  const sourceRefs = sourceReferences(input.sourceRefs);
  const aliases = workItemAliases(dependencies.aliases ?? []);
  const existingAliases = new Set(
    listWorkItems(repositoryRoot).flatMap((item) => [item.id, ...item.aliases]),
  );
  if (aliases.some((alias) => existingAliases.has(alias))) {
    throw registryInvalid('Work Item alias already exists.');
  }
  for (const sourceRef of sourceRefs) {
    readSource(repositoryRoot, sourceRef);
  }
  const item: WorkItemV1 = {
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
  const relativePath = path.posix.join(
    repositoryWorkRegistryConfiguration(repositoryRoot).itemRoot,
    year,
    `${id}.yaml`,
  );
  createCanonicalFile(
    path.join(repositoryRoot, ...relativePath.split('/')),
    item,
  );
  return { item, relativePath };
}

export function prepareWorkItemPromotionSurvey(
  repositoryRoot: string,
  requestedId: string,
  requestedChangeId: string,
  declaration: WorkItemPromotionSurveyDeclarationV1,
): { survey: WorkItemPromotionSurveyV1; relativePath: string } {
  const item = showWorkItem(repositoryRoot, requestedId);
  assertPromotionEligible(repositoryRoot, item);
  const changeId = changeIdentity(requestedChangeId);
  const changeDirectory = assertChangeDirectory(repositoryRoot, changeId);
  if (
    declaration.schemaVersion !== 1 ||
    !Array.isArray(declaration.symbols) ||
    declaration.symbols.some((symbol) => !isSurveySymbol(symbol)) ||
    new Set(declaration.symbols).size !== declaration.symbols.length ||
    (declaration.emptyReason !== null &&
      boundedText(declaration.emptyReason, 500, 'survey reason') !==
        declaration.emptyReason) ||
    (declaration.symbols.length === 0 && declaration.emptyReason === null) ||
    (declaration.symbols.length > 0 && declaration.emptyReason !== null)
  ) {
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
  const survey: WorkItemPromotionSurveyV1 = {
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

export function workItemDigest(item: WorkItemV1): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(item)).digest('hex')}`;
}

export function workRegistryTransitionRequiresGrant(
  repositoryRoot: string,
  transition: WorkRegistryGovernedTransition,
): boolean {
  return (
    loadWorkRegistryTransitionPolicy(repositoryRoot).transitions[transition] ===
    'central-grant'
  );
}

export type WorkRegistryGrantRequiredDetailsV1 =
  | Readonly<{
      schemaVersion: 1;
      kind: 'work-registry-grant-required.v1';
      operation: 'review';
      transition: 'intake' | 'prioritize';
      workItemId: string;
      review: WorkItemReviewV1;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: 'work-registry-grant-required.v1';
      operation: 'promote';
      transition: 'promote';
      workItemId: string;
      changeId: string;
      expectedDigest: string;
    }>;

export function assertOrdinaryWorkRegistryTransition(
  repositoryRoot: string,
  transition: WorkRegistryGovernedTransition,
  recovery: string,
  details?: WorkRegistryGrantRequiredDetailsV1,
): void {
  if (!workRegistryTransitionRequiresGrant(repositoryRoot, transition)) return;
  throw workflowError(
    'WORK_REGISTRY_GRANT_REQUIRED',
    `Repository policy requires Central Grant for the ${transition} transition.`,
    ExitCode.guard,
    { recovery, ...(details === undefined ? {} : { details }) },
  );
}

export function showWorkItem(
  repositoryRoot: string,
  requestedId: string,
): WorkItemV1 {
  if (
    !/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(requestedId) &&
    !/^ISS-[0-9]+$/.test(requestedId)
  ) {
    throw registryInvalid('Work Item identity or alias is invalid.');
  }
  const matches = listWorkItemPaths(repositoryRoot)
    .map((itemPath) => readWorkItem(itemPath))
    .filter(
      (item) => item.id === requestedId || item.aliases.includes(requestedId),
    );
  if (matches.length !== 1) {
    throw registryInvalid(
      'Work Item identity or alias must resolve to exactly one stable path.',
    );
  }
  return matches[0]!;
}

export function applyWorkItemReview(
  repositoryRoot: string,
  requestedId: string,
  review: WorkItemReviewV1,
  now: () => string = () => new Date().toISOString(),
): WorkItemV1 {
  const id = workItemId(requestedId);
  const itemPath = findWorkItemPath(repositoryRoot, id);
  const item = readWorkItem(itemPath);
  if (workItemDigest(item) !== exactDigest(review.expectedDigest)) {
    throw workflowError(
      'WORK_REGISTRY_STALE',
      'Work Item changed after the review was prepared.',
      ExitCode.conflict,
    );
  }
  const at = canonicalTimestamp(now());
  let next: WorkItemV1;
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
  } else if (review.action === 'prioritize') {
    if (item.stage !== 'backlog' || item.closure !== null) {
      throw registryInvalid('Only an open backlog item can be prioritized.');
    }
    const blockedBy = workItemReferences(review.blockedBy);
    if (blockedBy.includes(item.id)) {
      throw registryInvalid('A Work Item cannot block itself.');
    }
    for (const blocker of blockedBy) showWorkItem(repositoryRoot, blocker);
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
  } else {
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

export function promoteWorkItem(
  repositoryRoot: string,
  requestedId: string,
  requestedChangeId: string,
  now: () => string = () => new Date().toISOString(),
  requestedExpectedDigest?: string,
  requireCurrentSurvey = false,
): { item: WorkItemV1; originPath: string } {
  const id = workItemId(requestedId);
  const changeId = changeIdentity(requestedChangeId);
  const itemPath = findWorkItemPath(repositoryRoot, id);
  const { item, serialized: itemBefore } = readWorkItemRecord(itemPath);
  if (
    requestedExpectedDigest !== undefined &&
    workItemDigest(item) !== exactDigest(requestedExpectedDigest)
  ) {
    throw workflowError(
      'WORK_REGISTRY_STALE',
      'Work Item changed after promotion was prepared.',
      ExitCode.conflict,
    );
  }
  assertPromotionEligible(repositoryRoot, item);
  const changeDirectory = assertChangeDirectory(repositoryRoot, changeId);
  if (requireCurrentSurvey) {
    assertPromotionSurveyCurrent(
      repositoryRoot,
      changeDirectory,
      item,
      changeId,
    );
  }
  const at = canonicalTimestamp(now());
  const promoted: WorkItemV1 = {
    ...item,
    stage: 'active',
    changeRefs: [...new Set([...item.changeRefs, changeId])].sort(),
    timeline: [...item.timeline, { at, event: 'promoted', changeId }],
  };
  const originPath = path.join(changeDirectory, 'origin.json');
  const originBefore = readOptionalPlainFile(originPath);
  const origin = mergeOrigin(
    repositoryRoot,
    originBefore,
    promoted.sourceRefs,
    [promoted.id],
  );

  try {
    replaceCanonicalFile(originPath, origin);
    replaceCanonicalFile(itemPath, promoted);
  } catch (error) {
    restoreFile(originPath, originBefore);
    restoreFile(itemPath, itemBefore);
    throw error;
  }
  return { item: promoted, originPath };
}

/**
 * Immediate work may cite an immutable Source without manufacturing a parking
 * Work Item. This only records provenance on an already-existing change; it
 * creates no planning, lifecycle, priority, or transition authority.
 */
export function linkSourceToChange(
  repositoryRoot: string,
  requestedSourceId: string,
  requestedChangeId: string,
): {
  origin: ChangeOriginV1;
  originPath: string;
  created: boolean;
} {
  const [sourceRef] = sourceReferences([requestedSourceId]);
  readSource(repositoryRoot, sourceRef!);
  const changeId = changeIdentity(requestedChangeId);
  const changeDirectory = path.join(
    repositoryConsumerPath(
      repositoryRoot,
      repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot,
    ),
    changeId,
  );
  const changeStats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
  if (!changeStats?.isDirectory() || changeStats.isSymbolicLink()) {
    throw registryInvalid(
      'Source linking requires an existing plain change directory.',
    );
  }
  const originPath = path.join(changeDirectory, 'origin.json');
  const before = readOptionalPlainFile(originPath);
  const origin = mergeOrigin(repositoryRoot, before, [sourceRef!], []);
  const content = `${canonicalJson(origin)}\n`;
  if (before === content) {
    return { origin, originPath, created: false };
  }
  replaceCanonicalFile(originPath, origin);
  return { origin, originPath, created: true };
}

export function listWorkItems(repositoryRoot: string): WorkItemV1[] {
  return listWorkItemPaths(repositoryRoot)
    .map((itemPath) => readWorkItem(itemPath))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Explain one transparent priority suggestion per Work Item. The recommendation
 * never mutates registry bytes and deliberately retains an explicit maintainer
 * lane unless an unresolved blocker makes starting the item unsafe.
 */
export function recommendWorkItemPriorities(
  repositoryRoot: string,
): WorkItemPriorityRecommendationV1[] {
  const items = listWorkItems(repositoryRoot);
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

export function inspectWorkRegistry(
  repositoryRoot: string,
): WorkRegistryInventoryV1 {
  const validated = validateWorkRegistry(repositoryRoot);
  const items = listWorkItems(repositoryRoot);
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

export function searchWorkItems(
  repositoryRoot: string,
  requestedQuery: string,
): WorkItemV1[] {
  const query = boundedText(requestedQuery, 256, 'search query').toLowerCase();
  return listWorkItems(repositoryRoot).filter((item) =>
    [
      item.id,
      item.title,
      item.interpretation.summary,
      ...item.aliases,
      ...item.sourceRefs,
      ...item.changeRefs,
    ].some((value) => value.toLowerCase().includes(query)),
  );
}

export function traceWorkItem(
  repositoryRoot: string,
  requestedId: string,
): {
  item: WorkItemV1;
  origins: string[];
  sources: unknown[];
} {
  const item = showWorkItem(repositoryRoot, requestedId);
  const origins = listOriginPaths(repositoryRoot)
    .filter((originPath) =>
      parseOrigin(fs.readFileSync(originPath, 'utf8')).workItemRefs.includes(
        item.id,
      ),
    )
    .map((originPath) =>
      path.relative(repositoryRoot, originPath).replaceAll(path.sep, '/'),
    )
    .sort();
  const sources = item.sourceRefs.map((sourceRef) =>
    readSourceValue(repositoryRoot, sourceRef),
  );
  return { item, origins, sources };
}

export function traceGovernanceSource(
  repositoryRoot: string,
  requestedSourceId: string,
): {
  source: GovernanceSourceV1;
  supersedes: GovernanceSourceV1 | null;
  supersededBy: GovernanceSourceV1[];
  workItems: WorkItemV1[];
  origins: string[];
} {
  const canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
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
  if (
    !repositoryConsumerConfigurationExists(repositoryRoot) ||
    repositoryWorkRegistryConfigurationOrNull(repositoryRoot) === null
  ) {
    return coreTrace;
  }
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
      if (!origin.sourceRefs.includes(source.id)) return [];
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
}

export function renderWorkRegistry(repositoryRoot: string): {
  backlogPath: string;
  inventoryPath: string;
  historyPaths: string[];
} {
  validateWorkRegistry(repositoryRoot);
  const items = listWorkItems(repositoryRoot);
  const registry = repositoryWorkRegistryConfiguration(repositoryRoot);
  const backlogPath = repositoryConsumerPath(
    repositoryRoot,
    registry.backlogPath,
  );
  replaceTextFile(backlogPath, renderBacklogProjection(repositoryRoot, items));

  const inventoryPath = repositoryConsumerPath(
    repositoryRoot,
    registry.inventoryPath,
  );
  replaceCanonicalFile(inventoryPath, inspectWorkRegistry(repositoryRoot));

  const historyPaths = [...closedWorkItemsByYear(items).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([year, closed]) => {
      const historyPath = path.join(
        repositoryConsumerPath(repositoryRoot, registry.historyRoot),
        `${year}.md`,
      );
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
export function validateWorkRegistryProjections(repositoryRoot: string): {
  projectionCount: number;
} {
  validateWorkRegistry(repositoryRoot);
  const registry = repositoryWorkRegistryConfiguration(repositoryRoot);
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
  const historyStats = fs.lstatSync(historyRoot, { throwIfNoEntry: false });
  const activated =
    fs.existsSync(backlogPath) ||
    fs.existsSync(inventoryPath) ||
    historyStats !== undefined;
  if (!activated) return { projectionCount: 0 };
  if (
    historyStats !== undefined &&
    (!historyStats.isDirectory() || historyStats.isSymbolicLink())
  ) {
    throw projectionDrift('Work Registry history root is unsafe.');
  }

  const items = listWorkItems(repositoryRoot);
  const expected = new Map<string, string>([
    [backlogPath, renderBacklogProjection(repositoryRoot, items)],
    [inventoryPath, `${canonicalJson(inspectWorkRegistry(repositoryRoot))}\n`],
  ]);
  for (const [year, closed] of closedWorkItemsByYear(items)) {
    expected.set(
      path.join(historyRoot, `${year}.md`),
      renderHistoryProjection(year, closed),
    );
  }
  const actualHistoryPaths =
    historyStats === undefined
      ? []
      : fs.readdirSync(historyRoot, { withFileTypes: true }).map((entry) => {
          if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            !/^\d{4}\.md$/.test(entry.name)
          ) {
            throw projectionDrift(
              'Work Registry history contains an unexpected path.',
            );
          }
          return path.join(historyRoot, entry.name);
        });
  const expectedHistoryPaths = [...expected.keys()].filter((filePath) =>
    filePath.startsWith(`${historyRoot}${path.sep}`),
  );
  if (
    actualHistoryPaths.length !== expectedHistoryPaths.length ||
    actualHistoryPaths.some((filePath) => !expected.has(filePath))
  ) {
    throw projectionDrift('Work Registry history projection is stale.');
  }
  for (const [filePath, content] of expected) {
    if (readOptionalPlainFile(filePath) !== content) {
      throw projectionDrift(
        `Work Registry projection is stale: ${path.relative(repositoryRoot, filePath).replaceAll(path.sep, '/')}`,
      );
    }
  }
  return { projectionCount: expected.size };
}

/**
 * Project Work Registry delivery into the same disposable tree as the public
 * OpenSpec archive. The caller supplies a timestamp derived from the immutable
 * archive parent so the projection can be replayed independently in CI.
 */
export function reconcileArchivedWorkItems(
  repositoryRoot: string,
  requestedChangeId: string,
  archivedChangeRoot: string,
  requestedClosedAt: string,
): { closedItemIds: string[]; outputPaths: string[] } {
  const changeId = changeIdentity(requestedChangeId);
  const closedAt = canonicalTimestamp(requestedClosedAt);
  const workRegistry =
    repositoryWorkRegistryConfigurationOrNull(repositoryRoot);
  if (workRegistry === null) {
    return { closedItemIds: [], outputPaths: [] };
  }
  const changeOriginRoot = workRegistry.changeOriginRoot;
  if (
    !new RegExp(
      `^${escapeRegExp(changeOriginRoot)}/archive/\\d{4}-\\d{2}-\\d{2}-${changeId}$`,
    ).test(archivedChangeRoot)
  ) {
    throw registryInvalid('Archived change root is invalid.');
  }
  const originPath = path.join(
    repositoryRoot,
    ...archivedChangeRoot.split('/'),
    'origin.json',
  );
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
    if (
      item.stage !== 'active' ||
      item.closure !== null ||
      !item.changeRefs.includes(changeId)
    ) {
      throw registryInvalid(
        'Archived change must reference an active, bidirectionally linked Work Item.',
      );
    }
    const closed: WorkItemV1 = {
      ...item,
      stage: 'closed',
      timeline: [...item.timeline, { at: closedAt, event: 'closed', changeId }],
      closure: { at: closedAt, outcome: 'delivered', changeId },
    };
    replaceCanonicalFile(itemPath, closed);
    return itemPath;
  });
  const rendered = renderWorkRegistry(repositoryRoot);
  const historyPath = path.join(
    repositoryConsumerPath(
      repositoryRoot,
      repositoryWorkRegistryConfiguration(repositoryRoot).historyRoot,
    ),
    `${closedAt.slice(0, 4)}.md`,
  );
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
      .map((outputPath) =>
        path.relative(repositoryRoot, outputPath).replaceAll(path.sep, '/'),
      )
      .sort(),
  };
}

export function validateWorkRegistry(repositoryRoot: string): {
  itemCount: number;
  sourceCount: number;
} {
  const sourceIds = new Set<string>();
  const sources = listGovernanceSources(
    repositoryRoot,
    repositoryWorkRegistryConfiguration(repositoryRoot).sourceRoot,
  );
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
  const itemIds = new Set<string>();
  const items = listWorkItems(repositoryRoot);
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
      const item = items.find((candidate) => candidate.id === workItemRef)!;
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
 * Admit an optional current change origin through the same citation and
 * bidirectional-link validation used by the public registry validator. The
 * current planning contract calls this boundary for both its live checkout and
 * its immutable detached-worktree replay.
 */
export function validateCurrentChangeOrigin(
  repositoryRoot: string,
  requestedChangeId: string,
): void {
  const configuration =
    repositoryWorkRegistryConfigurationOrNull(repositoryRoot);
  if (configuration === null) return;
  const changeId = changeIdentity(requestedChangeId);
  const originPath = path.join(
    repositoryConsumerPath(repositoryRoot, configuration.changeOriginRoot),
    changeId,
    'origin.json',
  );
  if (readOptionalPlainFile(originPath) === null) return;
  validateWorkRegistry(repositoryRoot);
}

function parseWorkItem(value: unknown): WorkItemV1 {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) {
    throw registryInvalid('Work Item is invalid.');
  }
  const item = value as unknown as WorkItemV1;
  if (
    item.schemaVersion !== 1 ||
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
    !['agent-derived', 'maintainer-confirmed'].includes(
      item.interpretation.status,
    ) ||
    !Array.isArray(item.aliases) ||
    !item.aliases.every(
      (alias) =>
        typeof alias === 'string' &&
        /^(?:ISS-[0-9]+|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(alias),
    ) ||
    new Set(item.aliases).size !== item.aliases.length ||
    !isClosure(item.closure)
  ) {
    throw registryInvalid('Work Item is invalid.');
  }
  const canonicalAliases = [...item.aliases].sort();
  const canonicalSourceRefs = sourceReferences(item.sourceRefs);
  if (
    !Array.isArray(item.blockedBy) ||
    !item.blockedBy.every((entry) =>
      /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(entry),
    ) ||
    !Array.isArray(item.changeRefs) ||
    !item.changeRefs.every((entry) => changeIdentity(entry) === entry) ||
    !Array.isArray(item.timeline) ||
    item.timeline.length < 1 ||
    !item.timeline.every(isTimelineEntry)
  ) {
    throw registryInvalid('Work Item relations are invalid.');
  }
  const canonicalBlockedBy = workItemReferences(item.blockedBy);
  const canonicalChangeRefs = [...new Set(item.changeRefs)].sort();
  if (
    JSON.stringify(item.aliases) !== JSON.stringify(canonicalAliases) ||
    JSON.stringify(item.sourceRefs) !== JSON.stringify(canonicalSourceRefs) ||
    JSON.stringify(item.blockedBy) !== JSON.stringify(canonicalBlockedBy) ||
    canonicalChangeRefs.length !== item.changeRefs.length ||
    JSON.stringify(item.changeRefs) !== JSON.stringify(canonicalChangeRefs) ||
    !hasCoherentWorkItemLifecycle(item)
  ) {
    throw registryInvalid('Work Item relations are invalid.');
  }
  return item;
}

function readWorkItem(itemPath: string): WorkItemV1 {
  return readWorkItemRecord(itemPath).item;
}

function readWorkItemRecord(
  itemPath: string,
): Readonly<{ item: WorkItemV1; serialized: string }> {
  const bytes = readPlainWorkItemBytes(itemPath);
  let serialized: string;
  let value: unknown;
  try {
    serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(serialized);
  } catch {
    throw registryInvalid('Work Item is invalid.');
  }
  const item = parseWorkItem(value);
  if (
    path.basename(itemPath) !== `${item.id}.yaml` ||
    path.basename(path.dirname(itemPath)) !== item.createdAt.slice(0, 4) ||
    !bytes.equals(Buffer.from(`${canonicalJson(item)}\n`, 'utf8'))
  ) {
    throw registryInvalid('Work Item path and identity differ.');
  }
  return { item, serialized };
}

function readPlainWorkItemBytes(itemPath: string): Buffer {
  let before: fs.BigIntStats | undefined;
  try {
    before = fs.lstatSync(itemPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
  } catch {
    throw registryInvalid('Work Item path is unsafe.');
  }
  if (before === undefined || !isSafeWorkItemFile(before)) {
    throw registryInvalid('Work Item path is unsafe.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      itemPath,
      fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
    );
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !isSafeWorkItemFile(openedBefore) ||
      !sameWorkItemFileSnapshot(before, openedBefore)
    ) {
      throw new Error('Work Item changed before descriptor admission.');
    }
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(itemPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      after === undefined ||
      !isSafeWorkItemFile(openedAfter) ||
      !isSafeWorkItemFile(after) ||
      BigInt(bytes.byteLength) !== openedBefore.size ||
      !sameWorkItemFileSnapshot(openedBefore, openedAfter) ||
      !sameWorkItemFileSnapshot(openedAfter, after)
    ) {
      throw new Error('Work Item changed while it was read.');
    }
    return bytes;
  } catch {
    throw registryInvalid('Work Item path could not be read safely.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isSafeWorkItemFile(stats: fs.BigIntStats): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1n &&
    (process.platform === 'win32' ||
      (stats.mode & 0o777n) === BigInt(WORK_ITEM_FILE_MODE)) &&
    (typeof process.getuid !== 'function' ||
      stats.uid === BigInt(process.getuid()))
  );
}

function sameWorkItemFileSnapshot(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function hasCoherentWorkItemLifecycle(item: WorkItemV1): boolean {
  const first = item.timeline[0]!;
  const last = item.timeline.at(-1)!;
  const promoted = item.timeline.filter(({ event }) => event === 'promoted');
  if (
    first.event !== 'created' ||
    first.at !== item.createdAt ||
    first.changeId !== null ||
    item.timeline.filter(({ event }) => event === 'created').length !== 1
  ) {
    return false;
  }
  let observedStage: WorkItemStageV1 = 'inbox';
  for (const entry of item.timeline.slice(1)) {
    if (
      entry.event === 'accepted' &&
      observedStage === 'inbox' &&
      entry.changeId === null
    ) {
      observedStage = 'backlog';
    } else if (
      entry.event === 'prioritized' &&
      observedStage === 'backlog' &&
      entry.changeId === null
    ) {
      continue;
    } else if (
      entry.event === 'promoted' &&
      observedStage === 'backlog' &&
      entry.changeId !== null
    ) {
      observedStage = 'active';
    } else if (entry.event === 'closed' && observedStage !== 'closed') {
      observedStage = 'closed';
    } else {
      return false;
    }
  }
  if (observedStage !== item.stage) return false;
  if (observedStage !== 'closed') {
    if (item.closure !== null) return false;
    if (observedStage !== 'active') return item.changeRefs.length === 0;
    return (
      promoted.length === 1 &&
      last.event === 'promoted' &&
      last.changeId !== null &&
      item.changeRefs.length === 1 &&
      item.changeRefs[0] === last.changeId
    );
  }
  if (
    item.closure === null ||
    last.event !== 'closed' ||
    last.at !== item.closure.at ||
    last.changeId !== item.closure.changeId
  ) {
    return false;
  }
  if (item.closure.outcome === 'delivered') {
    return (
      item.closure.changeId !== null &&
      promoted.length === 1 &&
      promoted[0]!.changeId === item.closure.changeId &&
      item.changeRefs.length === 1 &&
      item.changeRefs[0] === item.closure.changeId
    );
  }
  return (
    item.closure.changeId === null &&
    promoted.length === 0 &&
    item.changeRefs.length === 0
  );
}

function isTimelineEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['at', 'changeId', 'event']) &&
    typeof value.at === 'string' &&
    canonicalTimestamp(value.at) === value.at &&
    ['created', 'accepted', 'prioritized', 'promoted', 'closed'].includes(
      String(value.event),
    ) &&
    (value.changeId === null ||
      (typeof value.changeId === 'string' &&
        changeIdentity(value.changeId) === value.changeId))
  );
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
] as const;

function isClosure(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['at', 'changeId', 'outcome']) &&
      typeof value.at === 'string' &&
      canonicalTimestamp(value.at) === value.at &&
      ['delivered', 'declined', 'duplicate', 'obsolete'].includes(
        String(value.outcome),
      ) &&
      (value.changeId === null ||
        (typeof value.changeId === 'string' &&
          changeIdentity(value.changeId) === value.changeId)))
  );
}

function mergeOrigin(
  repositoryRoot: string,
  existingText: string | null,
  sourceRefs: readonly `SRC-${string}`[],
  workItemRefs: readonly `WORK-${string}`[],
): ChangeOriginV1 {
  let existing: ChangeOriginV1 = {
    schemaVersion: 1,
    sourceRefs: [],
    workItemRefs: [],
  };
  if (existingText !== null) {
    const value: unknown = JSON.parse(existingText);
    if (!isRecord(value) || !hasExactKeys(value, ORIGIN_KEYS)) {
      throw registryInvalid('Change origin is invalid.');
    }
    if (
      value.schemaVersion !== 1 ||
      !Array.isArray(value.sourceRefs) ||
      !Array.isArray(value.workItemRefs) ||
      !value.sourceRefs.every((entry) => typeof entry === 'string') ||
      !value.workItemRefs.every((entry) => typeof entry === 'string')
    ) {
      throw registryInvalid('Change origin is invalid.');
    }
    existing = value as ChangeOriginV1;
  }
  const merged: ChangeOriginV1 = {
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

function parseOrigin(existingText: string): ChangeOriginV1 {
  let value: unknown;
  try {
    value = JSON.parse(existingText);
  } catch {
    throw registryInvalid('Change origin is invalid.');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ORIGIN_KEYS) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.sourceRefs) ||
    !Array.isArray(value.workItemRefs) ||
    !value.sourceRefs.every(
      (entry) => typeof entry === 'string' && /^SRC-[0-9a-f]{64}$/.test(entry),
    ) ||
    !value.workItemRefs.every(
      (entry) =>
        typeof entry === 'string' &&
        /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(entry),
    )
  ) {
    throw registryInvalid('Change origin is invalid.');
  }
  const origin = value as unknown as ChangeOriginV1;
  const canonicalSourceRefs = sourceReferences(origin.sourceRefs);
  const canonicalWorkItemRefs = workItemReferences(origin.workItemRefs);
  if (
    JSON.stringify(origin.sourceRefs) !== JSON.stringify(canonicalSourceRefs) ||
    JSON.stringify(origin.workItemRefs) !==
      JSON.stringify(canonicalWorkItemRefs) ||
    existingText !== `${canonicalJson(origin)}\n`
  ) {
    throw registryInvalid('Change origin is invalid.');
  }
  return origin;
}

const ORIGIN_KEYS = ['schemaVersion', 'sourceRefs', 'workItemRefs'] as const;

function listWorkItemPaths(repositoryRoot: string): string[] {
  const itemsRoot = repositoryConsumerPath(
    repositoryRoot,
    repositoryWorkRegistryConfiguration(repositoryRoot).itemRoot,
  );
  const rootStats = fs.lstatSync(itemsRoot, { throwIfNoEntry: false });
  if (!rootStats) return [];
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw registryInvalid('Work Registry item root is unsafe.');
  }
  const itemPaths: string[] = [];
  for (const entry of fs.readdirSync(itemsRoot, { withFileTypes: true })) {
    const yearRoot = path.join(itemsRoot, entry.name);
    const yearStats = fs.lstatSync(yearRoot);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !yearStats.isDirectory() ||
      yearStats.isSymbolicLink() ||
      !/^\d{4}$/.test(entry.name)
    ) {
      throw registryInvalid('Work Registry year entry is unsafe or invalid.');
    }
    for (const item of fs.readdirSync(yearRoot, { withFileTypes: true })) {
      const itemPath = path.join(yearRoot, item.name);
      const itemStats = fs.lstatSync(itemPath);
      if (
        item.isSymbolicLink() ||
        !item.isFile() ||
        !itemStats.isFile() ||
        itemStats.isSymbolicLink() ||
        !/^WORK-[0-9A-HJKMNP-TV-Z]{26}\.yaml$/.test(item.name)
      ) {
        throw registryInvalid('Work Registry item entry is unsafe or invalid.');
      }
      itemPaths.push(itemPath);
    }
  }
  return itemPaths.sort();
}

function readSource(repositoryRoot: string, sourceRef: `SRC-${string}`): void {
  readSourceValue(repositoryRoot, sourceRef);
}

function findWorkItemPath(repositoryRoot: string, id: string): string {
  const matches = listWorkItemPaths(repositoryRoot).filter(
    (itemPath) => path.basename(itemPath, '.yaml') === id,
  );
  if (matches.length !== 1) {
    throw registryInvalid('Work Item must resolve to exactly one stable path.');
  }
  return matches[0]!;
}

function assertChangeDirectory(
  repositoryRoot: string,
  changeId: string,
): string {
  const changeDirectory = path.join(
    repositoryConsumerPath(
      repositoryRoot,
      repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot,
    ),
    changeId,
  );
  const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw registryInvalid(
      'Promotion requires an existing plain change directory.',
    );
  }
  return changeDirectory;
}

function isSurveySymbol(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 200 &&
    !/[\0\r\n]/u.test(value)
  );
}

function listSymbolConsumers(
  repositoryRoot: string,
  commit: string,
  symbol: string,
): string[] {
  const output = runGit(
    repositoryRoot,
    ['grep', '-l', '-z', '-F', '-e', symbol, commit, '--', '.'],
    true,
  );
  const prefix = `${commit}:`;
  return output
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith(prefix)) {
        throw registryInvalid(
          'Promotion survey returned an invalid consumer path.',
        );
      }
      const relativePath = entry.slice(prefix.length);
      if (
        path.isAbsolute(relativePath) ||
        path.posix.normalize(relativePath) !== relativePath ||
        relativePath.startsWith('../') ||
        relativePath.includes('\\')
      ) {
        throw registryInvalid('Promotion survey consumer path is invalid.');
      }
      return relativePath;
    })
    .sort();
}

function assertPromotionSurveyCurrent(
  repositoryRoot: string,
  changeDirectory: string,
  item: WorkItemV1,
  changeId: string,
): void {
  const surveyPath = path.join(changeDirectory, 'survey.json');
  const source = readOptionalPlainFile(surveyPath);
  if (source === null) {
    throw promotionSurveyRequired(
      'Promotion requires a current premise survey.',
    );
  }
  const survey = parsePromotionSurvey(source);
  if (survey.workItemId !== item.id || survey.changeId !== changeId) {
    throw registryInvalid('Promotion survey is invalid.');
  }
  const currentHead = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  if (survey.surveyedCommit !== currentHead) {
    throw promotionSurveyRequired(
      'Promotion survey is stale for the current repository head.',
    );
  }
  const currentSymbols = survey.symbols.map(({ symbol }) => ({
    symbol,
    consumerPaths: listSymbolConsumers(
      repositoryRoot,
      survey.surveyedCommit,
      symbol,
    ),
  }));
  if (canonicalJson(survey.symbols) !== canonicalJson(currentSymbols)) {
    throw promotionSurveyRequired(
      'Promotion survey consumer facts do not match the surveyed Git commit.',
    );
  }
}

function parsePromotionSurvey(source: string): WorkItemPromotionSurveyV1 {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw registryInvalid('Promotion survey is invalid.');
  }
  if (
    !isRecord(value) ||
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
    value.symbols.some(
      (entry) =>
        !isRecord(entry) ||
        !hasExactKeys(entry, ['consumerPaths', 'symbol']) ||
        !isSurveySymbol(entry.symbol) ||
        !Array.isArray(entry.consumerPaths) ||
        entry.consumerPaths.some((consumer) => typeof consumer !== 'string'),
    ) ||
    (value.emptyReason !== null &&
      (typeof value.emptyReason !== 'string' ||
        boundedText(value.emptyReason, 500, 'survey reason') !==
          value.emptyReason)) ||
    (value.symbols.length === 0 && value.emptyReason === null) ||
    (value.symbols.length > 0 && value.emptyReason !== null)
  ) {
    throw registryInvalid('Promotion survey is invalid.');
  }
  const survey = value as unknown as WorkItemPromotionSurveyV1;
  const symbols = survey.symbols.map(({ symbol }) => symbol);
  if (
    new Set(symbols).size !== symbols.length ||
    JSON.stringify(symbols) !== JSON.stringify([...symbols].sort()) ||
    source !== `${canonicalJson(survey)}\n`
  ) {
    throw registryInvalid('Promotion survey is invalid.');
  }
  return survey;
}

function promotionSurveyRequired(message: string) {
  return workflowError(
    'WORK_REGISTRY_SURVEY_REQUIRED',
    message,
    ExitCode.conflict,
  );
}

function assertPromotionEligible(
  repositoryRoot: string,
  item: WorkItemV1,
): void {
  if (
    item.stage !== 'backlog' ||
    item.interpretation.status !== 'maintainer-confirmed' ||
    (item.lane !== 'now' && item.lane !== 'next') ||
    item.changeRefs.length !== 0 ||
    item.closure !== null
  ) {
    throw promotionIneligible(
      'Promotion requires one reviewed Now or Next backlog Work Item.',
    );
  }
  for (const blockerId of item.blockedBy) {
    const blocker = showWorkItem(repositoryRoot, blockerId);
    if (blocker.stage !== 'closed') {
      throw promotionIneligible(
        'Promotion requires every blocking Work Item to be closed.',
      );
    }
  }
}

function createCanonicalFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = `${canonicalJson(value)}\n`;
  try {
    fs.writeFileSync(filePath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: WORK_ITEM_FILE_MODE,
    });
  } catch (error) {
    if (
      isNodeError(error) &&
      error.code === 'EEXIST' &&
      readWorkItemRecord(filePath).serialized === content
    ) {
      return;
    }
    throw error;
  }
}

function replaceCanonicalFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${canonicalJson(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: WORK_ITEM_FILE_MODE,
  });
  try {
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readOptionalPlainFile(filePath: string): string | null {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw registryInvalid('Work Registry path is unsafe.');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function restoreFile(filePath: string, content: string | null): void {
  if (content === null) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  replaceCanonicalFile(filePath, JSON.parse(content));
}

function createMonotonicWorkItemId(timestamp: string): string {
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

function workItemId(value: string): `WORK-${string}` {
  if (!/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
    throw registryInvalid('Work Item identity is invalid.');
  }
  return value as `WORK-${string}`;
}

function workItemKind(value: string): WorkItemKindV1 {
  if (!['feature', 'bug', 'improvement', 'chore', 'research'].includes(value)) {
    throw registryInvalid('Work Item kind is invalid.');
  }
  return value as WorkItemKindV1;
}

function workItemLane(value: unknown): WorkItemLaneV1 {
  if (
    value !== null &&
    !['now', 'next', 'later', 'icebox'].includes(String(value))
  ) {
    throw registryInvalid('Work Item lane is invalid.');
  }
  return value as WorkItemLaneV1;
}

function sourceReferences(value: readonly string[]): `SRC-${string}`[] {
  if (!Array.isArray(value))
    throw registryInvalid('Source references are invalid.');
  const refs = value.map((entry) => {
    if (!/^SRC-[0-9a-f]{64}$/.test(entry)) {
      throw registryInvalid('Source reference is invalid.');
    }
    return entry as `SRC-${string}`;
  });
  if (new Set(refs).size !== refs.length) {
    throw registryInvalid('Source references are duplicated.');
  }
  return refs.sort();
}

function workItemReferences(value: readonly string[]): `WORK-${string}`[] {
  if (!Array.isArray(value)) {
    throw registryInvalid('Work Item references are invalid.');
  }
  const refs = value.map((entry) => workItemId(entry));
  if (new Set(refs).size !== refs.length) {
    throw registryInvalid('Work Item references are duplicated.');
  }
  return refs.sort();
}

function workItemAliases(value: readonly string[]): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== 'string' || !/^ISS-[0-9]+$/.test(entry),
    )
  ) {
    throw registryInvalid('Work Item aliases are invalid.');
  }
  const aliases = [...value].sort();
  if (new Set(aliases).size !== aliases.length) {
    throw registryInvalid('Work Item aliases are duplicated.');
  }
  return aliases;
}

function exactDigest(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw registryInvalid('Work Item review digest is invalid.');
  }
  return value as `sha256:${string}`;
}

function compareWorkItems(left: WorkItemV1, right: WorkItemV1): number {
  const lanes: Record<Exclude<WorkItemLaneV1, null> | 'none', number> = {
    now: 0,
    next: 1,
    later: 2,
    icebox: 3,
    none: 4,
  };
  return (
    lanes[left.lane ?? 'none'] - lanes[right.lane ?? 'none'] ||
    left.id.localeCompare(right.id)
  );
}

function renderBacklogProjection(
  repositoryRoot: string,
  items: readonly WorkItemV1[],
): string {
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

function renderBacklogSourceLink(
  repositoryRoot: string,
  sourceRef: `SRC-${string}`,
): string {
  const digest = sourceRef.slice('SRC-'.length);
  const registry = repositoryWorkRegistryConfiguration(repositoryRoot);
  const target = path.posix.join(
    registry.sourceRoot,
    digest.slice(0, 2),
    `${digest}.json`,
  );
  const relative = path.posix.relative(
    path.posix.dirname(registry.backlogPath),
    target,
  );
  return `[${sourceRef}](${relative})`;
}

function closedWorkItemsByYear(
  items: readonly WorkItemV1[],
): Map<string, WorkItemV1[]> {
  const byYear = new Map<string, WorkItemV1[]>();
  for (const item of items.filter(
    (candidate) => candidate.stage === 'closed',
  )) {
    const year = item.closure!.at.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), item]);
  }
  return byYear;
}

function renderHistoryProjection(
  year: string,
  closed: readonly WorkItemV1[],
): string {
  return [
    `# Work history ${year}`,
    '',
    '<!-- Generated by jigwright work-item render. -->',
    '',
    ...[...closed]
      .sort(compareWorkItems)
      .map(
        (item) =>
          `- **${item.id} — ${item.title}** (${item.closure!.outcome}${item.closure!.changeId ? `; ${item.closure!.changeId}` : ''})`,
      ),
    '',
  ].join('\n');
}

function loadWorkRegistryTransitionPolicy(
  repositoryRoot: string,
): WorkRegistryTransitionPolicyV1 {
  const policyPath = repositoryConsumerPath(
    repositoryRoot,
    repositoryWorkRegistryConfiguration(repositoryRoot).transitionPolicyPath,
  );
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
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw registryInvalid('Work Registry transition policy is invalid.');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'transitions']) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.transitions) ||
    !hasExactKeys(value.transitions, ['intake', 'prioritize', 'promote']) ||
    !['ordinary', 'central-grant'].includes(String(value.transitions.intake)) ||
    !['ordinary', 'central-grant'].includes(
      String(value.transitions.prioritize),
    ) ||
    !['ordinary', 'central-grant'].includes(String(value.transitions.promote))
  ) {
    throw registryInvalid('Work Registry transition policy is invalid.');
  }
  return value as WorkRegistryTransitionPolicyV1;
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

function assertNoCycles(items: readonly WorkItemV1[]): void {
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

function listOriginPaths(repositoryRoot: string): string[] {
  const changesRoot = repositoryConsumerPath(
    repositoryRoot,
    repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot,
  );
  const stats = fs.lstatSync(changesRoot, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw registryInvalid('OpenSpec change root is unsafe.');
  }
  const paths: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw registryInvalid('Change origin tree contains a symbolic link.');
      }
      if (entry.isDirectory()) {
        visit(target, depth + 1);
      } else if (entry.isFile() && entry.name === 'origin.json') {
        paths.push(target);
      }
    }
  };
  visit(changesRoot, 0);
  return paths.sort();
}

function originChangeId(repositoryRoot: string, originPath: string): string {
  const changesRoot = repositoryConsumerPath(
    repositoryRoot,
    repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot,
  );
  const relative = path
    .relative(changesRoot, originPath)
    .replaceAll(path.sep, '/');
  const segments = relative.split('/');
  if (segments.length === 2) return changeIdentity(segments[0]!);
  if (segments.length === 3 && segments[0] === 'archive') {
    return changeIdentity(segments[1]!.replace(/^\d{4}-\d{2}-\d{2}-/, ''));
  }
  throw registryInvalid('Change origin path is invalid.');
}

function findOriginForChange(repositoryRoot: string, changeId: string): string {
  const matches = listOriginPaths(repositoryRoot).filter(
    (originPath) => originChangeId(repositoryRoot, originPath) === changeId,
  );
  if (matches.length !== 1) {
    throw registryInvalid('Linked change must resolve to one origin file.');
  }
  return matches[0]!;
}

function readSourceValue(
  repositoryRoot: string,
  sourceRef: `SRC-${string}`,
): GovernanceSourceV1 {
  return readGovernanceSource(
    repositoryRoot,
    sourceRef,
    repositoryWorkRegistryConfiguration(repositoryRoot).sourceRoot,
  );
}

function replaceTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const before = readOptionalPlainFile(filePath);
  if (before === content) return;
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  });
  try {
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function boundedText(value: string, maximum: number, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    value.includes('\0')
  ) {
    throw registryInvalid(`Work Item ${field} is invalid.`);
  }
  return value;
}

function changeIdentity(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw registryInvalid('Change identity is invalid.');
  }
  return value;
}

function canonicalTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw registryInvalid('Work Item timestamp is invalid.');
  }
  return value;
}

function registryInvalid(message: string) {
  return workflowError('WORK_REGISTRY_INVALID', message, ExitCode.usage);
}

function projectionDrift(message: string) {
  return workflowError(
    'WORK_REGISTRY_PROJECTION_DRIFT',
    message,
    ExitCode.verification,
    { recovery: 'Run `pnpm workflow work-item render --json`.' },
  );
}

function promotionIneligible(message: string) {
  return workflowError(
    'WORK_REGISTRY_PROMOTION_INELIGIBLE',
    message,
    ExitCode.conflict,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
