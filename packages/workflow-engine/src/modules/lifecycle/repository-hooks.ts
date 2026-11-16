/** Repository hook admission rules over required current observations and checks. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { hasManagedTrailerLine } from '@jigwright/core/managed-transition-trailers';
import {
  assertChangeRoutingCommitAuthorized,
  changeLifecycleRelativePath,
} from './change-routing.ts';
import type { RepositoryValidation } from '../repository-consumer/repository-validation.ts';
import type { WorkflowSession } from './workflow-session-contract.ts';
import type { MaintainerSignerProvider } from '../authority/maintainer-signer-port.ts';

export type HookResult = {
  hook: string;
  changes: string[];
  documents: string[];
};

export type RepositoryHookDependencies = Readonly<{
  readCommitMessage(cwd: string, requestedPath: string): string;
  validateRepositoryState(cwd: string): RepositoryValidation;
  validateWorkflowIntegrationAssets(repositoryRoot: string): void;
  realRepositoryPath(repositoryRoot: string): string;
  listSessions(
    cwd: string,
  ): readonly Pick<WorkflowSession, 'state' | 'repositoryRoot'>[];
  findStagedLifecyclePaths(repositoryRoot: string): string[];
  readStagedLifecycleSource(repositoryRoot: string): string;
  assertActivePublishTransaction(
    cwd: string,
    hookArgs: string[],
    environment?: NodeJS.ProcessEnv,
    signer?: MaintainerSignerProvider,
  ): void;
}>;

export function createRepositoryHookRules({
  readCommitMessage,
  validateRepositoryState,
  validateWorkflowIntegrationAssets,
  realRepositoryPath,
  listSessions,
  findStagedLifecyclePaths,
  readStagedLifecycleSource,
  assertActivePublishTransaction,
}: RepositoryHookDependencies) {
  function runRepositoryHook(
    cwd: string,
    requestedHook: string,
    args: string[],
    options: {
      environment?: NodeJS.ProcessEnv;
      externalEffectSigner?: MaintainerSignerProvider;
    } = {},
  ): HookResult {
    assertHookArguments(requestedHook, args);
    if (requestedHook === 'commit-msg') {
      validateCommitMessageText(readCommitMessage(cwd, args[0]));
    }
    const validated = validateRepositoryState(cwd);
    validateWorkflowIntegrationAssets(validated.repositoryRoot);
    const repositoryRealPath = realRepositoryPath(validated.repositoryRoot);
    if (
      requestedHook === 'pre-commit' &&
      listSessions(cwd).some(
        (session) =>
          session.state === 'active' &&
          session.repositoryRoot === repositoryRealPath,
      )
    ) {
      throw workflowError(
        'ACTIVE_SESSION_REQUIRES_MANAGED_COMMIT',
        'An active workflow session must be committed by the workflow engine.',
        ExitCode.guard,
      );
    }
    if (requestedHook === 'pre-commit') {
      const stagedLifecyclePaths = findStagedLifecyclePaths(
        validated.repositoryRoot,
      );
      if (stagedLifecyclePaths.includes(changeLifecycleRelativePath)) {
        assertChangeRoutingCommitAuthorized(
          validated.repositoryRoot,
          readStagedLifecycleSource(validated.repositoryRoot),
        );
      }
      const unmanagedLifecyclePaths = stagedLifecyclePaths.filter(
        (filePath) => filePath !== changeLifecycleRelativePath,
      );
      if (unmanagedLifecyclePaths.length > 0) {
        throw workflowError(
          'MANAGED_DIFF_REQUIRES_WORKFLOW_COMMIT',
          'OpenSpec task, planning, archive, and authority diffs require a workflow commit-tree transition.',
          ExitCode.guard,
          { details: { stagedPaths: unmanagedLifecyclePaths } },
        );
      }
    }
    if (requestedHook === 'pre-push') {
      assertActivePublishTransaction(
        cwd,
        args,
        options.environment,
        options.externalEffectSigner,
      );
    }
    return {
      hook: requestedHook,
      changes: validated.changes,
      documents: validated.documents,
    };
  }
  return Object.freeze({ runRepositoryHook });
}

function assertHookArguments(hook: string, args: string[]): void {
  const valid =
    (hook === 'pre-commit' && args.length === 0) ||
    (hook === 'commit-msg' && args.length === 1) ||
    (hook === 'pre-push' && (args.length === 0 || args.length === 2)) ||
    (hook === 'post-merge' &&
      args.length === 1 &&
      ['0', '1'].includes(args[0]));
  if (!valid) {
    throw workflowError(
      'INVALID_HOOK_USAGE',
      'Usage: pnpm workflow hook <pre-commit|commit-msg|pre-push|post-merge> [hook arguments].',
      ExitCode.usage,
    );
  }
}

export function validateCommitMessageText(contents: string): void {
  const lines = contents
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter((line) => !line.startsWith('#'));
  if (hasManagedTrailerLine(lines.join('\n'))) {
    throw workflowError(
      'MANAGED_TRAILERS_REQUIRE_WORKFLOW_COMMIT',
      'Managed trailers may only be created by a workflow commit transition.',
      ExitCode.guard,
    );
  }
  const header = (lines[0] ?? '').trim();
  const body = lines.slice(1);
  const errors: string[] = [];
  if (!header) {
    errors.push('Commit message requires a summary.');
  }
  if (header.length > 72) {
    errors.push('Summary exceeds 72 characters.');
  }
  if (/\b(?:WIP|FIXUP|SQUASH)\b/i.test(header)) {
    errors.push('Summary contains a placeholder.');
  }
  if (header.endsWith('.')) {
    errors.push('Summary ends with a period.');
  }
  const headerAfterEmoji = header.replace(/^[^\p{L}\p{N}]+\s*/u, '');
  if (/^[a-z]/.test(headerAfterEmoji)) {
    errors.push('Summary must start with a capitalized verb.');
  }
  if (body.some((line) => line.trim())) {
    if ((body[0] ?? '').trim()) {
      errors.push('Summary and body require a blank separator.');
    }
    if (body.some((line) => line.length > 100)) {
      errors.push('Body line exceeds 100 characters.');
    }
  }
  if (errors.length > 0) {
    throw invalidCommitMessage(errors);
  }
}

export function invalidCommitMessage(errors: string[]) {
  return workflowError(
    'COMMIT_MESSAGE_INVALID',
    'Commit message does not satisfy repository guidelines.',
    ExitCode.guard,
    { details: { errors } },
  );
}
