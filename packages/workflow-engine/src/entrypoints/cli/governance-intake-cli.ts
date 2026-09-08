import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createGovernanceSourceV1,
  GovernanceSourceError,
  type GovernanceSourceAuthoringV1,
} from '@jigwright/core/governance-source';

import {
  assertExistingGovernanceIntakeChange,
  findActiveTaskSessionId,
  renderGovernanceIntakeHandoff,
  resolveGovernanceIntakeRuntimeRoot,
  resolveRepositoryFindingScope,
} from '../../composition-root/governance-intake-production.ts';
import { loadActiveSessionContext } from '../../composition-root/lifecycle-context.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  deferredIntakeDestination,
  INTAKE_KINDS,
  isRequirementKind,
} from '../../composition-root/governance-intake-production.ts';
import {
  captureGovernanceSource,
  convertGovernanceFinding,
  dismissGovernanceFinding,
  linkGovernanceFinding,
  listGovernanceFindings,
  listGovernanceSources,
  readGovernanceSource,
  recordGovernanceFinding,
  type GovernanceFindingAuthoringV1,
  type GovernanceFindingContextV1,
} from '../../modules/governance-intake/governance-intake.ts';
import {
  applyWorkItemReview,
  attachSourceToWorkItem,
  assertOrdinaryWorkRegistryTransition,
  createWorkItem,
  createWorkItemAfterExactSourceTextRecheck,
  ensureWorkItemPromotionChangeDirectory,
  ensureWorkItemPromotionSurveyBinding,
  ensureFindingConversionWorkItem,
  findWorkItemsByExactSourceText,
  hasExactCurrentWorkItemPromotion,
  inspectWorkRegistry,
  linkSourceToChange,
  listWorkItems,
  prepareWorkItemPromotionSurvey,
  promoteWorkItem,
  recommendWorkItemPriorities,
  renderWorkRegistry,
  searchWorkItems,
  showWorkItem,
  traceGovernanceSource,
  traceWorkItem,
  validateWorkRegistry,
  validateWorkRegistryProjections,
  type WorkItemAuthoringV1,
  type WorkItemPromotionSurveyDeclarationV1,
  type WorkItemReviewV1,
  workItemDigest,
} from '../../modules/governance-intake/work-registry.ts';

export type GovernanceIntakeCliDependencies = Readonly<{
  now?: () => string;
  afterNowSourceCaptured?: () => void;
  afterFindingConversionWorkItemPersisted?: () => void;
  afterLaterSourceCaptured?: () => void;
  resolveSession?: (
    cwd: string,
    sessionId: string,
  ) => GovernanceFindingContextV1;
  resolveRuntimeRoot?: (cwd: string) => string;
  resolveRepositoryScope?: (cwd: string) => GovernanceFindingContextV1;
  /** The task session covering `cwd`, or null when no task is running there. */
  resolveTaskScope?: (cwd: string) => GovernanceFindingContextV1 | null;
  startImmediateChange?: (
    cwd: string,
    changeId: string,
    intent: Readonly<{
      schemaVersion: 1;
      summary: string;
      sourceRefs: readonly `SRC-${string}`[];
      explicitPaths: readonly string[];
      explicitSymbols: readonly string[];
      explicitConfigKeys: readonly string[];
      renamePairs: readonly Readonly<{ from: string; to: string }>[];
    }>,
    immediateSource: Readonly<{
      sourceId: `SRC-${string}`;
      exactText: string;
    }> | null,
  ) => unknown;
}>;

