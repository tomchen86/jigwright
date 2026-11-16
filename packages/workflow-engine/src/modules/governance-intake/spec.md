# Governance Intake
capabilities: [governance-intake]

## Purpose

Preserve original requirement wording and organize work, findings, provenance, and promotion without allowing a projection to replace its records.
## Requirements
### Requirement: Governance Sources Preserve Selected Wording Exactly
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

The engine SHALL capture selected UTF-8 wording as an append-only,
content-addressed Source under
`workflow/source-ledger/objects/sha256/<prefix>/<digest>.json`. The Source SHALL
record the semantic author, capture actor, canonical capture time, durable
context reference, exact text, text digest, and optional predecessor Source.
Both the object identity and text digest MUST be recomputed on read.

A maintainer-authored Source SHALL carry a `direct-human:` or
`maintainer-confirmation:` context reference. This reference records the claimed
provenance; it does not manufacture external authentication or transition
authority.

#### Scenario: Maintainer wording is captured and shown
covers: #Requirement: Governance Sources Preserve Selected Wording Exactly
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#Source CLI show and trace preserve exact wording and refuse dangling citations

- **WHEN** a caller captures selected maintainer wording with explicit direct-human provenance
- **THEN** the engine stores the exact selected bytes without paraphrase
- **AND** `source show` returns the identity-valid canonical Source

#### Scenario: Stored Source bytes or identity drift
covers: #Requirement: Governance Sources Preserve Selected Wording Exactly
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#Source ledger list and configured registry validation reject every noncanonical entry without mutation

- **WHEN** a Source path, canonical bytes, text digest, or object identity no longer agrees
- **THEN** Source reading fails without rewriting the record

### Requirement: Corrections Preserve Earlier Sources
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

A correction SHALL create a new Source whose `supersedes` field resolves to an
existing identity-valid Source. The engine MUST NOT edit, delete, redirect, or
silently migrate the earlier Source, and citations to the earlier Source SHALL
remain replayable.

#### Scenario: A maintainer corrects earlier wording
covers: #Requirement: Corrections Preserve Earlier Sources
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#Source CLI show and trace preserve exact wording and refuse dangling citations

- **WHEN** the corrected wording cites an existing predecessor Source
- **THEN** both immutable Sources remain readable
- **AND** `source trace` reports the correction relation

#### Scenario: A correction cites an absent Source
covers: #Requirement: Corrections Preserve Earlier Sources
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#Source CLI show and trace preserve exact wording and refuse dangling citations

- **WHEN** `supersedes` names no identity-valid Source object
- **THEN** capture fails before publishing the correction

### Requirement: Source Trace Exposes Provenance Without Copying Authority
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

The Source read surface SHALL provide `list`, `show`, and `trace`. List SHALL
return every identity-valid canonical Source in stable Source-ID order. Trace
SHALL resolve the selected Source, its predecessor and direct corrections,
linked Work Items, and current or archived change `origin.json` citations.
Change and planning artifacts SHALL store Source identities rather than copied
Source records.

#### Scenario: Sources are listed when there are no Work Items
covers: #Requirement: Source Trace Exposes Provenance Without Copying Authority
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#Source list preserves exact wording before repository consumer configuration exists

- **WHEN** a repository has Source records but no Work Item records
- **THEN** `source list` returns their exact selected wording in stable Source-ID order
- **AND** every returned Source passes the same identity and canonical-byte validation as `source show`

#### Scenario: Immediate work cites a Source directly
covers: #Requirement: Source Trace Exposes Provenance Without Copying Authority
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#a Source can link directly to a change without a parking Work Item

- **WHEN** an existing change `origin.json` cites a Source without a parking Work Item
- **THEN** `source trace` reports that change origin
- **AND** the Source gains no lifecycle, priority, check, or transition authority

#### Scenario: Built-in Work Registry has zero items
covers: #Requirement: Source Trace Exposes Provenance Without Copying Authority
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#configured consumers keep Work Registry available and the Source ledger engine-owned

- **WHEN** a configured repository has Source records and zero Work Items
- **THEN** `source list`, `source show`, and correction-chain `source trace` remain available
- **AND** Work Item and change-origin relations are returned as empty

### Requirement: Every Governance Citation Resolves
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Every Source identity in a Source correction, Finding, Work Item, or change
`origin.json` SHALL resolve to one canonical identity-valid Source object.
Governance validation MUST reject a dangling citation rather than inventing a
Source, deleting the citation, or rewriting historical bytes.

#### Scenario: A Finding cites a missing Source
covers: #Requirement: Every Governance Citation Resolves
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#Source CLI show and trace preserve exact wording and refuse dangling citations

- **WHEN** Finding capture names a syntactically valid but absent Source identity
- **THEN** capture fails before publishing the Finding

#### Scenario: A change origin cites a missing Source
covers: #Requirement: Every Governance Citation Resolves
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#Source CLI show and trace preserve exact wording and refuse dangling citations

- **WHEN** registry validation reads an `origin.json` with a dangling `sourceRefs` entry
- **THEN** validation fails without changing the origin or Source ledger

