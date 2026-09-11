# Governance intake

## Why this design

<!-- jigwright:module-why confirmed=fa1eab4fc25bd29bd01e7567d6785046592789a2 -->

Keep original requirement wording separate from the working inbox so corrections, scheduling and conversion never rewrite what the owner asked for. Source holds a core requirement, Finding records an observation, and a Work Item tracks work; this preserves the [recorded requirements](../../../../../docs/REQUIREMENTS.md) while keeping bugs and chores easy to capture. Use `now` or `later` to capture the owner's words and choose a lane, `attach` to add an existing Source, and `correct` to replace a selected citation with newly captured wording. Corrections retain the earlier Source, update active planning provenance recoverably, and require renewed interpretation confirmation; observations never manufacture owner wording. Findings and their append-only dispositions live on a dedicated Git ref so another clone can recover the same facts without expanding a task's write scope.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.governance-intake-readme v=1 digest=sha256:2e3c427739d1d42fd0cabc2336c26617882b70fa12985572c4dcd9ece12defd2 -->

<!-- prettier-ignore-start -->

12 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| source &lt;capture --input &lt;source-envelope.json&gt;\|link-change &lt;source-id&gt; --change &lt;change-id&gt;\|list\|show &lt;source-id&gt;\|trace &lt;source-id&gt;&gt; [--json] | Preserve and inspect original requirement wording and its provenance. |
| now &lt;original-text&gt; [--kind &lt;kind&gt;] [--json] | Start work from the supplied request or an existing Work Item. |
| now &lt;work-item-id&gt; [--json] | Start work from the supplied request or an existing Work Item. |
| later &lt;original-text&gt; [--kind &lt;kind&gt;] [--json] | Capture work for later using the selected kind. |
| attach &lt;work-item-id&gt; &lt;original-text&gt;\|&lt;SRC-id&gt; [--supersedes &lt;SRC-id&gt;] [--json] | Attach owner wording or an existing Source to a Work Item. |
| correct &lt;work-item-id&gt; &lt;old-SRC-id&gt; &lt;original-text&gt; [--json] | Correct the selected request while preserving its original Source history. |
| finding &lt;add [--session &lt;session-id&gt;] --input &lt;finding-envelope.json&gt;\|list [--all]\|convert &lt;finding-id&gt; [--kind &lt;kind&gt;] [--now]\|link &lt;finding-id&gt; --change &lt;change-id&gt;\|link &lt;finding-id&gt; --work-item &lt;work-item-id&gt;\|dismiss &lt;finding-id&gt; --reason &lt;reason&gt;&gt; [--json] | Record, inspect, convert, link or dismiss a development observation. |
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
- [Selected Source Corrections Update Active Provenance Recoverably](spec.md#requirement-selected-source-corrections-update-active-provenance-recoverably)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [governance-finding-ref.ts](governance-finding-ref.ts) | Defines canonical Finding paths and the dedicated-ref persistence contract. | 1 | Header changed since confirmation |
| [governance-findings.ts](governance-findings.ts) | Capture exact Finding observations and resolve their append-only dispositions. | 3 | Possibly stale |
| [governance-intake-storage.ts](governance-intake-storage.ts) | Publishes canonical governance intake records and reads them with file identity checks. | 1 | Header changed since confirmation |
| [governance-intake.ts](governance-intake.ts) | Captures and reads immutable requirement Sources and composes development Finding operations. | 1 | History unavailable |
| [intake-policy.ts](intake-policy.ts) | Defines intake kinds and the destination of deferred observations. | 1 | Header changed since confirmation |
| [intake-summary.ts](intake-summary.ts) | Aggregates inbox, pending Finding and backlog counts through supplied readers. | 1 | History unavailable |
| [source-aliases.ts](source-aliases.ts) | Resolve named owner requirements to their canonical Source records. | 1 | Possibly stale |
| [work-registry-grant.ts](work-registry-grant.ts) | Creates and validates protected Work Registry review and promotion Grant transitions. | 1 | History unavailable |
| [work-registry-projections.ts](work-registry-projections.ts) | Renders Work Registry backlog and history views and detects projection drift. | 1 | Header changed since confirmation |
| [work-registry-promotion-preparation.ts](work-registry-promotion-preparation.ts) | Prepares promotion surveys and exact change bindings before durable promotion. | 1 | Header changed since confirmation |
| [work-registry-promotion-transaction.ts](work-registry-promotion-transaction.ts) | Commit and recover paired Work Item/origin updates under the registry lock. | 3 | No newer code observed |
| [work-registry-queries.ts](work-registry-queries.ts) | Discovers Work Items, traces provenance, and validates registry relationships. | 1 | Header changed since confirmation |
| [work-registry-record.ts](work-registry-record.ts) | Parses canonical Work Items, lifecycle records, and change origins. | 1 | Header changed since confirmation |
| [work-registry-source-update.ts](work-registry-source-update.ts) | Project a Source attachment or correction onto a Work Item and its origin. | 3 | No newer code observed |
| [work-registry-storage.ts](work-registry-storage.ts) | Reads canonical Work Items, discovers their paths and publishes record replacements. | 1 | Header changed since confirmation |
| [work-registry.ts](work-registry.ts) | Maintain canonical Work Items, reviewed transitions and change provenance. | 3 | No newer code observed |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->
