/** Canonical task diff review artifact record data; parsing and effects stay with their existing implementation. */
import type {
  RISK_PATH_OUTCOMES,
  TASK_DIFF_REVIEW_COVERAGE,
} from './task-diff-review-schema.ts';
import type {
  TaskDiffReviewPathRole,
  TaskDiffReviewScope,
  TaskDiffReviewSubject,
} from './task-diff-review-record.ts';

export type TaskDiffReviewVerdict = 'advisory-approve' | 'advisory-reject';

export type TaskDiffReviewSeverity =
  'critical' | 'high' | 'medium' | 'low' | 'informational';

export type TaskDiffReviewEvidence =
  | Readonly<{
      kind: 'repository-location';
      path: string;
      line: number;
      blobObjectId: string;
      observation: string;
    }>
  | Readonly<{
      kind: 'check-report';
      reportId: string;
      checkId: string;
      observation: string;
    }>
  | Readonly<{
      kind: 'planning-node';
      nodeId: string;
      resultDigest: string;
      observation: string;
    }>;

export type TaskDiffReviewFinding = Readonly<{
  kind: 'challenge';
  severity: TaskDiffReviewSeverity;
  category: (typeof TASK_DIFF_REVIEW_COVERAGE)[number];
  currentChangeImpact: 'required';
  summary: string;
  evidence: readonly TaskDiffReviewEvidence[];
}>;

export type TaskDiffReviewSuggestion = Readonly<{
  kind: 'suggestion';
  severity: TaskDiffReviewSeverity;
  category: (typeof TASK_DIFF_REVIEW_COVERAGE)[number];
  currentChangeImpact: 'independent-follow-up';
  summary: string;
  evidence: readonly TaskDiffReviewEvidence[];
}>;

export type TaskDiffReviewRiskPathDisposition = Readonly<{
  path: string;
  role: Exclude<TaskDiffReviewPathRole, 'ordinary'>;
  outcome: (typeof RISK_PATH_OUTCOMES)[number];
}>;

export type TaskDiffDocumentationAssessment =
  | Readonly<{
      decision: 'updated';
      paths: readonly string[];
      notes: string;
    }>
  | Readonly<{
      decision: 'no-impact';
      notes: string;
    }>
  | Readonly<{
      decision: 'generated-verified';
      sources: readonly string[];
      generated: readonly string[];
      evidence: readonly string[];
      notes: string;
    }>
  | Readonly<{
      decision: 'needs-changes';
      requiredPaths: readonly string[];
      notes: string;
    }>;

export type TaskDiffReviewSubmission = Readonly<{
  schemaVersion: 1;
  verdict: TaskDiffReviewVerdict;
  coverage: readonly string[];
  scopeAssessment:
    | Readonly<{ kind: 'challenges' }>
    | Readonly<{
        kind: 'no-challenge';
        evidence: readonly TaskDiffReviewEvidence[];
      }>;
  findings: readonly TaskDiffReviewFinding[];
  suggestions: readonly TaskDiffReviewSuggestion[];
  riskPathDispositions: readonly TaskDiffReviewRiskPathDisposition[];
  residualRisk: string;
  uncertainty: string;
  documentationAssessment?: TaskDiffDocumentationAssessment;
}>;

export type TaskDiffReviewContinuationDecision =
  'accepted' | 'rebutted' | 'superseded' | 'withdrawn' | 'waived';

export type TaskDiffReviewContinuationSubmission = Readonly<{
  schemaVersion: 1;
  reviewRecordDigest: string;
  responseDigest: string;
  proposedDispositions: readonly Readonly<{
    challengeId: string;
    decision: TaskDiffReviewContinuationDecision;
    rationale: string;
    supersededBy: string | null;
  }>[];
}>;

type TaskDiffReviewAssignmentBase = Readonly<{
  implementerPrincipalId: string;
  implementerProviderId: string | null;
  implementationSessionId: string;
}>;

