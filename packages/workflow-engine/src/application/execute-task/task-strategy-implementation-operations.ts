/** External capabilities of the complete implementation use case; decisions stay in application. */
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import type { SessionRuntimeLayoutV1 } from '@jigwright/core/session-runtime-layout-port';
import type { GrantLifecycleClockPortV1 } from '@jigwright/core/grant-lifecycle-contracts';
import type {
  DataAuthorizationPolicyPort,
  LoadedDataAuthorizationPolicyV4,
} from '@jigwright/core/data-authorization-policy-port';
import type { EvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import type { GitState } from '../../modules/repository-consumer/repository-git-state.ts';
import type { WorkflowConfig } from '../../modules/repository-consumer/workflow-config.ts';
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import type {
  CollaborationGrantInspection,
  CollaborationReservationRecord,
  CollaborationReservationRequest,
  CollaborationConsumptionRequest,
} from '../../modules/authority/collaboration-grant-records.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyImplementationResultBinding,
  TaskStrategyCallerImplementationBinding,
  TaskStrategyPatchRecord,
  TaskStrategyPatchCurrentBinding,
} from '../../modules/assurance/task-strategy-evidence.ts';
import type {
  TaskStrategyImplementationReservation,
  TaskStrategyImplementationProviderAttempt,
  TaskStrategyCallerImplementationReservation,
} from '../../modules/assurance/task-strategy-implementation-record.ts';
import type {
  TaskStrategyCorrectionRound,
  TaskStrategyCorrectionProjection,
  ReserveTaskStrategyCorrectionRoundInput,
  PublishTaskStrategyCorrectionRoundResultInput,
  PublishTaskStrategyCorrectionRoundImportInput,
} from '../../modules/assurance/task-strategy-correction-round-record.ts';
import type {
  TaskStrategyPatchValidation,
  ImportedTaskStrategyPatch,
  ProviderTaskStrategyPatchValidationInput,
  CallerTaskStrategyPatchValidationInput,
  ProviderTaskStrategyPatchImportInput,
  CallerTaskStrategyPatchImportInput,
} from '../../modules/assurance/task-strategy-patch-contract.ts';
import type { ProviderInvocationManifest } from '../../modules/assurance/provider-invocation-manifest.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import type {
  ProviderRetryReservationV3,
  ProviderRetryReservationCurrent,
} from '../../modules/provider-orchestration/provider-invocation-reservations.ts';
import type {
  TaskStrategyImplementationSubject,
  TaskStrategyImplementationManifest,
} from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import type {
  TaskStrategyGreenFailureRecord,
  TaskStrategyCorrectionPolicy,
} from '../../modules/provider-orchestration/task-strategy-correction-record.ts';

/** A type view of the original observation, never a cloned/truncated session. */
export type TaskStrategyImplementationSession = {
  git: Pick<
    GitState,
    'repositoryRoot' | 'repositoryRealPath' | 'gitCommonDirectory'
  >;
  config: Pick<WorkflowConfig, 'repositoryName'>;
  runtime: SessionRuntimeLayoutV1;
  session: WorkflowSession;
};

type RecordInput<T, Digest extends keyof T> = Omit<
  T,
  'schemaVersion' | 'kind' | Digest
>;

export type TaskStrategyProviderInvocationInput = Pick<
  TaskStrategyImplementationReservation,
  'changeId' | 'manifest' | 'request' | 'createdAt'
> & {
  investigationId: string;
  attempt: number;
  mandateBinding?: TaskMandateBinding;
};

export type TaskStrategyProviderRetryInput = Pick<
  ProviderRetryReservationV3,
  | 'investigationId'
  | 'changeId'
  | 'attempt'
  | 'previousInvocationId'
  | 'request'
  | 'retryDecision'
  | 'replacement'
  | 'createdAt'
  | 'mandateBinding'
> & {
  manifest: TaskStrategyImplementationManifest;
  executionPolicy: LoadedDataAuthorizationPolicyV4<ProviderId>;
};