### Requirement: Work Registry Search Resolves Linked Source Wording
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

The built-in Work Registry SHALL allow a caller to find a Work Item by the
exact text of any identity-valid Source it cites. Search SHALL return the
canonical Work Item without copying Source text into the item, a projection,
or a search index. Every cited Source SHALL be validated during the search;
missing or invalid Source bytes MUST fail rather than silently degrading to an
item-only match.

#### Scenario: Exact maintainer wording finds a linked Work Item
covers: #Requirement: Work Registry Search Resolves Linked Source Wording
test: packages/workflow-engine/test/governance-intake.integration.test.ts#Work Registry search resolves exact linked Source wording without copying it

- **WHEN** a Work Item cites a canonical Source whose exact selected wording matches the query
- **THEN** `work-item search` returns that unchanged Work Item
- **AND** the Source and Work Item bytes remain unchanged
- **AND** no lifecycle, priority, or transition authority is created

### Requirement: Work Items Use Stable Per-Item Records
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

The built-in Work Registry SHALL persist each current Work Item as one exact,
canonical record under
`docs/work-registry/items/<created-year>/WORK-<ULID>.yaml`. The Work Item path
MUST remain stable across lifecycle changes. `stage`, `lane`, and `blockedBy`
SHALL remain independent facts, and the current interpretation SHALL identify
whether it is `agent-derived` or `maintainer-confirmed`. Source identities,
blockers, change identities, aliases, timeline events, and closure facts MUST
be canonical, internally coherent, and validated without inventing history.

#### Scenario: A new current Work Item is parked
covers: #Requirement: Work Items Use Stable Per-Item Records
test: packages/workflow-engine/test/governance-intake.integration.test.ts#built-in Work Registry creates one stable item and promotes exact provenance

- **WHEN** a caller creates one valid Work Item from explicit current input
- **THEN** the registry writes one `inbox` item at its creation-year path
- **AND** the initial interpretation remains visibly `agent-derived`
- **AND** no priority, planning, or transition authority is created

#### Scenario: A persisted relation is incoherent
covers: #Requirement: Work Items Use Stable Per-Item Records
test: packages/workflow-engine/test/governance-intake.integration.test.ts#persisted Work Item reads reject incoherent state, path identity drift, and noncanonical relation sets without mutation

- **WHEN** a Work Item path, canonical bytes, blocker, Source reference, change link, timeline, or closure disagrees
- **THEN** the registry rejects the record without moving or rewriting it

### Requirement: Reviewed Work Item Decisions Use Grant Core
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Priority recommendation SHALL be read-only and SHALL expose its current lane,
recommended lane, and explicit reasons. Intake, priority application, and
promotion SHALL bind the exact current Work Item digest. When repository policy
classifies one of those operations as a protected continuation, the domain
SHALL submit a registered Central Grant transition and apply only the exact
accepted transition. A Source, Finding, recommendation, or Work Item MUST NOT
act as a second authority or bypass an accepted Grant Core result.

#### Scenario: Priority is inspected without application
covers: #Requirement: Reviewed Work Item Decisions Use Grant Core
test: packages/workflow-engine/test/governance-intake.integration.test.ts#priority recommendations are explainable and inventory exposes current intake facts

- **WHEN** a caller requests the current priority recommendation
- **THEN** the registry returns explicit recommendation reasons
- **AND** no Work Item, projection, Git ref, or private journal is changed

#### Scenario: Protected review needs exact authorization
covers: #Requirement: Reviewed Work Item Decisions Use Grant Core
test: packages/workflow-engine/test/governance-grant-transitions.integration.test.ts#registered Central Grant review transition applies the exact reviewed item once

- **WHEN** current policy requires a Grant for the requested reviewed transition
- **THEN** the ordinary command emits one exact Fail-Grant challenge before mutation
- **AND** only the registered transition consumer may apply the accepted current decision

### Requirement: Promotion Atomically Links Work and Source Provenance
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Promotion SHALL require one `maintainer-confirmed` `backlog` Work Item in lane
`now` or `next`, closed blockers, and the exact expected item digest. A Work
Item citing any agent-authored Source SHALL bind a current survey of declared
repository symbols; one `promote` command SHALL prepare an explicit empty
declaration only when that survey is absent. Empty `sourceRefs` and Sources
authored solely by maintainers SHALL bind `not-required` with the exact
`sourceRefs` digest and SHALL NOT create survey bytes. It SHALL atomically change
the Work Item to `active` and merge the Work Item's immutable `sourceRefs` plus
its identity into the existing change `origin.json` `sourceRefs` and
`workItemRefs`. Promotion MUST preserve unrelated origin relations, use
compare-and-swap for both tracked inputs, and recover the same prepared
transaction after a crash.

#### Scenario: Current promotion succeeds
covers: #Requirement: Promotion Atomically Links Work and Source Provenance
test: packages/workflow-engine/test/governance-promotion-recovery.integration.test.ts#Work Item promotion recovers one exact item-origin transaction after every hard-crash cut

