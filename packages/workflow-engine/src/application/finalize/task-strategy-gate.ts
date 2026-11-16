/**
 * Finalize's task-strategy evidence port: admission checks in their required
 * order, plus the GREEN failure ledger entry recorded when a check fails.
 */
import {
  assertTaskStrategyRedTransactionCurrent,
  classifyCurrentRedPaths,
  assertCurrentRedPaths,
  assertCurrentFrozenFiles,
  assertTaskStrategyCorrectionCurrent,
  requireTaskStrategyPatchHead,
  assertCurrentTaskStrategyPatch,
  requireCorrectionFailureRecord,
  type TaskStrategyGateObservations,
  type TaskStrategyGateInspection,
  type TaskStrategyExecutionGate,
  type TaskStrategyGateCorrectionEvidence,
} from '../../modules/assurance/task-strategy-gate.ts';
import {
  createTaskStrategyImplementationSubject,
  createTaskStrategyCorrectionSubject,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
export function createTaskStrategyExecutionGate<
  Inspection extends TaskStrategyGateInspection,
>(services: {
  observeRepository(inspection: Inspection): TaskStrategyGateObservations;
  resolveCorrection(inspection: Inspection): TaskStrategyGateCorrectionEvidence;
  assertMechanicalEvidence(inspection: Inspection): void;
  recordGreenFailure: TaskStrategyExecutionGate<Inspection>['recordGreenFailure'];
}): TaskStrategyExecutionGate<Inspection> {
  function assertExecutionAdmitted(
    inspection: Inspection,
    _environment: NodeJS.ProcessEnv,
  ): void {
    const task =
      inspection.contract.execution?.tasks[inspection.session.taskId];
    if (task?.strategy === 'mechanical-transform') {
      services.assertMechanicalEvidence(inspection);
      return;
    }
    if (
      task?.strategy !== 'cross-agent-tdd' &&
      task?.strategy !== 'tdd-single-agent'
    ) {
      return;
    }
    const observations = services.observeRepository(inspection);
    const transaction = observations.readTransaction();
    assertTaskStrategyRedTransactionCurrent(inspection, task, transaction);
    const preview = observations.previewTree(
      inspection.session.baseline.head,
      inspection.changedPaths,
    );
    const currentRedPaths = classifyCurrentRedPaths(
      inspection.changedPaths,
      task,
    );
    assertCurrentRedPaths(currentRedPaths, transaction);
    assertCurrentFrozenFiles(
      observations.readFrozenFiles(
        preview.tree,
        transaction.red.files.map(({ path }) => path),
      ),
      transaction,
    );
    const initialImplementationSubject =
      createTaskStrategyImplementationSubject({
        sessionId: transaction.sessionId,
        changeId: transaction.changeId,
        taskId: transaction.taskId,
        strategy: transaction.strategy,
        transactionDigest: transaction.recordDigest,
        taskContractDigest: transaction.taskContractDigest,
        sourceTree: transaction.red.candidateTree,
        failureFingerprint: transaction.red.failureFingerprint,
        redEvidenceNodeId: transaction.red.evidenceNodeId,
        redEvidenceResultDigest: transaction.red.evidenceResultDigest,
        testPaths: transaction.red.testPaths,
        fixturePaths: transaction.red.fixturePaths,
        frozenFiles: transaction.red.files,
      });
    const correction = services.resolveCorrection(inspection);
    assertTaskStrategyCorrectionCurrent(transaction, correction);
    const head = correction.head;
    requireTaskStrategyPatchHead(head);
    const sourceTree = head.record.sourceTree;
    const evidence = observations.readPatchEvidence(
      sourceTree,
      head.record.patchDigest,
    );
    const implementationSubject =
      correction.completedCorrectionRounds === 0
        ? initialImplementationSubject
        : createTaskStrategyCorrectionSubject({
            subject: initialImplementationSubject,
            round: correction.completedCorrectionRounds,
            greenFailureRecord: requireCorrectionFailureRecord(
              observations.readCorrectionFailure(sourceTree),
            ),
          });
    const authority = observations.readImplementationAuthority(
      implementationSubject.subjectDigest,
    );
    assertCurrentTaskStrategyPatch(
      inspection,
      task,
      transaction,
      preview,
      head,
      sourceTree,
      evidence,
      authority,
    );
  }
  return {
    assertExecutionAdmitted,
    recordGreenFailure: services.recordGreenFailure,
  };
}
