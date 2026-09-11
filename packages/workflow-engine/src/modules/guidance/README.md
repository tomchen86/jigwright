# Guidance

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Derive command guidance and next steps from one executable command catalog and the observed workflow state so an agent can resume without reconstructing the process from prose. Use `jigwright guide` for the supported command surface and the returned next steps to select an action; guidance describes prerequisites and consequences but does not itself authorize a transition. This separation follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): help the agent continue accurately, retain current evidence and make a blocked choice understandable. Generated agent-instruction regions use explicit targets and preserve the owner's surrounding text.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.guidance-readme v=1 digest=sha256:5abd834c0609cd524921dac9e7e3e69f1f15c0d3b6300f250191017bc160068e -->

<!-- prettier-ignore-start -->

6 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| guidance &lt;install [path ...]\|refresh\|remove\|status&gt; [--json] | Install, refresh, remove or inspect explicitly configured agent guidance regions. |
| guide [--json] | Inspect the versioned managed-task workflow command guide. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| WorkflowGuidanceStatus | preferred, compatible, read-only, recovery | [catalog/managed-workflow-command-registry.ts](catalog/managed-workflow-command-registry.ts) |
| TaskStrategyGuidanceKind | resume, waiting, retry, grant-required, exhausted, task-complete, status-only | [next-steps/workflow-guidance.ts](next-steps/workflow-guidance.ts) |
| TaskDiffReviewGuidanceKind | satisfied, default, direct-human, reconcile, external-grant, waiting, inspect | [next-steps/workflow-guidance.ts](next-steps/workflow-guidance.ts) |
| AuthorityPlanGuidanceKind | approve, resume-publication, attest, status-only | [next-steps/workflow-guidance.ts](next-steps/workflow-guidance.ts) |

## Contracts

- [Agent Guide Uses Supported Planning Entry Points](spec.md#requirement-agent-guide-uses-supported-planning-entry-points)
- [Agent Guide Explains Every Workflow Command](spec.md#requirement-agent-guide-explains-every-workflow-command)
- [Source Size Does Not Authorize Churn](spec.md#requirement-source-size-does-not-authorize-churn)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [catalog/agent-rule-registry.ts](catalog/agent-rule-registry.ts) | Renders agent rules from product purpose, Source preservation and intake policy. | 1 | History unavailable |
| [catalog/agent-rule-sources.ts](catalog/agent-rule-sources.ts) | Packages selected R-000 purpose sentences for generated agent guidance. | 1 | History unavailable |
| [catalog/managed-workflow-command-registry.ts](catalog/managed-workflow-command-registry.ts) | Defines managed command routes and derives CLI usage and agent guidance. | 1 | History unavailable |
| [next-steps/workflow-guidance.ts](next-steps/workflow-guidance.ts) | Project executable next steps from current command results and lifecycle facts. | 2 | Possibly stale |
| [renderers/plan-digest.ts](renderers/plan-digest.ts) | Summarizes authored proposal and design sections alongside the declared touched files. | 1 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
