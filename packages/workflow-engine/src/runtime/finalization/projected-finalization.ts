import {
  PROJECTED_SINGLE_PASS_ASSURANCE,
  type FinalizeTaskResult,
  type FinalizeTaskOptions,
  type CandidateFinalizeTransaction,
  assertCandidateTransaction,
  createCheckReport,
  createCompletionReport,
  createFinishReport,
  finalizedSession,
  sessionHasFinalizeReports,
  resultFrom,
  assertProtectedApplyRequestMatches,
  transactionDiverged,
  assertExplicitCheckRequestMatches,
  assertFinalizeTransactionIdentity,
} from '../../modules/lifecycle/projected-finalization.ts';
import type { SystemDocumentDispositionService } from '../repository-validation/system-document-dispositions.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import type { ReviewedGeneratedAssetInventory } from '../../modules/source/mutation-class-policy.ts';

import type { TaskStrategyExecutionGate } from '../../modules/assurance/task-strategy-gate.ts';
import type { ManagedDocumentOperations } from '../../modules/projection/managed-documents.ts';
/**
 * Applies projected finalize transactions and recovers their checks and
 * reports.
 *
 * Invariants:
 * - A new projected finalize requires a session without prior completion
 *   evidence.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseTasks } from '../../modules/planning-provider/planning-artifact-parsers.ts';
import { classifyProjectionPaths } from '../../modules/projection/engine-projection-registry.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  advanceFinalizeTransaction,
  createFinalizeTransaction,
  publishFinalizeTransaction,
  readFinalizeTransaction,
  removeFinalizeTransaction,
} from '../storage-journal/finalize-transaction.ts';
import { type FinalizeTransaction } from '../../modules/lifecycle/finalize-transaction.ts';
import { resolveFinalizeCheckPolicy } from '../../modules/assurance/finalize-check-policy.ts';
import {
  listStagedPaths,
  previewExactStaging,
  rollbackExactStaging,
  stageExactPaths,
} from '../repository-transaction/git-transitions.ts';
import {
  fingerprintRepositoryProjectionExcludingPaths,
  fingerprintUnstagedRepositoryProjection,
  runGit,
} from '../repository-transaction/git.ts';
import { loadActiveSessionContext } from '../repository-observation/workflow-session-context.ts';
import { applyGeneratedDocumentMutations } from '../managed-documents/validation/managed-documents.ts';
import type { ImplementationReconciliationGate } from '../../modules/why-knowledge/implementation-reconciliation.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import { reconcilePredecessor } from '../repository-validation/predecessor-reconciliation.ts';
import type { WorkflowReport } from '../../modules/lifecycle/workflow-report.ts';
import {
  assertInspectionReport,
  assertReportChecks,
} from '../../modules/lifecycle/workflow-report.ts';
import { readSessionReport } from '../storage-journal/session-report-reader.ts';
import {
  applyTaskProjection,
  digestTaskContent,
  planTasksCompleted,
  restoreTaskProjection,
} from '../managed-documents/transaction/task-projection.ts';
import { type TaskDiffReviewCompletionOperations } from '../../modules/lifecycle/task-diff-review-contracts.ts';

import { ensureTaskMechanicalTransformationEvidence } from '../repository-validation/task-mechanical-transform.ts';
import {
  type SessionCheckService,
  writeSessionReport,
} from '../repository-validation/session-verification.ts';
import { persistSession } from '../session-workspace/session-persistence.ts';
import { inspectSession } from '../repository-validation/session-inspection.ts';

/**
 * A projected single-pass finalize builds the final implementation, checkbox,
 * and generated-handoff projection, runs each current-task required check
 * exactly once on that final tree, and, on success, emits schema-compatible
 * check -> completion -> finish reports bound to the same projected inspection
 * and check evidence. Independently required predecessor reconciliation stays
 * distinct. On any caught ordinary failure it restores the controlled
 * projections and leaves no evidence pointers behind.
 */

