/** Canonical finalize transaction records, digests and phase admission. */
import path from 'node:path';
import crypto from 'node:crypto';
import type { FinalizeCheckEscalation } from '../assurance/finalize-check-policy.ts';
import {
  type DocumentationReviewCapture,
  parseDocumentationReviewCapture,
} from '../assurance/documentation-closure.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

export type FinalizeTransactionPhase =
  | 'projection-prepared'
  | 'candidate-prepared'
  | 'checks-running'
  | 'checked'
  | 'staged'
  | 'reports-persisted'
  | 'completed';

export type FinalizeProjectionMutation = Readonly<{
  path: string;
  before: string | null;
  after: string;
}>;

export type FinalizeReconciledTask = Readonly<{
  taskId: string;
  commitHash: string;
  changedPaths: readonly string[];
  checks: readonly unknown[];
}>;

export type ProtectedTaskApplyAuthorizationBinding = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-authorization.v1';
  transitionId: 'task.protected-apply.finalize.v1';
  challengeId: string;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
  stateBindingDigest: `sha256:${string}`;
  parametersDigest: `sha256:${string}`;
  commitMessage: string;
}>;

export type FinalizeTransaction = Readonly<{
  schemaVersion: 2;
  kind: 'projected-finalize-transaction.v2';
  transactionId: string;
  recordDigest: string;
  phase: FinalizeTransactionPhase;
  sessionId: string;
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  completedTaskIds: readonly string[];
  requiredChecks: readonly string[];
  checkEscalation: FinalizeCheckEscalation;
  reconciledTasks: readonly FinalizeReconciledTask[];
  taskProjectionPath: string;
  projectionMutations: readonly FinalizeProjectionMutation[];
  projectionSourceDigest: string;
  projectionBaseFingerprint: string;
  transitionPaths: readonly string[];
  changedPaths: readonly string[];
  candidateTree: string | null;
  candidateFingerprint: string | null;
  candidateStatusEntries: readonly string[];
  previousIndexTree: string;
  createdAt: string;
  checkReportId: string | null;
  completionReportId: string | null;
  finishReportId: string | null;
  documentationReview?: DocumentationReviewCapture;
  protectedApply?: ProtectedTaskApplyAuthorizationBinding;
}>;

const DIGEST = /^[0-9a-f]{64}$/;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type FinalizeTransactionSeed = Readonly<{
  schemaVersion: 2;
  kind: 'projected-finalize-transaction.v2';
  sessionId: string;
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  completedTaskIds: readonly string[];
  requiredChecks: readonly string[];
  checkEscalation: FinalizeCheckEscalation;
  reconciledTasks: readonly FinalizeReconciledTask[];
  taskProjectionPath: string;
  projectionMutations: readonly FinalizeProjectionMutation[];
  projectionSourceDigest: string;
  projectionBaseFingerprint: string;
  transitionPaths: readonly string[];
  previousIndexTree: string;
  createdAt: string;
  protectedApply?: ProtectedTaskApplyAuthorizationBinding;
}>;

export function createFinalizeTransaction(
  input: FinalizeTransactionSeed,
): FinalizeTransaction {
  if (
    input.schemaVersion !== 2 ||
    input.kind !== 'projected-finalize-transaction.v2' ||
    !isCanonicalCheckArray(input.requiredChecks) ||
    !isFinalizeCheckEscalation(input.checkEscalation)
  ) {
    throw malformed();
  }
  const seed = normalizeSeed(input);
  return sealFinalizeTransaction({
    ...seed,
    transactionId: digestSeed(seed),
    phase: 'projection-prepared',
    changedPaths: [],
    candidateTree: null,
    candidateFingerprint: null,
    candidateStatusEntries: [],
    checkReportId: null,
    completionReportId: null,
    finishReportId: null,
  });
}

