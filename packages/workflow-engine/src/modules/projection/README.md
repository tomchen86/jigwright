# Projection

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep canonical facts in their owning records and regenerate their readable views through one declared projection catalog. `documents render` builds the contract map, coverage gaps, original requirements and module reference sections from the same source snapshot; `documents validate` compares those views with current inputs. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): one authority should be readable in many places. Whole-file and marked-region ownership are explicit, edits outside a managed region remain intact, and a stored marker digest never substitutes for recomputing the expected content.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.projection-readme v=1 digest=sha256:230e9fffab08a2db74ad2005f531bd54aa910c6ccfc7281c71f3c01a67c851ae -->

<!-- prettier-ignore-start -->

8 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| documents validate [--json] | Validate contract references, observed test proof and document projections. |
| documents render [--json] | Regenerate readable document projections from canonical records. |
| documents test [--spec &lt;path&gt;] [--json] | Run the exact tests named by the selected contracts and record their outcomes. |
| documents review &lt;session-id&gt; [--input &lt;review.json&gt;] [--json] | Inspect or record document decisions for the current finalization candidate. |
| document-refresh &lt;propose\|show\|review\|apply&gt; ... [--json] | Propose, inspect, review or apply a scoped curated document refresh. |
| handoff validate [--json] | Validate the generated repository handoff. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| EngineProjectionTransition | archive, completion, plan, rollback-completion | [engine-projection-registry.ts](engine-projection-registry.ts) |

## Contracts

- [Declarative Projection Catalog](spec.md#requirement-declarative-projection-catalog)
- [Deterministic Shared Projection Services](spec.md#requirement-deterministic-shared-projection-services)
- [Preserve Existing Projection Contracts](spec.md#requirement-preserve-existing-projection-contracts)
- [Curated Refresh Shares Region Splicing](spec.md#requirement-curated-refresh-shares-region-splicing)
- [System Maps Project One Readable Contract Authority](spec.md#requirement-system-maps-project-one-readable-contract-authority)
- [Module References Combine Reviewed Explanations and Generated Facts](spec.md#requirement-module-references-combine-reviewed-explanations-and-generated-facts)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [engine-projection-registry.ts](engine-projection-registry.ts) | Declares generated document outputs, their triggers and privileged projection path ownership. | 1 | History unavailable |
| [investigation-design-projection.ts](investigation-design-projection.ts) | Projects investigation WHY overlays into the managed ledger region of a design document. | 1 | History unavailable |
| [investigation-term-projection.ts](investigation-term-projection.ts) | Projects current PlanReview terms into bounded reviewer contribution deltas. | 1 | History unavailable |
| [module-readme-projection.ts](module-readme-projection.ts) | Derives module reference sections from snapshot CLI usage, union types, contracts and source headers. | 1 | Header changed since confirmation |
| [projection-service.ts](projection-service.ts) | Locates, renders, and conditionally updates engine-owned document regions. | 1 | History unavailable |
| [system-document-projections.ts](system-document-projections.ts) | Projects the contract map, proof coverage and original requirements as readable text. | 2 | Possibly stale |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
