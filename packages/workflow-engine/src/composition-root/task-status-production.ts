/** Binds task-status observations and current replay authorities without observing at assembly. */
import { createTaskStatusQuery } from '../application/session-inspection/task-status.ts';
import { currentGovernanceIntakeCounts } from './governance-intake-command-production.ts';
import { getProposeStatus } from './propose-production.ts';
import {
  productionConsumedRoleResultReplayPort,
  productionConsumedPlanReviewReplayPort,
} from './grant-verifier-composition.ts';
import { findOpenTaskLifecycleStatus as findOpenTaskLifecycleStatusWithContractReader } from '../application/execute-task/open-task.ts';
import { handoffDocuments } from './handoff-production.ts';
import { loadChangeContract as productionChangeContractReader } from './consumer-contract-production.ts';
import {
  getSession,
  listSessions,
} from '../runtime/repository-observation/workflow-session-context.ts';
import { inspectFinalizeRecoveryStatus } from './finalization-production.ts';
import { inspectTaskStrategyLifecycle } from './task-strategy-production.ts';
import { inspectTaskRevisionStatus } from '../application/revise/task-revision.ts';
import { findTaskCommits } from '../runtime/finalization/commit.ts';

const findOpenTaskLifecycleStatus =
  findOpenTaskLifecycleStatusWithContractReader.bind(
    undefined,
    handoffDocuments,
    productionChangeContractReader,
  );

export const queryTaskStatus = createTaskStatusQuery({
  currentGovernanceIntakeCounts,
  getProposeStatus(cwd, identifier) {
    return getProposeStatus(cwd, identifier, {
      consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
      consumedPlanReviewReplay: productionConsumedPlanReviewReplayPort,
    });
  },
  findOpenTaskLifecycleStatus,
  getSession,
  listSessions,
  inspectFinalizeRecoveryStatus(cwd, sessionId) {
    return inspectFinalizeRecoveryStatus(cwd, sessionId, {
      consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
    });
  },
  inspectTaskStrategyLifecycle,
  inspectTaskRevisionStatus,
  findTaskCommits,
});
