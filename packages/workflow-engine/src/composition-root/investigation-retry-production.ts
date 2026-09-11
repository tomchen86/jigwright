import { taskMandateOperations } from './task-mandate-production.ts';
/** Supplies durable retry accounting to the investigation retry workflow. */
import { retryInvestigationProvider as retry } from '../adapters/planning/investigation/investigation-session.ts';
import { readProviderRetryAccountingEvidence } from '../runtime/storage-journal/provider-retry-accounting-reader.ts';

export const retryInvestigationProvider = retry.bind(
  undefined,
  taskMandateOperations,
  readProviderRetryAccountingEvidence,
);

export * from '../adapters/planning/investigation/investigation-session.ts';

import {
  startInvestigationSession as startSession,
  startInvestigationSessionUnderLifecycleLock as startLocked,
} from '../adapters/planning/investigation/investigation-session.ts';
export const startInvestigationSession = startSession.bind(
  undefined,
  taskMandateOperations,
);
export const startInvestigationSessionUnderLifecycleLock = startLocked.bind(
  undefined,
  taskMandateOperations,
);

import { createInvestigationHumanActionBlockerFactory } from '../modules/investigation/domain/human-resolution-contract.ts';
export const createInvestigationHumanActionBlocker =
  createInvestigationHumanActionBlockerFactory(() => new Date());
import {
  blockInvestigationForReviewerTerms as blockReviewer,
  blockInvestigationForReviewerTermsUnderAuthority as blockReviewerLocked,
  blockInvestigationForPlanReviewRetryUnderAuthority as blockRetryLocked,
} from '../adapters/planning/investigation/investigation-session.ts';
export const blockInvestigationForReviewerTerms = blockReviewer.bind(
  undefined,
  createInvestigationHumanActionBlocker,
);
export const blockInvestigationForReviewerTermsUnderAuthority =
  blockReviewerLocked.bind(undefined, createInvestigationHumanActionBlocker);
export const blockInvestigationForPlanReviewRetryUnderAuthority =
  blockRetryLocked.bind(undefined, createInvestigationHumanActionBlocker);

import {
  createInvestigationHumanResolutionOperations,
  reopenInvestigationForReviewerTerms as reopen,
  reopenInvestigationForReviewerTermsUnderAuthority as reopenLocked,
  inspectReviewerTermResolutionAuthorization as inspectReviewer,
} from '../adapters/planning/investigation/investigation-session.ts';
import {
  assertResolutionDecisionTarget,
  loadMaintainerPolicyForResolution,
} from '../runtime/repository-observation/human-resolution-grants.ts';
import {
  revokeStoredHumanResolutionGrant,
  verifyHumanResolutionGrantForRevocation,
} from './human-revocation-production.ts';
export const {
  inspectHumanResolutionGrants,
  inspectHumanResolutionGrantPublicationRecoveries,
  discardHumanResolutionGrantPublication,
  revokeHumanResolutionGrant,
  executeGrantCoreHumanResolution,
} = createInvestigationHumanResolutionOperations({
  assertResolutionDecisionTarget,
  loadMaintainerPolicyForResolution,
  revokeStoredHumanResolutionGrant,
  verifyHumanResolutionGrantForRevocation,
});
export const reopenInvestigationForReviewerTerms = reopen.bind(
  undefined,
  loadMaintainerPolicyForResolution,
);
export const reopenInvestigationForReviewerTermsUnderAuthority =
  reopenLocked.bind(undefined, loadMaintainerPolicyForResolution);
export const inspectReviewerTermResolutionAuthorization = inspectReviewer.bind(
  undefined,
  loadMaintainerPolicyForResolution,
);

import {
  acknowledgeReviewerTermInputClosure as acknowledge,
  acknowledgeReviewerTermInputClosureUnderAuthority as acknowledgeLocked,
} from '../adapters/planning/investigation/investigation-session.ts';
export const acknowledgeReviewerTermInputClosure = acknowledge.bind(
  undefined,
  loadMaintainerPolicyForResolution,
);
export const acknowledgeReviewerTermInputClosureUnderAuthority =
  acknowledgeLocked.bind(undefined, loadMaintainerPolicyForResolution);
