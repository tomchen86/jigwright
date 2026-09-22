/** Canonical correction lineage facts; observation and durable validation stay with their producers. */
import type {
  TaskStrategyPatchHead,
  TaskStrategyCorrectionPolicy,
  TaskStrategyGreenFailureRecord,
} from '../provider-orchestration/task-strategy-correction-record.ts';
import type {
  TaskStrategyPatchImplementer,
  TaskStrategyPatchCurrentBinding,
  TaskStrategyPatchRecord,
  TaskStrategyPatchImportReceipt,
  TaskStrategyTransaction,
} from './task-strategy-evidence.ts';

export type TaskStrategyCorrectionFailureIdentity = Readonly<{
  recordDigest: string;
  subjectDigest: string;
  candidateTree: string;
  failureFingerprint: string;
  currentRedTransactionDigest: string;
  currentPatchHead: TaskStrategyPatchHead;
}>;

export type TaskStrategyCorrectionProviderRequestIdentity = Readonly<{
  ownerInvestigationId: string;
  invocationId: string;
  requestDigest: string;
}>;

export type TaskStrategyCorrectionProviderReservationIdentity = Readonly<{
  reservationDigest: string;
  authorizationNodeId: string;
  reservationNodeId: string;
}>;

export type TaskStrategyCorrectionProviderResultIdentity = Readonly<{
  bindingDigest: string;
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  providerResultNodeId: string;
  providerResultDigest: string;
}>;

export type TaskStrategyCorrectionProviderAttemptIdentity = Readonly<{
  attempt: number;
  attemptReservationDigest: string;
  invocationId: string;
  requestDigest: string;
}>;

export type TaskStrategyCorrectionCallerReservationIdentity = Readonly<{
  reservationDigest: string;
  grantId: string;
  transitionDigest: string;
  submissionNodeId: string;
  submissionResultDigest: string;
}>;

export type TaskStrategyCorrectionCallerResultIdentity = Readonly<{
  bindingDigest: string;
  resultNodeId: string;
  resultDigest: string;
  roleResultDigest: string;
  grantUseDigest: string;
}>;

/** The exact source-scoped transition from the failed candidate to this round. */
export type TaskStrategyCorrectionPatchResult = Readonly<{
  sourceTree: string;
  targetCandidateTree: string;
  patchRecordDigest: string;
  patchDigest: string;
}>;

export type TaskStrategyCorrectionReservationAuthority =
  | Readonly<{
      kind: 'provider';
      providerRequest: TaskStrategyCorrectionProviderRequestIdentity;
      providerReservation: TaskStrategyCorrectionProviderReservationIdentity;
    }>
  | Readonly<{
      kind: 'sealed-local';
      author: TaskStrategyPatchImplementer;
    }>
  | Readonly<{
      kind: 'caller-supplied';
      callerReservation: TaskStrategyCorrectionCallerReservationIdentity;
    }>;

export type TaskStrategyCorrectionResultAuthority =
  | Readonly<{
      kind: 'provider';
      providerRequest: TaskStrategyCorrectionProviderRequestIdentity;
      providerReservation: TaskStrategyCorrectionProviderReservationIdentity;
      providerAttempt: TaskStrategyCorrectionProviderAttemptIdentity;
      providerResult: TaskStrategyCorrectionProviderResultIdentity;
    }>
  | Readonly<{
      kind: 'sealed-local';
      author: TaskStrategyPatchImplementer;
    }>
  | Readonly<{
      kind: 'caller-supplied';
      callerReservation: TaskStrategyCorrectionCallerReservationIdentity;
      callerResult: TaskStrategyCorrectionCallerResultIdentity;
    }>;

export type TaskStrategyCorrectionImportReceiptIdentity = Readonly<{
  patchRecordDigest: string;
  patchDigest: string;
  receiptDigest: string;
  candidateTree: string;
}>;

export type TaskStrategyCorrectionRoundReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-correction-round-reservation.v1';
  reservationDigest: string;
  sessionId: string;
  round: number;
  policy: TaskStrategyCorrectionPolicy;
  policyDigest: string;
  predecessorFailure: TaskStrategyCorrectionFailureIdentity;
  correctionSubjectDigest: string;
  redSourceTree: string;
  authority: TaskStrategyCorrectionReservationAuthority;
  createdAt: string;
}>;

export type TaskStrategyCorrectionRoundResult = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-correction-round-result.v1';
  resultDigest: string;
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  patchResult: TaskStrategyCorrectionPatchResult;
  createdAt: string;
}>;

export type TaskStrategyCorrectionRoundImport = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-correction-round-import.v1';
  importDigest: string;
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  patchResult: TaskStrategyCorrectionPatchResult;
  importReceipt: TaskStrategyCorrectionImportReceiptIdentity;
  currentPatchHead: TaskStrategyPatchHead;
  importedAt: string;
}>;

export type TaskStrategyCorrectionRound = Readonly<{
  reservation: TaskStrategyCorrectionRoundReservation;
  result: TaskStrategyCorrectionRoundResult | null;
  importRecord: TaskStrategyCorrectionRoundImport | null;
}>;

export type TaskStrategyCorrectionState =
  | Readonly<{
      state: 'correction-required';
      round: number;
      nextAction: 'reserve';
    }>
  | Readonly<{
      state: 'correction-required';
      round: number;
      nextAction: 'publish-result' | 'publish-import-receipt';
      correctionSubjectDigest: string;
    }>
  | Readonly<{
      state: 'correction-exhausted';
      completedRounds: number;
      reason: 'max-repair-attempts' | 'same-failure-fingerprint';
      failureRecordDigest: string;
    }>;

export type ReserveTaskStrategyCorrectionRoundInput = Readonly<{
  sessionId: string;
  round: number;
  policy: TaskStrategyCorrectionPolicy;
  predecessorFailure: TaskStrategyGreenFailureRecord;
  /** Exact digest minted by createTaskStrategyCorrectionSubject. */
  correctionSubjectDigest: string;
  redSourceTree: string;
  authority: TaskStrategyCorrectionReservationAuthority;
  createdAt: string;
}>;

export type PublishTaskStrategyCorrectionRoundResultInput = Readonly<{
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  patchResult: TaskStrategyCorrectionPatchResult;
  createdAt: string;
}>;

export type PublishTaskStrategyCorrectionRoundImportInput = Readonly<{
  sessionId: string;
  currentRedTransactionDigest: string;
  round: number;
  correctionSubjectDigest: string;
  authority: TaskStrategyCorrectionResultAuthority;
  importReceipt: TaskStrategyCorrectionImportReceiptIdentity;
  currentPatchHead: TaskStrategyPatchHead;
  importedAt: string;
}>;

/** The current patch head, as the three readers beside it return it. */
export type CurrentTaskStrategyPatchHead = Readonly<{
  binding: TaskStrategyPatchCurrentBinding;
  record: TaskStrategyPatchRecord;
  receipt: TaskStrategyPatchImportReceipt;
}>;

/** What a correction round looks like once its durable records are read. */
export type TaskStrategyCorrectionProjection = Readonly<{
  transaction: TaskStrategyTransaction;
  head: CurrentTaskStrategyPatchHead | null;
  failure: TaskStrategyGreenFailureRecord | null;
  completedCorrectionRounds: number;
  exhausted: boolean;
  correctionState: TaskStrategyCorrectionState | null;
}>;
