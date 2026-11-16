/** Owns semantic intake decisions and primitive ordering without CLI or repository effects. */
import crypto from 'node:crypto';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  deferredIntakeDestination,
  isRequirementKind,
  type INTAKE_KINDS,
} from '../../modules/governance-intake/intake-policy.ts';
import { projectGovernanceIntakeCounts } from '../../modules/governance-intake/intake-summary.ts';
import { workItemDigest } from '../../modules/governance-intake/work-registry-record.ts';
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';
import type { GovernanceFindingContextV1 } from '../../modules/governance-intake/governance-intake.ts';
import type {
  WorkItemReviewV1,
  WorkItemPromotionSurveyDeclarationV1,
} from '../../modules/governance-intake/work-registry-contracts.ts';
import type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
import type { createGovernanceSourceServices } from '../../modules/governance-intake/governance-sources.ts';
import type { createGovernanceFindingServices } from './governance-findings.ts';
import type { createWorkRegistryWriteService } from '../work-registry/work-registry.ts';
import type { createWorkRegistryQueries } from '../work-registry/work-registry-queries.ts';
export type IntakeKind = (typeof INTAKE_KINDS)[number];
export type ImmediateChangeStart = (
  cwd: string,
  changeId: string,
  intent: Readonly<NormalizedChangeIntent>,
  immediateSource: Readonly<{
    sourceId: GovernanceSourceV1['id'];
    exactText: string;
  }> | null,
) => unknown;
export type GovernanceIntakeWorkflowOptions = Readonly<{
  now?: () => string;
  afterNowSourceCaptured?: () => void;
  afterFindingConversionWorkItemPersisted?: () => void;
  afterLaterSourceCaptured?: () => void;
  afterCorrectSourceCaptured?: () => void;
  startImmediateChange?: ImmediateChangeStart;
}>;
export type GovernanceIntakeWorkflowOperations = {
  sources: Pick<
    ReturnType<typeof createGovernanceSourceServices>,
    'captureGovernanceSource' | 'listGovernanceSources' | 'readGovernanceSource'
  >;
  findings: Pick<
    ReturnType<typeof createGovernanceFindingServices>,
    | 'convertGovernanceFinding'
    | 'linkGovernanceFinding'
    | 'listGovernanceFindings'
    | 'recordGovernanceFinding'
  >;
  writes: Pick<
    ReturnType<typeof createWorkRegistryWriteService>,
    | 'applyWorkItemReview'
    | 'attachSourceToWorkItem'
    | 'assertOrdinaryWorkRegistryTransition'
    | 'createWorkItem'
    | 'correctWorkItemSource'
    | 'createWorkItemAfterExactSourceTextRecheck'
    | 'ensureWorkItemPromotionChangeDirectory'
    | 'ensureWorkItemPromotionSurveyBinding'
    | 'ensureFindingConversionWorkItem'
    | 'hasExactCurrentWorkItemPromotion'
    | 'prepareWorkItemPromotionSurvey'
    | 'promoteWorkItem'
  >;
  queries: Pick<
    ReturnType<typeof createWorkRegistryQueries>,
    'listWorkItems' | 'findWorkItemsByExactSourceText' | 'showWorkItem'
  >;
  context: {
    taskScope(cwd: string): GovernanceFindingContextV1 | null;
    runtimeRoot(cwd: string): string;
    existingChange(cwd: string, changeId: string): string;
  };
  now(): string;
};
/** Transport adds its usage hint after this lexical refusal at the original observation point. */
export class GovernanceIntakeTextError extends Error {}
const SOURCE_ID = /^SRC-[0-9a-f]{64}$/u;
function intakeUsage(message: string) {
  return workflowError('GOVERNANCE_INTAKE_INVALID', message, ExitCode.usage);
}
function clipTitle(text: string): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim();
  return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 159)}…`;
}
export function createGovernanceIntakeWorkflow(
  operations: GovernanceIntakeWorkflowOperations,
  dependencies: GovernanceIntakeWorkflowOptions = {},
) {
  const {
    captureGovernanceSource,
    listGovernanceSources,
    readGovernanceSource,
  } = operations.sources;
  const {
    convertGovernanceFinding,
    linkGovernanceFinding,
    listGovernanceFindings,
    recordGovernanceFinding,
  } = operations.findings;
  const {
    applyWorkItemReview,
    attachSourceToWorkItem,
    assertOrdinaryWorkRegistryTransition,
    createWorkItem,
    correctWorkItemSource,
    createWorkItemAfterExactSourceTextRecheck,
    ensureWorkItemPromotionChangeDirectory,
    ensureWorkItemPromotionSurveyBinding,
    ensureFindingConversionWorkItem,
    hasExactCurrentWorkItemPromotion,
    prepareWorkItemPromotionSurvey,
    promoteWorkItem,
  } = operations.writes;
  const { listWorkItems, findWorkItemsByExactSourceText, showWorkItem } =
    operations.queries;
  function findOpenWorkItemsBySummary(cwd: string, text: string) {
    return listWorkItems(cwd).filter(
      (item) =>
        item.closure === null &&
        item.stage !== 'closed' &&
        item.interpretation.summary === text,
    );
  }
  function startWorkItem(
    cwd: string,
    id: string,
    grantGuidance: (
      id: string,
      changeId: string,
      expectedDigest: string,
    ) => string,
  ) {
    const workItem = showWorkItem(cwd, id);
    const originalTexts = workItem.sourceRefs.map(
      (sourceRef) => readGovernanceSource(cwd, sourceRef).text,
    );
    const changeId = `work-${workItem.id.slice('WORK-'.length).toLowerCase()}`;
    if (hasExactCurrentWorkItemPromotion(cwd, workItem.id, changeId)) {
      return {
        outcome: 'promoted' as const,
        workItemId: workItem.id,
        title: workItem.title,
        sourceRefs: workItem.sourceRefs,
        originalTexts,
        promoted: true,
        changeId,
      };
    }
    if (workItem.stage === 'inbox') {
      return {
        outcome: 'needs-review' as const,
        workItemId: workItem.id,
        title: workItem.title,
        sourceRefs: workItem.sourceRefs,
        originalTexts,
        promoted: false,
        changeId: null,
      };
    }
    if (
      workItem.stage !== 'backlog' ||
      workItem.interpretation.status !== 'maintainer-confirmed'
    ) {
      throw workflowError(
        'WORK_REGISTRY_INVALID',
        'Immediate Work Item promotion requires a current unpromoted backlog item.',
        ExitCode.usage,
      );
    }
    if (workItem.lane !== 'now' && workItem.lane !== 'next') {
      return {
        outcome: 'needs-priority' as const,
        workItemId: workItem.id,
        title: workItem.title,
        sourceRefs: workItem.sourceRefs,
        originalTexts,
        promoted: false,
        changeId: null,
      };
    }
    if (workItem.blockedBy.length > 0) {
      const openBlockers = workItem.blockedBy.filter(
        (blockerId) => showWorkItem(cwd, blockerId).stage !== 'closed',
      );
      if (openBlockers.length > 0) {
        return {
          outcome: 'blocked' as const,
          workItemId: workItem.id,
          title: workItem.title,
          sourceRefs: workItem.sourceRefs,
          originalTexts,
          promoted: false,
          changeId: null,
          blockingWorkItemIds: openBlockers,
        };
      }
    }
    const expectedDigest = workItemDigest(workItem);
    assertOrdinaryWorkRegistryTransition(
      cwd,
      'promote',
      grantGuidance(workItem.id, changeId, expectedDigest),
      {
        schemaVersion: 1,
        kind: 'work-registry-grant-required.v1',
        operation: 'promote',
        transition: 'promote',
        workItemId: workItem.id,
        changeId,
        expectedDigest,
      },
    );
    ensureWorkItemPromotionChangeDirectory(cwd, changeId);
    ensureWorkItemPromotionSurveyBinding(cwd, workItem.id, changeId);
    const promoted = promoteWorkItem(
      cwd,
      workItem.id,
      changeId,
      dependencies.now,
      expectedDigest,
    );
    return {
      outcome: 'promoted' as const,
      workItemId: promoted.item.id,
      title: promoted.item.title,
      sourceRefs: promoted.item.sourceRefs,
      originalTexts,
      promoted: true,
      changeId,
    };
  }
  function startText(cwd: string, exactText: string, kind: IntakeKind) {
    if (dependencies.startImmediateChange === undefined) {
      throw intakeUsage('Immediate change start dependency is unavailable.');
    }
    const changeId = `source-${crypto.createHash('sha256').update(exactText).digest('hex')}`;
    if (!isRequirementKind(kind)) {
      // An observation starts a change without a Source: nothing here is a
      // requirement the implementation must be read against.
      const intent = {
        schemaVersion: 1 as const,
        summary: exactText,
        sourceRefs: [],
        explicitPaths: [],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      };
      const propose = dependencies.startImmediateChange(
        cwd,
        changeId,
        intent,
        null,
      );
      return {
        originalText: exactText,
        kind,
        sourceId: null,
        changeId,
        propose,
      };
    }
    const existing = listGovernanceSources(cwd)
      .filter(
        (source) =>
          source.semanticAuthor === 'maintainer' &&
          source.supersedes === null &&
          source.text === exactText,
      )
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    const captured =
      existing === undefined
        ? captureGovernanceSource(cwd, {
            semanticAuthor: 'maintainer',
            capturedBy: 'jigwright-intake',
            capturedAt: (dependencies.now ?? operations.now)(),
            contextRef: 'direct-human:workflow-cli',
            text: exactText,
            supersedes: null,
          })
        : null;
    if (captured !== null) dependencies.afterNowSourceCaptured?.();
    const source = captured?.source ?? existing!;
    const intent = {
      schemaVersion: 1 as const,
      summary: `Implement the immediate change cited by ${source.id}.`,
      sourceRefs: [source.id],
      explicitPaths: [],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    };
    const propose = dependencies.startImmediateChange(cwd, changeId, intent, {
      sourceId: source.id,
      exactText,
    });
    return {
      originalText: exactText,
      kind,
      sourceId: source.id,
      changeId,
      propose,
    };
  }
  function deferText(cwd: string, originalText: string, kind: IntakeKind) {
    const capturedAt = (dependencies.now ?? operations.now)();
    // Inside a task the registry is off-limits and an observation must not
    // land in the task diff, so it is staged as a Finding and flushed to the
    // inbox at triage. Outside a task the inbox is the front door.
    const taskScope = operations.context.taskScope(cwd);
    if (taskScope !== null && deferredIntakeDestination(true) === 'finding') {
      const staged = recordGovernanceFinding(
        taskScope,
        { schemaVersion: 1, text: originalText, sourceRefs: [] },
        dependencies.now,
      );
      return {
        outcome: 'finding' as const,
        originalText,
        kind,
        staged: 'finding',
        findingId: staged.finding.id,
        sessionId: staged.finding.sessionId,
        changeId: staged.finding.changeId,
        created: staged.created,
      };
    }
    if (!isRequirementKind(kind)) {
      // An observation goes to the inbox as it is: no Source, because it is
      // not wording the implementation must be read against.
      const matches = findOpenWorkItemsBySummary(cwd, originalText);
      if (matches.length > 0) {
        return {
          outcome: 'observation-match' as const,
          originalText,
          kind,
          sourceId: null,
          sourceLinked: false,
          deduplicated: true,
          matches: matches.map(({ id }) => id),
        };
      }
      const created = createWorkItem(
        cwd,
        {
          schemaVersion: 1,
          kind,
          lane: null,
          title: clipTitle(originalText),
          summary: originalText,
          sourceRefs: [],
        },
        { now: () => capturedAt },
      );
      return {
        outcome: 'created' as const,
        originalText,
        kind,
        sourceId: null,
        sourceLinked: false,
        workItemId: created.item.id,
        title: created.item.title,
        deduplicated: false,
      };
    }
    const matches = findWorkItemsByExactSourceText(cwd, originalText).filter(
      ({ closure, stage }) => closure === null && stage !== 'closed',
    );
    if (matches.length > 0) {
      return {
        outcome: 'requirement-match' as const,
        originalText,
        kind,
        sourceId: null,
        sourceLinked: false,
        deduplicated: true,
        matches: matches.map(({ id }) => id),
      };
    }
    const source = captureGovernanceSource(cwd, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright-intake',
      capturedAt,
      contextRef: 'direct-human:workflow-cli',
      text: originalText,
      supersedes: null,
    });
    dependencies.afterLaterSourceCaptured?.();
    const workItem = createWorkItemAfterExactSourceTextRecheck(
      cwd,
      originalText,
      {
        schemaVersion: 1,
        kind,
        lane: null,
        title: `Review captured Source ${source.source.id}`,
        summary: 'Interpret and disposition the linked Source.',
        sourceRefs: [source.source.id],
      },
      { now: () => capturedAt },
    );
    if (!workItem.created) {
      return {
        outcome: 'requirement-match' as const,
        originalText,
        kind,
        sourceId: source.source.id,
        sourceLinked: false,
        deduplicated: true,
        matches: workItem.matches.map(({ id }) => id),
      };
    }
    return {
      outcome: 'created' as const,
      originalText,
      kind,
      sourceId: source.source.id,
      sourceLinked: true,
      workItemId: workItem.item.id,
      title: workItem.item.title,
      deduplicated: false,
    };
  }
  function attachSource(
    cwd: string,
    id: string,
    request: Readonly<{ kind: 'existing' | 'wording'; value: string }>,
    supersedes: string | null,
  ) {
    const current = showWorkItem(cwd, id);
    if (current.closure !== null || current.stage === 'closed') {
      throw intakeUsage('A closed Work Item cannot receive a Source.');
    }
    if (request.kind === 'existing') {
      // An existing Source is linked as it is: the wording already lives in
      // the ledger and is never minted twice.
      if (supersedes !== null) {
        throw intakeUsage(
          'Linking an existing Source cannot also supersede one; capture new wording instead.',
        );
      }
      const source = readGovernanceSource(cwd, request.value);
      const attached = attachSourceToWorkItem(cwd, current.id, source.id);
      return {
        originalText: source.text,
        sourceId: source.id,
        supersedes: source.supersedes,
        workItemId: attached.item.id,
        title: attached.item.title,
        updated: attached.updated,
      };
    }
    const originalText = request.value;
    if (originalText.trim().length === 0 || originalText.startsWith('-'))
      throw new GovernanceIntakeTextError();
    if (supersedes !== null && !SOURCE_ID.test(supersedes)) {
      throw intakeUsage('--supersedes needs an existing Source identity.');
    }
    const supersedesRef = supersedes as `SRC-${string}` | null;
    const exactMatch = findWorkItemsByExactSourceText(cwd, originalText).find(
      ({ id }) => id === current.id,
    );
    const existingSourceRef = exactMatch?.sourceRefs.find((sourceRef) => {
      const source = readGovernanceSource(cwd, sourceRef);
      return (
        source.text === originalText && source.supersedes === supersedesRef
      );
    });
    const source =
      existingSourceRef === undefined
        ? captureGovernanceSource(cwd, {
            semanticAuthor: 'maintainer',
            capturedBy: 'jigwright-intake',
            capturedAt: (dependencies.now ?? operations.now)(),
            contextRef: 'direct-human:workflow-cli',
            text: originalText,
            supersedes: supersedesRef,
          }).source
        : readGovernanceSource(cwd, existingSourceRef);
    const attached = attachSourceToWorkItem(cwd, current.id, source.id);
    return {
      originalText,
      sourceId: source.id,
      supersedes,
      workItemId: attached.item.id,
      title: attached.item.title,
      updated: attached.updated,
    };
  }
  function correctSource(
    cwd: string,
    id: string,
    oldRef: GovernanceSourceV1['id'],
    originalText: string,
  ) {
    const current = showWorkItem(cwd, id);
    if (current.stage === 'closed' || current.closure !== null)
      throw intakeUsage('A closed Work Item cannot receive a Source.');
    readGovernanceSource(cwd, oldRef);
    const matches = listGovernanceSources(cwd).filter(
      (source) =>
        source.semanticAuthor === 'maintainer' &&
        source.supersedes === oldRef &&
        source.text === originalText,
    );
    const attached = matches.find((source) =>
      current.sourceRefs.includes(source.id),
    );
    if (!current.sourceRefs.includes(oldRef) && attached === undefined)
      throw intakeUsage(
        'The Source being corrected is not linked to this Work Item.',
      );
    const source =
      attached ??
      matches[0] ??
      captureGovernanceSource(cwd, {
        semanticAuthor: 'maintainer',
        capturedBy: 'jigwright-intake',
        capturedAt: (dependencies.now ?? operations.now)(),
        contextRef: 'direct-human:workflow-cli',
        text: originalText,
        supersedes: oldRef,
      }).source;
    dependencies.afterCorrectSourceCaptured?.();
    const corrected = correctWorkItemSource(
      cwd,
      current.id,
      oldRef,
      source.id,
      workItemDigest(current),
    );
    return {
      originalText: source.text,
      title: corrected.item.title,
      sourceId: source.id,
      supersedes: source.supersedes,
      workItemId: corrected.item.id,
      updated: corrected.updated,
    };
  }
  function convertFinding(
    cwd: string,
    findingId: string,
    kind: IntakeKind,
    now: boolean,
  ) {
    const runtimeRoot = operations.context.runtimeRoot(cwd);
    const finding = listGovernanceFindings(runtimeRoot).find(
      ({ id }) => id === findingId,
    );
    if (finding === undefined) {
      throw intakeUsage('Governance Finding does not exist.');
    }
    const workItemId = `WORK-${finding.id
      .slice('FND-'.length, 'FND-'.length + 26)
      .toUpperCase()}`;
    if (
      finding.disposition !== 'pending' &&
      (finding.disposition !== 'converted' ||
        finding.target?.kind !== 'work-item' ||
        finding.target.id !== workItemId)
    ) {
      throw workflowError(
        'GOVERNANCE_FINDING_DISPOSITION_COLLISION',
        'Governance Finding already has a different terminal disposition.',
        ExitCode.conflict,
      );
    }
    // A Finding is an observation, so converting it mints no Source: the
    // inbox item carries the note itself and only the Sources the Finding
    // already cited.
    const sourceRefs = [...new Set(finding.sourceRefs)].sort();
    for (const sourceRef of sourceRefs) readGovernanceSource(cwd, sourceRef);
    const ensured = ensureFindingConversionWorkItem(
      cwd,
      finding.id,
      {
        schemaVersion: 1,
        kind,
        lane: null,
        title: clipTitle(finding.text),
        summary: finding.text,
        sourceRefs,
      },
      finding.createdAt,
    );
    dependencies.afterFindingConversionWorkItemPersisted?.();
    const converted = convertGovernanceFinding(
      runtimeRoot,
      finding.id,
      ensured.item.id,
      dependencies.now,
    );
    const result = {
      originalText: converted.finding.text,
      title: ensured.item.title,
      kind,
      sourceId: null,
      workItemId: ensured.item.id,
      workItemCreated: ensured.created,
      finding: converted.finding,
      created: converted.created,
    };
    if (!now) return { ...result, outcome: 'converted' as const };
    if (dependencies.startImmediateChange === undefined) {
      throw intakeUsage('Immediate change start dependency is unavailable.');
    }
    const changeId = `source-${crypto.createHash('sha256').update(finding.text).digest('hex')}`;
    const propose = dependencies.startImmediateChange(
      cwd,
      changeId,
      {
        schemaVersion: 1,
        summary: finding.text,
        sourceRefs,
        explicitPaths: [],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      null,
    );
    return {
      outcome: 'started' as const,
      ...result,
      originalText: finding.text,
      immediateChange: { sourceId: null, changeId, propose },
    };
  }
  function linkFinding(
    cwd: string,
    findingId: string,
    target: Readonly<{ kind: 'change' | 'work-item'; id: string }>,
  ) {
    const item =
      target.kind === 'work-item' ? showWorkItem(cwd, target.id) : null;
    const resolvedTarget =
      item === null
        ? operations.context.existingChange(cwd, target.id)
        : { kind: 'work-item' as const, id: item.id };
    const runtimeRoot = operations.context.runtimeRoot(cwd);
    const linked = linkGovernanceFinding(
      runtimeRoot,
      findingId,
      resolvedTarget,
      dependencies.now,
    );
    return {
      originalText: linked.finding.text,
      ...(item === null ? {} : { title: item.title }),
      finding: linked.finding,
      created: linked.created,
    };
  }
  function preparePromotion(
    cwd: string,
    id: string,
    changeId: string,
    declaration: WorkItemPromotionSurveyDeclarationV1,
  ) {
    const prepared = prepareWorkItemPromotionSurvey(
      cwd,
      id,
      changeId,
      declaration,
    );
    return {
      workItemId: id,
      title: showWorkItem(cwd, id).title,
      changeId: changeId,
      path: prepared.relativePath,
      surveyedCommit: prepared.survey.surveyedCommit,
    };
  }
  function promote(
    cwd: string,
    id: string,
    changeId: string,
    expectedDigest: string,
    grantGuidance: string,
  ) {
    assertOrdinaryWorkRegistryTransition(cwd, 'promote', grantGuidance, {
      schemaVersion: 1,
      kind: 'work-registry-grant-required.v1',
      operation: 'promote',
      transition: 'promote',
      workItemId: id,
      changeId: changeId,
      expectedDigest: expectedDigest,
    });
    ensureWorkItemPromotionSurveyBinding(cwd, id, changeId);
    const promoted = promoteWorkItem(
      cwd,
      id,
      changeId,
      dependencies.now,
      expectedDigest,
    );
    return {
      workItemId: promoted.item.id,
      title: promoted.item.title,
      changeId: changeId,
    };
  }
  function reviewWorkItem(
    cwd: string,
    id: string,
    review: WorkItemReviewV1,
    grantGuidance: string,
  ) {
    assertOrdinaryWorkRegistryTransition(
      cwd,
      review.action === 'prioritize' ? 'prioritize' : 'intake',
      grantGuidance,
      {
        schemaVersion: 1,
        kind: 'work-registry-grant-required.v1',
        operation: 'review',
        transition: review.action === 'prioritize' ? 'prioritize' : 'intake',
        workItemId: id,
        review,
      },
    );
    const item = applyWorkItemReview(cwd, id, review, dependencies.now);
    return item;
  }
  return {
    startWorkItem,
    startText,
    deferText,
    attachSource,
    correctSource,
    convertFinding,
    linkFinding,
    preparePromotion,
    promote,
    reviewWorkItem,
  };
}
export function createGovernanceIntakeCountInspector(operations: {
  queries: Pick<
    ReturnType<typeof createWorkRegistryQueries>,
    'inspectWorkRegistry'
  >;
  findings: Pick<
    ReturnType<typeof createGovernanceFindingServices>,
    'listGovernanceFindings'
  >;
}) {
  return function inspectGovernanceIntakeCounts(
    repositoryRoot: string,
    runtimeRoot: string,
  ) {
    const inventory = operations.queries.inspectWorkRegistry(repositoryRoot);
    return projectGovernanceIntakeCounts(
      inventory,
      operations.findings.listGovernanceFindings(runtimeRoot),
    );
  };
}