- **WHEN** an eligible reviewed Work Item, conditional survey binding, expected digest, and change identity still agree
- **THEN** the item and origin publish one bidirectional relationship
- **AND** the origin stores identities rather than copied Source or Work Item records

#### Scenario: Agent premise has no survey yet
covers: #Requirement: Promotion Atomically Links Work and Source Provenance
test: packages/workflow-engine/test/governance-promotion-survey.integration.test.ts#one promote command skips surveys for maintainer premises and prepares a current empty survey for agent premises

- **WHEN** an eligible Work Item cites an agent-authored Source and no survey file exists
- **THEN** one promotion command prepares an explicit empty-declaration current survey and promotes
- **AND** an existing stale or tampered survey is rejected without overwrite

#### Scenario: Maintainer premise needs no survey artifact
covers: #Requirement: Promotion Atomically Links Work and Source Provenance
test: packages/workflow-engine/test/governance-promotion-survey.integration.test.ts#one promote command skips surveys for maintainer premises and prepares a current empty survey for agent premises

- **WHEN** an eligible Work Item has empty Source references or cites only maintainer-authored Sources
- **THEN** promotion binds the exact `not-required` decision and Source-reference digest
- **AND** no survey file is created

#### Scenario: Either tracked input changes
covers: #Requirement: Promotion Atomically Links Work and Source Provenance
test: packages/workflow-engine/test/governance-promotion-recovery.integration.test.ts#Work Item promotion resumes durable rollback after hard crashes in either tracked file

- **WHEN** the Work Item or origin no longer matches the prepared promotion
- **THEN** promotion fails or rolls back without a partial relationship
- **AND** retry never overwrites a concurrent canonical update

### Requirement: Work Registry Read Surfaces Are Deterministic
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

The built-in registry SHALL expose `list`, `show`, `search`, `trace`,
`recommend`, `inventory`, `render`, and `validate`. Every composite read MUST
use one coherent item/origin snapshot and validate every traversed Source and
relation. Render SHALL derive the backlog, inventory, history, and configured
handoff views deterministically from canonical records; those views and any
search cache SHALL NOT become authority.

#### Scenario: A caller traces one Work Item
covers: #Requirement: Work Registry Read Surfaces Are Deterministic
test: packages/workflow-engine/test/governance-intake.integration.test.ts#built-in Work Registry creates one stable item and promotes exact provenance

- **WHEN** the Work Item and all cited records are canonical
- **THEN** trace returns the unchanged item, its canonical Sources, and linked current or archived origins
- **AND** the read creates no lifecycle or transition fact

#### Scenario: A projection drifts
covers: #Requirement: Work Registry Read Surfaces Are Deterministic
test: packages/workflow-engine/test/governance-intake.integration.test.ts#registry render is deterministic and validates blocking cycles

- **WHEN** a generated backlog, inventory, history, or handoff byte no longer matches canonical records
- **THEN** validation rejects the projection rather than treating it as registry authority

### Requirement: Planning Prose Distinguishes Source-Backed Claims
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

The generated planning interface SHALL instruct callers to resolve cited
Sources through `source show`, preserve their exact selected wording, mark
claims grounded in those Sources as `source-backed`, and mark interpretations
or extensions as `agent-derived`. Planning and change artifacts SHALL retain
immutable Source identities without copying an entire Source record. This
provenance distinction SHALL NOT grant planning, policy, check, or transition
authority and SHALL NOT require a Work Item for an uncited change.

#### Scenario: A proposed change cites maintainer wording
covers: #Requirement: Planning Prose Distinguishes Source-Backed Claims
test: packages/workflow-engine/test/agent-rule-registry.contract.test.ts#agent rules are generated from current purpose, exact-text and command sources

- **WHEN** the request names a canonical Source identity
- **THEN** the planning guidance directs the caller to the current Source read surface
- **AND** source-backed wording remains distinguishable from agent-derived interpretation

### Requirement: Archive Reconciles Linked Work Items Deterministically
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Archive reconciliation SHALL derive linked Work Items from the canonical
archived change origin, require the same bidirectional relationship admitted
before archive, close only those active items with outcome `delivered`, and
regenerate exact current projections. It SHALL preserve every Source and Work
Item timeline and SHALL be idempotent for the same archive facts. An archived
change with zero linked Work Items SHALL produce no Work Item effects.

#### Scenario: One linked change is archived
covers: #Requirement: Archive Reconciles Linked Work Items Deterministically
test: packages/workflow-engine/test/archive-transition.integration.test.ts#archive closes linked Work Items and renders registry history in the verified commit

- **WHEN** current item, origin, archive identity, and compare-and-swap facts agree
- **THEN** each exactly linked active Work Item closes once with the archived change identity
- **AND** a second reconciliation preserves the same record and projection bytes

#### Scenario: An archived change has no linked Work Items
covers: #Requirement: Archive Reconciles Linked Work Items Deterministically
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#configured consumers keep Work Registry available and the Source ledger engine-owned

- **WHEN** the canonical archived origin has no `workItemRefs`
- **THEN** archive reconciliation returns no Work Item output paths
- **AND** Source, Work Registry, handoff, and Git bytes remain unchanged

