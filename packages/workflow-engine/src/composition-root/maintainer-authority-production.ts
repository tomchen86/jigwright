import { authorityAttestationOperations } from './maintainer-attestation-production.ts';
import { authorityApplicationReceipts } from './authority-application-receipt-production.ts';
import { maintainerManifestOperations } from './maintainer-manifest-production.ts';
/** Binds maintained authority operations to live manifest observations and Task Mandate services. */
import { taskMandateOperations } from './task-mandate-production.ts';
import { issueMaintainerGrantV2 as issueMaintainerGrantV2WithMandate } from '../modules/authority/maintainer-grant-v2.ts';
export const issueMaintainerGrantV2 = issueMaintainerGrantV2WithMandate.bind(
  undefined,
  maintainerManifestOperations,
  taskMandateOperations,
);
import { validateMaintainerGrantV2AuthorityBinding as validateMaintainerGrantV2AuthorityBindingWithMandate } from '../modules/authority/maintainer-grant-v2.ts';
export const validateMaintainerGrantV2AuthorityBinding =
  validateMaintainerGrantV2AuthorityBindingWithMandate.bind(
    undefined,
    maintainerManifestOperations,
    taskMandateOperations,
  );
import { approveAndApplyMaintainerGrantV2 as approveAndApplyMaintainerGrantV2WithMandate } from '../application/control-plane/maintainer-approve.ts';
export const approveAndApplyMaintainerGrantV2 =
  approveAndApplyMaintainerGrantV2WithMandate.bind(
    undefined,
    authorityApplicationReceipts,
    maintainerManifestOperations,
    taskMandateOperations,
  );
import { reissueAndApplyMaintainerGrantV2 as reissueAndApplyMaintainerGrantV2WithMandate } from '../application/control-plane/maintainer-approve.ts';
export const reissueAndApplyMaintainerGrantV2 =
  reissueAndApplyMaintainerGrantV2WithMandate.bind(
    undefined,
    authorityApplicationReceipts,
    maintainerManifestOperations,
    taskMandateOperations,
  );
import { recoverAuthorityCommit as recoverAuthorityCommitWithMandate } from '../application/control-plane/maintainer-recovery.ts';
export const recoverAuthorityCommit = recoverAuthorityCommitWithMandate.bind(
  undefined,
  authorityApplicationReceipts,
  taskMandateOperations,
);
import { startAuthoritySession as startAuthoritySessionWithMandate } from '../application/control-plane/maintainer-session.ts';
export const startAuthoritySession = startAuthoritySessionWithMandate.bind(
  undefined,
  maintainerManifestOperations,
  taskMandateOperations,
);
import { inspectActiveAuthoritySession as inspectActiveAuthoritySessionWithMandate } from '../application/control-plane/maintainer-session.ts';
export const inspectActiveAuthoritySession =
  inspectActiveAuthoritySessionWithMandate.bind(
    undefined,
    maintainerManifestOperations,
    taskMandateOperations,
  );
import { checkAuthoritySession as checkAuthoritySessionWithMandate } from '../application/control-plane/maintainer-session.ts';
export const checkAuthoritySession = checkAuthoritySessionWithMandate.bind(
  undefined,
  maintainerManifestOperations,
  taskMandateOperations,
);
import { commitAuthoritySession as commitAuthoritySessionWithMandate } from '../application/control-plane/maintainer-commit.ts';
export const commitAuthoritySession = commitAuthoritySessionWithMandate.bind(
  undefined,
  authorityApplicationReceipts,
  maintainerManifestOperations,
  taskMandateOperations,
);
import { approveAndApplyAuthorityPlan as approveAndApplyAuthorityPlanWithMandate } from '../application/control-plane/authority-plan.ts';
export const approveAndApplyAuthorityPlan =
  approveAndApplyAuthorityPlanWithMandate.bind(
    undefined,
    authorityApplicationReceipts,
    maintainerManifestOperations,
    taskMandateOperations,
  );

import { preflightMaintainerGrantV2 as preflightMaintainerGrantV2WithManifest } from '../modules/authority/maintainer-grant-v2.ts';
export const preflightMaintainerGrantV2 =
  preflightMaintainerGrantV2WithManifest.bind(
    undefined,
    maintainerManifestOperations,
  );

import { prepareMaintainerGrantV2Checks as prepareMaintainerGrantV2ChecksWithManifest } from '../application/control-plane/maintainer-approve.ts';
export const prepareMaintainerGrantV2Checks =
  prepareMaintainerGrantV2ChecksWithManifest.bind(
    undefined,
    maintainerManifestOperations,
  );

import { createAuthorityPlan as createAuthorityPlanWithManifest } from '../application/control-plane/authority-plan.ts';
export const createAuthorityPlan = createAuthorityPlanWithManifest.bind(
  undefined,
  maintainerManifestOperations,
);

import { projectAuthorityAttestationRelay as projectAuthorityAttestationRelayWithReceipts } from './maintainer-attestation-production.ts';
export const projectAuthorityAttestationRelay =
  projectAuthorityAttestationRelayWithReceipts.bind(
    undefined,
    authorityApplicationReceipts,
  );

import { issueAuthorityAttestation as issueAuthorityAttestationWithReceipts } from './maintainer-attestation-production.ts';
export const issueAuthorityAttestation =
  issueAuthorityAttestationWithReceipts.bind(
    undefined,
    authorityApplicationReceipts,
  );

import { resumeAuthorityPlan as resumeAuthorityPlanWithReceipts } from '../application/control-plane/authority-plan.ts';
export const resumeAuthorityPlan = resumeAuthorityPlanWithReceipts.bind(
  undefined,
  authorityAttestationOperations,
  authorityApplicationReceipts,
);

import { attestAuthorityPlan as attestAuthorityPlanWithReceipts } from '../application/control-plane/authority-plan.ts';
export const attestAuthorityPlan = attestAuthorityPlanWithReceipts.bind(
  undefined,
  authorityAttestationOperations,
  authorityApplicationReceipts,
);
