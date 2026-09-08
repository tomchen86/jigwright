# Governance intake

## Why this design

<!-- jigwright:module-why -->

Keep original requirement wording separate from the working inbox so corrections, scheduling and conversion never rewrite what the owner asked for. Use Source for a core requirement, Finding for an observation during a task, and a Work Item for work that needs tracking; this preserves the [recorded requirements](../../../../../docs/REQUIREMENTS.md) while keeping everyday bugs and chores easy to capture.

Confirmed at commit: `3ee8e14b57e1b571676d37a540fcf50d578329c9`
<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.governance-intake-readme v=1 digest=sha256:568086b51d9828af63bb25d6f3219f99246a1a6b2ee271db91e915252276dd91 -->

<!-- prettier-ignore-start -->

2 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| source &lt;capture --input &lt;source-envelope.json&gt;\|link-change &lt;source-id&gt; --change &lt;change-id&gt;\|list\|show &lt;source-id&gt;\|trace &lt;source-id&gt;&gt; [--json] | Preserve and inspect original requirement wording and its provenance. |
| now &lt;original-text&gt; [--kind &lt;kind&gt;] [--json] | Start work from the supplied request or an existing Work Item. |
| now &lt;work-item-id&gt; [--json] | Start work from the supplied request or an existing Work Item. |
| later &lt;original-text&gt; [--kind &lt;kind&gt;] [--json] | Capture work for later using the selected kind. |
| attach &lt;work-item-id&gt; &lt;original-text&gt;\|&lt;SRC-id&gt; [--supersedes &lt;SRC-id&gt;] [--json] | Attach owner wording or an existing Source to a Work Item. |
| finding &lt;add [--session &lt;session-id&gt;] --input &lt;finding-envelope.json&gt;\|list [--all]\|convert &lt;finding-id&gt; [--kind &lt;kind&gt;] [--now]\|link &lt;finding-id&gt; --change &lt;change-id&gt;\|dismiss &lt;finding-id&gt; --reason &lt;reason&gt;&gt; [--json] | Record, inspect, convert, link or dismiss a development observation. |
| work-item &lt;create\|review\|promote-prepare\|promote\|list\|show\|search\|trace\|recommend\|inventory\|render\|validate&gt; ... [--json] | Manage the built-in work inventory and render its projections. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| GovernanceFindingDispositionV1 | pending, converted, linked, dismissed | [governance-intake.ts](governance-intake.ts) |
| WorkItemKindV1 | feature, bug, improvement, chore, research | [work-registry.ts](work-registry.ts) |
| WorkItemLaneV1 | now, next, later, icebox, null | [work-registry.ts](work-registry.ts) |
| WorkItemStageV1 | inbox, backlog, active, closed | [work-registry.ts](work-registry.ts) |
| WorkRegistryGovernedTransition | intake, prioritize, promote | [work-registry.ts](work-registry.ts) |

## Contracts

- [Governance Sources Preserve Selected Wording Exactly](spec.md#requirement-governance-sources-preserve-selected-wording-exactly)
- [Corrections Preserve Earlier Sources](spec.md#requirement-corrections-preserve-earlier-sources)
- [Source Trace Exposes Provenance Without Copying Authority](spec.md#requirement-source-trace-exposes-provenance-without-copying-authority)
- [Every Governance Citation Resolves](spec.md#requirement-every-governance-citation-resolves)
- [Work Registry Search Resolves Linked Source Wording](spec.md#requirement-work-registry-search-resolves-linked-source-wording)
- [Work Items Use Stable Per-Item Records](spec.md#requirement-work-items-use-stable-per-item-records)
- [Reviewed Work Item Decisions Use Grant Core](spec.md#requirement-reviewed-work-item-decisions-use-grant-core)
- [Promotion Atomically Links Work and Source Provenance](spec.md#requirement-promotion-atomically-links-work-and-source-provenance)
- [Work Registry Read Surfaces Are Deterministic](spec.md#requirement-work-registry-read-surfaces-are-deterministic)
- [Planning Prose Distinguishes Source-Backed Claims](spec.md#requirement-planning-prose-distinguishes-source-backed-claims)
- [Archive Reconciles Linked Work Items Deterministically](spec.md#requirement-archive-reconciles-linked-work-items-deterministically)
- [Work Registry Is Always Available; Work Item Use Is Not Mandatory](spec.md#requirement-work-registry-is-always-available-work-item-use-is-not-mandatory)
- [Governance Source Ledger Path Is Engine-Owned](spec.md#requirement-governance-source-ledger-path-is-engine-owned)
- [Findings Remain Independent of Task Write Scope](spec.md#requirement-findings-remain-independent-of-task-write-scope)
- [Finding Disposition Is Append-Only](spec.md#requirement-finding-disposition-is-append-only)
- [Intent-Level Now Starts One Source-Bound Change](spec.md#requirement-intent-level-now-starts-one-source-bound-change)
- [Intent-Level Now Promotes One Eligible Work Item](spec.md#requirement-intent-level-now-promotes-one-eligible-work-item)
- [Intent-Level Later Surface Is One Command](spec.md#requirement-intent-level-later-surface-is-one-command)
- [Attach Adds a Source Without Reclassifying Work](spec.md#requirement-attach-adds-a-source-without-reclassifying-work)
- [Finding Conversion Has One Deterministic Target](spec.md#requirement-finding-conversion-has-one-deterministic-target)
- [Finding Link Is a Receipt-Only Relation](spec.md#requirement-finding-link-is-a-receipt-only-relation)
- [Governance Intake Counts Are Read-Only](spec.md#requirement-governance-intake-counts-are-read-only)

## Files

| File | Responsibility | Invariants |
| --- | --- | ---: |
| [governance-findings.ts](governance-findings.ts) | Session-private Finding records and append-only dispositions. | 0 |
| [governance-intake-storage.ts](governance-intake-storage.ts) | Create-only canonical publication and stable file reads shared by Source and Finding ledgers. | 0 |
| [governance-intake.ts](governance-intake.ts) | No leading responsibility comment. | 0 |
| [intake-policy.ts](intake-policy.ts) | Shared by intake routing and generated agent guidance. | 0 |
| [intake-summary.ts](intake-summary.ts) | No leading responsibility comment. | 0 |
| [source-aliases.ts](source-aliases.ts) | Resolve named owner requirements to their canonical Source records. | 1 |
| [work-registry-grant.ts](work-registry-grant.ts) | No leading responsibility comment. | 0 |
| [work-registry-projections.ts](work-registry-projections.ts) | Derived Work Registry projections, rendering, and drift validation. | 0 |
| [work-registry-promotion-preparation.ts](work-registry-promotion-preparation.ts) | Promotion survey and exact preparation bindings, before the durable promotion transaction. | 0 |
| [work-registry-promotion-transaction.ts](work-registry-promotion-transaction.ts) | Work Registry promotion transaction protocol. | 0 |
| [work-registry-queries.ts](work-registry-queries.ts) | Read-only Work Registry discovery, provenance tracing, inventory, and canonical relationship validation. | 0 |
| [work-registry-record.ts](work-registry-record.ts) | Pure canonical Work Item and change-origin record validation shared by the registry and promotion journal. | 0 |
| [work-registry-storage.ts](work-registry-storage.ts) | Stable canonical Work Item reads, path discovery, and create/replace file publication. | 0 |
| [work-registry.ts](work-registry.ts) | No leading responsibility comment. | 0 |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
