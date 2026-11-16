/** Coordinates canonical Work Item writes, reviewed transitions and paired origin changes. */
import { canonicalJson } from '@jigwright/core/canonical-json';
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  ChangeOriginV1,
  WorkItemAuthoringV1,
  WorkItemPromotionGrantBindingV1,
  WorkItemReviewV1,
  WorkItemV1,
  WorkRegistryGovernedTransition,
  WorkRegistryGrantRequiredDetailsV1,
  WorkRegistryTransitionPolicyV1,
} from '../../modules/governance-intake/work-registry-contracts.ts';

import {
  boundedText,
  canonicalTimestamp,
  changeIdentity,
  exactDigest,
  parseOrigin,
  registryInvalid,
  sourceReferences,
  workItemDigest,
  workItemId,
  workItemKind,
  workItemLane,
} from '../../modules/governance-intake/work-registry-record.ts';

import type { WorkItemPromotionTestHooks } from '../../modules/governance-intake/work-registry-contracts.ts';
import {
  assertPromotionBlockerClosed,
  assertPromotionCandidate,
  mergeOrigin as mergeOriginValues,
  parseWorkRegistryTransitionPolicy,
  projectWorkItemReview,
  workItemAliases,
  workItemReviewDependencies,
} from '../../modules/governance-intake/work-registry-policy.ts';
import {
  projectSourceUpdateOrigin,
  projectWorkItemSourceUpdate,
  type WorkItemSourceUpdateV1,
} from '../../modules/governance-intake/work-registry-source-update.ts';
import type { createWorkRegistryProjectionOperations } from './work-registry-projections.ts';
import { createWorkRegistryPromotionPreparation } from './work-registry-promotion-preparation.ts';
import type { createWorkRegistryQueries } from './work-registry-queries.ts';
import type { WorkRegistryWriteRepository } from './work-registry-repository.ts';
export type { WorkRegistryReadTestHooks } from './work-registry-queries.ts';
export function createWorkRegistryWriteService(
  services: Readonly<{
    repository: WorkRegistryWriteRepository;
    queries: ReturnType<typeof createWorkRegistryQueries>;
    projections: Pick<
      ReturnType<typeof createWorkRegistryProjectionOperations>,
      'renderWorkRegistry'
    >;
    readSource(root: string, id: `SRC-${string}`): GovernanceSourceV1;
  }>,
) {
  const { repository } = services;
  const withWorkRegistryPromotionLock = repository.withPromotion;
  const withWorkRegistryPromotionLockWhenAvailable = repository.withRegistry;
  const {
    findItem: findWorkItemPath,
    readItem: readWorkItem,
    readItemSnapshot: readWorkItemRecord,
    createItem: createCanonicalFile,
    replaceItem: replaceCanonicalFile,
    readRecordText: readOptionalPlainFile,
    changeDirectory: assertChangeDirectory,
  } = repository;
  const {
    showWorkItem,
    listWorkItems,
    findWorkItemsByExactSourceText,
    assertNoProspectiveCycle,
    showWorkItemUnlocked,
    validateWorkRegistry,
  } = services.queries;
  const { renderWorkRegistry } = services.projections;
  const preparation = createWorkRegistryPromotionPreparation(
    repository,
    services.queries,
    readSourceValue,
    assertPromotionEligible,
  );
  const { observePromotionSurveyBinding, promotionGrantStale } = preparation;
  function loadWorkRegistryTransitionPolicy(
    root: string,
  ): WorkRegistryTransitionPolicyV1 {
    const policyPath = repository.resolvePath(
      root,
      repository.layout(root).transitionPolicyPath,
    );
    return parseWorkRegistryTransitionPolicy(readOptionalPlainFile(policyPath));
  }
  function createWorkItem(
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
      (dependencies.createId ?? (() => repository.createId(createdAt)))(),
    );
    const sourceRefs = sourceReferences(input.sourceRefs);
    const aliases = workItemAliases(dependencies.aliases ?? []);
    const existingAliases = new Set(
      listWorkItems(repositoryRoot).flatMap((item) => [
        item.id,
        ...item.aliases,
      ]),
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
      repository.layout(repositoryRoot).itemRoot,
      year,
      `${id}.yaml`,
    );
    createCanonicalFile(
      path.join(repositoryRoot, ...relativePath.split('/')),
      item,
    );
    return { item, relativePath };
  }

  function createWorkItemAfterExactSourceTextRecheck(
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

  function ensureFindingConversionWorkItem(
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

  function attachSourceToWorkItem(
    repositoryRoot: string,
    requestedId: string,
    requestedSourceRef: string,
  ): { item: WorkItemV1; updated: boolean } {
    return updateWorkItemSource(
      repositoryRoot,
      requestedId,
      requestedSourceRef,
      null,
    );
  }

  function correctWorkItemSource(
    repositoryRoot: string,
    requestedId: string,
    replacedSourceRef: string,
    requestedSourceRef: string,
    expectedDigest?: string,
    testHooks: WorkItemPromotionTestHooks = {},
  ): { item: WorkItemV1; updated: boolean } {
    return updateWorkItemSource(
      repositoryRoot,
      requestedId,
      requestedSourceRef,
      replacedSourceRef,
      expectedDigest,
      testHooks,
    );
  }

  function updateWorkItemSource(
    repositoryRoot: string,
    requestedId: string,
    requestedSourceRef: string,
    replacedSourceRef: string | null,
    expectedDigest?: string,
    testHooks: WorkItemPromotionTestHooks = {},
  ): { item: WorkItemV1; updated: boolean } {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
      const itemPath = findWorkItemPath(
        repositoryRoot,
        workItemId(requestedId),
      );
      const { item, serialized: itemBefore } = readWorkItemRecord(itemPath);
      const source = readSourceValue(
        repositoryRoot,
        sourceReferences([requestedSourceRef])[0]!,
      );
      const replaces =
        replacedSourceRef === null
          ? null
          : sourceReferences([replacedSourceRef])[0]!;
      if (
        replaces !== null &&
        (source.supersedes !== replaces || source.id === replaces)
      )
        throw registryInvalid(
          'A correction requires a new Source superseding the specified original.',
        );
      const update: WorkItemSourceUpdateV1 = {
        sourceRef: source.id,
        replaces,
        retainReplacedOrigin: false,
      };
      const next = projectWorkItemSourceUpdate(item, update);
      if (next === item && item.stage !== 'active')
        return { item, updated: false };
      if (
        next !== item &&
        expectedDigest !== undefined &&
        workItemDigest(item) !== exactDigest(expectedDigest)
      ) {
        throw workflowError(
          'WORK_REGISTRY_STALE',
          'Work Item changed before its Source update.',
          ExitCode.conflict,
        );
      }
      if (item.stage !== 'active') {
        replaceCanonicalFile(itemPath, next);
        return { item: next, updated: true };
      }
      return withWorkRegistryPromotionLock(repositoryRoot, (runtime) => {
        const originPath = path.join(
          assertChangeDirectory(repositoryRoot, item.changeRefs[0]!),
          'origin.json',
        );
        const originBefore = repository.readOriginBefore(originPath, false)!;
        const beforeOrigin = parseOrigin(originBefore);
        const retainedUpdate: WorkItemSourceUpdateV1 = {
          ...update,
          retainReplacedOrigin:
            replaces !== null &&
            beforeOrigin.workItemRefs.some(
              (id) =>
                id !== item.id &&
                showWorkItem(repositoryRoot, id).sourceRefs.includes(replaces),
            ),
        };
        const origin = projectSourceUpdateOrigin(
          beforeOrigin,
          next,
          retainedUpdate,
        );
        if (
          next === item &&
          canonicalJson(origin) === canonicalJson(beforeOrigin)
        )
          return { item, updated: false };
        if (
          expectedDigest !== undefined &&
          workItemDigest(item) !== exactDigest(expectedDigest)
        ) {
          throw workflowError(
            'WORK_REGISTRY_STALE',
            'Work Item changed before its Source update.',
            ExitCode.conflict,
          );
        }
        runtime.commit(
          {
            itemPath,
            originPath,
            itemBefore,
            originBefore,
            item: next,
            origin,
            grantBinding: null,
            sourceUpdate: retainedUpdate,
          },
          testHooks,
        );
        return { item: next, updated: true };
      });
    });
  }

  function workRegistryTransitionRequiresGrant(
    repositoryRoot: string,
    transition: WorkRegistryGovernedTransition,
  ): boolean {
    return (
      loadWorkRegistryTransitionPolicy(repositoryRoot).transitions[
        transition
      ] === 'central-grant'
    );
  }

  function assertOrdinaryWorkRegistryTransition(
    repositoryRoot: string,
    transition: WorkRegistryGovernedTransition,
    recovery: string,
    details?: WorkRegistryGrantRequiredDetailsV1,
  ): void {
    if (!workRegistryTransitionRequiresGrant(repositoryRoot, transition))
      return;
    throw workflowError(
      'WORK_REGISTRY_GRANT_REQUIRED',
      `Repository policy requires Central Grant for the ${transition} transition.`,
      ExitCode.guard,
      { recovery, ...(details === undefined ? {} : { details }) },
    );
  }

  function applyWorkItemReview(
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
    const blockedBy = workItemReviewDependencies(item, review);
    if (review.action === 'prioritize') {
      for (const blocker of blockedBy) showWorkItem(repositoryRoot, blocker);
      assertNoProspectiveCycle(repositoryRoot, item.id, blockedBy);
    }
    const next = projectWorkItemReview(item, review, at, blockedBy);
    replaceCanonicalFile(itemPath, next);
    return next;
  }

  function promoteWorkItem(
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
      runtime.recover();
      const recovered = runtime.replay(
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
        canonicalJson(surveyBinding) !==
          canonicalJson(grantBinding.surveyBinding)
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
      const originBefore = repository.readOriginBefore(originPath, true);
      const origin = mergeOrigin(
        repositoryRoot,
        originBefore,
        promoted.sourceRefs,
        [promoted.id],
      );
      return runtime.commit(
        {
          itemPath,
          originPath,
          itemBefore,
          originBefore,
          item: promoted,
          origin,
          grantBinding,
        },
        testHooks,
      );
    });
  }

  function hasExactWorkItemPromotionReceipt(
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
      runtime.recover();
      return runtime.hasReceipt(id, changeId, expectedDigest, grantBinding);
    });
  }

  function hasExactCurrentWorkItemPromotion(
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

  function linkSourceToChange(
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
    const changeDirectory = repository.changeDirectory(
      repositoryRoot,
      changeId,
      'Source linking',
    );
    const originPath = path.join(changeDirectory, 'origin.json');
    const before = readOptionalPlainFile(originPath);
    const origin = mergeOrigin(repositoryRoot, before, [sourceRef!], []);
    const content = `${canonicalJson(origin)}\n`;
    if (before === content) {
      return { origin, originPath, created: false };
    }
    repository.writeOrigin(originPath, origin);
    return { origin, originPath, created: true };
  }

  function reconcileArchivedWorkItems(
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
    const workRegistry = repository.layout(repositoryRoot);
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
        timeline: [
          ...item.timeline,
          { at: closedAt, event: 'closed', changeId },
        ],
        closure: { at: closedAt, outcome: 'delivered', changeId },
      };
      replaceCanonicalFile(itemPath, closed);
      return itemPath;
    });
    const rendered = renderWorkRegistry(repositoryRoot);
    const historyPath = path.join(
      repository.resolvePath(
        repositoryRoot,
        repository.layout(repositoryRoot).historyRoot,
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
    const merged = mergeOriginValues(existingText, sourceRefs, workItemRefs);
    for (const sourceRef of merged.sourceRefs)
      readSource(repositoryRoot, sourceRef);
    return merged;
  }

  function readSource(
    repositoryRoot: string,
    sourceRef: `SRC-${string}`,
  ): void {
    readSourceValue(repositoryRoot, sourceRef);
  }

  function assertPromotionEligible(
    repositoryRoot: string,
    item: WorkItemV1,
  ): void {
    assertPromotionCandidate(item);
    for (const blockerId of item.blockedBy) {
      const blocker = showWorkItem(repositoryRoot, blockerId);
      assertPromotionBlockerClosed(blocker);
    }
  }

  function readSourceValue(
    repositoryRoot: string,
    sourceRef: `SRC-${string}`,
  ): GovernanceSourceV1 {
    return services.readSource(repositoryRoot, sourceRef);
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return {
    createWorkItem,
    createWorkItemAfterExactSourceTextRecheck,
    ensureFindingConversionWorkItem,
    attachSourceToWorkItem,
    correctWorkItemSource,
    workRegistryTransitionRequiresGrant,
    assertOrdinaryWorkRegistryTransition,
    applyWorkItemReview,
    promoteWorkItem,
    hasExactWorkItemPromotionReceipt,
    hasExactCurrentWorkItemPromotion,
    linkSourceToChange,
    reconcileArchivedWorkItems,
    ...preparation,
  };
}
