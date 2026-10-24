/** Binds complete finalization operations to the original required capabilities. */
import path from 'node:path';
import fs from 'node:fs';
import type { ReviewedGeneratedAssetInventory } from '../../modules/source/mutation-class-policy.ts';
import {
  type SessionCheckService,
  writeSessionReport,
} from '../repository-validation/session-verification.ts';
import type { TaskStrategyExecutionGate } from '../../modules/assurance/task-strategy-gate.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import { type TaskDiffReviewCompletionOperations } from '../../modules/lifecycle/task-diff-review-contracts.ts';
import type { ManagedDocumentOperations } from '../../modules/projection/managed-documents.ts';
import type { ImplementationReconciliationGate } from '../../modules/why-knowledge/implementation-reconciliation.ts';
import type { SystemDocumentDispositionService } from '../repository-validation/system-document-dispositions.ts';
import {
  getSession,
  runSessionOperation,
  loadActiveSessionContext,
} from '../repository-observation/workflow-session-context.ts';
import {
  discoverRepository,
  listChangedPaths,
} from '../repository-transaction/git.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import { readFinalizeTransaction } from '../storage-journal/finalize-transaction.ts';
import {
  assertProtectedTaskApplyNotRequired,
  finalizeTransactionTaskPaths,
  assertProtectedTaskApplyParametersCurrent,
  assertProtectedApplyTransactionAuthorization,
} from './protected-apply.ts';
import {
  type FinalizeTaskOptions,
  type FinalizeTaskResult,
} from '../../modules/lifecycle/projected-finalization.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { finalizeTaskUnlocked } from './projected-finalization.ts';
import type {
  FinalizeSessionOptions,
  FinalizeSessionResult,
  TaskDiffReviewReplayOptions,
  CompleteTaskResult,
  FinishSessionResult,
} from '../../modules/lifecycle/finalization.ts';
import {
  validateCommitSubject,
  commitFacts,
  stageExactPaths,
  rollbackExactStaging,
} from '../repository-transaction/git-transitions.ts';
import type { ProtectedTaskApplyFinalizationParametersV1 } from '../../modules/authority/protected-task-apply-grant.ts';
import { type ProtectedTaskApplyAuthorizationBinding } from '../../modules/lifecycle/finalize-transaction.ts';
import {
  assertProtectedApplyAuthorizationMatchesParameters,
  isCompletedFinalizeTransaction,
  invalidCompletedFinalize,
  assertFinalizeTransactionMatchesSession,
  finalizeResultFromTransaction,
} from '../../modules/lifecycle/finalization.ts';
import { assertPreparedProtectedTaskApplyAuthorization } from '../repository-validation/protected-task-apply-authorization.ts';
import { commitSessionUnlocked } from './commit.ts';
import { inspectSession } from '../repository-validation/session-inspection.ts';
import { readSessionReport } from '../storage-journal/session-report-reader.ts';
import {
  assertInspectionReport,
  assertReportChecks,
  staleReport,
  reportTaskIds,
  reportString,
  reportStringArray,
  assertProjectionPathClassification,
  assertCompletionTaskIds,
} from '../../modules/lifecycle/workflow-report.ts';
import { reconcilePredecessor } from '../repository-validation/predecessor-reconciliation.ts';
import {
  projectTasksCompleted,
  digestTaskContent,
  restoreTaskProjection,
} from '../managed-documents/transaction/task-projection.ts';
import { type GeneratedDocumentMutation } from '../../modules/projection/managed-documents.ts';
import { classifyProjectionPaths } from '../../modules/projection/engine-projection-registry.ts';
import type { WorkflowReport } from '../../modules/lifecycle/workflow-report.ts';
import { digestRequiredCheckDefinitions } from '../../modules/lifecycle/contract-digests.ts';
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import { persistSession } from '../session-workspace/session-persistence.ts';
import { rollbackGeneratedDocuments } from '../managed-documents/validation/managed-documents.ts';
import { readImmutableReport } from '../storage-journal/report-store.ts';
import { resolveFinalizeCheckPolicy } from '../../modules/assurance/finalize-check-policy.ts';
import { parseTasks } from '../../modules/planning-provider/planning-artifact-parsers.ts';

