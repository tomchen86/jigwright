/** Observations and effects used by the complete patch policy and recovery state machine. */
import type { GrantLifecycleClockPortV1 } from '@jigwright/core/grant-lifecycle-contracts';
import type {
  TaskStrategyImplementationOperations,
  TaskStrategyImplementationJournal,
} from './task-strategy-implementation-operations.ts';
import type { TaskStrategyLifecycleOperations } from './task-strategy-lifecycle-operations.ts';
import type { TaskStrategyCorrectionJournal } from './task-strategy-correction-operations.ts';
import type {
  TaskStrategyPatchEntry,
  TaskStrategyPatchRecord,
  TaskStrategyPatchReservation,
  TaskStrategyPatchImportReceipt,
  TaskStrategyPatchCurrentBinding,
} from '../../modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyCorrectionPolicy } from '../../modules/provider-orchestration/task-strategy-correction-record.ts';

type RecordInput<T, Digest extends keyof T> = Omit<
  T,
  'schemaVersion' | 'kind' | Digest
>;

/** Binding uses the original inspection paths and does not read records. */
export type TaskStrategyPatchJournal = {
  correction: Pick<
    TaskStrategyImplementationJournal['correction'],
    | 'readTransaction'
    | 'readFailure'
    | 'reserve'
    | 'publishResult'
    | 'publishImport'
  >;
  implementation: Pick<
    TaskStrategyImplementationJournal['implementation'],
    | 'readReservation'
    | 'readResult'
    | 'readCallerReservation'
    | 'readCallerResult'
    | 'readAttempt'
    | 'readCurrentAttempt'
  >;
  patch: Pick<
    TaskStrategyImplementationJournal['patch'],
    'readRecord' | 'readCurrentBinding'
  > &
    Pick<TaskStrategyCorrectionJournal['patch'], 'readImportReceipt'> & {
      readReservation(
        sessionId: string,
        sourceTree: string,
      ): TaskStrategyPatchReservation | null;
      reserve(
        input: RecordInput<TaskStrategyPatchReservation, 'reservationDigest'>,
      ): TaskStrategyPatchReservation;
      persistRecord(record: TaskStrategyPatchRecord): TaskStrategyPatchRecord;
      createImportReceipt(
        input: RecordInput<TaskStrategyPatchImportReceipt, 'receiptDigest'>,
        sourceTree: string,
      ): TaskStrategyPatchImportReceipt;
      createCurrentBinding(
        input: RecordInput<TaskStrategyPatchCurrentBinding, 'bindingDigest'>,
        sourceTree: string,
      ): TaskStrategyPatchCurrentBinding;
    };
};

export type TaskStrategyPatchOperations = {
  session: Pick<
    TaskStrategyImplementationOperations['session'],
    'loadActive' | 'inspectExpected' | 'previewCandidate'
  > &
    Pick<TaskStrategyLifecycleOperations['session'], 'inspect'>;
  locks: TaskStrategyImplementationOperations['locks'] & {
    /** Original session-only admission; it does not require an active session. */
    runSessionOperation<T>(
      cwd: string,
      sessionId: string,
      operation: () => T,
    ): T;
  };
  observeJournal(
    gitCommonDirectory: string,
    runtimeDirectory: string,
  ): TaskStrategyPatchJournal;
  repository: {
    applyPatchToIsolatedTree(
      repositoryRoot: string,
      sourceTree: string,
      patchBytes: Buffer,
    ): { candidateTree: string; changedPaths: string[] };
    createBinaryPatch(
      repositoryRoot: string,
      sourceTree: string,
      candidateTree: string,
    ): Buffer;
    readRegularTreeEntry(
      repositoryRoot: string,
      tree: string,
      candidatePath: string,
    ): TaskStrategyPatchEntry | null;
    applyPatchToWorktree(
      repositoryRoot: string,
      patchBytes: Buffer,
      reverse?: boolean,
    ): void;
  };
  correctionPolicy: TaskStrategyCorrectionPolicy;
  environment(): NodeJS.ProcessEnv;
  clock: GrantLifecycleClockPortV1;
};