### Requirement: Work Registry Is Always Available; Work Item Use Is Not Mandatory
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

A configured repository SHALL always have the built-in Work Registry available.
The repository MAY have zero Work Items, and a change MAY cite a Source directly
without first creating a Work Item. The `workRegistry` configuration key MAY be
omitted to select engine-owned default paths or MAY contain one exact current
path configuration. The value `workRegistry: null` MUST fail with
`REPOSITORY_CONSUMER_CONFIG_INVALID` under D-018 rather than disabling the
capability or preserving a dormant null branch.

#### Scenario: Configured consumer has zero Work Items
covers: #Requirement: Work Registry Is Always Available; Work Item Use Is Not Mandatory
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#configured consumers keep Work Registry available and the Source ledger engine-owned

- **WHEN** a valid configured repository has no Work Item records or inventory projection
- **THEN** Work Item list and Source-to-work trace return empty Work Item facts
- **AND** Source capture, generic handoff, and archive processing remain available

#### Scenario: Work Registry configuration selects defaults
covers: #Requirement: Work Registry Is Always Available; Work Item Use Is Not Mandatory
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#configured consumers keep Work Registry available and the Source ledger engine-owned

- **WHEN** a repository consumer configuration omits the `workRegistry` key
- **THEN** the engine supplies its exact current Work Registry default paths
- **AND** it does not infer a disabled capability

#### Scenario: Configured consumer attempts to disable the Work Registry
covers: #Requirement: Work Registry Is Always Available; Work Item Use Is Not Mandatory
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#configured consumers keep Work Registry available and the Source ledger engine-owned

- **WHEN** a repository consumer configuration supplies `workRegistry: null`
- **THEN** configuration validation fails with `REPOSITORY_CONSUMER_CONFIG_INVALID`
- **AND** no Source, Work Item, projection, lock, or Git byte changes

### Requirement: Governance Source Ledger Path Is Engine-Owned
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Every Governance Source writer, reader, list operation, Work Item citation,
backlog link, trace, and validator SHALL resolve the Source ledger only at
`workflow/source-ledger/objects/sha256`. Work Registry configuration MUST NOT
contain `sourceRoot`; an attempted override is an unknown extra key and MUST
fail with `REPOSITORY_CONSUMER_CONFIG_INVALID` before reading or writing either
the fixed ledger or the requested path.

#### Scenario: A configuration attempts to redirect Sources
covers: #Requirement: Governance Source Ledger Path Is Engine-Owned
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#configured consumers keep Work Registry available and the Source ledger engine-owned

- **WHEN** an otherwise valid Work Registry configuration supplies `sourceRoot`
- **THEN** configuration validation rejects the extra key
- **AND** the fixed Source ledger and requested path remain unchanged

#### Scenario: Core Source capture precedes repository consumer configuration
covers: #Requirement: Governance Source Ledger Path Is Engine-Owned
test: packages/workflow-engine/test/governance-source-ledger.integration.test.ts#Source trace stays core-only before repository consumer configuration exists

- **WHEN** a caller captures or reads an identity-valid Source before a repository consumer configuration exists
- **THEN** the engine uses the fixed core-owned ledger path
- **AND** it creates no Work Item or repository configuration

### Requirement: Findings Remain Independent of Task Write Scope
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

A Finding SHALL bind its exact text to the active session, change, branch, head,
and tree in immutable Git records on the dedicated `refs/heads/jigwright/findings` branch. When no task is active, the existing repository scope supplies the actual repository context. Finding capture SHALL remain
available when the repository path is outside the current task's allowed write
scope. Capture SHALL update only the dedicated Finding ref while preserving the task HEAD, index and working tree. Ordinary clones SHALL discover the retained records through the fetched remote-tracking Finding branch without requiring private runtime files. A Finding is an agent-authored observation and MUST be revalidated before
promotion into normative planning or transition facts.

#### Scenario: Mid-task observation is outside allowed paths
covers: #Requirement: Findings Remain Independent of Task Write Scope
test: packages/workflow-engine/test/governance-findings.integration.test.ts#finding capture binds active session and Git facts outside task paths

- **WHEN** an active session records a bounded Finding about work outside its task paths
- **THEN** the engine stores the Finding with current session and Git facts
- **AND** no repository lifecycle transition is authorized by the Finding

#### Scenario: An ordinary clone retains the observations
covers: #Requirement: Findings Remain Independent of Task Write Scope
test: packages/workflow-engine/test/governance-finding-ref.integration.test.ts#ordinary clone retains immutable Findings and receipts without task-tree files

- **WHEN** an ordinary clone reads Findings after the original repository and its private runtime are removed
- **THEN** it still reads the exact immutable records and receipts from Git
- **AND** recording another Finding preserves the clone task HEAD, index and worktree