export function createFinalizationService(
  reviewedAssets: ReviewedGeneratedAssetInventory,
  sessionChecks: Pick<SessionCheckService, 'executeChecks'>,
  taskStrategyExecutionGate: TaskStrategyExecutionGate<SessionInspection>,
  changeContract: ChangeContractServices,
  taskDiffReview: Pick<
    TaskDiffReviewCompletionOperations,
    | 'assertTaskDiffReviewCompletionGateSatisfied'
    | 'loadTaskDiffDocumentationReviewCapture'
  >,
  managedDocuments: ManagedDocumentOperations,
  assertCurrentImplementationReconciliation: ImplementationReconciliationGate<SessionInspection>,
  systemDocumentDispositions: Pick<
    SystemDocumentDispositionService,
    'assertSystemDocumentDispositions'
  >,
) {
  function assertCurrentTaskMayUseOrdinaryFinalize(
    cwd: string,
    requestedSessionId: string,
  ): void {
    const session = getSession(cwd, requestedSessionId);
    const git = discoverRepository(cwd);
    const config = loadWorkflowConfig(git.repositoryRoot);
    const runtime = runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    );
    const transaction = readFinalizeTransaction(
      runtime.root,
      session.sessionId,
    );
    if (transaction !== null) {
      assertProtectedTaskApplyNotRequired(
        git.repositoryRoot,
        config,
        session,
        finalizeTransactionTaskPaths(transaction, session),
      );
      return;
    }
    systemDocumentDispositions.assertSystemDocumentDispositions(
      cwd,
      requestedSessionId,
    );
    assertProtectedTaskApplyNotRequired(
      git.repositoryRoot,
      config,
      session,
      listChangedPaths(git.repositoryRoot, session.baseline.head),
    );
  }

  function recoverFinalize(
    cwd: string,
    requestedSessionId: string,
    environment: NodeJS.ProcessEnv = process.env,
    options: FinalizeTaskOptions = {},
  ): FinalizeTaskResult {
    return runSessionOperation(cwd, requestedSessionId, () => {
      const session = getSession(cwd, requestedSessionId);
      const git = discoverRepository(cwd);
      const config = loadWorkflowConfig(git.repositoryRoot);
      const runtime = runtimePaths(
        git.gitCommonDirectory,
        config.runtimeDirectory,
      );
      const transaction = readFinalizeTransaction(
        runtime.root,
        session.sessionId,
      );
      if (transaction === null) {
        throw workflowError(
          'FINALIZE_TRANSACTION_NOT_FOUND',
          'No durable finalize transaction exists for this session.',
          ExitCode.staleState,
        );
      }
      assertProtectedTaskApplyNotRequired(
        git.repositoryRoot,
        config,
        session,
        finalizeTransactionTaskPaths(transaction, session),
      );
      return session.state === 'committed'
        ? replayCompletedFinalize(cwd, session)
        : finalizeTaskUnlocked(
            reviewedAssets,
            taskStrategyExecutionGate,
            changeContract,
            taskDiffReview,
            managedDocuments,
            assertCurrentImplementationReconciliation,
            systemDocumentDispositions,
            sessionChecks,
            cwd,
            requestedSessionId,
            environment,
            options,
          );
    });
  }

  function finalizeSession(
    cwd: string,
    requestedSessionId: string,
    subject: string,
    environment: NodeJS.ProcessEnv = process.env,
    options: FinalizeSessionOptions = {},
  ): FinalizeSessionResult {
    validateCommitSubject(subject);
    return runSessionOperation(cwd, requestedSessionId, () =>
      finalizeSessionUnlocked(
        cwd,
        requestedSessionId,
        subject,
        environment,
        options,
        null,
      ),
    );
  }

  function finalizeProtectedTaskApplyUnderGrant(
    cwd: string,
    parameters: ProtectedTaskApplyFinalizationParametersV1,
    authorization: ProtectedTaskApplyAuthorizationBinding,
    assertLifecycleOwned: () => void,
    environment: NodeJS.ProcessEnv = process.env,
  ): FinalizeSessionResult {
    validateCommitSubject(parameters.commitMessage);
    assertProtectedApplyAuthorizationMatchesParameters(
      authorization,
      parameters,
    );
    const repository = discoverRepository(cwd);
    const workflowConfig = loadWorkflowConfig(repository.repositoryRoot);
    assertPreparedProtectedTaskApplyAuthorization(
      runtimePaths(
        repository.gitCommonDirectory,
        workflowConfig.runtimeDirectory,
      ).root,
      authorization,
      parameters,
    );
    return runSessionOperation(cwd, parameters.sessionId, () => {
      assertLifecycleOwned();
      assertProtectedTaskApplyParametersCurrent(cwd, parameters);
      assertLifecycleOwned();
      const result = finalizeSessionUnlocked(
        cwd,
        parameters.sessionId,
        parameters.commitMessage,
        environment,
        {
          ...(parameters.fullGate === true ? { fullGate: true } : {}),
          consumedRoleResultReplay: undefined,
        },
        { parameters, authorization },
      );
      assertLifecycleOwned();
      return result;
    });
  }

  function finalizeSessionUnlocked(
    cwd: string,
    requestedSessionId: string,
    subject: string,
    environment: NodeJS.ProcessEnv,
    options: FinalizeSessionOptions,
    protectedApply: Readonly<{
      parameters: ProtectedTaskApplyFinalizationParametersV1;
      authorization: ProtectedTaskApplyAuthorizationBinding;
    }> | null,
  ): FinalizeSessionResult {
    const observed = getSession(cwd, requestedSessionId);
    let finalized: FinalizeTaskResult;
    if (observed.state === 'committed') {
      if (protectedApply !== null) {
        assertProtectedApplyTransactionAuthorization(
          cwd,
          observed,
          protectedApply.authorization,
        );
      }
      finalized = replayCompletedFinalize(cwd, observed);
    } else {
      if (protectedApply === null) {
        assertCurrentTaskMayUseOrdinaryFinalize(cwd, requestedSessionId);
      } else {
        assertProtectedTaskApplyParametersCurrent(
          cwd,
          protectedApply.parameters,
        );
      }
      finalized = finalizeTaskUnlocked(
        reviewedAssets,
        taskStrategyExecutionGate,
        changeContract,
        taskDiffReview,
        managedDocuments,
        assertCurrentImplementationReconciliation,
        systemDocumentDispositions,
        sessionChecks,
        cwd,
        requestedSessionId,
        environment,
        {
          ...(options.fullGate === true ? { fullGate: true } : {}),
          ...(options.consumedRoleResultReplay === undefined
            ? {}
            : {
                consumedRoleResultReplay: options.consumedRoleResultReplay,
              }),
          ...(options.onCheckEscalation
            ? { onCheckEscalation: options.onCheckEscalation }
            : {}),
          ...(options.testCrashAfter && options.testCrashAfter !== 'finalized'
            ? { testCrashAfter: options.testCrashAfter }
            : {}),
          ...(protectedApply === null
            ? {}
            : { protectedApply: protectedApply.authorization }),
        },
      );
      if (options.testCrashAfter === 'finalized') {
        throw new Error('Simulated finalize interruption after finalized.');
      }
    }
    const committed = commitSessionUnlocked(
      changeContract,
      cwd,
      requestedSessionId,
      subject,
      environment,
      protectedApply?.authorization ?? null,
    );
    const facts = commitFacts(
      finalized.session.repositoryRoot,
      committed.commitHash,
    );
    if (facts.tree !== finalized.tree) {
      throw workflowError(
        'FINALIZE_TRANSACTION_DIVERGED',
        'Managed finalize commit does not match its checked candidate tree.',
        ExitCode.staleState,
      );
    }
    const { session: _activeSession, ...result } = finalized;
    return {
      ...result,
      session: committed.session,
      commitReportId: committed.reportId,
      commitHash: committed.commitHash,
    };
  }

  function finalizeTask(
    cwd: string,
    requestedSessionId: string,
    environment: NodeJS.ProcessEnv = process.env,
    options: FinalizeTaskOptions = {},
  ): FinalizeTaskResult {
    return runSessionOperation(cwd, requestedSessionId, () => {
      assertCurrentTaskMayUseOrdinaryFinalize(cwd, requestedSessionId);
      return finalizeTaskUnlocked(
        reviewedAssets,
        taskStrategyExecutionGate,
        changeContract,
        taskDiffReview,
        managedDocuments,
        assertCurrentImplementationReconciliation,
        systemDocumentDispositions,
        sessionChecks,
        cwd,
        requestedSessionId,
        environment,
        options,
      );
    });
  }

  function completeTask(
    cwd: string,
    requestedSessionId: string,
    environment: NodeJS.ProcessEnv = process.env,
    options: TaskDiffReviewReplayOptions = {},
  ): CompleteTaskResult {
    return runSessionOperation(cwd, requestedSessionId, () =>
      completeTaskUnlocked(cwd, requestedSessionId, environment, options),
    );
  }

  function completeTaskUnlocked(
    cwd: string,
    requestedSessionId: string,
    environment: NodeJS.ProcessEnv,
    options: TaskDiffReviewReplayOptions,
  ): CompleteTaskResult {
    assertCurrentTaskMayUseOrdinaryFinalize(cwd, requestedSessionId);
    const initial = inspectSession(changeContract, cwd, requestedSessionId);
    assertProtectedTaskApplyNotRequired(
      initial.git.repositoryRoot,
      initial.contract.config,
      initial.session,
      initial.changedPaths,
    );
    if (initial.session.completionReportId) {
      throw workflowError(
        'TASK_ALREADY_PROJECTED',
        'The active session already has a completion report.',
        ExitCode.staleState,
      );
    }
    const checkReportId = initial.session.latestCheckReportId;
    if (!checkReportId) {
      throw workflowError(
        'CURRENT_CHECK_REPORT_REQUIRED',
        'A current passing check report is required before completion.',
        ExitCode.verification,
      );
    }
    const checkReport = readSessionReport(initial, checkReportId);
    assertInspectionReport(checkReport, initial, 'check', 'CHECK_REPORT_STALE');
    assertReportChecks(
      checkReport,
      initial,
      initial.session.requiredChecks,
      'CHECK_REPORT_STALE',
    );
    if (checkReport.parentReportId !== undefined) {
      throw staleReport('CHECK_REPORT_STALE');
    }
    assertCurrentImplementationReconciliation(initial);
    taskDiffReview.assertTaskDiffReviewCompletionGateSatisfied(
      cwd,
      requestedSessionId,
      {
        ...(options.consumedRoleResultReplay === undefined
          ? {}
          : { consumedRoleResultReplay: options.consumedRoleResultReplay }),
      },
    );
    const reconciliation = reconcilePredecessor(
      sessionChecks,
      cwd,
      initial,
      environment,
    );
    const completedTaskIds = [
      ...reconciliation.map(({ taskId }) => taskId),
      initial.session.taskId,
    ];
    const completesChange = initial.contract.tasks.every(
      ({ id, completed }) => completed || completedTaskIds.includes(id),
    );
    const documentationReview = completesChange
      ? taskDiffReview.loadTaskDiffDocumentationReviewCapture(
          cwd,
          requestedSessionId,
        )
      : null;
    const projection = projectTasksCompleted(
      initial.tasksPath,
      completedTaskIds,
    );
    const projectionSourceDigest = digestTaskContent(projection.before);
    let generatedDocuments: GeneratedDocumentMutation[] = [];

    try {
      generatedDocuments = managedDocuments.refreshCompletionDocuments(
        initial.git.repositoryRoot,
      );
      const transitionPaths = generatedDocuments.map(({ path }) => path).sort();
      const projected = inspectSession(
        changeContract,
        cwd,
        initial.session.sessionId,
        {
          expectedSession: initial.session,
          projectedTaskIds: completedTaskIds,
          projectionSourceDigest,
          authorizedTransitionPaths: transitionPaths,
        },
      );
      const pathClassification = classifyProjectionPaths(
        projected.changedPaths,
        [path.relative(projected.git.repositoryRoot, projected.tasksPath)],
        transitionPaths,
      );
      const report: WorkflowReport = {
        schemaVersion: 1,
        kind: 'completion',
        sessionId: initial.session.sessionId,
        changeId: initial.session.changeId,
        taskId: initial.session.taskId,
        createdAt: new Date().toISOString(),
        parentReportId: checkReportId,
        baseline: initial.session.baseline,
        branch: initial.session.branch,
        artifactDigests: projected.artifactDigests,
        allowedPaths: initial.session.allowedPaths,
        requiredChecks: initial.session.requiredChecks,
        requiredCheckDigests: digestRequiredCheckDefinitions(
          projected.contract.checks,
          initial.session.requiredChecks,
        ),
        ...pathClassification,
        fingerprint: projected.fingerprint,
        completedTaskIds,
        projectionSourceDigest,
        transitionPaths,
        reconciledTasks: reconciliation,
        ...(documentationReview === null ? {} : { documentationReview }),
      };
      const reportId = writeSessionReport(projected, report);
      const session: WorkflowSession = {
        ...initial.session,
        completionReportId: reportId,
      };
      persistSession(projected, session);
      return { session, reportId, completedTaskIds };
    } catch (error) {
      try {
        rollbackGeneratedDocuments(
          initial.git.repositoryRoot,
          generatedDocuments,
        );
      } finally {
        restoreTaskProjection(
          initial.tasksPath,
          projection.after,
          projection.before,
        );
      }
      throw error;
    }
  }

  function finishSession(
    cwd: string,
    requestedSessionId: string,
    environment: NodeJS.ProcessEnv = process.env,
    options: TaskDiffReviewReplayOptions = {},
  ): FinishSessionResult {
    return runSessionOperation(cwd, requestedSessionId, () =>
      finishSessionUnlocked(cwd, requestedSessionId, environment, options),
    );
  }

  function finishSessionUnlocked(
    cwd: string,
    requestedSessionId: string,
    environment: NodeJS.ProcessEnv,
    options: TaskDiffReviewReplayOptions,
  ): FinishSessionResult {
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const session = context.session;
    if (session.finishReportId) {
      throw workflowError(
        'SESSION_ALREADY_FINISHED',
        'The active session already has a finish report.',
        ExitCode.staleState,
      );
    }
    if (!session.completionReportId) {
      throw workflowError(
        'COMPLETION_REPORT_REQUIRED',
        'An authorized completion report is required before finish.',
        ExitCode.verification,
      );
    }
    const completionReport = readImmutableReport(
      context.runtime.reports,
      session.sessionId,
      session.completionReportId,
    );
    const completedTaskIds = reportTaskIds(
      completionReport,
      'COMPLETION_REPORT_STALE',
    );
    const projectionSourceDigest = reportString(
      completionReport,
      'projectionSourceDigest',
      'COMPLETION_REPORT_STALE',
    );
    const transitionPaths = reportStringArray(
      completionReport,
      'transitionPaths',
      'COMPLETION_REPORT_STALE',
    );
    const unprojected = inspectSession(
      changeContract,
      cwd,
      requestedSessionId,
      {
        projectedTaskIds: completedTaskIds,
        projectionSourceDigest,
        authorizedTransitionPaths: transitionPaths,
      },
    );
    const pathClassification = classifyProjectionPaths(
      unprojected.changedPaths,
      [path.relative(unprojected.git.repositoryRoot, unprojected.tasksPath)],
      transitionPaths,
    );
    assertProtectedTaskApplyNotRequired(
      unprojected.git.repositoryRoot,
      unprojected.contract.config,
      unprojected.session,
      pathClassification.taskPaths,
    );
    assertProjectionPathClassification(
      completionReport,
      pathClassification,
      'COMPLETION_REPORT_STALE',
    );
    assertInspectionReport(
      completionReport,
      unprojected,
      'completion',
      'COMPLETION_REPORT_STALE',
    );
    assertCompletionTaskIds(
      completionReport,
      unprojected,
      'COMPLETION_REPORT_STALE',
    );
    if (completionReport.parentReportId !== session.latestCheckReportId) {
      throw staleReport('COMPLETION_REPORT_STALE');
    }
    assertCurrentImplementationReconciliation(unprojected);
    taskDiffReview.assertTaskDiffReviewCompletionGateSatisfied(
      cwd,
      requestedSessionId,
      {
        projectedTaskIds: completedTaskIds,
        projectionSourceDigest,
        authorizedTransitionPaths: transitionPaths,
        ...(options.consumedRoleResultReplay === undefined
          ? {}
          : { consumedRoleResultReplay: options.consumedRoleResultReplay }),
      },
    );

    const checkPolicy = resolveFinalizeCheckPolicy(
      parseTasks(fs.readFileSync(unprojected.tasksPath, 'utf8')),
      session.requiredChecks,
      unprojected.contract.config,
    );
    const verified = sessionChecks.executeChecks({
      cwd,
      initial: unprojected,
      checkIds: [...checkPolicy.requiredChecks],
      environment,
      projectedTaskIds: completedTaskIds,
      projectionSourceDigest,
      authorizedTransitionPaths: transitionPaths,
    });
    const staged = stageExactPaths(
      verified.inspection.git.repositoryRoot,
      session.baseline.head,
      verified.inspection.changedPaths,
    );
    try {
      const finished = inspectSession(changeContract, cwd, session.sessionId, {
        expectedSession: session,
        projectedTaskIds: completedTaskIds,
        projectionSourceDigest,
        authorizedTransitionPaths: transitionPaths,
      });
      const report: WorkflowReport = {
        schemaVersion: 1,
        kind: 'finish',
        sessionId: session.sessionId,
        changeId: session.changeId,
        taskId: session.taskId,
        createdAt: new Date().toISOString(),
        parentReportId: session.completionReportId,
        baseline: session.baseline,
        branch: session.branch,
        artifactDigests: finished.artifactDigests,
        allowedPaths: session.allowedPaths,
        requiredChecks: [...checkPolicy.requiredChecks],
        requiredCheckDigests: digestRequiredCheckDefinitions(
          finished.contract.checks,
          [...checkPolicy.requiredChecks],
        ),
        checkEscalation: checkPolicy.checkEscalation,
        ...classifyProjectionPaths(
          finished.changedPaths,
          pathClassification.taskProjectionPaths,
          transitionPaths,
        ),
        fingerprint: finished.fingerprint,
        completedTaskIds,
        projectionSourceDigest,
        transitionPaths,
        checks: verified.checks,
        stagedPaths: staged.stagedPaths,
        tree: staged.tree,
      };
      const reportId = writeSessionReport(finished, report);
      const updated: WorkflowSession = { ...session, finishReportId: reportId };
      persistSession(finished, updated);
      return {
        session: updated,
        reportId,
        stagedPaths: staged.stagedPaths,
        tree: staged.tree,
      };
    } catch (error) {
      rollbackExactStaging(
        verified.inspection.git.repositoryRoot,
        staged.previousIndexTree,
        staged.tree,
        error,
      );
      throw error;
    }
  }
  return Object.freeze({
    recoverFinalize,
    finalizeSession,
    finalizeProtectedTaskApplyUnderGrant,
    finalizeTask,
    completeTask,
    finishSession,
  });
}

function replayCompletedFinalize(
  cwd: string,
  session: WorkflowSession,
): FinalizeTaskResult {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const transaction = readFinalizeTransaction(runtime.root, session.sessionId);
  if (
    transaction === null ||
    !isCompletedFinalizeTransaction(transaction) ||
    transaction.checkReportId !== session.latestCheckReportId ||
    transaction.completionReportId !== session.completionReportId ||
    transaction.finishReportId !== session.finishReportId
  ) {
    throw invalidCompletedFinalize();
  }
  assertFinalizeTransactionMatchesSession(transaction, session, git);
  return finalizeResultFromTransaction(transaction, session);
}
