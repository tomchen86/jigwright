/** Instantiate required maintainer services in the trusted host process. */
import { createMaintainerAuthorityProduction } from '../src/composition-root/maintainer-authority-production.ts';
import { createMaintainerGrantV2Production } from '../src/composition-root/maintainer-grant-v2-production.ts';
import { createCandidateDependencyObservations } from '../src/runtime/repository-observation/maintainer-candidate-dependencies.ts';
import { pinCheckRunner } from '../src/adapters/consumer/repository/work-registry/check-runner.ts';
import { resolveCandidateHarnessEngineDigest } from './candidate-engine-selection.ts';

export const maintainerGrantExecutionServices =
  createMaintainerGrantV2Production(
    createCandidateDependencyObservations({
      pinCheckRunner,
      resolveCandidateHarnessEngineDigest,
      currentEnvironment: () => process.env,
    }),
  );
export const maintainerAuthorityOperations =
  createMaintainerAuthorityProduction(maintainerGrantExecutionServices);
export const {
  issueMaintainerGrantV2,
  validateMaintainerGrantV2AuthorityBinding,
  approveAndApplyMaintainerGrantV2,
  reissueAndApplyMaintainerGrantV2,
  recoverAuthorityCommit,
  startAuthoritySession,
  inspectActiveAuthoritySession,
  checkAuthoritySession,
  commitAuthoritySession,
  approveAndApplyAuthorityPlan,
  preflightMaintainerGrantV2,
  prepareMaintainerGrantV2Checks,
  createAuthorityPlan,
  projectAuthorityAttestationRelay,
  issueAuthorityAttestation,
  resumeAuthorityPlan,
  attestAuthorityPlan,
} = maintainerAuthorityOperations;

import {
  bootstrapInterventionStateRoot,
  readInitialControlPlaneSupervisorAnchorEvidence,
  readBuiltInControlPlaneEngineArtifact,
} from './control-plane-trust.ts';
import type { ControlPlanePromotionBootstrapObservations } from '../src/modules/authority/intervention-bootstrap-contract.ts';
export const controlPlanePromotionBootstrapObservations: ControlPlanePromotionBootstrapObservations =
  {
    bootstrapInterventionStateRoot,
    readInitialControlPlaneSupervisorAnchorEvidence,
    readBuiltInControlPlaneEngineArtifact,
  };
