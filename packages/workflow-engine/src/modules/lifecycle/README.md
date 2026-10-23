# Lifecycle

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep repository routing in one controlled source and derive the visible inventory and handoff from it, so selecting the next task does not depend on a stale checklist. Inspect routing before preparing and applying a change of route; writer admission then uses that reviewed state alongside current planning facts. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): durable state should prevent duplicated or omitted work and make recovery possible. A Grant authorizes an exact protected continuation, while the state machine keeps the resulting route and evidence explicit.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.lifecycle-readme v=1 digest=sha256:9d61064e3844d6f1139dac63a1b2be31ed49251a9061d9a5a169e6af15cfa402 -->

<!-- prettier-ignore-start -->

22 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| archive &lt;change-id&gt; [--json] | Archive a completed change through its current workflow authority. |
| route &lt;prepare --intent &lt;intent.json&gt; --output &lt;review.json&gt; [--grant &lt;challenge-id&gt;]\|apply &lt;review.json&gt;\|status&gt; [--json] | Inspect or apply one exact reviewed repository change-routing transition. |
| route status [--json] | Inspect the exact current repository routing state before selecting an executable task transition. |
| task-preflight &lt;change-id&gt; [--task &lt;task-id&gt;] [--json] | Inspect the exact task-session admission and isolation binding without acquiring authority or changing repository state. |
| open-task &lt;change-id&gt; [--task &lt;task-id&gt;] [--mandate &lt;mandate-task-id&gt;] [--json] | Open the selected or next incomplete task, committing an owned draft only when required. |
| update-base &lt;change-id&gt; --onto &lt;ref&gt; [--json] | Replay one clean finished managed task branch onto a locally available base and revalidate its current planning authority. |
| revise-task &lt;session-id&gt; --reason &lt;text&gt; [--json] | Prepare a reviewed planning-only revision of one active task. |
| resume-task &lt;session-id&gt; [--approval &lt;approval-id&gt;] [--json] | Resume the exact durable task revision without replaying ceremony. |
| resume &lt;session-id&gt; [--actor &lt;provider&gt;] [--grant &lt;grant-id&gt;] [--input &lt;typed-envelope.json&gt;] [--json] | Resume the next exact durable implementation-strategy substate. |
| status [investigation-or-task-id] [--json] | Inspect durable investigation, task, and recovery state. |
| check &lt;session-id&gt; [--json] | Produce current check evidence for the compatible task path. |
| complete-task &lt;session-id&gt; [--json] | Apply the compatible task and document completion projection. |
| finish &lt;session-id&gt; [--json] | Check and stage the compatible exact completion tree. |
| review-diff &lt;session-id&gt; [--actor &lt;provider&gt;] [--grant &lt;grant-id&gt;] [--json] | Inspect, run, or reconcile the exact required TaskDiff review. |
| review-diff &lt;session-id&gt; --input &lt;typed-envelope.json&gt; [--grant &lt;grant-id&gt;] [--json] | Inspect, run, or reconcile the exact required TaskDiff review. |
| review-diff &lt;inspect\|status\|reconcile&gt; &lt;session-id&gt; [--json] | Inspect, run, or reconcile the exact required TaskDiff review. |
| finalize &lt;session-id&gt; --message &lt;subject&gt; [--full-gate] [--json] | Check, project, stage, and commit one exact ordinary candidate tree. |
| rollback-completion &lt;session-id&gt; --reason &lt;text&gt; [--json] | Restore an uncommitted compatible completion projection. |
| commit &lt;session-id&gt; --message &lt;subject&gt; [--json] | Commit an exact tree already staged by a compatible lifecycle path. |
| abort &lt;session-id&gt; --reason &lt;text&gt; [--json] | Abandon an active pre-completion session without discarding files. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| ChangeRoutingState | primary, concurrent, ready, blocked, resume-available, parked, completed-awaiting-archive, archived, revising, recovery-required | [change-routing.ts](change-routing.ts) |
| ChangeRoutingRuntimeState | revising, recovery-required, null | [change-routing.ts](change-routing.ts) |
| ManagedTaskStrategyState | not-required, session-terminal, transformation-required, transformation-produced, red-authoring, implementation-required, ready, reservation-persisted, collaboration-grant-required, waiting-for-provider, provider-succeeded-awaiting-import, provider-failed, correction-required, correction-exhausted, caller-supplied-awaiting-import, patch-imported | [managed-workflow-state-contract.ts](managed-workflow-state-contract.ts) |
| ManagedTaskDiffReviewState | not-required, ready, collaboration-grant-required, external-grant-resume-required, direct-human-attestation-required, external-reconciliation-required, satisfied, challenge-response-required, challenge-closure-required, changes-required, waiting-for-provider, provider-succeeded-awaiting-reconciliation, provider-failed | [managed-workflow-state-contract.ts](managed-workflow-state-contract.ts) |
| TaskMechanicalTransformLifecycleState | transformation-required, transformation-produced | [managed-workflow-state-contract.ts](managed-workflow-state-contract.ts) |
| OpenTaskPhase | prepared, plan-committed, session-active, completed | [open-task-status.ts](open-task-status.ts) |
| TaskDiffReviewReplayMode | inspect, governing | [task-diff-review-contracts.ts](task-diff-review-contracts.ts) |