export function dispatchGovernanceIntakeCommand(
  command: 'source' | 'finding' | 'work-item' | 'now' | 'later' | 'attach',
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies = {},
): Record<string, unknown> {
  try {
    if (
      command === 'now' &&
      args.length === 1 &&
      /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/u.test(args[0]!)
    ) {
      const workItem = showWorkItem(cwd, args[0]!);
      const originalTexts = workItem.sourceRefs.map(
        (sourceRef) => readGovernanceSource(cwd, sourceRef).text,
      );
      const changeId = `work-${workItem.id
        .slice('WORK-'.length)
        .toLowerCase()}`;
      if (hasExactCurrentWorkItemPromotion(cwd, workItem.id, changeId)) {
        return {
          action: 'now',
          workItemId: workItem.id,
          sourceRefs: workItem.sourceRefs,
          originalTexts,
          promoted: true,
          changeId,
          nextSteps: immediateWorkItemNextSteps(
            workItem.id,
            workItem.sourceRefs,
          ),
        };
      }
      if (workItem.stage === 'inbox') {
        return {
          action: 'now',
          workItemId: workItem.id,
          sourceRefs: workItem.sourceRefs,
          originalTexts,
          promoted: false,
          changeId: null,
          nextSteps: [
            `pnpm workflow work-item review ${workItem.id} --input <accept-review.json> --json`,
            `pnpm workflow work-item review ${workItem.id} --input <prioritize-now-review.json> --json`,
          ],
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
          action: 'now',
          workItemId: workItem.id,
          sourceRefs: workItem.sourceRefs,
          originalTexts,
          promoted: false,
          changeId: null,
          nextSteps: [
            `pnpm workflow work-item review ${workItem.id} --input <prioritize-now-review.json> --json`,
          ],
        };
      }
      if (workItem.blockedBy.length > 0) {
        const openBlockers = workItem.blockedBy.filter(
          (blockerId) => showWorkItem(cwd, blockerId).stage !== 'closed',
        );
        if (openBlockers.length > 0) {
          return {
            action: 'now',
            workItemId: workItem.id,
            sourceRefs: workItem.sourceRefs,
            originalTexts,
            promoted: false,
            changeId: null,
            nextSteps:
              openBlockers.length <= 3
                ? openBlockers.map(
                    (blockerId) =>
                      `pnpm workflow work-item show ${blockerId} --json`,
                  )
                : [
                    ...openBlockers
                      .slice(0, 2)
                      .map(
                        (blockerId) =>
                          `pnpm workflow work-item show ${blockerId} --json`,
                      ),
                    'pnpm workflow guide --json',
                  ],
          };
        }
      }
      const expectedDigest = workItemDigest(workItem);
      assertOrdinaryWorkRegistryTransition(
        cwd,
        'promote',
        `pnpm workflow grant human request-work-item-promotion ${workItem.id} --change ${changeId} --expected ${expectedDigest} --reason <reason> --json`,
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
        action: 'now',
        workItemId: promoted.item.id,
        sourceRefs: promoted.item.sourceRefs,
        originalTexts,
        promoted: true,
        changeId,
        nextSteps: immediateWorkItemNextSteps(
          promoted.item.id,
          promoted.item.sourceRefs,
        ),
      };
    }
    if (command === 'now' && (args.length === 1 || args.length === 3)) {
      const { value: kindFlag, rest } = takeFlag(args, '--kind');
      if (rest.length !== 1) throw intakeUsage(INTAKE_USAGE);
      const exactText = rest[0]!;
      assertIntentText(exactText, 'pnpm workflow now "<original text>" --json');
      const kind = intakeKind(kindFlag);
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
          action: 'now',
          originalText: exactText,
          kind,
          sourceId: null,
          changeId,
          propose,
          nextSteps: immediateChangeNextSteps(changeId, propose),
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
              capturedAt: (
                dependencies.now ?? (() => new Date().toISOString())
              )(),
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
        action: 'now',
        originalText: exactText,
        kind,
        sourceId: source.id,
        changeId,
        propose,
        nextSteps: immediateChangeNextSteps(changeId, propose),
      };
    }
    if (command === 'later' && (args.length === 1 || args.length === 3)) {
      const { value: kindFlag, rest } = takeFlag(args, '--kind');
      if (rest.length !== 1) throw intakeUsage(INTAKE_USAGE);
      const originalText = rest[0]!;
      assertIntentText(
        originalText,
        'pnpm workflow later "<original text>" --json',
      );
      const kind = intakeKind(kindFlag);
      const capturedAt = (
        dependencies.now ?? (() => new Date().toISOString())
      )();
      // Inside a task the registry is off-limits and an observation must not
      // land in the task diff, so it is staged as a Finding and flushed to the
      // inbox at triage. Outside a task the inbox is the front door.
      const taskScope = (dependencies.resolveTaskScope ?? resolveTaskScope)(
        cwd,
      );
      if (taskScope !== null && deferredIntakeDestination(true) === 'finding') {
        const staged = recordGovernanceFinding(
          taskScope,
          { schemaVersion: 1, text: originalText, sourceRefs: [] },
          dependencies.now,
        );
        return {
          action: 'later',
          originalText,
          kind,
          staged: 'finding',
          findingId: staged.finding.id,
          sessionId: staged.finding.sessionId,
          changeId: staged.finding.changeId,
          created: staged.created,
          nextSteps: [
            `pnpm workflow finding convert ${staged.finding.id} --kind ${kind} --json`,
          ],
        };
      }
      if (!isRequirementKind(kind)) {
        // An observation goes to the inbox as it is: no Source, because it is
        // not wording the implementation must be read against.
        const matches = findOpenWorkItemsBySummary(cwd, originalText);
        if (matches.length > 0) {
          return {
            action: 'later',
            originalText,
            kind,
            sourceId: null,
            sourceLinked: false,
            deduplicated: true,
            matches: matches.map(({ id }) => id),
            nextSteps: matches
              .slice(0, 3)
              .map(({ id }) => `pnpm workflow work-item show ${id} --json`),
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
          action: 'later',
          originalText,
          kind,
          sourceId: null,
          sourceLinked: false,
          workItemId: created.item.id,
          deduplicated: false,
          nextSteps: [`pnpm workflow work-item show ${created.item.id} --json`],
        };
      }
      const matches = findWorkItemsByExactSourceText(cwd, originalText).filter(
        ({ closure, stage }) => closure === null && stage !== 'closed',
      );
      if (matches.length > 0) {
        return {
          action: 'later',
          originalText,
          kind,
          sourceId: null,
          sourceLinked: false,
          deduplicated: true,
          matches: matches.map(({ id }) => id),
          nextSteps: matches
            .slice(0, 3)
            .map(
              ({ id }) => `pnpm workflow attach ${id} <original-text> --json`,
            ),
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
          action: 'later',
          originalText,
          kind,
          sourceId: source.source.id,
          sourceLinked: false,
          deduplicated: true,
          matches: workItem.matches.map(({ id }) => id),
          nextSteps: workItem.matches
            .slice(0, 3)
            .map(
              ({ id }) => `pnpm workflow attach ${id} <original-text> --json`,
            ),
        };
      }
      return {
        action: 'later',
        originalText,
        kind,
        sourceId: source.source.id,
        sourceLinked: true,
        workItemId: workItem.item.id,
        deduplicated: false,
        nextSteps: [`pnpm workflow work-item show ${workItem.item.id} --json`],
      };
    }
    if (command === 'attach' && (args.length === 2 || args.length === 4)) {
      const { value: supersedes, rest } = takeFlag(args, '--supersedes');
      if (rest.length !== 2) throw intakeUsage(INTAKE_USAGE);
      const requestedWorkItemId = rest[0]!;
      const wordingOrSource = rest[1]!;
      const current = showWorkItem(cwd, requestedWorkItemId);
      if (current.closure !== null || current.stage === 'closed') {
        throw intakeUsage('A closed Work Item cannot receive a Source.');
      }
      if (SOURCE_ID.test(wordingOrSource)) {
        // An existing Source is linked as it is: the wording already lives in
        // the ledger and is never minted twice.
        if (supersedes !== null) {
          throw intakeUsage(
            'Linking an existing Source cannot also supersede one; capture new wording instead.',
          );
        }
        const source = readGovernanceSource(cwd, wordingOrSource);
        const attached = attachSourceToWorkItem(cwd, current.id, source.id);
        return {
          action: 'attach',
          originalText: source.text,
          sourceId: source.id,
          supersedes: null,
          workItemId: attached.item.id,
          updated: attached.updated,
          nextSteps: [
            `pnpm workflow work-item show ${attached.item.id} --json`,
          ],
        };
      }
      const originalText = wordingOrSource;
      assertIntentText(
        originalText,
        'pnpm workflow attach <work-item-id> "<original text>" --json',
      );
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
              capturedAt: (
                dependencies.now ?? (() => new Date().toISOString())
              )(),
              contextRef: 'direct-human:workflow-cli',
              text: originalText,
              supersedes: supersedesRef,
            }).source
          : readGovernanceSource(cwd, existingSourceRef);
      const attached = attachSourceToWorkItem(cwd, current.id, source.id);
      return {
        action: 'attach',
        originalText,
        sourceId: source.id,
        supersedes,
        workItemId: attached.item.id,
        updated: attached.updated,
        nextSteps: [`pnpm workflow work-item show ${attached.item.id} --json`],
      };
    }
    if (
      command === 'source' &&
      args.length === 3 &&
      args[0] === 'capture' &&
      args[1] === '--input'
    ) {
      const input = parseSourceInput(readInput(cwd, args[2]!));
      const result = captureGovernanceSource(cwd, input);
      return {
        action: 'capture',
        sourceId: result.source.id,
        sourceDigest: result.source.textDigest,
        path: result.relativePath,
        created: result.created,
      };
    }
    if (command === 'source' && args.length === 2 && args[0] === 'show') {
      return {
        action: 'show',
        source: readGovernanceSource(cwd, args[1]!),
      };
    }
    if (command === 'source' && args.length === 1 && args[0] === 'list') {
      return {
        action: 'list',
        sources: listGovernanceSources(cwd),
      };
    }
    if (command === 'source' && args.length === 2 && args[0] === 'trace') {
      return {
        action: 'trace',
        ...traceGovernanceSource(cwd, args[1]!),
      };
    }
    if (
      command === 'source' &&
      args.length === 4 &&
      args[0] === 'link-change' &&
      args[2] === '--change'
    ) {
      const linked = linkSourceToChange(cwd, args[1]!, args[3]!);
      return {
        action: 'link-change',
        sourceId: args[1],
        changeId: args[3],
        path: path
          .relative(fs.realpathSync(cwd), linked.originPath)
          .replaceAll(path.sep, '/'),
        created: linked.created,
      };
    }
    if (
      command === 'work-item' &&
      args.length === 6 &&
      args[0] === 'promote-prepare' &&
      args[2] === '--change' &&
      args[4] === '--input'
    ) {
      const declaration = parsePromotionSurveyDeclaration(
        readInput(cwd, args[5]!),
      );
      const prepared = prepareWorkItemPromotionSurvey(
        cwd,
        args[1]!,
        args[3]!,
        declaration,
      );
      return {
        action: 'promote-prepare',
        workItemId: args[1],
        changeId: args[3],
        path: prepared.relativePath,
        surveyedCommit: prepared.survey.surveyedCommit,
      };
    }
    if (
      command === 'work-item' &&
      args.length === 3 &&
      args[0] === 'create' &&
      args[1] === '--input'
    ) {
      const input = parseWorkItemInput(readInput(cwd, args[2]!));
      const created = createWorkItem(cwd, input, { now: dependencies.now });
      return {
        action: 'create',
        workItemId: created.item.id,
        path: created.relativePath,
      };
    }
    if (
      command === 'work-item' &&
      args.length === 6 &&
      args[0] === 'promote' &&
      args[2] === '--change' &&
      args[4] === '--expected'
    ) {
      assertOrdinaryWorkRegistryTransition(
        cwd,
        'promote',
        `pnpm workflow grant human request-work-item-promotion ${args[1]} --change ${args[3]} --expected ${args[5]} --reason <reason> --json`,
        {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'promote',
          transition: 'promote',
          workItemId: args[1]!,
          changeId: args[3]!,
          expectedDigest: args[5]!,
        },
      );
      ensureWorkItemPromotionSurveyBinding(cwd, args[1]!, args[3]!);
      const promoted = promoteWorkItem(
        cwd,
        args[1]!,
        args[3]!,
        dependencies.now,
        args[5]!,
      );
      return {
        action: 'promote',
        workItemId: promoted.item.id,
        changeId: args[3],
      };
    }
    if (
      command === 'work-item' &&
      args.length === 4 &&
      args[0] === 'review' &&
      args[2] === '--input'
    ) {
      const review = parseWorkItemReview(readInput(cwd, args[3]!));
      assertOrdinaryWorkRegistryTransition(
        cwd,
        review.action === 'prioritize' ? 'prioritize' : 'intake',
        `pnpm workflow grant human request-work-item-review ${args[1]} --input <review.json> --reason <reason> --json`,
        {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'review',
          transition: review.action === 'prioritize' ? 'prioritize' : 'intake',
          workItemId: args[1]!,
          review,
        },
      );
      const item = applyWorkItemReview(cwd, args[1]!, review, dependencies.now);
      return { action: 'review', item };
    }
    if (command === 'work-item' && args.length === 1 && args[0] === 'list') {
      return { action: 'list', items: listWorkItems(cwd) };
    }
    if (command === 'work-item' && args.length === 2 && args[0] === 'show') {
      return { action: 'show', item: showWorkItem(cwd, args[1]!) };
    }
    if (command === 'work-item' && args.length === 2 && args[0] === 'search') {
      return { action: 'search', items: searchWorkItems(cwd, args[1]!) };
    }
    if (command === 'work-item' && args.length === 2 && args[0] === 'trace') {
      return { action: 'trace', ...traceWorkItem(cwd, args[1]!) };
    }
    if (
      command === 'work-item' &&
      args.length === 1 &&
      args[0] === 'recommend'
    ) {
      return {
        action: 'recommend',
        recommendations: recommendWorkItemPriorities(cwd),
      };
    }
    if (
      command === 'work-item' &&
      args.length === 1 &&
      args[0] === 'inventory'
    ) {
      return { action: 'inventory', inventory: inspectWorkRegistry(cwd) };
    }
    if (command === 'work-item' && args.length === 1 && args[0] === 'render') {
      const repositoryRoot = fs.realpathSync(cwd);
      const rendered = renderWorkRegistry(cwd);
      const handoffRendered = fs.existsSync(
        path.join(cwd, 'workflow', 'config.json'),
      );
      const handoffPath = handoffRendered
        ? renderGovernanceIntakeHandoff(cwd)
        : null;
      return {
        action: 'render',
        backlogPath: path
          .relative(repositoryRoot, rendered.backlogPath)
          .replaceAll(path.sep, '/'),
        inventoryPath: path
          .relative(repositoryRoot, rendered.inventoryPath)
          .replaceAll(path.sep, '/'),
        ...(handoffPath !== null
          ? {
              handoffPath,
            }
          : {}),
        historyPaths: rendered.historyPaths.map((historyPath) =>
          path.relative(repositoryRoot, historyPath).replaceAll(path.sep, '/'),
        ),
      };
    }
    if (
      command === 'work-item' &&
      args.length === 1 &&
      args[0] === 'validate'
    ) {
      const registry = validateWorkRegistry(cwd);
      validateWorkRegistryProjections(cwd);
      return { action: 'validate', ...registry };
    }
    if (command === 'finding' && args[0] === 'convert' && args.length >= 2) {
      const { value: kindFlag, rest } = takeFlag(args.slice(1), '--kind');
      const now = rest.includes('--now');
      const positional = rest.filter((entry) => entry !== '--now');
      if (positional.length !== 1 || rest.length - positional.length > 1) {
        throw intakeUsage(INTAKE_USAGE);
      }
      const kind = intakeKind(kindFlag ?? 'bug');
      const runtimeRoot = (
        dependencies.resolveRuntimeRoot ?? resolveGovernanceIntakeRuntimeRoot
      )(cwd);
      const finding = listGovernanceFindings(runtimeRoot).find(
        ({ id }) => id === positional[0],
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
        action: 'convert',
        kind,
        sourceId: null,
        workItemId: ensured.item.id,
        workItemCreated: ensured.created,
        finding: converted.finding,
        created: converted.created,
        nextSteps: [`pnpm workflow work-item show ${ensured.item.id} --json`],
      };
      if (!now) return result;
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
        ...result,
        originalText: finding.text,
        immediateChange: { sourceId: null, changeId, propose },
        nextSteps: immediateChangeNextSteps(changeId, propose),
      };
    }
    if (
      command === 'finding' &&
      args.length === 4 &&
      args[0] === 'link' &&
      args[2] === '--change'
    ) {
      const changeId = assertExistingGovernanceIntakeChange(cwd, args[3]!);
      const runtimeRoot = (
        dependencies.resolveRuntimeRoot ?? resolveGovernanceIntakeRuntimeRoot
      )(cwd);
      const linked = linkGovernanceFinding(
        runtimeRoot,
        args[1]!,
        changeId,
        dependencies.now,
      );
      return {
        action: 'link',
        finding: linked.finding,
        created: linked.created,
      };
    }
    if (
      command === 'finding' &&
      ((args.length === 1 && args[0] === 'list') ||
        (args.length === 2 && args[0] === 'list' && args[1] === '--all'))
    ) {
      const runtimeRoot = (
        dependencies.resolveRuntimeRoot ?? resolveGovernanceIntakeRuntimeRoot
      )(cwd);
      const includeTerminal = args[1] === '--all';
      return {
        action: 'list',
        findings: listGovernanceFindings(runtimeRoot).filter(
          (finding) => includeTerminal || finding.disposition === 'pending',
        ),
      };
    }
    if (
      command === 'finding' &&
      args.length === 4 &&
      args[0] === 'dismiss' &&
      args[2] === '--reason'
    ) {
      const runtimeRoot = (
        dependencies.resolveRuntimeRoot ?? resolveGovernanceIntakeRuntimeRoot
      )(cwd);
      const result = dismissGovernanceFinding(
        runtimeRoot,
        args[1]!,
        args[3]!,
        dependencies.now,
      );
      return {
        action: 'dismiss',
        finding: result.finding,
        created: result.created,
      };
    }
    // Staging a note is about where the writer may write, not about whether a
    // task happens to be open. Without a session the note is repository-scoped
    // and still reaches `finding list` and `finding convert`; requiring a
    // session meant an observation made between tasks had nowhere to go.
    if (
      command === 'finding' &&
      args.length === 3 &&
      args[0] === 'add' &&
      args[1] === '--input'
    ) {
      const input = parseFindingInput(readInput(cwd, args[2]!));
      const context = (
        dependencies.resolveRepositoryScope ?? resolveRepositoryFindingScope
      )(cwd);
      const result = recordGovernanceFinding(context, input, dependencies.now);
      return {
        action: 'add',
        findingId: result.finding.id,
        sessionId: result.finding.sessionId,
        path: result.path,
        created: result.created,
      };
    }
    if (
      command === 'finding' &&
      args.length === 5 &&
      args[0] === 'add' &&
      args[1] === '--session' &&
      args[3] === '--input'
    ) {
      const sessionId = args[2]!;
      const input = parseFindingInput(readInput(cwd, args[4]!));
      const context = (dependencies.resolveSession ?? resolveActiveSession)(
        cwd,
        sessionId,
      );
      if (context.sessionId !== sessionId) {
        throw intakeUsage(
          'Finding session context does not match the request.',
        );
      }
      const result = recordGovernanceFinding(context, input, dependencies.now);
      return {
        action: 'add',
        findingId: result.finding.id,
        sessionId: result.finding.sessionId,
        changeId: result.finding.changeId,
        created: result.created,
      };
    }
  } catch (error) {
    if (error instanceof GovernanceSourceError) {
      throw workflowError(error.code, error.message, ExitCode.usage);
    }
    throw error;
  }
  throw intakeUsage(INTAKE_USAGE);
}

