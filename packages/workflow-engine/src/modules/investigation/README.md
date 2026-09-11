# Investigation

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Build the investigation around a manifest of the exact tracked source snapshot so every selected hit has a disposition and every explanation can be traced back to the bytes that prompted it. Terms retain their provenance, scanning covers the governed tracked tree, and durable `propose` state allows an interrupted investigation to resume. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): retain useful working memory without making an agent repeat completed work. Manifest facts and PlanReview are separate records, and an investigation exemption records an explicit choice without fabricating an investigation result.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.investigation-readme v=1 digest=sha256:0a4f4c84cf2be8c081b908e3ac7bcdcd6ac631ec18ec82f8c3f07905e9117982 -->

<!-- prettier-ignore-start -->

22 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| propose &lt;change-id&gt; --intent &lt;intent.json&gt; --mandate &lt;mandate-task-id&gt; [--actor &lt;id&gt;] [--grant &lt;grant-id&gt;] [--json] | Create or resume the durable investigation and planning workflow. |
| propose &lt;change-id&gt; --resume --input &lt;envelope.json&gt; [--grant &lt;grant-id&gt;\|--role-context-grant &lt;grant-id&gt;] [--json] | Create or resume the durable investigation and planning workflow. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| SampleAuditOutcome | passed, member-misclassified, rationale-wrong, type-wrong | [domain/class-sample-audit.ts](domain/class-sample-audit.ts) |
| InvestigationTermKind | literal-content, literal-path, symbol, config-key | [domain/investigation-terms.ts](domain/investigation-terms.ts) |
| InvestigationTermSource | engine, main, survey, reviewer | [domain/investigation-terms.ts](domain/investigation-terms.ts) |

## Contracts

- [Current Investigation Applicability Gates Authoritative Planning](spec.md#requirement-current-investigation-applicability-gates-authoritative-planning)
- [Investigation Exemption Is Structured, Narrow, and Reviewed](spec.md#requirement-investigation-exemption-is-structured-narrow-and-reviewed)
- [Investigation Uses Three Term Sources With a Reviewer Pre-Anchor Turn](spec.md#requirement-investigation-uses-three-term-sources-with-a-reviewer-pre-anchor-turn)
- [Every Sealed Term Is Scanned Across the Governed Tracked Tree](spec.md#requirement-every-sealed-term-is-scanned-across-the-governed-tracked-tree)
- [Propose Is a Durable Resumable Planning Wrapper](spec.md#requirement-propose-is-a-durable-resumable-planning-wrapper)
- [Manifest v3 and PlanReview Remain Separate Authorities](spec.md#requirement-manifest-v3-and-planreview-remain-separate-authorities)
- [Search Terms Form Bounded Provenance-Preserving Unions](spec.md#requirement-search-terms-form-bounded-provenance-preserving-unions)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [domain/class-disposition.ts](domain/class-disposition.ts) | Proves shared scan-hit classifications and expands them into ordinary per-group dispositions. | 1 | History unavailable |
| [domain/class-sample-audit.ts](domain/class-sample-audit.ts) | Draws deterministic class samples and resolves first- and second-sample review failures. | 3 | No newer code observed |
| [domain/floor-overflow-pruning.ts](domain/floor-overflow-pruning.ts) | Bounds the investigation floor using a deterministic retention order. | 1 | History unavailable |
| [domain/hit-predicate.ts](domain/hit-predicate.ts) | Parses a bounded predicate language and evaluates it against stored scan- hit windows. | 1 | History unavailable |
| [domain/investigation-applicability.ts](domain/investigation-applicability.ts) | Defines investigation applicability and bounded exemption eligibility. | 1 | History unavailable |
| [domain/investigation-domain.ts](domain/investigation-domain.ts) | Applies semantic grouping and disposition decisions to mechanical investigation facts. | 1 | History unavailable |
| [domain/investigation-floor.ts](domain/investigation-floor.ts) | Derives investigation floors and path facts from pinned repository changes. | 1 | History unavailable |
| [domain/investigation-full-blob.ts](domain/investigation-full-blob.ts) | Materializes full pinned source bytes and disposition relationships for current WHY authoring requirements. | 1 | History unavailable |
| [domain/investigation-groups.ts](domain/investigation-groups.ts) | Derives investigation hit groups and validates their source and context facts. | 1 | History unavailable |
| [domain/investigation-roots.ts](domain/investigation-roots.ts) | Derives canonical investigation commitments from terms, scan hits, groups and dispositions. | 1 | History unavailable |
| [domain/investigation-scanner.ts](domain/investigation-scanner.ts) | Scans tracked tree content into bounded term hits and inventory facts. | 1 | History unavailable |
| [domain/investigation-terms.ts](domain/investigation-terms.ts) | Normalizes investigation terms and previews their bounded provenance union. | 1 | History unavailable |
| [domain/predicate-discrimination.ts](domain/predicate-discrimination.ts) | Measures whether a class predicate matches its members and distinguishes control evidence. | 1 | History unavailable |
| [manifest/investigation-manifest-builder.ts](manifest/investigation-manifest-builder.ts) | Builds, seals and checks an investigation manifest against the exact lifecycle snapshot. | 1 | History unavailable |
| [manifest/investigation-manifest-requirements.ts](manifest/investigation-manifest-requirements.ts) | Normalizes structured review coverage and implementation reconciliation requirements. | 1 | Header changed since confirmation |
| [manifest/investigation-manifest-semantic-evidence.ts](manifest/investigation-manifest-semantic-evidence.ts) | Normalizes manifest semantic decisions and verifies their source and Why evidence. | 1 | Header changed since confirmation |
| [manifest/investigation-manifest-values.ts](manifest/investigation-manifest-values.ts) | Validates bounded manifest values and canonical digest reference collections. | 1 | Header changed since confirmation |
| [manifest/investigation-manifest.ts](manifest/investigation-manifest.ts) | Builds, seals, and validates v3 Investigation Manifests and structured blockers. | 1 | History unavailable |
| [manifest/investigation-materializer.ts](manifest/investigation-materializer.ts) | Materializes canonical investigation evidence from replayable terms and tree facts. | 1 | History unavailable |
| [manifest/investigation-why-domain.ts](manifest/investigation-why-domain.ts) | Derives Why requirements and maps investigation authoring to exact source anchors. | 1 | History unavailable |
| [seal/investigation-v3-failure-source.ts](seal/investigation-v3-failure-source.ts) | Binds investigation failures to observable direct or publication lifecycle sources. | 1 | History unavailable |
| [seal/investigation-v3-grant.ts](seal/investigation-v3-grant.ts) | Creates source-bound Grants for investigation blockers and stop transitions. | 1 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
