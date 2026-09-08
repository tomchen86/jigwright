import { createWorkRegistryQueries } from './work-registry-queries.ts';
import { createWorkRegistryStorage } from './work-registry-storage.ts';
import { createWorkRegistryPromotionPreparation } from './work-registry-promotion-preparation.ts';
import { createWorkRegistryProjectionOperations } from './work-registry-projections.ts';
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
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

import {
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  repositoryConsumerPath,
  repositoryWorkRegistryConfiguration,
} from '../repository-consumer/repository-consumer-config.ts';
import { readGovernanceSource } from './governance-intake.ts';
import {
  ORIGIN_KEYS,
  boundedText,
  canonicalTimestamp,
  changeIdentity,
  exactDigest,
  hasExactKeys,
  isRecord,
  parseOrigin,
  registryInvalid,
  sourceReferences,
  workItemDigest,
  workItemId,
  workItemKind,
  workItemLane,
  workItemReferences,
} from './work-registry-record.ts';
import {
  WorkRegistryPromotionCasMismatch,
  abortWorkItemPromotionTransaction,
  applyWorkItemPromotionTransaction,
  createWorkRegistryPromotionLocks,
  createWorkItemPromotionTransaction,
  findExactRecoveredWorkItemPromotion,
  markWorkItemPromotionRollback,
  parsePromotionItemContent,
  publishRecoveredWorkItemPromotion,
  publishWorkItemPromotionTransaction,
  readStablePromotionTarget,
  recoverWorkItemPromotionTransactionsUnlocked,
  removeWorkItemPromotionJournal,
  replayRecoveredWorkItemPromotion,
  workRegistryTransactionConflict,
} from './work-registry-promotion-transaction.ts';

export type WorkRegistryPromotionLockBindings = Readonly<{
  publishPreparedExclusiveLock: typeof publishPreparedExclusiveLock;
  reclaimDeadPreparedLock: typeof reclaimDeadPreparedLock;
  runGit: typeof runGit;
}>;

const {
  withWorkRegistryPromotionLock,
  withWorkRegistryPromotionLockWhenAvailable,
  withWorkRegistryPromotionReadLockWhenAvailable,
} = createWorkRegistryPromotionLocks({
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
  runGit,
});

export { workItemDigest } from './work-registry-record.ts';

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

export type WorkItemPromotionSurveyBindingV1 =
  | Readonly<{
      schemaVersion: 1;
      kind: 'current-survey';
      digest: `sha256:${string}`;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: 'not-required';
      reason: 'pure-maintainer-sources';
      sourceRefsDigest: `sha256:${string}`;
    }>;

export type WorkItemPromotionChangeEntryV1 =
  | Readonly<{
      path: string;
      kind: 'directory';
      mode: number;
    }>
  | Readonly<{
      path: string;
      kind: 'file';
      mode: number;
      digest: `sha256:${string}`;
    }>;

