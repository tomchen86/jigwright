/**
 * Exact consumer-branded identities emitted before the T3 namespace cutover.
 *
 * These values are reader inputs only. Current writers must use a neutral
 * `workflow.<kind>.vN` identity and persist that identity with the record when
 * signature verification depends on it.
 */
export const LEGACY_WORKFLOW_IDENTITIES = Object.freeze({
  authorityApplicationReceipt:
    'expense-app.workflow.authority-application-receipt.v1',
  authorityAttestation: 'expense-app.workflow.authority-attestation.v1',
  blindSurveyOutput: 'expense-app.workflow.blind-survey-output',
  collaborationGrant: 'expense-app.workflow.collaboration-grant.v1',
  collaborationPolicy: 'expense-app.workflow.collaboration-policy.v1',
  taskDiffReviewCollaborationPolicy:
    'expense-app.workflow.collaboration-policy.task-diff-review.v1',
  directHumanReview: 'expense-app.workflow.direct-human-review.v1',
  evidenceConvergence: 'expense-app.workflow.evidence-convergence.v1',
  evidenceConvergenceOutput:
    'expense-app.workflow.evidence-convergence-output.v1',
  evidenceReuseProof: 'expense-app.workflow.evidence-reuse-proof.v1',
  evidenceReuseProofOutput:
    'expense-app.workflow.evidence-reuse-proof-output.v1',
  humanResolutionGrant: 'expense-app.workflow.human-resolution-grant.v1',
  humanRevocation: 'expense-app.workflow.human-revocation.v1',
  maintainerGrantV1: 'expense-app.workflow.maintainer-grant.v1',
  providerAvailabilityPilotAuthorization:
    'expense-app.workflow.provider-availability-pilot-authorization.v1',
  providerAvailabilityPilotAuthorizationOutput:
    'expense-app.workflow.provider-availability-pilot-authorization-output.v1',
  roleContextSharingPolicy:
    'expense-app.workflow.role-context-sharing-policy.v1',
  taskDiffReviewOutput: 'expense-app.workflow.task-diff-review-output',
  taskDiffReviewContinuationOutput:
    'expense-app.workflow.task-diff-review-continuation-output',
  taskRevisionApproval: 'expense-app.workflow.task-revision-approval.v1',
  taskStrategyImplementationOutput:
    'expense-app.workflow.task-strategy-implementation-output',
} as const);

export type LegacyWorkflowIdentity =
  (typeof LEGACY_WORKFLOW_IDENTITIES)[keyof typeof LEGACY_WORKFLOW_IDENTITIES];
