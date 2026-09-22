/** Binds RED revision observations and durable effects without owning its transitions. */
import path from 'node:path';
import type { TaskStrategyRedRevisionOperations } from '../application/execute-task/task-strategy-red-revision-operations.ts';
import { createTaskStrategyRedRevisionService } from '../application/execute-task/task-strategy-red-revision.ts';
import { productionTaskStrategyCorrection } from './task-strategy-correction-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import { assertCurrentImplementationReconciliation } from './implementation-reconciliation-production.ts';
import { loadActiveSessionContext } from '../runtime/repository-observation/workflow-session-context.ts';
import { observeInvestigationRuntimeContext } from '../runtime/repository-observation/investigation-runtime-context.ts';
import { inspectSession } from '../application/session-inspection/session-inspection.ts';
import { pinCheckRunner } from '../adapters/consumer/repository/work-registry/check-runner.ts';
import { restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock } from '../application/execute-task/task-strategy-patch.ts';
import { prepareTaskStrategyRedSuccessorUnlocked } from '../application/execute-task/task-strategy-execution.ts';
import {
  withRepositoryLifecycleOperation,
  withSessionOperation,
  readSessionFile,
  writeJsonAtomic,
} from '../runtime/session-workspace/session-store.ts';
import { readFinalizeTransaction } from '../runtime/storage-journal/finalize-transaction.ts';
import { writeEvidenceNode } from '../runtime/storage-journal/evidence-object-store.ts';
import {
  readTaskStrategyTransaction,
  readTaskStrategyTransactionByDigest,
  persistTaskStrategyTransaction,
} from '../runtime/storage-journal/task-strategy-store.ts';
import {
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchRecord,
} from '../runtime/storage-journal/task-strategy-patch-store.ts';
import {
  readTaskStrategyRedRevisionJournal,
  readActiveTaskStrategyRedRevision,
  persistTaskStrategyRedRevisionRequest,
  createTaskStrategyRedRevisionJournal,
  updateTaskStrategyRedRevisionJournal,
  readTaskStrategyCurrentRef,
  compareAndSwapTaskStrategyCurrentRef,
} from '../runtime/storage-journal/task-strategy-red-revision-store.ts';

export const taskStrategyRedRevisionOperations: TaskStrategyRedRevisionOperations =
  {
    session: {
      loadActive: loadActiveSessionContext,
      inspect: (cwd, sessionId) =>
        inspectSession(productionChangeContract, cwd, sessionId),
    },
    locks: {
      repository: withRepositoryLifecycleOperation,
      session: withSessionOperation,
    },
    observeJournal(cwd) {
      const { runtime, lifecycleRuntime } =
        observeInvestigationRuntimeContext(cwd);
      return {
        revision: {
          read: readTaskStrategyRedRevisionJournal.bind(undefined, runtime),
          readActive: readActiveTaskStrategyRedRevision.bind(
            undefined,
            runtime,
          ),
          persistRequest: persistTaskStrategyRedRevisionRequest.bind(
            undefined,
            runtime,
          ),
          create: createTaskStrategyRedRevisionJournal.bind(undefined, runtime),
          update: updateTaskStrategyRedRevisionJournal.bind(undefined, runtime),
        },
        transaction: {
          readTransaction: readTaskStrategyTransaction.bind(undefined, runtime),
          readByDigest: readTaskStrategyTransactionByDigest.bind(
            undefined,
            runtime,
          ),
          persist: persistTaskStrategyTransaction.bind(undefined, runtime),
        },
        currentRef: {
          read: readTaskStrategyCurrentRef.bind(undefined, runtime),
          compareAndSwap: compareAndSwapTaskStrategyCurrentRef.bind(
            undefined,
            runtime,
          ),
        },
        patch: {
          readCurrentBinding: readTaskStrategyPatchCurrentBinding.bind(
            undefined,
            runtime,
          ),
          readRecord: readTaskStrategyPatchRecord.bind(undefined, runtime),
        },
        evidence: { write: writeEvidenceNode.bind(undefined, runtime) },
        session: {
          read: (sessionId) =>
            readSessionFile(
              path.join(lifecycleRuntime.sessions, `${sessionId}.json`),
            ),
          write: (sessionId, next) =>
            writeJsonAtomic(
              path.join(lifecycleRuntime.sessions, `${sessionId}.json`),
              next,
            ),
        },
        hasFinalizeTransaction: (sessionId) =>
          readFinalizeTransaction(lifecycleRuntime.root, sessionId) !== null,
      };
    },
    pinCheckRunner,
    restoreImplementationToRed: (cwd, sessionId, transaction, assertOwned) =>
      restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock(
        productionChangeContract,
        productionTaskStrategyCorrection,
        cwd,
        sessionId,
        transaction,
        assertOwned,
      ),
    prepareSuccessor: (cwd, sessionId, options) =>
      prepareTaskStrategyRedSuccessorUnlocked(
        productionChangeContract,
        cwd,
        sessionId,
        options,
      ),
    environment: () => process.env,
    clock: { now: () => new Date() },
  };

export const { beginTaskStrategyRedRevision, continueTaskStrategyRedRevision } =
  createTaskStrategyRedRevisionService(
    taskStrategyRedRevisionOperations,
    assertCurrentImplementationReconciliation,
  );
