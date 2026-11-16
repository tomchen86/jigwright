/** Observes exactly the repository/runtime pair needed by current intake counts. */
import { discoverRepository } from '../repository-transaction/git.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
export function observeGovernanceIntakeCountContext(cwd: string) {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  return {
    repositoryRoot: repository.repositoryRoot,
    runtimeRoot: runtimePaths(
      repository.gitCommonDirectory,
      config.runtimeDirectory,
    ).root,
  };
}
