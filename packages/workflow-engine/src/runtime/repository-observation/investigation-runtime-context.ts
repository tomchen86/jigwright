/** Observes repository/configuration and both investigation runtime layouts. */
import { discoverRepository } from '../repository-transaction/git.ts';
import { investigationRuntimePaths } from '../paths/runtime-paths.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';

export function observeInvestigationRuntimeContext(cwd: string) {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  return {
    git,
    config,
    runtime: investigationRuntimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    ),
    lifecycleRuntime: runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    ),
  };
}
