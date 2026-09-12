/** Assemble authority commands around required current grant and candidate services. */
import { authorityAttestationOperations } from './maintainer-attestation-production.ts';
import { authorityApplicationReceipts } from './authority-application-receipt-production.ts';
import { maintainerManifestOperations } from './maintainer-manifest-production.ts';
import { taskMandateOperations } from './task-mandate-production.ts';
import { approveAndApplyMaintainerGrantV2 as approveAndApplyMaintainerGrantV2WithMandate } from '../application/control-plane/maintainer-approve.ts';
import { reissueAndApplyMaintainerGrantV2 as reissueAndApplyMaintainerGrantV2WithMandate } from '../application/control-plane/maintainer-approve.ts';
import { recoverAuthorityCommit as recoverAuthorityCommitWithMandate } from '../application/control-plane/maintainer-recovery.ts';
import { startAuthoritySession as startAuthoritySessionWithMandate } from '../application/control-plane/maintainer-session.ts';
import { inspectActiveAuthoritySession as inspectActiveAuthoritySessionWithMandate } from '../application/control-plane/maintainer-session.ts';
import { checkAuthoritySession as checkAuthoritySessionWithMandate } from '../application/control-plane/maintainer-session.ts';
import { commitAuthoritySession as commitAuthoritySessionWithMandate } from '../application/control-plane/maintainer-commit.ts';
import { approveAndApplyAuthorityPlan as approveAndApplyAuthorityPlanWithMandate } from '../application/control-plane/authority-plan.ts';
import { prepareMaintainerGrantV2Checks as prepareMaintainerGrantV2ChecksWithManifest } from '../application/control-plane/maintainer-approve.ts';
import { createAuthorityPlan as createAuthorityPlanWithManifest } from '../application/control-plane/authority-plan.ts';
import { projectAuthorityAttestationRelay as projectAuthorityAttestationRelayWithReceipts } from './maintainer-attestation-production.ts';
import { issueAuthorityAttestation as issueAuthorityAttestationWithReceipts } from './maintainer-attestation-production.ts';
import { resumeAuthorityPlan as resumeAuthorityPlanWithReceipts } from '../application/control-plane/authority-plan.ts';
import { attestAuthorityPlan as attestAuthorityPlanWithReceipts } from '../application/control-plane/authority-plan.ts';
import type { MaintainerGrantExecutionServices } from '../application/control-plane/maintainer-grant-v2.ts';

export function createMaintainerAuthorityProduction(
  maintainerGrantExecutionServices: MaintainerGrantExecutionServices,
) {
  const issueMaintainerGrantV2WithMandate =
    maintainerGrantExecutionServices.issueMaintainerGrantV2;
  const issueMaintainerGrantV2 = issueMaintainerGrantV2WithMandate.bind(
    undefined,
    maintainerManifestOperations,
    taskMandateOperations,
  );
  const validateMaintainerGrantV2AuthorityBindingWithMandate =
    maintainerGrantExecutionServices.validateMaintainerGrantV2AuthorityBinding;
  const validateMaintainerGrantV2AuthorityBinding =
    validateMaintainerGrantV2AuthorityBindingWithMandate.bind(
      undefined,
      maintainerManifestOperations,
      taskMandateOperations,
    );
  const approveAndApplyMaintainerGrantV2 =
    approveAndApplyMaintainerGrantV2WithMandate.bind(
      undefined,
      maintainerGrantExecutionServices,
      authorityApplicationReceipts,
      maintainerManifestOperations,
      taskMandateOperations,
    );
  const reissueAndApplyMaintainerGrantV2 =
    reissueAndApplyMaintainerGrantV2WithMandate.bind(
      undefined,
      maintainerGrantExecutionServices,
      authorityApplicationReceipts,
      maintainerManifestOperations,
      taskMandateOperations,
    );
  const recoverAuthorityCommit = recoverAuthorityCommitWithMandate.bind(
    undefined,
    maintainerGrantExecutionServices,
    authorityApplicationReceipts,
    taskMandateOperations,
  );
  const startAuthoritySession = startAuthoritySessionWithMandate.bind(
    undefined,
    maintainerGrantExecutionServices,
    maintainerManifestOperations,
    taskMandateOperations,
  );
  const inspectActiveAuthoritySession =
    inspectActiveAuthoritySessionWithMandate.bind(
      undefined,
      maintainerGrantExecutionServices,
      maintainerManifestOperations,
      taskMandateOperations,
    );
  const checkAuthoritySession = checkAuthoritySessionWithMandate.bind(
    undefined,
    maintainerGrantExecutionServices,
    maintainerManifestOperations,
    taskMandateOperations,
  );
  const commitAuthoritySession = commitAuthoritySessionWithMandate.bind(
    undefined,
    maintainerGrantExecutionServices,
    authorityApplicationReceipts,
    maintainerManifestOperations,
    taskMandateOperations,
  );
  const approveAndApplyAuthorityPlan =
    approveAndApplyAuthorityPlanWithMandate.bind(
      undefined,
      maintainerGrantExecutionServices,
      authorityApplicationReceipts,
      maintainerManifestOperations,
      taskMandateOperations,
    );
  const preflightMaintainerGrantV2WithManifest =
    maintainerGrantExecutionServices.preflightMaintainerGrantV2;
  const preflightMaintainerGrantV2 =
    preflightMaintainerGrantV2WithManifest.bind(
      undefined,
      maintainerManifestOperations,
    );
  const prepareMaintainerGrantV2Checks =
    prepareMaintainerGrantV2ChecksWithManifest.bind(
      undefined,
      maintainerGrantExecutionServices,
      maintainerManifestOperations,
    );
  const createAuthorityPlan = createAuthorityPlanWithManifest.bind(
    undefined,
    maintainerManifestOperations,
  );
  const projectAuthorityAttestationRelay =
    projectAuthorityAttestationRelayWithReceipts.bind(
      undefined,
      authorityApplicationReceipts,
    );
  const issueAuthorityAttestation = issueAuthorityAttestationWithReceipts.bind(
    undefined,
    authorityApplicationReceipts,
  );
  const resumeAuthorityPlan = resumeAuthorityPlanWithReceipts.bind(
    undefined,
    authorityAttestationOperations,
    authorityApplicationReceipts,
  );
  const attestAuthorityPlan = attestAuthorityPlanWithReceipts.bind(
    undefined,
    authorityAttestationOperations,
    authorityApplicationReceipts,
  );
  return {
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
  };
}

export type MaintainerAuthorityOperations = ReturnType<
  typeof createMaintainerAuthorityProduction
>;
