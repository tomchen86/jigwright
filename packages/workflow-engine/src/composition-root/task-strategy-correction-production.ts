/** Bind correction lineage decisions to the original durable observations and writer. */
import { createTaskStrategyCorrection } from '../application/execute-task/task-strategy-correction.ts';
import { investigationRuntimePaths } from '../runtime/paths/runtime-paths.ts';
import { readTaskStrategyTransaction } from '../runtime/storage-journal/task-strategy-store.ts';
import {
  DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  readTaskStrategyGreenFailureRecord,
  createTaskStrategyGreenFailureRecord,
} from '../runtime/storage-journal/task-strategy-correction-store.ts';
import {
  listTaskStrategyCorrectionRounds,
  deriveTaskStrategyCorrectionState,
} from '../runtime/storage-journal/task-strategy-correction-round-store.ts';
import {
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchImportReceipt,
} from '../runtime/storage-journal/task-strategy-patch-store.ts';
import {
  readTaskStrategyImplementationReservation,
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyCallerImplementationReservation,
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyImplementationProviderAttempt,
  assertTaskStrategyImplementationProviderAuthorityCurrent,
  assertTaskStrategyCallerImplementationAuthorityCurrent,
} from '../runtime/storage-journal/task-strategy-provider-store.ts';
import { readProviderInvocation } from '../runtime/storage-journal/provider-invocation-state.ts';

export const productionTaskStrategyCorrection = createTaskStrategyCorrection({
  observeJournal(gitCommonDirectory, runtimeDirectory) {
    const paths = investigationRuntimePaths(
      gitCommonDirectory,
      runtimeDirectory,
    );
    return {
      correction: {
        readTransaction: readTaskStrategyTransaction.bind(undefined, paths),
        readFailure: readTaskStrategyGreenFailureRecord.bind(undefined, paths),
        listRounds: listTaskStrategyCorrectionRounds.bind(undefined, paths),
        deriveState: deriveTaskStrategyCorrectionState.bind(undefined, paths),
        createFailure: createTaskStrategyGreenFailureRecord.bind(
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
        assertProviderCurrent:
          assertTaskStrategyImplementationProviderAuthorityCurrent.bind(
            undefined,
            paths,
          ),
        assertCallerCurrent:
          assertTaskStrategyCallerImplementationAuthorityCurrent.bind(
            undefined,
            paths,
          ),
      },
      provider: { read: readProviderInvocation.bind(undefined, paths) },
      patch: {
        readCurrentBinding: readTaskStrategyPatchCurrentBinding.bind(
          undefined,
          paths,
        ),
        readRecord: readTaskStrategyPatchRecord.bind(undefined, paths),
        readImportReceipt: readTaskStrategyPatchImportReceipt.bind(
          undefined,
          paths,
        ),
      },
    };
  },
  correctionPolicy: DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  clock: { now: () => new Date() },
});

export const {
  recordTaskStrategyGreenFailure,
  readCurrentTaskStrategyGreenFailure,
  resolveCurrentTaskStrategyCorrection,
  resolveCurrentTaskStrategyImplementationAuthority,
} = productionTaskStrategyCorrection;
