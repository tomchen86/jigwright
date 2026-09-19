/** Exact epoch manifests, evidence, and recovery predicates. */
import crypto from 'node:crypto';
import type { SpecDeltaPreflightRecord } from '@jigwright/core/planning-archive-projection-port';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { buildContextManifest } from '../authority/execution-governance-context.ts';
import type {
  DurableEpochContextState,
  DurableRetentionCatalog,
} from '../authority/execution-governance-store-contracts.ts';
import type {
  PlanningCarryForwardTaskEvidence,
  PlanningTransitionReport,
} from './planning-transition-report.ts';
import type { CommitFacts } from '../repository-consumer/commit-facts.ts';
import { parseManagedTrailers } from '@jigwright/core/managed-transition-trailers';
export const SOURCE_CHECKPOINT = 'execution-complete';
export const RESTART_CHECKPOINT = 'execution-restart-required';

export type PlanningExecutionEpochInspection = Readonly<{
  workflowId: string;
  context: DurableEpochContextState;
  retention: DurableRetentionCatalog;
}>;

export type PlanningExecutionEpochTransition = Readonly<{
  changeId: string;
  amendmentCommit: string;
  parentCommit: string;
  planningGeneration: string;
  amendsPlanningGeneration: string;
  decisionDigest: string;
  reportId: string;
  executionImpact: 'none' | 'required';
  taskEvidence: readonly PlanningCarryForwardTaskEvidence[];
  createdAt: string;
}>;
export type PlanningExecutionEpochOperations = Readonly<{
  recordPlanningExecutionEpochTransition: (
    cwd: string,
    input: PlanningExecutionEpochTransition,
  ) => PlanningExecutionEpochInspection;
  inspectPlanningExecutionEpoch: (
    cwd: string,
    requestedChangeId: string,
  ) => PlanningExecutionEpochInspection;
  ensurePlanningExecutionEpochCompleteForArchive: (
    cwd: string,
    input: {
      changeId: string;
      head: string;
      planningGeneration: string | null;
      taskEvidence: readonly PlanningCarryForwardTaskEvidence[];
      now: Date;
    },
  ) => PlanningExecutionEpochInspection | null;
}>;

export function planningExecutionWorkflowId(changeId: string): string {
  return `planning-execution:${changeId}`;
}

export function planningManifest(input: {
  workflowId: string;
  epoch: number;
  contractVersion: number;
  commit: string;
  intent: string;
  planningGeneration: string;
  items: { identity: string; content: string }[];
}) {
  return buildContextManifest({
    workflowId: input.workflowId,
    epoch: input.epoch,
    contractVersion: input.contractVersion,
    baselineDigest: digest(input.commit),
    intentDigest: digest(input.intent),
    termSetDigest: digest(
      canonicalJson(input.items.map(({ identity }) => identity)),
    ),
    planningSnapshotDigest: digest(input.planningGeneration),
    items: input.items,
  });
}

export function planningManifestWithIntentDigest(input: {
  workflowId: string;
  epoch: number;
  contractVersion: number;
  commit: string;
  intentDigest: string;
  planningGeneration: string;
  items: { identity: string; content: string }[];
}) {
  return buildContextManifest({
    workflowId: input.workflowId,
    epoch: input.epoch,
    contractVersion: input.contractVersion,
    baselineDigest: digest(input.commit),
    intentDigest: input.intentDigest,
    termSetDigest: digest(
      canonicalJson(input.items.map(({ identity }) => identity)),
    ),
    planningSnapshotDigest: digest(input.planningGeneration),
    items: input.items,
  });
}

export function taskEvidenceItems(
  evidence: readonly PlanningCarryForwardTaskEvidence[],
): { identity: string; content: string }[] {
  const sorted = [...evidence].sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
  if (
    sorted.length === 0 ||
    new Set(sorted.map(({ taskId }) => taskId)).size !== sorted.length
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_INVALID',
      'Execution epoch transition requires one exact evidence record per completed task.',
      ExitCode.verification,
    );
  }
  return sorted.map((entry) => ({
    identity: `task:${entry.taskId}`,
    content: canonicalJson({
      schemaVersion: 1,
      kind: 'planning-task-execution-evidence',
      ...entry,
    }),
  }));
}

export function digest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function exactDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_INVALID',
      'Planning execution epoch timestamp is invalid.',
      ExitCode.verification,
    );
  }
  return date;
}
export function isRecordedPlanningAmendment(
  current: DurableEpochContextState,
  input: PlanningExecutionEpochTransition,
  workflowId: string,
  nextItems: ReturnType<typeof taskEvidenceItems>,
) {
  return (
    current.currentManifest.baselineDigest === digest(input.amendmentCommit) &&
    current.currentManifest.intentDigest === digest(input.decisionDigest) &&
    current.currentManifest.planningSnapshotDigest ===
      digest(input.planningGeneration) &&
    canonicalJson(current.currentManifest.items) ===
      canonicalJson(
        planningManifest({
          workflowId,
          epoch: current.workflow.currentEpoch,
          contractVersion: current.workflow.contractVersion,
          commit: input.amendmentCommit,
          intent: input.decisionDigest,
          planningGeneration: input.planningGeneration,
          items: nextItems,
        }).items,
      ) &&
    current.workflow.checkpoint ===
      (input.executionImpact === 'none'
        ? SOURCE_CHECKPOINT
        : RESTART_CHECKPOINT)
  );
}

