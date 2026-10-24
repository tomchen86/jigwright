/** Existing observations and effects required by the complete RED sealing use case. */
import type { GrantLifecycleClockPortV1 } from '@jigwright/core/grant-lifecycle-contracts';
import type {
  TaskStrategyImplementationOperations,
  TaskStrategyImplementationJournal,
} from './task-strategy-implementation-operations.ts';
import type { TaskStrategyLifecycleOperations } from './task-strategy-lifecycle-operations.ts';
import type { TaskStrategyPatchOperations } from './task-strategy-patch-operations.ts';
import type {
  TaskStrategyFrozenFile,
  TaskStrategyTransaction,
  TaskStrategyTransactionInput,
} from '../../modules/assurance/task-strategy-evidence.ts';
import type { CheckRunnerPin } from '../../modules/source/check-command.ts';
import type { ExpectedRedCheckRunner } from '../../modules/assurance/check-execution-port.ts';

/** A fresh path-bound journal; binding it does not read any records. */
export type TaskStrategyExecutionJournal = {
  transaction: Pick<
    TaskStrategyImplementationJournal['correction'],
    'readTransaction'
  > & {
    create(input: TaskStrategyTransactionInput): TaskStrategyTransaction;
  };
  evidence: Pick<
    TaskStrategyImplementationJournal['evidence'],
    'write' | 'read'
  >;
};

export type TaskStrategyExecutionOperations = {
  session: Pick<TaskStrategyLifecycleOperations['session'], 'inspect'> &
    Pick<
      TaskStrategyImplementationOperations['session'],
      'inspectExpected' | 'previewCandidate'
    >;
  locks: Pick<TaskStrategyPatchOperations['locks'], 'runSessionOperation'>;
  observeJournal(cwd: string): TaskStrategyExecutionJournal;
  checks: {
    pin: CheckRunnerPin;
    run: ExpectedRedCheckRunner;
    environment(
      repositoryRoot: string,
      environment: NodeJS.ProcessEnv,
      destructiveDatabase: boolean,
    ): NodeJS.ProcessEnv;
  };
  readFrozenFiles(
    repositoryRoot: string,
    tree: string,
    paths: readonly string[],
  ): TaskStrategyFrozenFile[];
  environment(): NodeJS.ProcessEnv;
  clock: GrantLifecycleClockPortV1;
};
