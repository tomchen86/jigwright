# Assurance

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep the presence and currentness of review evidence separate from the reviewer's advisory verdict. A PlanReview binds the exact planning generation and exposes scope, depth, findings and residual work, allowing the workflow to detect when a plan changed after review without pretending that an approval proves every claim. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): agents need a repeatable review step with useful explanations, while an exact Grant can authorize an explicit exception. Review findings that belong to another change stay visible as follow-up work rather than silently expanding this change.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.assurance-readme v=1 digest=sha256:f0e7f3dd786739ddf0a8f2e245149eec9c9beef4b524fa08d0bc14cf656de961 -->

<!-- prettier-ignore-start -->

30 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| doctor [--json] | Inspect setup, provider availability and repository configuration. |
| run-check &lt;check-id&gt; [--json] | Run the selected registered check and report its actual result. |
| ci --base &lt;commit&gt; --head &lt;commit&gt; [--input &lt;integration-review.json&gt;] [--json] | Verify committed planning and implementation evidence for the selected range. |
| boundary inventory [--check] [--json] | Inspect or verify the machine-checked T3 consumer-coupling inventory. |
| boundary vectors [--check] [--json] | Authenticate the public language-neutral conformance corpus. |
| boundary remap --input &lt;request.json&gt; [--json] | Prove one exact mechanical move and project its authority remap manifest. |
| check &lt;session-id&gt; [--json] | Produce current check evidence for the compatible task path. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| CoverageTier | standard, elevated, critical | [assurance-assessment-chain.ts](assurance-assessment-chain.ts) |
| FinalizeCheckEscalation | all-tasks-terminal, explicit, null | [finalize-check-policy.ts](finalize-check-policy.ts) |
| ImplementationTermOrigin | added-identifier, deleted-identifier, added-literal, deleted-literal, modified-outer-symbol, alias-one-hop | [implementation-term-floor.ts](implementation-term-floor.ts) |
| PlanningArtifactMutability | preserved-byte-identical, replaceable-on-replanning, engine-managed | [plan-review-target-snapshot.ts](plan-review-target-snapshot.ts) |
| PlanReviewVerdict | advisory-approve, advisory-reject | [plan-review.ts](plan-review.ts) |
| PlanReviewSeverity | critical, high, medium, low, informational | [plan-review.ts](plan-review.ts) |
| PlanReviewDispositionDecision | mitigated, rejected, accepted | [plan-review.ts](plan-review.ts) |
| AuthorizedPlanReviewDispositionDecision | accepted, rebutted, superseded, withdrawn, waived | [plan-review.ts](plan-review.ts) |
| PreMergeCoverageCategory | planning, implementation, base-context, check-policy, integration-question | [pre-merge-assurance.ts](pre-merge-assurance.ts) |
| ChallengeDisposition | accepted, rebutted, superseded, withdrawn, waived | [review-challenge.ts](review-challenge.ts) |
| ChallengeSeverity | ordinary, forbidden-floor | [review-challenge.ts](review-challenge.ts) |
| SupportedModule | node:path, node:fs, node:fs/promises | [t3-boundary-scanner.ts](t3-boundary-scanner.ts) |
| TaskDiffReviewVerdict | advisory-approve, advisory-reject | [task-diff-review-artifact.ts](task-diff-review-artifact.ts) |
| TaskDiffReviewSeverity | critical, high, medium, low, informational | [task-diff-review-artifact.ts](task-diff-review-artifact.ts) |
| TaskDiffReviewContinuationDecision | accepted, rebutted, superseded, withdrawn, waived | [task-diff-review-artifact.ts](task-diff-review-artifact.ts) |
| TaskDiffReviewDisposition | accepted, rebutted, withdrawn | [task-diff-review-artifact.ts](task-diff-review-artifact.ts) |

## Contracts

