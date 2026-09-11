# Source

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Use the directory tree to locate governing contracts and source imports to discover file dependencies, so an agent does not have to maintain another ownership or dependency list. A nearest containing `spec.md` defines the contract boundary; leading file headers hold local responsibilities and invariants, and scenario bindings connect that meaning to exact test observations. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): documentation should live with code and remain readable from one authority. `documents test`, `render` and `validate` respectively observe proof, rebuild views and inspect the result; a present test file alone never counts as a passing test.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.source-readme v=1 digest=sha256:52d09b2254cfb33eec04b6f22d40493426e0348b86967b27b4431b10edc6a1c2 -->

<!-- prettier-ignore-start -->

15 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| documents validate [--json] | Validate contract references, observed test proof and document projections. |
| documents render [--json] | Regenerate readable document projections from canonical records. |
| documents test [--spec &lt;path&gt;] [--json] | Run the exact tests named by the selected contracts and record their outcomes. |
| documents review &lt;session-id&gt; [--input &lt;review.json&gt;] [--json] | Inspect or record document decisions for the current finalization candidate. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| PolicyKind | agent-role-plan, central-role-provider-default | [planning-role-provider-policy-reader.ts](planning-role-provider-policy-reader.ts) |
| SystemTestOutcome | passed, not-passed, skipped, todo, missing, stale | [system-documents.ts](system-documents.ts) |

## Contracts

- [Normative Base Specs Pass Pinned Strict Validation](spec.md#requirement-normative-base-specs-pass-pinned-strict-validation)
- [Structural Repairs Preserve Requirement Semantics](spec.md#requirement-structural-repairs-preserve-requirement-semantics)
- [Canonical Contracts Follow Directory Containment](spec.md#requirement-canonical-contracts-follow-directory-containment)
- [System Scenarios Bind Existing Meaning and Observed Test Proof](spec.md#requirement-system-scenarios-bind-existing-meaning-and-observed-test-proof)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [check-command.ts](check-command.ts) | Exposes shared check-command parsing and registry types to source consumers. | 1 | History unavailable |
| [declared-path-symbols.ts](declared-path-symbols.ts) | Lexically extracts published names from declared source paths for investigation search. | 1 | Header changed since confirmation |
| [document-disposition.ts](document-disposition.ts) | Finds the contracts and design explanations that a module change must disposition. | 2 | Possibly stale |
| [file-header.ts](file-header.ts) | Reads a file's responsibility and invariant bullets for document projections. | 2 | Header changed since confirmation |
| [import-dependencies.ts](import-dependencies.ts) | Derives file dependency bindings from literal JavaScript and TypeScript imports. | 2 | No newer code observed |
| [module-readme.ts](module-readme.ts) | Reads the handwritten module explanation and its confirmation marker. | 1 | Header changed since confirmation |
| [mutation-class-policy.ts](mutation-class-policy.ts) | Canonicalizes mutation-class rules and classifies exact repository path identities. | 1 | History unavailable |
| [path-role-registry.ts](path-role-registry.ts) | Classifies repository paths by planning evidence responsibility and compression eligibility. | 1 | History unavailable |
| [planning-paths.ts](planning-paths.ts) | Checks planning artifact boundaries and maps cited Sources to immutable ledger paths. | 1 | History unavailable |
| [planning-role-policy-paths.ts](planning-role-policy-paths.ts) | Separates the change-bound role policy path from planning provider changes. | 1 | History unavailable |
| [planning-role-provider-policy-reader.ts](planning-role-provider-policy-reader.ts) | Reads stable current role plans and their central provider policy bytes. | 1 | History unavailable |
| [spec-ownership.ts](spec-ownership.ts) | Resolves colocated contracts and their proof references from a caller's snapshot. | 2 | Possibly stale |
| [system-description-snapshot.ts](system-description-snapshot.ts) | Projects an already-read tracked tree into system document snapshot accessors. | 1 | Header changed since confirmation |
| [system-document-context.ts](system-document-context.ts) | Presents the task's inherited contracts, original requirements and file invariants. | 2 | No newer code observed |
| [system-documents.ts](system-documents.ts) | Joins colocated contracts to Source wording, file invariants and observed tests. | 2 | Possibly stale |
| [system-spec-catalog.ts](system-spec-catalog.ts) | Resolves planning capability names and aliases to their colocated canonical contracts. | 1 | Header changed since confirmation |
| [system-spec-deltas.ts](system-spec-deltas.ts) | Groups planning deltas by their canonical colocated specification. | 1 | Header changed since confirmation |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
