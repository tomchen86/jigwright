import { discoverRepository } from '../repository-transaction/git.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { investigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  readPreMergeAssurance,
  storePreMergeAssurance,
} from './pre-merge-assurance-store.ts';
import type { PreMergeAssuranceNode } from '../../modules/assurance/pre-merge-assurance.ts';
export function storePreMergeAssuranceForRepository(
  cwd: string,
  assurance: PreMergeAssuranceNode,
): PreMergeAssuranceNode {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  return storePreMergeAssurance(
    investigationRuntimePaths(git.gitCommonDirectory, config.runtimeDirectory),
    assurance,
  );
}

export function readPreMergeAssuranceForRepository(
  cwd: string,
  requestedBaseCommit: string,
  requestedHeadCommit: string,
): PreMergeAssuranceNode | null {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  return readPreMergeAssurance(
    investigationRuntimePaths(git.gitCommonDirectory, config.runtimeDirectory),
    requestedBaseCommit,
    requestedHeadCommit,
  );
}