export type WorkItemPromotionPreparationBindingV1 = Readonly<{
  schemaVersion: 1;
  changeTarget:
    | Readonly<{ kind: 'absent-change' }>
    | Readonly<{
        kind: 'existing-change';
        directoryMode: number;
        entries: readonly WorkItemPromotionChangeEntryV1[];
        originDigest: `sha256:${string}` | null;
      }>;
  sourceRefsDigest: `sha256:${string}`;
  surveyPreparation:
    | Readonly<{
        kind: 'current-survey';
        binding: Extract<
          WorkItemPromotionSurveyBindingV1,
          { kind: 'current-survey' }
        >;
      }>
    | Readonly<{
        kind: 'not-required';
        binding: Extract<
          WorkItemPromotionSurveyBindingV1,
          { kind: 'not-required' }
        >;
      }>
    | Readonly<{
        kind: 'create-current-survey';
        binding: Extract<
          WorkItemPromotionSurveyBindingV1,
          { kind: 'current-survey' }
        >;
        survey: WorkItemPromotionSurveyV1;
      }>;
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

export type WorkItemPromotionTestHooks = Readonly<{
  /** Test-only hard-crash cut after durable intent and before tracked writes. */
  afterJournalPersisted?: () => void;
  /** Test-only ancestor swap after initial origin-parent validation. */
  afterOriginParentCapabilityAcquired?: () => void;
  /** Test-only hard-crash cut after origin publication and before item CAS. */
  afterOriginPublished?: () => void;
  /** Test-only hard-crash cut after both tracked writes and before cleanup. */
  afterItemPublished?: () => void;
  /** Test-only hard-crash cut after origin rollback captured prior bytes. */
  afterOriginRollbackCaptured?: () => void;
  /** Test-only hard-crash cut after item rollback captured prior bytes. */
  afterItemRollbackCaptured?: () => void;
  /** Test-only crash cut after tracked commit and durable journal cleanup. */
  afterTransactionCommitted?: () => void;
}>;

export type WorkRegistryReadTestHooks = Readonly<{
  /** Test-only cut after item facts and before related origin traversal. */
  afterItemSnapshot?: () => void;
}>;

export type WorkItemPromotionGrantBindingV1 = Readonly<{
  schemaVersion: 1;
  challengeId: string;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
  surveyBinding: WorkItemPromotionSurveyBindingV1;
}>;

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

export function createWorkItemAfterExactSourceTextRecheck(
  repositoryRoot: string,
  exactText: string,
  input: WorkItemAuthoringV1,
  dependencies: Readonly<{
    now?: () => string;
    createId?: () => string;
    aliases?: readonly string[];
  }> = {},
):
  | Readonly<{ created: false; matches: WorkItemV1[] }>
  | Readonly<{
      created: true;
      item: WorkItemV1;
      relativePath: string;
    }> {
  return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
    const inputSources = sourceReferences(input.sourceRefs).map((sourceRef) =>
      readSourceValue(repositoryRoot, sourceRef),
    );
    if (!inputSources.some(({ text }) => text === exactText)) {
      throw registryInvalid(
        'Work Item exact-wording recheck requires its captured Source.',
      );
    }
    const matches = findWorkItemsByExactSourceText(
      repositoryRoot,
      exactText,
    ).filter(({ closure, stage }) => closure === null && stage !== 'closed');
    if (matches.length > 0) return { created: false, matches };
    return {
      created: true,
      ...createWorkItem(repositoryRoot, input, dependencies),
    };
  });
}

export function ensureFindingConversionWorkItem(
  repositoryRoot: string,
  requestedFindingId: string,
  input: WorkItemAuthoringV1,
  createdAt: string,
): {
  item: WorkItemV1;
  relativePath: string;
  created: boolean;
} {
  if (!/^FND-[0-9a-f]{64}$/.test(requestedFindingId)) {
    throw registryInvalid('Governance Finding identity is invalid.');
  }
  const deterministicId = `WORK-${requestedFindingId
    .slice('FND-'.length, 'FND-'.length + 26)
    .toUpperCase()}`;
  return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
    const existing = listWorkItems(repositoryRoot).find(
      ({ id }) => id === deterministicId,
    );
    const ensured = createWorkItem(repositoryRoot, input, {
      now: () => createdAt,
      createId: () => deterministicId,
    });
    return { ...ensured, created: existing === undefined };
  });
}