### Requirement: Finding Disposition Is Append-Only
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Under D-019, the engine SHALL keep each original `FND-*.json` Git record immutable. A
Finding read model SHALL expose exactly one `disposition` value from `pending`,
`converted`, `linked`, or `dismissed`, together with its reason, target, and
terminal time. Absence of a terminal receipt means `pending`; a terminal value
MUST come from one create-once canonical sidecar beside the original Finding.
The current `dismiss` command SHALL require a non-empty reason, write a null
target, preserve the original Finding bytes, and remain visible through
`finding list --all`. The ordinary `finding list` command SHALL return only
pending Findings across the repository Finding branch and available remote-tracking copies. Conflicting terminal receipts SHALL be reported without choosing a winner or rewriting history.

#### Scenario: A caller dismisses one pending Finding
covers: #Requirement: Finding Disposition Is Append-Only
test: packages/workflow-engine/test/governance-findings.integration.test.ts#Finding disposition is append-only and runtime-wide counts stay read-only

- **WHEN** `finding dismiss <finding-id> --reason <reason>` resolves one identity-valid pending Finding
- **THEN** one immutable terminal receipt records `dismissed`, the exact reason, a null target, and the current time
- **AND** the original Finding, Source, Work Item, task HEAD, index, working tree and tracked projection bytes remain unchanged; only the dedicated Finding ref advances
- **AND** the Finding disappears from the default list but remains in `finding list --all`

#### Scenario: Finding storage is ambiguous or unsafe
covers: #Requirement: Finding Disposition Is Append-Only
test: packages/workflow-engine/test/governance-findings.integration.test.ts#Finding readers report invalid Git records and receipts without repair

- **WHEN** repository-wide listing observes a noncanonical Git path, path mismatch, invalid blob mode or bytes, orphan receipt, conflicting terminal receipts, or duplicate identity
- **THEN** listing and disposition fail closed without choosing one record
- **AND** no Finding or disposition byte is repaired, deleted, or rewritten

#### Scenario: Concurrent writers preserve distinct records
covers: #Requirement: Finding Disposition Is Append-Only
test: packages/workflow-engine/test/governance-finding-ref.integration.test.ts#concurrent Finding writers converge through Git ref CAS

- **WHEN** concurrent writers append distinct Findings to the same dedicated ref
- **THEN** compare-and-swap retries preserve each published record

#### Scenario: Remote terminal conflicts remain explicit
covers: #Requirement: Finding Disposition Is Append-Only
test: packages/workflow-engine/test/governance-finding-ref.integration.test.ts#Finding writes merge remote divergence and preserve conflicting terminal receipts

- **WHEN** local and fetched Finding histories contain unrelated records or conflicting terminal receipts
- **THEN** unrelated records remain visible and conflicting dispositions are reported
- **AND** the engine does not rewrite a terminal receipt

### Requirement: Intent-Level Now Starts One Source-Bound Change
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Under D-019, `now <original-text>` SHALL capture or deterministically reuse one
direct-human Governance Source and start the change named
`source-<sha256(exact-original-text)>` without a JSON intent envelope. The
normalized propose intent SHALL cite that exact Source ID and SHALL NOT copy the
original wording. The owned planning worktree SHALL contain the same canonical
Source object and an exact `origin.json` citation before proposal work proceeds.
Only Source-object paths cited by that validated current origin may cross the
planning-path boundary. Retry after Source capture or after a source-only
workspace bootstrap SHALL converge without a second Source, change, origin, or
planning workspace. Every result SHALL echo the original text, Source ID,
change ID, current propose state, and one truthful next step; actor-resolution
output MUST NOT pretend an investigation already exists.

`--kind <kind>` SHALL select any registered Work Item kind, defaulting to
`improvement`. Requirement kinds (`feature`, `improvement`) SHALL use the
Source-bound path above. Observation kinds (`bug`, `chore`, `research`) SHALL
start the same deterministic change without minting a Source and SHALL carry
the complete original wording in the normalized intent summary, without title
truncation.

#### Scenario: One immediate sentence starts planning
covers: #Requirement: Intent-Level Now Starts One Source-Bound Change
test: packages/workflow-engine/test/propose-planning-workspace.integration.test.ts#top-level now starts the stable Source-bound planning workspace without an intent envelope

- **WHEN** a caller invokes `now <original-text>` with one resolved current actor
- **THEN** one stable change and planning workspace cite the captured Source through `origin.json`
- **AND** the Source is the only planning path outside the named change tree
- **AND** retry returns the same Source and change identities without copying the original text into the intent

#### Scenario: An immediate observation retains its complete wording
covers: #Requirement: Intent-Level Now Starts One Source-Bound Change
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#later --kind bug parks an observation in the inbox without minting a Source

- **WHEN** a caller invokes `now <original-text> --kind bug`
- **THEN** the normalized intent contains the complete original text and cites no newly minted Source
- **AND** wording beyond the Work Item title limit remains available to planning

#### Scenario: Capture or workspace bootstrap stops early
covers: #Requirement: Intent-Level Now Starts One Source-Bound Change
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#D-019 now converges exact wording on one Source and stable immediate change after capture crash

- **WHEN** immediate intake stops after Source capture or after copying the Source before origin publication
- **THEN** retry rechecks the exact Source text and stable change identity
- **AND** it completes the exact origin citation without accepting unrelated planning paths

