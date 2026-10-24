/**
 * Collects execution, governance and retention observations for engine
 * metrics computation.
 *
 * Invariants:
 * - A supersede reason is accepted only from a resolution node bound to
 *   that workflow and a supersede decision.
 */
import path from 'node:path';

import type { WorkflowRecord } from '../../modules/provider-orchestration/execution-record-types.ts';
import { deepFreeze } from '../../modules/provider-orchestration/execution-values.ts';
import {
  assertMetricsInvestigationId,
  computeEngineMetrics,
  exactTimestamp,
  uniqueWorkflows,
  type EngineGovernanceMetricsSource,
  type EngineMetricsSnapshot,
} from '../../modules/provider-orchestration/engine-metrics.ts';
import { listExecutionBudgetGrantMetrics } from '../../runtime/storage-journal/execution-budget-grants.ts';
import { listExecutionReplacementGrantRequestDigests } from './execution-replacement.ts';
import { listExecutionJobs } from '../../runtime/provider-execution/execution-runtime.ts';
import {
  privatePathExists,
  readPrivateCanonicalJson,
} from '../../runtime/journal-primitives/investigation-private-files.ts';
import { readHumanResolutionNode } from '../../runtime/storage-journal/human-resolution-nodes.ts';
import type { WorkflowSupersedeReason } from '../../modules/authority/intervention-control.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../../runtime/repository-observation/investigation-runtime-context.ts';
import { type InvestigationRuntimePaths } from '../../runtime/paths/runtime-paths.ts';
import type {
  ProviderRetentionMetrics,
  ProviderRetentionOptions,
} from '../../modules/provider-orchestration/provider-retention.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

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
