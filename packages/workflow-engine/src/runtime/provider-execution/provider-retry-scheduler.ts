/** Durable retry schedules and bounded lock-scoped dispatch/probe receipt pumping. */
import fs from 'node:fs';
import path from 'node:path';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  assertReadOnlyProbe,
  type ReadOnlyProbeRequest,
} from '../../modules/provider-orchestration/execution-core.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import { readExecutionJobState } from '../storage-journal/execution-store.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  privatePathExists,
  readPrivateCanonicalJson,
  assertPrivateInvestigationDirectory,
  withPrivateRuntimeLock,
} from '../journal-primitives/investigation-private-files.ts';
import { readProviderInvocation } from '../storage-journal/provider-invocation-state.ts';
import { readProviderInvocationRequest } from '../storage-journal/provider-invocation-artifacts.ts';
import {
  type ProviderAutomaticRetrySchedule,
  exactTimestamp,
  deepFreeze,
  providerRetryScheduleUnsafe,
  assertProviderAutomaticRetrySchedule,
  sha256Text,
  type ProviderRetryScheduleReceipt,
  isDigest,
  assertProviderRetryScheduleReceipt,
  digestCanonical,
  isRecord,
  hasExactKeys,
} from '../../modules/provider-orchestration/provider-retry-schedule.ts';
import {
  providerRetrySchedulePath,
  providerRetryScheduleRoot,
  providerRetryReceiptRoot,
  providerRetryScheduleLockPath,
  readProviderAutomaticRetryScheduleFromPaths,
  startScheduleReceipt,
  reconcileScheduleFromReceipt,
  finishScheduleReceipt,
  probeBackoffForAttempt,
  persistSchedule,
} from './provider-retry-store.ts';
import type {
  ProviderRetryRuntime,
  ProviderRetrySchedulePumpResult,
  ProviderRetrySchedulePumpOptions,
  ProviderFailureRetryResult,
  ProcessProviderFailureRetryOptions,
  ProviderReadOnlyProbeExecutionResult,
} from '../../modules/provider-orchestration/provider-retry-service-port.ts';

const RETRY_SCHEDULE_FILE = /^[0-9a-f]{64}\.json$/;
const RETRY_RECEIPT_FILE = /^[0-9a-f]{64}\.json$/;