### Requirement: Intent-Level Now Promotes One Eligible Work Item
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Under D-019, `now <work-item-id>` SHALL preserve inbox review and priority
authority, then perform the current promotion preparation and promotion as one
facade only for an eligible reviewed `now` or `next` Work Item. The deterministic
change identity SHALL be `work-<lowercase Work Item ULID>`. A protected
promotion MUST emit its exact Fail-Grant challenge before creating the change
directory, survey, origin, or any other byte. That challenge SHALL bind the
exact absent or existing change prestate, Source-reference digest, and the
conditional current-survey facts. Only the accepted registered transition may
create an absent plain change directory, publish its exact current empty survey
for an agent premise, and promote the item. Retry after that owned preparation
or after successful promotion SHALL converge on the same Work Item, Source, and
change identities without rewriting bytes or refs. Results SHALL echo the cited
original Source wording and return only executable `work-item show` and `source
trace` next steps.

#### Scenario: Inbox authority is preserved
covers: #Requirement: Intent-Level Now Promotes One Eligible Work Item
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#D-019 now work-item preserves inbox authority, promotes ordinary agent work, and keeps protected refusal mutation-free

- **WHEN** `now <work-item-id>` names an unreviewed inbox item
- **THEN** it returns exact accept-review and prioritize-now next steps
- **AND** no Work Item, change, survey, origin, Grant, or Git byte changes

#### Scenario: Eligible current item is promoted once
covers: #Requirement: Intent-Level Now Promotes One Eligible Work Item
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#D-019 now work-item preserves inbox authority, promotes ordinary agent work, and keeps protected refusal mutation-free

- **WHEN** the reviewed item and every blocker, Source, survey fact, and target prestate remain exact
- **THEN** the facade creates or reuses the deterministic change and performs one current promotion
- **AND** retry returns the same result without a second mutation

#### Scenario: Protected absent target requires Grant before preparation
covers: #Requirement: Intent-Level Now Promotes One Eligible Work Item
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#D-019 now work-item preserves inbox authority, promotes ordinary agent work, and keeps protected refusal mutation-free

- **WHEN** repository policy protects promotion and the deterministic change does not exist
- **THEN** the facade emits one exact Central Grant challenge while the target remains absent
- **AND** an accepted transition may prepare only an empty directory or its own exact survey before promotion
- **AND** a foreign target entry or metadata drift fails stale without overwrite

### Requirement: Intent-Level Later Surface Is One Command
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Under D-019, `later <original-text>` SHALL capture one direct-human Governance
Source and create one inbox Work Item in the always-available Work Registry
without requiring a JSON envelope. The facade SHALL use the exact fixed
authoring defaults `kind: improvement` and `lane: null`; `--kind <kind>` SHALL
select any registered Work Item kind. Only requirement kinds (`feature`,
`improvement`) describe what the system should do and SHALL capture a Source;
observation kinds (`bug`, `chore`, `research`) SHALL create the inbox item
carrying the wording as its interpretation summary and SHALL NOT mint a Source,
deduplicating on exact summary among open Work Items. When a Source is
captured, its title SHALL identify the captured Source, and its agent-derived
interpretation SHALL not duplicate the original wording. Before capture, exact
Source wording already cited by a Work Item SHALL produce a deterministic attach
suggestion and SHALL NOT create a second Source or Work Item. Invoked inside an
active task session, `later` SHALL stage the wording as a repository Finding
bound to that session instead of writing the Work Registry, so the task diff
stays scoped; conversion flushes it to the inbox. The ordinary path SHALL
require no Grant.

#### Scenario: Original wording is parked for later
covers: #Requirement: Intent-Level Later Surface Is One Command
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#D-019 later and attach preserve original wording only in Sources and converge exactly

- **WHEN** one caller invokes `later <original-text>` in a current repository
- **THEN** the original text exists only in one immutable Source and the returned inbox Work Item cites that Source ID
- **AND** the result returns the original text, Source ID, Work Item ID, and one exact next step
- **AND** repeating the same wording returns the existing Work Item as a dedupe match without changing Source, Work Item, Git ref, or Grant bytes

#### Scenario: An observation is parked without a Source
covers: #Requirement: Intent-Level Later Surface Is One Command
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#later --kind bug parks an observation in the inbox without minting a Source

- **WHEN** one caller invokes `later <original-text> --kind bug` outside any task session
- **THEN** one inbox Work Item of kind `bug` carries the wording as its interpretation summary and cites no Source
- **AND** the Governance Source ledger is unchanged and repeating the wording returns that Work Item as a dedupe match

#### Scenario: Wording noted inside a task is staged as a Finding
covers: #Requirement: Intent-Level Later Surface Is One Command
test: packages/workflow-engine/test/governance-findings.integration.test.ts#later inside an active task stages a Finding and convert flushes it to the inbox without a Source

- **WHEN** one caller invokes `later <original-text>` while a task session covers the working tree
- **THEN** one pending Finding bound to that session records the wording and no Work Registry or Source bytes change
- **AND** the result names the `finding convert` next step that flushes it to the inbox

