/**
 * Exposes durable intervention, sidecar, and local adoption operations.
 *
 * Invariants:
 * - Existing callers retain the same public functions, types, and persisted record contracts.
 * - Each operation remains owned by its original lock and publication sequence.
 */

export {
  type BootstrapMaintenanceWorkflowBindingV1,
  type BootstrapMaintenanceWorkflowStatus,
  type BootstrapSidecarSessionEventKind,
  type BootstrapSidecarSessionHistoryEntry,
  type ChildWorktreeMetadata,
  type InterventionControlPersistencePaths,
  type PersistedBootstrapSidecarSessionV2,
  type PersistedEngineAdoptionRecord,
  type PersistedInterventionRecord,
  type PersistedTransitionObservation,
  type PersistenceHumanDependencies,
  type PersistenceHumanSignatureVerifier,
} from './intervention-persistence-contracts.ts';

export {
  engineAdoptionRecordPath,
  interventionControlPersistencePaths,
  interventionRecordPath,
  persistedBootstrapSidecarSessionPath,
} from './intervention-persistence-paths.ts';

export {
  persistInterventionPlan,
  readPersistedIntervention,
} from './intervention-plan-store.ts';

export {
  findPersistedBootstrapSidecarSessionForIntervention,
  readPersistedBootstrapSidecarWorkflow,
  recordBootstrapSidecarAbandoned,
  recordBootstrapSidecarAdopted,
  recordBootstrapSidecarArtifactReady,
  recordBootstrapSidecarWorkspaceMaterialized,
} from './intervention-sidecar-store.ts';

export {
  advancePersistedEngineAdoption,
  inFlightPersistedEngineAdoptionTxIds,
  preparePersistedEngineAdoption,
  readPersistedEngineAdoption,
  recoverPersistedEngineAdoption,
  renewPersistedEngineAdoptionAuthority,
  rollbackPersistedEngineAdoption,
} from './intervention-adoption-store.ts';

export { activeBootstrapMaintenanceWorkflowBindingDigest } from './intervention-sidecar-records.ts';

export { withInterventionParentOperation } from './intervention-persistence-locks.ts';
