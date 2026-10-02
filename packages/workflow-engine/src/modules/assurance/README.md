# Assurance

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep the presence and currentness of review evidence separate from the reviewer's advisory verdict. A PlanReview binds the exact planning generation and exposes scope, depth, findings and residual work, allowing the workflow to detect when a plan changed after review without pretending that an approval proves every claim. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): agents need a repeatable review step with useful explanations, while an exact Grant can authorize an explicit exception. Review findings that belong to another change stay visible as follow-up work rather than silently expanding this change.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.assurance-readme v=1 digest=sha256:9353f1f6d04740b25cc1c7b88079b777e28347f25a8c4c379102ac03c74f1d2f -->

<!-- prettier-ignore-start -->

75 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| doctor [--json] | Inspect setup, provider availability and repository configuration. |
| run-check &lt;check-id&gt; [--json] | Run the selected registered check and report its actual result. |
| ci --base &lt;commit&gt; --head &lt;commit&gt; [--input &lt;integration-review.json&gt;] [--json] | Verify committed planning and implementation evidence for the selected range. |
| boundary vectors [--check] [--json] | Authenticate the public language-neutral conformance corpus. |
| boundary remap --input &lt;request.json&gt; [--json] | Prove one exact mechanical move and project its authority remap manifest. |
| check &lt;session-id&gt; [--json] | Produce current check evidence for the compatible task path. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| CoverageTier | standard, elevated, critical | [assurance-assessment-chain.ts](assurance-assessment-chain.ts) |
| CheckPostValidation | live-current-ref, immutable-head | [check-execution-port.ts](check-execution-port.ts) |
| FinalizeCheckEscalation | all-tasks-terminal, explicit, null | [finalize-check-policy.ts](finalize-check-policy.ts) |
| ImplementationTermOrigin | added-identifier, deleted-identifier, added-literal, deleted-literal, modified-outer-symbol, alias-one-hop | [implementation-term-dispositions.ts](implementation-term-dispositions.ts) |
| PlanReviewVerdict | advisory-approve, advisory-reject | [plan-review-report.ts](plan-review-report.ts) |
| PlanReviewSeverity | critical, high, medium, low, informational | [plan-review-report.ts](plan-review-report.ts) |
| PlanningArtifactMutability | preserved-byte-identical, replaceable-on-replanning, engine-managed | [plan-review-target-snapshot-record.ts](plan-review-target-snapshot-record.ts) |
| PlanReviewDispositionDecision | mitigated, rejected, accepted | [plan-review.ts](plan-review.ts) |
| AuthorizedPlanReviewDispositionDecision | accepted, rebutted, superseded, withdrawn, waived | [plan-review.ts](plan-review.ts) |
| PreMergeCoverageCategory | planning, implementation, base-context, check-policy, integration-question | [pre-merge-assurance.ts](pre-merge-assurance.ts) |
| ChallengeDisposition | accepted, rebutted, superseded, withdrawn, waived | [review-challenge.ts](review-challenge.ts) |
| ChallengeSeverity | ordinary, forbidden-floor | [review-challenge.ts](review-challenge.ts) |
| TaskDiffReviewVerdict | advisory-approve, advisory-reject | [task-diff-review-artifact-record.ts](task-diff-review-artifact-record.ts) |
| TaskDiffReviewSeverity | critical, high, medium, low, informational | [task-diff-review-artifact-record.ts](task-diff-review-artifact-record.ts) |
| TaskDiffReviewContinuationDecision | accepted, rebutted, superseded, withdrawn, waived | [task-diff-review-artifact-record.ts](task-diff-review-artifact-record.ts) |
| TaskDiffReviewDisposition | accepted, rebutted, withdrawn | [task-diff-review-artifact-record.ts](task-diff-review-artifact-record.ts) |
| TaskStrategyPatchCrashPhase | reservation-persisted, record-persisted, patch-applied, receipt-persisted | [task-strategy-patch-contract.ts](task-strategy-patch-contract.ts) |

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
| [check-execution-port.ts](check-execution-port.ts) | Bound ordinary execution; checkout validation remains a separate consumer capability. | 0 | History unavailable |
| [check-execution.ts](check-execution.ts) | Prepare the whole selected batch before execution; consumers own post-check observation. | 0 | History unavailable |
| [ci-attestation.ts](ci-attestation.ts) | No leading responsibility comment. | 0 | History unavailable |
| [ci-verification.ts](ci-verification.ts) | No leading responsibility comment. | 0 | History unavailable |
| [commit-replay/ci-archive-tree.ts](commit-replay/ci-archive-tree.ts) | Canonical commit replay contracts and pure predicates. | 0 | History unavailable |
| [commit-replay/ci-archive.ts](commit-replay/ci-archive.ts) | No leading responsibility comment. | 0 | History unavailable |
| [commit-replay/ci-authority.ts](commit-replay/ci-authority.ts) | No leading responsibility comment. | 0 | History unavailable |
| [commit-replay/ci-git.ts](commit-replay/ci-git.ts) | Canonical commit replay contracts and pure predicates. | 0 | History unavailable |
| [commit-replay/ci-historical-contract.ts](commit-replay/ci-historical-contract.ts) | Canonical commit replay contracts and pure predicates. | 0 | History unavailable |
| [commit-replay/ci-planning.ts](commit-replay/ci-planning.ts) | No leading responsibility comment. | 0 | History unavailable |
| [commit-replay/ci-routing.ts](commit-replay/ci-routing.ts) | Canonical commit replay contracts and pure predicates. | 0 | History unavailable |
| [commit-replay/ci-sequence.ts](commit-replay/ci-sequence.ts) | No leading responsibility comment. | 0 | History unavailable |
| [commit-replay/ci-task-state.ts](commit-replay/ci-task-state.ts) | Canonical commit replay contracts and pure predicates. | 0 | History unavailable |
| [documentation-closure.ts](documentation-closure.ts) | Canonical documentation closure records, commitment encoding and pure validation rules. | 0 | History unavailable |
| [finalize-check-policy.ts](finalize-check-policy.ts) | Selects task and terminal check requirements for a projected completion state. | 1 | History unavailable |
| [implementation-term-dispositions.ts](implementation-term-dispositions.ts) | Canonical bounded implementation-term review evidence. | 0 | History unavailable |
| [implementation-term-floor.ts](implementation-term-floor.ts) | Pure hunk extraction and bounded implementation-term delta decisions. | 0 | History unavailable |
| [plan-review-artifact.ts](plan-review-artifact.ts) | No leading responsibility comment. | 0 | History unavailable |
| [plan-review-coverage.ts](plan-review-coverage.ts) | Builds and verifies PlanReview coverage requirements and reuse bindings. | 1 | History unavailable |
| [plan-review-disposition.ts](plan-review-disposition.ts) | Constructs and validates PlanReview dispositions and challenge-closure authorization. | 1 | Header changed since confirmation |
| [plan-review-report.ts](plan-review-report.ts) | Review evidence, submissions, and admitted reports shared by planning rules. | 0 | History unavailable |
| [plan-review-subject.ts](plan-review-subject.ts) | Canonical plan review subject data; parsing and effects stay with their existing implementation. | 0 | History unavailable |
| [plan-review-submission.ts](plan-review-submission.ts) | Defines PlanReview submission grammar, normalization, and evidence parsing. | 1 | Header changed since confirmation |
| [plan-review-target-snapshot-record.ts](plan-review-target-snapshot-record.ts) | Canonical plan review target snapshot record data; parsing and effects stay with their existing implementation. | 0 | History unavailable |
| [plan-review-target-snapshot.ts](plan-review-target-snapshot.ts) | Creates and validates immutable planning target snapshots and migration contracts. | 1 | Header changed since confirmation |
| [plan-review-terms.ts](plan-review-terms.ts) | Projects current PlanReview terms into bounded reviewer contribution deltas. | 1 | History unavailable |
| [plan-review-validation.ts](plan-review-validation.ts) | Validates PlanReview evidence, independence, dispositions, and resulting intake candidates. | 1 | History unavailable |
| [plan-review-values.ts](plan-review-values.ts) | Provides exact value guards and freezing helpers for PlanReview evidence. | 1 | Header changed since confirmation |
| [plan-review.ts](plan-review.ts) | No leading responsibility comment. | 0 | History unavailable |
| [plan-target.ts](plan-target.ts) | Canonicalizes planning components into a stable review target and identity. | 1 | History unavailable |
| [planning-assurance-binding.ts](planning-assurance-binding.ts) | Validates the provenance and independence claims attached to planning assurance. | 1 | History unavailable |
| [planning-assurance-evidence.ts](planning-assurance-evidence.ts) | Pure planning evidence admission and exact consumed role replay rules. | 0 | Header changed since confirmation |
| [planning-assurance-observations.ts](planning-assurance-observations.ts) | No leading responsibility comment. | 0 | History unavailable |
| [planning-assurance-port.ts](planning-assurance-port.ts) | Required planning assurance evaluation supplied by application composition. | 0 | History unavailable |
| [planning-assurance-validator.ts](planning-assurance-validator.ts) | Derives planning subjects and validates investigation-first planning readiness. | 1 | History unavailable |
| [planning-assurance-values.ts](planning-assurance-values.ts) | Pure planning assurance value and error operations. | 0 | History unavailable |
| [planning-generation-record.ts](planning-generation-record.ts) | No leading responsibility comment. | 0 | History unavailable |
| [planning-generation.ts](planning-generation.ts) | Creates canonical planning generations from targets, investigation evidence, and policies. | 1 | History unavailable |
| [pre-merge-assurance.ts](pre-merge-assurance.ts) | Builds and validates pre-merge coverage, planning proofs, and integration review. | 1 | History unavailable |
| [pre-merge-verification.ts](pre-merge-verification.ts) | No leading responsibility comment. | 0 | History unavailable |
| [provider-invocation-manifest.ts](provider-invocation-manifest.ts) | The complete set of provider invocation manifest variants. | 0 | History unavailable |
| [provider-output-contract.ts](provider-output-contract.ts) | Code-owned semantic schemas and validators for provider execution and durable results. | 0 | History unavailable |
| [provider-review-manifests.ts](provider-review-manifests.ts) | Canonical provider review manifests DTOs; field and wire semantics are unchanged. | 0 | History unavailable |
| [required-checks.ts](required-checks.ts) | Resolves required check definitions through the existing versioned registry contract. | 0 | History unavailable |
| [review-challenge.ts](review-challenge.ts) | Enforces review challenge closure authority and identifies targets requiring another review. | 1 | History unavailable |
| [review-coverage.ts](review-coverage.ts) | Builds review populations and selects the required targets for each assurance tier. | 1 | History unavailable |
| [task-diff-final-assurance-artifact.ts](task-diff-final-assurance-artifact.ts) | Builds and validates final task diff assurance from current reviews and responses. | 1 | Header changed since confirmation |
| [task-diff-review-artifact-record.ts](task-diff-review-artifact-record.ts) | Canonical task diff review artifact record data; parsing and effects stay with their existing implementation. | 0 | History unavailable |
| [task-diff-review-artifact.ts](task-diff-review-artifact.ts) | Creates and validates task diff review, disposition, and challenge- response records. | 1 | History unavailable |
| [task-diff-review-continuation-submission.ts](task-diff-review-continuation-submission.ts) | Parses advisory task diff continuation proposals and checks their review and response bindings. | 1 | Header changed since confirmation |
| [task-diff-review-input.ts](task-diff-review-input.ts) | Parses external task diff reviews, challenge responses and advisory closure requests. | 1 | History unavailable |
| [task-diff-review-lineage.ts](task-diff-review-lineage.ts) | Validates task diff review ancestry and selects the predecessor at the end of the chain. | 1 | History unavailable |
| [task-diff-review-record.ts](task-diff-review-record.ts) | Canonical task diff review record data; parsing and effects stay with their existing implementation. | 0 | History unavailable |
| [task-diff-review-schema.ts](task-diff-review-schema.ts) | Canonical shared task-diff review schema values. | 0 | History unavailable |
| [task-diff-review-submission.ts](task-diff-review-submission.ts) | Defines task diff provider submissions, canonical findings, and evidence validation. | 1 | Header changed since confirmation |
| [task-diff-review.ts](task-diff-review.ts) | Derives task diff review subjects, candidate scopes, and documentation requirements. | 1 | History unavailable |
| [task-execution-evidence.ts](task-execution-evidence.ts) | Pure admission rules and facts for task execution generation evidence. | 0 | History unavailable |
| [task-strategy-correction-round-record.ts](task-strategy-correction-round-record.ts) | Canonical correction lineage facts; observation and durable validation stay with their producers. | 0 | History unavailable |
| [task-strategy-current-ref.ts](task-strategy-current-ref.ts) | Owns canonical current RED reference identity and its authoring/sealed variants. | 0 | History unavailable |
| [task-strategy-evidence.ts](task-strategy-evidence.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-strategy-gate.ts](task-strategy-gate.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-strategy-implementation-attempt.ts](task-strategy-implementation-attempt.ts) | Interpret an exact effective attempt without reading its durable lineage. | 0 | History unavailable |
| [task-strategy-implementation-record.ts](task-strategy-implementation-record.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-strategy-implementation-values.ts](task-strategy-implementation-values.ts) | Defines canonical task implementation value checks, digests, and store errors. | 2 | History unavailable |
| [task-strategy-patch-contract.ts](task-strategy-patch-contract.ts) | Patch transaction inputs and results shared by their real producer and application callers. | 0 | History unavailable |
| [task-strategy-patch-record.ts](task-strategy-patch-record.ts) | Canonical patch record codecs without durable storage or repository operations. | 0 | History unavailable |
| [task-strategy-red-revision-contract.ts](task-strategy-red-revision-contract.ts) | Validates revision requests and digest-bound RED recovery journal states. | 2 | History unavailable |
| [task-strategy-red-revision-values.ts](task-strategy-red-revision-values.ts) | Defines RED revision phases, exact identity checks, and stable failure codes. | 2 | History unavailable |
| [task-strategy-transaction.ts](task-strategy-transaction.ts) | Validates immutable RED evidence and prepares its canonical transaction identity. | 0 | History unavailable |
| [validated-change-contract.ts](validated-change-contract.ts) | Admitted change facts shared by planning, execution and report validation. | 0 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
