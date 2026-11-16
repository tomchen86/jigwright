/** Evidence retention use cases depend on explicit observation, storage and authority capabilities. */
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import type {
  TaskMandateActiveBinding,
  TaskMandateOptions,
} from '../../modules/authority/task-mandate-access-contract.ts';
import type { MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import type { MaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type {
  DurableEpochContextState,
  DurableRetentionCatalog,
  DurableContextRetentionMaintenanceResult,
  DurableEvidencePinInput,
} from '../../modules/authority/execution-governance-store-contracts.ts';
import type {
  EvidenceRetentionRecord,
  WorkflowRetentionBinding,
} from '../../modules/authority/execution-governance-retention.ts';
import type {
  ProviderRetentionMetrics,
  ProviderRetentionPassResult,
} from '../../modules/provider-orchestration/provider-retention.ts';
import {
  collectRetentionWorkflowBindings,
  exactWorkflowMandateBinding,
  isWorkflowEvidencePinReplay,
  assertEvidenceRetentionLimit as assertLimit,
  assertEvidencePinReason as assertReason,
  exactRetentionTimestamp as exactTimestamp,
} from '../../modules/authority/execution-governance-retention.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';

type WorkflowObservation = {
  runtime(cwd: string): InvestigationRuntimePaths;
  workflowBindings(cwd: string): Iterable<WorkflowRetentionBinding>;
};
type CatalogObservation = {
  catalog(root: string, workflowId: string): DurableRetentionCatalog;
};
type Clock = { now(): Date };
export type RetentionMaintenanceDependencies = WorkflowObservation &
  Clock & {
    pruneProviderRuntime(
      cwd: string,
      input: { limit: number; now: string },
    ): ProviderRetentionPassResult;
    maintainDurableContexts(
      root: string,
      workflows: readonly string[],
      input: { limit: number; now: Date },
    ): EvidenceRetentionMaintenanceResult['durableContexts'];
  };
export type RetentionInspectionDependencies = WorkflowObservation &
  CatalogObservation &
  Clock & {
    context(root: string, workflowId: string): DurableEpochContextState;
    inspectProviderRetentionMetrics(
      cwd: string,
      input: { now: string },
    ): ProviderRetentionMetrics;
  };
export type EvidencePinDependencies = WorkflowObservation &
  CatalogObservation &
  Clock &
  Pick<TaskMandateActiveBinding, 'withActiveTaskMandateBinding'> & {
    policy(cwd: string): { repositoryRoot: string; policy: MaintainerPolicy };
    createSigner(
      root: string,
      policy: MaintainerPolicy,
    ): MaintainerSignerProvider;
    assertPinnable(
      runtime: InvestigationRuntimePaths,
      record: EvidenceRetentionRecord,
    ): void;
    pinEvidence(
      root: string,
      input: DurableEvidencePinInput,
    ): DurableRetentionCatalog;
  };

export type EvidenceRetentionMaintenanceResult = Readonly<{
  schemaVersion: 1;
  kind: 'evidence-retention-maintenance.v1';
  provider: ProviderRetentionPassResult;
  durableContexts: DurableContextRetentionMaintenanceResult;
}>;
export type EvidenceRetentionInspection = Readonly<{
  schemaVersion: 1;
  kind: 'evidence-retention-inspection.v1';
  provider: ProviderRetentionMetrics;
  durableContexts: ReadonlyArray<{
    workflowId: string;
    currentEpoch: number;
    contextGeneration: number;
    catalogGeneration: number;
    records: number;
    active: number;
    expiring: number;
    pinned: number;
  }>;
}>;
export function runEvidenceRetentionMaintenance(
  dependencies: RetentionMaintenanceDependencies,
  cwd: string,
  input: { limit: number; now?: string },
): EvidenceRetentionMaintenanceResult {
  const limit = assertLimit(input.limit);
  const now = exactTimestamp(input.now ?? dependencies.now().toISOString());
  const provider = dependencies.pruneProviderRuntime(cwd, { limit, now });
  const storeRoot = dependencies.runtime(cwd).root;
  const workflows = collectRetentionWorkflowBindings(
    dependencies.workflowBindings(cwd),
  ).map(({ workflowId }) => workflowId);
  const durableContexts = dependencies.maintainDurableContexts(
    storeRoot,
    workflows,
    { limit, now: new Date(now) },
  );
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'evidence-retention-maintenance.v1' as const,
    provider,
    durableContexts,
  });
}

