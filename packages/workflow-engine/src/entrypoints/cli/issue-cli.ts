import fs from 'node:fs';
import path from 'node:path';

import {
  AtomicTextSafetyError,
  replaceTextAtomic,
} from '../../runtime/repository-transaction/atomic-text.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { renderHandoff } from '../../adapters/consumer/repository/handoff/handoff.ts';
import {
  addIssue,
  closeIssue,
  issueLogRelativePath,
  managedIssueDocumentPaths,
  renderIssues,
  updateIssue,
  validateIssueLog,
  type Issue,
  type IssueUpdateField,
} from '../../adapters/consumer/repository/documents/issues.ts';
import {
  assertOrdinaryLegacyIssueCompatibilityTransition,
  closeLegacyIssueCompatibilityWorkItem,
  createLegacyIssueCompatibilityWorkItem,
  legacyIssueBacklogRelativePath,
  renderLegacyIssueCompatibilityProjections,
  updateLegacyIssueCompatibilityWorkItem,
  validateLegacyIssueCompatibilityRegistry,
  workRegistryIsActivated,
} from '../../composition-root/governance-intake-production.ts';

export type IssueCommandTestHooks = {
  afterSourceWrite?: () => void;
  afterIssueLogWrite?: () => void;
};

export function dispatchIssueCommand(
  args: string[],
  repositoryRoot: string,
  testHooks: IssueCommandTestHooks = {},
): Record<string, unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case 'add': {
      const options = parseOptions(rest);
      const requirementLabel = single(options, 'requirement-label', false);
      const requirementHref = single(options, 'requirement-href', false);
      if (
        (requirementLabel === undefined) !==
        (requirementHref === undefined)
      ) {
        throw usage('Requirement label and href must be provided together.');
      }
      const issue: Issue = {
        id: single(options, 'id'),
        category: single(options, 'category') as Issue['category'],
        title: single(options, 'title'),
        status: single(options, 'status') as Issue['status'],
        priority: single(options, 'priority') as Issue['priority'],
        requirement:
          requirementLabel && requirementHref
            ? { label: requirementLabel, href: requirementHref }
            : null,
        references: options.get('reference') ?? [],
        notes: single(options, 'notes'),
      };
      if (workRegistryIsActivated(repositoryRoot)) {
        if (issue.status !== 'proposed' && issue.status !== 'icebox') {
          throw compatibilityTransitionRequired(
            'New compatibility issues enter the Work Registry inbox; active, blocked, or closed state requires a canonical reviewed transition.',
          );
        }
        const created = createLegacyIssueCompatibilityWorkItem(
          repositoryRoot,
          {
            schemaVersion: 1,
            kind: legacyIssueKind(issue.category),
            lane:
              issue.status === 'icebox'
                ? 'icebox'
                : legacyIssuePriority(issue.priority),
            title: issue.title,
            summary: legacyIssueSummary(issue),
            sourceRefs: [],
          },
          issue.id,
        );
        refreshCompatibilityProjections(repositoryRoot);
        return {
          action,
          issueId: issue.id,
          canonical: 'work-registry',
          workItemId: created.item.id,
          stage: created.item.stage,
        };
      }
      const data = applyManagedIssueMutation(
        repositoryRoot,
        () => addIssue(repositoryRoot, issue),
        testHooks,
      );
      return { action, issueId: issue.id, issueCount: data.issues.length };
    }
    case 'update': {
      const issueId = rest[0];
      if (!issueId) {
        throw usage('Issue update requires an issue ID.');
      }
      const options = parseOptions(rest.slice(1));
      const field = single(options, 'field') as IssueUpdateField;
      if (!['title', 'status', 'priority', 'notes'].includes(field)) {
        throw usage('Issue update field is not supported.');
      }
      if (workRegistryIsActivated(repositoryRoot)) {
        assertOrdinaryLegacyIssueCompatibilityTransition(
          repositoryRoot,
          field === 'priority' ||
            (field === 'status' && single(options, 'value') === 'icebox')
            ? 'prioritize'
            : 'intake',
          `pnpm workflow work-item show ${issueId} --json`,
        );
        const item = updateLegacyIssueCompatibilityWorkItem(
          repositoryRoot,
          issueId,
          field,
          single(options, 'value'),
        );
        refreshCompatibilityProjections(repositoryRoot);
        return {
          action,
          issueId,
          field,
          canonical: 'work-registry',
          workItemId: item.id,
        };
      }
      applyManagedIssueMutation(
        repositoryRoot,
        () =>
          updateIssue(repositoryRoot, issueId, field, single(options, 'value')),
        testHooks,
      );
      return { action, issueId, field };
    }
    case 'close': {
      const issueId = rest[0];
      if (!issueId) {
        throw usage('Issue close requires an issue ID.');
      }
      const options = parseOptions(rest.slice(1));
      if (workRegistryIsActivated(repositoryRoot)) {
        assertOrdinaryLegacyIssueCompatibilityTransition(
          repositoryRoot,
          'intake',
          `pnpm workflow work-item show ${issueId} --json`,
        );
        const item = closeLegacyIssueCompatibilityWorkItem(
          repositoryRoot,
          issueId,
          single(options, 'date'),
          single(options, 'notes'),
        );
        refreshCompatibilityProjections(repositoryRoot);
        return {
          action,
          issueId,
          canonical: 'work-registry',
          workItemId: item.id,
        };
      }
      applyManagedIssueMutation(
        repositoryRoot,
        () =>
          closeIssue(
            repositoryRoot,
            issueId,
            single(options, 'date'),
            single(options, 'notes'),
          ),
        testHooks,
      );
      return { action, issueId };
    }
    case 'render':
      if (rest.length !== 0) {
        throw usage('Issue render takes no arguments.');
      }
      renderIssues(repositoryRoot);
      if (workRegistryIsActivated(repositoryRoot)) {
        const rendered =
          renderLegacyIssueCompatibilityProjections(repositoryRoot);
        return {
          action,
          canonical: 'work-registry',
          path: legacyIssueBacklogRelativePath(repositoryRoot),
          inventoryPath: path
            .relative(repositoryRoot, rendered.inventoryPath)
            .replaceAll(path.sep, '/'),
        };
      }
      return {
        action,
        path: issueLogRelativePath(repositoryRoot),
      };
    case 'validate':
      if (rest.length !== 0) {
        throw usage('Issue validate takes no arguments.');
      }
      validateIssueLog(repositoryRoot);
      if (workRegistryIsActivated(repositoryRoot)) {
        validateLegacyIssueCompatibilityRegistry(repositoryRoot);
        return { action, valid: true, canonical: 'work-registry' };
      }
      return { action, valid: true };
    default:
      throw usage(
        'Usage: pnpm workflow issue <add|update|close|render|validate> ...',
      );
  }
}

