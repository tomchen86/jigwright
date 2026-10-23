/** Bootstrap package verification and ordinary repository safety fences. */
export { verifyBuiltInEngineClosure } from './control-plane-bootstrap-closure.ts';
export { bootstrapInterventionStateRoot } from './control-plane-bootstrap-files.ts';
export {
  assertParentInterventionFenceCleared,
  resolveParentInterventionFence,
} from './control-plane-bootstrap-local.ts';
export {
  bootstrapRecoveryAuthorityStateRoot,
  resolveRecoveryOperationalTrustRootFence,
  resolveRecoveryQuarantineMarker,
} from './control-plane-bootstrap-quarantine.ts';
export type {
  BootstrapParentInterventionFence,
  BootstrapRecoveryQuarantineMarker,
  BootstrapWorktreeIdentity,
} from './control-plane-bootstrap-types.ts';
