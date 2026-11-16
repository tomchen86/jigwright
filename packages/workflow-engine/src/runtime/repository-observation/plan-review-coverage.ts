/** Observes the exact Git blob and ledger subject sealed into review coverage. */
import { readFileAtCommit } from '../repository-transaction/git.ts';
import { readLedgerEntry } from '../storage-journal/semantic-ledger-store.ts';
import { sha256 } from '../../modules/assurance/plan-review-values.ts';
import type { PlanReviewCoverageTargetReader } from '../../modules/assurance/plan-review-coverage.ts';

export const readPlanReviewCoverageTarget: PlanReviewCoverageTargetReader = (
  repositoryRoot,
  requirement,
  binding,
) => {
  if (!binding.reusedFromLedger) {
    const content = readFileAtCommit(
      repositoryRoot,
      requirement.baselineCommit,
      binding.path,
    );
    return content === undefined ? 'missing' : `sha256:${sha256(content)}`;
  }
  try {
    const entry = readLedgerEntry(repositoryRoot, binding.ledgerEntryId!);
    if (
      entry.subject.subjectId !== binding.subjectId ||
      entry.subject.path !== binding.path ||
      entry.binding.sourceDigest !== binding.targetDigest
    ) {
      return 'mismatched-ledger-subject';
    }
    const content = readFileAtCommit(
      repositoryRoot,
      requirement.baselineCommit,
      binding.path,
    );
    return content === undefined ? 'missing' : `sha256:${sha256(content)}`;
  } catch {
    return 'missing-ledger-subject';
  }
};
