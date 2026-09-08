# Jigwright decision register

**Status:** Accepted product decisions and explicitly open owner decisions

**Live import:** 2026-09-02 into `jigwright-package-side`; D-018 and D-019
wording below is authoritative for live surfaces.

**Official repository:** `jigwright`

**Evidence quarry:** `jigwright-quarry@t3-integration-freeze-2`

This register refines, but never replaces, the owner requirements and
normative product specifications in this repository. Requirement IDs describe
what the product must achieve. Decision IDs record how an accepted product
boundary currently interprets those requirements.

An implementation, test, historical plan, or agent recommendation is not a
decision merely because it exists. Entries marked `open` require an owner
decision and must not be silently inferred.

## Source records

- **UR-2026-08-15:** `USER-REQUIREMENTS-Provider-Agent-Harness.md`,
  R-001–R-013.
- **HARNESS-V3-2026-08-19:** `PLAN-Provider-Agent-Harness-v3.md`, especially
  §§1 and 13.
- **T3-V3-2026-08-21:** `UNIFIED-PLAN-T3-Engine-Independence-v3.md`,
  especially §§1, 3, 5, and 10.
- **CLEAN-2026-08-24:** owner clean-slate, package-name, and optional-capability
  decisions recorded when the official Jigwright repository was created.
- **QUARRY-2026-08-25:** owner-approved separation between the official product
  repository and the frozen integration quarry.
- **PARITY-2026-08-25:** owner correction that clean-slate preserves the full
  current-v3 product surface and removes only evidenced historical or
  consumer-specific baggage.

The first three source records remain recoverable from the evidence quarry.
The owner quotations below preserve the later clean-slate boundary inside the
official repository.

## Owner boundary quotations

> 我覺得打壞也沒關係 那都是之前的workflow 都是試驗期的

> 主要是新建立的engine要是好的

> 我是要一個clean package

> Jigwright v1 先採單一 distribution package，但內部保持 package-grade module boundaries。

> Grants 是可選 capability，而不是可繞過的 policy；它 disabled-by-default，且 core 不得直接依賴 Grants implementation。

> 所以現在真正應該保護的是抽離能力，而不是提早抽離。

## Accepted decisions

### D-001 — Current-only fresh bootstrap

- **Status:** `accepted`
- **Sources:** CLEAN-2026-08-24; R-004; R-012
- **Decision:** Jigwright reads, writes, replays, and recovers only its current
  schema. It does not read or migrate v1/v2 runtime state. An adopting
  repository starts with a fresh current bootstrap.
- **Consequence:** Non-current input reaches one common
  `UNSUPPORTED_SCHEMA_VERSION` boundary. Legacy compatibility is not an
  acceptance criterion. This schema boundary does not reduce current-v3
  commands, capabilities, or invariants.

### D-002 — Preserve current correctness invariants

- **Status:** `accepted`
- **Sources:** CLEAN-2026-08-24
- **Decision:** Removing legacy compatibility does not remove Git
  compare-and-swap, atomic current-state persistence, current crash recovery,
  once-only effects, or state-drift refusal.
- **Consequence:** These are product-quality invariants, not migration
  features.

### D-003 — One public package and CLI named `jigwright`

- **Status:** `accepted`
- **Sources:** CLEAN-2026-08-24; R-012
- **Decision:** v1 has one installation unit, one public package identity, and
  one CLI identity: `jigwright`.
- **Consequence:** The official repository has clean history and the tarball
  excludes application trees, consumer data, legacy readers, migrations,
  shadow/parity modules, and consumer-specific namespaces.

### D-004 — Package-grade internal boundaries before package splitting

- **Status:** `accepted`
- **Sources:** CLEAN-2026-08-24; R-004; R-011; R-012
- **Decision:** `core`, runtime/provider services, planning, Grants,
  integrations, composition, and CLI remain explicit internal modules inside
  one distribution package.
- **Consequence:** Core owns ports and imports no feature implementation.
  A future `@jigwright/*` split is permitted only as a distribution-topology
  change justified by real consumers or release cadence.

