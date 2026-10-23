/**
 * Exposes durable intervention, sidecar, and local adoption operations.
 *
 * Invariants:
 * - Existing callers retain the same public functions, types, and persisted record contracts.
 * - Each operation remains owned by its original lock and publication sequence.
 */
export { engineAdoptionRecordPath, interventionControlPersistencePaths, interventionRecordPath, persistedBootstrapSidecarSessionPath, } from "./intervention-persistence-paths.js";
export { persistInterventionPlan, readPersistedIntervention, } from "./intervention-plan-store.js";
export { findPersistedBootstrapSidecarSessionForIntervention, readPersistedBootstrapSidecarWorkflow, recordBootstrapSidecarAbandoned, recordBootstrapSidecarAdopted, recordBootstrapSidecarArtifactReady, recordBootstrapSidecarWorkspaceMaterialized, } from "./intervention-sidecar-store.js";
export { advancePersistedEngineAdoption, inFlightPersistedEngineAdoptionTxIds, preparePersistedEngineAdoption, readPersistedEngineAdoption, recoverPersistedEngineAdoption, renewPersistedEngineAdoptionAuthority, rollbackPersistedEngineAdoption, } from "./intervention-adoption-store.js";
export { activeBootstrapMaintenanceWorkflowBindingDigest } from "./intervention-sidecar-records.js";
export { withInterventionParentOperation } from "./intervention-persistence-locks.js";
