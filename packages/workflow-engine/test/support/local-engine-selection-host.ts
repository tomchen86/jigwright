/** Test host: bind the real outer bootstrap readers without a source fallback. */
import {
  bootstrapInterventionStateRoot,
  resolveLocalEngineSelection,
} from '../../bootstrap/control-plane-trust.ts';
import type { LocalEngineSelectionReaders } from '../../src/modules/authority/local-engine-selection.ts';
import { checkSession as checkSessionWithLocalEngineSelection } from '../../src/application/finalize/verification.ts';
import { createProductionFinalizationService } from '../../src/composition-root/finalization-production.ts';

export const localEngineSelectionReaders: LocalEngineSelectionReaders =
  Object.freeze({
    bootstrapInterventionStateRoot,
    resolveLocalEngineSelection,
  });

export const checkSession = checkSessionWithLocalEngineSelection.bind(
  undefined,
  localEngineSelectionReaders,
);

export const {
  rollbackCompletion,
  recoverFinalize,
  finalizeSession,
  finalizeProtectedTaskApplyUnderGrant,
  finalizeTask,
  completeTask,
  finishSession,
} = createProductionFinalizationService(localEngineSelectionReaders);

import { createProductionProtectedTaskApplyGrantPort as createProtectedTaskApplyPort } from '../../src/composition-root/protected-task-apply-grant-production.ts';
export const createProductionProtectedTaskApplyGrantPort =
  createProtectedTaskApplyPort.bind(
    undefined,
    finalizeProtectedTaskApplyUnderGrant,
  );