export function finalizeTaskUnlocked(
  reviewedAssets: ReviewedGeneratedAssetInventory,
  taskStrategyExecutionGate: TaskStrategyExecutionGate<SessionInspection>,
  changeContract: ChangeContractServices,
  taskDiffReview: Pick<
    TaskDiffReviewCompletionOperations,
    | 'assertTaskDiffReviewCompletionGateSatisfied'
    | 'loadTaskDiffDocumentationReviewCapture'
  >,
  managedDocuments: Pick<ManagedDocumentOperations, 'planCompletionDocuments'>,
  assertCurrentImplementationReconciliation: ImplementationReconciliationGate<SessionInspection>,
  systemDocumentDispositions: Pick<
    SystemDocumentDispositionService,
    'assertSystemDocumentDispositions'
  >,
  sessionChecks: Pick<SessionCheckService, 'executeChecks'>,
  cwd: string,
  requestedSessionId: string,
  environment: NodeJS.ProcessEnv,
  options: FinalizeTaskOptions = {},
): FinalizeTaskResult {
  const active = loadActiveSessionContext(cwd, requestedSessionId);
  const existing = readFinalizeTransaction(
    active.runtime.root,
    active.session.sessionId,
  );
  if (existing !== null) {
    assertFinalizeTransactionIdentity(active.session, active.git, existing);
    assertExplicitCheckRequestMatches(
      active.session,
      active.config,
      existing,
      options,
    );
    assertProtectedApplyRequestMatches(existing, options);
    try {
      return continueFinalizeTransaction(
        sessionChecks,
        changeContract,
        taskDiffReview,
        cwd,
        existing,
        environment,
        options,
      );
    } catch (error) {
      if (preservesFinalizeTransaction(error)) throw error;
      rollbackPersistedFinalizeTransaction(cwd, existing.sessionId, error);
      throw error;
    }
  }

  systemDocumentDispositions.assertSystemDocumentDispositions(
    cwd,
    requestedSessionId,
  );
  const initial = inspectSession(changeContract, cwd, requestedSessionId, {
    ...(options.protectedApply === undefined
      ? {}
      : { protectedApplyAuthorization: options.protectedApply }),
  });
  const session = initial.session;
  if (
    session.latestCheckReportId ||
    session.completionReportId ||
    session.finishReportId
  ) {
    throw workflowError(
      'FINALIZE_REQUIRES_FRESH_SESSION',
      'Projected single-pass finalize requires an active session without prior check, completion, or finish evidence.',
      ExitCode.staleState,
    );
  }
  assertCurrentImplementationReconciliation(initial);
  ensureTaskMechanicalTransformationEvidence(reviewedAssets, initial);
  taskStrategyExecutionGate.assertExecutionAdmitted(initial, environment);

  const reconciliation = reconcilePredecessor(
    sessionChecks,
    cwd,
    initial,
    environment,
  );
  const completedTaskIds = [
    ...reconciliation.map(({ taskId }) => taskId),
    session.taskId,
  ];
  const projection = planTasksCompleted(initial.tasksPath, completedTaskIds);
  const projectionSourceDigest = digestTaskContent(projection.before);
  const checkPolicy = resolveFinalizeCheckPolicy(
    parseTasks(projection.after),
    session.requiredChecks,
    initial.contract.config,
    options.fullGate === true,
  );
  if (options.fullGate === true && checkPolicy.checkEscalation === null) {
    throw workflowError(
      'FINALIZE_FULL_GATE_NOT_CONFIGURED',
      'Explicit full-gate escalation requires repository terminal checks.',
      ExitCode.guard,
    );
  }
  let transaction: FinalizeTransaction | null = null;

  try {
    const generatedDocuments = managedDocuments.planCompletionDocuments(
      initial.git.repositoryRoot,
      { changeId: session.changeId, tasks: projection.after },
    );
    const transitionPaths = generatedDocuments.map(({ path }) => path).sort();
    const taskProjectionPath = path.relative(
      initial.git.repositoryRoot,
      initial.tasksPath,
    );
    const projectionMutations = [
      {
        path: taskProjectionPath,
        before: projection.before,
        after: projection.after,
      },
      ...generatedDocuments.map((mutation) => ({
        path: mutation.path,
        before: mutation.before ?? null,
        after: mutation.after,
      })),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const projectionPaths = projectionMutations.map(({ path }) => path);
    if (
      listStagedPaths(initial.git.repositoryRoot, session.baseline.head)
        .length > 0
    ) {
      throw workflowError(
        'STAGING_ALREADY_PRESENT',
        'Only workflow finalize may create the managed staging projection.',
        ExitCode.staleState,
      );
    }
    transaction = publishFinalizeTransaction(
      active.runtime.root,
      createFinalizeTransaction({
        schemaVersion: 2,
        kind: 'projected-finalize-transaction.v2',
        sessionId: session.sessionId,
        changeId: session.changeId,
        taskId: session.taskId,
        repositoryRoot: initial.git.repositoryRealPath,
        gitCommonDirectory: initial.git.gitCommonDirectory,
        branch: session.branch,
        baseline: session.baseline,
        completedTaskIds,
        requiredChecks: checkPolicy.requiredChecks,
        checkEscalation: checkPolicy.checkEscalation,
        reconciledTasks: reconciliation,
        taskProjectionPath,
        projectionMutations,
        projectionSourceDigest,
        projectionBaseFingerprint:
          fingerprintRepositoryProjectionExcludingPaths(
            initial.git.repositoryRoot,
            session.baseline.head,
            initial.git.statusEntries,
            projectionPaths,
          ),
        transitionPaths,
        previousIndexTree: runGit(initial.git.repositoryRoot, [
          'write-tree',
        ]).trim(),
        createdAt: new Date().toISOString(),
        ...(options.protectedApply === undefined
          ? {}
          : { protectedApply: options.protectedApply }),
      }),
    );
    maybeInterrupt(options, 'projection-prepared');
    return continueFinalizeTransaction(
      sessionChecks,
      changeContract,
      taskDiffReview,
      cwd,
      transaction,
      environment,
      options,
    );
  } catch (error) {
    if (preservesFinalizeTransaction(error)) throw error;
    if (transaction !== null) {
      rollbackPersistedFinalizeTransaction(cwd, session.sessionId, error);
      throw error;
    }
    throw error;
  }
}

function continueFinalizeTransaction(
  sessionChecks: Pick<SessionCheckService, 'executeChecks'>,
  changeContract: ChangeContractServices,
  taskDiffReview: Pick<
    TaskDiffReviewCompletionOperations,
    | 'assertTaskDiffReviewCompletionGateSatisfied'
    | 'loadTaskDiffDocumentationReviewCapture'
  >,
  cwd: string,
  initial: FinalizeTransaction,
  environment: NodeJS.ProcessEnv,
  options: FinalizeTaskOptions,
): FinalizeTaskResult {
  let transaction = initial;
  while (true) {
    if (transaction.phase === 'projection-prepared') {
      transaction = applyPreparedFinalizeProjection(
        changeContract,
        cwd,
        transaction,
        options,
      );
      continue;
    }
    assertCandidateTransaction(transaction);
    const state = inspectFinalizeTransaction(changeContract, cwd, transaction);
    const session = state.inspection.session;
    if (transaction.phase === 'candidate-prepared') {
      if (state.indexState !== 'previous') throw transactionDiverged();
      if (transaction.checkEscalation) {
        options.onCheckEscalation?.(transaction.checkEscalation, [
          ...transaction.requiredChecks,
        ]);
      }
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        { ...transaction, phase: 'checks-running' },
      );
      maybeInterrupt(options, 'checks-running');
      const verified = sessionChecks.executeChecks({
        cwd,
        initial: state.inspection,
        checkIds: [...transaction.requiredChecks],
        environment,
        projectedTaskIds: [...transaction.completedTaskIds],
        projectionSourceDigest: transaction.projectionSourceDigest,
        authorizedTransitionPaths: [...transaction.transitionPaths],
        protectedApplyAuthorization: transaction.protectedApply,
      });
      maybeInterrupt(options, 'checks-executed');
      if (
        verified.inspection.fingerprint !== transaction.candidateFingerprint ||
        JSON.stringify(verified.inspection.git.statusEntries) !==
          JSON.stringify(transaction.candidateStatusEntries)
      ) {
        throw transactionDiverged();
      }
      const checkReportId = writeSessionReport(
        verified.inspection,
        createCheckReport(transaction, verified.inspection, verified.checks),
      );
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        { ...transaction, phase: 'checked', checkReportId },
      );
      maybeInterrupt(options, 'checked');
      continue;
    }
    if (transaction.phase === 'checks-running') {
      throw finalizeRecoveryRequired(transaction);
    }
    const checkReport = currentCheckReport(state.inspection, transaction);
    if (transaction.phase === 'checked') {
      taskDiffReview.assertTaskDiffReviewCompletionGateSatisfied(
        cwd,
        transaction.sessionId,
        {
          projectedTaskIds: transaction.completedTaskIds,
          projectionSourceDigest: transaction.projectionSourceDigest,
          authorizedTransitionPaths: transaction.transitionPaths,
          transactionId: transaction.transactionId,
          candidateTree: transaction.candidateTree,
          ...(options.consumedRoleResultReplay === undefined
            ? {}
            : {
                consumedRoleResultReplay: options.consumedRoleResultReplay,
              }),
        },
      );
      const documentationReview =
        taskDiffReview.loadTaskDiffDocumentationReviewCapture(
          cwd,
          transaction.sessionId,
        );
      if (state.indexState === 'previous') {
        stageExactPaths(
          state.inspection.git.repositoryRoot,
          session.baseline.head,
          [...transaction.changedPaths],
          {
            expectedTree: transaction.candidateTree,
            expectedPreviousIndexTree: transaction.previousIndexTree,
          },
        );
      }
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        {
          ...transaction,
          phase: 'staged',
          ...(documentationReview === null ? {} : { documentationReview }),
        },
      );
      maybeInterrupt(options, 'staged');
      continue;
    }
    if (transaction.phase === 'staged') {
      if (state.indexState !== 'candidate') throw transactionDiverged();
      const completionReportId = writeSessionReport(
        state.inspection,
        createCompletionReport(
          transaction,
          state.inspection,
          transaction.documentationReview ?? null,
        ),
      );
      const finishReportId = writeSessionReport(
        state.inspection,
        createFinishReport(
          transaction,
          state.inspection,
          checkReport,
          completionReportId,
        ),
      );
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        {
          ...transaction,
          phase: 'reports-persisted',
          completionReportId,
          finishReportId,
        },
      );
      maybeInterrupt(options, 'reports-persisted');
      continue;
    }
    if (transaction.phase === 'reports-persisted') {
      if (state.indexState !== 'candidate') throw transactionDiverged();
      const updated = finalizedSession(session, transaction);
      if (!sessionHasFinalizeReports(session, transaction)) {
        if (
          session.latestCheckReportId ||
          session.completionReportId ||
          session.finishReportId
        ) {
          throw transactionDiverged();
        }
        persistSession(state.inspection, updated);
      }
      maybeInterrupt(options, 'session-finished');
      transaction = advanceFinalizeTransaction(
        state.context.runtime.root,
        transaction,
        { ...transaction, phase: 'completed' },
      );
      continue;
    }
    if (transaction.phase === 'completed') {
      if (
        state.indexState !== 'candidate' ||
        !sessionHasFinalizeReports(session, transaction)
      ) {
        throw transactionDiverged();
      }
      return resultFrom(transaction, session);
    }
  }
}

