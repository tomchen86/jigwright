/** Review evidence, submissions, and admitted reports shared by planning rules. */
import type { InvestigationTermKind } from '../investigation/domain/investigation-terms.ts';
import type { ProviderRoleAssignment } from '../provider-orchestration/role-assignment.ts';
import type { IndependenceDimension } from '../provider-orchestration/role-independence.ts';
export type PlanReviewVerdict = 'advisory-approve' | 'advisory-reject';

export type PlanReviewSeverity =
  'critical' | 'high' | 'medium' | 'low' | 'informational';

export type PlanReviewEvidence =
  | {
      kind: 'planning-location';
      path: string;
      line: number;
      observation: string;
    }
  | {
      kind: 'repository-location';
      path: string;
      line: number;
      observation: string;
    }
  | { kind: 'investigation-node'; nodeId: string; resultDigest: string }
  | { kind: 'survey-record'; nodeId: string; resultDigest: string }
  | {
      kind: 'investigation-role-result';
      role: 'reviewer-pre-anchor' | 'investigation-reviewer';
      requestDigest: string;
      resultDigest: string;
    };

export type PlanReviewProposedTerm = {
  kind: InvestigationTermKind;
  value: string;
};

/**
 * A submitted finding. Challenges are current-change required and demand
 * disposition; suggestions are independent follow-ups. The `kind` and
 * `currentChangeImpact` fields are deliberately wide so a malformed pairing is
 * rejected at validation rather than swallowed by the type.
 */
export type PlanReviewFinding = {
  kind: 'challenge' | 'suggestion';
  severity: PlanReviewSeverity;
  category: string;
  currentChangeImpact: 'required' | 'independent-follow-up';
  summary: string;
  evidence: PlanReviewEvidence[];
};

export type PlanReviewScopeAssessment =
  | { kind: 'challenges' }
  | { kind: 'no-challenge'; evidence: PlanReviewEvidence[] };

export type PlanReviewSubmission = {
  schemaVersion: 2;
  verdict: PlanReviewVerdict;
  coverage: string[];
  scopeAssessment: PlanReviewScopeAssessment;
  findings: PlanReviewFinding[];
  proposedTerms: PlanReviewProposedTerm[];
  suggestions: PlanReviewFinding[];
  residualRisk: string;
  uncertainty: string;
};

export type PlanReviewChallenge = {
  findingId: string;
  kind: 'challenge';
  severity: PlanReviewSeverity;
  category: string;
  currentChangeImpact: 'required';
  summary: string;
  evidence: PlanReviewEvidence[];
};

export type PlanReviewSuggestion = {
  suggestionId: string;
  kind: 'suggestion';
  severity: PlanReviewSeverity;
  category: string;
  currentChangeImpact: 'independent-follow-up';
  summary: string;
  evidence: PlanReviewEvidence[];
};

export type PlanReviewReport = {
  schemaVersion: 2;
  nodeId: string;
  resultDigest: string;
  policyDigest: string;
  subjectDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  assignment: ProviderRoleAssignment;
  providerResultNodeId: string;
  providerResultResultDigest: string;
  verdict: PlanReviewVerdict;
  coverage: readonly string[];
  scopeAssessment: PlanReviewScopeAssessment;
  findings: PlanReviewChallenge[];
  suggestions: PlanReviewSuggestion[];
  proposedTerms: PlanReviewProposedTerm[];
  residualRisk: string;
  uncertainty: string;
  requiredIndependence: IndependenceDimension;
  achievedIndependence: IndependenceDimension;
};
