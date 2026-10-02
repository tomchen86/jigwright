/** Binds the complete RED service to the original repository and durable producers. */
import { createTaskStrategyExecutionService } from '../application/execute-task/task-strategy-execution.ts';
import type { TaskStrategyExecutionOperations } from '../application/execute-task/task-strategy-execution-operations.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import { inspectSession } from '../application/session-inspection/session-inspection.ts';
import { runSessionOperation } from '../runtime/repository-observation/workflow-session-context.ts';
import { observeInvestigationRuntimeContext } from '../runtime/repository-observation/investigation-runtime-context.ts';
import { previewExactStaging } from '../runtime/repository-transaction/git-transitions.ts';
import { readFrozenFiles } from '../runtime/repository-observation/task-strategy-red-files.ts';
import {
  pinCheckRunner,
  runExpectedRedCheck,
} from '../adapters/consumer/repository/work-registry/check-runner.ts';
import { createCheckEnvironmentForRepository } from '../adapters/consumer/repository/work-registry/database-policy.ts';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from '../runtime/storage-journal/evidence-object-store.ts';
import {
  createTaskStrategyTransaction,
  readTaskStrategyTransaction,
} from '../runtime/storage-journal/task-strategy-store.ts';
export type {
  SealTaskStrategyRedOptions,
  PreparedTaskStrategyRed,
  PrepareTaskStrategyRedSuccessorOptions,
} from '../application/execute-task/task-strategy-execution.ts';

export const taskStrategyExecutionOperations: TaskStrategyExecutionOperations =
  {
    session: {
      inspect: (cwd, sessionId) =>
        inspectSession(productionChangeContract, cwd, sessionId),
      inspectExpected: (cwd, sessionId, expectedSession) =>
        inspectSession(productionChangeContract, cwd, sessionId, {
          expectedSession,
        }),
      previewCandidate: previewExactStaging,
    },
    locks: { runSessionOperation },
    observeJournal(cwd) {
      const paths = observeInvestigationRuntimeContext(cwd).runtime;
      return {
        transaction: {
          readTransaction: readTaskStrategyTransaction.bind(undefined, paths),
          create: createTaskStrategyTransaction.bind(undefined, paths),
        },
        evidence: {
          write: writeEvidenceNode.bind(undefined, paths),
          read: readEvidenceNode.bind(undefined, paths),
        },
      };
    },
    checks: {
      pin: pinCheckRunner,
      run: runExpectedRedCheck,
      environment: createCheckEnvironmentForRepository,
    },
    readFrozenFiles,
    environment: () => process.env,
    clock: { now: () => new Date() },
  };

export const {
  inspectTaskStrategyTransaction,
  sealTaskStrategyRed,
  prepareTaskStrategyRedSuccessorUnlocked,
} = createTaskStrategyExecutionService(taskStrategyExecutionOperations);
