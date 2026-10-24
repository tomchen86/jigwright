/** Binds patch observations and effects to the actual application state machine. */
import type { TaskStrategyPatchOperations } from '../application/execute-task/task-strategy-patch-operations.ts';
import { createTaskStrategyPatchService } from '../application/execute-task/task-strategy-patch.ts';
import { productionTaskStrategyCorrection } from './task-strategy-correction-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import { inspectSession } from '../runtime/repository-validation/session-inspection.ts';
import {
  loadActiveSessionContext,
  runSessionOperation,
} from '../runtime/repository-observation/workflow-session-context.ts';
import { previewExactStaging } from '../runtime/repository-transaction/git-transitions.ts';
import {
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from '../runtime/session-workspace/session-store.ts';
import { investigationRuntimePaths } from '../runtime/paths/runtime-paths.ts';
import { readTaskStrategyTransaction } from '../runtime/storage-journal/task-strategy-store.ts';
import {
  readTaskStrategyGreenFailureRecord,
  DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
} from '../runtime/storage-journal/task-strategy-correction-store.ts';
import {
  reserveTaskStrategyCorrectionRound,
  publishTaskStrategyCorrectionRoundResult,
  publishTaskStrategyCorrectionRoundImport,
} from '../runtime/storage-journal/task-strategy-correction-round-store.ts';
import {
  readTaskStrategyImplementationReservation,
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyCallerImplementationReservation,
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyImplementationProviderAttempt,
  readCurrentTaskStrategyImplementationProviderAttempt,
} from '../runtime/storage-journal/task-strategy-provider-store.ts';
import {
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchImportReceipt,
  readTaskStrategyPatchReservation,
  createTaskStrategyPatchReservation,
  persistTaskStrategyPatchRecord,
  createTaskStrategyPatchImportReceipt,
  createTaskStrategyPatchCurrentBinding,
} from '../runtime/storage-journal/task-strategy-patch-store.ts';
import {
  applyPatchToIsolatedTree,
  createBinaryPatch,
  readRegularTreeEntry,
  applyPatchToWorktree,
} from '../runtime/repository-transaction/task-strategy-patch-operators.ts';

export const taskStrategyPatchOperations: TaskStrategyPatchOperations = {
  session: {
    loadActive: loadActiveSessionContext,
    inspect: (cwd, sessionId) =>
      inspectSession(productionChangeContract, cwd, sessionId),
    inspectExpected: (cwd, sessionId, expectedSession) =>
      inspectSession(productionChangeContract, cwd, sessionId, {
        expectedSession,
      }),
    previewCandidate: previewExactStaging,
  },
  locks: {
    repository: withRepositoryLifecycleOperation,
    session: withSessionOperation,
    runSessionOperation,
  },
  observeJournal(gitCommonDirectory, runtimeDirectory) {
    const paths = investigationRuntimePaths(
      gitCommonDirectory,
      runtimeDirectory,
    );
    return {
      correction: {
        readTransaction: readTaskStrategyTransaction.bind(undefined, paths),
        readFailure: readTaskStrategyGreenFailureRecord.bind(undefined, paths),
        reserve: reserveTaskStrategyCorrectionRound.bind(undefined, paths),
        publishResult: publishTaskStrategyCorrectionRoundResult.bind(
          undefined,
          paths,
        ),
        publishImport: publishTaskStrategyCorrectionRoundImport.bind(
          undefined,
          paths,
        ),
      },
      implementation: {
        readReservation: readTaskStrategyImplementationReservation.bind(
          undefined,
          paths,
        ),
        readResult: readTaskStrategyImplementationResultBinding.bind(
          undefined,
          paths,
        ),
        readCallerReservation:
          readTaskStrategyCallerImplementationReservation.bind(
            undefined,
            paths,
          ),
        readCallerResult: readTaskStrategyCallerImplementationBinding.bind(
          undefined,
          paths,
        ),
        readAttempt: readTaskStrategyImplementationProviderAttempt.bind(
          undefined,
          paths,
        ),
        readCurrentAttempt:
          readCurrentTaskStrategyImplementationProviderAttempt.bind(
            undefined,
            paths,
          ),
      },
      patch: {
        readRecord: readTaskStrategyPatchRecord.bind(undefined, paths),
        readCurrentBinding: readTaskStrategyPatchCurrentBinding.bind(
          undefined,
          paths,
        ),
        readImportReceipt: readTaskStrategyPatchImportReceipt.bind(
          undefined,
          paths,
        ),
        readReservation: readTaskStrategyPatchReservation.bind(
          undefined,
          paths,
        ),
        reserve: createTaskStrategyPatchReservation.bind(undefined, paths),
        persistRecord: persistTaskStrategyPatchRecord.bind(undefined, paths),
        createImportReceipt: createTaskStrategyPatchImportReceipt.bind(
          undefined,
          paths,
        ),
        createCurrentBinding: createTaskStrategyPatchCurrentBinding.bind(
          undefined,
          paths,
        ),
      },
    };
  },
  repository: {
    applyPatchToIsolatedTree,
    createBinaryPatch,
    readRegularTreeEntry,
    applyPatchToWorktree,
  },
  correctionPolicy: DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  environment: () => process.env,
  clock: { now: () => new Date() },
};

export const productionTaskStrategyPatch = createTaskStrategyPatchService(
  taskStrategyPatchOperations,
  productionTaskStrategyCorrection,
);
export const {
  validateTaskStrategyPatch,
  validateTaskStrategyProviderPatch,
  validateTaskStrategyCallerPatch,
  importTaskStrategyPatch,
  adoptCurrentTaskStrategyImplementation,
  adoptCurrentTaskStrategyCorrection,
  restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock,
  importTaskStrategyProviderPatch,
  importTaskStrategyProviderPatchUnderLifecycleLock,
  importTaskStrategyCallerPatchUnderLifecycleLock,
} = productionTaskStrategyPatch;
