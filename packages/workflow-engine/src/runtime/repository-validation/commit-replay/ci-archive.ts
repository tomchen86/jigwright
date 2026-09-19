/** Immutable commit replay operations; caller-owned semantic services are required. */
import fs from 'node:fs';
import path from 'node:path';
import { verifyArchiveDeltaOutcomes } from '../../repository-transaction/archive-delta-verifier.ts';
import { assertUniqueCollaborationGrantUses } from '../../grants/grant-services.ts';
import { canonicalCheckDefinition } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import { assertArchiveReplayContent } from './ci-archive-tree.ts';
import { inspectArchiveCommitTree } from './ci-archive-tree.ts';
import { normalizeArchivePaths } from '../../../modules/assurance/commit-replay/ci-archive-tree.ts';
import { loadChecksConfig } from '../../repository-observation/workflow-configuration.ts';
import { loadWorkflowConfig } from '../../repository-observation/workflow-configuration.ts';
import type { ChangeContract } from '../../../modules/planning-provider/change-contract.ts';
import { createTrustedExecutionEnvironment } from '../../process-environment/execution-environment.ts';
import { archiveCommitMessage } from '../../repository-transaction/git-transitions.ts';
import { commitChangedPaths } from '../../repository-transaction/git-transitions.ts';
import { commitFacts } from '../../repository-transaction/git-transitions.ts';
import { findCurrentExecutionTaskCommits } from '../../repository-transaction/git-transitions.ts';
import { listChangedPaths } from '../../repository-transaction/git.ts';
import { runGit } from '../../repository-transaction/git.ts';
import { inspectPlanningArchiveReadiness } from '../../../modules/planning-provider/planning-archive-projection-port.ts';
import { validatePlanningArchiveProjectedSpecs } from '../../../modules/planning-provider/planning-archive-projection-port.ts';
import type { PlanningArchiveProjectionContext } from '@jigwright/core/planning-archive-projection-port';
import type { CiArchiveValidation } from '../../../modules/assurance/commit-replay/ci-archive.ts';
import { prepareArchiveProjectionForReplay } from '../../../modules/assurance/commit-replay/ci-archive.ts';
import { archivePayloadFromProjection } from '../../../modules/assurance/commit-replay/ci-archive.ts';
import { assertChangeId } from '../../../modules/assurance/commit-replay/ci-archive.ts';
import { replayMismatch } from '../../../modules/assurance/commit-replay/ci-archive.ts';
import { archiveError } from '../../../modules/assurance/commit-replay/ci-archive.ts';

