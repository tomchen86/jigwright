import type { TaskSessionReference } from '@jigwright/core/workflow-identifiers';
import type { ValidatedChangeContract } from './validated-change-contract.ts';
/** Pure task-strategy evidence predicates. Repository observations are supplied at their original operation boundaries. */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { matchesAllowedPath } from '../../foundation/repository-path/repository-path.ts';
import type {
  CrossAgentTddExecution,
  TddSingleAgentExecution,
} from '../planning-provider/planning-artifact-types.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyFrozenFile,
  TaskStrategyPatchRecord,
  TaskStrategyPatchImportReceipt,
  TaskStrategyPatchReservation,
  TaskStrategyPatchCurrentBinding,
  TaskStrategyImplementationResultBinding,
  TaskStrategyCallerImplementationBinding,
} from './task-strategy-evidence.ts';
import type { TaskStrategyGreenFailureRecord } from '../provider-orchestration/task-strategy-correction-record.ts';
import type {
  CheckEvidence,
  ObservedCheckFailure,
} from '../../foundation/check-evidence/check-evidence.ts';
export type TaskStrategyGateTask =
  CrossAgentTddExecution | TddSingleAgentExecution;
export type TaskStrategyGateIdentity = {
  session: Omit<TaskSessionReference, 'baseline'> & {
    baseline: Readonly<TaskSessionReference['baseline']>;
  };
};
export type TaskStrategyPatchEvidence = {
  binding: TaskStrategyPatchCurrentBinding | null;
  record: TaskStrategyPatchRecord | null;
  receipt: TaskStrategyPatchImportReceipt | null;
  reservation: TaskStrategyPatchReservation | null;
};
export type TaskStrategyImplementationAuthorityEvidence = {
  implementationResult: TaskStrategyImplementationResultBinding | null;
  callerImplementationResult: TaskStrategyCallerImplementationBinding | null;
};
export type TaskStrategyGateObservations = {
  readTransaction(): TaskStrategyTransaction | null;
  previewTree(
    baselineHead: string,
    changedPaths: readonly string[],
  ): { tree: string };
  readFrozenFiles(
    tree: string,
    paths: readonly string[],
  ): TaskStrategyFrozenFile[];
  readPatchEvidence(
    sourceTree: string,
    patchDigest: string,
  ): TaskStrategyPatchEvidence;
  readCorrectionFailure(
    sourceTree: string,
  ): TaskStrategyGreenFailureRecord | null;
  readImplementationAuthority(
    subjectDigest: string,
  ): TaskStrategyImplementationAuthorityEvidence;
};
export function assertTaskStrategyRedTransactionCurrent(
  inspection: TaskStrategyGateIdentity,
  task: TaskStrategyGateTask,
  transaction: TaskStrategyTransaction | null,
): asserts transaction is TaskStrategyTransaction {
  if (transaction === null) {
    throw workflowError(
      'TASK_STRATEGY_RED_REQUIRED',
      'The task cannot run GREEN checks until the engine seals exact RED evidence.',
      ExitCode.verification,
      {
        recovery:
          'Seal the strategy RED transaction with the registered failing check before implementation.',
      },
    );
  }
  if (
    transaction.changeId !== inspection.session.changeId ||
    transaction.taskId !== inspection.session.taskId ||
    transaction.strategy !== task.strategy ||
    canonicalJson(transaction.baseline) !==
      canonicalJson(inspection.session.baseline) ||
    transaction.taskContractDigest !== sha256(canonicalJson(task))
  ) {
    throw redStale();
  }
}
export function assertTaskStrategyCorrectionCurrent(
  transaction: TaskStrategyTransaction,
  correction: {
    transaction: { recordDigest: string };
    failure: TaskStrategyGreenFailureRecord | null;
  },
): void {
  if (correction.transaction.recordDigest !== transaction.recordDigest) {
    throw redStale();
  }
  if (correction.failure !== null) {
    throw workflowError(
      'TASK_STRATEGY_CORRECTION_REQUIRED',
      'GREEN checks cannot run while the latest imported candidate has an unresolved engine-observed failure.',
      ExitCode.verification,
      {
        recovery: `pnpm workflow resume ${transaction.sessionId} --json`,
      },
    );
  }
}
export function requireTaskStrategyPatchHead<T>(
  head: T | null,
): asserts head is T {
  if (head === null) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_REQUIRED',
      'GREEN checks require one engine-validated and durably imported implementation patch.',
      ExitCode.verification,
      {
        recovery:
          'Import the exact provider patch through the task strategy transaction before rerunning checks.',
      },
    );
  }
}
export function assertCurrentTaskStrategyPatch(
  inspection: TaskStrategyGateIdentity,
  task: TaskStrategyGateTask,
  transaction: TaskStrategyTransaction,
  preview: { tree: string },
  head: {
    binding: TaskStrategyPatchCurrentBinding;
    record: TaskStrategyPatchRecord;
    receipt: TaskStrategyPatchImportReceipt;
  },
  sourceTree: string,
  evidence: TaskStrategyPatchEvidence,
  authority: TaskStrategyImplementationAuthorityEvidence,
): void {
  const { binding, record, receipt, reservation } = evidence;
  const { implementationResult, callerImplementationResult } = authority;
  const {
    sameProviderDegradationCurrent,
    ordinarySessionIndependenceCurrent,
    callerDegradationCurrent,
  } = currentImplementationAuthorityBindings({
    record,
    implementationResult,
    callerImplementationResult,
    sourceTree,
    transaction,
  });
  if (
    record === null ||
    receipt === null ||
    binding === null ||
    reservation === null ||
    binding.bindingDigest !== head.binding.bindingDigest ||
    record.recordDigest !== head.record.recordDigest ||
    receipt.receiptDigest !== head.receipt.receiptDigest ||
    record.sessionId !== inspection.session.sessionId ||
    record.changeId !== inspection.session.changeId ||
    record.taskId !== inspection.session.taskId ||
    record.strategy !== task.strategy ||
    record.sourceTree !== sourceTree ||
    record.taskContractDigest !== sha256(canonicalJson(task)) ||
    reservation.patchDigest !== record.patchDigest ||
    reservation.recordDigest !== record.recordDigest ||
    reservation.sourceTree !== record.sourceTree ||
    reservation.candidateTree !== record.candidateTree ||
    reservation.createdAt !== record.createdAt ||
    receipt.recordDigest !== record.recordDigest ||
    receipt.patchDigest !== record.patchDigest ||
    receipt.candidateTree !== record.candidateTree ||
    binding.patchDigest !== record.patchDigest ||
    binding.recordDigest !== record.recordDigest ||
    binding.receiptDigest !== receipt.receiptDigest ||
    binding.candidateTree !== record.candidateTree ||
    binding.createdAt !== receipt.importedAt ||
    preview.tree !== record.candidateTree ||
    (record.implementer.providerId === null && !callerDegradationCurrent) ||
    (task.strategy === 'tdd-single-agent' &&
      canonicalJson(record.implementer) !==
        canonicalJson(transaction.author)) ||
    (task.strategy === 'cross-agent-tdd' &&
      record.implementer.providerId === transaction.author.providerId &&
      !ordinarySessionIndependenceCurrent &&
      !sameProviderDegradationCurrent)
  ) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_STALE',
      'The imported implementation patch is missing, stale, or not bound to the current strategy authority.',
      ExitCode.staleState,
    );
  }
}

