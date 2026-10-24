/** Observations and durable effects consumed by the complete RED revision state machine. */
import type { GrantLifecycleClockPortV1 } from '@jigwright/core/grant-lifecycle-contracts';
import type {
  TaskStrategyImplementationOperations,
  TaskStrategyImplementationJournal,
} from './task-strategy-implementation-operations.ts';
import type { TaskStrategyLifecycleOperations } from './task-strategy-lifecycle-operations.ts';
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import type { CheckRunnerPin } from '../../modules/source/check-command.ts';
import type {
  TaskStrategyTransaction,
  TaskStrategyPatchRecord,
  PreparedTaskStrategyRed,
  PrepareTaskStrategyRedSuccessorOptions,
  TaskStrategyRedRevisionRequest,
} from '../../modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyCurrentRef } from '../../modules/assurance/task-strategy-current-ref.ts';
import type {
  TaskStrategyRedRevisionJournal,
  TaskStrategyRedRevisionJournalState,
  TaskStrategyRedRevisionRequestSnapshot,
  ActiveTaskStrategyRedRevision,
} from '../../modules/assurance/task-strategy-red-revision-contract.ts';

/** Bound to one fresh observation, without reading records during binding. */
export type TaskStrategyRedRevisionJournalOperations = {
  revision: {
    read(
      sessionId: string,
      revisionId: string,
    ): TaskStrategyRedRevisionJournal | null;
    readActive(sessionId: string): ActiveTaskStrategyRedRevision | null;
    persistRequest(
      request: TaskStrategyRedRevisionRequest,
    ): TaskStrategyRedRevisionRequestSnapshot;
    create(
      state: TaskStrategyRedRevisionJournalState,
    ): TaskStrategyRedRevisionJournal;
    update(
      input: Readonly<{
        sessionId: string;
        revisionId: string;
        expectedJournalDigest: string;
        next: TaskStrategyRedRevisionJournalState;
      }>,
    ): TaskStrategyRedRevisionJournal;
  };
  transaction: Pick<
    TaskStrategyImplementationJournal['correction'],
    'readTransaction'
  > & {
    readByDigest(
      sessionId: string,
      digest: string,
    ): TaskStrategyTransaction | null;
    persist(transaction: TaskStrategyTransaction): TaskStrategyTransaction;
  };
  currentRef: {
    read(sessionId: string): TaskStrategyCurrentRef | null;
    compareAndSwap(
      input: Readonly<{
        sessionId: string;
        expectedRefDigest: string | null;
        next: TaskStrategyCurrentRef;
      }>,
    ): TaskStrategyCurrentRef;
  };
  patch: Pick<
    TaskStrategyImplementationJournal['patch'],
    'readCurrentBinding' | 'readRecord'
  >;
  evidence: Pick<TaskStrategyImplementationJournal['evidence'], 'write'>;
  session: {
    read(sessionId: string): WorkflowSession;
    write(sessionId: string, next: WorkflowSession): void;
  };
  hasFinalizeTransaction(sessionId: string): boolean;
};

export type TaskStrategyRedRevisionOperations = {
  session: Pick<TaskStrategyImplementationOperations['session'], 'loadActive'> &
    Pick<TaskStrategyLifecycleOperations['session'], 'inspect'>;
  locks: TaskStrategyImplementationOperations['locks'];
  observeJournal(cwd: string): TaskStrategyRedRevisionJournalOperations;
  pinCheckRunner: CheckRunnerPin;
  restoreImplementationToRed(
    cwd: string,
    sessionId: string,
    transaction: TaskStrategyTransaction,
    assertOwned: () => void,
  ): TaskStrategyPatchRecord | null;
  prepareSuccessor(
    cwd: string,
    sessionId: string,
    options: PrepareTaskStrategyRedSuccessorOptions,
  ): PreparedTaskStrategyRed;
  environment(): NodeJS.ProcessEnv;
  clock: GrantLifecycleClockPortV1;
};
