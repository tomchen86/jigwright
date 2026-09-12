/** Observe and admit an existing engine overlay for a parent session. */
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { GitState } from '../repository-consumer/repository-git-state.ts';
import type { LocalEngineBinding } from './intervention-bootstrap-contract.ts';
export type HarnessBootstrapParentBindingObservations = {
  observeParentBindingPath(
    stateRoot: string,
    parentChangeId: string,
  ): string | null;
};

export function assertHarnessBootstrapParentBinding(
  localBinding: LocalEngineBinding,
  parentChangeId: string,
  repository: GitState,
  expectedBranch: string,
): void {
  if (
    localBinding.parentChangeId !== parentChangeId ||
    localBinding.parentWorkspacePath !== repository.repositoryRealPath ||
    localBinding.parentBranch !== `refs/heads/${expectedBranch}` ||
    localBinding.interventionState !== 'adopted' ||
    localBinding.blocker !== null
  ) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_BINDING_CONFLICT',
      'Existing local engine binding is not a committed parent overlay.',
      ExitCode.staleState,
    );
  }
}
