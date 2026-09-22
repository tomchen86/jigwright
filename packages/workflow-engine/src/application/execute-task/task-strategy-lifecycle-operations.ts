/** Observations and existing child transitions used by inspect/resume decisions. */
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import type { GitState } from '../../modules/repository-consumer/repository-git-state.ts';
import type { StableValidatedChangeContractLoader } from '../../modules/assurance/validated-change-contract.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyRedRevisionRequest,
} from '../../modules/assurance/task-strategy-evidence.ts';
import type {
  TaskStrategyCorrectionProjection,
  CurrentTaskStrategyImplementationAuthority,
} from '../../modules/assurance/task-strategy-correction-round-record.ts';
import type { TaskMechanicalTransformLifecycleStatus } from '../../modules/lifecycle/managed-workflow-state-contract.ts';
import type { ImportedTaskStrategyPatch } from '../../modules/assurance/task-strategy-patch-contract.ts';
import type { ProviderRetryAccountingReader } from '../../modules/provider-orchestration/provider-retry-accounting.ts';
import type { TaskStrategyImplementationJournal } from './task-strategy-implementation-operations.ts';
import type {
  TaskStrategyImplementationLifecycle,
  BeginTaskStrategyImplementationOptions,
} from './task-strategy-implementation-lifecycle.ts';

export type ResumeTaskStrategyOptions = Readonly<{
  explicitActor?: string;
  collaborationGrant?: BeginTaskStrategyImplementationOptions['collaborationGrant'];
  redRevisionRequest?: TaskStrategyRedRevisionRequest;
}>;

/** A read-only view of the original path-bound journal, without copied schemas. */
export type TaskStrategyLifecycleJournal = {
  correction: Pick<
    TaskStrategyImplementationJournal['correction'],
    'readTransaction'
  >;
  implementation: Pick<
    TaskStrategyImplementationJournal['implementation'],
    | 'readReservation'
    | 'readCallerReservation'
    | 'readCallerResult'
    | 'readCurrentAttempt'
    | 'readResult'
  >;
  provider: Pick<
    TaskStrategyImplementationJournal['provider'],
    'exists' | 'read'
  >;
};

export type TaskStrategyLifecycleOperations = {
  session: {
    read(cwd: string, sessionId: string): WorkflowSession;
    discoverRepository(cwd: string): GitState;
    loadStableContract: StableValidatedChangeContractLoader;
    inspect(cwd: string, sessionId: string): SessionInspection;
    resolveCorrection(
      inspection: SessionInspection,
    ): TaskStrategyCorrectionProjection;
    resolveImplementationAuthority(
      inspection: SessionInspection,
      projection: TaskStrategyCorrectionProjection,
    ): CurrentTaskStrategyImplementationAuthority;
  };
  observeJournal(cwd: string): TaskStrategyLifecycleJournal;
  mechanical: {
    inspect(
      cwd: string,
      sessionId: string,
    ): TaskMechanicalTransformLifecycleStatus | null;
    resume(cwd: string, sessionId: string): void;
  };
  red: {
    seal(
      cwd: string,
      sessionId: string,
      options: Pick<ResumeTaskStrategyOptions, 'explicitActor'>,
    ): TaskStrategyTransaction;
    beginRevision(cwd: string, request: TaskStrategyRedRevisionRequest): void;
    continueRevision(cwd: string, sessionId: string): void;
  };
  adopt: {
    implementation(
      cwd: string,
      sessionId: string,
    ): ImportedTaskStrategyPatch | null;
    correction(
      cwd: string,
      sessionId: string,
    ): ImportedTaskStrategyPatch | null;
  };
  implementation: Pick<
    TaskStrategyImplementationLifecycle,
    'beginTaskStrategyImplementation'
  >;
  readProviderRetryAccountingEvidence: ProviderRetryAccountingReader;
};
