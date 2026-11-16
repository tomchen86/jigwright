/** Immutable commit replay operations; caller-owned semantic services are required. */
import { lastCommitChangingPath } from './ci-git.ts';
import { readFileAtCommit } from '../../repository-transaction/git-command.ts';
import { parseTasks } from '../../../modules/planning-provider/planning-artifact-parsers.ts';
import { WorkflowError } from '../../../foundation/errors/errors.ts';
import { assertChangeId } from '../../../foundation/repository-path/repository-path.ts';
import { assertTaskId } from '../../../foundation/repository-path/repository-path.ts';
import type { HistoricalTaskAuthority } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import { parseCheckRegistry } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import { parseTaskPolicy } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import { parseJson } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import { hasExactKeys } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import { isRecord } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import { ciContractError } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import { currentPlanRequiredError } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';

import type { CiHistoricalReplayServices } from './services.ts';
import type { CiHistoricalReplayOperations } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
export function createCiHistoricalReplay(
  services: CiHistoricalReplayServices,
): CiHistoricalReplayOperations {
  const { validateCiPlanningCommit } = services;
  function loadHistoricalTaskAuthority(
    repositoryRoot: string,
    commit: string,
    requestedChangeId: string,
    requestedTaskId: string,
    changeRoot = 'openspec/changes',
  ): HistoricalTaskAuthority {
    const changeId = assertChangeId(requestedChangeId);
    const taskId = assertTaskId(requestedTaskId);
    const planReviewPath = `${changeRoot}/${changeId}/plan-review.json`;
    const governingPlanCommit = lastCommitChangingPath(
      repositoryRoot,
      commit,
      planReviewPath,
    );
    if (governingPlanCommit === null) {
      throw currentPlanRequiredError();
    }
    try {
      validateCiPlanningCommit(
        repositoryRoot,
        governingPlanCommit,
        changeId,
        changeRoot,
      );
    } catch (error) {
      if (
        error instanceof WorkflowError &&
        error.code === 'OPENSPEC_MANAGED_SCHEMA_REQUIRED'
      ) {
        throw currentPlanRequiredError();
      }
      throw error;
    }
    const tasksPath = `${changeRoot}/${changeId}/tasks.md`;
    const tasksContent = requiredFile(repositoryRoot, commit, tasksPath);
    const tasks = parseTasks(tasksContent);

    const guardPath = `${changeRoot}/${changeId}/guard.json`;
    const guard = parseJson(
      requiredFile(repositoryRoot, commit, guardPath),
      'CI_PARENT_GUARD_INVALID',
    );
    if (
      !isRecord(guard) ||
      !hasExactKeys(guard, ['changeId', 'schemaVersion', 'tasks']) ||
      guard.schemaVersion !== 1 ||
      guard.changeId !== changeId ||
      !isRecord(guard.tasks)
    ) {
      throw ciContractError(
        'CI_PARENT_GUARD_INVALID',
        'The parent guard contract is invalid.',
      );
    }
    const guardTasks = guard.tasks;
    const taskIds = tasks.map(({ id }) => id).sort();
    const guardTaskIds = Object.keys(guardTasks).sort();
    if (JSON.stringify(taskIds) !== JSON.stringify(guardTaskIds)) {
      throw ciContractError(
        'CI_PARENT_GUARD_INVALID',
        'The parent tasks and guard policies are not one-to-one.',
      );
    }

    const checks = parseJson(
      requiredFile(repositoryRoot, commit, 'workflow/checks.json'),
      'CI_PARENT_CHECKS_INVALID',
    );
    if (
      !isRecord(checks) ||
      !hasExactKeys(checks, ['checks', 'schemaVersion']) ||
      checks.schemaVersion !== 1 ||
      !isRecord(checks.checks)
    ) {
      throw ciContractError(
        'CI_PARENT_CHECKS_INVALID',
        'The parent check registry is invalid.',
      );
    }
    const registry = parseCheckRegistry(checks.checks);
    const policies = Object.fromEntries(
      taskIds.map((currentTaskId) => [
        currentTaskId,
        parseTaskPolicy(guardTasks[currentTaskId], registry),
      ]),
    );
    const task = tasks.find(({ id }) => id === taskId);
    if (!task || task.completed) {
      throw ciContractError(
        'CI_MANAGED_TRAILER_UNKNOWN',
        'A task commit must name an incomplete task in its parent contract.',
      );
    }
    const policy = policies[taskId];

    return {
      changeId,
      taskId,
      tasksPath,
      tasks,
      allowedPaths: policy.allowedPaths,
      requiredChecks: policy.requiredChecks,
      checkDefinitions: policy.checkDefinitions,
    };
  }

  function requiredFile(
    repositoryRoot: string,
    commit: string,
    filePath: string,
  ): string {
    const content = readFileAtCommit(repositoryRoot, commit, filePath);
    if (content === undefined) {
      throw ciContractError(
        'CI_PARENT_CONTRACT_MISSING',
        `The parent contract is missing ${filePath}.`,
      );
    }
    return content;
  }
  return { loadHistoricalTaskAuthority };
}