## Contracts

- [Routing Status Exposes Current Repository Inventory](spec.md#requirement-routing-status-exposes-current-repository-inventory)
- [Controlled Lifecycle Source Owns Explicit Routing](spec.md#requirement-controlled-lifecycle-source-owns-explicit-routing)
- [Routing Review Is Current and Recoverable](spec.md#requirement-routing-review-is-current-and-recoverable)
- [Grant Core Owns Protected Continuation](spec.md#requirement-grant-core-owns-protected-continuation)
- [Writer Admission Requires Managed Routing](spec.md#requirement-writer-admission-requires-managed-routing)
- [Handoff Is a Derived Repository Projection](spec.md#requirement-handoff-is-a-derived-repository-projection)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [change-routing-grant-contract.ts](change-routing-grant-contract.ts) | Defines the stable identity and schema bindings of routing continuation Grants. | 1 | History unavailable |
| [change-routing-grant.ts](change-routing-grant.ts) | Defines and requests authorization to continue a parked or manually blocked change. | 1 | History unavailable |
| [change-routing-transaction.ts](change-routing-transaction.ts) | Builds and validates reports binding a routing review to its lifecycle Source update. | 1 | History unavailable |
| [change-routing.ts](change-routing.ts) | No leading responsibility comment. | 0 | History unavailable |
| [completion-rollback.ts](completion-rollback.ts) | Pure admission and state reset for reversing an unfinished completion projection. | 0 | History unavailable |
| [contract-digests.ts](contract-digests.ts) | Computes identities for the required registered check definitions. | 1 | History unavailable |
| [managed-workflow-state-contract.ts](managed-workflow-state-contract.ts) | Defines shared task strategy, review and authority-plan state names. | 1 | Header changed since confirmation |
| [open-task-status.ts](open-task-status.ts) | Durable open-task phase and status values shared by activation and status queries. | 0 | History unavailable |
| [planning-amendment-decision.ts](planning-amendment-decision.ts) | Creates, reads and replaces canonical amendment decisions embedded in proposal markers. | 1 | History unavailable |
| [planning-execution-epoch-observations.ts](planning-execution-epoch-observations.ts) | Required repository observations, invoked at each epoch admission phase. | 0 | History unavailable |
| [planning-execution-epoch.ts](planning-execution-epoch.ts) | Exact epoch manifests, evidence, and recovery predicates. | 0 | History unavailable |
| [planning-transition-report.ts](planning-transition-report.ts) | No leading responsibility comment. | 0 | History unavailable |
| [repository-hooks.ts](repository-hooks.ts) | Repository hook admission rules over required current observations and checks. | 0 | History unavailable |
| [repository-specification-policy.ts](repository-specification-policy.ts) | Combines canonical spec ownership with repository-specific lifecycle paths. | 1 | History unavailable |
| [session-inspection.ts](session-inspection.ts) | Observed session facts consumed by lifecycle rules and report validation. | 0 | History unavailable |
| [task-diff-review-contracts.ts](task-diff-review-contracts.ts) | Defines shared task diff review command, status, and replay contracts. | 1 | History unavailable |
| [workflow-report.ts](workflow-report.ts) | Workflow report contract and validation rules shared by lifecycle policy and durable storage. | 0 | History unavailable |
| [workflow-session-contract.ts](workflow-session-contract.ts) | Current durable workflow session data shared by lifecycle rules and storage. | 0 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