### D-005 — Grants are optional capability, never policy bypass

- **Status:** `accepted`
- **Sources:** CLEAN-2026-08-24; R-007; R-011
- **Decision:** Grants are disabled by default. Unprotected transitions work
  without Grants; transitions classified as protected fail closed when the
  capability is unavailable.
- **Consequence:** `core` depends only on an authorization port. Missing
  Grants never becomes implicit approval.

### D-006 — Ordinary floor is session-independent

- **Status:** `accepted`
- **Sources:** UR-2026-08-15 owner decision dated 2026-08-19;
  HARNESS-V3-2026-08-19; R-005
- **Decision:** A single provider is usable. The ordinary default uses three
  fresh sessions for the three logical roles and records the achieved
  independence honestly.
- **Consequence:** Provider diversity may strengthen assurance but is not an
  ordinary usability prerequisite. Final public role names remain an open
  naming decision.

### D-007 — Blind is a Reviewer sealed pre-anchor turn

- **Status:** `accepted`
- **Sources:** UR-2026-08-15 owner decision dated 2026-08-19;
  HARNESS-V3-2026-08-19; R-006
- **Decision:** Blind is not a fourth role. It is the Reviewer's sealed first
  turn before Author terms, conclusions, plan drafts, or Builder transcripts
  become visible.
- **Consequence:** A risk policy may add diversity, but mandatory historical
  blind-provider ceremony is retired.

### D-008 — Planning and agent-runtime provider planes are distinct

- **Status:** `accepted`
- **Sources:** HARNESS-V3-2026-08-19; T3-V3-2026-08-21; R-009; R-012
- **Decision:** Planning adapters own planning-artifact lifecycle. Agent
  runtime owns model processes, streams, native sessions, usage observations,
  and role assignment.
- **Consequence:** Their identities, configuration, types, and storage paths
  cannot substitute for each other.

### D-009 — Provider plan is an optional override

- **Status:** `accepted`
- **Sources:** HARNESS-V3-2026-08-19; R-004; R-009
- **Decision:** Repository policy plus host provider configuration resolves the
  default role assignment. A per-change provider plan is optional.
- **Consequence:** The resolved effective configuration is durable execution
  evidence; every change does not require a ceremonial plan file.

### D-010 — Minimal wrapper protocol

- **Status:** `accepted`
- **Sources:** HARNESS-V3-2026-08-19; R-004
- **Decision:** A provider wrapper emits minimal bounded protocol frames.
  Jigwright binds Attempt identity and receipt ordering at ingestion.
- **Consequence:** The wrapper does not reproduce Jigwright's Job, Attempt,
  digest, grant, or recovery state machines.

### D-011 — v1 runtime surface and explicit deferrals

- **Status:** `accepted`
- **Sources:** HARNESS-V3-2026-08-19; R-002; R-003
- **Decision:** v1 requires start, turn-level resume/continue, cancel, status,
  and watch. One-shot invocation may coexist.
- **Consequence:** Fork and universal in-flight reattachment are deferred until
  a supervisor/event-spool design is explicitly accepted. Turn-level resume
  must not be presented as process reattachment.

### D-012 — Small, honest independence and waiver records

- **Status:** `accepted`
- **Sources:** HARNESS-V3-2026-08-19; R-005; R-007; R-008
- **Decision:** Public records state provider/session independence and
  cross-role context sharing directly. Human waiver and post-review state use
  simple queryable records or labels.
- **Consequence:** Jigwright does not build a parallel assurance-debt graph or
  claim independence that was waived.

### D-013 — Fully collapsed mode uses one exact grant

- **Status:** `accepted`
- **Sources:** HARNESS-V3-2026-08-19; T3-V3-2026-08-21; R-007
- **Decision:** One human action may authorize one explicitly enumerated role
  pair set. The canonical Grant is consumed once for that exact subject.
- **Consequence:** An unbounded blanket waiver and repeated signing ceremony
  are both rejected.