export function createProviderRetryRuntime(
  cwd: string,
  loadPaths: () => InvestigationRuntimePaths,
  defaultProbeExecutor: NonNullable<
    ProviderRetrySchedulePumpOptions['probeExecutor']
  >,
): ProviderRetryRuntime {
  function readProviderAutomaticRetrySchedule(
    requestedInvocationId: string,
  ): ProviderAutomaticRetrySchedule | null {
    const runtime = loadPaths();
    const schedulePath = providerRetrySchedulePath(
      runtime,
      requestedInvocationId,
    );
    if (
      !privatePathExists(runtime, schedulePath, providerRetryScheduleUnsafe)
    ) {
      return null;
    }
    const schedule = assertProviderAutomaticRetrySchedule(
      readPrivateCanonicalJson(
        runtime,
        schedulePath,
        providerRetryScheduleUnsafe,
      ),
    );
    if (schedule.failedInvocationId !== requestedInvocationId) {
      throw providerRetryScheduleUnsafe();
    }
    return schedule;
  }

  function listProviderAutomaticRetrySchedules(): ProviderAutomaticRetrySchedule[] {
    const runtime = loadPaths();
    const root = providerRetryScheduleRoot(runtime);
    const stats = fs.lstatSync(root, { throwIfNoEntry: false });
    if (stats === undefined) return [];
    assertPrivateInvestigationDirectory(
      runtime,
      root,
      providerRetryScheduleUnsafe,
    );
    return fs
      .readdirSync(root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !RETRY_SCHEDULE_FILE.test(entry.name)
        ) {
          throw providerRetryScheduleUnsafe();
        }
        const schedule = assertProviderAutomaticRetrySchedule(
          readPrivateCanonicalJson(
            runtime,
            path.join(root, entry.name),
            providerRetryScheduleUnsafe,
          ),
        );
        if (`${sha256Text(schedule.failedInvocationId)}.json` !== entry.name) {
          throw providerRetryScheduleUnsafe();
        }
        return schedule;
      });
  }

  function listProviderRetryScheduleReceipts(
    scheduleId?: string,
  ): ProviderRetryScheduleReceipt[] {
    if (scheduleId !== undefined && !isDigest(scheduleId)) {
      throw providerRetryScheduleUnsafe();
    }
    const runtime = loadPaths();
    const root = providerRetryReceiptRoot(runtime);
    const stats = fs.lstatSync(root, { throwIfNoEntry: false });
    if (stats === undefined) return [];
    assertPrivateInvestigationDirectory(
      runtime,
      root,
      providerRetryScheduleUnsafe,
    );
    return fs
      .readdirSync(root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !RETRY_RECEIPT_FILE.test(entry.name)
        ) {
          throw providerRetryScheduleUnsafe();
        }
        const receipt = assertProviderRetryScheduleReceipt(
          readPrivateCanonicalJson(
            runtime,
            path.join(root, entry.name),
            providerRetryScheduleUnsafe,
          ),
        );
        if (
          `${receipt.receiptId.slice('sha256:'.length)}.json` !== entry.name
        ) {
          throw providerRetryScheduleUnsafe();
        }
        return receipt;
      })
      .filter((receipt) =>
        scheduleId === undefined ? true : receipt.scheduleId === scheduleId,
      )
      .sort(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) ||
          left.attemptNumber - right.attemptNumber ||
          left.receiptId.localeCompare(right.receiptId),
      );
  }

  /** Process at most `limit` due retry schedules in one finite sweep. */
  function pumpProviderRetrySchedules(
    options: ProviderRetrySchedulePumpOptions,
  ): ProviderRetrySchedulePumpResult {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    ) {
      throw workflowError(
        'PROVIDER_RETRY_PUMP_LIMIT_INVALID',
        'Provider retry pump limit must be an integer from 1 through 100.',
        ExitCode.usage,
      );
    }
    const now = exactTimestamp(options.now ?? new Date().toISOString());
    const schedules = listProviderAutomaticRetrySchedules();
    const due = schedules
      .filter(
        (schedule) =>
          schedule.state === 'scheduled' &&
          Date.parse(schedule.notBefore) <= Date.parse(now) &&
          (schedule.route === 'environment-probe' ||
            options.dispatcher !== undefined),
      )
      .sort(
        (left, right) =>
          left.notBefore.localeCompare(right.notBefore) ||
          left.scheduleId.localeCompare(right.scheduleId),
      );
    const processed: string[] = [];
    for (const schedule of due.slice(0, options.limit)) {
      const updated = processDueSchedule(schedule, now, options);
      if (
        updated.state !== 'scheduled' ||
        updated.updatedAt !== schedule.updatedAt
      ) {
        processed.push(updated.scheduleId);
      }
    }
    return deepFreeze({
      schemaVersion: 1 as const,
      kind: 'provider-retry-schedule-pump' as const,
      inspected: schedules.length,
      due: due.length,
      processed: processed.length,
      scheduleIds: processed,
    });
  }

  function processDueSchedule(
    expected: ProviderAutomaticRetrySchedule,
    now: string,
    options: Pick<
      ProviderRetrySchedulePumpOptions,
      'dispatcher' | 'probeExecutor' | 'faultInjector'
    >,
  ): ProviderAutomaticRetrySchedule {
    const runtime = loadPaths();
    return withPrivateRuntimeLock(
      runtime,
      providerRetryScheduleLockPath(runtime, expected.failedInvocationId),
      () => {
        const current = readProviderAutomaticRetryScheduleFromPaths(
          runtime,
          expected.failedInvocationId,
        );
        if (current.scheduleId !== expected.scheduleId) {
          throw providerRetryScheduleUnsafe();
        }
        if (
          current.state !== 'scheduled' ||
          Date.parse(current.notBefore) > Date.parse(now)
        ) {
          return current;
        }
        const receipt = startScheduleReceipt(runtime, current, now);
        if (receipt.state !== 'started') {
          return reconcileScheduleFromReceipt(runtime, current, receipt);
        }
        if (current.route === 'provider-replacement') {
          if (options.dispatcher === undefined) return current;
          const replacement = readProviderInvocation(
            runtime,
            current.replacementInvocationId!,
          );
          if (replacement.state === 'prepared') {
            options.dispatcher(cwd, replacement.invocationId);
          }
          options.faultInjector?.('after-dispatch', current);
          const completed = finishScheduleReceipt(runtime, receipt, {
            state: 'dispatch-issued',
            outcomeCode: 'PROVIDER_REPLACEMENT_DISPATCH_ISSUED',
            observationDigest: digestCanonical({
              invocationId: replacement.invocationId,
              observedState: replacement.state,
            }),
            completedAt: now,
            nextNotBefore: null,
          });
          return reconcileScheduleFromReceipt(runtime, current, completed);
        }

        const probe = assertReadOnlyProbe(current.probe);
        let result: ProviderReadOnlyProbeExecutionResult;
        try {
          result = assertProviderReadOnlyProbeExecutionResult(
            (options.probeExecutor ?? defaultProbeExecutor)(
              cwd,
              probe,
              current,
            ),
          );
        } catch (error) {
          result = {
            state: 'failed',
            code:
              error instanceof WorkflowError
                ? error.code
                : 'PROVIDER_PROBE_EXECUTION_FAILED',
            observationDigest: digestCanonical({
              code:
                error instanceof WorkflowError
                  ? error.code
                  : 'PROVIDER_PROBE_EXECUTION_FAILED',
            }),
            elapsedMs: 0,
          };
        }
        if (result.elapsedMs > probe.timeoutMs) {
          result = {
            state: 'failed',
            code: 'PROVIDER_PROBE_TIMEOUT',
            observationDigest: digestCanonical({
              reportedObservationDigest: result.observationDigest,
              elapsedMs: result.elapsedMs,
              timeoutMs: probe.timeoutMs,
            }),
            elapsedMs: result.elapsedMs,
          };
        }
        options.faultInjector?.('after-probe-execution', current);
        const attemptNumber = receipt.attemptNumber;
        const terminal =
          result.state === 'succeeded' ||
          attemptNumber >= current.probeMaxAttempts;
        const nextNotBefore = terminal
          ? null
          : new Date(
              Date.parse(now) + probeBackoffForAttempt(current, attemptNumber),
            ).toISOString();
        const completed = finishScheduleReceipt(runtime, receipt, {
          state:
            result.state === 'succeeded'
              ? 'probe-succeeded'
              : terminal
                ? 'probe-failed-terminal'
                : 'probe-retry-scheduled',
          outcomeCode: result.code,
          observationDigest: result.observationDigest,
          completedAt: now,
          nextNotBefore,
        });
        return reconcileScheduleFromReceipt(runtime, current, completed);
      },
      'PROVIDER_RETRY_SCHEDULE_OPERATION_CONFLICT',
      providerRetryScheduleUnsafe,
    );
  }

  function assertProviderReadOnlyProbeExecutionResult(
    value: unknown,
  ): ProviderReadOnlyProbeExecutionResult {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'state',
        'code',
        'observationDigest',
        'elapsedMs',
      ]) ||
      (value.state !== 'succeeded' && value.state !== 'failed') ||
      typeof value.code !== 'string' ||
      !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.code) ||
      !isDigest(value.observationDigest) ||
      !Number.isSafeInteger(value.elapsedMs) ||
      (value.elapsedMs as number) < 0 ||
      (value.elapsedMs as number) > 86_400_000
    ) {
      throw providerRetryScheduleUnsafe();
    }
    return deepFreeze(
      structuredClone(value) as unknown as ProviderReadOnlyProbeExecutionResult,
    );
  }

  function persistProbe(
    failed: ProviderInvocationRecord,
    jobId: string,
    probe: Readonly<ReadOnlyProbeRequest>,
    retryAfterMs: number,
    now: string,
  ): ProviderAutomaticRetrySchedule {
    const runtime = loadPaths();
    const state = readExecutionJobState(runtime, jobId);
    const failedAttempt = state?.attempts.find(
      ({ providerInvocation }) =>
        providerInvocation?.invocationId === failed.invocationId,
    );
    if (state === null || state === undefined || failedAttempt === undefined) {
      throw providerRetryScheduleUnsafe();
    }
    const schedule = persistSchedule(runtime, {
      failed,
      state,
      failedAttemptId: failedAttempt.attemptId,
      replacementAttemptId: null,
      replacementInvocationId: null,
      route: 'environment-probe',
      retryMode: 'probe-only',
      probe,
      retryAfterMs,
      createdAt: now,
    });
    return schedule;
  }

  function createReplacementSchedule(
    failed: ProviderInvocationRecord,
    jobId: string,
    replacementInvocationId: string,
    now: string,
  ): ProviderAutomaticRetrySchedule {
    const runtime = loadPaths();
    const replacement = readProviderInvocation(
      runtime,
      replacementInvocationId,
    );
    const state = readExecutionJobState(runtime, jobId);
    const failedAttempt = state?.attempts.find(
      ({ providerInvocation }) =>
        providerInvocation?.invocationId === failed.invocationId,
    );
    const replacementAttempt = state?.attempts.find(
      ({ providerInvocation }) =>
        providerInvocation?.invocationId === replacement.invocationId,
    );
    if (
      state === null ||
      state === undefined ||
      failedAttempt === undefined ||
      replacementAttempt === undefined ||
      replacement.investigationId !== failed.investigationId ||
      replacement.changeId !== failed.changeId ||
      replacement.purpose !== failed.purpose ||
      replacement.attempt !== failed.attempt + 1 ||
      replacementAttempt.retryOf !== failedAttempt.attemptId ||
      replacementAttempt.jobId !== failedAttempt.jobId ||
      replacementAttempt.workflowId !== failedAttempt.workflowId ||
      replacementAttempt.epoch !== failedAttempt.epoch ||
      replacementAttempt.contextDigest !== failedAttempt.contextDigest
    ) {
      throw providerRetryScheduleUnsafe();
    }
    return persistSchedule(runtime, {
      failed,
      state,
      failedAttemptId: failedAttempt.attemptId,
      replacementAttemptId: replacementAttempt.attemptId,
      replacementInvocationId: replacement.invocationId,
      route: 'provider-replacement',
      retryMode: replacementAttempt.retryMode,
      probe: null,
      retryAfterMs: failed.failure!.retryAfterMs ?? 0,
      createdAt: now,
    });
  }

  function continueSchedule(
    schedule: ProviderAutomaticRetrySchedule,
    now: string,
    dispatcher: ProcessProviderFailureRetryOptions['dispatcher'],
  ): ProviderFailureRetryResult {
    if (schedule.route === 'environment-probe') {
      return deepFreeze({ kind: 'probe-scheduled' as const, schedule });
    }
    if (schedule.state === 'dispatch-issued') {
      return deepFreeze({
        kind: 'replacement-dispatched' as const,
        schedule,
      });
    }
    if (Date.parse(now) < Date.parse(schedule.notBefore) || !dispatcher) {
      return deepFreeze({
        kind: 'replacement-scheduled' as const,
        schedule,
      });
    }
    const updated = processDueSchedule(schedule, now, { dispatcher });
    return deepFreeze({
      kind: 'replacement-dispatched' as const,
      schedule: updated,
    });
  }

  return {
    readSchedule: readProviderAutomaticRetrySchedule,
    readFailure(invocationId) {
      const runtime = loadPaths();
      const failed = readProviderInvocation(runtime, invocationId);
      return {
        failed,
        request: readProviderInvocationRequest(runtime, failed.invocationId),
      };
    },
    persistProbe,
    persistReplacement: createReplacementSchedule,
    continueSchedule,
    pump: pumpProviderRetrySchedules,
    listSchedules: listProviderAutomaticRetrySchedules,
    listReceipts: listProviderRetryScheduleReceipts,
  };
}