/** Bound to one fresh paths observation; binding itself never reads a record. */
export type TaskStrategyImplementationJournal = {
  readonly paths: InvestigationRuntimePaths;
  evidence: {
    read(nodeId: string): EvidenceNode;
    write(node: EvidenceNode): void;
  };
  implementation: {
    readReservation(
      sessionId: string,
      subjectDigest: string,
    ): TaskStrategyImplementationReservation | null;
    reserve(
      input: RecordInput<TaskStrategyImplementationReservation, 'recordDigest'>,
    ): TaskStrategyImplementationReservation;
    readResult(
      sessionId: string,
      subjectDigest: string,
    ): TaskStrategyImplementationResultBinding | null;
    publishResult(
      input: RecordInput<
        TaskStrategyImplementationResultBinding,
        'bindingDigest'
      >,
    ): TaskStrategyImplementationResultBinding;
    readCallerReservation(
      sessionId: string,
      subjectDigest: string,
    ): TaskStrategyCallerImplementationReservation | null;
    reserveCaller(
      input: RecordInput<
        TaskStrategyCallerImplementationReservation,
        'reservationDigest'
      >,
    ): TaskStrategyCallerImplementationReservation;
    readCallerResult(
      sessionId: string,
      subjectDigest: string,
    ): TaskStrategyCallerImplementationBinding | null;
    publishCallerResult(
      input: RecordInput<
        TaskStrategyCallerImplementationBinding,
        'bindingDigest'
      >,
    ): TaskStrategyCallerImplementationBinding;
    readAttempt(
      root: TaskStrategyImplementationReservation,
      invocationId: string,
    ): TaskStrategyImplementationProviderAttempt;
    readCurrentAttempt(
      root: TaskStrategyImplementationReservation,
    ): TaskStrategyImplementationProviderAttempt;
    assertProviderCurrent(
      reservation: TaskStrategyImplementationReservation,
      invocation: ProviderInvocationRecord,
      binding: TaskStrategyImplementationResultBinding,
    ): void;
    assertCallerReservationCurrent(
      transaction: TaskStrategyTransaction,
      subject: TaskStrategyImplementationSubject,
      reservation: TaskStrategyCallerImplementationReservation,
    ): void;
    assertCallerCurrent(
      transaction: TaskStrategyTransaction,
      subject: TaskStrategyImplementationSubject,
      reservation: TaskStrategyCallerImplementationReservation,
      binding: TaskStrategyCallerImplementationBinding,
    ): void;
  };
  provider: {
    exists(invocationId: string): boolean;
    read(invocationId: string): ProviderInvocationRecord;
    readRequest(invocationId: string): ProviderInvocationRequest;
    readManifest(invocationId: string): ProviderInvocationManifest;
    storePolicy(
      request: ProviderInvocationRequest,
      policy: LoadedDataAuthorizationPolicyV4<ProviderId>,
    ): void;
    create(
      input: TaskStrategyProviderInvocationInput,
    ): ProviderInvocationRecord;
    reserveRetry(
      input: TaskStrategyProviderRetryInput,
    ): ProviderRetryReservationCurrent;
  };
  correction: {
    readTransaction(sessionId: string): TaskStrategyTransaction | null;
    readFailure(
      sessionId: string,
      sourceTree: string,
    ): TaskStrategyGreenFailureRecord | null;
    readRound(
      sessionId: string,
      redTransactionDigest: string,
      round: number,
    ): TaskStrategyCorrectionRound | null;
    listRounds(
      sessionId: string,
      redTransactionDigest: string,
    ): readonly TaskStrategyCorrectionRound[];
    reserve(input: ReserveTaskStrategyCorrectionRoundInput): void;
    publishResult(input: PublishTaskStrategyCorrectionRoundResultInput): void;
    publishImport(input: PublishTaskStrategyCorrectionRoundImportInput): void;
  };
  patch: {
    readRecord(
      sessionId: string,
      patchDigest: string,
      sourceTree: string,
    ): TaskStrategyPatchRecord | null;
    readCurrentBinding(
      sessionId: string,
      sourceTree: string,
    ): TaskStrategyPatchCurrentBinding | null;
  };
};

export type TaskStrategyImplementationOperations = {
  session: {
    loadActive(
      cwd: string,
      sessionId: string,
    ): TaskStrategyImplementationSession;
    inspectExpected(
      cwd: string,
      sessionId: string,
      expected: WorkflowSession,
    ): SessionInspection;
    previewCandidate(
      repositoryRoot: string,
      baseCommit: string,
      changedPaths: string[],
    ): { tree: string };
    resolveCorrection(
      inspection: SessionInspection,
    ): TaskStrategyCorrectionProjection;
  };
  observeJournal(cwd: string): TaskStrategyImplementationJournal;
  locks: {
    repository<T>(
      layout: SessionRuntimeLayoutV1,
      operation: (assertOwned: () => void) => T,
    ): T;
    session<T>(
      layout: SessionRuntimeLayoutV1,
      sessionId: string,
      operation: () => T,
    ): T;
  };
  baseline: {
    readDocument(
      repositoryRoot: string,
      commit: string,
      document:
        'workflow/ai-adapter-policy.json' | 'workflow/maintainer-policy.json',
    ): string;
    readMaintainerBlob(repositoryRoot: string, commit: string): string;
  };
  collaboration: {
    inspect(
      gitCommonDirectory: string,
      grantId: string,
      assertOwned: () => void,
    ): readonly CollaborationGrantInspection[];
    reserve(
      repositoryRoot: string,
      grantId: string,
      request: CollaborationReservationRequest,
      assertOwned: () => void,
    ): CollaborationReservationRecord;
    readReserved(
      gitCommonDirectory: string,
      grantId: string,
      assertOwned: () => void,
    ): CollaborationReservationRecord;
    consume(
      gitCommonDirectory: string,
      grantId: string,
      request: CollaborationConsumptionRequest,
      assertOwned: () => void,
    ): CollaborationGrantInspection;
  };
  patches: {
    validateProvider(
      cwd: string,
      sessionId: string,
      input: ProviderTaskStrategyPatchValidationInput,
    ): TaskStrategyPatchValidation;
    validateCaller(
      cwd: string,
      sessionId: string,
      input: CallerTaskStrategyPatchValidationInput,
    ): TaskStrategyPatchValidation;
    importProvider(
      cwd: string,
      sessionId: string,
      input: ProviderTaskStrategyPatchImportInput,
      assertOwned: () => void,
    ): ImportedTaskStrategyPatch;
    importCaller(
      cwd: string,
      sessionId: string,
      input: CallerTaskStrategyPatchImportInput,
      assertOwned: () => void,
    ): ImportedTaskStrategyPatch;
  };
  dataPolicy: DataAuthorizationPolicyPort<ProviderId>;
  correctionPolicy: TaskStrategyCorrectionPolicy;
  clock: GrantLifecycleClockPortV1;
};
