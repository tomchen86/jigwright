/** Binds operational command handlers to the actual job, retry, retention and replay services. */
import {
  listExecutionJobs,
  inspectExecutionJob,
} from '../runtime/provider-execution/execution-runtime.ts';
import {
  inspectProviderRetentionMetrics,
  pruneProviderRuntime,
  inspectEvidenceRetention,
  runEvidenceRetentionMaintenance,
  pinWorkflowEvidence,
} from './retention-production.ts';
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
  pinWorkflowEvidence,
  consumedPlanReviewReplay: productionConsumedPlanReviewReplayPort,
};

import { collectEngineMetrics as collectMetrics } from '../application/control-plane/engine-metrics.ts';
export const collectEngineMetrics = collectMetrics.bind(
  undefined,
  inspectProviderRetentionMetrics,
);
