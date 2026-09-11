# WHY knowledge

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep reusable knowledge as a source-binding and freshness index, leaving the explanation itself in the source header and per-change investigation. Reuse compares the current subject, dependency and policy observations with the recorded bindings, so changing a dependency invalidates its consumers even when their own text is unchanged. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): save repeated investigation effort without reusing an explanation for different code. Reconciliation records the current implementation meaning and provenance; it does not turn a stale observation or an explicit exception into proof that a check passed.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.why-knowledge-readme v=1 digest=sha256:a4c91429a4f5f4ded2587ff789098e166b7445a92b41545af4bceb7d66d72445 -->

<!-- prettier-ignore-start -->

9 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| semantic-ledger reconcile --change &lt;change-id&gt; [--input &lt;json&gt;] [--json] | Reconcile reusable source bindings with the selected change. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| FreshnessState | current, exact-changed-semantic-same, subject-changed, dependency-changed, policy-stale, identity-ambiguous, subject-deleted, superseded | [semantic-freshness.ts](semantic-freshness.ts) |
| ResolutionMode | reuse, revalidate, regenerate | [semantic-freshness.ts](semantic-freshness.ts) |
| MutationDisposition | existing-subject-changed, new-subject, subject-deleted, subject-moved, non-semantic-change, generated-output, vendored-or-external | [semantic-reconciliation.ts](semantic-reconciliation.ts) |

## Contracts

- [Semantic Entries Index Source Meaning Without Copying It](spec.md#requirement-semantic-entries-index-source-meaning-without-copying-it)
- [Reuse Reassesses Changed Import Dependencies](spec.md#requirement-reuse-reassesses-changed-import-dependencies)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [implementation-reconciliation-policy.ts](implementation-reconciliation-policy.ts) | Defines the policy identity for reconciling implementation changes with planned subjects. | 1 | History unavailable |
| [implementation-reconciliation.ts](implementation-reconciliation.ts) | Pure reconciliation identities, canonical submissions and exact mutation coverage. | 0 | History unavailable |
| [semantic-freshness.ts](semantic-freshness.ts) | Observes ledger subjects and dependencies and decides whether recorded understanding remains usable. | 1 | History unavailable |
| [semantic-ledger.ts](semantic-ledger.ts) | Indexes semantic subjects by exact source, import bindings, and freshness policy. | 2 | No newer code observed |
| [semantic-manifest-reuse.ts](semantic-manifest-reuse.ts) | No leading responsibility comment. | 0 | History unavailable |
| [semantic-reconciliation.ts](semantic-reconciliation.ts) | Compares planned intent with recorded mutations, changed ranges and preserved invariants. | 1 | History unavailable |
| [semantic-reuse-coverage.ts](semantic-reuse-coverage.ts) | No leading responsibility comment. | 0 | History unavailable |
| [semantic-reuse.ts](semantic-reuse.ts) | Plans which subjects can reuse prior understanding and propagates dependency revalidation to their consumers. | 1 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