export function classifyCurrentRedPaths(
  changedPaths: readonly string[],
  task: CrossAgentTddExecution | TddSingleAgentExecution,
): { testPaths: string[]; fixturePaths: string[] } {
  const testPaths: string[] = [];
  const fixturePaths: string[] = [];
  for (const changedPath of changedPaths) {
    if (
      task.fixturePathScopes.some((scope) =>
        matchesAllowedPath(changedPath, scope),
      )
    ) {
      fixturePaths.push(changedPath);
    } else if (
      task.testPathScopes.some((scope) =>
        matchesAllowedPath(changedPath, scope),
      )
    ) {
      testPaths.push(changedPath);
    }
  }
  return { testPaths: testPaths.sort(), fixturePaths: fixturePaths.sort() };
}
export function redStale() {
  return workflowError(
    'TASK_STRATEGY_RED_STALE',
    'The sealed RED transaction no longer matches the exact task or frozen test and fixture bytes.',
    ExitCode.staleState,
  );
}
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
export function currentImplementationAuthorityBindings(input: {
  record: TaskStrategyPatchRecord | null;
  implementationResult: TaskStrategyImplementationResultBinding | null;
  callerImplementationResult: TaskStrategyCallerImplementationBinding | null;
  sourceTree: string;
  transaction: TaskStrategyTransaction;
}): {
  sameProviderDegradationCurrent: boolean;
  ordinarySessionIndependenceCurrent: boolean;
  callerDegradationCurrent: boolean;
} {
  const {
    record,
    implementationResult,
    callerImplementationResult,
    sourceTree,
    transaction,
  } = input;
  const sameProviderDegradationCurrent =
    implementationResult !== null &&
    implementationResult.output.patchDigest === record?.patchDigest &&
    implementationResult.output.sourceTree === sourceTree &&
    implementationResult.roleResult.form === 'granted-same-provider' &&
    implementationResult.roleResult.grantUse?.degradedForm ===
      'same-provider-fresh-session' &&
    implementationResult.roleResult.grantUse.targetDigest ===
      implementationResult.subjectDigest &&
    implementationResult.roleResult.assignment.providerId ===
      record?.implementer.providerId;
  const ordinarySessionIndependenceCurrent =
    implementationResult !== null &&
    implementationResult.output.patchDigest === record?.patchDigest &&
    implementationResult.output.sourceTree === sourceTree &&
    implementationResult.roleResult.form === 'ordinary-provider' &&
    implementationResult.roleResult.grantUse === null &&
    implementationResult.roleResult.assignment.providerId ===
      record?.implementer.providerId &&
    implementationResult.roleResult.assignment.sessionId !== null &&
    implementationResult.roleResult.assignment.sessionId !==
      transaction.sessionId &&
    implementationResult.roleResult.assignment.requiredIndependence ===
      'session-independent' &&
    (implementationResult.roleResult.assignment.achievedIndependence ===
      'session-independent' ||
      implementationResult.roleResult.assignment.achievedIndependence ===
        'provider-independent');
  const callerDegradationCurrent =
    record?.implementer.providerId === null &&
    callerImplementationResult !== null &&
    callerImplementationResult.output.patchDigest === record.patchDigest &&
    callerImplementationResult.output.sourceTree === sourceTree &&
    callerImplementationResult.subjectDigest ===
      callerImplementationResult.roleResult.targetDigest &&
    callerImplementationResult.roleResult.form === 'granted-caller-supplied' &&
    callerImplementationResult.roleResult.orchestration === 'caller-supplied' &&
    callerImplementationResult.roleResult.providerInvocation === null &&
    callerImplementationResult.roleResult.directHumanReviewAttestation ===
      null &&
    callerImplementationResult.roleResult.assignment.providerId === null &&
    callerImplementationResult.roleResult.assignment.sessionId === null &&
    'grantId' in callerImplementationResult.roleResult.assignment &&
    callerImplementationResult.roleResult.assignment.grantId ===
      record.implementer.grantId &&
    callerImplementationResult.roleResult.assignment.degradedForm ===
      'caller-supplied' &&
    callerImplementationResult.roleResult.participant.providerId === null &&
    callerImplementationResult.roleResult.participant.sessionId === null &&
    callerImplementationResult.roleResult.participant.principalId ===
      record.implementer.principalId &&
    callerImplementationResult.roleResult.participant.identityAssurance ===
      record.implementer.assurance &&
    callerImplementationResult.roleResult.participant.engineSpawned === false &&
    callerImplementationResult.roleResult.grantUse?.grantId ===
      record.implementer.grantId &&
    callerImplementationResult.roleResult.grantUse.degradedForm ===
      'caller-supplied' &&
    callerImplementationResult.roleResult.grantUse.targetDigest ===
      callerImplementationResult.subjectDigest &&
    callerImplementationResult.roleResult.grantUse.structuredContent.kind ===
      'task-implementation' &&
    callerImplementationResult.roleResult.grantUse.structuredContent.nodeId ===
      callerImplementationResult.submissionNodeId &&
    callerImplementationResult.roleResult.grantUse.structuredContent
      .resultDigest === callerImplementationResult.submissionResultDigest;
  return {
    sameProviderDegradationCurrent,
    ordinarySessionIndependenceCurrent,
    callerDegradationCurrent,
  };
}
export function assertCurrentRedPaths(
  currentRedPaths: { testPaths: string[]; fixturePaths: string[] },
  transaction: TaskStrategyTransaction,
): void {
  if (
    canonicalJson(currentRedPaths.testPaths) !==
      canonicalJson(transaction.red.testPaths) ||
    canonicalJson(currentRedPaths.fixturePaths) !==
      canonicalJson(transaction.red.fixturePaths)
  )
    throw redStale();
}
export function assertCurrentFrozenFiles(
  files: readonly TaskStrategyFrozenFile[],
  transaction: TaskStrategyTransaction,
): void {
  if (canonicalJson(files) !== canonicalJson(transaction.red.files))
    throw redStale();
}
export function parseTaskStrategyFrozenFile(
  candidatePath: string,
  output: string,
): TaskStrategyFrozenFile {
  const match =
    /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
      output,
    );
  if (!match || match[3] !== candidatePath) throw redStale();
  return {
    path: candidatePath,
    mode: match[1] as TaskStrategyFrozenFile['mode'],
    objectId: match[2]!,
  };
}
export function requireCorrectionFailureRecord(
  failure: TaskStrategyGreenFailureRecord | null,
): TaskStrategyGreenFailureRecord {
  if (failure === null) {
    throw workflowError(
      'TASK_STRATEGY_PATCH_STALE',
      'The latest correction patch is not bound to its exact preceding engine-observed GREEN failure.',
      ExitCode.staleState,
    );
  }
  return failure;
}

export type TaskStrategyGateInspection = TaskStrategyGateIdentity & {
  contract: Pick<ValidatedChangeContract, 'execution'>;
  changedPaths: readonly string[];
};
/**
 * Finalize's port into task-strategy evidence: admission before required
 * checks run, and the GREEN failure ledger entry written when one fails.
 */
export type TaskStrategyExecutionGate<Inspection> = Readonly<{
  assertExecutionAdmitted(
    inspection: Inspection,
    environment: NodeJS.ProcessEnv,
  ): void;
  recordGreenFailure(
    inspection: Inspection,
    passedChecks: readonly CheckEvidence[],
    failingCheck: ObservedCheckFailure,
  ): TaskStrategyGreenFailureRecord | null;
}>;
export type TaskStrategyGateCorrectionEvidence = {
  transaction: TaskStrategyTransaction;
  head: {
    binding: TaskStrategyPatchCurrentBinding;
    record: TaskStrategyPatchRecord;
    receipt: TaskStrategyPatchImportReceipt;
  } | null;
  failure: TaskStrategyGreenFailureRecord | null;
  completedCorrectionRounds: number;
};