export function inspectEvidenceRetention(
  dependencies: RetentionInspectionDependencies,
  cwd: string,
  input: { now?: string } = {},
): EvidenceRetentionInspection {
  const now = exactTimestamp(input.now ?? dependencies.now().toISOString());
  const storeRoot = dependencies.runtime(cwd).root;
  const durableContexts = collectRetentionWorkflowBindings(
    dependencies.workflowBindings(cwd),
  ).flatMap(({ workflowId }) => {
    try {
      const context = dependencies.context(storeRoot, workflowId);
      const catalog = dependencies.catalog(storeRoot, workflowId);
      return [
        {
          workflowId,
          currentEpoch: context.workflow.currentEpoch,
          contextGeneration: context.generation,
          catalogGeneration: catalog.generation,
          records: catalog.records.length,
          active: catalog.records.filter(
            ({ retention }) => retention === 'active',
          ).length,
          expiring: catalog.records.filter(
            ({ retention }) => retention === 'expiring',
          ).length,
          pinned: catalog.records.filter(
            ({ retention }) => retention === 'pinned',
          ).length,
        },
      ];
    } catch (error) {
      if (isWorkflowError(error, 'EXECUTION_CONTEXT_NOT_FOUND')) return [];
      throw error;
    }
  });
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'evidence-retention-inspection.v1' as const,
    provider: dependencies.inspectProviderRetentionMetrics(cwd, { now }),
    durableContexts,
  });
}

export function pinWorkflowEvidence(
  dependencies: EvidencePinDependencies,
  cwd: string,
  request: { workflowId: string; evidenceId: string; reason: string },
  options: TaskMandateOptions = {},
): Readonly<{
  workflowId: string;
  evidenceId: string;
  record: EvidenceRetentionRecord;
  catalogGeneration: number;
  replayed: boolean;
}> {
  const reason = assertReason(request.reason);
  const entries = collectRetentionWorkflowBindings(
    dependencies.workflowBindings(cwd),
  ).filter((entry) => entry.workflowId === request.workflowId);
  if (entries.length === 0) {
    throw workflowError(
      'RETENTION_WORKFLOW_NOT_FOUND',
      `Execution workflow ${request.workflowId} was not found.`,
      ExitCode.guard,
    );
  }
  const binding = exactWorkflowMandateBinding(
    entries.map(({ mandateBinding }) => mandateBinding),
  );
  const storeRoot = dependencies.runtime(cwd).root;
  const observedCatalog = dependencies.catalog(storeRoot, request.workflowId);
  const observed = observedCatalog.records.find(
    ({ evidenceId }) => evidenceId === request.evidenceId,
  );
  if (observed === undefined) {
    throw workflowError(
      'RETENTION_EVIDENCE_NOT_FOUND',
      `Evidence ${request.evidenceId} was not found.`,
      ExitCode.guard,
    );
  }
  const { repositoryRoot, policy } = dependencies.policy(cwd);
  const signer =
    options.signer ?? dependencies.createSigner(repositoryRoot, policy);
  signer.assertHumanPresent();
  const actor = signer.identity();
  if (!policy.trustedSigners.some(({ identity }) => identity === actor)) {
    throw workflowError(
      'RETENTION_PIN_SIGNER_UNTRUSTED',
      'Evidence pinning requires a currently trusted controlling maintainer.',
      ExitCode.verification,
    );
  }
  return dependencies.withActiveTaskMandateBinding(
    cwd,
    binding.mandateTaskId,
    {
      now: options.now,
      signer,
    },
    (active, assertOwned) => {
      if (canonicalJson(active) !== canonicalJson(binding)) {
        throw workflowError(
          'RETENTION_TASK_MANDATE_MISMATCH',
          'Evidence retention authority no longer matches the exact active Task Mandate.',
          ExitCode.staleState,
        );
      }
      const runtime = dependencies.runtime(cwd);
      const catalog = dependencies.catalog(runtime.root, request.workflowId);
      const current = catalog.records.find(
        ({ evidenceId }) => evidenceId === request.evidenceId,
      );
      if (current === undefined) {
        throw workflowError(
          'RETENTION_EVIDENCE_NOT_FOUND',
          `Evidence ${request.evidenceId} was not found.`,
          ExitCode.guard,
        );
      }
      dependencies.assertPinnable(runtime, current);
      assertOwned();
      if (isWorkflowEvidencePinReplay(current, actor, reason)) {
        return deepFreeze({
          workflowId: request.workflowId,
          evidenceId: request.evidenceId,
          record: current,
          catalogGeneration: catalog.generation,
          replayed: true,
        });
      }
      const updated = dependencies.pinEvidence(runtime.root, {
        workflowId: request.workflowId,
        evidenceId: request.evidenceId,
        expectedCatalogGeneration: catalog.generation,
        decision: {
          actor,
          reason,
          pinnedAt: options.now ?? dependencies.now(),
          humanConfirmed: true,
        },
      });
      assertOwned();
      const record = updated.records.find(
        ({ evidenceId }) => evidenceId === request.evidenceId,
      )!;
      return deepFreeze({
        workflowId: request.workflowId,
        evidenceId: request.evidenceId,
        record,
        catalogGeneration: updated.generation,
        replayed: false,
      });
    },
  );
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
