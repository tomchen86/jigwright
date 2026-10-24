import type { GovernanceFindingAuthoringV1 } from '../../modules/governance-intake/governance-intake.ts';
/**
 * Route exact wording, observations and Work Item decisions through intake APIs.
 *
 * Invariants:
 * - Original text is returned verbatim from canonical records, including whitespace.
 * - Corrections supersede Sources; they never overwrite captured wording.
 * - Existing Work Item and change links resolve before a Finding receipt is written.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  GovernanceSourceError,
  type GovernanceSourceAuthoringV1,
} from '@jigwright/core/governance-source';

import {
  renderGovernanceIntakeHandoff,
  resolveActiveSession,
  createGovernanceIntakeWorkflowForCommand,
  GovernanceIntakeTextError,
  type GovernanceIntakeWorkflowOptions,
  resolveGovernanceIntakeRuntimeRoot,
  resolveRepositoryFindingScope,
} from '../../composition-root/governance-intake-production.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { INTAKE_KINDS } from '../../composition-root/governance-intake-production.ts';
import {
  dismissGovernanceFinding,
  listGovernanceFindings,
  recordGovernanceFinding,
} from '../../composition-root/governance-findings-production.ts';
import {
  captureGovernanceSource,
  listGovernanceSources,
  readGovernanceSource,
} from '../../composition-root/governance-sources-production.ts';
import {
  createWorkItem,
  inspectWorkRegistry,
  linkSourceToChange,
  listWorkItems,
  recommendWorkItemPriorities,
  renderWorkRegistry,
  searchWorkItems,
  showWorkItem,
  traceGovernanceSource,
  traceWorkItem,
  validateWorkRegistry,
  validateWorkRegistryProjections,
} from '../../composition-root/work-registry-production.ts';
import type {
  WorkItemAuthoringV1,
  WorkItemPromotionSurveyDeclarationV1,
  WorkItemReviewV1,
} from '../../modules/governance-intake/work-registry-contracts.ts';

export type GovernanceIntakeCliDependencies = GovernanceIntakeWorkflowOptions;

export function dispatchGovernanceIntakeCommand(
  command:
    'source' | 'finding' | 'work-item' | 'now' | 'later' | 'attach' | 'correct',
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies = {},
): Record<string, unknown> {
  try {
    switch (command) {
      case 'now':
        return dispatchNowIntakeCommand(command, args, cwd, dependencies);
      case 'later':
        return dispatchLaterIntakeCommand(command, args, cwd, dependencies);
      case 'correct':
        return dispatchCorrectIntakeCommand(args, cwd, dependencies);
      case 'attach':
        return dispatchAttachIntakeCommand(command, args, cwd, dependencies);
      case 'source':
        return dispatchSourceIntakeCommand(command, args, cwd, dependencies);
      case 'work-item':
        return dispatchWorkItemIntakeCommand(command, args, cwd, dependencies);
      case 'finding':
        return dispatchFindingIntakeCommand(command, args, cwd, dependencies);
    }
  } catch (error) {
    if (error instanceof GovernanceIntakeTextError) {
      throw intakeUsage(
        'Original text must be plain wording, not a flag or empty. Usage: pnpm workflow attach <work-item-id> "<original text>" --json',
      );
    }
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
  'Usage: jigwright now "<original text>" [--kind <kind>] | jigwright later "<original text>" [--kind <kind>] | jigwright attach <work-item-id> "<original text>"|<SRC-id> [--supersedes <SRC-id>] | jigwright correct <work-item-id> <old-SRC-id> <original-text> | jigwright finding convert <finding-id> [--kind <kind>] [--now]; kind = feature|bug|improvement|chore|research (default improvement; convert defaults to bug)';
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

function dispatchNowIntakeCommand(
  command: 'now',
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies,
): Record<string, unknown> {
  if (
    command === 'now' &&
    args.length === 1 &&
    /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/u.test(args[0]!)
  ) {
    const result = createGovernanceIntakeWorkflowForCommand(
      dependencies,
    ).startWorkItem(
      cwd,
      args[0]!,
      (id, changeId, digest) =>
        `pnpm workflow grant human request-work-item-promotion ${id} --change ${changeId} --expected ${digest} --reason <reason> --json`,
    );
    if (result.outcome === 'blocked') {
      const { outcome, blockingWorkItemIds, ...visible } = result;
      return {
        action: 'now',
        ...visible,
        nextSteps:
          blockingWorkItemIds.length <= 3
            ? blockingWorkItemIds.map(
                (id) => `pnpm workflow work-item show ${id} --json`,
              )
            : [
                ...blockingWorkItemIds
                  .slice(0, 2)
                  .map((id) => `pnpm workflow work-item show ${id} --json`),
                'pnpm workflow guide --json',
              ],
      };
    }
    const { outcome, ...details } = result;
    return {
      action: 'now',
      ...details,
      nextSteps:
        outcome === 'needs-review'
          ? [
              `pnpm workflow work-item review ${result.workItemId} --input <accept-review.json> --json`,
              `pnpm workflow work-item review ${result.workItemId} --input <prioritize-now-review.json> --json`,
            ]
          : outcome === 'needs-priority'
            ? [
                `pnpm workflow work-item review ${result.workItemId} --input <prioritize-now-review.json> --json`,
              ]
            : immediateWorkItemNextSteps(result.workItemId, result.sourceRefs),
    };
  }
  if (command === 'now' && (args.length === 1 || args.length === 3)) {
    const { value: kindFlag, rest } = takeFlag(args, '--kind');
    if (rest.length !== 1) throw intakeUsage(INTAKE_USAGE);
    const exactText = rest[0]!;
    assertIntentText(exactText, 'pnpm workflow now "<original text>" --json');
    const kind = intakeKind(kindFlag);
    const result = createGovernanceIntakeWorkflowForCommand(
      dependencies,
    ).startText(cwd, exactText, kind);
    return {
      action: 'now',
      ...result,
      nextSteps: immediateChangeNextSteps(result.changeId, result.propose),
    };
  }
  throw intakeUsage(INTAKE_USAGE);
}

function dispatchLaterIntakeCommand(
  command: 'later',
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies,
): Record<string, unknown> {
  if (command === 'later' && (args.length === 1 || args.length === 3)) {
    const { value: kindFlag, rest } = takeFlag(args, '--kind');
    if (rest.length !== 1) throw intakeUsage(INTAKE_USAGE);
    const originalText = rest[0]!;
    assertIntentText(
      originalText,
      'pnpm workflow later "<original text>" --json',
    );
    const kind = intakeKind(kindFlag);
    const result = createGovernanceIntakeWorkflowForCommand(
      dependencies,
    ).deferText(cwd, originalText, kind);
    const { outcome, ...details } = result;
    let nextSteps: string[];
    switch (result.outcome) {
      case 'finding':
        nextSteps = [
          `pnpm workflow finding convert ${result.findingId} --kind ${kind} --json`,
        ];
        break;
      case 'observation-match':
        nextSteps = result.matches
          .slice(0, 3)
          .map((id) => `pnpm workflow work-item show ${id} --json`);
        break;
      case 'requirement-match':
        nextSteps = result.matches
          .slice(0, 3)
          .map((id) => `pnpm workflow attach ${id} <original-text> --json`);
        break;
      case 'created':
        nextSteps = [
          `pnpm workflow work-item show ${result.workItemId} --json`,
        ];
        break;
    }
    return { action: 'later', ...details, nextSteps };
  }
  throw intakeUsage(INTAKE_USAGE);
}

function dispatchAttachIntakeCommand(
  command: 'attach',
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies,
): Record<string, unknown> {
  if (command === 'attach' && (args.length === 2 || args.length === 4)) {
    const { value: supersedes, rest } = takeFlag(args, '--supersedes');
    if (rest.length !== 2) throw intakeUsage(INTAKE_USAGE);
    const requestedWorkItemId = rest[0]!;
    const wordingOrSource = rest[1]!;
    const result = createGovernanceIntakeWorkflowForCommand(
      dependencies,
    ).attachSource(
      cwd,
      requestedWorkItemId,
      {
        kind: SOURCE_ID.test(wordingOrSource) ? 'existing' : 'wording',
        value: wordingOrSource,
      },
      supersedes,
    );
    return {
      action: 'attach',
      ...result,
      nextSteps: [`pnpm workflow work-item show ${result.workItemId} --json`],
    };
  }
  throw intakeUsage(INTAKE_USAGE);
}

function dispatchCorrectIntakeCommand(
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies,
): Record<string, unknown> {
  if (args.length !== 3 || !SOURCE_ID.test(args[1]!))
    throw intakeUsage(INTAKE_USAGE);
  const [id, oldRef, originalText] = args as [string, `SRC-${string}`, string];
  assertIntentText(
    originalText,
    'pnpm workflow correct <work-item-id> <old-SRC-id> "<original text>" --json',
  );
  const result = createGovernanceIntakeWorkflowForCommand(
    dependencies,
  ).correctSource(cwd, id, oldRef, originalText);
  return {
    action: 'correct',
    ...result,
    nextSteps: [`pnpm workflow work-item show ${result.workItemId} --json`],
  };
}

function dispatchSourceIntakeCommand(
  command: 'source',
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies,
): Record<string, unknown> {
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
      originalText: result.source.text,
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
      originalText: readGovernanceSource(cwd, args[1]!).text,
      sourceId: args[1],
      changeId: args[3],
      path: path
        .relative(fs.realpathSync(cwd), linked.originPath)
        .replaceAll(path.sep, '/'),
      created: linked.created,
    };
  }
  throw intakeUsage(INTAKE_USAGE);
}

function dispatchWorkItemIntakeCommand(
  command: 'work-item',
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies,
): Record<string, unknown> {
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
    return {
      action: 'promote-prepare',
      ...createGovernanceIntakeWorkflowForCommand(
        dependencies,
      ).preparePromotion(cwd, args[1]!, args[3]!, declaration),
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
      title: created.item.title,
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
    return {
      action: 'promote',
      ...createGovernanceIntakeWorkflowForCommand(dependencies).promote(
        cwd,
        args[1]!,
        args[3]!,
        args[5]!,
        `pnpm workflow grant human request-work-item-promotion ${args[1]} --change ${args[3]} --expected ${args[5]} --reason <reason> --json`,
      ),
    };
  }
  if (
    command === 'work-item' &&
    args.length === 4 &&
    args[0] === 'review' &&
    args[2] === '--input'
  ) {
    const review = parseWorkItemReview(readInput(cwd, args[3]!));
    const item = createGovernanceIntakeWorkflowForCommand(
      dependencies,
    ).reviewWorkItem(
      cwd,
      args[1]!,
      review,
      `pnpm workflow grant human request-work-item-review ${args[1]} --input <review.json> --reason <reason> --json`,
    );
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
  if (command === 'work-item' && args.length === 1 && args[0] === 'recommend') {
    return {
      action: 'recommend',
      recommendations: recommendWorkItemPriorities(cwd),
    };
  }
  if (command === 'work-item' && args.length === 1 && args[0] === 'inventory') {
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
  if (command === 'work-item' && args.length === 1 && args[0] === 'validate') {
    const registry = validateWorkRegistry(cwd);
    validateWorkRegistryProjections(cwd);
    return { action: 'validate', ...registry };
  }
  throw intakeUsage(INTAKE_USAGE);
}

function dispatchFindingIntakeCommand(
  command: 'finding',
  args: string[],
  cwd: string,
  dependencies: GovernanceIntakeCliDependencies,
): Record<string, unknown> {
  if (command === 'finding' && args[0] === 'convert' && args.length >= 2) {
    const { value: kindFlag, rest } = takeFlag(args.slice(1), '--kind');
    const now = rest.includes('--now');
    const positional = rest.filter((entry) => entry !== '--now');
    if (positional.length !== 1 || rest.length - positional.length > 1) {
      throw intakeUsage(INTAKE_USAGE);
    }
    const kind = intakeKind(kindFlag ?? 'bug');
    const result = createGovernanceIntakeWorkflowForCommand(
      dependencies,
    ).convertFinding(cwd, positional[0]!, kind, now);
    const { outcome, ...details } = result;
    return {
      action: 'convert',
      ...details,
      nextSteps:
        result.outcome === 'started'
          ? immediateChangeNextSteps(
              result.immediateChange.changeId,
              result.immediateChange.propose,
            )
          : [`pnpm workflow work-item show ${result.workItemId} --json`],
    };
  }
  if (
    command === 'finding' &&
    args.length === 4 &&
    args[0] === 'link' &&
    (args[2] === '--change' || args[2] === '--work-item')
  ) {
    return {
      action: 'link',
      ...createGovernanceIntakeWorkflowForCommand(dependencies).linkFinding(
        cwd,
        args[1]!,
        {
          kind: args[2] === '--work-item' ? 'work-item' : 'change',
          id: args[3]!,
        },
      ),
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
      originalText: result.finding.text,
      finding: result.finding,
      created: result.created,
    };
  }
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
      originalText: result.finding.text,
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
      throw intakeUsage('Finding session context does not match the request.');
    }
    const result = recordGovernanceFinding(context, input, dependencies.now);
    return {
      action: 'add',
      originalText: result.finding.text,
      findingId: result.finding.id,
      sessionId: result.finding.sessionId,
      changeId: result.finding.changeId,
      created: result.created,
    };
  }
  throw intakeUsage(INTAKE_USAGE);
}
