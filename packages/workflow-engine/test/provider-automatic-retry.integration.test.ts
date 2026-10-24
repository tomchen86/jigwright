import { observeInvestigationRuntimeContext } from '../src/runtime/repository-observation/investigation-runtime-context.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { deriveAuthorityAuditRepositoryId } from '../src/modules/authority/authority-audit-contract.ts';
import { showAuthorityAuditTask } from '../src/runtime/storage-journal/authority-audit-service.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { projectProviderInvocationExecution } from '../src/modules/provider-orchestration/execution-core.ts';
import { inspectExecutionJob } from '../src/runtime/provider-execution/execution-runtime.ts';
import { readExecutionJobState } from '../src/runtime/storage-journal/execution-store.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import { startPropose } from '../src/composition-root/propose-production.ts';
import { readProviderInvocation } from '../src/runtime/storage-journal/provider-invocation-state.ts';
import { readProviderInvocationRequest } from '../src/runtime/storage-journal/provider-invocation-artifacts.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import {
  listProviderRetryScheduleReceipts,
  pumpProviderRetrySchedules,
  readProviderAutomaticRetrySchedule,
  type ProviderAutomaticRetrySchedule,
} from '../src/composition-root/provider-retry-production.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { listProviderWorkerMaintenanceWarnings } from '../src/runtime/storage-journal/provider-worker-maintenance.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import {
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
  createFixtureRepository,
  git,
} from './fixture.ts';