export type TaskDiffReviewAssignment = TaskDiffReviewAssignmentBase &
  (
    | Readonly<{
        reviewerPrincipalId: string;
        reviewerProviderId: string;
        reviewerSessionId: string;
        achievedIndependence: 'provider-independent' | 'session-independent';
        degradedForm: 'same-provider-fresh-session' | null;
        grantUseDigest: string | null;
      }>
    | Readonly<{
        reviewerPrincipalId: string;
        reviewerProviderId: null;
        reviewerSessionId: null;
        achievedIndependence: 'none';
        degradedForm: 'caller-supplied' | 'direct-human-review';
        grantUseDigest: string;
      }>
  );

export type StoredTaskDiffReviewChallenge = TaskDiffReviewFinding &
  Readonly<{
    challengeId: string;
    raisedBy: string;
  }>;

export type StoredTaskDiffReviewSuggestion = TaskDiffReviewSuggestion &
  Readonly<{
    suggestionId: string;
  }>;

export type TaskDiffReviewRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-record.v1';
  recordDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  reviewScope: TaskDiffReviewScope;
  assignment: TaskDiffReviewAssignment;
  verdict: TaskDiffReviewVerdict;
  coverage: typeof TASK_DIFF_REVIEW_COVERAGE;
  scopeAssessment:
    | Readonly<{ kind: 'challenges' }>
    | Readonly<{
        kind: 'no-challenge';
        evidence: readonly TaskDiffReviewEvidence[];
      }>;
  challenges: readonly StoredTaskDiffReviewChallenge[];
  suggestions: readonly StoredTaskDiffReviewSuggestion[];
  riskPathDispositions: readonly TaskDiffReviewRiskPathDisposition[];
  residualRisk: string;
  uncertainty: string;
  documentationAssessment?: TaskDiffDocumentationAssessment;
}>;

export type CreateTaskDiffReviewRecordInput = Readonly<{
  subject: TaskDiffReviewSubject;
  reviewScope?: TaskDiffReviewScope;
  assignment: TaskDiffReviewAssignment;
  submission: TaskDiffReviewSubmission;
}>;

export type TaskDiffReviewDisposition = 'accepted' | 'rebutted' | 'withdrawn';

export type TaskDiffReviewDispositionEntry = Readonly<{
  challengeId: string;
  disposition: TaskDiffReviewDisposition;
  rationale: string;
  closedBy: string;
}>;

export type TaskDiffReviewDispositionRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-disposition.v1';
  dispositionDigest: string;
  reviewRecordDigest: string;
  subjectDigest: string;
  entries: readonly TaskDiffReviewDispositionEntry[];
}>;

export type TaskDiffReviewChallengeResponseRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-challenge-response.v1';
  responseDigest: string;
  reviewRecordDigest: string;
  subjectDigest: string;
  responses: readonly Readonly<{
    challengeId: string;
    rationale: string;
    evidence: readonly TaskDiffReviewEvidence[];
  }>[];
}>;

export type TaskDiffFinalAssuranceReviewerAuthority =
  | Readonly<{
      kind: 'engine-attributed-provider-reviewer';
      principalId: string;
      providerId: string;
      policyDigest: string;
    }>
  | Readonly<{
      kind: 'grant-attributed-external-reviewer';
      principalId: string;
      degradedForm: 'caller-supplied' | 'direct-human-review';
      grantUseDigest: string;
      policyDigest: string;
    }>;

export type TaskDiffAuthenticatedReviewerAuthority = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-authenticated-reviewer-authority.v1';
  stage: 'review' | 'challenge-closure';
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string | null;
  authorityNodeId: string;
  authorityResultDigest: string;
  authority: TaskDiffFinalAssuranceReviewerAuthority;
}>;

export type TaskDiffFinalAssuranceException = Readonly<{
  kind: 'collaboration-grant-degradation';
  stage: 'review' | 'challenge-closure';
  grantUseDigest: string;
  degradedForm:
    'same-provider-fresh-session' | 'caller-supplied' | 'direct-human-review';
}>;

export type TaskDiffFinalAssuranceRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-final-assurance.v1';
  commitmentDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  verdict: 'satisfied' | 'changes-required';
  reviewerAuthority: TaskDiffFinalAssuranceReviewerAuthority;
  dispositions: readonly Readonly<{
    challengeId: string;
    decision: TaskDiffReviewContinuationDecision;
    rationale: string;
    closedBy: string;
    supersededBy: string | null;
  }>[];
  exceptions: readonly TaskDiffFinalAssuranceException[];
}>;
