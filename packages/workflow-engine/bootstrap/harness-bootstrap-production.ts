/** Bind recovery services inside the independently verified host. */
import { createHarnessBootstrapProduction } from '../src/composition-root/harness-bootstrap-production.ts';
import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from './built-in-engine-closure-pin.ts';

export const harnessBootstrapProduction = createHarnessBootstrapProduction(
  BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
);
export const {
  resolveHarnessBootstrapParentState,
  createHarnessBootstrapDependencies,
  auditHarnessRecoveryRefusal,
  productionRecoveryTrustRootAuditSink,
  productionRecoveryQuarantineAuditSink,
  productionControlPlaneAuditSink,
  productionRecoveryAuditSink,
  recoveryOperationalTrustRootDependencies,
  recoveryQuarantineDependencies,
  createHarnessRecoveryDependencies,
  createHarnessBootstrapCommandDispatcher,
} = harnessBootstrapProduction;
