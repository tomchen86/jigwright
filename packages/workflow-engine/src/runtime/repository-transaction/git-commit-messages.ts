/**
 * Builds exact planning, archive, route, task, and authority commit messages.
 *
 * Invariants:
 * - Required subjects and trailers preserve their byte encoding and ordering.
 * - Authority and amendment provenance retain existing validation constraints.
 *
 * Depends on: managed trailer contracts, documentation closure encoding, and subject validation.
 * Failure modes: managed commits no longer match their lifecycle or authority evidence.
 */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  type CentralAuthorityCommitProvenance,
  isCentralAuthorityCommitProvenance,
  isCentralAuthorityCommitSubject,
} from '../../modules/lifecycle/managed-trailers.ts';
import {
  type DocumentationClosureRecord,
  encodeDocumentationClosure,
} from '../managed-documents/contracts/documentation-closure.ts';
import { validateCommitSubject } from './git-transition-values.ts';

export function routeCommitMessage(routingReview: string): string {
  if (!/^[0-9a-f]{64}$/.test(routingReview)) {
    throw workflowError(
      'CHANGE_ROUTING_REVIEW_DIGEST_INVALID',
      'A route commit requires one exact review digest.',
      ExitCode.guard,
    );
  }
  return [
    'Route managed changes',
    '',
    'Transition: route',
    `Routing-Review: ${routingReview}`,
  ].join('\n');
}

export function planningCommitMessage(changeId: string): string {
  const subject = `Plan ${changeId}`;
  validateCommitSubject(subject);
  return [subject, '', `Change: ${changeId}`, 'Transition: plan'].join('\n');
}

export type AmendmentProvenance = {
  planningGeneration: string;
  amendsPlanningGeneration: string;
  executionImpact: 'none' | 'required';
  planReview: string;
};

/**
 * The trailer block an amendment commits under.
 *
 * The order is fixed because the parser reads it positionally, which is what
 * stops a commit from claiming an amendment by writing some of the lines and
 * leaving the rest to be assumed.
 */
export function amendPlanCommitTrailers(
  changeId: string,
  provenance: AmendmentProvenance,
): string {
  return [
    `Change: ${changeId}`,
    'Transition: amend-plan',
    `Planning-Generation: ${provenance.planningGeneration}`,
    `Amends-Planning-Generation: ${provenance.amendsPlanningGeneration}`,
    `Execution-Impact: ${provenance.executionImpact}`,
    `Plan-Review: ${provenance.planReview}`,
  ].join('\n');
}

export function amendPlanCommitMessage(
  changeId: string,
  provenance: AmendmentProvenance,
): string {
  const subject = `Amend plan ${changeId}`;
  validateCommitSubject(subject);
  return [subject, '', amendPlanCommitTrailers(changeId, provenance)].join(
    '\n',
  );
}

export function archiveCommitMessage(changeId: string): string {
  const subject = `Archive ${changeId}`;
  validateCommitSubject(subject);
  return [subject, '', `Change: ${changeId}`, 'Transition: archive'].join('\n');
}

export function authorityCommitMessage(
  subject: string,
  changeId: string,
  grantId: string,
): string {
  validateCommitSubject(subject);
  return [
    subject,
    '',
    `Change: ${changeId}`,
    'Transition: authority-maintenance',
    `Grant: ${grantId}`,
  ].join('\n');
}

export function authorityCandidateCommitMessage(
  subject: string,
  changeId: string,
): string {
  validateCommitSubject(subject);
  return [
    subject,
    '',
    `Change: ${changeId}`,
    'Transition: authority-candidate',
  ].join('\n');
}

export type GitAuthorityCandidateApplyCommitProvenance =
  CentralAuthorityCommitProvenance;

export function gitAuthorityCandidateApplyCommitTrailers(
  provenance: GitAuthorityCandidateApplyCommitProvenance,
): string {
  if (!isCentralAuthorityCommitProvenance(provenance)) {
    throw workflowError(
      'INVALID_MANAGED_TRAILERS',
      'Central authority commit provenance is not exact.',
      ExitCode.usage,
    );
  }
  return [
    'Transition: git.authority-candidate.apply.v1',
    `Candidate: ${provenance.candidateDigest}`,
    `Grant-Challenge: ${provenance.challengeId}`,
    `Grant-Operation: ${provenance.operationId}`,
    `Approval-Subject: ${provenance.approvalSubjectDigest}`,
    `Prepared-Grant: ${provenance.preparedGrantRecordDigest}`,
  ].join('\n');
}

export function gitAuthorityCandidateApplyCommitMessage(
  subject: string,
  provenance: GitAuthorityCandidateApplyCommitProvenance,
): string {
  validateCentralAuthorityCommitSubject(subject);
  return [
    subject,
    '',
    gitAuthorityCandidateApplyCommitTrailers(provenance),
  ].join('\n');
}

function validateCentralAuthorityCommitSubject(subject: string): void {
  if (!isCentralAuthorityCommitSubject(subject)) {
    throw workflowError(
      'INVALID_COMMIT_SUBJECT',
      'Central authority commit subject must be one bounded, trimmed line.',
      ExitCode.usage,
    );
  }
}

export function managedCommitMessage(
  subject: string,
  changeId: string,
  taskId: string,
  documentationClosure: DocumentationClosureRecord | null = null,
): string {
  validateCommitSubject(subject);
  return [
    subject,
    ...(documentationClosure === null
      ? []
      : ['', encodeDocumentationClosure(documentationClosure)]),
    '',
    `Change: ${changeId}`,
    `Task: ${taskId}`,
  ].join('\n');
}