export function parseFinalizeTransaction(value: unknown): FinalizeTransaction {
  if (!isRecord(value)) throw malformed();
  const baseKeys = [
    'baseline',
    'branch',
    'candidateFingerprint',
    'candidateStatusEntries',
    'candidateTree',
    'changeId',
    'changedPaths',
    'checkReportId',
    'completedTaskIds',
    'completionReportId',
    'createdAt',
    'finishReportId',
    'gitCommonDirectory',
    'kind',
    'phase',
    'previousIndexTree',
    'projectionMutations',
    'projectionBaseFingerprint',
    'projectionSourceDigest',
    'recordDigest',
    'reconciledTasks',
    'repositoryRoot',
    'schemaVersion',
    'sessionId',
    'taskId',
    'taskProjectionPath',
    'transactionId',
    'transitionPaths',
    'checkEscalation',
    'requiredChecks',
  ].sort();
  const optionalKeys = [
    ...(Object.hasOwn(value, 'documentationReview')
      ? ['documentationReview']
      : []),
    ...(Object.hasOwn(value, 'protectedApply') ? ['protectedApply'] : []),
  ];
  const keys = [...baseKeys, ...optionalKeys].sort();
  if (
    value.schemaVersion !== 2 ||
    value.kind !== 'projected-finalize-transaction.v2' ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    typeof value.transactionId !== 'string' ||
    !DIGEST.test(value.transactionId) ||
    typeof value.recordDigest !== 'string' ||
    !DIGEST.test(value.recordDigest) ||
    ![
      'projection-prepared',
      'candidate-prepared',
      'checks-running',
      'checked',
      'staged',
      'reports-persisted',
      'completed',
    ].includes(String(value.phase)) ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.gitCommonDirectory !== 'string' ||
    !path.isAbsolute(value.repositoryRoot) ||
    !path.isAbsolute(value.gitCommonDirectory) ||
    path.normalize(value.repositoryRoot) !== value.repositoryRoot ||
    path.normalize(value.gitCommonDirectory) !== value.gitCommonDirectory ||
    typeof value.branch !== 'string' ||
    !isRecord(value.baseline) ||
    JSON.stringify(Object.keys(value.baseline).sort()) !==
      JSON.stringify(['head', 'tree']) ||
    typeof value.baseline.head !== 'string' ||
    typeof value.baseline.tree !== 'string' ||
    !OBJECT_ID.test(value.baseline.head) ||
    !OBJECT_ID.test(value.baseline.tree) ||
    !isCanonicalStringArray(value.completedTaskIds) ||
    !isCanonicalCheckArray(value.requiredChecks) ||
    !isFinalizeCheckEscalation(value.checkEscalation) ||
    !Array.isArray(value.reconciledTasks) ||
    typeof value.taskProjectionPath !== 'string' ||
    !isSafeRelativePath(value.taskProjectionPath) ||
    !Array.isArray(value.projectionMutations) ||
    value.projectionMutations.length === 0 ||
    typeof value.projectionSourceDigest !== 'string' ||
    !DIGEST.test(value.projectionSourceDigest) ||
    typeof value.projectionBaseFingerprint !== 'string' ||
    !DIGEST.test(value.projectionBaseFingerprint) ||
    !isCanonicalPathArray(value.transitionPaths) ||
    !isCanonicalPathArray(value.changedPaths) ||
    !isNullableObjectId(value.candidateTree) ||
    !isNullableDigest(value.candidateFingerprint) ||
    !isStringArray(value.candidateStatusEntries) ||
    typeof value.previousIndexTree !== 'string' ||
    !OBJECT_ID.test(value.previousIndexTree) ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !isNullableDigest(value.checkReportId) ||
    !isNullableDigest(value.completionReportId) ||
    !isNullableDigest(value.finishReportId)
  ) {
    throw malformed();
  }
  const projectionMutations = value.projectionMutations.map((mutation) => {
    if (
      !isRecord(mutation) ||
      JSON.stringify(Object.keys(mutation).sort()) !==
        JSON.stringify(['after', 'before', 'path']) ||
      typeof mutation.path !== 'string' ||
      !isSafeRelativePath(mutation.path) ||
      (mutation.before !== null && typeof mutation.before !== 'string') ||
      typeof mutation.after !== 'string'
    ) {
      throw malformed();
    }
    return {
      path: mutation.path,
      before: mutation.before as string | null,
      after: mutation.after,
    };
  });
  const reconciledTasks = value.reconciledTasks.map((entry) => {
    if (
      !isRecord(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(['changedPaths', 'checks', 'commitHash', 'taskId']) ||
      typeof entry.taskId !== 'string' ||
      !entry.taskId ||
      typeof entry.commitHash !== 'string' ||
      !OBJECT_ID.test(entry.commitHash) ||
      !isCanonicalPathArray(entry.changedPaths) ||
      !Array.isArray(entry.checks) ||
      entry.checks.some((check) => !isRecord(check))
    ) {
      throw malformed();
    }
    return {
      taskId: entry.taskId,
      commitHash: entry.commitHash,
      changedPaths: [...entry.changedPaths],
      checks: entry.checks.map((check) => ({ ...check })),
    };
  });
  let documentationReview: DocumentationReviewCapture | undefined;
  if (Object.hasOwn(value, 'documentationReview')) {
    try {
      documentationReview = parseDocumentationReviewCapture(
        value.documentationReview,
      );
    } catch {
      throw malformed();
    }
  }
  const protectedApply = Object.hasOwn(value, 'protectedApply')
    ? parseProtectedTaskApplyAuthorizationBinding(value.protectedApply)
    : undefined;
  if (
    !isCanonicalPathArray(projectionMutations.map((entry) => entry.path)) ||
    !projectionMutations.some(
      (entry) => entry.path === value.taskProjectionPath,
    ) ||
    JSON.stringify(value.transitionPaths) !==
      JSON.stringify(
        projectionMutations
          .map((entry) => entry.path)
          .filter((entry) => entry !== value.taskProjectionPath),
      ) ||
    !phaseCandidateStateIsValid(
      value.phase as FinalizeTransactionPhase,
      value.changedPaths as string[],
      value.candidateTree as string | null,
      value.candidateFingerprint as string | null,
      value.candidateStatusEntries as string[],
    ) ||
    !phaseReportIdsAreValid(
      value.phase as FinalizeTransactionPhase,
      value.checkReportId as string | null,
      value.completionReportId as string | null,
      value.finishReportId as string | null,
    )
  ) {
    throw malformed();
  }
  const transaction: FinalizeTransaction = {
    schemaVersion: 2,
    kind: 'projected-finalize-transaction.v2',
    transactionId: value.transactionId,
    recordDigest: value.recordDigest,
    phase: value.phase as FinalizeTransactionPhase,
    sessionId: value.sessionId,
    changeId: value.changeId,
    taskId: value.taskId,
    repositoryRoot: value.repositoryRoot,
    gitCommonDirectory: value.gitCommonDirectory,
    branch: value.branch,
    baseline: {
      head: value.baseline.head,
      tree: value.baseline.tree,
    },
    completedTaskIds: [...value.completedTaskIds] as string[],
    requiredChecks: [...(value.requiredChecks as string[])],
    checkEscalation: value.checkEscalation as FinalizeCheckEscalation,
    reconciledTasks,
    taskProjectionPath: value.taskProjectionPath,
    projectionMutations,
    projectionSourceDigest: value.projectionSourceDigest,
    projectionBaseFingerprint: value.projectionBaseFingerprint,
    transitionPaths: [...value.transitionPaths] as string[],
    changedPaths: [...value.changedPaths] as string[],
    candidateTree: value.candidateTree as string | null,
    candidateFingerprint: value.candidateFingerprint as string | null,
    candidateStatusEntries: [...value.candidateStatusEntries] as string[],
    previousIndexTree: value.previousIndexTree,
    createdAt: value.createdAt,
    checkReportId: value.checkReportId as string | null,
    completionReportId: value.completionReportId as string | null,
    finishReportId: value.finishReportId as string | null,
    ...(documentationReview === undefined ? {} : { documentationReview }),
    ...(protectedApply === undefined ? {} : { protectedApply }),
  };
  const seed = transactionSeed(transaction);
  if (
    digestSeed(seed) !== transaction.transactionId ||
    digestRecord(recordWithoutDigest(transaction)) !== transaction.recordDigest
  ) {
    throw malformed();
  }
  return transaction;
}

function normalizeSeed(
  input: FinalizeTransactionSeed,
): FinalizeTransactionSeed {
  return {
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    sessionId: input.sessionId,
    changeId: input.changeId,
    taskId: input.taskId,
    repositoryRoot: input.repositoryRoot,
    gitCommonDirectory: input.gitCommonDirectory,
    branch: input.branch,
    baseline: { ...input.baseline },
    completedTaskIds: [...input.completedTaskIds],
    requiredChecks: [...input.requiredChecks],
    checkEscalation: input.checkEscalation,
    reconciledTasks: input.reconciledTasks.map((entry) => ({
      taskId: entry.taskId,
      commitHash: entry.commitHash,
      changedPaths: [...entry.changedPaths],
      checks: entry.checks.map((check) =>
        isRecord(check) ? { ...check } : check,
      ),
    })),
    taskProjectionPath: input.taskProjectionPath,
    projectionMutations: input.projectionMutations.map((mutation) => ({
      ...mutation,
    })),
    projectionSourceDigest: input.projectionSourceDigest,
    projectionBaseFingerprint: input.projectionBaseFingerprint,
    transitionPaths: [...input.transitionPaths],
    previousIndexTree: input.previousIndexTree,
    createdAt: input.createdAt,
    ...(input.protectedApply === undefined
      ? {}
      : {
          protectedApply: parseProtectedTaskApplyAuthorizationBinding(
            input.protectedApply,
          ),
        }),
  };
}

function transactionSeed(
  transaction: FinalizeTransaction,
): FinalizeTransactionSeed {
  return normalizeSeed({
    schemaVersion: transaction.schemaVersion,
    kind: transaction.kind,
    sessionId: transaction.sessionId,
    changeId: transaction.changeId,
    taskId: transaction.taskId,
    repositoryRoot: transaction.repositoryRoot,
    gitCommonDirectory: transaction.gitCommonDirectory,
    branch: transaction.branch,
    baseline: transaction.baseline,
    completedTaskIds: transaction.completedTaskIds,
    requiredChecks: transaction.requiredChecks,
    checkEscalation: transaction.checkEscalation,
    reconciledTasks: transaction.reconciledTasks,
    taskProjectionPath: transaction.taskProjectionPath,
    projectionMutations: transaction.projectionMutations,
    projectionSourceDigest: transaction.projectionSourceDigest,
    projectionBaseFingerprint: transaction.projectionBaseFingerprint,
    transitionPaths: transaction.transitionPaths,
    previousIndexTree: transaction.previousIndexTree,
    createdAt: transaction.createdAt,
    ...(transaction.protectedApply === undefined
      ? {}
      : { protectedApply: transaction.protectedApply }),
  });
}

export function parseProtectedTaskApplyAuthorizationBinding(
  value: unknown,
): ProtectedTaskApplyAuthorizationBinding {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          'approvalSubjectDigest',
          'challengeId',
          'commitMessage',
          'kind',
          'operationId',
          'parametersDigest',
          'schemaVersion',
          'stateBindingDigest',
          'transitionId',
        ].sort(),
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-task-apply-authorization.v1' ||
    value.transitionId !== 'task.protected-apply.finalize.v1' ||
    typeof value.challengeId !== 'string' ||
    !UUID_V4.test(value.challengeId) ||
    typeof value.operationId !== 'string' ||
    !UUID_V4.test(value.operationId) ||
    typeof value.approvalSubjectDigest !== 'string' ||
    !SHA256_DIGEST.test(value.approvalSubjectDigest) ||
    typeof value.stateBindingDigest !== 'string' ||
    !SHA256_DIGEST.test(value.stateBindingDigest) ||
    typeof value.parametersDigest !== 'string' ||
    !SHA256_DIGEST.test(value.parametersDigest) ||
    typeof value.commitMessage !== 'string' ||
    value.commitMessage.length === 0 ||
    value.commitMessage.trim() !== value.commitMessage ||
    Buffer.byteLength(value.commitMessage) > 4096 ||
    /\p{Cc}/u.test(value.commitMessage)
  ) {
    throw malformed();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-authorization.v1',
    transitionId: 'task.protected-apply.finalize.v1',
    challengeId: value.challengeId,
    operationId: value.operationId,
    approvalSubjectDigest: value.approvalSubjectDigest as `sha256:${string}`,
    stateBindingDigest: value.stateBindingDigest as `sha256:${string}`,
    parametersDigest: value.parametersDigest as `sha256:${string}`,
    commitMessage: value.commitMessage,
  });
}

