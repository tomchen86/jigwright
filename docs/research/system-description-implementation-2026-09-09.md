# System description implementation — 2026-09-09

This is the local implementation record for Phase C, steps 1–11 of
[the v2.1 plan](system-description-docs-plan.md). The source baseline is
`608f3c5`; the working branch began at source-equivalent `23e2bea6`.
The supplied scratchpad handoff takes precedence over the older repository
handoff. The owner excluded the pilot, optional symbol granularity and a new
header gate. Development uses the owner's local repository override; it does
not claim a managed product lifecycle or external publication.

## Delivered behavior

- Exact R-000–R-014 wording is available through Source records and aliases.
  `AGENTS.md` projects the selected wording. D-020 permits readable projections
  to quote it; the canonical Source remains the authority.
- Twelve colocated specifications describe 13 modules, including three that
  inherit their containing specification. Native OpenSpec validation passes.
  All 167 requirements and 475 scenarios have Source and proof references;
  the scenarios resolve to 303 distinct named tests. These are structural
  counts, not a claim that a test passed.
- `SPEC_MAP.md`, `COVERAGE.md` and `REQUIREMENTS.md` are generated. BACKLOG
  groups work by lane and prints its kind and original wording. The coverage
  reader accepts actual native observations or matching full-gate telemetry;
  missing, skipped, failed and stale evidence retain their actual status.
- Open-task context uses the pinned baseline's containing specification and
  module explanation. Finalization records exact document dispositions and
  candidate freshness. An accepted exact Grant can skip the document
  obligation while recording the exception, without manufacturing a pass.
- Semantic ledger projections derive import dependencies and freshness from
  source and workspace bindings. File headers supply shallow invariant facts.
  Existing headers were simplified without changing their retained invariant
  text. Header history is informational.
- Governance intake and authority READMEs combine reviewed explanations with
  generated command, data, contract and file tables. Their confirmation
  commits are reachable on the integration branch. Human CLI output explains
  operations and prints original wording while JSON retains structured IDs.
- Finding records and append-only receipts use `refs/heads/jigwright/findings`.
  Readers include the corresponding remote-tracking ref after an ordinary
  clone. `attach` accepts an existing Source. `correct` preserves the earlier
  Source and recoverably changes selected Work Item and active-origin
  provenance, requiring renewed interpretation confirmation.

## Data and contract reconciliation

The [dated Source migration](agent-source-migration-2026-09-08.md) records the
15 agent-authored Sources converted to Findings. Fifteen linked receipts were
created for existing Work Items; the former references were removed before
the Source objects were deleted. All 36 maintainer Source objects and their
capture metadata were preserved. A fresh clone was checked against the
dedicated Finding ref.

Every normative change is recorded in
[`system-description-docs-deltas/`](system-description-docs-deltas/), applied
through the pinned native OpenSpec builder and checked for preservation of
untouched requirements. Current authority, planning, provider, document and
intake behavior replaces retired implementation assumptions. Exact
[hosted prerequisites](hosting-prerequisites-2026-09-08.md) remain separate
from local implementation facts; this work does not claim their activation.

Consumer preparation corrected the 18 ISS records using their original
migration commit's timestamp and `agent-derived` interpretation, preserving
aliases and later history. Its separate worktree records the subsequent exact
vendored package and installed-command verification. No consumer database
tests or pilot are part of this delivery.

## Verification boundary

Targeted native checks accompany the behavior changes and reconciliation.
The full-gate inventory contains 453 physical files, including the 19 new
system-description tests. Generated pins are refreshed in order: built-in
closure, bootstrap runtime, protected capabilities.

Final full-gate receipts, raw logs, named-test observations, pairing reviews
and consumer installation evidence are retained outside the source snapshot
under `.worktree-backups/jigwright-system-description-20260908/`. The receipt
must name the actual candidate commit and tree; this dated implementation
record does not substitute for it. Package test wrapper success alone is not
used as proof that an individual package case passed. No push, hosted action
or real maintainer ceremony is authorized by this record.