export function attachSourceToWorkItem(
  repositoryRoot: string,
  requestedId: string,
  requestedSourceRef: string,
): { item: WorkItemV1; updated: boolean } {
  return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
    const id = workItemId(requestedId);
    const itemPath = findWorkItemPath(repositoryRoot, id);
    const item = readWorkItem(itemPath);
    if (item.closure !== null || item.stage === 'closed') {
      throw registryInvalid('A closed Work Item cannot receive a Source.');
    }
    const sourceRef = sourceReferences([requestedSourceRef])[0]!;
    readSource(repositoryRoot, sourceRef);
    const sourceRefs = sourceReferences([
      ...new Set([...item.sourceRefs, sourceRef]),
    ]);
    const next: WorkItemV1 = {
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

export function applyWorkItemReview(
  repositoryRoot: string,
  requestedId: string,
  review: WorkItemReviewV1,
  now: () => string = () => new Date().toISOString(),
): WorkItemV1 {
  return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
    applyWorkItemReviewUnlocked(repositoryRoot, requestedId, review, now),
  );
}

function applyWorkItemReviewUnlocked(
  repositoryRoot: string,
  requestedId: string,
  review: WorkItemReviewV1,
  now: () => string,
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
  testHooks: WorkItemPromotionTestHooks = {},
  grantBinding: WorkItemPromotionGrantBindingV1 | null = null,
): { item: WorkItemV1; originPath: string } {
  const id = workItemId(requestedId);
  const changeId = changeIdentity(requestedChangeId);
  return withWorkRegistryPromotionLock(repositoryRoot, (runtime) => {
    recoverWorkItemPromotionTransactionsUnlocked(runtime);
    const recovered = replayRecoveredWorkItemPromotion(
      runtime,
      id,
      changeId,
      requestedExpectedDigest,
      grantBinding,
    );
    if (recovered !== null) return recovered;
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
    const surveyBinding = observePromotionSurveyBinding(
      repositoryRoot,
      changeDirectory,
      item,
      changeId,
    );
    if (
      grantBinding !== null &&
      canonicalJson(surveyBinding) !== canonicalJson(grantBinding.surveyBinding)
    ) {
      throw promotionGrantStale(
        'Work Registry promotion survey binding changed after Grant approval.',
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
    const originBefore =
      readStablePromotionTarget(originPath, true)?.content ?? null;
    const origin = mergeOrigin(
      repositoryRoot,
      originBefore,
      promoted.sourceRefs,
      [promoted.id],
    );
    const requestedTransaction = createWorkItemPromotionTransaction(
      repositoryRoot,
      itemPath,
      originPath,
      itemBefore,
      originBefore,
      promoted,
      origin,
      grantBinding,
    );
    const persisted = publishWorkItemPromotionTransaction(
      runtime,
      requestedTransaction,
    );
    if (persisted.created) testHooks.afterJournalPersisted?.();
    try {
      applyWorkItemPromotionTransaction(
        runtime,
        persisted.transaction,
        testHooks,
      );
    } catch (error) {
      markWorkItemPromotionRollback(runtime, persisted.transaction);
      abortWorkItemPromotionTransaction(
        runtime,
        persisted.transaction,
        testHooks,
      );
      if (error instanceof WorkRegistryPromotionCasMismatch) {
        throw workRegistryTransactionConflict(
          'Work Item promotion inputs changed before compare-and-swap.',
        );
      }
      throw error;
    }
    if (persisted.transaction.grantBinding === null) {
      removeWorkItemPromotionJournal(runtime, persisted.transaction);
    } else {
      publishRecoveredWorkItemPromotion(runtime, persisted.transaction);
    }
    testHooks.afterTransactionCommitted?.();
    const committed = parsePromotionItemContent(
      persisted.transaction.after.itemContent,
    );
    return {
      item: committed,
      originPath: path.join(
        repositoryRoot,
        ...persisted.transaction.originRelativePath.split('/'),
      ),
    };
  });
}

/**
 * Verifies an exact Grant-bound receipt without projecting historical bytes as
 * current state. The Grant coordinator separately observes the actual current
 * poststate after accepting this durable proof of the completed effect.
 */
export function hasExactWorkItemPromotionReceipt(
  repositoryRoot: string,
  requestedId: string,
  requestedChangeId: string,
  requestedExpectedDigest: string,
  grantBinding: WorkItemPromotionGrantBindingV1,
): boolean {
  const id = workItemId(requestedId);
  const changeId = changeIdentity(requestedChangeId);
  const expectedDigest = exactDigest(requestedExpectedDigest);
  return withWorkRegistryPromotionLock(repositoryRoot, (runtime) => {
    recoverWorkItemPromotionTransactionsUnlocked(runtime);
    return (
      findExactRecoveredWorkItemPromotion(
        runtime,
        id,
        changeId,
        expectedDigest,
        grantBinding,
      ) !== null
    );
  });
}

export function hasExactCurrentWorkItemPromotion(
  repositoryRoot: string,
  requestedId: string,
  requestedChangeId: string,
): boolean {
  return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
    const item = showWorkItemUnlocked(repositoryRoot, requestedId);
    const changeId = changeIdentity(requestedChangeId);
    if (
      item.stage !== 'active' ||
      item.closure !== null ||
      canonicalJson(item.changeRefs) !== canonicalJson([changeId])
    ) {
      return false;
    }
    const changeDirectory = assertChangeDirectory(repositoryRoot, changeId);
    const originSource = readOptionalPlainFile(
      path.join(changeDirectory, 'origin.json'),
    );
    if (originSource === null) return false;
    const origin = parseOrigin(originSource);
    return (
      item.sourceRefs.every((sourceRef) =>
        origin.sourceRefs.includes(sourceRef),
      ) && origin.workItemRefs.includes(item.id)
    );
  });
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
  return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
    linkSourceToChangeUnlocked(
      repositoryRoot,
      requestedSourceId,
      requestedChangeId,
    ),
  );
}