function digestSeed(seed: FinalizeTransactionSeed): string {
  return crypto.createHash('sha256').update(canonicalJson(seed)).digest('hex');
}

function sealFinalizeTransaction(
  value: Omit<FinalizeTransaction, 'recordDigest'> | FinalizeTransaction,
): FinalizeTransaction {
  const record = recordWithoutDigest(value);
  return parseFinalizeTransaction({
    ...record,
    recordDigest: digestRecord(record),
  });
}

function recordWithoutDigest(
  value: Omit<FinalizeTransaction, 'recordDigest'> | FinalizeTransaction,
): Omit<FinalizeTransaction, 'recordDigest'> {
  const { recordDigest: _recordDigest, ...record } =
    value as FinalizeTransaction;
  return record;
}

function digestRecord(
  record: Omit<FinalizeTransaction, 'recordDigest'>,
): string {
  return crypto
    .createHash('sha256')
    .update(canonicalJson(record))
    .digest('hex');
}

function nextPhase(phase: FinalizeTransactionPhase): FinalizeTransactionPhase {
  const phases: FinalizeTransactionPhase[] = [
    'projection-prepared',
    'candidate-prepared',
    'checks-running',
    'checked',
    'staged',
    'reports-persisted',
    'completed',
  ];
  const index = phases.indexOf(phase);
  if (index < 0 || index === phases.length - 1) {
    throw invalidFinalizeTransaction(
      'Finalize transaction is already terminal.',
    );
  }
  return phases[index + 1]!;
}