function applyPreparedFinalizeProjection(
  changeContract: ChangeContractServices,
  cwd: string,
  transaction: FinalizeTransaction,
  options: FinalizeTaskOptions,
): CandidateFinalizeTransaction {
  const context = loadActiveSessionContext(cwd, transaction.sessionId);
  assertFinalizeTransactionIdentity(context.session, context.git, transaction);
  if (
    context.session.latestCheckReportId ||
    context.session.completionReportId ||
    context.session.finishReportId ||
    runGit(context.git.repositoryRoot, ['write-tree']).trim() !==
      transaction.previousIndexTree
  ) {
    throw transactionDiverged();
  }
  const projectionPaths = transaction.projectionMutations.map(
    ({ path: mutationPath }) => mutationPath,
  );
  assertProjectionBaseCurrent(context.git, transaction, projectionPaths);
  const taskMutation = transaction.projectionMutations.find(
    ({ path: mutationPath }) => mutationPath === transaction.taskProjectionPath,
  );
  if (!taskMutation || taskMutation.before === null) {
    throw transactionDiverged();
  }
  applyTaskProjection(
    path.join(transaction.repositoryRoot, taskMutation.path),
    taskMutation.before,
    taskMutation.after,
  );
  maybeInterrupt(options, 'task-projected');
  applyGeneratedDocumentMutations(
    transaction.repositoryRoot,
    transaction.projectionMutations
      .filter(
        ({ path: mutationPath }) =>
          mutationPath !== transaction.taskProjectionPath,
      )
      .map((mutation) => ({
        path: mutation.path,
        before: mutation.before ?? undefined,
        after: mutation.after,
      })),
  );
  maybeInterrupt(options, 'projection-applied');

  const projected = inspectSession(changeContract, cwd, transaction.sessionId, {
    expectedSession: context.session,
    projectedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    authorizedTransitionPaths: [...transaction.transitionPaths],
    ...(transaction.protectedApply === undefined
      ? {}
      : { protectedApplyAuthorization: transaction.protectedApply }),
  });
  assertProjectionBaseCurrent(projected.git, transaction, projectionPaths);
  const preview = previewExactStaging(
    projected.git.repositoryRoot,
    transaction.baseline.head,
    projected.changedPaths,
  );
  if (preview.previousIndexTree !== transaction.previousIndexTree) {
    throw transactionDiverged();
  }
  const candidate = advanceFinalizeTransaction(
    context.runtime.root,
    transaction,
    {
      ...transaction,
      phase: 'candidate-prepared',
      changedPaths: projected.changedPaths,
      candidateTree: preview.tree,
      candidateFingerprint: projected.fingerprint,
      candidateStatusEntries: projected.git.statusEntries,
    },
  );
  assertCandidateTransaction(candidate);
  maybeInterrupt(options, 'candidate-prepared');
  return candidate;
}

