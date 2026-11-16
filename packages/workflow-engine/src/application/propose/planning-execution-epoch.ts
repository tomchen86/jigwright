import {
  isRecordedPlanningAmendment,
  isCompletedGenerationRestart,
  assertPlanningAmendmentSourceCurrent,
  assertPlanningAmendmentReached,
  assertArchiveEpochRestartCurrent,
  assertArchiveEpochComplete,
  assertPlanningRecoveryReportMatches,
  recoverablePlanningAmendment,
} from '../../modules/lifecycle/planning-execution-epoch.ts';
/** Coordinates exact epoch reads, transitions, and archive recovery. */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { assertChangeId } from '../../foundation/repository-path/repository-path.ts';
import {
  buildContextManifest,
  type WorkflowContextState,
} from '../../modules/authority/execution-governance-context.ts';
import type { DurableEpochContextState } from '../../modules/authority/execution-governance-store-contracts.ts';
import type { ExecutionEpochStore } from '../../modules/authority/execution-governance-epoch-port.ts';
import type {
  PlanningCarryForwardTaskEvidence,
  PlanningTransitionReport,
} from '../../modules/lifecycle/planning-transition-report.ts';
import type {
  PlanningExecutionEpochInspection,
  PlanningExecutionEpochOperations,
  PlanningExecutionEpochTransition,
} from '../../modules/lifecycle/planning-execution-epoch.ts';
import type { PlanningExecutionEpochObservations } from '../../modules/lifecycle/planning-execution-epoch-observations.ts';
import {
  SOURCE_CHECKPOINT,
  RESTART_CHECKPOINT,
  planningExecutionWorkflowId,
  planningManifest,
  planningManifestWithIntentDigest,
  taskEvidenceItems,
  digest,
  exactDate,
} from '../../modules/lifecycle/planning-execution-epoch.ts';

