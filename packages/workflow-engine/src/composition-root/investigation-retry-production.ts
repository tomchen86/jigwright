import { taskMandateOperations } from './task-mandate-production.ts';
/** Supplies durable retry accounting to the investigation retry workflow. */
import { retryInvestigationProvider as retry } from '../runtime/investigation-lifecycle/investigation-session.ts';
import { readProviderRetryAccountingEvidence } from '../runtime/storage-journal/provider-retry-accounting-reader.ts';

export const retryInvestigationProvider = retry.bind(
  undefined,
  taskMandateOperations,
  readProviderRetryAccountingEvidence,
);

export * from '../runtime/investigation-lifecycle/investigation-session.ts';
export { createInvestigationCheckpointEnvelope } from '../modules/lifecycle/investigation-checkpoint-envelope.ts';
export {
  decideReviewerTermReopen,
  type ReviewerTermResolutionAuthorization,
} from '../modules/investigation/domain/reviewer-term-reopen.ts';

import {
  startInvestigationSession as startSession,
  startInvestigationSessionUnderLifecycleLock as startLocked,
} from '../runtime/investigation-lifecycle/investigation-session.ts';
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
} from '../runtime/investigation-lifecycle/investigation-session.ts';
export const blockInvestigationForReviewerTerms = blockReviewer.bind(
  undefined,
  createInvestigationHumanActionBlocker,
);
export const blockInvestigationForReviewerTermsUnderAuthority =
  blockReviewerLocked.bind(undefined, createInvestigationHumanActionBlocker);
export const blockInvestigationForPlanReviewRetryUnderAuthority =
  blockRetryLocked.bind(undefined, createInvestigationHumanActionBlocker);

import {
  reopenInvestigationForReviewerTerms as reopen,
  reopenInvestigationForReviewerTermsUnderAuthority as reopenLocked,
  inspectReviewerTermResolutionAuthorization as inspectReviewer,
} from '../runtime/investigation-lifecycle/investigation-session.ts';
import { loadMaintainerPolicyForResolution } from '../runtime/repository-observation/human-resolution-grants.ts';

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
} from '../runtime/investigation-lifecycle/investigation-session.ts';
export const acknowledgeReviewerTermInputClosure = acknowledge.bind(
  undefined,
  loadMaintainerPolicyForResolution,
);
export const acknowledgeReviewerTermInputClosureUnderAuthority =
  acknowledgeLocked.bind(undefined, loadMaintainerPolicyForResolution);