function assertProjectionBaseCurrent(
  git: ReturnType<typeof loadActiveSessionContext>['git'],
  transaction: FinalizeTransaction,
  projectionPaths: string[],
): void {
  if (
    fingerprintRepositoryProjectionExcludingPaths(
      git.repositoryRoot,
      transaction.baseline.head,
      git.statusEntries,
      projectionPaths,
    ) !== transaction.projectionBaseFingerprint
  ) {
    throw transactionDiverged();
  }
}

function inspectFinalizeTransaction(
  changeContract: ChangeContractServices,
  cwd: string,
  transaction: CandidateFinalizeTransaction,
) {
  const context = loadActiveSessionContext(cwd, transaction.sessionId);
  assertFinalizeTransactionIdentity(context.session, context.git, transaction);
  for (const mutation of transaction.projectionMutations) {
    if (
      readProjectionText(transaction.repositoryRoot, mutation.path) !==
      mutation.after
    ) {
      throw transactionDiverged();
    }
  }
  const inspection = inspectSession(
    changeContract,
    cwd,
    transaction.sessionId,
    {
      expectedSession: context.session,
      projectedTaskIds: [...transaction.completedTaskIds],
      projectionSourceDigest: transaction.projectionSourceDigest,
      authorizedTransitionPaths: [...transaction.transitionPaths],
      ...(transaction.protectedApply === undefined
        ? {}
        : { protectedApplyAuthorization: transaction.protectedApply }),
    },
  );
  if (
    JSON.stringify(inspection.changedPaths) !==
    JSON.stringify(transaction.changedPaths)
  ) {
    throw transactionDiverged();
  }
  const indexTree = runGit(inspection.git.repositoryRoot, [
    'write-tree',
  ]).trim();
  const unstagedState = runGit(inspection.git.repositoryRoot, [
    'diff',
    '--name-only',
    '-z',
    '--',
  ]);
  const reconstructedCandidateFingerprint =
    fingerprintUnstagedRepositoryProjection(
      inspection.git.repositoryRoot,
      transaction.baseline.head,
      [...transaction.candidateStatusEntries],
    );
  let indexState: 'previous' | 'candidate';
  if (indexTree === transaction.previousIndexTree) {
    const preview = previewExactStaging(
      inspection.git.repositoryRoot,
      transaction.baseline.head,
      [...transaction.changedPaths],
    );
    if (
      preview.tree !== transaction.candidateTree ||
      preview.previousIndexTree !== transaction.previousIndexTree ||
      inspection.fingerprint !== transaction.candidateFingerprint ||
      JSON.stringify(inspection.git.statusEntries) !==
        JSON.stringify(transaction.candidateStatusEntries)
    ) {
      throw transactionDiverged();
    }
    indexState = 'previous';
  } else if (
    indexTree === transaction.candidateTree &&
    JSON.stringify(
      listStagedPaths(inspection.git.repositoryRoot, transaction.baseline.head),
    ) === JSON.stringify(transaction.changedPaths) &&
    unstagedState === '' &&
    reconstructedCandidateFingerprint === transaction.candidateFingerprint
  ) {
    indexState = 'candidate';
  } else {
    throw transactionDiverged();
  }
  return {
    context,
    inspection,
    indexState,
    pathClassification: classifyProjectionPaths(
      [...transaction.changedPaths],
      [transaction.taskProjectionPath],
      [...transaction.transitionPaths],
    ),
  };
}

