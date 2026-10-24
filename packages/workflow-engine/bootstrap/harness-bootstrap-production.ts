/** Bind recovery services inside the independently verified host. */
import { createHarnessBootstrapProduction } from '../src/composition-root/harness-bootstrap-production.ts';

export const harnessBootstrapProduction = createHarnessBootstrapProduction();
export const {
  createHarnessBootstrapDependencies,
  auditHarnessRecoveryRefusal,
  productionRecoveryTrustRootAuditSink,
  productionRecoveryQuarantineAuditSink,
  recoveryOperationalTrustRootDependencies,
  recoveryQuarantineDependencies,
  createHarnessBootstrapCommandDispatcher,
} = harnessBootstrapProduction;
