/** Binds task-strategy retry observations at the production boundary. */
import type {
  TaskStrategyImplementationOperations,
  TaskStrategyImplementationJournal,
} from '../application/execute-task/task-strategy-implementation-operations.ts';
import {
  getSession,
  loadActiveSessionContext,
} from '../runtime/repository-observation/workflow-session-context.ts';
import { observeInvestigationRuntimeContext } from '../runtime/repository-observation/investigation-runtime-context.ts';
import { inspectSession } from '../application/session-inspection/session-inspection.ts';
import {
  resolveCurrentTaskStrategyCorrection,
  resolveCurrentTaskStrategyImplementationAuthority,
} from './task-strategy-correction-production.ts';
import {
  adoptCurrentTaskStrategyImplementation,
  adoptCurrentTaskStrategyCorrection,
  validateTaskStrategyProviderPatch,
  validateTaskStrategyCallerPatch,
  importTaskStrategyProviderPatchUnderLifecycleLock,
  importTaskStrategyCallerPatchUnderLifecycleLock,
} from './task-strategy-patch-production.ts';
import { readFileAtRevision } from '../runtime/repository-transaction/git-command.ts';
import { resolveBlobOid } from '../runtime/repository-transaction/git-object-ids.ts';
import { previewExactStaging } from '../runtime/repository-transaction/git-transitions.ts';
import {
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from '../runtime/session-workspace/session-store.ts';
import { AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT } from '../runtime/provider-policy/ai-adapter-policy.ts';
import {
  DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  readTaskStrategyGreenFailureRecord,
} from '../runtime/storage-journal/task-strategy-correction-store.ts';
import { readTaskStrategyTransaction } from '../runtime/storage-journal/task-strategy-store.ts';
import {
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchCurrentBinding,
} from '../runtime/storage-journal/task-strategy-patch-store.ts';
import {
  reserveTaskStrategyCorrectionRound,
  publishTaskStrategyCorrectionRoundResult,
  publishTaskStrategyCorrectionRoundImport,
  readTaskStrategyCorrectionRound,
  listTaskStrategyCorrectionRounds,
} from '../runtime/storage-journal/task-strategy-correction-round-store.ts';
import {
  readTaskStrategyImplementationReservation,
  createTaskStrategyImplementationReservation,
  readTaskStrategyImplementationResultBinding,
  createTaskStrategyImplementationResultBinding,
  readTaskStrategyCallerImplementationReservation,
  createTaskStrategyCallerImplementationReservation,
  readTaskStrategyCallerImplementationBinding,
  createTaskStrategyCallerImplementationBinding,
  readTaskStrategyImplementationProviderAttempt,
  readCurrentTaskStrategyImplementationProviderAttempt,
  assertTaskStrategyImplementationProviderAuthorityCurrent,
  assertTaskStrategyCallerImplementationReservationAuthorityCurrent,
  assertTaskStrategyCallerImplementationAuthorityCurrent,
} from '../runtime/storage-journal/task-strategy-provider-store.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderInvocationManifest,
  providerInvocationExists,
  createProviderInvocation,
  createProviderRetryReservation,
  storeProviderExecutionPolicySnapshot,
} from '../runtime/storage-journal/provider-invocation-store.ts';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from '../runtime/storage-journal/evidence-object-store.ts';
import { inspectCollaborationGrantsUnderLifecycleLock } from '../runtime/storage-journal/collaboration-grant-records.ts';
import {
  reserveCollaborationGrantUnderLifecycleLock,
  readReservedCollaborationGrantUnderLifecycleLock,
} from '../runtime/storage-journal/collaboration-grant-reservation.ts';
import { consumeCollaborationGrantUnderLifecycleLock } from '../runtime/storage-journal/collaboration-grant-consumption.ts';
import { taskMandateOperations } from './task-mandate-production.ts';
import { reviewedGeneratedAssets } from './planning-provider-authoring-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import {
  beginTaskStrategyRedRevision,
  continueTaskStrategyRedRevision,
} from './task-strategy-red-revision-production.ts';
import { createTaskStrategyImplementationLifecycle } from '../application/execute-task/task-strategy-implementation-lifecycle.ts';
import { roleResultAdmission } from './role-admission-production.ts';
import { createTaskStrategyLifecycle } from '../application/execute-task/task-strategy-lifecycle.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import {
  inspectTaskMechanicalTransformLifecycle,
  resumeTaskMechanicalTransformation,
} from '../application/execute-task/task-mechanical-transform-lifecycle.ts';
import { sealTaskStrategyRed } from '../application/execute-task/task-strategy-execution.ts';
import { readProviderRetryAccountingEvidence } from '../runtime/storage-journal/provider-retry-accounting-reader.ts';