function currentCheckReport(
  inspection: ReturnType<typeof inspectSession>,
  transaction: CandidateFinalizeTransaction,
): WorkflowReport {
  if (transaction.checkReportId === null) throw transactionDiverged();
  const report = readSessionReport(inspection, transaction.checkReportId);
  assertInspectionReport(
    report,
    { ...inspection, fingerprint: transaction.candidateFingerprint },
    'check',
    'CHECK_REPORT_STALE',
    [...transaction.requiredChecks],
  );
  assertReportChecks(
    report,
    inspection,
    [...transaction.requiredChecks],
    'CHECK_REPORT_STALE',
  );
  if (
    report.parentReportId !== undefined ||
    report.finalizeProfile !== PROJECTED_SINGLE_PASS_ASSURANCE ||
    report.candidateTree !== transaction.candidateTree ||
    report.checkEscalation !== transaction.checkEscalation
  ) {
    throw transactionDiverged();
  }
  return report;
}

function rollbackPersistedFinalizeTransaction(
  cwd: string,
  sessionId: string,
  cause: unknown,
): void {
  const context = loadActiveSessionContext(cwd, sessionId);
  const transaction = readFinalizeTransaction(
    context.runtime.root,
    context.session.sessionId,
  );
  if (transaction === null) return;
  if (sessionHasFinalizeReports(context.session, transaction)) return;
  restoreFinalizeTransactionProjection(cwd, transaction, cause);
  removeFinalizeTransaction(context.runtime.root, transaction);
}