#### Scenario: Concurrent exact wording converges
covers: #Requirement: Intent-Level Later Surface Is One Command
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#D-019 concurrent later calls converge on at most one Work Item

- **WHEN** two `later` calls both pass their initial exact-wording search before either publishes a Work Item
- **THEN** a Work Registry locked recheck allows at most one inbox Work Item to cite that wording
- **AND** the loser returns the winning Work Item as a truthful dedupe match with an attach next step
- **AND** any Source captured by the loser remains an immutable unreferenced record and no Work Item relation is overwritten

### Requirement: Attach Adds a Source Without Reclassifying Work
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Under D-019, `attach <work-item-id> <original-text>` SHALL capture or reuse one
exact Source and append its identity to the requested open Work Item under the
existing Work Registry lock. The update SHALL preserve kind, stage, lane, title,
relations, closure, and timeline. Its current interpretation SHALL become
agent-derived and SHALL bind only the canonically sorted Source identities; it
MUST NOT copy the original wording. Repeating the exact attachment SHALL be
byte-idempotent, including after a later accepted interpretation. An active item and its change origin SHALL receive their Source references through the existing recoverable Work Registry transaction. An open backlog or active item with a changed agent-derived interpretation MAY be confirmed again through `accept` without changing its stage. A closed item or unsafe current record SHALL fail before
claiming an attachment.

`attach <work-item-id> <SRC-id>` SHALL link that existing Source without
minting another, and `attach <work-item-id> <original-text> --supersedes
<SRC-id>` SHALL capture the wording as a correction that supersedes the named
Source while the Work Item keeps citing both records. Repeating the same
correction SHALL reuse the existing Source. Attaching a Source to an observation
kind SHALL preserve the observation's interpretation summary.

#### Scenario: New wording supplements one inbox item
covers: #Requirement: Attach Adds a Source Without Reclassifying Work
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#D-019 later and attach preserve original wording only in Sources and converge exactly

- **WHEN** `attach <work-item-id> <original-text>` names one current open Work Item
- **THEN** exactly one Source identity is added and the current interpretation binds all sorted Source IDs
- **AND** stage, lane, title, timeline, Git refs, and unrelated Work Items remain unchanged
- **AND** retry reuses the exact Source and leaves the Work Item bytes unchanged

#### Scenario: Active attachment keeps shared provenance and later confirmation
covers: #Requirement: Attach Adds a Source Without Reclassifying Work
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#correction preserves shared origin citations and attachment replays preserve confirmation

- **WHEN** an existing Source is attached to an active Work Item sharing an origin with another item
- **THEN** the existing Source is reused and the origin retains the other item’s provenance
- **AND** an exact attachment retry preserves a subsequently confirmed interpretation

### Requirement: Finding Conversion Has One Deterministic Target
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

`finding convert <finding-id>` SHALL preserve the immutable Finding, derive one
stable Work Item identity from it, and create or reuse the exact inbox item
before publishing the create-once `converted` receipt. A Finding is an
observation, so conversion SHALL NOT mint a Source: the inbox item carries the
Finding text as its interpretation summary, defaults to `kind: bug` unless
`--kind <kind>` names another registered kind, and cites only the Sources the
Finding already cited. A crash after the item publication but before
the receipt SHALL truthfully leave the Finding pending; retry SHALL converge to
the same item and then publish the receipt. A different record at that derived
identity SHALL fail closed without publishing or rewriting a receipt, Finding,
or Work Item. `finding convert <finding-id> --now` SHALL first complete that
same durable inbox item and converted receipt, then start the stable immediate
change whose intent cites only the Finding's already-cited Sources. The
intent summary SHALL retain the complete Finding text. The converted item
SHALL remain inbox, and no maintainer-authored duplicate of the Finding text
may be created.

#### Scenario: Conversion resumes after its item is durable
covers: #Requirement: Finding Conversion Has One Deterministic Target
test: packages/workflow-engine/test/governance-findings.integration.test.ts#D-019 finding convert resumes one deterministic item before publishing its receipt

- **WHEN** conversion stops after the deterministic inbox item is durable but before its receipt exists
- **THEN** default Finding listing still reports the Finding as pending
- **AND** retry reuses the byte-identical Work Item record, mints no Source, and publishes one converted receipt targeting that item
- **AND** no second Work Item, migration record, Grant, or unrelated Git ref is created; only the dedicated Finding ref advances for its receipt

#### Scenario: Converted Finding is escalated immediately
covers: #Requirement: Finding Conversion Has One Deterministic Target
test: packages/workflow-engine/test/propose-planning-workspace.integration.test.ts#actual host Finding conversion keeps no Source, durable inbox/receipt, real planning bootstrap and exact replay

- **WHEN** `finding convert <finding-id> --now` names one pending or exactly converted Finding
- **THEN** conversion first publishes or reuses its deterministic inbox item and receipt
- **AND** the stable immediate change carries only the Finding's already-cited Sources while the Work Item remains inbox
- **AND** the result echoes the original Finding text and one truthful propose next step

### Requirement: Finding Link Is a Receipt-Only Relation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

