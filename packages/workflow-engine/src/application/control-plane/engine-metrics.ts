/**
 * Collects execution, governance and retention observations for engine
 * metrics computation.
 *
 * Invariants:
 * - A supersede reason is accepted only from a resolution node bound to
 *   that workflow and a supersede decision.
 */
import { createEngineMetricsComputation } from './engine-metrics-computation.ts';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  AttemptRecord,
  WorkflowRecord,
} from '../../modules/provider-orchestration/execution-core.ts';
import { listExecutionBudgetGrantMetrics } from '../../runtime/storage-journal/execution-budget-grants.ts';
import { listExecutionReplacementGrantRequestDigests } from './execution-replacement.ts';
import {
  listExecutionJobs,
  type ExecutionJobInspection,
} from '../../runtime/provider-execution/execution-runtime.ts';
import {
  privatePathExists,
  readPrivateCanonicalJson,
} from '../../runtime/storage-journal/investigation-private-files.ts';
import { readHumanResolutionNode } from '../../runtime/storage-journal/human-resolution-nodes.ts';
import {
  WORKFLOW_SUPERSEDE_REASONS,
  type WorkflowSupersedeReason,
} from '../../modules/authority/intervention-control.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import { type InvestigationRuntimePaths } from '../../runtime/session-workspace/paths.ts';
import { assertInvestigationId } from '../../foundation/repository-path/repository-path.ts';
import type {
  ProviderRetentionMetrics,
  ProviderRetentionOptions,
} from '../../modules/provider-orchestration/provider-retention.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

type Rate = Readonly<{
  numerator: number;
  denominator: number;
  value: number | null;
}>;

export type EngineGovernanceMetricsSource = Readonly<{
  grantRequestDigests: readonly string[];
  issuedGrants: readonly Readonly<{
    grantId: string;
    requestDigest: string;
    consumedAttemptIds: readonly string[];
  }>[];
  supersedeReasons: readonly Readonly<{
    workflowId: string;
    reason: WorkflowSupersedeReason;
  }>[];
}>;

export type EngineMetricsSnapshot = Readonly<{
  schemaVersion: 1;
  kind: 'engine-metrics-snapshot.v1';
  generatedAt: string;
  sample: Readonly<{
    workflows: number;
    jobs: number;
    attempts: number;
  }>;
  metrics: Readonly<{
    attempt_failure_recovered_rate: Rate;
    automatic_retry_success_rate: Rate;
    repair_retry_success_rate: Rate;
    late_output_rejected_count: number;
    same_fingerprint_replay_count: number;
    median_failure_to_next_attempt_ms: number | null;
    median_failure_to_recovery_ms: number | null;
    human_actions_per_recoverable_failure: number | null;
    stages_recomputed_per_retry: number | null;
    workflow_blocked_hours: number;
    suspended_created_count: 0;
    supersede_by_reason: Readonly<Record<string, number>>;
    direct_refusal_count: number;
    grant_request_count: number;
    grant_to_success_rate: Rate;
    raw_evidence_bytes_by_retention_class: ProviderRetentionMetrics['rawEvidenceBytesByRetentionClass'];
    expired_pending_deletion: ProviderRetentionMetrics['expiredPendingDeletion'];
    pinned_count: number;
    receipt_count: number;
  }>;
}>;

const FAILURE_STATUSES = new Set<AttemptRecord['status']>([
  'failed-retryable',
  'failed-terminal',
  'timed-out',
]);
const RATE_TERMINAL_STATUSES = new Set<AttemptRecord['status']>([
  'succeeded',
  'failed-retryable',
  'failed-terminal',
  'timed-out',
]);
export function collectEngineMetrics(
  inspectProviderRetentionMetrics: (
    cwd: string,
    options: Pick<ProviderRetentionOptions, 'now' | 'ttlDays'>,
  ) => ProviderRetentionMetrics,
  cwd: string,
  options: { now?: string; retentionTtlDays?: number } = {},
): EngineMetricsSnapshot {
  const now = exactTimestamp(options.now ?? new Date().toISOString());
  const jobs = listExecutionJobs(cwd);
  const storage = inspectProviderRetentionMetrics(cwd, {
    now,
    ...(options.retentionTtlDays === undefined
      ? {}
      : { ttlDays: options.retentionTtlDays }),
  });
  const context = loadInvestigationRuntimeContext(cwd);
  const issuedGrants = listExecutionBudgetGrantMetrics(
    context.lifecycleRuntime.root,
  );
  const replacementRequestDigests =
    listExecutionReplacementGrantRequestDigests(cwd);
  const governance: EngineGovernanceMetricsSource = {
    grantRequestDigests: [
      ...new Set([
        ...issuedGrants.map(({ requestDigest }) => requestDigest),
        ...replacementRequestDigests,
      ]),
    ].sort(),
    issuedGrants,
    supersedeReasons: collectSupersedeReasons(
      context.runtime,
      uniqueWorkflows(jobs),
    ),
  };
  return computeEngineMetrics(jobs, storage, now, governance);
}

