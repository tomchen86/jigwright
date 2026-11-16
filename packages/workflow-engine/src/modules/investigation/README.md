# Investigation

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Build the investigation around a manifest of the exact tracked source snapshot so every selected hit has a disposition and every explanation can be traced back to the bytes that prompted it. Terms retain their provenance, scanning covers the governed tracked tree, and durable `propose` state allows an interrupted investigation to resume. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): retain useful working memory without making an agent repeat completed work. Manifest facts and PlanReview are separate records, and an investigation exemption records an explicit choice without fabricating an investigation result. This working memory is scoped to one change and never outlives it; durable understanding that survives across changes belongs to the semantic ledger in `why-knowledge`.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.investigation-readme v=1 digest=sha256:4bc0676c94a208640540c19406aa24674848a2a633b0edbf51dd2905b760d4a5 -->

<!-- prettier-ignore-start -->

45 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| propose &lt;change-id&gt; --intent &lt;intent.json&gt; --mandate &lt;mandate-task-id&gt; [--actor &lt;id&gt;] [--grant &lt;grant-id&gt;] [--json] | Create or resume the durable investigation and planning workflow. |
| propose &lt;change-id&gt; --resume --input &lt;envelope.json&gt; [--grant &lt;grant-id&gt;\|--role-context-grant &lt;grant-id&gt;] [--json] | Create or resume the durable investigation and planning workflow. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| SampleAuditOutcome | passed, member-misclassified, rationale-wrong, type-wrong | [domain/class-sample-audit.ts](domain/class-sample-audit.ts) |
| InvestigationSessionState | actor-resolution-required, human-action-required, awaiting-main-terms, waiting-for-provider, awaiting-group-dispositions, awaiting-ledger-answers, investigation-sealed | [domain/investigation-session-types.ts](domain/investigation-session-types.ts) |
| InvestigationCheckpointKind | main-terms, group-dispositions, why-answers | [domain/investigation-session-types.ts](domain/investigation-session-types.ts) |
| InvestigationTermSource | engine, main, survey, reviewer | [domain/investigation-terms.ts](domain/investigation-terms.ts) |
| InvestigationManifestPublicationPhase | candidate-written, journal-prepared, manifest-installed, current-ref-published, journal-committed | [manifest/investigation-publication-contracts.ts](manifest/investigation-publication-contracts.ts) |

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
| [domain/human-resolution-contract.ts](domain/human-resolution-contract.ts) | Defines and validates investigation resolution decisions, nodes, and state identities. | 2 | History unavailable |
| [domain/human-resolution-grant-contract.ts](domain/human-resolution-grant-contract.ts) | Owns investigation human-resolution Grant evidence and session-bound revocation. | 2 | History unavailable |
| [domain/human-resolution-grant-publication-contract.ts](domain/human-resolution-grant-publication-contract.ts) | Defines and validates exact grant-publication observations and quarantine receipts. | 2 | History unavailable |
| [domain/human-resolution-journal-contract.ts](domain/human-resolution-journal-contract.ts) | Validates resolution journal plans and their immutable identities and phase order. | 2 | History unavailable |
| [domain/human-resolution-values.ts](domain/human-resolution-values.ts) | Shared human-resolution scalar validation and stable refusal errors. | 0 | History unavailable |
| [domain/investigation-applicability.ts](domain/investigation-applicability.ts) | Defines investigation applicability and bounded exemption eligibility. | 1 | History unavailable |
| [domain/investigation-checkpoint-contract.ts](domain/investigation-checkpoint-contract.ts) | Validates and digests investigation checkpoints and scan saturation acceptance. | 2 | History unavailable |
| [domain/investigation-design-ledger.ts](domain/investigation-design-ledger.ts) | Projects investigation WHY overlays into the managed ledger region of a design document. | 1 | History unavailable |
| [domain/investigation-domain.ts](domain/investigation-domain.ts) | Applies semantic grouping and disposition decisions to mechanical investigation facts. | 1 | History unavailable |
| [domain/investigation-floor.ts](domain/investigation-floor.ts) | Derives investigation floors and path facts from pinned repository changes. | 1 | History unavailable |
| [domain/investigation-full-blob.ts](domain/investigation-full-blob.ts) | Materializes full pinned source bytes and disposition relationships for current WHY authoring requirements. | 1 | History unavailable |
| [domain/investigation-groups.ts](domain/investigation-groups.ts) | Derives investigation hit groups and validates their source and context facts. | 1 | History unavailable |
| [domain/investigation-roots.ts](domain/investigation-roots.ts) | No leading responsibility comment. | 0 | History unavailable |
| [domain/investigation-scan-facts.ts](domain/investigation-scan-facts.ts) | Scanner input/output values and the maximum stored hit-context size. | 0 | History unavailable |
| [domain/investigation-scanner.ts](domain/investigation-scanner.ts) | No leading responsibility comment. | 0 | History unavailable |
| [domain/investigation-schema.ts](domain/investigation-schema.ts) | Canonical investigation protocol versions, assurance label, and diagnostic catalogs. | 0 | History unavailable |
| [domain/investigation-session-contract.ts](domain/investigation-session-contract.ts) | Validates investigation session milestones and monotonic state transitions. | 2 | History unavailable |
| [domain/investigation-session-types.ts](domain/investigation-session-types.ts) | Defines persisted investigation sessions, checkpoint payloads, and current-ref records. | 2 | History unavailable |
| [domain/investigation-store-values.ts](domain/investigation-store-values.ts) | Supplies shared value checks, digests, and provider-state errors for investigation storage. | 2 | History unavailable |
| [domain/investigation-terms.ts](domain/investigation-terms.ts) | Normalizes investigation terms and previews their bounded provenance union. | 1 | History unavailable |
| [domain/predicate-discrimination.ts](domain/predicate-discrimination.ts) | Measures whether a class predicate matches its members and distinguishes control evidence. | 1 | History unavailable |
| [domain/reviewer-term-reopen.ts](domain/reviewer-term-reopen.ts) | No leading responsibility comment. | 0 | History unavailable |
| [manifest/blind-survey-manifest.ts](manifest/blind-survey-manifest.ts) | Canonical blind survey manifest DTOs; field and wire semantics are unchanged. | 0 | History unavailable |
| [manifest/investigation-baseline.ts](manifest/investigation-baseline.ts) | Canonical investigation evidence DTOs, independent of materialization and normalization. | 0 | History unavailable |
| [manifest/investigation-manifest-builder.ts](manifest/investigation-manifest-builder.ts) | Builds, seals and checks an investigation manifest against the exact lifecycle snapshot. | 1 | History unavailable |
| [manifest/investigation-manifest-requirements.ts](manifest/investigation-manifest-requirements.ts) | Normalizes structured review coverage and implementation reconciliation requirements. | 1 | Header changed since confirmation |
| [manifest/investigation-manifest-semantic-evidence.ts](manifest/investigation-manifest-semantic-evidence.ts) | Normalizes manifest semantic decisions and verifies their source and Why evidence. | 1 | Header changed since confirmation |
| [manifest/investigation-manifest-types.ts](manifest/investigation-manifest-types.ts) | Canonical investigation value contracts, separate from replay and repository observation. | 0 | History unavailable |
| [manifest/investigation-manifest-values.ts](manifest/investigation-manifest-values.ts) | Validates bounded manifest values and canonical digest reference collections. | 1 | Header changed since confirmation |
| [manifest/investigation-manifest.ts](manifest/investigation-manifest.ts) | No leading responsibility comment. | 0 | History unavailable |
| [manifest/investigation-materializer.ts](manifest/investigation-materializer.ts) | No leading responsibility comment. | 0 | History unavailable |
| [manifest/investigation-observation.ts](manifest/investigation-observation.ts) | Exact immutable-tree identity observed while loading a Manifest; no repository operations. | 0 | History unavailable |
| [manifest/investigation-publication-contracts.ts](manifest/investigation-publication-contracts.ts) | Validates publication envelopes and binds manifest authority to one investigation lifecycle. | 2 | History unavailable |
| [manifest/investigation-publication-values.ts](manifest/investigation-publication-values.ts) | Defines exact publication path, digest, and internal error primitives. | 2 | History unavailable |
| [manifest/investigation-replay-input.ts](manifest/investigation-replay-input.ts) | Canonical investigation value contracts, separate from replay and repository observation. | 0 | History unavailable |
| [manifest/investigation-requirement-types.ts](manifest/investigation-requirement-types.ts) | Canonical investigation evidence DTOs, independent of materialization and normalization. | 0 | History unavailable |
| [manifest/investigation-why-domain.ts](manifest/investigation-why-domain.ts) | Derives Why requirements and maps investigation authoring to exact source anchors. | 1 | History unavailable |
| [manifest/plan-review-coverage-policy.ts](manifest/plan-review-coverage-policy.ts) | Defines the identity of the global PlanReview coverage policy. | 1 | History unavailable |
| [seal/investigation-v3-failure-record.ts](seal/investigation-v3-failure-record.ts) | Canonical stored failure facts and exact admission; no repository observation. | 0 | History unavailable |
| [seal/investigation-v3-failure-source.ts](seal/investigation-v3-failure-source.ts) | Binds canonical failure sources to their exact observer schema. | 0 | History unavailable |
| [seal/investigation-v3-grant.ts](seal/investigation-v3-grant.ts) | No leading responsibility comment. | 0 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