test('worker persists Retry-After, creates one cheap replacement, and dispatches only when due', () => {
  const fixture = startWorkerFixture('worker-auto-rate-limit');
  try {
    const dispatched: string[] = [];
    const result = runProviderWorker(fixture.repository, fixture.invocationId, {
      runner() {
        throw workflowError(
          'PROVIDER_RATE_LIMIT',
          'The provider asked the worker to retry later.',
          ExitCode.verification,
          { details: { retryAfterMs: 23_000 } },
        );
      },
      automaticRetry: {
        enabled: true,
        dispatcher(_cwd, invocationId) {
          dispatched.push(invocationId);
        },
      },
    });

    assert.equal(result.state, 'failed');
    const failed = readProviderInvocation(
      fixture.runtime,
      fixture.invocationId,
    );
    assert.equal(failed.failure?.executionKind, 'rate-limit');
    assert.equal(failed.failure?.retryAfterMs, 23_000);
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    assert.equal(schedule.route, 'provider-replacement');
    assert.equal(schedule.retryMode, 'same-input');
    assert.equal(schedule.retryAfterMs, 23_000);
    assert.equal(schedule.state, 'scheduled');
    assert.ok(schedule.replacementInvocationId);
    assert.equal(dispatched.length, 0);

    const replacement = readProviderInvocation(
      fixture.runtime,
      schedule.replacementInvocationId,
    );
    assert.equal(replacement.state, 'prepared');
    assert.equal(replacement.attempt, 2);
    assert.equal(replacement.investigationId, failed.investigationId);
    const state = readExecutionJobState(
      fixture.runtime,
      schedule.executionJobId,
    );
    assert.ok(state);
    assert.equal(state.workflow.workflowId, schedule.workflowId);
    assert.equal(state.workflow.currentEpoch, schedule.epoch);
    assert.equal(state.workflow.contextDigest, schedule.contextDigest);
    assert.equal(state.attempts.length, 2);
    assert.equal(state.attempts[1]?.retryOf, state.attempts[0]?.attemptId);

    const due = new Date(Date.parse(schedule.notBefore) + 1).toISOString();
    const swept = pumpProviderRetrySchedules(fixture.repository, {
      limit: 10,
      now: due,
      dispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.equal(swept.processed, 1);
    assert.deepEqual(dispatched, [schedule.replacementInvocationId]);
    assert.equal(
      requiredSchedule(fixture.repository, fixture.invocationId).state,
      'dispatch-issued',
    );
    assert.equal(
      listProviderRetryScheduleReceipts(
        fixture.repository,
        schedule.scheduleId,
      )[0]?.state,
      'dispatch-issued',
    );

    pumpProviderRetrySchedules(fixture.repository, {
      limit: 10,
      now: due,
      dispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.deepEqual(dispatched, [schedule.replacementInvocationId]);
  } finally {
    fixture.dispose();
  }
});

test('replacement worker rejects a prior Attempt without its exact execution policy snapshot', () => {
  const fixture = startWorkerFixture('worker-rejects-missing-prior-policy');
  try {
    runProviderWorker(fixture.repository, fixture.invocationId, {
      runner() {
        throw workflowError(
          'PROVIDER_RATE_LIMIT',
          'The provider asked the worker to retry immediately.',
          ExitCode.verification,
          { details: { retryAfterMs: 0 } },
        );
      },
      automaticRetry: { enabled: true },
    });
    const replacement = requiredSchedule(
      fixture.repository,
      fixture.invocationId,
    ).replacementInvocationId;
    fs.rmSync(
      path.join(
        fixture.runtime.invocations,
        fixture.invocationId,
        'execution-policy.json',
      ),
    );

    let runnerCalled = false;
    assert.throws(
      () =>
        runProviderWorker(fixture.repository, replacement, {
          runner() {
            runnerCalled = true;
            throw workflowError(
              'PROVIDER_LAUNCH_FAILED',
              'The fixture runner must remain unreachable.',
              ExitCode.verification,
            );
          },
          automaticRetry: { enabled: false },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE',
    );
    assert.equal(runnerCalled, false);
  } finally {
    fixture.dispose();
  }
});

test('replacement role-assignment Fail-Grant reaches the caller and resumes the same schedule after approval', () => {
  const fixture = startWorkerFixture('worker-auto-role-grant');
  try {
    const now = '2030-08-29T02:00:00.000Z';
    let gatedInvocationId: string | null = null;
    let retentionCalls = 0;
    assert.throws(
      () =>
        runProviderWorker(fixture.repository, fixture.invocationId, {
          runner() {
            throw workflowError(
              'PROVIDER_RATE_LIMIT',
              'The provider asked the worker to retry immediately.',
              ExitCode.verification,
              { details: { retryAfterMs: 0 } },
            );
          },
          automaticRetry: {
            enabled: true,
            now,
            dispatcher(_cwd, invocationId) {
              gatedInvocationId = invocationId;
              throw workflowError(
                'AGENT_RUNTIME_GRANT_REQUIRED',
                'The replacement requires its own exact role-assignment Grant.',
                ExitCode.verification,
                { details: { invocationId } },
              );
            },
          },
          schedulePump: { enabled: false },
          retentionMaintenance() {
            retentionCalls++;
            assert.fail('retry Grant must skip retention');
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_GRANT_REQUIRED',
    );

    assert.equal(retentionCalls, 0);
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.runtime.locks,
          `${fixture.invocationId}.worker-active`,
        ),
      ),
      false,
    );
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    assert.equal(gatedInvocationId, schedule.replacementInvocationId);
    assert.equal(schedule.state, 'scheduled');
    assert.equal(
      readProviderInvocation(fixture.runtime, fixture.invocationId).state,
      'failed',
    );
    assert.equal(
      readProviderInvocation(fixture.runtime, schedule.replacementInvocationId)
        .state,
      'prepared',
    );
    assert.equal(
      listProviderRetryScheduleReceipts(
        fixture.repository,
        schedule.scheduleId,
      )[0]?.state,
      'started',
    );
    assert.deepEqual(
      listProviderWorkerMaintenanceWarnings(
        observeInvestigationRuntimeContext(fixture.repository).runtime,
      ),
      [],
    );

    const dispatched: string[] = [];
    pumpProviderRetrySchedules(fixture.repository, {
      limit: 1,
      now,
      dispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.deepEqual(dispatched, [schedule.replacementInvocationId]);
    assert.equal(
      requiredSchedule(fixture.repository, fixture.invocationId).state,
      'dispatch-issued',
    );
    assert.equal(
      listProviderRetryScheduleReceipts(
        fixture.repository,
        schedule.scheduleId,
      )[0]?.state,
      'dispatch-issued',
    );
  } finally {
    fixture.dispose();
  }
});

test('terminal schedule pump Grant skips retention and releases the original worker fence', () => {
  const fixture = startWorkerFixture('worker-pump-role-grant');
  try {
    const grant = workflowError(
      'AGENT_RUNTIME_GRANT_REQUIRED',
      'The due replacement requires its exact role Grant.',
      ExitCode.verification,
    );
    const fencePath = path.join(
      fixture.runtime.locks,
      `${fixture.invocationId}.worker-active`,
    );
    const dispatched: string[] = [];
    let fenceDuringPump: boolean | undefined;
    let retentionCalls = 0;
    assert.throws(
      () =>
        runProviderWorker(fixture.repository, fixture.invocationId, {
          runner() {
            throw workflowError(
              'PROVIDER_RATE_LIMIT',
              'Retry after one second.',
              ExitCode.verification,
              { details: { retryAfterMs: 1_000 } },
            );
          },
          automaticRetry: {
            enabled: true,
            get now() {
              return readProviderInvocation(
                fixture.runtime,
                fixture.invocationId,
              ).updatedAt;
            },
            dispatcher() {
              assert.fail('retry must leave future work for the pump');
            },
          },
          schedulePump: {
            enabled: true,
            limit: 1,
            get now() {
              return requiredSchedule(fixture.repository, fixture.invocationId)
                .notBefore;
            },
            dispatcher(_cwd, invocationId) {
              dispatched.push(invocationId);
              fenceDuringPump = fs.existsSync(fencePath);
              throw grant;
            },
          },
          retentionMaintenance() {
            retentionCalls++;
            assert.fail('pump Grant must skip retention');
          },
        }),
      (error) => error === grant,
    );
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    assert.deepEqual(dispatched, [schedule.replacementInvocationId]);
    assert.equal(fenceDuringPump, true);
    assert.equal(retentionCalls, 0);
    assert.equal(fs.existsSync(fencePath), false);
    const terminal = readProviderInvocation(
      fixture.runtime,
      fixture.invocationId,
    );
    assert.equal(terminal.state, 'failed');
    assert.equal(terminal.failure?.code, 'PROVIDER_RATE_LIMIT');
    assert.equal(
      readProviderInvocation(fixture.runtime, schedule.replacementInvocationId)
        .state,
      'prepared',
    );
    assert.equal(schedule.state, 'scheduled');
    assert.equal(
      listProviderRetryScheduleReceipts(
        fixture.repository,
        schedule.scheduleId,
      )[0]?.state,
      'started',
    );
    assert.deepEqual(
      listProviderWorkerMaintenanceWarnings(fixture.runtime),
      [],
    );
  } finally {
    fixture.dispose();
  }
});

test('production provider timeout creates one automatic replacement in the same Job, context, and epoch', () => {
  const fixture = startWorkerFixture('worker-auto-provider-timeout');
  try {
    const dispatched: string[] = [];
    const original = readProviderInvocation(
      fixture.runtime,
      fixture.invocationId,
    );
    const originalRequest = readProviderInvocationRequest(
      fixture.runtime,
      fixture.invocationId,
    );
    const originalProjection = projectProviderInvocationExecution({
      record: original,
      request: originalRequest,
    });

    runProviderWorker(fixture.repository, fixture.invocationId, {
      runner() {
        throw workflowError(
          'PROVIDER_TIMEOUT',
          'The production provider exceeded its bounded timeout.',
          ExitCode.verification,
        );
      },
      automaticRetry: {
        enabled: true,
        dispatcher(_cwd, invocationId) {
          dispatched.push(invocationId);
        },
      },
    });

    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    assert.equal(schedule.route, 'provider-replacement');
    assert.equal(schedule.state, 'dispatch-issued');
    assert.deepEqual(dispatched, [schedule.replacementInvocationId]);
    const replacement = readProviderInvocation(
      fixture.runtime,
      schedule.replacementInvocationId,
    );
    const replacementRequest = readProviderInvocationRequest(
      fixture.runtime,
      replacement.invocationId,
    );
    const replacementProjection = projectProviderInvocationExecution({
      record: replacement,
      request: replacementRequest,
    });
    assert.equal(replacementProjection.job.jobId, originalProjection.job.jobId);
    assert.equal(
      replacementProjection.workflow.workflowId,
      originalProjection.workflow.workflowId,
    );
    assert.equal(replacementProjection.job.epoch, originalProjection.job.epoch);
    assert.equal(
      replacementProjection.job.contextDigest,
      originalProjection.job.contextDigest,
    );
    const state = readExecutionJobState(
      fixture.runtime,
      originalProjection.job.jobId,
    );
    assert.ok(state);
    assert.equal(state.workflow.status, 'active');
    assert.equal(state.workflow.currentEpoch, originalProjection.job.epoch);
    assert.equal(state.job.jobId, originalProjection.job.jobId);
    assert.equal(state.job.contextDigest, originalProjection.job.contextDigest);
    assert.equal(state.attempts.length, 2);
    assert.equal(state.attempts[1]?.retryOf, state.attempts[0]?.attemptId);
  } finally {
    fixture.dispose();
  }
});

for (const failure of [
  { code: 'NETWORK_TRANSIENT', executionKind: 'network' },
  {
    code: 'PROVIDER_PROCESS_CRASH',
    executionKind: 'provider-process-crash',
  },
] as const) {
  test(`worker routes ${failure.executionKind} through an immediate bounded replacement`, () => {
    const fixture = startWorkerFixture(`worker-auto-${failure.executionKind}`);
    try {
      const dispatched: string[] = [];
      runProviderWorker(fixture.repository, fixture.invocationId, {
        runner() {
          throw workflowError(
            failure.code,
            `${failure.executionKind} fixture failure.`,
            ExitCode.verification,
          );
        },
        automaticRetry: {
          enabled: true,
          dispatcher(_cwd, invocationId) {
            dispatched.push(invocationId);
          },
        },
      });

      const failed = readProviderInvocation(
        fixture.runtime,
        fixture.invocationId,
      );
      assert.equal(failed.failure?.executionKind, failure.executionKind);
      const schedule = requiredSchedule(
        fixture.repository,
        fixture.invocationId,
      );
      assert.equal(schedule.route, 'provider-replacement');
      assert.equal(schedule.state, 'dispatch-issued');
      assert.deepEqual(dispatched, [schedule.replacementInvocationId]);
      assertCheapLineage(fixture, schedule);
    } finally {
      fixture.dispose();
    }
  });
}

test('worker routes native schema failure through a repair Attempt with structured context', () => {
  const fixture = startWorkerFixture('worker-auto-schema-repair');
  try {
    const dispatched: string[] = [];
    runProviderWorker(fixture.repository, fixture.invocationId, {
      runner() {
        throw workflowError(
          'PROVIDER_NATIVE_OUTPUT_INVALID',
          'Provider output failed its schema.',
          ExitCode.verification,
          {
            details: {
              repair: {
                repairKind: 'schema',
                previousOutput: { reference: fixture.invocationId },
                validationErrors: [
                  {
                    path: '/terms',
                    code: 'OUTPUT_REQUIRED_FIELD_MISSING',
                    message: 'The terms field is required.',
                  },
                ],
              },
            },
          },
        );
      },
      automaticRetry: {
        enabled: true,
        dispatcher(_cwd, invocationId) {
          dispatched.push(invocationId);
        },
      },
    });

    const failed = readProviderInvocation(
      fixture.runtime,
      fixture.invocationId,
    );
    assert.equal(failed.failure?.executionKind, 'schema-mismatch');
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    assert.equal(schedule.retryMode, 'repair');
    assert.deepEqual(dispatched, [schedule.replacementInvocationId]);
    const state = readExecutionJobState(
      fixture.runtime,
      schedule.executionJobId,
    );
    assert.ok(state);
    assert.equal(state.attempts[1]?.retryMode, 'repair');
    assert.ok(state.attempts[1]?.repairContext);
  } finally {
    fixture.dispose();
  }
});

test('environment probe failure schedules only the probe and never republishes provider work', () => {
  const fixture = startWorkerFixture('worker-auto-environment-probe');
  try {
    const dispatched: string[] = [];
    const probe = {
      kind: 'file-read' as const,
      target:
        'packages/workflow-engine/src/entrypoints/worker/provider-worker.ts',
      timeoutMs: 1_000,
    };
    runProviderWorker(fixture.repository, fixture.invocationId, {
      runner() {
        throw workflowError(
          'ENVIRONMENT_PROBE_TRANSIENT',
          'A read-only dependency probe was temporarily unavailable.',
          ExitCode.verification,
          { details: { retryAfterMs: 1_000, probe } },
        );
      },
      automaticRetry: {
        enabled: true,
        dispatcher(_cwd, invocationId) {
          dispatched.push(invocationId);
        },
      },
    });

    const failed = readProviderInvocation(
      fixture.runtime,
      fixture.invocationId,
    );
    assert.equal(failed.failure?.executionKind, 'probe-transient');
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    assert.equal(schedule.route, 'environment-probe');
    assert.equal(schedule.replacementInvocationId, null);
    assert.equal(schedule.state, 'scheduled');
    assert.deepEqual(schedule.probe, probe);
    assert.equal(schedule.probeAttemptsCompleted, 0);
    assert.equal(schedule.probeMaxAttempts, 3);
    assert.deepEqual(dispatched, []);
    const state = readExecutionJobState(
      fixture.runtime,
      schedule.executionJobId,
    );
    assert.ok(state);
    assert.equal(state.attempts.length, 1);
  } finally {
    fixture.dispose();
  }
});

test('due probe-only sweep succeeds durably without creating provider work or mutating execution state', () => {
  const fixture = startProbeScheduleFixture('worker-probe-pump-success');
  try {
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    const stateBefore = canonicalJson(
      readExecutionJobState(fixture.runtime, schedule.executionJobId),
    );
    const invocationsBefore = invocationEntries(fixture.runtime.invocations);
    const observed: unknown[] = [];
    const now = new Date(Date.parse(schedule.notBefore) + 1).toISOString();

    const swept = pumpProviderRetrySchedules(fixture.repository, {
      limit: 10,
      now,
      probeExecutor(_cwd, request) {
        observed.push(request);
        return {
          state: 'succeeded',
          code: 'PROVIDER_PROBE_SUCCEEDED',
          observationDigest: digestValue('probe-success'),
          elapsedMs: 1,
        };
      },
      dispatcher() {
        assert.fail('A probe-only schedule must never dispatch provider work.');
      },
    });

    assert.equal(swept.processed, 1);
    assert.deepEqual(observed, [schedule.probe]);
    const completed = requiredSchedule(
      fixture.repository,
      fixture.invocationId,
    );
    assert.equal(completed.state, 'probe-succeeded');
    assert.equal(completed.probeAttemptsCompleted, 1);
    assert.equal(completed.nextAction, 'none');
    assert.ok(completed.completedAt);
    const receipts = listProviderRetryScheduleReceipts(
      fixture.repository,
      schedule.scheduleId,
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.state, 'probe-succeeded');
    assert.equal(receipts[0]?.attemptNumber, 1);
    assert.equal(receipts[0]?.observationDigest, digestValue('probe-success'));
    assert.equal(
      canonicalJson(
        readExecutionJobState(fixture.runtime, schedule.executionJobId),
      ),
      stateBefore,
    );
    assert.deepEqual(
      invocationEntries(fixture.runtime.invocations),
      invocationsBefore,
    );

    pumpProviderRetrySchedules(fixture.repository, {
      limit: 10,
      now,
      probeExecutor(_cwd, request) {
        observed.push(request);
        return {
          state: 'succeeded',
          code: 'PROVIDER_PROBE_SUCCEEDED',
          observationDigest: digestValue('unexpected-replay'),
          elapsedMs: 1,
        };
      },
    });
    assert.equal(observed.length, 1);
  } finally {
    fixture.dispose();
  }
});

test('production probe executor performs the exact persisted read-only request', () => {
  const fixture = startProbeScheduleFixture('worker-probe-production-executor');
  try {
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    const before = invocationEntries(fixture.runtime.invocations);
    pumpProviderRetrySchedules(fixture.repository, {
      limit: 1,
      now: new Date(Date.parse(schedule.notBefore) + 1).toISOString(),
      dispatcher() {
        assert.fail(
          'The production probe executor cannot dispatch a provider.',
        );
      },
    });

    const completed = requiredSchedule(
      fixture.repository,
      fixture.invocationId,
    );
    assert.equal(completed.state, 'probe-succeeded');
    assert.deepEqual(invocationEntries(fixture.runtime.invocations), before);
    const receipt = listProviderRetryScheduleReceipts(
      fixture.repository,
      schedule.scheduleId,
    )[0];
    assert.equal(receipt?.outcomeCode, 'PROVIDER_PROBE_SUCCEEDED');
    assert.deepEqual(receipt?.probe, schedule.probe);
  } finally {
    fixture.dispose();
  }
});

test('ordinary terminal worker entry triggers one bounded retry schedule sweep', () => {
  const fixture = startProbeScheduleFixture('worker-probe-entry-pump');
  try {
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    runProviderWorker(fixture.repository, fixture.invocationId, {
      automaticRetry: { enabled: false },
      schedulePump: {
        enabled: true,
        limit: 1,
        now: new Date(Date.parse(schedule.notBefore) + 1).toISOString(),
        probeExecutor() {
          return {
            state: 'succeeded',
            code: 'PROVIDER_PROBE_SUCCEEDED',
            observationDigest: digestValue('worker-entry-pump'),
            elapsedMs: 1,
          };
        },
      },
    });
    assert.equal(
      requiredSchedule(fixture.repository, fixture.invocationId).state,
      'probe-succeeded',
    );
  } finally {
    fixture.dispose();
  }
});

test('probe timeout is independent from provider timeout and consumes one bounded probe attempt', () => {
  const fixture = startProbeScheduleFixture('worker-probe-independent-timeout');
  try {
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    pumpProviderRetrySchedules(fixture.repository, {
      limit: 1,
      now: new Date(Date.parse(schedule.notBefore) + 1).toISOString(),
      probeExecutor() {
        return {
          state: 'succeeded',
          code: 'PROVIDER_PROBE_SUCCEEDED',
          observationDigest: digestValue('late-probe-result'),
          elapsedMs: schedule.probe!.timeoutMs + 1,
        };
      },
    });
    const retried = requiredSchedule(fixture.repository, fixture.invocationId);
    assert.equal(retried.state, 'scheduled');
    assert.equal(retried.probeAttemptsCompleted, 1);
    assert.equal(
      listProviderRetryScheduleReceipts(
        fixture.repository,
        schedule.scheduleId,
      )[0]?.outcomeCode,
      'PROVIDER_PROBE_TIMEOUT',
    );
  } finally {
    fixture.dispose();
  }
});

test('unallowlisted environment probe is durably denied without a schedule', () => {
  const fixture = startWorkerFixture('worker-probe-unallowlisted');
  try {
    runProviderWorker(fixture.repository, fixture.invocationId, {
      runner() {
        throw workflowError(
          'ENVIRONMENT_PROBE_TRANSIENT',
          'The fixture attempted an unallowlisted command probe.',
          ExitCode.verification,
          {
            details: {
              probe: {
                kind: 'run-command',
                target: 'touch forbidden',
                timeoutMs: 1_000,
              },
            },
          },
        );
      },
      automaticRetry: { enabled: true },
    });
    const failed = readProviderInvocation(
      fixture.runtime,
      fixture.invocationId,
    );
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.executionKind, undefined);
    assert.equal(failed.failure?.probe, undefined);
    assert.equal(
      readProviderAutomaticRetrySchedule(
        fixture.repository,
        fixture.invocationId,
      ),
      null,
    );
  } finally {
    fixture.dispose();
  }
});

test('probe-only sweep applies bounded backoff then exposes a terminal next action', () => {
  const fixture = startProbeScheduleFixture('worker-probe-pump-exhausted');
  try {
    let schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    const observedAt: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const now = new Date(Date.parse(schedule.notBefore) + 1).toISOString();
      observedAt.push(now);
      pumpProviderRetrySchedules(fixture.repository, {
        limit: 1,
        now,
        probeExecutor() {
          return {
            state: 'failed',
            code: 'PROVIDER_PROBE_DEPENDENCY_UNAVAILABLE',
            observationDigest: digestValue(`probe-failure-${attempt}`),
            elapsedMs: 1,
          };
        },
      });
      schedule = requiredSchedule(fixture.repository, fixture.invocationId);
      assert.equal(schedule.probeAttemptsCompleted, attempt);
      if (attempt < 3) {
        assert.equal(schedule.state, 'scheduled');
        assert.equal(schedule.nextAction, 'wait-until-due');
        assert.ok(Date.parse(schedule.notBefore) > Date.parse(now));
        const beforeDueCalls = observedAt.length;
        pumpProviderRetrySchedules(fixture.repository, {
          limit: 1,
          now,
          probeExecutor() {
            observedAt.push('unexpected-before-due');
            return {
              state: 'failed',
              code: 'PROVIDER_PROBE_DEPENDENCY_UNAVAILABLE',
              observationDigest: digestValue('unexpected-before-due'),
              elapsedMs: 1,
            };
          },
        });
        assert.equal(observedAt.length, beforeDueCalls);
      }
    }

    assert.equal(schedule.state, 'probe-failed-terminal');
    assert.equal(
      schedule.nextAction,
      'inspect-environment-before-new-provider-attempt',
    );
    assert.ok(schedule.completedAt);
    assert.deepEqual(
      listProviderRetryScheduleReceipts(
        fixture.repository,
        schedule.scheduleId,
      ).map(({ attemptNumber, state }) => ({ attemptNumber, state })),
      [
        { attemptNumber: 1, state: 'probe-retry-scheduled' },
        { attemptNumber: 2, state: 'probe-retry-scheduled' },
        { attemptNumber: 3, state: 'probe-failed-terminal' },
      ],
    );

    pumpProviderRetrySchedules(fixture.repository, {
      limit: 10,
      now: new Date(Date.parse(observedAt.at(-1)!) + 60_000).toISOString(),
      probeExecutor() {
        assert.fail('An exhausted probe schedule must be terminal.');
      },
    });
  } finally {
    fixture.dispose();
  }
});

test('probe crash replay resumes the same durable attempt without double-accounting', () => {
  const fixture = startProbeScheduleFixture('worker-probe-pump-crash-replay');
  try {
    const schedule = requiredSchedule(fixture.repository, fixture.invocationId);
    const now = new Date(Date.parse(schedule.notBefore) + 1).toISOString();
    let executions = 0;
    assert.throws(
      () =>
        pumpProviderRetrySchedules(fixture.repository, {
          limit: 1,
          now,
          probeExecutor() {
            executions += 1;
            return {
              state: 'succeeded',
              code: 'PROVIDER_PROBE_SUCCEEDED',
              observationDigest: digestValue('crash-replay'),
              elapsedMs: 1,
            };
          },
          faultInjector(point) {
            if (point === 'after-probe-execution') {
              throw new Error('simulated crash after read-only probe');
            }
          },
        }),
      /simulated crash/,
    );
    assert.equal(
      requiredSchedule(fixture.repository, fixture.invocationId)
        .probeAttemptsCompleted,
      0,
    );
    assert.deepEqual(
      listProviderRetryScheduleReceipts(
        fixture.repository,
        schedule.scheduleId,
      ).map(({ attemptNumber, state }) => ({ attemptNumber, state })),
      [{ attemptNumber: 1, state: 'started' }],
    );

    pumpProviderRetrySchedules(fixture.repository, {
      limit: 1,
      now,
      probeExecutor() {
        executions += 1;
        return {
          state: 'succeeded',
          code: 'PROVIDER_PROBE_SUCCEEDED',
          observationDigest: digestValue('crash-replay'),
          elapsedMs: 1,
        };
      },
    });
    assert.equal(executions, 2);
    const completed = requiredSchedule(
      fixture.repository,
      fixture.invocationId,
    );
    assert.equal(completed.state, 'probe-succeeded');
    assert.equal(completed.probeAttemptsCompleted, 1);
    assert.equal(
      listProviderRetryScheduleReceipts(fixture.repository, schedule.scheduleId)
        .length,
      1,
    );
  } finally {
    fixture.dispose();
  }
});

test('exhausted automatic budget exposes a scoped GrantRequest and executes nothing', () => {
  const repository = createFixtureRepository();
  const changeId = 'worker-auto-grant-required';
  let mandate: ReturnType<typeof prepareExecutionMandate> | undefined;
  try {
    constrainRetryBudgetToOneAttempt(repository);
    git(repository, ['add', 'workflow/ai-adapter-policy.json']);
    git(repository, ['commit', '-m', 'Constrain automatic retries']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    mandate = prepareExecutionMandate(repository, changeId);
    const started = startPropose(repository, changeId, intent(), {
      explicitActor: 'codex',
      environment: {},
      taskMandateId: mandate.taskId,
      taskMandateValidation: { signer: mandate.signer },
    });
    const invocationId = started.investigation!.providerInvocationId;
    const runtime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    const original = readProviderInvocation(runtime, invocationId);
    const jobId = projectProviderInvocationExecution({
      record: original,
      request,
    }).job.jobId;
    assert.ok(original.mandateBinding);
    assert.deepEqual(original.mandateBinding, mandate.binding);
    assert.equal(original.state, 'prepared');
    const fencePath = path.join(runtime.locks, `${invocationId}.worker-active`);
    const auditScope = {
      repositoryRoot: fs.realpathSync(repository),
      repositoryId: deriveAuthorityAuditRepositoryId(
        mandate.repositoryIdentity,
      ),
      externalAuditRoot: mandate.externalAuditRoot,
    };
    const taskId = mandate.taskId;
    const atExecution: Array<{
      record: ReturnType<typeof readProviderInvocation>;
      fencePresent: boolean;
      audit: ReturnType<typeof showAuthorityAuditTask>;
    }> = [];
    let runnerCalls = 0;
    const dispatched: string[] = [];

    const result = runProviderWorker(repository, invocationId, {
      runner() {
        runnerCalls += 1;
        atExecution.push({
          record: readProviderInvocation(runtime, invocationId),
          fencePresent: fs.existsSync(fencePath),
          audit: showAuthorityAuditTask(auditScope, taskId),
        });
        throw workflowError(
          'NETWORK_TRANSIENT',
          'Network is temporarily unavailable.',
          ExitCode.verification,
        );
      },
      automaticRetry: {
        enabled: true,
        dispatcher(_cwd, replacementInvocationId) {
          dispatched.push(replacementInvocationId);
        },
      },
    });

    // Assertions stay outside the runner: worker failure handling must not
    // turn a failed assertion into the controlled network failure below.
    assert.equal(atExecution.length, 1, canonicalJson({ runnerCalls, result }));
    assert.equal(runnerCalls, 1);
    const executed = atExecution[0]!;
    assert.equal(executed.record.state, 'leased');
    assert.ok(executed.record.lease);
    assert.deepEqual(executed.record.mandateBinding, mandate.binding);
    assert.equal(executed.fencePresent, true);
    assert.equal(executed.audit.ok, true);
    const invocationEvents = executed.audit.events.filter(
      ({ event }) =>
        event.eventType === 'provider-invocation' &&
        event.providerInvocation?.invocationId === invocationId,
    );
    assert.equal(invocationEvents.length, 1);
    const invocationEvent = invocationEvents[0]!.event;
    assert.equal(invocationEvent.taskId, mandate.taskId);
    assert.equal(invocationEvent.changeId, changeId);
    assert.equal(
      invocationEvent.grantDigest,
      `sha256:${mandate.binding.mandateDigest}`,
    );
    assert.equal(invocationEvent.occurredAt, original.createdAt);
    assert.deepEqual(invocationEvent.providerInvocation, {
      providerId: request.providerId,
      invocationId,
      requestDigest: `sha256:${request.requestDigest}`,
    });
    assert.equal(result.state, 'failed');
    const failed = readProviderInvocation(runtime, invocationId);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure?.code, 'NETWORK_TRANSIENT');
    assert.deepEqual(failed.mandateBinding, mandate.binding);
    assert.equal(fs.existsSync(fencePath), false);

    assert.equal(
      readProviderAutomaticRetrySchedule(repository, invocationId),
      null,
    );
    assert.deepEqual(dispatched, []);
    const inspection = inspectExecutionJob(repository, jobId);
    const grant = inspection.latestFailure?.decision.requiredGrant;
    assert.ok(grant);
    assert.equal(grant.workflowId, inspection.workflow.workflowId);
    assert.equal(grant.epoch, inspection.job.epoch);
    assert.equal(grant.jobId, inspection.job.jobId);
    assert.equal(
      canonicalJson(grant.mandateBinding),
      canonicalJson(mandate.binding),
    );
    assert.equal(readExecutionJobState(runtime, jobId)?.attempts.length, 1);
  } finally {
    mandate?.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('terminal retention failure is journaled without overwriting the durable outcome', () => {
  const fixture = startWorkerFixture('worker-retention-warning');
  try {
    const completed = runProviderWorker(
      fixture.repository,
      fixture.invocationId,
      {
        runner() {
          return successfulWorkerReport(fixture);
        },
        retentionMaintenance() {
          throw workflowError(
            'RETENTION_FIXTURE_FAILURE',
            'The bounded maintenance fixture failed.',
            ExitCode.verification,
          );
        },
      },
    );
    assert.equal(
      completed.state,
      'succeeded',
      canonicalJson(completed.failure),
    );
    assert.equal(
      readProviderInvocation(fixture.runtime, fixture.invocationId).state,
      'succeeded',
    );
    const warnings = listProviderWorkerMaintenanceWarnings(
      observeInvestigationRuntimeContext(fixture.repository).runtime,
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.operation, 'retention-maintenance');
    assert.equal(warnings[0]?.errorCode, 'RETENTION_FIXTURE_FAILURE');
    assert.equal(warnings[0]?.invocationId, fixture.invocationId);
    assert.equal(warnings[0]?.terminalState, 'succeeded');

    runProviderWorker(fixture.repository, fixture.invocationId, {
      retentionMaintenance() {
        throw workflowError(
          'RETENTION_FIXTURE_FAILURE',
          'The bounded maintenance fixture failed.',
          ExitCode.verification,
        );
      },
    });
    assert.equal(
      listProviderWorkerMaintenanceWarnings(
        observeInvestigationRuntimeContext(fixture.repository).runtime,
      ).length,
      1,
    );
  } finally {
    fixture.dispose();
  }
});

function startWorkerFixture(changeId: string) {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const started = startPropose(repository, changeId, intent(), {
    explicitActor: 'codex',
    environment: {},
  });
  const invocationId = started.investigation!.providerInvocationId;
  const runtime = investigationRuntimePaths(
    discoverRepository(repository).gitCommonDirectory,
    'workflow-engine',
  );
  return {
    repository,
    invocationId,
    runtime,
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function startProbeScheduleFixture(changeId: string) {
  const fixture = startWorkerFixture(changeId);
  runProviderWorker(fixture.repository, fixture.invocationId, {
    runner() {
      throw workflowError(
        'ENVIRONMENT_PROBE_TRANSIENT',
        'A read-only repository probe was temporarily unavailable.',
        ExitCode.verification,
        {
          details: {
            retryAfterMs: 1_000,
            probe: {
              kind: 'file-read',
              target:
                'packages/workflow-engine/src/entrypoints/worker/provider-worker.ts',
              timeoutMs: 5_000,
            },
          },
        },
      );
    },
    automaticRetry: { enabled: true },
  });
  return fixture;
}

function invocationEntries(invocations: string): string[] {
  return fs
    .readdirSync(invocations, { withFileTypes: true })
    .map(
      (entry) => `${entry.isDirectory() ? 'directory' : 'file'}:${entry.name}`,
    )
    .sort();
}

function digestValue(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function requiredSchedule(
  repository: string,
  invocationId: string,
): ProviderAutomaticRetrySchedule & { replacementInvocationId: string } {
  const schedule = readProviderAutomaticRetrySchedule(repository, invocationId);
  assert.ok(
    schedule,
    canonicalJson(
      listProviderWorkerMaintenanceWarnings(
        observeInvestigationRuntimeContext(repository).runtime,
      ),
    ),
  );
  if (
    schedule.route === 'provider-replacement' &&
    schedule.replacementInvocationId !== null
  ) {
    return schedule as ProviderAutomaticRetrySchedule & {
      replacementInvocationId: string;
    };
  }
  if (schedule.route === 'environment-probe') {
    return schedule as ProviderAutomaticRetrySchedule & {
      replacementInvocationId: string;
    };
  }
  assert.fail('Expected a provider retry schedule.');
}

function assertCheapLineage(
  fixture: ReturnType<typeof startWorkerFixture>,
  schedule: ProviderAutomaticRetrySchedule,
): void {
  const state = readExecutionJobState(fixture.runtime, schedule.executionJobId);
  assert.ok(state);
  assert.equal(state.job.jobId, schedule.executionJobId);
  assert.equal(state.workflow.workflowId, schedule.workflowId);
  assert.equal(state.workflow.currentEpoch, schedule.epoch);
  assert.equal(state.workflow.contextDigest, schedule.contextDigest);
  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[1]?.retryOf, state.attempts[0]?.attemptId);
  assert.equal(state.attempts[1]?.retryMode, 'same-input');
}

function intent() {
  return {
    schemaVersion: 1 as const,
    summary: 'Exercise production automatic provider retry routing.',
    sourceRefs: [],
    explicitPaths: [
      'packages/workflow-engine/src/entrypoints/worker/provider-worker.ts',
    ],
    explicitSymbols: ['runProviderWorker'],
    explicitConfigKeys: [],
    renamePairs: [],
  };
}

function constrainRetryBudgetToOneAttempt(repository: string): void {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.retryAccounting.maxAttempts = 1;
  policy.retryAccounting.maxRepairAttempts = 1;
  policy.retryAccounting.maxCumulativeRuntimeMs = policy.limits.timeoutMs;
  policy.retryAccounting.maxProviderCostMicros =
    policy.retryAccounting.reservations.codex.providerCostMicros;
  policy.retryAccounting.maxProviderTokens =
    policy.retryAccounting.reservations.codex.providerTokens;
  policy.retryAccounting.providerLimits.codex = 1;
  policy.retryAccounting.providerLimits.claude = 1;
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
}

function successfulWorkerReport(
  fixture: ReturnType<typeof startWorkerFixture>,
) {
  const request = readProviderInvocationRequest(
    fixture.runtime,
    fixture.invocationId,
  );
  const semanticOutput = {
    reference: fixture.invocationId,
    terms: [{ kind: 'symbol', value: 'runProviderWorker' }],
  };
  return {
    invocationId: fixture.invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(semanticOutput))
      .digest('hex'),
    assurance: 'unchanged-governed-projection' as const,
    projection: {
      unchanged: true as const,
      changedCategories: [],
      beforeDigest: 'b'.repeat(64),
      afterDigest: 'b'.repeat(64),
    },
    sameUserProcessConfined: false as const,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: builtInProviderExecutableIdentityForTest(request.providerId),
    elapsedMs: 1,
    providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
      request.providerId,
    ),
  };
}
