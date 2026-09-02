import fs from 'node:fs';
import path from 'node:path';

import {
  createGovernanceSourceV1,
  GovernanceSourceError,
  type GovernanceSourceAuthoringV1,
} from '@jigwright/core/governance-source';

import { renderGovernanceIntakeHandoff } from '../../composition-root/governance-intake-production.ts';
import { loadActiveSessionContext } from '../../composition-root/lifecycle-context.ts';
import { loadWorkflowConfig } from '../../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  captureGovernanceSource,
  convertGovernanceFinding,
  dismissGovernanceFinding,
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
  ensureFindingConversionWorkItem,
  findWorkItemsByExactSourceText,
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
} from '../../modules/governance-intake/work-registry.ts';
import { discoverRepository } from '../../runtime/repository-transaction/git.ts';
import { runtimePaths } from '../../runtime/session-workspace/session-store.ts';

export type GovernanceIntakeCliDependencies = Readonly<{
  now?: () => string;
  afterFindingConversionWorkItemPersisted?: () => void;
  resolveSession?: (
    cwd: string,
    sessionId: string,
  ) => GovernanceFindingContextV1;
  resolveRuntimeRoot?: (cwd: string) => string;
}>;

export function dispatchGovernanceIntakeCommand(
  command: 'source' | 'finding' | 'work-item' | 'later' | 'attach',
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies = {},
): Record<string, unknown> {
  try {
    if (command === 'later' && args.length === 1) {
      const originalText = args[0]!;
      const matches = findWorkItemsByExactSourceText(cwd, originalText).filter(
        ({ closure, stage }) => closure === null && stage !== 'closed',
      );
      if (matches.length > 0) {
        return {
          action: 'later',
          originalText,
          deduplicated: true,
          matches: matches.map(({ id }) => id),
          nextSteps: matches
            .slice(0, 3)
            .map(
              ({ id }) => `pnpm workflow attach ${id} <original-text> --json`,
            ),
        };
      }
      const capturedAt = (
        dependencies.now ?? (() => new Date().toISOString())
      )();
      const source = captureGovernanceSource(cwd, {
        semanticAuthor: 'maintainer',
        capturedBy: 'jigwright-intake',
        capturedAt,
        contextRef: 'direct-human:workflow-cli',
        text: originalText,
        supersedes: null,
      });
      const workItem = createWorkItem(
        cwd,
        {
          schemaVersion: 1,
          kind: 'improvement',
          lane: null,
          title: `Review captured Source ${source.source.id}`,
          summary: 'Interpret and disposition the linked Source.',
          sourceRefs: [source.source.id],
        },
        { now: () => capturedAt },
      );
      return {
        action: 'later',
        originalText,
        sourceId: source.source.id,
        workItemId: workItem.item.id,
        deduplicated: false,
        nextSteps: [`pnpm workflow work-item show ${workItem.item.id} --json`],
      };
    }
    if (command === 'attach' && args.length === 2) {
      const requestedWorkItemId = args[0]!;
      const originalText = args[1]!;
      const current = showWorkItem(cwd, requestedWorkItemId);
      if (current.closure !== null || current.stage === 'closed') {
        throw intakeUsage('A closed Work Item cannot receive a Source.');
      }
      const exactMatch = findWorkItemsByExactSourceText(cwd, originalText).find(
        ({ id }) => id === current.id,
      );
      const existingSourceRef = exactMatch?.sourceRefs.find(
        (sourceRef) =>
          readGovernanceSource(cwd, sourceRef).text === originalText,
      );
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
              supersedes: null,
            }).source
          : readGovernanceSource(cwd, existingSourceRef);
      const attached = attachSourceToWorkItem(cwd, current.id, source.id);
      return {
        action: 'attach',
        originalText,
        sourceId: source.id,
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
      const promoted = promoteWorkItem(
        cwd,
        args[1]!,
        args[3]!,
        dependencies.now,
        args[5]!,
        true,
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
    if (command === 'finding' && args.length === 2 && args[0] === 'convert') {
      const runtimeRoot = (
        dependencies.resolveRuntimeRoot ?? resolveFindingRuntimeRoot
      )(cwd);
      const finding = listGovernanceFindings(runtimeRoot).find(
        ({ id }) => id === args[1],
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
      const conversionSourceInput = {
        semanticAuthor: 'agent',
        capturedBy: 'jigwright-finding-convert',
        capturedAt: finding.createdAt,
        contextRef: `finding:${finding.id}`,
        text: finding.text,
        supersedes: null,
      } as const;
      const projectedSource = createGovernanceSourceV1(conversionSourceInput);
      if (finding.disposition === 'converted') {
        const currentItem = showWorkItem(cwd, workItemId);
        for (const sourceRef of currentItem.sourceRefs) {
          readGovernanceSource(cwd, sourceRef);
        }
        if (!currentItem.sourceRefs.includes(projectedSource.id)) {
          throw workflowError(
            'GOVERNANCE_FINDING_DISPOSITION_COLLISION',
            'Converted Finding target does not cite its deterministic Source.',
            ExitCode.conflict,
          );
        }
      }
      const source = captureGovernanceSource(cwd, conversionSourceInput);
      const sourceRefs = [
        ...new Set([...finding.sourceRefs, source.source.id]),
      ].sort();
      const ensured = ensureFindingConversionWorkItem(
        cwd,
        finding.id,
        {
          schemaVersion: 1,
          kind: 'improvement',
          lane: null,
          title: `Review captured Source ${source.source.id}`,
          summary: 'Interpret and disposition the linked Source.',
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
      return {
        action: 'convert',
        sourceId: source.source.id,
        workItemId: ensured.item.id,
        workItemCreated: ensured.created,
        finding: converted.finding,
        created: converted.created,
        nextSteps: [`pnpm workflow work-item show ${ensured.item.id} --json`],
      };
    }
    if (
      command === 'finding' &&
      ((args.length === 1 && args[0] === 'list') ||
        (args.length === 2 && args[0] === 'list' && args[1] === '--all'))
    ) {
      const runtimeRoot = (
        dependencies.resolveRuntimeRoot ?? resolveFindingRuntimeRoot
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
        dependencies.resolveRuntimeRoot ?? resolveFindingRuntimeRoot
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
  throw intakeUsage(
    'Usage: jigwright later <original-text> | jigwright attach <work-item-id> <original-text> | jigwright source <capture --input <source-envelope.json> | list | show <source-id> | trace <source-id> | link-change <source-id> --change <change-id>> | jigwright finding <add --session <session-id> --input <finding-envelope.json> | list [--all] | convert <finding-id> | dismiss <finding-id> --reason <reason>> | jigwright work-item <create|review|promote-prepare|promote|list|show|search|trace|recommend|inventory|render|validate> ...',
  );
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

function resolveFindingRuntimeRoot(cwd: string): string {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  return runtimePaths(git.gitCommonDirectory, config.runtimeDirectory).root;
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

function intakeUsage(message: string) {
  return workflowError('GOVERNANCE_INTAKE_INVALID', message, ExitCode.usage);
}