`finding link <finding-id> --change <change-id>` SHALL require one exact
existing plain change directory inside the configured change root. `finding link <finding-id> --work-item <work-item-id>` SHALL instead resolve one existing valid Work Item. Both forms SHALL publish
only the create-once `linked` Finding disposition receipt. The receipt SHALL
name the requested change or Work Item and SHALL NOT write `origin.json`, add Source or Work
Item references, widen a task path, create a Grant, or mutate planning, the task HEAD, index, working tree or
repository projection bytes. Only the dedicated Finding ref SHALL advance. The same exact link SHALL be idempotent. Missing,
symbolic-link, escaped, or otherwise unsafe change targets and conflicting
terminal dispositions SHALL fail before receipt publication.

#### Scenario: A Finding links to a non-current existing change
covers: #Requirement: Finding Link Is a Receipt-Only Relation
test: packages/workflow-engine/test/governance-findings.integration.test.ts#D-019 finding link records only one exact existing change target

- **WHEN** `finding link <finding-id> --change <change-id>` names a contained plain managed change directory
- **THEN** one immutable linked receipt records that change target and the original Finding remains byte-identical
- **AND** the target change, task scope, origin, Source, Work Item, task HEAD, index, working tree and Grant bytes remain unchanged
- **AND** retry returns the same terminal relation without another receipt

#### Scenario: An observation links to existing work without another inbox item
covers: #Requirement: Finding Link Is a Receipt-Only Relation
test: packages/workflow-engine/test/governance-finding-work-item.integration.test.ts#Finding links an existing Work Item once without creating another inbox item

- **WHEN** a Finding links to an existing Work Item
- **THEN** one create-once receipt names that item without mutating it or creating another
- **AND** an exact retry returns the same relation

### Requirement: Governance Intake Counts Are Read-Only
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

The engine SHALL expose `intakeCounts` with exactly the current `inbox`,
`pendingFindings`, and `backlog` counts in `status`, successful `open-task`
session-start, and `handoff validate` read outputs. Work Item counts SHALL come
from the validated current Work Registry inventory, and pending Finding counts
SHALL cover the validated records visible through the repository Finding ref and available remote-tracking copies. Reading the aggregate MUST NOT create or update a Source,
Finding, disposition, Work Item, tracked projection, or Git ref of its own. It
MAY enter the existing Work Registry read boundary, which can finish one exact
previously prepared crash-recovery transaction before returning current counts.

#### Scenario: One Finding is dismissed
covers: #Requirement: Governance Intake Counts Are Read-Only
test: packages/workflow-engine/test/governance-findings.integration.test.ts#Finding disposition is append-only and runtime-wide counts stay read-only

- **WHEN** the repository contains two identity-valid pending Findings and one is dismissed
- **THEN** `pendingFindings` decreases by one while inbox and backlog counts remain exact
- **AND** every original Finding and tracked repository byte remains unchanged

### Requirement: Selected Source Corrections Update Active Provenance Recoverably
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

`correct <work-item-id> <old-SRC-id> <original-text>` SHALL preserve the exact new wording in a Source superseding the selected existing Source. It SHALL replace that reference only on the selected open Work Item, make its interpretation agent-derived and preserve every immutable Source. If the item is active, the same recoverable journal and compare-and-swap transaction SHALL update its origin. References still used by another linked Work Item MUST remain in that shared origin. A later `accept` MAY confirm the changed interpretation without changing backlog or active stage; exact correction retries SHALL preserve that subsequent confirmation.

Intake mutation responses SHALL expose canonical original wording and readable Work Item titles while retaining structured identities. A captured correction left by an interruption MAY be reused when its predecessor and exact wording match.

#### Scenario: Correcting active work preserves history and permits fresh confirmation
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#correct preserves exact Source history, replaces active provenance and can be re-confirmed

- **WHEN** the public correction command replaces a Source on an active item
- **THEN** both Source records stay exact and the item and origin cite the correction
- **AND** accepting the interpretation retains the active stage and subsequent retries preserve that acceptance

#### Scenario: An interrupted correction reuses its captured Source
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#correction reuses captured wording after interruption and reopens backlog interpretation

- **WHEN** correction stops after Source capture and before updating its Work Item
- **THEN** retry reuses the exact superseding Source
- **AND** the open item can obtain a fresh confirmed interpretation

#### Scenario: Paired source updates recover across write boundaries
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#active Source corrections recover after each journal and paired-write crash

- **WHEN** an active correction process stops after journal publication or either paired write
- **THEN** existing transaction recovery converges the selected Work Item and its origin

#### Scenario: Concurrent item edits survive correction rollback
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#correction CAS rolls back its origin update while preserving a concurrent item edit

- **WHEN** a concurrent item edit defeats the correction compare-and-swap
- **THEN** rollback preserves the foreign item and restores only its own origin write

#### Scenario: Mutation outputs retain human-readable wording
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#intake mutation results expose canonical wording and Work Item titles

- **WHEN** intake creates, attaches, links or corrects records
- **THEN** its response exposes the original wording and available Work Item title
