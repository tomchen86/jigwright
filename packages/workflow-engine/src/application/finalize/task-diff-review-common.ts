/**
 * Coordinates lifecycle locks, protected-apply admission and baseline
 * observations across task diff review modules.
 *
 * Invariants:
 * - Protected apply review requires a checked transaction matching the
 *   current session.
 */
import { protectedTaskApplyReviewAuthorizationInvalid } from '../../modules/assurance/task-diff-review-values.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { assertPreparedProtectedTaskApplyAuthorization } from '../task-apply-authorization/protected-task-apply-authorization.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import type {
  TaskDiffReviewRuntimeBindings,
  TaskDiffReviewRuntimeData,
} from './task-diff-review-lifecycle.ts';

import { readFileAtRevision } from '../../runtime/repository-transaction/git-command.ts';

type RepositoryLifecycleOperationOptions =
  TaskDiffReviewRuntimeData['RepositoryLifecycleOperationOptions'];

export function createTaskDiffReviewCommonModule(
  runtime: TaskDiffReviewRuntimeBindings,
) {
  const {
    loadActiveSessionContext,
    readFinalizeTransaction,
    withRepositoryLifecycleOperation,
    parseAiAdapterPolicyDocument,
  } = runtime;
  function taskDiffReviewLifecycleOptions(
    context: ReturnType<typeof loadActiveSessionContext>,
    requestedSessionId: string,
  ): RepositoryLifecycleOperationOptions {
    const challengeId = protectedTaskApplyReviewChallenge(
      context,
      requestedSessionId,
    );
    return challengeId === null
      ? {}
      : { allowGrantChallengeIds: [challengeId] };
  }

  function assertTaskDiffReviewLifecycleGrantCurrent(
    context: ReturnType<typeof loadActiveSessionContext>,
    requestedSessionId: string,
  ): void {
    protectedTaskApplyReviewChallenge(context, requestedSessionId);
  }

  function protectedTaskApplyReviewChallenge(
    context: ReturnType<typeof loadActiveSessionContext>,
    requestedSessionId: string,
  ): string | null {
    if (context.session.sessionId !== requestedSessionId) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    const transaction = readFinalizeTransaction(
      context.runtime.root,
      context.session.sessionId,
    );
    if (transaction?.protectedApply === undefined) return null;
    if (
      transaction.phase !== 'checked' ||
      transaction.candidateTree === null ||
      transaction.sessionId !== context.session.sessionId ||
      transaction.changeId !== context.session.changeId ||
      transaction.taskId !== context.session.taskId ||
      transaction.repositoryRoot !== context.git.repositoryRealPath ||
      transaction.gitCommonDirectory !== context.git.gitCommonDirectory ||
      transaction.branch !== context.session.branch ||
      canonicalJson(transaction.baseline) !==
        canonicalJson(context.session.baseline)
    ) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    const binding = transaction.protectedApply;
    const { parameters } = assertPreparedProtectedTaskApplyAuthorization(
      context.runtime.root,
      binding,
    );
    const engineOwnedPaths = new Set([
      transaction.taskProjectionPath,
      ...transaction.transitionPaths,
      ...(context.session.implementationReconciliationPaths ?? []),
    ]);
    const taskPaths = transaction.changedPaths.filter(
      (changedPath) => !engineOwnedPaths.has(changedPath),
    );
    if (
      parameters.changeId !== context.session.changeId ||
      parameters.sessionId !== context.session.sessionId ||
      parameters.taskId !== context.session.taskId ||
      parameters.branch !== context.session.branch ||
      canonicalJson(parameters.baseline) !==
        canonicalJson(context.session.baseline) ||
      canonicalJson(parameters.mandateBinding) !==
        canonicalJson(context.session.mandateBinding ?? null) ||
      canonicalJson(parameters.changedPaths) !== canonicalJson(taskPaths)
    ) {
      throw protectedTaskApplyReviewAuthorizationInvalid();
    }
    return binding.challengeId;
  }

  function withTaskDiffReviewProviderLifecycleOperation<T>(
    cwd: string,
    requestedSessionId: string,
    operation: (assertOwned: () => void) => T,
  ): T {
    const initialContext = loadActiveSessionContext(cwd, requestedSessionId);
    return withRepositoryLifecycleOperation(
      initialContext.runtime,
      (assertOwned) => {
        assertOwned();
        const context = loadActiveSessionContext(cwd, requestedSessionId);
        assertTaskDiffReviewLifecycleGrantCurrent(context, requestedSessionId);
        return operation(assertOwned);
      },
      taskDiffReviewLifecycleOptions(initialContext, requestedSessionId),
    );
  }

  function baselineAdapterPolicy(repositoryRoot: string, commit: string) {
    try {
      return parseAiAdapterPolicyDocument(
        readFileAtRevision(
          repositoryRoot,
          commit,
          'workflow/ai-adapter-policy.json',
        ),
      );
    } catch (error) {
      throw workflowError(
        'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
        'TaskDiffReview could not verify its baseline adapter policy.',
        ExitCode.staleState,
        {
          details: {
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
  }

  function parseBaselineJson<T>(
    repositoryRoot: string,
    commit: string,
    relativePath: string,
    parse: (value: unknown) => T,
  ): T {
    let value: unknown;
    try {
      value = JSON.parse(
        readFileAtRevision(repositoryRoot, commit, `${relativePath}`),
      );
    } catch (error) {
      throw workflowError(
        'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
        `TaskDiffReview could not verify baseline ${relativePath}.`,
        ExitCode.staleState,
        {
          details: {
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
    try {
      return parse(value);
    } catch (error) {
      throw workflowError(
        'TASK_DIFF_REVIEW_BASELINE_POLICY_INVALID',
        `TaskDiffReview baseline ${relativePath} is invalid.`,
        ExitCode.staleState,
        {
          details: {
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
  }
  return {
    taskDiffReviewLifecycleOptions,
    assertTaskDiffReviewLifecycleGrantCurrent,
    protectedTaskApplyReviewChallenge,
    withTaskDiffReviewProviderLifecycleOperation,
    baselineAdapterPolicy,
    parseBaselineJson,
  };
}