export function createPlanningExecutionEpochOperations(
  services: Readonly<{
    executionEpochStore: ExecutionEpochStore;
    observations: PlanningExecutionEpochObservations;
  }>,
): PlanningExecutionEpochOperations {
  const { executionEpochStore, observations } = services;

  const recordPlanningExecutionEpochTransition: PlanningExecutionEpochOperations['recordPlanningExecutionEpochTransition'] =
    (cwd, input) => {
      const changeId = assertChangeId(input.changeId);
      const { repositoryRoot, changeRoot, storeRoot } =
        observations.resolveEnvironment(cwd);
      const workflowId = planningExecutionWorkflowId(changeId);
      const sourceItems = taskEvidenceItems(input.taskEvidence);
      let current: DurableEpochContextState;
      try {
        current = executionEpochStore.inspectDurableEpochContextStore(
          storeRoot,
          workflowId,
        );
      } catch (error) {
        if (
          !(error instanceof WorkflowError) ||
          error.code !== 'EXECUTION_CONTEXT_NOT_FOUND'
        ) {
          throw error;
        }
        const sourceManifest = planningManifest({
          workflowId,
          epoch: 1,
          contractVersion: 1,
          commit: input.parentCommit,
          intent: input.amendsPlanningGeneration,
          planningGeneration: input.amendsPlanningGeneration,
          items: sourceItems,
        });
        const workflow: WorkflowContextState = {
          workflowId,
          currentEpoch: 1,
          contractVersion: 1,
          contextDigest: sourceManifest.contextDigest,
          snapshotDigest: sourceManifest.baselineDigest,
          status: 'active',
          checkpoint: SOURCE_CHECKPOINT,
          blocker: null,
        };
        current = executionEpochStore.initializeDurableEpochContextStore(
          storeRoot,
          {
            workflow,
            manifest: sourceManifest,
            items: sourceItems,
            now: exactDate(input.createdAt),
          },
        );
      }

      const nextItems = input.executionImpact === 'none' ? sourceItems : [];
      if (isRecordedPlanningAmendment(current, input, workflowId, nextItems)) {
        return inspectPlanningExecutionEpoch(cwd, changeId);
      }

      if (isCompletedGenerationRestart(current, input)) {
        const completedManifest = planningManifestWithIntentDigest({
          workflowId,
          epoch: current.workflow.currentEpoch + 1,
          contractVersion: current.workflow.contractVersion,
          commit: input.parentCommit,
          intentDigest: current.currentManifest.intentDigest,
          planningGeneration: input.amendsPlanningGeneration,
          items: sourceItems,
        });
        current = executionEpochStore.rolloverDurableEpochContextStore(
          storeRoot,
          {
            workflowId,
            expectedGeneration: current.generation,
            expectedEpoch: current.workflow.currentEpoch,
            expectedContextDigest: current.workflow.contextDigest,
            nextManifest: completedManifest,
            items: sourceItems,
            reason:
              'Every task reopened by the reviewed amendment completed with exact managed commit evidence.',
            restartFrom: SOURCE_CHECKPOINT,
            carriedForward: [],
            carryForwardManifest: {
              sourceWorkflow: workflowId,
              sourceEpoch: current.workflow.currentEpoch,
              carriedForward: [],
              excluded: [],
            },
            invalidated: [],
            verification: {
              check: 'managed-task-generation-complete',
              result: 'passed',
            },
            createdAt: exactDate(input.createdAt),
          },
        );
      }

      const sourceManifest = planningManifestWithIntentDigest({
        workflowId,
        epoch: current.workflow.currentEpoch,
        contractVersion: current.workflow.contractVersion,
        commit: input.parentCommit,
        intentDigest: current.currentManifest.intentDigest,
        planningGeneration: input.amendsPlanningGeneration,
        items: sourceItems,
      });
      assertPlanningAmendmentSourceCurrent(current, sourceManifest);

      const nextManifest = planningManifest({
        workflowId,
        epoch: current.workflow.currentEpoch + 1,
        contractVersion: current.workflow.contractVersion + 1,
        commit: input.amendmentCommit,
        intent: input.decisionDigest,
        planningGeneration: input.planningGeneration,
        items: nextItems,
      });

      const carriedForward =
        input.executionImpact === 'none'
          ? sourceItems.map(({ identity }) => identity)
          : [];
      const carriedSet = new Set(carriedForward);
      current = executionEpochStore.rolloverDurableEpochContextStore(
        storeRoot,
        {
          workflowId,
          expectedGeneration: current.generation,
          expectedEpoch: current.workflow.currentEpoch,
          expectedContextDigest: current.workflow.contextDigest,
          nextManifest,
          items: nextItems,
          reason:
            input.executionImpact === 'none'
              ? 'Reviewed planning amendment preserved the exact completed execution evidence.'
              : 'Reviewed planning amendment invalidated the completed execution evidence.',
          restartFrom:
            input.executionImpact === 'none'
              ? SOURCE_CHECKPOINT
              : RESTART_CHECKPOINT,
          carriedForward,
          carryForwardManifest: {
            sourceWorkflow: workflowId,
            sourceEpoch: current.workflow.currentEpoch,
            carriedForward: carriedForward.map((identity) => ({
              identity,
              reason:
                'Exact managed task evidence remains valid under the reviewed no-impact amendment.',
            })),
            excluded: sourceItems
              .filter(({ identity }) => !carriedSet.has(identity))
              .map(({ identity }) => ({
                identity,
                reason:
                  'The reviewed amendment requires this task to execute again in the new planning generation.',
              })),
          },
          invalidated:
            input.executionImpact === 'required'
              ? sourceItems.map(({ identity }) => identity)
              : [],
          verification: {
            check: 'reviewed-planning-amendment',
            result: 'passed',
            reportDigest: digest(input.reportId),
          },
          createdAt: exactDate(input.createdAt),
        },
      );

      assertPlanningAmendmentReached(current, nextManifest, input);
      return inspectPlanningExecutionEpoch(cwd, changeId);
    };

  const inspectPlanningExecutionEpoch: PlanningExecutionEpochOperations['inspectPlanningExecutionEpoch'] =
    (cwd, requestedChangeId) => {
      const changeId = assertChangeId(requestedChangeId);
      const { repositoryRoot, changeRoot, storeRoot } =
        observations.resolveEnvironment(cwd);
      const workflowId = planningExecutionWorkflowId(changeId);
      return Object.freeze({
        workflowId,
        context: executionEpochStore.inspectDurableEpochContextStore(
          storeRoot,
          workflowId,
        ),
        retention: executionEpochStore.inspectDurableRetentionCatalog(
          storeRoot,
          workflowId,
        ),
      });
    };

  const ensurePlanningExecutionEpochCompleteForArchive: PlanningExecutionEpochOperations['ensurePlanningExecutionEpochCompleteForArchive'] =
    (cwd, input) => {
      const changeId = assertChangeId(input.changeId);
      const { repositoryRoot, changeRoot, storeRoot } =
        observations.resolveEnvironment(cwd);
      const workflowId = planningExecutionWorkflowId(changeId);
      let current: DurableEpochContextState;
      try {
        current = executionEpochStore.inspectDurableEpochContextStore(
          storeRoot,
          workflowId,
        );
      } catch (error) {
        if (
          error instanceof WorkflowError &&
          error.code === 'EXECUTION_CONTEXT_NOT_FOUND'
        ) {
          const recovered = recoverLatestPlanningExecutionEpoch(
            repositoryRoot,
            storeRoot,
            changeRoot,
            changeId,
            input.head,
          );
          if (recovered === null) return null;
          current = recovered.context;
        } else {
          throw error;
        }
      }
      if (
        input.planningGeneration !== null &&
        current.currentManifest.planningSnapshotDigest !==
          digest(input.planningGeneration)
      ) {
        const recovered = recoverLatestPlanningExecutionEpoch(
          repositoryRoot,
          storeRoot,
          changeRoot,
          changeId,
          input.head,
        );
        if (recovered !== null) current = recovered.context;
      }
      if (input.planningGeneration === null) {
        throw workflowError(
          'PLANNING_EXECUTION_EPOCH_STALE',
          'A durable planning execution epoch has no current planning generation.',
          ExitCode.staleState,
        );
      }
      const items = taskEvidenceItems(input.taskEvidence);
      const expectedReferences = planningManifest({
        workflowId,
        epoch: current.workflow.currentEpoch,
        contractVersion: current.workflow.contractVersion,
        commit: input.head,
        intent: input.planningGeneration,
        planningGeneration: input.planningGeneration,
        items,
      }).items;
      const generationMatches =
        current.currentManifest.planningSnapshotDigest ===
        digest(input.planningGeneration);
      if (
        generationMatches &&
        current.workflow.checkpoint === SOURCE_CHECKPOINT &&
        current.currentManifest.baselineDigest === digest(input.head) &&
        canonicalJson(current.currentManifest.items) ===
          canonicalJson(expectedReferences)
      ) {
        return inspectPlanningExecutionEpoch(cwd, changeId);
      }
      assertArchiveEpochRestartCurrent(generationMatches, current);
      const completedManifest = buildContextManifest({
        workflowId,
        epoch: current.workflow.currentEpoch + 1,
        contractVersion: current.workflow.contractVersion,
        baselineDigest: digest(input.head),
        intentDigest: current.currentManifest.intentDigest,
        termSetDigest: digest(
          canonicalJson(items.map(({ identity }) => identity)),
        ),
        planningSnapshotDigest: current.currentManifest.planningSnapshotDigest,
        items,
      });
      current = executionEpochStore.rolloverDurableEpochContextStore(
        storeRoot,
        {
          workflowId,
          expectedGeneration: current.generation,
          expectedEpoch: current.workflow.currentEpoch,
          expectedContextDigest: current.workflow.contextDigest,
          nextManifest: completedManifest,
          items,
          reason:
            'All tasks reopened by the current planning generation completed before archive.',
          restartFrom: SOURCE_CHECKPOINT,
          carriedForward: [],
          carryForwardManifest: {
            sourceWorkflow: workflowId,
            sourceEpoch: current.workflow.currentEpoch,
            carriedForward: [],
            excluded: [],
          },
          invalidated: [],
          verification: {
            check: 'archive-task-generation-complete',
            result: 'passed',
          },
          createdAt: input.now,
        },
      );
      assertArchiveEpochComplete(current, completedManifest);
      return inspectPlanningExecutionEpoch(cwd, changeId);
    };

  function recoverLatestPlanningExecutionEpoch(
    repositoryRoot: string,
    storeRoot: string,
    changeRoot: string,
    changeId: string,
    tip: string,
  ): PlanningExecutionEpochInspection | null {
    const amendment = latestAmendmentCommit(repositoryRoot, changeId, tip);
    if (amendment === null) return null;
    const reportsDirectory = path.join(storeRoot, 'planning-reports');
    const reportEntries = observations.readReportEntries(reportsDirectory);
    const matches = reportEntries
      .filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry))
      .flatMap((entry) => {
        const reportId = entry.slice(0, -'.json'.length);
        const report = observations.readPlanningTransitionReport(
          reportsDirectory,
          reportId,
        );
        return report.commitHash === amendment.commitHash
          ? [{ reportId, report }]
          : [];
      });
    if (matches.length !== 1) {
      throw workflowError(
        'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID',
        'Epoch recovery requires exactly one immutable report for the committed amendment.',
        ExitCode.staleState,
      );
    }
    const [{ reportId, report }] = matches;
    const recordedAmendment = assertPlanningRecoveryReportMatches(
      report,
      amendment,
    );
    const taskEvidence = sourceTaskEvidenceForReport(
      repositoryRoot,
      changeRoot,
      changeId,
      amendment.parentCommit,
      report,
    );
    return recordPlanningExecutionEpochTransition(repositoryRoot, {
      changeId,
      amendmentCommit: amendment.commitHash,
      parentCommit: amendment.parentCommit,
      planningGeneration: amendment.planningGeneration,
      amendsPlanningGeneration: amendment.amendsPlanningGeneration,
      decisionDigest: recordedAmendment.decisionDigest,
      reportId,
      executionImpact: amendment.executionImpact,
      taskEvidence,
      createdAt: report.createdAt,
    });
  }

  function latestAmendmentCommit(
    repositoryRoot: string,
    changeId: string,
    tip: string,
  ): {
    commitHash: string;
    parentCommit: string;
    planningGeneration: string;
    amendsPlanningGeneration: string;
    executionImpact: 'none' | 'required';
  } | null {
    const commits = observations.readFirstParentCommits(repositoryRoot, tip);
    for (const commitHash of commits) {
      const facts = observations.readCommitFacts(repositoryRoot, commitHash);
      const amendment = recoverablePlanningAmendment(
        commitHash,
        facts,
        changeId,
      );
      if (amendment !== null) return amendment;
    }
    return null;
  }

  function sourceTaskEvidenceForReport(
    repositoryRoot: string,
    changeRoot: string,
    changeId: string,
    parentCommit: string,
    report: PlanningTransitionReport,
  ): PlanningCarryForwardTaskEvidence[] {
    if (
      report.amendment !== null &&
      report.amendment.status === 'recorded' &&
      report.amendment.executionDisposition.kind === 'carried-forward'
    ) {
      return [...report.amendment.executionDisposition.tasks];
    }
    const taskIds =
      report.amendment !== null &&
      report.amendment.status === 'recorded' &&
      report.amendment.executionDisposition.kind === 'reopened'
        ? report.amendment.executionDisposition.taskIds
        : [];
    const generation = observations.taskExecutionGeneration(
      repositoryRoot,
      changeRoot,
      changeId,
      taskIds,
      parentCommit,
    );
    return taskIds.map((taskId) => {
      const commits = generation.commitsByTask[taskId] ?? [];
      if (commits.length === 1) {
        return {
          taskId,
          source: 'managed-task-commit' as const,
          commitHash: commits[0]!.hash,
        };
      }
      throw workflowError(
        'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID',
        'The committed amendment source task generation is missing or ambiguous.',
        ExitCode.staleState,
      );
    });
  }
  return {
    recordPlanningExecutionEpochTransition,
    inspectPlanningExecutionEpoch,
    ensurePlanningExecutionEpochCompleteForArchive,
  };
}