export function restoreFinalizeTransactionProjection(
  cwd: string,
  transaction: FinalizeTransaction,
  cause: unknown,
): void {
  const context = loadActiveSessionContext(cwd, transaction.sessionId);
  assertFinalizeTransactionIdentity(context.session, context.git, transaction);
  const observed = readFinalizeTransaction(
    context.runtime.root,
    transaction.sessionId,
  );
  if (
    observed === null ||
    JSON.stringify(observed) !== JSON.stringify(transaction) ||
    sessionHasFinalizeReports(context.session, transaction)
  ) {
    throw transactionDiverged();
  }
  const indexTree = runGit(context.git.repositoryRoot, ['write-tree']).trim();
  if (indexTree === transaction.candidateTree) {
    rollbackExactStaging(
      context.git.repositoryRoot,
      transaction.previousIndexTree,
      transaction.candidateTree,
      cause,
    );
  } else if (indexTree !== transaction.previousIndexTree) {
    throw transactionDiverged();
  }
  for (const mutation of [...transaction.projectionMutations].reverse()) {
    const current = readProjectionText(
      transaction.repositoryRoot,
      mutation.path,
    );
    if (current === mutation.before) continue;
    if (current !== mutation.after) throw transactionDiverged();
    const target = path.join(transaction.repositoryRoot, mutation.path);
    if (mutation.path === transaction.taskProjectionPath) {
      if (mutation.before === null) throw transactionDiverged();
      restoreTaskProjection(target, mutation.after, mutation.before);
    } else if (mutation.before === null) {
      fs.rmSync(target, { force: true });
    } else {
      fs.writeFileSync(target, mutation.before, 'utf8');
    }
  }
}

function readProjectionText(
  repositoryRoot: string,
  relativePath: string,
): string | null {
  const target = path.join(repositoryRoot, relativePath);
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw transactionDiverged();
  }
  return fs.readFileSync(target, 'utf8');
}

function maybeInterrupt(
  options: FinalizeTaskOptions,
  phase: FinalizeTaskOptions['testCrashAfter'],
): void {
  if (options.testCrashAfter === phase) {
    throw new SimulatedFinalizeInterruption(String(phase));
  }
}

function preservesFinalizeTransaction(error: unknown): boolean {
  return (
    error instanceof SimulatedFinalizeInterruption ||
    (error instanceof WorkflowError &&
      [
        'FINALIZE_RECOVERY_REQUIRED',
        'TASK_DIFF_REVIEW_REQUIRED',
        'TASK_DIFF_REVIEW_CHALLENGE_OPEN',
        'TASK_DIFF_REVIEW_CHANGES_REQUIRED',
      ].includes(error.code))
  );
}

function finalizeRecoveryRequired(transaction: FinalizeTransaction) {
  return workflowError(
    'FINALIZE_RECOVERY_REQUIRED',
    'Finalize check execution may have crossed an interruption boundary; automatic retry will not duplicate it.',
    ExitCode.staleState,
    {
      details: {
        transactionId: transaction.transactionId,
        phase: transaction.phase,
      },
      recovery:
        'Inspect the durable finalize transaction and explicitly cancel or reconcile it before retrying.',
    },
  );
}

class SimulatedFinalizeInterruption extends Error {
  constructor(phase: string) {
    super(`Simulated finalize interruption after ${phase}.`);
  }
}