const SOURCE_ID = /^SRC-[0-9a-f]{64}$/u;
type IntakeKind = (typeof INTAKE_KINDS)[number];
const INTAKE_USAGE =
  'Usage: jigwright now "<original text>" [--kind <kind>] | jigwright later "<original text>" [--kind <kind>] | jigwright attach <work-item-id> "<original text>"|<SRC-id> [--supersedes <SRC-id>] | jigwright finding convert <finding-id> [--kind <kind>] [--now]; kind = feature|bug|improvement|chore|research (default improvement; convert defaults to bug)';
function takeFlag(
  args: readonly string[],
  flag: string,
): { value: string | null; rest: string[] } {
  const index = args.indexOf(flag);
  if (index === -1) return { value: null, rest: [...args] };
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw intakeUsage(`${flag} needs a value. ${INTAKE_USAGE}`);
  }
  return {
    value,
    rest: [...args.slice(0, index), ...args.slice(index + 2)],
  };
}
function intakeKind(value: string | null): IntakeKind {
  if (value === null) return 'improvement';
  if (!(INTAKE_KINDS as readonly string[]).includes(value)) {
    throw intakeUsage(`Unknown kind "${value}". ${INTAKE_USAGE}`);
  }
  return value as IntakeKind;
}
function clipTitle(text: string): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim();
  return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 159)}…`;
}
function findOpenWorkItemsBySummary(cwd: string, text: string) {
  return listWorkItems(cwd).filter(
    (item) =>
      item.closure === null &&
      item.stage !== 'closed' &&
      item.interpretation.summary === text,
  );
}
function resolveTaskScope(cwd: string): GovernanceFindingContextV1 | null {
  const sessionId = findActiveTaskSessionId(cwd);
  return sessionId === null ? null : resolveActiveSession(cwd, sessionId);
}
function immediateChangeNextSteps(
  _changeId: string,
  propose: unknown,
): string[] {
  if (
    isRecord(propose) &&
    isRecord(propose.investigation) &&
    typeof propose.investigation.investigationId === 'string'
  ) {
    return [
      `pnpm workflow status ${propose.investigation.investigationId} --json`,
    ];
  }
  return ['pnpm workflow now <original-text> --json'];
}
function immediateWorkItemNextSteps(
  workItemId: string,
  sourceRefs: readonly string[],
): string[] {
  const steps = [
    `pnpm workflow work-item show ${workItemId} --json`,
    ...sourceRefs
      .slice(0, 2)
      .map((sourceRef) => `pnpm workflow source trace ${sourceRef} --json`),
  ];
  if (sourceRefs.length > 2) {
    return [steps[0]!, steps[1]!, 'pnpm workflow guide --json'];
  }
  return steps;
}
function resolveActiveSession(
  cwd: string,
  sessionId: string,
): GovernanceFindingContextV1 {
  const context = loadActiveSessionContext(cwd, sessionId);
  return {
    repositoryRoot: context.git.repositoryRoot,
    runtimeRoot: context.runtime.root,
    sessionId: context.session.sessionId,
    changeId: context.session.changeId,
    branch: context.git.branch ?? context.session.branch,
    head: context.git.head,
    tree: context.git.tree,
  };
}

function readInput(cwd: string, inputPath: string): unknown {
  const resolved = path.resolve(cwd, inputPath);
  const stats = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > 65_536) {
    throw intakeUsage('Governance intake input must be a bounded plain file.');
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    throw intakeUsage('Governance intake input must be valid JSON.');
  }
}

function parseSourceInput(value: unknown): GovernanceSourceAuthoringV1 {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_INPUT_KEYS)) {
    throw intakeUsage('Source capture envelope is invalid.');
  }
  return value as GovernanceSourceAuthoringV1;
}

function parseFindingInput(value: unknown): GovernanceFindingAuthoringV1 {
  if (!isRecord(value) || !hasExactKeys(value, FINDING_INPUT_KEYS)) {
    throw intakeUsage('Finding envelope is invalid.');
  }
  return value as GovernanceFindingAuthoringV1;
}

function parseWorkItemInput(value: unknown): WorkItemAuthoringV1 {
  if (!isRecord(value) || !hasExactKeys(value, WORK_ITEM_INPUT_KEYS)) {
    throw intakeUsage('Work Item envelope is invalid.');
  }
  return value as WorkItemAuthoringV1;
}

function parseWorkItemReview(value: unknown): WorkItemReviewV1 {
  if (!isRecord(value) || typeof value.action !== 'string') {
    throw intakeUsage('Work Item review envelope is invalid.');
  }
  const keys =
    value.action === 'accept'
      ? ['action', 'expectedDigest', 'summary']
      : value.action === 'prioritize'
        ? ['action', 'blockedBy', 'expectedDigest', 'lane']
        : value.action === 'decline'
          ? ['action', 'expectedDigest', 'outcome']
          : [];
  if (keys.length === 0 || !hasExactKeys(value, keys)) {
    throw intakeUsage('Work Item review envelope is invalid.');
  }
  return value as WorkItemReviewV1;
}

function parsePromotionSurveyDeclaration(
  value: unknown,
): WorkItemPromotionSurveyDeclarationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['emptyReason', 'schemaVersion', 'symbols'])
  ) {
    throw intakeUsage('Promotion survey declaration is invalid.');
  }
  return value as WorkItemPromotionSurveyDeclarationV1;
}

const SOURCE_INPUT_KEYS = [
  'capturedAt',
  'capturedBy',
  'contextRef',
  'semanticAuthor',
  'supersedes',
  'text',
] as const;
const FINDING_INPUT_KEYS = ['schemaVersion', 'sourceRefs', 'text'] as const;
const WORK_ITEM_INPUT_KEYS = [
  'kind',
  'lane',
  'schemaVersion',
  'sourceRefs',
  'summary',
  'title',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function assertIntentText(text: string, usage: string): void {
  if (text.trim().length === 0 || text.startsWith('-')) {
    throw intakeUsage(
      `Original text must be plain wording, not a flag or empty. Usage: ${usage}`,
    );
  }
}
function intakeUsage(message: string) {
  return workflowError('GOVERNANCE_INTAKE_INVALID', message, ExitCode.usage);
}
