/** Reads only the requested epoch observation, without batching later phases. */
import fs from 'node:fs';
import { defaultSessionRuntimeLayoutPort } from '@jigwright/core/session-runtime-layout-port';
import type { PlanningExecutionEpochObservations } from '../../modules/lifecycle/planning-execution-epoch-observations.ts';
import { discoverRepository, runGit } from '../repository-transaction/git.ts';
import { commitFacts } from '../repository-transaction/git-commit-history.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { readPlanningTransitionReport } from '../storage-journal/planning-report.ts';
export const resolvePlanningExecutionEpochEnvironment: PlanningExecutionEpochObservations['resolveEnvironment'] =
  (cwd) => {
    const repository = discoverRepository(cwd);
    const config = loadWorkflowConfig(repository.repositoryRoot);
    const storeRoot = defaultSessionRuntimeLayoutPort.resolve({
      gitCommonDirectory: repository.gitCommonDirectory,
      runtimeDirectory: config.runtimeDirectory,
    }).root;
    return {
      repositoryRoot: repository.repositoryRoot,
      changeRoot: config.changeRoot,
      storeRoot,
    };
  };
export const readPlanningExecutionEpochCommits: PlanningExecutionEpochObservations['readFirstParentCommits'] =
  (repositoryRoot, tip) =>
    runGit(repositoryRoot, ['rev-list', '--first-parent', tip])
      .trim()
      .split(/\s+/)
      .filter(Boolean);
export const readPlanningExecutionEpochReportEntries: PlanningExecutionEpochObservations['readReportEntries'] =
  (reportsDirectory) => {
    // A fresh clone has no runtime reports; recovery still enforces exactly one matching report.
    return fs.existsSync(reportsDirectory)
      ? fs.readdirSync(reportsDirectory)
      : [];
  };
export const planningExecutionEpochRepositoryObservations = {
  resolveEnvironment: resolvePlanningExecutionEpochEnvironment,
  readFirstParentCommits: readPlanningExecutionEpochCommits,
  readReportEntries: readPlanningExecutionEpochReportEntries,
  readCommitFacts: commitFacts,
  readPlanningTransitionReport,
} satisfies Omit<PlanningExecutionEpochObservations, 'taskExecutionGeneration'>;