export function isCompletedGenerationRestart(
  current: DurableEpochContextState,
  input: PlanningExecutionEpochTransition,
) {
  return (
    current.workflow.checkpoint === RESTART_CHECKPOINT &&
    current.currentManifest.planningSnapshotDigest ===
      digest(input.amendsPlanningGeneration) &&
    current.currentManifest.items.length === 0
  );
}

export function assertPlanningAmendmentSourceCurrent(
  current: DurableEpochContextState,
  sourceManifest: ReturnType<typeof planningManifestWithIntentDigest>,
) {
  if (
    current.currentManifest.contextDigest !== sourceManifest.contextDigest ||
    current.workflow.checkpoint !== SOURCE_CHECKPOINT
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_STALE',
      'The current execution epoch does not match the exact completed generation being amended.',
      ExitCode.staleState,
    );
  }
}

export function assertPlanningAmendmentReached(
  current: DurableEpochContextState,
  nextManifest: ReturnType<typeof planningManifest>,
  input: PlanningExecutionEpochTransition,
) {
  if (
    current.currentManifest.contextDigest !== nextManifest.contextDigest ||
    current.workflow.checkpoint !==
      (input.executionImpact === 'none'
        ? SOURCE_CHECKPOINT
        : RESTART_CHECKPOINT)
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_CORRUPT',
      'The durable execution epoch did not reach the amendment checkpoint.',
      ExitCode.staleState,
    );
  }
}

export function assertArchiveEpochRestartCurrent(
  generationMatches: boolean,
  current: DurableEpochContextState,
) {
  if (
    !generationMatches ||
    current.workflow.checkpoint !== RESTART_CHECKPOINT ||
    current.currentManifest.items.length !== 0
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_STALE',
      'Archive execution evidence does not match the active planning epoch.',
      ExitCode.staleState,
    );
  }
}

export function assertArchiveEpochComplete(
  current: DurableEpochContextState,
  completedManifest: ReturnType<typeof planningManifest>,
) {
  if (
    current.workflow.checkpoint !== SOURCE_CHECKPOINT ||
    current.currentManifest.contextDigest !== completedManifest.contextDigest
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_CORRUPT',
      'Archive execution completion did not reach its exact durable epoch.',
      ExitCode.staleState,
    );
  }
}

export function assertPlanningRecoveryReportMatches(
  report: PlanningTransitionReport,
  amendment: NonNullable<ReturnType<typeof recoverablePlanningAmendment>>,
) {
  if (
    report.transition !== 'amend-plan' ||
    report.parent.head !== amendment.parentCommit ||
    report.amendment === null ||
    report.amendment.status !== 'recorded' ||
    report.amendment.planningGeneration !== amendment.planningGeneration ||
    report.amendment.amendsPlanningGeneration !==
      amendment.amendsPlanningGeneration ||
    report.amendment.executionImpact !== amendment.executionImpact
  ) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID',
      'The immutable amendment report does not match its committed transition.',
      ExitCode.staleState,
    );
  }
  return report.amendment;
}

export function recoverablePlanningAmendment(
  commitHash: string,
  facts: CommitFacts,
  changeId: string,
) {
  const trailers = parseManagedTrailers(
    facts.message.endsWith('\n') ? facts.message.slice(0, -1) : facts.message,
  );
  if (trailers?.kind !== 'amend-plan' || trailers.changeId !== changeId) {
    return null;
  }
  if (facts.parents.length !== 1) {
    throw workflowError(
      'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID',
      'A recoverable amendment must have exactly one parent.',
      ExitCode.staleState,
    );
  }
  return {
    commitHash,
    parentCommit: facts.parents[0]!,
    planningGeneration: trailers.planningGeneration,
    amendsPlanningGeneration: trailers.amendsPlanningGeneration,
    executionImpact: trailers.executionImpact,
  };
}

export type PlanningTransitionExecutionServices = Readonly<{
  planningExecutionEpoch: PlanningExecutionEpochOperations;
  taskExecutionGeneration: import('../assurance/task-execution-evidence.ts').TaskExecutionGenerationReader;
  /** Observes the transition before it is committed. */
  inspectPlanningTransition(
    repositoryRoot: string,
    baselineHead: string,
    changeRoot: string,
    changeId: string,
    changedPaths: string[],
    deletedPaths?: readonly string[],
    reopenAuthorized?: boolean,
  ): import('../planning-provider/change-contract.ts').PlanningInspection &
    Readonly<{
      planningRoleOverride:
        | import('../provider-orchestration/planning-role-provider-policy.ts').CurrentPlanningRoleOverridePolicy
        | null;
    }>;
  /** Runs the archive applicability preflight before the transition commits. */
  projectArchiveApplicability(
    input: import('../planning-provider/planning-archive-projection-port.ts').ArchiveApplicabilityProjectionInput,
  ): SpecDeltaPreflightRecord;
  /** Validates the transition against the configured current schema. */
  validatePlanningTransition(
    repositoryRoot: string,
    changeId: string,
    schemaName: import('../planning-provider/change-contract.ts').ManagedSchemaName,
  ): Pick<
    import('./planning-transition-report.ts').PlanningTransitionReport,
    'openspec' | 'planningAssurance'
  >;
}>;