function phaseReportIdsAreValid(
  phase: FinalizeTransactionPhase,
  checkReportId: string | null,
  completionReportId: string | null,
  finishReportId: string | null,
): boolean {
  if (
    phase === 'projection-prepared' ||
    phase === 'candidate-prepared' ||
    phase === 'checks-running'
  ) {
    return (
      checkReportId === null &&
      completionReportId === null &&
      finishReportId === null
    );
  }
  if (phase === 'checked' || phase === 'staged') {
    return (
      checkReportId !== null &&
      completionReportId === null &&
      finishReportId === null
    );
  }
  return (
    checkReportId !== null &&
    completionReportId !== null &&
    finishReportId !== null
  );
}

function phaseCandidateStateIsValid(
  phase: FinalizeTransactionPhase,
  changedPaths: string[],
  candidateTree: string | null,
  candidateFingerprint: string | null,
  candidateStatusEntries: string[],
): boolean {
  if (phase === 'projection-prepared') {
    return (
      changedPaths.length === 0 &&
      candidateTree === null &&
      candidateFingerprint === null &&
      candidateStatusEntries.length === 0
    );
  }
  return (
    changedPaths.length > 0 &&
    candidateTree !== null &&
    candidateFingerprint !== null &&
    candidateStatusEntries.length > 0
  );
}

function isCanonicalStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0) &&
    new Set(value).size === value.length
  );
}

function isCanonicalCheckArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry),
    ) &&
    new Set(value).size === value.length
  );
}

function isFinalizeCheckEscalation(
  value: unknown,
): value is FinalizeCheckEscalation {
  return (
    value === null || value === 'all-tasks-terminal' || value === 'explicit'
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0) &&
    new Set(value).size === value.length
  );
}

function isCanonicalPathArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => typeof entry === 'string' && isSafeRelativePath(entry),
    ) &&
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== '..' &&
    !value.startsWith('../') &&
    !value.includes('\\')
  );
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && DIGEST.test(value));
}

function isNullableObjectId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && OBJECT_ID.test(value));
}

function malformed(): never {
  throw invalidFinalizeTransaction('Finalize transaction is malformed.');
}

export function invalidFinalizeTransaction(message: string) {
  return workflowError(
    'FINALIZE_TRANSACTION_INVALID',
    message,
    ExitCode.staleState,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function advanceFinalizeTransactionRecord(
  current: FinalizeTransaction,
  next: FinalizeTransaction,
): FinalizeTransaction {
  const normalized = sealFinalizeTransaction(next);
  if (
    normalized.transactionId !== current.transactionId ||
    nextPhase(current.phase) !== normalized.phase
  ) {
    throw invalidFinalizeTransaction('Finalize transaction phase is invalid.');
  }
  return normalized;
}
