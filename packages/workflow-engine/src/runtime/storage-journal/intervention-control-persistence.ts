/**
 * Exposes durable intervention, sidecar, adoption, and control-update operations.
 *
 * Invariants:
 * - Existing callers retain the same public functions, types, and persisted record contracts.
 * - Each operation remains owned by its original lock and publication sequence.
 *
 * Depends on: intervention stores, sidecar records, and shared private persistence primitives.
 * Failure modes: incompatible callers, lost workflow bindings, or operations routed to the wrong durable owner.
 */

export {
  type PersistenceHumanSignatureVerifier,
  type PersistenceHumanDependencies,
  type InterventionControlPersistencePaths,
  type ChildWorktreeMetadata,
  type PersistedInterventionRecord,
  type BootstrapSidecarSessionEventKind,
  type BootstrapSidecarSessionHistoryEntry,
  type BootstrapMaintenanceWorkflowStatus,
  type BootstrapMaintenanceWorkflowBindingV1,
  type PersistedBootstrapSidecarSessionV2,
  type PersistedTransitionObservation,
  type PersistedEngineAdoptionRecord,
  type PersistedBootstrapSidecarPromotionPin,
  type PersistedControlPlaneUpdateRecordV3,
  type PersistedControlPlaneUpdateRecord,
} from './intervention-persistence-contracts.ts';

export {
  interventionControlPersistencePaths,
  interventionRecordPath,
  persistedBootstrapSidecarSessionPath,
  engineAdoptionRecordPath,
  bootstrapSidecarPromotionPinPath,
  controlPlaneUpdateRecordPath,
} from './intervention-persistence-paths.ts';

export {
  persistInterventionPlan,
  readPersistedIntervention,
} from './intervention-plan-store.ts';

export {
  readPersistedBootstrapSidecarWorkflow,
  findPersistedBootstrapSidecarSessionForIntervention,
  recordBootstrapSidecarWorkspaceMaterialized,
  recordBootstrapSidecarArtifactReady,
  recordBootstrapSidecarAdopted,
  recordBootstrapSidecarAbandoned,
} from './intervention-sidecar-store.ts';

export {
  reserveBootstrapSidecarPromotion,
  advanceBootstrapSidecarPromotionPin,
  readBootstrapSidecarPromotionPin,
  activeBootstrapSidecarPromotionPinTxIds,
  recordBootstrapSidecarPromotionIfPresent,
} from './intervention-promotion-store.ts';

export {
  preparePersistedEngineAdoption,
  advancePersistedEngineAdoption,
  renewPersistedEngineAdoptionAuthority,
  recoverPersistedEngineAdoption,
  rollbackPersistedEngineAdoption,
  readPersistedEngineAdoption,
  inFlightPersistedEngineAdoptionTxIds,
} from './intervention-adoption-store.ts';

export {
  preparePersistedControlPlaneUpdateV3,
  advancePersistedControlPlaneUpdate,
  recoverPersistedControlPlaneUpdate,
  readPersistedControlPlaneUpdate,
} from './intervention-update-store.ts';

export { activeBootstrapMaintenanceWorkflowBindingDigest } from './intervention-sidecar-records.ts';

export { withInterventionParentOperation } from './intervention-persistence-locks.ts';
