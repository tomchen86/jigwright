// engine metrics computation; repository effects remain bound by the public module.
import type {
  EngineMetricsComputationBindings,
  EngineMetricsComputationBindingsTypes,
} from './engine-metrics.ts';
type ExecutionJobInspection =
  EngineMetricsComputationBindingsTypes['ExecutionJobInspection'];
type ProviderRetentionMetrics =
  EngineMetricsComputationBindingsTypes['ProviderRetentionMetrics'];
type EngineGovernanceMetricsSource =
  EngineMetricsComputationBindingsTypes['EngineGovernanceMetricsSource'];
type EngineMetricsSnapshot =
  EngineMetricsComputationBindingsTypes['EngineMetricsSnapshot'];
type WorkflowRecord = EngineMetricsComputationBindingsTypes['WorkflowRecord'];
type Rate = EngineMetricsComputationBindingsTypes['Rate'];

export function createEngineMetricsComputation(
  bindings: () => EngineMetricsComputationBindings,
) {
  function computeEngineMetrics(
    inspections: readonly ExecutionJobInspection[],
    storage: ProviderRetentionMetrics,
    generatedAt: string,
    governanceSource: EngineGovernanceMetricsSource,
  ): EngineMetricsSnapshot {
    const boundServices: EngineMetricsComputationBindings = bindings();
    const {
      metricsInvalid,
      FAILURE_STATUSES,
      RATE_TERMINAL_STATUSES,
      deepFreeze,
    } = boundServices;

    const now = exactTimestamp(generatedAt);
    if (storage.measuredAt !== now) {
      throw metricsInvalid(
        'Execution and retention metrics must share one exact observation time.',
      );
    }
    const jobs = [...inspections].sort((left, right) =>
      left.job.jobId.localeCompare(right.job.jobId),
    );
    if (new Set(jobs.map(({ job }) => job.jobId)).size !== jobs.length) {
      throw metricsInvalid(
        'Execution metrics contain duplicate Job identities.',
      );
    }
    const workflows = uniqueWorkflows(jobs);
    const failures = jobs.flatMap(({ job, attempts }) =>
      attempts
        .filter((attempt) => FAILURE_STATUSES.has(attempt.status))
        .map((attempt) => ({ job, attempts, attempt })),
    );
    const recoveredFailures = failures.filter(({ job, attempts, attempt }) => {
      const accepted = attempts.find(
        ({ attemptId }) => attemptId === job.acceptedAttemptId,
      );
      return (
        accepted !== undefined && accepted.attemptNumber > attempt.attemptNumber
      );
    });
    const automaticRetries = jobs.flatMap(({ job, attempts }) =>
      attempts
        .filter(
          (attempt) =>
            attempt.grantId === null &&
            [
              'same-input',
              'execution-policy-change',
              'strategy-change',
            ].includes(attempt.retryMode) &&
            RATE_TERMINAL_STATUSES.has(attempt.status),
        )
        .map((attempt) => ({ job, attempt })),
    );
    const repairRetries = jobs.flatMap(({ job, attempts }) =>
      attempts
        .filter(
          (attempt) =>
            attempt.retryMode === 'repair' &&
            RATE_TERMINAL_STATUSES.has(attempt.status),
        )
        .map((attempt) => ({ job, attempt })),
    );
    const failureToNext = failures.flatMap(({ attempts, attempt }) => {
      const next = attempts
        .filter(({ attemptNumber }) => attemptNumber > attempt.attemptNumber)
        .sort((left, right) => left.attemptNumber - right.attemptNumber)[0];
      return next === undefined
        ? []
        : [duration(attempt.updatedAt, next.createdAt)];
    });
    const failureToRecovery = recoveredFailures.map(
      ({ job, attempts, attempt }) => {
        const accepted = attempts.find(
          ({ attemptId }) => attemptId === job.acceptedAttemptId,
        )!;
        return duration(attempt.updatedAt, accepted.updatedAt);
      },
    );
    const recoverableFailures = failures.filter(
      ({ attempt }) => attempt.failure?.retryClass !== 'terminal',
    );
    const governance = normalizeGovernanceSource(jobs, governanceSource);
    const requestIds = new Set<string>(governance.grantRequestDigests);
    let directRefusalCount = 0;
    for (const inspection of jobs) {
      const latest = inspection.latestFailure;
      if (
        latest !== null &&
        latest.failure.retryClass !== 'terminal' &&
        latest.decision.retryable === false &&
        latest.decision.requiredGrant === undefined
      ) {
        directRefusalCount += 1;
      }
    }
    const acceptedAttemptIds = new Set(
      jobs.flatMap(({ job }) =>
        job.acceptedAttemptId === null ? [] : [job.acceptedAttemptId],
      ),
    );
    const successfulGrantIds = new Set(
      governance.issuedGrants.flatMap((grant) =>
        grant.consumedAttemptIds.some((attemptId) =>
          acceptedAttemptIds.has(attemptId),
        )
          ? [grant.grantId]
          : [],
      ),
    );
    const recomputedRetries = jobs.flatMap(({ job, attempts }) =>
      attempts
        .filter((attempt) => attempt.retryOf !== null)
        .map((attempt) => {
          if (
            !attempts.some(({ attemptId }) => attemptId === attempt.retryOf)
          ) {
            throw metricsInvalid(
              'A replacement Attempt does not name a predecessor in its bound Job.',
            );
          }
          return { stage: job.stage };
        }),
    );
    const recomputedStageCount = recomputedRetries.reduce(
      (total, { stage }) => total + (stage.length > 0 ? 1 : 0),
      0,
    );
    const supersedeByReason: Record<string, number> = {};
    for (const workflow of workflows.values()) {
      if (workflow.status === 'superseded') {
        const reason = governance.supersedeReasons.find(
          (entry) => entry.workflowId === workflow.workflowId,
        )?.reason;
        if (reason === undefined) {
          throw metricsInvalid(
            'A superseded Workflow has no exact governance reason observation.',
          );
        }
        supersedeByReason[reason] = (supersedeByReason[reason] ?? 0) + 1;
      }
    }
    const snapshot: EngineMetricsSnapshot = {
      schemaVersion: 1,
      kind: 'engine-metrics-snapshot.v1',
      generatedAt: now,
      sample: {
        workflows: workflows.size,
        jobs: jobs.length,
        attempts: jobs.reduce(
          (total, inspection) => total + inspection.attempts.length,
          0,
        ),
      },
      metrics: {
        attempt_failure_recovered_rate: rate(
          recoveredFailures.length,
          failures.length,
        ),
        automatic_retry_success_rate: rate(
          automaticRetries.filter(
            ({ job, attempt }) => job.acceptedAttemptId === attempt.attemptId,
          ).length,
          automaticRetries.length,
        ),
        repair_retry_success_rate: rate(
          repairRetries.filter(
            ({ job, attempt }) => job.acceptedAttemptId === attempt.attemptId,
          ).length,
          repairRetries.length,
        ),
        late_output_rejected_count: jobs.reduce(
          (total, { attempts }) =>
            total +
            attempts.filter(({ status }) =>
              ['stale', 'late-duplicate'].includes(status),
            ).length,
          0,
        ),
        same_fingerprint_replay_count: sameFingerprintReplayCount(jobs),
        median_failure_to_next_attempt_ms: median(failureToNext),
        median_failure_to_recovery_ms: median(failureToRecovery),
        human_actions_per_recoverable_failure:
          recoverableFailures.length === 0
            ? null
            : governance.issuedGrants.length / recoverableFailures.length,
        stages_recomputed_per_retry:
          recomputedRetries.length === 0
            ? null
            : recomputedStageCount / recomputedRetries.length,
        workflow_blocked_hours: workflowBlockedHours(jobs, workflows, now),
        // WorkflowStatus has no suspended state, so this is a schema-enforced
        // invariant rather than an inferred zero from missing telemetry.
        suspended_created_count: 0,
        supersede_by_reason: supersedeByReason,
        direct_refusal_count: directRefusalCount,
        grant_request_count: requestIds.size,
        grant_to_success_rate: rate(
          successfulGrantIds.size,
          governance.issuedGrants.length,
        ),
        raw_evidence_bytes_by_retention_class: {
          ...storage.rawEvidenceBytesByRetentionClass,
        },
        expired_pending_deletion: { ...storage.expiredPendingDeletion },
        pinned_count: storage.pinnedCount,
        receipt_count: storage.receiptCount,
      },
    };
    return deepFreeze(snapshot);
  }

  function normalizeGovernanceSource(
    jobs: readonly ExecutionJobInspection[],
    source: EngineGovernanceMetricsSource,
  ): EngineGovernanceMetricsSource {
    const boundServices: EngineMetricsComputationBindings = bindings();
    const { isRecord, metricsInvalid, WORKFLOW_SUPERSEDE_REASONS, deepFreeze } =
      boundServices;

    if (
      !isRecord(source) ||
      !Array.isArray(source.grantRequestDigests) ||
      !Array.isArray(source.issuedGrants) ||
      !Array.isArray(source.supersedeReasons) ||
      source.grantRequestDigests.some(
        (requestDigest: unknown) =>
          typeof requestDigest !== 'string' || requestDigest.length === 0,
      )
    ) {
      throw metricsInvalid('Engine governance metrics source is malformed.');
    }
    const grantIds = new Set<string>();
    for (const grant of source.issuedGrants) {
      if (
        typeof grant?.grantId !== 'string' ||
        grant.grantId.length === 0 ||
        typeof grant.requestDigest !== 'string' ||
        grant.requestDigest.length === 0 ||
        !Array.isArray(grant.consumedAttemptIds) ||
        grant.consumedAttemptIds.some(
          (attemptId: unknown) =>
            typeof attemptId !== 'string' || attemptId.length === 0,
        ) ||
        new Set(grant.consumedAttemptIds).size !==
          grant.consumedAttemptIds.length ||
        grantIds.has(grant.grantId)
      ) {
        throw metricsInvalid('Engine governance metrics source is malformed.');
      }
      grantIds.add(grant.grantId);
    }
    const supersededWorkflowIds = new Set(
      [...uniqueWorkflows(jobs).values()]
        .filter(({ status }) => status === 'superseded')
        .map(({ workflowId }) => workflowId),
    );
    const reasonWorkflowIds = new Set<string>();
    for (const entry of source.supersedeReasons) {
      if (
        typeof entry?.workflowId !== 'string' ||
        entry.workflowId.length === 0 ||
        !WORKFLOW_SUPERSEDE_REASONS.includes(entry.reason) ||
        !supersededWorkflowIds.has(entry.workflowId) ||
        reasonWorkflowIds.has(entry.workflowId)
      ) {
        throw metricsInvalid('Engine governance metrics source is malformed.');
      }
      reasonWorkflowIds.add(entry.workflowId);
    }
    if (
      reasonWorkflowIds.size !== supersededWorkflowIds.size ||
      [...supersededWorkflowIds].some(
        (workflowId) => !reasonWorkflowIds.has(workflowId),
      )
    ) {
      throw metricsInvalid('Engine governance metrics source is malformed.');
    }
    const requestDigests = new Set(source.grantRequestDigests);
    if (
      source.issuedGrants.some(
        ({ requestDigest }) => !requestDigests.has(requestDigest),
      )
    ) {
      throw metricsInvalid('Engine governance metrics source is malformed.');
    }
    return deepFreeze({
      grantRequestDigests: [...new Set(source.grantRequestDigests)].sort(),
      issuedGrants: source.issuedGrants
        .map((grant) => ({
          grantId: grant.grantId,
          requestDigest: grant.requestDigest,
          consumedAttemptIds: [...grant.consumedAttemptIds].sort(),
        }))
        .sort((left, right) => left.grantId.localeCompare(right.grantId)),
      supersedeReasons: source.supersedeReasons
        .map((entry) => ({ ...entry }))
        .sort((left, right) => left.workflowId.localeCompare(right.workflowId)),
    });
  }

  function uniqueWorkflows(
    jobs: readonly ExecutionJobInspection[],
  ): Map<string, WorkflowRecord> {
    const boundServices: EngineMetricsComputationBindings = bindings();
    const { canonicalJson, metricsInvalid } = boundServices;

    const workflows = new Map<string, WorkflowRecord>();
    for (const { workflow } of jobs) {
      const existing = workflows.get(workflow.workflowId);
      if (existing && canonicalJson(existing) !== canonicalJson(workflow)) {
        throw metricsInvalid(
          'Execution Jobs disagree about their shared Workflow state.',
        );
      }
      workflows.set(workflow.workflowId, structuredClone(workflow));
    }
    return workflows;
  }

  function sameFingerprintReplayCount(
    jobs: readonly ExecutionJobInspection[],
  ): number {
    let total = 0;
    for (const { attempts } of jobs) {
      const counts = new Map<string, number>();
      for (const { failureFingerprint } of attempts) {
        if (failureFingerprint !== null) {
          counts.set(
            failureFingerprint,
            (counts.get(failureFingerprint) ?? 0) + 1,
          );
        }
      }
      total += [...counts.values()].reduce(
        (sum, count) => sum + Math.max(0, count - 1),
        0,
      );
    }
    return total;
  }

  function workflowBlockedHours(
    jobs: readonly ExecutionJobInspection[],
    workflows: ReadonlyMap<string, WorkflowRecord>,
    now: string,
  ): number {
    const boundServices: EngineMetricsComputationBindings = bindings();
    const { metricsInvalid, FAILURE_STATUSES } = boundServices;

    const intervals = new Map<string, Array<readonly [number, number]>>();
    const append = (workflowId: string, from: string, to: string): void => {
      const start = Date.parse(from);
      const end = Date.parse(to);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw metricsInvalid('Execution metric timestamps are not monotonic.');
      }
      const current = intervals.get(workflowId) ?? [];
      current.push([start, end]);
      intervals.set(workflowId, current);
    };
    for (const workflow of workflows.values()) {
      if (workflow.blocker !== null) {
        append(workflow.workflowId, workflow.blocker.since, now);
      }
    }
    for (const { workflow, job, attempts } of jobs) {
      const ordered = [...attempts].sort(
        (left, right) => left.attemptNumber - right.attemptNumber,
      );
      for (let index = 0; index < ordered.length; index += 1) {
        const attempt = ordered[index]!;
        if (!FAILURE_STATUSES.has(attempt.status)) continue;
        const next = ordered[index + 1];
        if (next !== undefined) {
          append(workflow.workflowId, attempt.updatedAt, next.createdAt);
        } else if (
          ['waiting-retry', 'waiting-grant', 'waiting-human-input'].includes(
            job.status,
          )
        ) {
          append(workflow.workflowId, attempt.updatedAt, now);
        }
      }
    }
    const milliseconds = [...intervals.values()].reduce((total, observed) => {
      const ordered = [...observed].sort(
        ([leftStart, leftEnd], [rightStart, rightEnd]) =>
          leftStart - rightStart || leftEnd - rightEnd,
      );
      let union = 0;
      let start: number | null = null;
      let end: number | null = null;
      for (const [candidateStart, candidateEnd] of ordered) {
        if (start === null || end === null) {
          start = candidateStart;
          end = candidateEnd;
        } else if (candidateStart <= end) {
          end = Math.max(end, candidateEnd);
        } else {
          union += end - start;
          start = candidateStart;
          end = candidateEnd;
        }
      }
      return (
        total + (start === null || end === null ? union : union + end - start)
      );
    }, 0);
    return milliseconds / 3_600_000;
  }

  function duration(from: string, to: string): number {
    const boundServices: EngineMetricsComputationBindings = bindings();
    const { metricsInvalid } = boundServices;

    const value = Date.parse(to) - Date.parse(from);
    if (!Number.isFinite(value) || value < 0) {
      throw metricsInvalid('Execution metric timestamps are not monotonic.');
    }
    return value;
  }

  function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
  }

  function rate(numerator: number, denominator: number): Rate {
    const boundServices: EngineMetricsComputationBindings = bindings();
    const { deepFreeze } = boundServices;

    return deepFreeze({
      numerator,
      denominator,
      value: denominator === 0 ? null : numerator / denominator,
    });
  }

  function exactTimestamp(value: string): string {
    const boundServices: EngineMetricsComputationBindings = bindings();
    const { metricsInvalid } = boundServices;

    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
      throw metricsInvalid(
        'Engine metrics require an exact ISO-8601 timestamp.',
      );
    }
    return value;
  }
  return { computeEngineMetrics, uniqueWorkflows, exactTimestamp };
}
