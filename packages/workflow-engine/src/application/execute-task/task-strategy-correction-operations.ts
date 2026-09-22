/** Repository observations and durable suboperations of correction lineage decisions. */
import type { GrantLifecycleClockPortV1 } from '@jigwright/core/grant-lifecycle-contracts';
import type { TaskStrategyImplementationJournal } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyPatchImportReceipt } from '../../modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyCorrectionState } from '../../modules/assurance/task-strategy-correction-round-record.ts';
import type {
  TaskStrategyCorrectionPolicy,
  TaskStrategyGreenFailureRecord,
  TaskStrategyGreenFailureInput,
} from '../../modules/provider-orchestration/task-strategy-correction-record.ts';

export type TaskStrategyCorrectionJournal = {
  correction: Pick<
    TaskStrategyImplementationJournal['correction'],
    'readTransaction' | 'readFailure' | 'listRounds'
  > & {
    deriveState(
      failure: TaskStrategyGreenFailureRecord,
      policy: TaskStrategyCorrectionPolicy,
    ): TaskStrategyCorrectionState;
    createFailure(
      input: TaskStrategyGreenFailureInput,
    ): TaskStrategyGreenFailureRecord;
  };
  implementation: Pick<
    TaskStrategyImplementationJournal['implementation'],
    | 'readReservation'
    | 'readResult'
    | 'readCallerReservation'
    | 'readCallerResult'
    | 'readAttempt'
    | 'assertProviderCurrent'
    | 'assertCallerCurrent'
  >;
  provider: Pick<TaskStrategyImplementationJournal['provider'], 'read'>;
  patch: Pick<
    TaskStrategyImplementationJournal['patch'],
    'readRecord' | 'readCurrentBinding'
  > & {
    readImportReceipt(
      sessionId: string,
      patchDigest: string,
      sourceTree: string,
    ): TaskStrategyPatchImportReceipt | null;
  };
};

export type TaskStrategyCorrectionOperations = {
  observeJournal(
    gitCommonDirectory: string,
    runtimeDirectory: string,
  ): TaskStrategyCorrectionJournal;
  correctionPolicy: TaskStrategyCorrectionPolicy;
  clock: GrantLifecycleClockPortV1;
};
