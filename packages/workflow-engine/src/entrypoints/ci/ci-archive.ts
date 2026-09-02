import fs from 'node:fs';
import path from 'node:path';

import { verifyArchiveDeltaOutcomes } from '../../runtime/repository-transaction/archive-delta-verifier.ts';
import { assertUniqueCollaborationGrantUses } from '../../modules/authority/collaboration-grant.ts';
import { canonicalCheckDefinition } from './ci-historical-contract.ts';
import {
  collectHistoricalCollaborationGrantUses,
  resolveHistoricalPlanningProviderForCi,
} from './ci-planning.ts';
import {
  assertArchiveReplayContent,
  inspectArchiveCommitTree,
  isArchiveName,
  normalizeArchivePaths,
} from './ci-archive-tree.ts';
import {
  loadCommittedChangeContract,
  loadChecksConfig,
  loadWorkflowConfig,
  type ChangeContract,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { createTrustedExecutionEnvironment } from '../../runtime/provider-execution/execution-environment.ts';
import {
  archiveCommitMessage,
  commitChangedPaths,
  commitFacts,
  findCurrentExecutionTaskCommits,
} from '../../runtime/repository-transaction/git-transitions.ts';
import {
  listChangedPaths,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  archiveReconciliationTimestamp,
  refreshArchiveManagedHandoff,
} from '../../application/archive/archive-transformation.ts';
import { reconcileArchivedWorkItems } from '../../modules/governance-intake/work-registry.ts';
import {
  inspectPlanningArchiveReadiness,
  preparePlanningArchiveProjection,
  validatePlanningArchiveProjectedSpecs,
  type PlanningArchiveProjection,
  type PlanningArchiveProjectionContext,
  type PlanningArchiveProjectionPort,
} from '../../modules/planning-provider/planning-archive-projection-port.ts';
import { createOpenSpecPlanningArchiveProjectionPort } from '../../composition-root/planning-archive-projection-production.ts';

type ArchiveTotals = {
  added: number;
  modified: number;
  removed: number;
  renamed: number;
};

export type CiArchiveValidation = {
  changeId: string;
  archivePath: string;
  changedPaths: string[];
  checkDefinitions: Record<string, string>;
};

export function validateCiArchiveCommit(
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
    const baseSpecPaths = replayPaths.filter((filePath) =>
      filePath.startsWith('openspec/specs/'),
    );
    verifyArchiveDeltaOutcomes(
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

function prepareArchiveProjectionForReplay(
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveProjection {
  try {
    return preparePlanningArchiveProjection(port, context);
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      (error.code === 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID' ||
        error.code === 'PLANNING_ARCHIVE_PROJECTION_PORT_INVALID')
    ) {
      throw replayMismatch();
    }
    throw error;
  }
}

function archivePayloadFromProjection(
  projection: PlanningArchiveProjection,
  changeRoot: string,
  changeId: string,
): { archivePath: string; totals: ArchiveTotals } {
  const totals = projection.totals;
  if (
    !projection.specsUpdated ||
    totals === undefined ||
    !isArchiveName(projection.archiveName, changeId) ||
    projection.archivePath !== `${changeRoot}/archive/${projection.archiveName}`
  ) {
    throw replayMismatch();
  }
  return { archivePath: projection.archivePath, totals };
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

function isTotals(value: unknown): value is ArchiveTotals {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['added', 'modified', 'removed', 'renamed']) &&
    ['added', 'modified', 'removed', 'renamed'].every(
      (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
    )
  );
}

function assertChangeId(changeId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) throw replayMismatch();
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replayMismatch() {
  return archiveError(
    'CI_ARCHIVE_REPLAY_MISMATCH',
    'Archive commit differs from the independently replayed transformation.',
  );
}

function archiveError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
