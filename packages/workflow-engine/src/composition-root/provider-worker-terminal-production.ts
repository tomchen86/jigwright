/** Binds terminal followups to retry, retention and fresh warning observations. */
import { runProviderWorkerTerminalFollowups as runTerminalFollowups } from '../application/provider-worker/provider-terminal-followups.ts';
import {
  processProviderFailureRetry,
  pumpProviderRetrySchedules,
} from './provider-retry-production.ts';
import { dispatchProviderWorker } from './provider-worker-dispatch-production.ts';
import { productionConsumedPlanReviewReplayPort } from './grant-verifier-composition.ts';
import { runEvidenceRetentionMaintenance } from './retention-production.ts';
import { recordProviderWorkerTerminalWarning } from '../runtime/storage-journal/provider-worker-maintenance.ts';
import { observeInvestigationRuntimeContext } from '../runtime/repository-observation/investigation-runtime-context.ts';

export {
  isRoleAssignmentGrantRequired,
  type ProviderWorkerTerminalOptions,
} from '../application/provider-worker/provider-terminal-followups.ts';

export const runProviderWorkerTerminalFollowups = runTerminalFollowups.bind(
  undefined,
  {
    processProviderFailureRetry,
    pumpProviderRetrySchedules,
    runEvidenceRetentionMaintenance,
    recordTerminalWarning: recordProviderWorkerTerminalWarning.bind(
      undefined,
      (cwd: string) => observeInvestigationRuntimeContext(cwd).runtime,
    ),
    dispatchProviderWorker,
    consumedPlanReviewReplay: productionConsumedPlanReviewReplayPort,
  },
);
