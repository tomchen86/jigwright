/** Feature capabilities for failure routing, lifecycle publication and durable retry pumping. */
import type { ProviderInvocationRecord } from './provider-invocation-record.ts';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import type { ReadOnlyProbeRequest, RetryDecision } from './execution-core.ts';
import type { GrantRequest } from '../authority/execution-governance-grant-contracts.ts';
import type { ConsumedPlanReviewReplayPort } from '../assurance/planning-assurance-validator.ts';
import type {
  ProviderAutomaticRetrySchedule,
  ProviderRetryScheduleReceipt,
} from './provider-retry-schedule.ts';

export type ProviderReadOnlyProbeExecutionResult = Readonly<{
  state: 'succeeded' | 'failed';
  code: string;
  observationDigest: string;
  elapsedMs: number;
}>;

export type ProviderRetrySchedulePumpResult = Readonly<{
  schemaVersion: 1;
  kind: 'provider-retry-schedule-pump';
  inspected: number;
  due: number;
  processed: number;
  scheduleIds: readonly string[];
}>;

export type ProviderRetrySchedulePumpOptions = Readonly<{
  limit: number;
  now?: string;
  dispatcher?: (cwd: string, invocationId: string) => unknown;
  probeExecutor?: (
    cwd: string,
    request: Readonly<ReadOnlyProbeRequest>,
    schedule: ProviderAutomaticRetrySchedule,
  ) => ProviderReadOnlyProbeExecutionResult;
  faultInjector?: (
    point: 'after-dispatch' | 'after-probe-execution',
    schedule: ProviderAutomaticRetrySchedule,
  ) => void;
}>;

export type ProviderFailureRetryResult =
  | Readonly<{
      kind: 'replacement-scheduled' | 'replacement-dispatched';
      schedule: ProviderAutomaticRetrySchedule;
    }>
  | Readonly<{
      kind: 'probe-scheduled';
      schedule: ProviderAutomaticRetrySchedule;
    }>
  | Readonly<{
      kind: 'grant-required';
      jobId: string;
      grantRequest: GrantRequest;
    }>
  | Readonly<{
      kind: 'decision-denied' | 'not-retryable';
      jobId: string;
      reasonCode: string;
    }>;

export type ProcessProviderFailureRetryOptions = Readonly<{
  now?: string;
  dispatcher?: (cwd: string, invocationId: string) => unknown;
  consumedRoleResultReplay?: ConsumedPlanReviewReplayPort;
}>;

export type ProviderFailureRetryStorage = Readonly<{
  readSchedule(invocationId: string): ProviderAutomaticRetrySchedule | null;
  readFailure(invocationId: string): {
    failed: ProviderInvocationRecord;
    request: ProviderInvocationRequest;
  };
  persistProbe(
    failed: ProviderInvocationRecord,
    jobId: string,
    probe: Readonly<ReadOnlyProbeRequest>,
    retryAfterMs: number,
    now: string,
  ): ProviderAutomaticRetrySchedule;
  persistReplacement(
    failed: ProviderInvocationRecord,
    jobId: string,
    replacementInvocationId: string,
    now: string,
  ): ProviderAutomaticRetrySchedule;
  continueSchedule(
    schedule: ProviderAutomaticRetrySchedule,
    now: string,
    dispatcher?: ProcessProviderFailureRetryOptions['dispatcher'],
  ): ProviderFailureRetryResult;
}>;

export type ProviderRetryRuntime = ProviderFailureRetryStorage &
  Readonly<{
    pump(
      options: ProviderRetrySchedulePumpOptions,
    ): ProviderRetrySchedulePumpResult;
    listSchedules(): ProviderAutomaticRetrySchedule[];
    listReceipts(scheduleId?: string): ProviderRetryScheduleReceipt[];
  }>;

export type ProviderRetryPublication = Readonly<{
  readSurveyReservation(
    failed: ProviderInvocationRecord,
  ): { previousInvocationId: string; invocationId: string } | null;
  readSurveyInput(failed: ProviderInvocationRecord): {
    request: ProviderInvocationRequest;
    revision: number;
    policyDigest: string;
    limits: ProviderInvocationRequest['limits'];
    identity: string;
  };
  publishSurvey(
    failed: ProviderInvocationRecord,
    expectedRevision: number,
    replacementRequest: ProviderInvocationRequest,
  ): { invocationId: string; attempt: number };
  publishPlanReview(
    failed: ProviderInvocationRecord,
    consumedRoleResultReplay?: ConsumedPlanReviewReplayPort,
  ): string | undefined;
}>;

export type ProviderFailureRetryPorts = Readonly<{
  runtime: ProviderFailureRetryStorage;
  inspectDecision(jobId: string): RetryDecision | undefined;
  publication: ProviderRetryPublication;
}>;

/** Repository-scoped access to the retry runtime's existing operations. */
export type ProviderRetryScheduleOperations = Readonly<{
  listProviderAutomaticRetrySchedules: (
    cwd: string,
    ...args: Parameters<ProviderRetryRuntime['listSchedules']>
  ) => ReturnType<ProviderRetryRuntime['listSchedules']>;
  listProviderRetryScheduleReceipts: (
    cwd: string,
    ...args: Parameters<ProviderRetryRuntime['listReceipts']>
  ) => ReturnType<ProviderRetryRuntime['listReceipts']>;
  pumpProviderRetrySchedules: (
    cwd: string,
    ...args: Parameters<ProviderRetryRuntime['pump']>
  ) => ReturnType<ProviderRetryRuntime['pump']>;
}>;