function collectSupersedeReasons(
  paths: InvestigationRuntimePaths,
  workflows: ReadonlyMap<string, WorkflowRecord>,
): EngineGovernanceMetricsSource['supersedeReasons'] {
  const observations: Array<{
    workflowId: string;
    reason: WorkflowSupersedeReason;
  }> = [];
  for (const workflow of workflows.values()) {
    if (workflow.status !== 'superseded') continue;
    const workflowId = assertMetricsInvestigationId(workflow.workflowId);
    observations.push({
      workflowId,
      reason: inspectEngineSupersedeReason(paths, workflowId),
    });
  }
  return deepFreeze(
    observations.sort((left, right) =>
      left.workflowId.localeCompare(right.workflowId),
    ),
  );
}

export function inspectEngineSupersedeReason(
  paths: InvestigationRuntimePaths,
  requestedWorkflowId: string,
): WorkflowSupersedeReason {
  const workflowId = assertMetricsInvestigationId(requestedWorkflowId);
  const resolutionRoot = path.join(paths.root, 'human-resolutions');
  const refPath = path.join(resolutionRoot, 'refs', `${workflowId}.json`);
  if (!privatePathExists(paths, refPath, metricsStoreUnsafe)) {
    throw metricsStoreUnsafe();
  }
  const ref = readPrivateCanonicalJson(paths, refPath, metricsStoreUnsafe);
  if (
    !isRecord(ref) ||
    !hasExactKeys(ref, ['schemaVersion', 'investigationId', 'nodeId']) ||
    ref.schemaVersion !== 1 ||
    ref.investigationId !== workflowId ||
    !isRawDigest(ref.nodeId)
  ) {
    throw metricsStoreUnsafe();
  }
  const nodeId = ref.nodeId;
  try {
    const node = readHumanResolutionNode(paths, nodeId);
    if (
      node.target.workflowId !== workflowId ||
      node.decision.kind !== 'supersede'
    ) {
      throw metricsStoreUnsafe();
    }
    return node.decision.parameters.reason;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENGINE_METRICS_STORE_UNSAFE'
    ) {
      throw error;
    }
    throw metricsStoreUnsafe();
  }
}

function assertMetricsInvestigationId(value: string): string {
  try {
    return assertInvestigationId(value);
  } catch {
    throw metricsInvalid(
      'A superseded execution Workflow is not a bound Investigation.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isRawDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function metricsStoreUnsafe() {
  return workflowError(
    'ENGINE_METRICS_STORE_UNSAFE',
    'Engine governance metrics encountered unsafe durable state.',
    ExitCode.unsafeEnvironment,
  );
}

function metricsInvalid(message: string) {
  return workflowError(
    'ENGINE_METRICS_INVALID',
    message,
    ExitCode.verification,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export type EngineMetricsComputationBindings = {
  metricsInvalid: typeof metricsInvalid;
  FAILURE_STATUSES: typeof FAILURE_STATUSES;
  RATE_TERMINAL_STATUSES: typeof RATE_TERMINAL_STATUSES;
  deepFreeze: typeof deepFreeze;
  isRecord: typeof isRecord;
  WORKFLOW_SUPERSEDE_REASONS: typeof WORKFLOW_SUPERSEDE_REASONS;
  canonicalJson: typeof canonicalJson;
};
export type EngineMetricsComputationBindingsTypes = {
  ExecutionJobInspection: ExecutionJobInspection;
  ProviderRetentionMetrics: ProviderRetentionMetrics;
  EngineGovernanceMetricsSource: EngineGovernanceMetricsSource;
  EngineMetricsSnapshot: EngineMetricsSnapshot;
  WorkflowRecord: WorkflowRecord;
  Rate: Rate;
};

const { computeEngineMetrics, uniqueWorkflows, exactTimestamp } =
  createEngineMetricsComputation(() => ({
    metricsInvalid,
    FAILURE_STATUSES,
    RATE_TERMINAL_STATUSES,
    deepFreeze,
    isRecord,
    WORKFLOW_SUPERSEDE_REASONS,
    canonicalJson,
  }));
export { computeEngineMetrics };
