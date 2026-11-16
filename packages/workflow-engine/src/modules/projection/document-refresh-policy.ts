/** Pure section, policy and reviewed proposal decisions for curated document refreshes. */
import crypto from 'node:crypto';
import { markdownHeadings } from '@jigwright/core/markdown-sections';
import { normalizeChangedPath } from '../../foundation/repository-path/repository-path.ts';
import {
  ExitCode,
  workflowError,
  type ExitCodeValue,
} from '../../foundation/errors/errors.ts';
import { spliceProjectionRegion } from './projection-service.ts';

export type ProposalRecord = {
  schemaVersion: 1;
  createdAt: string;
  kind: 'document-refresh-proposal';
  target: string;
  section: string;
  sourceDigest: string;
  resultDigest: string;
  policyDigest: string;
  replacement: string;
};

export type ReviewRecord = {
  schemaVersion: 1;
  createdAt: string;
  kind: 'document-refresh-review';
  proposalId: string;
  decision: 'approve' | 'reject';
  reviewer: string;
};

export function replaceSection(
  current: string,
  section: string,
  replacement: string,
): string {
  const heading = /^(#{2,6}) [^\n]+$/.exec(section);
  const replacementHeadings = markdownHeadings(replacement);
  if (
    !heading ||
    replacement.split('\n')[0] !== section ||
    replacementHeadings[0]?.start !== 0 ||
    replacementHeadings[0]?.canonical !== section
  ) {
    throw refreshError(
      'DOCUMENT_SECTION_INVALID',
      'Replacement must begin with the exact scoped heading.',
      ExitCode.usage,
    );
  }
  const headings = markdownHeadings(current);
  const matches = headings.filter((item) => item.canonical === section);
  if (matches.length !== 1) {
    throw refreshError(
      'DOCUMENT_SECTION_NOT_UNIQUE',
      'Target must contain exactly one scoped heading.',
    );
  }
  const start = matches[0].start;
  const headingEnd = current.indexOf('\n', start);
  const afterHeading = headingEnd === -1 ? current.length : headingEnd + 1;
  const nextHeading = headings.find(
    (item) => item.start >= afterHeading && item.level <= heading[1].length,
  );
  const end = nextHeading?.start ?? current.length;
  const nested = replacementHeadings
    .slice(1)
    .some((item) => item.level <= heading[1].length);
  if (nested) {
    throw refreshError(
      'DOCUMENT_REPLACEMENT_ESCAPES_SECTION',
      'Replacement contains a heading outside the proposed section scope.',
      ExitCode.usage,
    );
  }
  const normalized = replacement.trimEnd();
  return spliceProjectionRegion(
    current,
    { start, end },
    `${normalized}${nextHeading !== undefined ? '\n\n' : '\n'}`,
  );
}

export function curatedTarget(value: string): string {
  const target = normalizeChangedPath(value);
  if (
    !target.endsWith('.md') ||
    (!target.startsWith('docs/architecture/') &&
      !target.startsWith('docs/features/'))
  ) {
    throw refreshError(
      'DOCUMENT_TARGET_NOT_CURATED',
      'Refresh target must be a Markdown file under architecture or features.',
      ExitCode.guard,
    );
  }
  return target;
}

export function reviewedRefreshPolicyDigest(
  content: string,
  target: string,
): string {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw refreshError(
      'DOCUMENT_REFRESH_POLICY_INVALID',
      'Document refresh policy is missing or invalid.',
      ExitCode.guard,
    );
  }
  const policyKey = target.startsWith('docs/architecture/')
    ? 'docs/architecture/**'
    : 'docs/features/**';
  const policy =
    isRecord(value) && isRecord(value.documents)
      ? value.documents[policyKey]
      : undefined;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.enforcementMode !== 'enforced' ||
    !isRecord(policy) ||
    policy.mode !== 'curated' ||
    policy.refresh !== 'reviewed-section'
  ) {
    throw refreshError(
      'DOCUMENT_REFRESH_NOT_AUTHORIZED',
      'Document policy does not authorize reviewed section refreshes.',
      ExitCode.guard,
    );
  }
  return digest(content);
}

export function parseProposalRecord(value: unknown): ProposalRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    value.kind !== 'document-refresh-proposal' ||
    typeof value.target !== 'string' ||
    typeof value.section !== 'string' ||
    typeof value.replacement !== 'string' ||
    !isDigest(value.sourceDigest) ||
    !isDigest(value.resultDigest) ||
    !isDigest(value.policyDigest)
  ) {
    throw refreshError('DOCUMENT_PROPOSAL_INVALID', 'Proposal is invalid.');
  }
  return value as ProposalRecord;
}

export function parseReviewRecord(value: unknown): ReviewRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    value.kind !== 'document-refresh-review' ||
    !isDigest(value.proposalId) ||
    !['approve', 'reject'].includes(String(value.decision)) ||
    !isSafeText(value.reviewer)
  ) {
    throw refreshError('DOCUMENT_REVIEW_INVALID', 'Review is invalid.');
  }
  return value as ReviewRecord;
}

export function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isSafeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    !value.includes('\n')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function refreshError(
  code: string,
  message: string,
  exitCode: ExitCodeValue = ExitCode.staleState,
) {
  return workflowError(code, message, exitCode);
}

export function assertReviewInput(decision: string, reviewer: string): void {
  if (!['approve', 'reject'].includes(decision) || !isSafeText(reviewer)) {
    throw refreshError(
      'DOCUMENT_REVIEW_INVALID',
      'Review requires an explicit decision and reviewer.',
      ExitCode.usage,
    );
  }
}

export function assertApprovedReview(
  proposalId: string,
  review: ReviewRecord,
): void {
  if (review.proposalId !== proposalId) {
    throw refreshError(
      'DOCUMENT_REVIEW_MISMATCH',
      'Review is bound to a different proposal.',
    );
  }
  if (review.decision !== 'approve') {
    throw refreshError(
      'DOCUMENT_REVIEW_REJECTED',
      'Document refresh was not approved.',
    );
  }
}

export function assertCurrentRefreshPolicy(
  proposal: ProposalRecord,
  content: string,
): void {
  if (
    reviewedRefreshPolicyDigest(content, proposal.target) !==
    proposal.policyDigest
  ) {
    throw refreshError(
      'DOCUMENT_REFRESH_POLICY_CHANGED',
      'Document refresh policy changed after the proposal was created.',
      ExitCode.guard,
    );
  }
}

export function reviewedReplacement(
  proposal: ProposalRecord,
  current: string,
): string {
  if (digest(current) !== proposal.sourceDigest) {
    throw refreshError(
      'DOCUMENT_TARGET_STALE',
      'Target changed after the refresh proposal was created.',
    );
  }
  const result = replaceSection(
    current,
    proposal.section,
    proposal.replacement,
  );
  if (digest(result) !== proposal.resultDigest) {
    throw refreshError(
      'DOCUMENT_PROPOSAL_INVALID',
      'Proposal result digest does not match its scoped replacement.',
    );
  }
  return result;
}