/** Each call observes paths afresh; binding the journal performs no record reads. */
function observeImplementationJournal(
  cwd: string,
): TaskStrategyImplementationJournal {
  const paths = observeInvestigationRuntimeContext(cwd).runtime;
  return {
    paths,
    evidence: {
      read: readEvidenceNode.bind(undefined, paths),
      write: writeEvidenceNode.bind(undefined, paths),
    },
    implementation: {
      readReservation: readTaskStrategyImplementationReservation.bind(
        undefined,
        paths,
      ),
      reserve: createTaskStrategyImplementationReservation.bind(
        undefined,
        paths,
      ),
      readResult: readTaskStrategyImplementationResultBinding.bind(
        undefined,
        paths,
      ),
      publishResult: createTaskStrategyImplementationResultBinding.bind(
        undefined,
        paths,
      ),
      readCallerReservation:
        readTaskStrategyCallerImplementationReservation.bind(undefined, paths),
      reserveCaller: createTaskStrategyCallerImplementationReservation.bind(
        undefined,
        paths,
      ),
      readCallerResult: readTaskStrategyCallerImplementationBinding.bind(
        undefined,
        paths,
      ),
      publishCallerResult: createTaskStrategyCallerImplementationBinding.bind(
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
      assertProviderCurrent:
        assertTaskStrategyImplementationProviderAuthorityCurrent.bind(
          undefined,
          paths,
        ),
      assertCallerReservationCurrent:
        assertTaskStrategyCallerImplementationReservationAuthorityCurrent.bind(
          undefined,
          paths,
        ),
      assertCallerCurrent:
        assertTaskStrategyCallerImplementationAuthorityCurrent.bind(
          undefined,
          paths,
        ),
    },
    provider: {
      exists: providerInvocationExists.bind(undefined, paths),
      read: readProviderInvocation.bind(undefined, paths),
      readRequest: readProviderInvocationRequest.bind(undefined, paths),
      readManifest: readProviderInvocationManifest.bind(undefined, paths),
      storePolicy: storeProviderExecutionPolicySnapshot.bind(undefined, paths),
      create: createProviderInvocation.bind(undefined, paths),
      reserveRetry: createProviderRetryReservation.bind(undefined, paths),
    },
    correction: {
      readTransaction: readTaskStrategyTransaction.bind(undefined, paths),
      readFailure: readTaskStrategyGreenFailureRecord.bind(undefined, paths),
      readRound: readTaskStrategyCorrectionRound.bind(undefined, paths),
      listRounds: listTaskStrategyCorrectionRounds.bind(undefined, paths),
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
    patch: {
      readRecord: readTaskStrategyPatchRecord.bind(undefined, paths),
      readCurrentBinding: readTaskStrategyPatchCurrentBinding.bind(
        undefined,
        paths,
      ),
    },
  };
}

const implementationOperations: TaskStrategyImplementationOperations = {
  session: {
    loadActive: loadActiveSessionContext,
    inspectExpected: (cwd, sessionId, expectedSession) =>
      inspectSession(productionChangeContract, cwd, sessionId, {
        expectedSession,
      }),
    previewCandidate: previewExactStaging,
    resolveCorrection: resolveCurrentTaskStrategyCorrection,
  },
  observeJournal: observeImplementationJournal,
  locks: {
    repository: withRepositoryLifecycleOperation,
    session: withSessionOperation,
  },
  baseline: {
    readDocument: readFileAtRevision,
    readMaintainerBlob: (repositoryRoot, commit) =>
      resolveBlobOid(repositoryRoot, commit, 'workflow/maintainer-policy.json'),
  },
  collaboration: {
    inspect: inspectCollaborationGrantsUnderLifecycleLock,
    reserve: reserveCollaborationGrantUnderLifecycleLock,
    readReserved: readReservedCollaborationGrantUnderLifecycleLock,
    consume: consumeCollaborationGrantUnderLifecycleLock,
  },
  patches: {
    validateProvider: validateTaskStrategyProviderPatch,
    validateCaller: validateTaskStrategyCallerPatch,
    importProvider: importTaskStrategyProviderPatchUnderLifecycleLock,
    importCaller: importTaskStrategyCallerPatchUnderLifecycleLock,
  },
  dataPolicy: AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  correctionPolicy: DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  clock: { now: () => new Date() },
};

const implementation = createTaskStrategyImplementationLifecycle(
  implementationOperations,
  roleResultAdmission,
  taskMandateOperations,
);
export const beginTaskStrategyImplementation =
  implementation.beginTaskStrategyImplementation.bind(
    undefined,
    readProviderRetryAccountingEvidence,
  );
const lifecycle = createTaskStrategyLifecycle({
  session: {
    read: getSession,
    discoverRepository,
    loadStableContract:
      productionChangeContract.loadStableValidatedChangeContract,
    inspect: inspectSession.bind(undefined, productionChangeContract),
    resolveCorrection: resolveCurrentTaskStrategyCorrection,
    resolveImplementationAuthority:
      resolveCurrentTaskStrategyImplementationAuthority,
  },
  observeJournal: observeImplementationJournal,
  mechanical: {
    inspect: inspectTaskMechanicalTransformLifecycle.bind(
      undefined,
      reviewedGeneratedAssets,
      productionChangeContract,
    ),
    resume: resumeTaskMechanicalTransformation.bind(
      undefined,
      reviewedGeneratedAssets,
      productionChangeContract,
    ),
  },
  red: {
    seal: sealTaskStrategyRed.bind(undefined, productionChangeContract),
    beginRevision: beginTaskStrategyRedRevision,
    continueRevision: continueTaskStrategyRedRevision,
  },
  adopt: {
    implementation: adoptCurrentTaskStrategyImplementation,
    correction: adoptCurrentTaskStrategyCorrection,
  },
  implementation,
  readProviderRetryAccountingEvidence,
});
export const { inspectTaskStrategyLifecycle, resumeTaskStrategy } = lifecycle;
export const {
  inspectTaskStrategyImplementation,
  assertTaskStrategyImplementationProviderOwnerCurrent,
} = implementation;

export type * from '../application/execute-task/task-strategy-implementation-lifecycle.ts';
export type * from '../application/execute-task/task-strategy-lifecycle.ts';
