/** Coordinates reviewed refresh records and lock-scoped validation through feature storage. */
import {
  assertReviewInput,
  assertApprovedReview,
  assertCurrentRefreshPolicy,
  digest,
  replaceSection,
  reviewedRefreshPolicyDigest,
  reviewedReplacement,
  parseProposalRecord,
  parseReviewRecord,
  type ProposalRecord,
  type ReviewRecord,
} from '../../modules/projection/document-refresh-policy.ts';
import type { DocumentRefreshStorage } from '../../modules/projection/document-refresh-storage.ts';

export function proposeDocumentRefresh(
  storage: DocumentRefreshStorage,
  requestedTarget: string,
  section: string,
  replacement: string,
) {
  const document = storage.openTarget(requestedTarget);
  const policyDigest = reviewedRefreshPolicyDigest(
    document.readPolicy(),
    document.target,
  );
  const current = document.readText();
  const result = replaceSection(current, section, replacement);
  const record: ProposalRecord = {
    schemaVersion: 1,
    kind: 'document-refresh-proposal',
    createdAt: new Date().toISOString(),
    target: document.target,
    section,
    sourceDigest: digest(current),
    resultDigest: digest(result),
    policyDigest,
    replacement,
  };
  const proposalId = storage.writeRecord(record);
  return {
    proposalId,
    target: record.target,
    resultDigest: record.resultDigest,
  };
}

export function reviewDocumentRefresh(
  storage: DocumentRefreshStorage,
  proposalId: string,
  decision: 'approve' | 'reject',
  reviewer: string,
) {
  assertReviewInput(decision, reviewer);
  parseProposalRecord(storage.readRecord('proposal', proposalId));
  const record: ReviewRecord = {
    schemaVersion: 1,
    kind: 'document-refresh-review',
    createdAt: new Date().toISOString(),
    proposalId,
    decision,
    reviewer,
  };
  return { reviewId: storage.writeRecord(record), decision };
}

export function inspectDocumentRefreshProposal(
  storage: DocumentRefreshStorage,
  proposalId: string,
) {
  const proposal = parseProposalRecord(
    storage.readRecord('proposal', proposalId),
  );
  return {
    proposalId,
    createdAt: proposal.createdAt,
    target: proposal.target,
    section: proposal.section,
    sourceDigest: proposal.sourceDigest,
    resultDigest: proposal.resultDigest,
    policyDigest: proposal.policyDigest,
    replacement: proposal.replacement,
  };
}

export function applyDocumentRefresh(
  storage: DocumentRefreshStorage,
  proposalId: string,
  reviewId: string,
) {
  const proposal = parseProposalRecord(
    storage.readRecord('proposal', proposalId),
  );
  const review = parseReviewRecord(storage.readRecord('review', reviewId));
  assertApprovedReview(proposalId, review);
  const document = storage.openTarget(proposal.target);
  return document.withLock((commit) => {
    assertCurrentRefreshPolicy(proposal, document.readPolicy());
    const result = reviewedReplacement(proposal, document.readText());
    commit(result);
    return { target: document.target, resultDigest: proposal.resultDigest };
  });
}
