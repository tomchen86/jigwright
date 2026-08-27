/**
 * Exact consumer-branded identities emitted before the T3 namespace cutover.
 *
 * These values are reader inputs only. Current writers must use a neutral
 * `workflow.<kind>.vN` identity and persist that identity with the record when
 * signature verification depends on it.
 */
export const LEGACY_WORKFLOW_IDENTITIES = Object.freeze({
    collaborationGrant: 'expense-app.workflow.collaboration-grant.v1',
    collaborationPolicy: 'expense-app.workflow.collaboration-policy.v1',
    taskDiffReviewCollaborationPolicy: 'expense-app.workflow.collaboration-policy.task-diff-review.v1',
    humanResolutionGrant: 'expense-app.workflow.human-resolution-grant.v1',
    maintainerGrantV1: 'expense-app.workflow.maintainer-grant.v1',
    roleContextSharingPolicy: 'expense-app.workflow.role-context-sharing-policy.v1',
});
