/** Parent bootstrap observation contract and exact durable admission decisions. */
import path from 'node:path';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { GitState } from '../repository-consumer/repository-git-state.ts';
import type { WorkflowSession } from '../lifecycle/workflow-session-contract.ts';
import type { SessionRuntimeLayoutV1 } from '@jigwright/core/session-runtime-layout-port';
import type { LocalEngineBinding } from './intervention-bootstrap-contract.ts';
export type HarnessBootstrapParentObservation = {
  repository: GitState;
  runtime: SessionRuntimeLayoutV1;
  candidates: Array<{
    sessionId: string;
    sessionPath: string;
    session: WorkflowSession;
  }>;
};
export type HarnessBootstrapParentObservations = {
  observeParentSessions(
    cwd: string,
    parentChangeId: string,
  ): HarnessBootstrapParentObservation;
  observeParentBindingPath(
    stateRoot: string,
    parentChangeId: string,
  ): string | null;
};

export function admitHarnessBootstrapParent(
  observation: HarnessBootstrapParentObservation,
  parentChangeId: string,
  stateRoot: string,
) {
  const { repository, runtime, candidates } = observation;
  if (candidates.length === 0) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_SESSION_NOT_FOUND',
      'No active durable workflow session exists for the requested parent change.',
      ExitCode.staleState,
    );
  }
  if (candidates.length !== 1) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_SESSION_AMBIGUOUS',
      'More than one active durable workflow session claims the parent change.',
      ExitCode.staleState,
    );
  }
  const { session } = candidates[0]!;
  const expectedBranch = `work/${parentChangeId}`;
  if (
    session.state !== 'active' ||
    session.repositoryRoot !== repository.repositoryRealPath ||
    session.gitCommonDirectory !== repository.gitCommonDirectory ||
    session.branch !== expectedBranch ||
    repository.branch !== expectedBranch ||
    session.baseline.head !== repository.head ||
    session.baseline.tree !== repository.tree
  ) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_SESSION_STALE',
      'Durable parent session identity, branch, or baseline differs from the current worktree.',
      ExitCode.staleState,
    );
  }
  const expectedStateRoot = path.join(runtime.root, 'intervention-control');
  if (stateRoot !== expectedStateRoot) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_STATE_ROOT_MISMATCH',
      'Bootstrap dispatcher state root differs from the durable workflow runtime.',
      ExitCode.verification,
    );
  }
  return { session, expectedBranch };
}

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