function refreshCompatibilityProjections(repositoryRoot: string): void {
  renderLegacyIssueCompatibilityProjections(repositoryRoot);
}

function legacyIssueKind(category: Issue['category']) {
  return category === 'enhancement' ? ('improvement' as const) : category;
}

function legacyIssuePriority(priority: Issue['priority']) {
  return priority.toLowerCase() as 'now' | 'next' | 'later';
}

function legacyIssueSummary(issue: Issue): string {
  return [
    issue.notes,
    ...(issue.requirement
      ? [
          `Legacy requirement: ${issue.requirement.label} (${issue.requirement.href})`,
        ]
      : []),
    ...(issue.references.length > 0
      ? [`Legacy references: ${issue.references.join(', ')}`]
      : []),
  ].join('\n\n');
}

function compatibilityTransitionRequired(message: string) {
  return workflowError(
    'WORK_REGISTRY_COMPATIBILITY_TRANSITION_REQUIRED',
    message,
    ExitCode.conflict,
    {
      recovery:
        'Create an inbox Work Item, then use exact-digest `workflow work-item review` transitions.',
    },
  );
}

type ManagedIssueFileState = {
  content: string;
  mode: number;
};

type ManagedIssueFileMutation = {
  filePath: string;
  before: ManagedIssueFileState | null;
  after?: ManagedIssueFileState;
};

