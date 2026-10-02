/** Queries task status from required observations without performing physical operations. */
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import type { GovernanceIntakeCountsV1 } from '../../modules/governance-intake/intake-summary.ts';
import type { TaskCommit } from '../../modules/assurance/task-execution-evidence.ts';
import type { OpenTaskLifecycleStatus } from '../../modules/lifecycle/open-task-status.ts';

export type TaskStatusOperations<TPropose, TFinalize, TStrategy, TRevision> =
  Readonly<{
    currentGovernanceIntakeCounts(cwd: string): GovernanceIntakeCountsV1;
    getProposeStatus(cwd: string, identifier: string): TPropose;
    findOpenTaskLifecycleStatus(
      cwd: string,
      identifier: string,
    ): OpenTaskLifecycleStatus | null;
    getSession(cwd: string, sessionId: string): WorkflowSession;
    listSessions(cwd: string): WorkflowSession[];
    inspectFinalizeRecoveryStatus(
      cwd: string,
      sessionId: string,
    ): TFinalize | null;
    inspectTaskStrategyLifecycle(cwd: string, sessionId: string): TStrategy;
    inspectTaskRevisionStatus(cwd: string, sessionId: string): TRevision | null;
    findTaskCommits(
      cwd: string,
      changeId: string,
      taskId: string,
    ): TaskCommit[];
  }>;

export function createTaskStatusQuery<
  TPropose,
  TFinalize,
  TStrategy,
  TRevision,
>(operations: TaskStatusOperations<TPropose, TFinalize, TStrategy, TRevision>) {
  const {
    currentGovernanceIntakeCounts,
    getProposeStatus,
    findOpenTaskLifecycleStatus,
    getSession,
    listSessions,
    inspectFinalizeRecoveryStatus,
    inspectTaskStrategyLifecycle,
    inspectTaskRevisionStatus,
    findTaskCommits,
  } = operations;
  return function queryTaskStatus(cwd: string, identifier?: string) {
    const intakeCounts = currentGovernanceIntakeCounts(cwd);
    if (identifier) {
      if (identifier.startsWith('investigation-')) {
        return {
          intakeCounts,
          result: getProposeStatus(cwd, identifier),
        };
      }
      const openTaskStatus = findOpenTaskLifecycleStatus(cwd, identifier);
      if (
        openTaskStatus !== null &&
        (openTaskStatus.state === 'opening' ||
          openTaskStatus.state === 'recovery-required')
      ) {
        return { intakeCounts, openTask: openTaskStatus };
      }
      const session = getSession(
        cwd,
        openTaskStatus === null ? identifier : openTaskStatus.sessionId,
      );
      const statusRoot = sessionStatusRepositoryRoot(cwd, session);
      const finalizeStatus = inspectFinalizeRecoveryStatus(
        statusRoot,
        session.sessionId,
      );
      return {
        intakeCounts,
        ...(openTaskStatus === null ? {} : { openTask: openTaskStatus }),
        session,
        ...(finalizeStatus ? { finalize: finalizeStatus } : {}),
        taskStrategy: inspectTaskStrategyLifecycle(
          statusRoot,
          session.sessionId,
        ),
        taskRevision: inspectTaskRevisionStatus(statusRoot, session.sessionId),
        taskCommits: findTaskCommits(
          statusRoot,
          session.changeId,
          session.taskId,
        ),
      };
    }
    const sessions = listSessions(cwd);
    return {
      intakeCounts,
      sessions,
      taskStrategies: sessions.map((session) => {
        const statusRoot = sessionStatusRepositoryRoot(cwd, session);
        return inspectTaskStrategyLifecycle(statusRoot, session.sessionId);
      }),
      taskRevisions: sessions.map((session) => {
        const statusRoot = sessionStatusRepositoryRoot(cwd, session);
        return inspectTaskRevisionStatus(statusRoot, session.sessionId);
      }),
      taskCommits: sessions.map((session) => ({
        changeId: session.changeId,
        taskId: session.taskId,
        commits: findTaskCommits(
          sessionStatusRepositoryRoot(cwd, session),
          session.changeId,
          session.taskId,
        ),
      })),
    };
  };
}

function sessionStatusRepositoryRoot(
  callerRoot: string,
  session: WorkflowSession,
): string {
  return session.state === 'active' || session.state === 'revising'
    ? session.repositoryRoot
    : callerRoot;
}