function linkSourceToChangeUnlocked(
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
  return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
    reconcileArchivedWorkItemsUnlocked(
      repositoryRoot,
      requestedChangeId,
      archivedChangeRoot,
      requestedClosedAt,
    ),
  );
}

function reconcileArchivedWorkItemsUnlocked(
  repositoryRoot: string,
  requestedChangeId: string,
  archivedChangeRoot: string,
  requestedClosedAt: string,
): { closedItemIds: string[]; outputPaths: string[] } {
  const changeId = changeIdentity(requestedChangeId);
  const closedAt = canonicalTimestamp(requestedClosedAt);
  const workRegistry = repositoryWorkRegistryConfiguration(repositoryRoot);
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

function readSource(repositoryRoot: string, sourceRef: `SRC-${string}`): void {
  readSourceValue(repositoryRoot, sourceRef);
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

function readSourceValue(
  repositoryRoot: string,
  sourceRef: `SRC-${string}`,
): GovernanceSourceV1 {
  return readGovernanceSource(repositoryRoot, sourceRef);
}

function linkedSourceInterpretationSummary(
  sourceRefs: readonly `SRC-${string}`[],
): string {
  return boundedText(
    `Interpret and disposition linked Sources: ${sourceRefs.join(', ')}.`,
    2_000,
    'summary',
  );
}

function promotionIneligible(message: string) {
  return workflowError(
    'WORK_REGISTRY_PROMOTION_INELIGIBLE',
    message,
    ExitCode.conflict,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type WorkRegistryStorageBindings = Readonly<{
  withWorkRegistryPromotionLockWhenAvailable: typeof withWorkRegistryPromotionLockWhenAvailable;
}>;

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

export type WorkRegistryQueryBindings = Readonly<{
  withWorkRegistryPromotionLockWhenAvailable: typeof withWorkRegistryPromotionLockWhenAvailable;
  listWorkItemPaths: typeof listWorkItemPaths;
  readWorkItem: typeof readWorkItem;
  listWorkItemPathsUnlocked: typeof listWorkItemPathsUnlocked;
  withWorkRegistryPromotionReadLockWhenAvailable: typeof withWorkRegistryPromotionReadLockWhenAvailable;
  readSourceValue: typeof readSourceValue;
  readSource: typeof readSource;
  readOptionalPlainFile: typeof readOptionalPlainFile;
}>;

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
export const recommendWorkItemPriorities =
  workRegistryQueries.recommendWorkItemPriorities;
export const inspectWorkRegistry = workRegistryQueries.inspectWorkRegistry;
export const searchWorkItems = workRegistryQueries.searchWorkItems;
export const findWorkItemsByExactSourceText =
  workRegistryQueries.findWorkItemsByExactSourceText;
export const traceWorkItem = workRegistryQueries.traceWorkItem;
export const traceGovernanceSource = workRegistryQueries.traceGovernanceSource;
export const validateWorkRegistry = workRegistryQueries.validateWorkRegistry;
export const validateCurrentChangeOrigin =
  workRegistryQueries.validateCurrentChangeOrigin;
export const readCurrentChangeOrigin =
  workRegistryQueries.readCurrentChangeOrigin;
const assertNoProspectiveCycle = workRegistryQueries.assertNoProspectiveCycle;
const showWorkItemUnlocked = workRegistryQueries.showWorkItemUnlocked;
const validateWorkRegistryUnlocked =
  workRegistryQueries.validateWorkRegistryUnlocked;
const listWorkItemsUnlocked = workRegistryQueries.listWorkItemsUnlocked;
const inspectWorkRegistryUnlocked =
  workRegistryQueries.inspectWorkRegistryUnlocked;

export type WorkRegistryProjectionOperationBindings = Readonly<{
  withWorkRegistryPromotionLockWhenAvailable: typeof withWorkRegistryPromotionLockWhenAvailable;
  validateWorkRegistryUnlocked: typeof validateWorkRegistryUnlocked;
  listWorkItemsUnlocked: typeof listWorkItemsUnlocked;
  inspectWorkRegistryUnlocked: typeof inspectWorkRegistryUnlocked;
  readOptionalPlainFile: typeof readOptionalPlainFile;
  validateWorkRegistry: typeof validateWorkRegistry;
}>;

const workRegistryProjectionOperations = createWorkRegistryProjectionOperations(
  {
    withWorkRegistryPromotionLockWhenAvailable,
    validateWorkRegistryUnlocked,
    listWorkItemsUnlocked,
    inspectWorkRegistryUnlocked,
    readOptionalPlainFile,
    validateWorkRegistry,
  },
);
export const renderWorkRegistry =
  workRegistryProjectionOperations.renderWorkRegistry;
export const workRegistryProjectionBindings =
  workRegistryProjectionOperations.workRegistryProjectionBindings;
export const inspectWorkRegistryProjectionStatus =
  workRegistryProjectionOperations.inspectWorkRegistryProjectionStatus;
export const validateWorkRegistryProjections =
  workRegistryProjectionOperations.validateWorkRegistryProjections;

export type WorkRegistryPromotionPreparationBindings = Readonly<{
  withWorkRegistryPromotionLockWhenAvailable: typeof withWorkRegistryPromotionLockWhenAvailable;
  showWorkItem: typeof showWorkItem;
  assertPromotionEligible: typeof assertPromotionEligible;
  assertChangeDirectory: typeof assertChangeDirectory;
  runGit: typeof runGit;
  replaceCanonicalFile: typeof replaceCanonicalFile;
  readOptionalPlainFile: typeof readOptionalPlainFile;
  showWorkItemUnlocked: typeof showWorkItemUnlocked;
  readSourceValue: typeof readSourceValue;
}>;

const workRegistryPromotionPreparation = createWorkRegistryPromotionPreparation(
  {
    withWorkRegistryPromotionLockWhenAvailable,
    showWorkItem,
    assertPromotionEligible,
    assertChangeDirectory,
    runGit,
    replaceCanonicalFile,
    readOptionalPlainFile,
    showWorkItemUnlocked,
    readSourceValue,
  },
);
export const prepareWorkItemPromotionSurvey =
  workRegistryPromotionPreparation.prepareWorkItemPromotionSurvey;
export const ensureWorkItemPromotionSurveyBinding =
  workRegistryPromotionPreparation.ensureWorkItemPromotionSurveyBinding;
export const ensureWorkItemPromotionChangeDirectory =
  workRegistryPromotionPreparation.ensureWorkItemPromotionChangeDirectory;
export const observeWorkItemPromotionPreparationBinding =
  workRegistryPromotionPreparation.observeWorkItemPromotionPreparationBinding;
export const prepareWorkItemPromotionFromBinding =
  workRegistryPromotionPreparation.prepareWorkItemPromotionFromBinding;
export const workItemPromotionPreparationMatches =
  workRegistryPromotionPreparation.workItemPromotionPreparationMatches;
export const observeWorkItemPromotionSurveyBinding =
  workRegistryPromotionPreparation.observeWorkItemPromotionSurveyBinding;
export const readWorkItemPromotionSurveyBinding =
  workRegistryPromotionPreparation.readWorkItemPromotionSurveyBinding;
const observePromotionSurveyBinding =
  workRegistryPromotionPreparation.observePromotionSurveyBinding;
const promotionGrantStale =
  workRegistryPromotionPreparation.promotionGrantStale;