### D-014 — One data-egress authorization authority

- **Status:** `accepted`
- **Sources:** HARNESS-V3-2026-08-19; T3-V3-2026-08-21; R-001; R-004
- **Decision:** Provider data-egress admission uses one repository-owned policy
  port and one durable authorization binding.
- **Consequence:** Execution evidence binds the policy identity, input
  identity, and actual provider. No parallel authorization store is created,
  and data-egress permission grants no Git or workflow authority.

### D-015 — TypeScript first; Rust requires evidence

- **Status:** `accepted`
- **Sources:** T3-V3-2026-08-21; CLEAN-2026-08-24; R-004; R-012
- **Decision:** The first public package remains TypeScript. Cross-language
  conformance data protects future extraction.
- **Consequence:** Rust work waits for a real distribution, performance, or
  maintenance need and must reuse the same public contracts.

### D-016 — Official repository is product truth; quarry is evidence

- **Status:** `accepted`
- **Sources:** QUARRY-2026-08-25
- **Decision:** `jigwright` owns current product requirements, decisions,
  implementation, and releases. `jigwright-quarry` preserves historical
  integration history and candidate implementations for selective inspection.
- **Consequence:** Quarry commits and files are never merged wholesale or
  treated as current authority. Every port needs an explicit current
  requirement, target design, and acceptance test. Until D-017's parity ledger
  closes, the official repository is the authoritative partial port, not a
  complete engine replacement.

### D-017 — Clean-slate preserves full current-v3 product parity

- **Status:** `accepted`
- **Sources:** PARITY-2026-08-25; R-014
- **Decision:** The official package must preserve the frozen engine's complete
  current-v3 product commands, capabilities, and correctness invariants. It may
  remove only evidenced v1/v2 formats and migration, legacy recovery formats,
  shadow/parity and historical compatibility, expense-app-owned data and
  adapters, embedded dual-run/downgrade paths, and tests exclusive to those
  surfaces.
- **Consequence:** `plan create` and `task start/check/complete` are primitives,
  not replacements for `propose`, `open-task`, `finalize`, TaskDiffReview,
  managed commits, and their recovery semantics. Every baseline item requires
  an explicit parity-ledger disposition; omission never means retirement.

### D-018 — Work Registry is always built in; Work Item use is not mandatory

- **Status:** `accepted`
- **Sources:** OWNER-2026-09-02 (revokes the owner's own 2026-08-12 downgrade
  in the Unified Plan §5(c)); R-004; R-008; T3 §3.5
- **Decision:** The Work Registry (intake, backlog, priority, promotion, archive
  reconciliation) is a permanently available built-in capability. It cannot be
  disabled and `workRegistry: null` is not a valid configuration. Using it is
  not mandatory: a repository may hold zero Work Items, and a change may be
  created directly from a Source or by hand without an intake step.
- **Consequence:** The Governance Source ledger is core-owned at the fixed path
  `workflow/source-ledger/objects/sha256`; `sourceRoot` leaves the Work
  Registry configuration and the Work Registry references Source IDs only.
  `WORK_REGISTRY_UNAVAILABLE` and every null-capability branch are removed;
  handoff and archive project an empty registry, never an absent capability.
  WIP limits, queue, and priority rules remain repository policy values. A
  future embedded consumer that truly needs no intake requires a new decision
  before any separate adapter split.

### D-019 — Intent-level intake surface: `now` / `later` / `attach`

- **Status:** `accepted`
- **Sources:** OWNER-2026-09-02; R-004; R-008; T3 §3.5; T3 §4.5; D-018;
  owner acceptance record retained in the evidence quarry and summarized here.
- **Decision:** Users and agents express three intents through composite
  verbs that are facades over the unchanged Source / Finding / Work Item
  records: `now` (capture Source → change whose `origin.json` cites it),
  `later` (capture Source → Work Item inbox, deduplicated by wording), and
  `attach` (new Source → existing Work Item, updating its interpretation);
  `now <work-item>` promotes in one step. A Finding gains one `disposition`
  field (`pending | converted | linked | dismissed` + reason) and the verbs
  `convert`, `link`, `dismiss`; pending Findings surface through the finalize
  `nextSteps` (advisory, within the three-item limit) and through status /
  handoff counts. The promotion symbol survey is required only when the Work
  Item holds agent-derived Findings.
