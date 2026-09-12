import { taskMandateOperations } from './task-mandate-production.ts';
/** Binds operational command handlers to the actual job, retry, retention and replay services. */
import {
  listExecutionJobs,
  inspectExecutionJob,
} from '../runtime/provider-execution/execution-runtime.ts';
import { pruneProviderRuntime } from '../runtime/provider-execution/provider-retention.ts';
import {
  inspectEvidenceRetention,
  runEvidenceRetentionMaintenance,
  pinWorkflowEvidence,
} from '../runtime/provider-execution/retention-control.ts';
import {
  requestExecutionReplacement,
  executeGrantedReplacement,
  previewExecutionJobRetry,
  requestExecutionJobRetry,
} from './execution-retry-production.ts';
import {
  pumpProviderRetrySchedules,
  listProviderAutomaticRetrySchedules,
  listProviderRetryScheduleReceipts,
} from './provider-retry-production.ts';
import { productionConsumedPlanReviewReplayPort } from './grant-verifier-composition.ts';
export const providerOperationsServices = {
  listExecutionJobs,
  inspectExecutionJob,
  pruneProviderRuntime,
  pumpProviderRetrySchedules,
  listProviderAutomaticRetrySchedules,
  listProviderRetryScheduleReceipts,
  requestExecutionReplacement,
  executeGrantedReplacement,
  previewExecutionJobRetry,
  requestExecutionJobRetry,
  inspectEvidenceRetention,
  runEvidenceRetentionMaintenance,
  pinWorkflowEvidence: pinWorkflowEvidence.bind(
    undefined,
    taskMandateOperations,
  ),
  consumedPlanReviewReplay: productionConsumedPlanReviewReplayPort,
};