- [Plan Review Binds an Exact Component-Typed Planning Generation](spec.md#requirement-plan-review-binds-an-exact-component-typed-planning-generation)
- [PlanReview Currentness Follows the Governing Planning Generation](spec.md#requirement-planreview-currentness-follows-the-governing-planning-generation)
- [Plan Review Performs the Evidence-Bound Scope and Depth Challenge](spec.md#requirement-plan-review-performs-the-evidence-bound-scope-and-depth-challenge)
- [Review Presence Is Hard and Verdict Is Advisory](spec.md#requirement-review-presence-is-hard-and-verdict-is-advisory)
- [PlanReview Findings and Residuals Are Structurally Explicit](spec.md#requirement-planreview-findings-and-residuals-are-structurally-explicit)
- [Reviewer Terms Enter Only the Fixed Term Projector](spec.md#requirement-reviewer-terms-enter-only-the-fixed-term-projector)
- [Review Findings Preserve Current-Change and Follow-Up Boundaries](spec.md#requirement-review-findings-preserve-current-change-and-follow-up-boundaries)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [assurance-assessment-chain.ts](assurance-assessment-chain.ts) | Builds assurance assessments and derives effective coverage and change- class floors. | 1 | History unavailable |
| [finalize-check-policy.ts](finalize-check-policy.ts) | Selects task and terminal check requirements for a projected completion state. | 1 | History unavailable |
| [implementation-term-floor.ts](implementation-term-floor.ts) | Derives implementation term changes and checks their bounded review dispositions. | 1 | History unavailable |
| [plan-review-coverage-policy.ts](plan-review-coverage-policy.ts) | Defines the identity of the global PlanReview coverage policy. | 1 | History unavailable |
| [plan-review-coverage.ts](plan-review-coverage.ts) | Builds and verifies PlanReview coverage requirements and reuse bindings. | 1 | History unavailable |
| [plan-review-disposition.ts](plan-review-disposition.ts) | Constructs and validates PlanReview dispositions and challenge-closure authorization. | 1 | Header changed since confirmation |
| [plan-review-submission.ts](plan-review-submission.ts) | Defines PlanReview submission grammar, normalization, and evidence parsing. | 1 | Header changed since confirmation |
| [plan-review-target-snapshot.ts](plan-review-target-snapshot.ts) | Creates and validates immutable planning target snapshots and migration contracts. | 1 | Header changed since confirmation |
| [plan-review-validation.ts](plan-review-validation.ts) | Validates PlanReview evidence, independence, dispositions, and resulting intake candidates. | 1 | History unavailable |
| [plan-review-values.ts](plan-review-values.ts) | Provides exact value guards and freezing helpers for PlanReview evidence. | 1 | Header changed since confirmation |
| [plan-review.ts](plan-review.ts) | Creates and authenticates PlanReview subjects, provider results, and review nodes. | 1 | History unavailable |
| [plan-target.ts](plan-target.ts) | Canonicalizes planning components into a stable review target and identity. | 1 | History unavailable |
| [planning-assurance-binding.ts](planning-assurance-binding.ts) | Validates the provenance and independence claims attached to planning assurance. | 1 | History unavailable |
| [planning-assurance-evidence.ts](planning-assurance-evidence.ts) | Replays current PlanReview roles and resolves exact repository and planning evidence. | 1 | Header changed since confirmation |
| [planning-assurance-validator.ts](planning-assurance-validator.ts) | Derives planning subjects and validates investigation-first planning readiness. | 1 | History unavailable |
| [pre-merge-assurance.ts](pre-merge-assurance.ts) | Builds and validates pre-merge coverage, planning proofs, and integration review. | 1 | History unavailable |
| [review-challenge.ts](review-challenge.ts) | Enforces review challenge closure authority and identifies targets requiring another review. | 1 | History unavailable |
| [review-coverage.ts](review-coverage.ts) | Builds review populations and selects the required targets for each assurance tier. | 1 | History unavailable |
| [t3-boundary-inventory.ts](t3-boundary-inventory.ts) | Compares observed namespace and schema boundaries with the recorded T3 inventory. | 1 | History unavailable |
| [t3-boundary-scanner.ts](t3-boundary-scanner.ts) | Statically scans source bindings for namespace and direct boundary references. | 1 | History unavailable |
| [task-diff-final-assurance-artifact.ts](task-diff-final-assurance-artifact.ts) | Builds and validates final task diff assurance from current reviews and responses. | 1 | Header changed since confirmation |
| [task-diff-review-artifact.ts](task-diff-review-artifact.ts) | Creates and validates task diff review, disposition, and challenge- response records. | 1 | History unavailable |
| [task-diff-review-continuation-submission.ts](task-diff-review-continuation-submission.ts) | Parses advisory task diff continuation proposals and checks their review and response bindings. | 1 | Header changed since confirmation |
| [task-diff-review-input.ts](task-diff-review-input.ts) | Parses external task diff reviews, challenge responses and advisory closure requests. | 1 | History unavailable |
| [task-diff-review-lineage.ts](task-diff-review-lineage.ts) | Validates task diff review ancestry and selects the predecessor at the end of the chain. | 1 | History unavailable |
| [task-diff-review-submission.ts](task-diff-review-submission.ts) | Defines task diff provider submissions, canonical findings, and evidence validation. | 1 | Header changed since confirmation |
| [task-diff-review.ts](task-diff-review.ts) | Derives task diff review subjects, candidate scopes, and documentation requirements. | 1 | History unavailable |
| [task-execution-evidence.ts](task-execution-evidence.ts) | Reconstructs the current task execution generation from immutable commit and amendment evidence. | 1 | History unavailable |
| [task-strategy-gate.ts](task-strategy-gate.ts) | Checks task strategy authority and sealed evidence before GREEN execution. | 1 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
