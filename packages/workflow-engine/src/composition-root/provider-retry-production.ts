import type { ProviderRetryScheduleOperations } from '../modules/provider-orchestration/provider-retry-service-port.ts';
/** Binds retry routing to lifecycle publishers, current observations and durable runtime pumping. */
import crypto from 'node:crypto';
import { processProviderFailureRetry as processFailure } from '../application/provider-retry/provider-failure-retry.ts';
import { createProviderRetryRuntime } from '../runtime/provider-execution/provider-retry-scheduler.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { inspectExecutionJob } from '../runtime/provider-execution/execution-runtime.ts';
import { readProviderRetryReservation } from '../runtime/storage-journal/provider-invocation-reservations.ts';
import { readProviderInvocationRequest } from '../runtime/storage-journal/provider-invocation-artifacts.ts';
import { readInvestigationSession } from '../runtime/storage-journal/investigation-session-records.ts';
import { loadAiAdapterPolicy } from '../runtime/provider-policy/ai-adapter-policy.ts';
import { executeProviderReadOnlyProbe } from '../runtime/provider-execution/provider-probe-executor.ts';
import { retryInvestigationProvider } from './investigation-retry-production.ts';
import {
  getProposeStatus,
  resumePropose,
  createPlanReviewRetryEnvelope,
} from './propose-production.ts';
import type {
  ProviderFailureRetryPorts,
  ProcessProviderFailureRetryOptions,
  ProviderRetrySchedulePumpOptions,
} from '../modules/provider-orchestration/provider-retry-service-port.ts';
export type {
  ProcessProviderFailureRetryOptions,
  ProviderRetrySchedulePumpOptions,
  ProviderFailureRetryResult,
  ProviderRetrySchedulePumpResult,
} from '../modules/provider-orchestration/provider-retry-service-port.ts';
export type {
  ProviderRetryScheduleState,
  ProviderRetryScheduleNextAction,
  ProviderAutomaticRetrySchedule,
  ProviderRetryScheduleReceiptState,
  ProviderRetryScheduleReceipt,
} from '../modules/provider-orchestration/provider-retry-schedule.ts';

function runtime(cwd: string) {
  return createProviderRetryRuntime(
    cwd,
    () => loadInvestigationRuntimeContext(cwd).runtime,
    executeProviderReadOnlyProbe,
  );
}

function failureRetryPorts(cwd: string): ProviderFailureRetryPorts {
  return {
    runtime: runtime(cwd),
    inspectDecision(jobId) {
      return inspectExecutionJob(cwd, jobId).latestFailure?.decision;
    },
    publication: {
      readSurveyReservation(failed) {
        const context = loadInvestigationRuntimeContext(cwd);
        return readProviderRetryReservation(
          context.runtime,
          failed.investigationId,
          failed.attempt + 1,
        );
      },
      readSurveyInput(failed) {
        const context = loadInvestigationRuntimeContext(cwd);
        const request = readProviderInvocationRequest(
          context.runtime,
          failed.invocationId,
        );
        const session = readInvestigationSession(
          context.runtime,
          failed.investigationId,
        );
        const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
        return {
          request,
          revision: session.revision,
          policyDigest: policy.digest,
          limits: policy.policy.limits,
          identity: crypto.randomUUID(),
        };
      },
      publishSurvey(failed, expectedRevision, replacementRequest) {
        const retried = retryInvestigationProvider(
          cwd,
          failed.investigationId,
          { expectedRevision, replacementRequest },
        );
        return {
          invocationId: retried.providerInvocationId,
          attempt: retried.provider.attempt,
        };
      },
      publishPlanReview(failed, consumedRoleResultReplay) {
        const collaborationGrantValidation =
          consumedRoleResultReplay === undefined
            ? undefined
            : {
                consumedRoleResultReplay,
                consumedPlanReviewReplay: consumedRoleResultReplay,
              };
        const output = getProposeStatus(
          cwd,
          failed.investigationId,
          collaborationGrantValidation,
        );
        const retried = resumePropose(
          cwd,
          failed.changeId,
          createPlanReviewRetryEnvelope(cwd, output, {
            acknowledgeProviderCost: true,
          }),
          collaborationGrantValidation === undefined
            ? {}
            : { collaborationGrantValidation },
        );
        return retried.planReview?.invocationId;
      },
    },
  };
}

export function processProviderFailureRetry(
  cwd: string,
  requestedInvocationId: string,
  options: ProcessProviderFailureRetryOptions = {},
) {
  return processFailure(failureRetryPorts(cwd), requestedInvocationId, options);
}
export function readProviderAutomaticRetrySchedule(
  cwd: string,
  invocationId: string,
) {
  return runtime(cwd).readSchedule(invocationId);
}
export const listProviderAutomaticRetrySchedules: ProviderRetryScheduleOperations['listProviderAutomaticRetrySchedules'] =
  function listProviderAutomaticRetrySchedules(cwd) {
    return runtime(cwd).listSchedules();
  };
export const listProviderRetryScheduleReceipts: ProviderRetryScheduleOperations['listProviderRetryScheduleReceipts'] =
  function listProviderRetryScheduleReceipts(cwd, scheduleId) {
    return runtime(cwd).listReceipts(scheduleId);
  };
export const pumpProviderRetrySchedules: ProviderRetryScheduleOperations['pumpProviderRetrySchedules'] =
  function pumpProviderRetrySchedules(cwd, options) {
    return runtime(cwd).pump(options);
  };
