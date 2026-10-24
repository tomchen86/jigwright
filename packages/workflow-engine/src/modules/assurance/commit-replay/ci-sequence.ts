import type { RangeCommit } from './ci-git.ts';
import type { CiCollaborationGrantUse } from './ci-planning.ts';
import type { ChangeContract } from '../../planning-provider/change-contract.ts';

/** Canonical commit replay contracts and pure predicates. */

import { taskKey } from './ci-task-state.ts';
import type { CompletedTask } from './ci-task-state.ts';
import { ExitCode } from '../../../foundation/errors/errors.ts';
import { workflowError } from '../../../foundation/errors/errors.ts';

export type CommitSequenceResult = {
  completedTasks: CompletedTask[];
  archivedChanges: string[];
  authorityGrants: string[];
  requiredCheckDefinitions: Record<string, string>;
  collaborationGrantUses: readonly CiCollaborationGrantUse[];
};

export function recordTransitions(
  completed: Map<string, CompletedTask>,
  transitions: CompletedTask[],
): void {
  for (const task of transitions) {
    completed.set(taskKey(task), task);
  }
}

export function recordDefinitions(
  collected: Map<string, string>,
  definitions: Record<string, string>,
  supersede = false,
): void {
  for (const [checkId, definition] of Object.entries(definitions)) {
    const previous = collected.get(checkId);
    if (!supersede && previous !== undefined && previous !== definition) {
      throw ciError(
        'CI_CHECK_DEFINITION_CHANGED',
        `Required check ${checkId} changed between task commits.`,
      );
    }
    collected.set(checkId, definition);
  }
}

export function ciError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}

export type CiSequenceReplayOperations = {
  replayCommitSequence(
    repositoryRoot: string,
    commits: RangeCommit[],
    contracts: Map<string, ChangeContract>,
    evaluatedAt?: Date,
    priorCollaborationGrantUses?: readonly CiCollaborationGrantUse[],
  ): CommitSequenceResult;
};
