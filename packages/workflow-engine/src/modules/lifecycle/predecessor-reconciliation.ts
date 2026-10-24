import type { CheckEvidence } from '../../foundation/check-evidence/check-evidence.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { matchesAllowedPath } from '../../foundation/repository-path/repository-path.ts';
import type { ChangeContract } from '../planning-provider/change-contract.ts';
import type {
  ParsedTask,
  TaskPolicy,
} from '../planning-provider/planning-artifact-types.ts';
import {
  hasExactTrailers,
  type CommitFacts,
} from '../repository-consumer/commit-facts.ts';
import type { WorkflowSession } from './workflow-session-contract.ts';

/** Selects and admits the immediate predecessor using pinned task, check and commit facts. */

export type ReconciledTask = {
  taskId: string;
  commitHash: string;
  changedPaths: string[];
  checks: CheckEvidence[];
};

export function selectImmediatePredecessor(
  contract: Pick<ChangeContract, 'tasks'>,
  session: Pick<WorkflowSession, 'taskId'>,
): ParsedTask | null {
  const currentIndex = contract.tasks.findIndex(
    ({ id }) => id === session.taskId,
  );
  const incompleteEarlier = contract.tasks
    .slice(0, currentIndex)
    .filter(({ completed }) => !completed);
  if (incompleteEarlier.length === 0) {
    return null;
  }
  const predecessor = contract.tasks[currentIndex - 1];
  if (
    incompleteEarlier.length !== 1 ||
    !predecessor ||
    incompleteEarlier[0].id !== predecessor.id
  ) {
    throw predecessorInvalid();
  }

  return predecessor;
}

export function assertPinnedPredecessorContract(
  currentContract: Pick<ChangeContract, 'checks'>,
  taskId: string,
  currentPolicy: TaskPolicy,
  baselineGuard: Record<string, unknown>,
  baselineChecks: Record<string, unknown>,
): void {
  if (
    !isRecord(baselineGuard.tasks) ||
    JSON.stringify(baselineGuard.tasks[taskId]) !==
      JSON.stringify(currentPolicy) ||
    !isRecord(baselineChecks.checks)
  ) {
    throw predecessorInvalid();
  }
  for (const checkId of currentPolicy.requiredChecks) {
    if (
      JSON.stringify(baselineChecks.checks[checkId]) !==
      JSON.stringify(currentContract.checks.checks[checkId])
    ) {
      throw predecessorInvalid();
    }
  }
}

export function assertPredecessorCommit(
  facts: CommitFacts,
  changedPaths: string[],
  session: Pick<WorkflowSession, 'changeId'>,
  predecessor: ParsedTask,
  policy: TaskPolicy,
): void {
  if (
    facts.parents.length !== 1 ||
    changedPaths.length === 0 ||
    !hasExactTrailers(facts.message, session.changeId, predecessor.id) ||
    changedPaths.some(
      (changedPath) =>
        !policy.allowedPaths.some((allowedPath) =>
          matchesAllowedPath(changedPath, allowedPath),
        ),
    )
  ) {
    throw predecessorInvalid();
  }
}

export function predecessorInvalid() {
  return workflowError(
    'PREDECESSOR_NOT_RECONCILABLE',
    'An incomplete predecessor lacks matching pinned Git and check evidence.',
    ExitCode.verification,
  );
}
