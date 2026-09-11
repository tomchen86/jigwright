import type { ProviderId } from '../provider-orchestration/provider-registry.ts';
import type { EvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import type { AdmittedRoleResult } from '../provider-orchestration/role-admission-contracts.ts';
import type { TaskStrategyImplementationOutput } from '../provider-orchestration/task-strategy-implementation-output.ts';

export type TaskStrategyFrozenFile = Readonly<{
  path: string;
  mode: '100644' | '100755';
  objectId: string;
}>;

export type TaskStrategyTransaction = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-transaction.v1';
  recordDigest: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  baseline: Readonly<{ head: string; tree: string }>;
  strategy: 'cross-agent-tdd' | 'tdd-single-agent';
  phase: 'red-sealed';
  taskContractDigest: string;
  author: Readonly<{
    providerId: ProviderId;
    assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  }>;
  red: Readonly<{
    candidateTree: string;
    changedPaths: readonly string[];
    checkId: string;
    runner: string;
    runnerDigest: string;
    exitCode: number;
    failureCategory: 'assertion' | 'behavior-mismatch';
    selector: string;
    testPaths: readonly string[];
    fixturePaths: readonly string[];
    files: readonly TaskStrategyFrozenFile[];
    stdoutDigest: string;
    stderrDigest: string;
    failureFingerprint: string;
    evidenceNodeId: string;
    evidenceResultDigest: string;
    evidenceNode: EvidenceNode;
  }>;
  createdAt: string;
}>;

export type TaskStrategyTransactionInput = Omit<
  TaskStrategyTransaction,
  'schemaVersion' | 'kind' | 'recordDigest'
>;

export type TaskStrategyPatchEntry = Readonly<{
  mode: '100644' | '100755';
  objectId: string;
}>;

export type TaskStrategyPatchChange = Readonly<{
  path: string;
  before: TaskStrategyPatchEntry | null;
  after: TaskStrategyPatchEntry | null;
}>;

export type TaskStrategyPatchImplementer =
  | Readonly<{
      providerId: ProviderId;
      assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
    }>
  | Readonly<{
      providerId: null;
      principalId: string;
      assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
      degradedForm: 'caller-supplied';
      grantId: string;
    }>;

export type TaskStrategyPatchRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-record.v1';
  recordDigest: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  strategy: 'cross-agent-tdd' | 'tdd-single-agent';
  sourceTree: string;
  candidateTree: string;
  taskContractDigest: string;
  patchDigest: string;
  patchBase64: string;
  changedPaths: readonly string[];
  changes: readonly TaskStrategyPatchChange[];
  implementer: TaskStrategyPatchImplementer;
  createdAt: string;
}>;

export type TaskStrategyPatchImportReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-import-receipt.v1';
  receiptDigest: string;
  recordDigest: string;
  sessionId: string;
  patchDigest: string;
  candidateTree: string;
  importedAt: string;
}>;

export type TaskStrategyPatchReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-reservation.v1';
  reservationDigest: string;
  sessionId: string;
  patchDigest: string;
  recordDigest: string;
  sourceTree: string;
  candidateTree: string;
  createdAt: string;
}>;

export type TaskStrategyPatchCurrentBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-current.v1';
  bindingDigest: string;
  sessionId: string;
  patchDigest: string;
  recordDigest: string;
  receiptDigest: string;
  candidateTree: string;
  createdAt: string;
}>;

export type TaskStrategyImplementationResultBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-implementation-result-binding.v1';
  bindingDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  subjectDigest: string;
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  runtimeObservationDigest: string;
  providerObservationNodeId: string;
  providerObservationDigest: string;
  providerResultNodeId: string;
  providerResultDigest: string;
  roleResult: AdmittedRoleResult;
  output: TaskStrategyImplementationOutput;
  createdAt: string;
}>;

export type TaskStrategyCallerImplementationBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-caller-implementation-binding.v1';
  bindingDigest: string;
  sessionId: string;
  subjectDigest: string;
  transitionDigest: string;
  submissionNodeId: string;
  submissionResultDigest: string;
  resultNodeId: string;
  resultDigest: string;
  roleResult: AdmittedRoleResult;
  output: TaskStrategyImplementationOutput;
  createdAt: string;
}>;