import type { CiArchiveReplayServices } from './services.ts';
import type { CiArchiveReplayOperations } from '../../../modules/assurance/commit-replay/ci-archive.ts';
export function createCiArchiveReplay(
  services: CiArchiveReplayServices,
): CiArchiveReplayOperations {
  const {
    readSystemSpecDeltaInputs,
    createRepositorySpecificationPolicy,
    loadCommittedChangeContract,
    archiveReconciliationTimestamp,
    refreshArchiveManagedHandoff,
    reconcileArchivedWorkItems,
    createOpenSpecPlanningArchiveProjectionPort,
    collectHistoricalCollaborationGrantUses,
    resolveHistoricalPlanningProviderForCi,
  } = services;
  function validateCiArchiveCommit(
    repositoryRoot: string,
    commitHash: string,
    changeId: string,
  ): CiArchiveValidation {
    assertChangeId(changeId);
    const facts = commitFacts(repositoryRoot, commitHash);
    if (
      facts.parents.length !== 1 ||
      facts.message !== `${archiveCommitMessage(changeId)}\n`
    ) {
      throw archiveError(
        'CI_ARCHIVE_MESSAGE_INVALID',
        'Archive commits require the exact managed message and one parent.',
      );
    }
    const parent = facts.parents[0];
    const changedPaths = commitChangedPaths(repositoryRoot, commitHash);
    const config = loadWorkflowConfig(repositoryRoot);
    assertUniqueCollaborationGrantUses(
      collectHistoricalCollaborationGrantUses(
        repositoryRoot,
        parent,
        changeId,
        config.changeRoot,
      ),
    );
    const archivePath = inspectArchiveCommitTree(
      repositoryRoot,
      parent,
      commitHash,
      config.changeRoot,
      changeId,
      changedPaths,
    );
    const planningProvider = resolveHistoricalPlanningProviderForCi(
      repositoryRoot,
      parent,
      config.changeRoot,
      changeId,
    );
    const archiveProjectionPort = createOpenSpecPlanningArchiveProjectionPort();
    const temporaryBase = createTrustedExecutionEnvironment().TMPDIR;
    if (!temporaryBase) {
      throw archiveError(
        'CI_ARCHIVE_TEMPORARY_DIRECTORY_UNAVAILABLE',
        'Archive replay requires a trusted temporary directory.',
      );
    }
    const temporaryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(temporaryBase), 'workflow-ci-archive-'),
    );
    const worktree = path.join(temporaryRoot, 'worktree');
    let worktreeAdded = false;
    try {
      runGit(repositoryRoot, ['worktree', 'add', '--detach', worktree, parent]);
      worktreeAdded = true;
      const contract = loadCommittedChangeContract(worktree, parent, changeId);
      if (contract.tasks.some(({ completed }) => !completed)) {
        throw archiveError(
          'CI_ARCHIVE_TASKS_INCOMPLETE',
          'Every archived task must be complete in the archive parent.',
        );
      }
      assertTaskEvidence(
        repositoryRoot,
        parent,
        config.changeRoot,
        contract.changeId,
        contract.tasks,
      );
      const checkDefinitions = archiveCheckDefinitions(worktree, contract);
      const context = archiveReplayProjectionContext(
        repositoryRoot,
        worktree,
        parent,
        changeId,
        planningProvider,
      );
      if (
        !inspectPlanningArchiveReadiness(archiveProjectionPort, context).ready
      ) {
        throw replayMismatch();
      }
      const payload = archivePayloadFromProjection(
        prepareArchiveProjectionForReplay(archiveProjectionPort, context),
        config.changeRoot,
        changeId,
      );
      reconcileArchivedWorkItems(
        worktree,
        changeId,
        payload.archivePath,
        archiveReconciliationTimestamp(worktree, parent),
      );
      refreshArchiveManagedHandoff(worktree, parent);
      if (
        !validatePlanningArchiveProjectedSpecs(archiveProjectionPort, context)
          .valid
      ) {
        throw replayMismatch();
      }
      const replayPaths = listChangedPaths(worktree, parent);
      if (
        JSON.stringify(normalizeArchivePaths(changedPaths, changeId)) !==
        JSON.stringify(normalizeArchivePaths(replayPaths, changeId))
      ) {
        throw replayMismatch();
      }
      assertArchiveReplayContent(
        repositoryRoot,
        commitHash,
        archivePath,
        worktree,
        payload.archivePath,
        replayPaths,
      );
      const baseSpecPaths = createRepositorySpecificationPolicy(
        config.changeRoot,
      ).baseSpecificationPaths(replayPaths);
      verifyArchiveDeltaOutcomes(
        readSystemSpecDeltaInputs,
        repositoryRoot,
        { changeId, head: parent },
        {
          baseSpecPaths,
          tree: commitHash,
          totals: payload.totals,
        },
      );
      return { changeId, archivePath, changedPaths, checkDefinitions };
    } finally {
      if (worktreeAdded) {
        runGit(repositoryRoot, ['worktree', 'remove', '--force', worktree]);
      }
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  function archiveReplayProjectionContext(
    repositoryRoot: string,
    projectionRoot: string,
    sourceRevision: string,
    changeId: string,
    planningProvider: ReturnType<typeof resolveHistoricalPlanningProviderForCi>,
  ): PlanningArchiveProjectionContext {
    return {
      repositoryRoot: fs.realpathSync(repositoryRoot),
      projectionRoot: fs.realpathSync(projectionRoot),
      sourceRevision,
      changeId,
      mode: 'replay',
      planningProvider,
    };
  }

  function assertTaskEvidence(
    repositoryRoot: string,
    parent: string,
    changeRoot: string,
    changeId: string,
    tasks: Array<{ id: string }>,
  ): void {
    for (const task of tasks) {
      const commits = findCurrentExecutionTaskCommits(
        repositoryRoot,
        changeId,
        task.id,
        parent,
      );
      if (commits.length !== 1) {
        throw archiveError(
          'CI_ARCHIVE_TASK_EVIDENCE_INVALID',
          'Every archived task requires one reachable canonical task commit.',
        );
      }
      if (
        runGit(
          repositoryRoot,
          ['merge-base', commits[0].hash, parent],
          true,
        ).trim() !== commits[0].hash
      ) {
        throw archiveError(
          'CI_ARCHIVE_TASK_EVIDENCE_INVALID',
          'Every archived task requires one reachable canonical task commit.',
        );
      }
    }
  }

  function archiveCheckDefinitions(
    repositoryRoot: string,
    contract: ChangeContract,
  ): Record<string, string> {
    const checks = loadChecksConfig(repositoryRoot).checks;
    return Object.fromEntries(
      [
        ...new Set(
          Object.values(contract.guard.tasks).flatMap(
            ({ requiredChecks }) => requiredChecks,
          ),
        ),
      ]
        .sort()
        .map((checkId) => {
          const definition = checks[checkId];
          if (!definition) throw replayMismatch();
          return [checkId, canonicalCheckDefinition(definition)];
        }),
    );
  }
  return { validateCiArchiveCommit };
}
