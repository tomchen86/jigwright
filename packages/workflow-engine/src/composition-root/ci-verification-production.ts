/** Assembles deterministic CI, protected-base attestations and pre-merge assurance. */
import { createPullRequestVerifier } from '../application/assurance/pull-request-verification.ts';
import { createBaseAuthorityAttestationVerifier } from '../application/assurance/base-authority-attestation.ts';
import { createPreMergeVerifier } from '../application/assurance/pre-merge-verification.ts';
import { ciRepositoryObservations } from '../runtime/repository-validation/commit-replay/ci-verification.ts';
import {
  readPreMergeAssuranceForRepository,
  storePreMergeAssuranceForRepository,
} from '../runtime/storage-journal/pre-merge-assurance-repository.ts';
import { readHumanResolutionAuditTag } from '../runtime/repository-observation/human-resolution-grants.ts';
import {
  verifySshDataSignature,
  verifyTrustedCommitSignature,
} from '../adapters/signing/ssh/ci-signature.ts';
import { validateWorkflowIntegrationAssets } from '../adapters/consumer/repository/work-registry/integration-assets.ts';
import {
  listVerifiedRoleContextSharingTerminalReceipts,
  assertRoleContextSharingTerminalReceiptUseBijection,
} from './role-context-sharing-terminal-receipt-production.ts';
import { runCiChecksAtCommit } from './check-execution-production.ts';
import {
  validateCiAuthorityCommit,
  collectHistoricalCollaborationGrantUses,
  replayCommitSequence,
} from './ci-replay-production.ts';
import { validateRepositoryStateAtCommit } from './repository-validation.ts';
import { loadCommittedChangeContract } from './consumer-contract-production.ts';
import { productionPlanningAssurance } from './planning-assurance-production.ts';
import { productionConsumedPlanReviewReplayPort } from './grant-verifier-composition.ts';

export const { verifyBaseAuthorityAttestations } =
  createBaseAuthorityAttestationVerifier({
    ...ciRepositoryObservations,
    listVerifiedRoleContextSharingTerminalReceipts,
    validateCiAuthorityCommit,
    verifySshDataSignature,
    verifyTrustedCommitSignature,
    readHumanResolutionAuditTag,
  });
export const { verifyPullRequest } = createPullRequestVerifier({
  ...ciRepositoryObservations,
  verifyBaseAuthorityAttestations,
  validateRepositoryStateAtCommit,
  validateWorkflowIntegrationAssets,
  loadCommittedChangeContract,
  collectHistoricalCollaborationGrantUses,
  replayCommitSequence,
  assertRoleContextSharingTerminalReceiptUseBijection,
  runCiChecksAtCommit,
});
export const {
  preparePullRequestPreMergeAssurance,
  verifyPullRequestWithPreMergeAssurance,
  completePreparedPullRequestPreMergeAssurance,
} = createPreMergeVerifier({
  ...ciRepositoryObservations,
  verifyPullRequest,
  loadCommittedChangeContract,
  productionPlanningAssurance,
  productionConsumedPlanReviewReplayPort,
  readPreMergeAssuranceForRepository,
  storePreMergeAssuranceForRepository,
});