- **Consequence:** `propose` must accept `sourceRefs` (the only core change).
  Ordinary intents cost one step, zero Grants, and no mandatory JSON
  envelopes. Backlog still grows only through reviewed intake; agents never
  write it directly; dismissed Findings remain readable with `--all`;
  `finding link` may target a non-current change but `nextSteps` offers only
  the current one. No Finding state machine, UI, or automatic triage.

### D-020 — One Source authority, readable projections

- **Status:** `accepted` (owner 2026-09-05; imported 2026-09-08)
- **Sources:** [One authority, many readable views](../workflow/source-ledger/objects/sha256/9e/9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e.json);
  [Fail-Grant without dead ends](../workflow/source-ledger/objects/sha256/be/be69144599ec1bdbbe9a4ee5e6636d0a044e7404b465f5fc5c209ffa4381ca77.json).
- **Decision:** The Governance Source ledger is the sole authority for captured
  owner wording. Canonical downstream records cite Sources; generated views
  print their exact wording and readable titles for people and agents. IDs and
  digests belong to verification output rather than readable document prose.
- **Consequence:** BACKLOG, REQUIREMENTS, module READMEs and the repository's
  R-000 guidance are projections. Regeneration never creates a second Source
  authority. Missing required document dispositions request an exact Grant
  with a continuation path. This supersedes D-005's unavailable-capability
  fail-closed wording; accepting a Grant never fabricates a passed check.

## Superseded decisions and approaches

| ID    | Status       | Superseded approach                                                                         | Current decision |
| ----- | ------------ | ------------------------------------------------------------------------------------------- | ---------------- |
| S-001 | `superseded` | v1/v2 runtime readers, migration, and recovery                                              | D-001            |
| S-002 | `superseded` | Publishing several `@jigwright/*` packages in v1                                            | D-003, D-004     |
| S-003 | `superseded` | Filtered-history extraction of the embedded application engine                              | D-003, D-016     |
| S-004 | `superseded` | Blind as an independent mandatory fourth role/provider call                                 | D-007            |
| S-005 | `superseded` | Provider-independent ordinary floor                                                         | D-006            |
| S-006 | `superseded` | Mandatory per-change agent plan                                                             | D-009            |
| S-007 | `superseded` | A second live SSH/R-007 grant lifecycle                                                     | D-005, D-013     |
| S-008 | `superseded` | Embedded/external dual-run, historical parity, and downgrade through legacy state           | D-001, D-003     |
| S-009 | `superseded` | Treating clean-slate as permission to redesign a smaller MVP product surface                | D-017            |
| S-010 | `superseded` | Work Registry as a disableable module (`workRegistry: null`; Unified Plan §5(c) 2026-08-12) | D-018            |

## Open owner decisions

| ID    | Related requirements | Decision still required                                                                                     |
| ----- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| O-001 | R-001                | Data-egress authorization scope and which data classes may use durable authorization                        |
| O-002 | R-002                | Whether a future version needs bidirectional live input, fork, a supervisor, or true in-flight reattachment |
| O-003 | R-004                | The stable metrics for proving a control reduces correctness, security, recovery, or cost risk              |
| O-004 | R-005, R-007         | Which high-risk changes require provider diversity or forbid fully collapsed mode                           |
| O-005 | R-009                | Provider configuration file format, wrapper-command allowance, and extensible output protocol               |
| O-006 | R-003, R-009         | Final protocol frame, stream, heartbeat, and raw-evidence retention limits                                  |
| O-007 | R-012                | The evidence threshold and component order for any future Rust extraction                                   |

Open entries are deliberate. An implementation may expose a bounded
versioned choice, but it may not claim that the owner selected one of these
options without a new decision entry.