function applyManagedIssueMutation<T>(
  repositoryRoot: string,
  mutateSource: () => T,
  testHooks: IssueCommandTestHooks,
): T {
  const mutations: ManagedIssueFileMutation[] = managedIssueDocumentPaths(
    repositoryRoot,
  ).map((filePath) => ({
    filePath,
    before: readManagedIssueFile(filePath),
  }));

  try {
    const result = mutateSource();
    mutations[0].after = requireManagedIssueFile(mutations[0].filePath);
    testHooks.afterSourceWrite?.();

    renderIssues(repositoryRoot);
    mutations[1].after = requireManagedIssueFile(mutations[1].filePath);
    testHooks.afterIssueLogWrite?.();

    renderHandoff(repositoryRoot);
    mutations[2].after = requireManagedIssueFile(mutations[2].filePath);
    return result;
  } catch (error) {
    try {
      rollbackManagedIssueMutation(mutations);
    } catch (rollbackError) {
      throw workflowError(
        'ISSUE_PROJECTION_ROLLBACK_REQUIRED',
        'A managed issue mutation failed and its exact prior projection could not be restored.',
        ExitCode.staleState,
        {
          details: {
            cause: error instanceof Error ? error.message : String(error),
            rollbackCause:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
          },
        },
      );
    }
    throw error;
  }
}

function rollbackManagedIssueMutation(
  mutations: ManagedIssueFileMutation[],
): void {
  let rollbackError: unknown;
  for (const mutation of [...mutations].reverse()) {
    if (mutation.after === undefined) continue;
    try {
      const current = readManagedIssueFile(mutation.filePath);
      if (managedIssueFileStatesEqual(current, mutation.before)) continue;
      if (!managedIssueFileStatesEqual(current, mutation.after)) {
        throw new AtomicTextSafetyError();
      }
      if (mutation.before === null) {
        fs.rmSync(mutation.filePath);
      } else {
        replaceTextAtomic(mutation.filePath, mutation.before.content);
      }
    } catch (error) {
      rollbackError ??= error;
    }
  }
  if (rollbackError !== undefined) throw rollbackError;
}

function readManagedIssueFile(filePath: string): ManagedIssueFileState | null {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw workflowError(
      'ISSUE_PROJECTION_PATH_UNSAFE',
      'A managed issue projection path is not a private plain file.',
      ExitCode.verification,
    );
  }
  return {
    content: fs.readFileSync(filePath, 'utf8'),
    mode: stats.mode & 0o777,
  };
}

function requireManagedIssueFile(filePath: string): ManagedIssueFileState {
  const state = readManagedIssueFile(filePath);
  if (state === null) {
    throw workflowError(
      'ISSUE_PROJECTION_PATH_UNSAFE',
      'A managed issue projection disappeared during mutation.',
      ExitCode.verification,
    );
  }
  return state;
}

function managedIssueFileStatesEqual(
  left: ManagedIssueFileState | null,
  right: ManagedIssueFileState | null,
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.content === right.content &&
      left.mode === right.mode)
  );
}

function parseOptions(args: string[]): Map<string, string[]> {
  if (args.length % 2 !== 0) {
    throw usage('Issue options must be --name value pairs.');
  }
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option.startsWith('--') || !value || value.startsWith('--')) {
      throw usage('Issue options must be --name value pairs.');
    }
    const name = option.slice(2);
    options.set(name, [...(options.get(name) ?? []), value]);
  }
  return options;
}

function single(options: Map<string, string[]>, name: string): string;
function single(
  options: Map<string, string[]>,
  name: string,
  required: false,
): string | undefined;
function single(
  options: Map<string, string[]>,
  name: string,
  required = true,
): string | undefined {
  const values = options.get(name);
  if (!values && !required) {
    return undefined;
  }
  if (values?.length !== 1) {
    throw usage(`Issue option --${name} must appear exactly once.`);
  }
  return values[0];
}

function usage(message: string) {
  return workflowError('INVALID_ISSUE_USAGE', message, ExitCode.usage);
}
