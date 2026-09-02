# governance-intake Specification

## Purpose

Define immutable Governance Sources, task-independent Findings, and truthful
Source-to-work provenance without granting lifecycle, priority, or transition
authority.

## Requirements

### Requirement: Governance Sources Preserve Selected Wording Exactly

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

- **WHEN** a caller captures selected maintainer wording with explicit direct-human provenance
- **THEN** the engine stores the exact selected bytes without paraphrase
- **AND** `source show` returns the identity-valid canonical Source

#### Scenario: Stored Source bytes or identity drift

- **WHEN** a Source path, canonical bytes, text digest, or object identity no longer agrees
- **THEN** Source reading fails without rewriting the record

### Requirement: Corrections Preserve Earlier Sources

A correction SHALL create a new Source whose `supersedes` field resolves to an
existing identity-valid Source. The engine MUST NOT edit, delete, redirect, or
silently migrate the earlier Source, and citations to the earlier Source SHALL
remain replayable.

#### Scenario: A maintainer corrects earlier wording

- **WHEN** the corrected wording cites an existing predecessor Source
- **THEN** both immutable Sources remain readable
- **AND** `source trace` reports the correction relation

#### Scenario: A correction cites an absent Source

- **WHEN** `supersedes` names no identity-valid Source object
- **THEN** capture fails before publishing the correction

### Requirement: Source Trace Exposes Provenance Without Copying Authority

The Source read surface SHALL provide `list`, `show`, and `trace`. List SHALL
return every identity-valid canonical Source in stable Source-ID order. Trace
SHALL resolve the selected Source, its predecessor and direct corrections,
linked Work Items, and current or archived change `origin.json` citations.
Change and planning artifacts SHALL store Source identities rather than copied
Source records.

#### Scenario: Sources are listed when there are no Work Items

- **WHEN** a repository has Source records but no Work Item records
- **THEN** `source list` returns their exact selected wording in stable Source-ID order
- **AND** every returned Source passes the same identity and canonical-byte validation as `source show`

#### Scenario: Immediate work cites a Source directly

- **WHEN** an existing change `origin.json` cites a Source without a parking Work Item
- **THEN** `source trace` reports that change origin
- **AND** the Source gains no lifecycle, priority, check, or transition authority

#### Scenario: Built-in Work Registry has zero items

- **WHEN** a configured repository has Source records and zero Work Items
- **THEN** `source list`, `source show`, and correction-chain `source trace` remain available
- **AND** Work Item and change-origin relations are returned as empty

### Requirement: Every Governance Citation Resolves

Every Source identity in a Source correction, Finding, Work Item, or change
`origin.json` SHALL resolve to one canonical identity-valid Source object.
Governance validation MUST reject a dangling citation rather than inventing a
Source, deleting the citation, or rewriting historical bytes.

#### Scenario: A Finding cites a missing Source

- **WHEN** Finding capture names a syntactically valid but absent Source identity
- **THEN** capture fails before publishing the Finding

#### Scenario: A change origin cites a missing Source

- **WHEN** registry validation reads an `origin.json` with a dangling `sourceRefs` entry
- **THEN** validation fails without changing the origin or Source ledger

### Requirement: Work Registry Search Resolves Linked Source Wording

The built-in Work Registry SHALL allow a caller to find a Work Item by the
exact text of any identity-valid Source it cites. Search SHALL return the
canonical Work Item without copying Source text into the item, a projection,
or a search index. Every cited Source SHALL be validated during the search;
missing or invalid Source bytes MUST fail rather than silently degrading to an
item-only match.

#### Scenario: Exact maintainer wording finds a linked Work Item

- **WHEN** a Work Item cites a canonical Source whose exact selected wording matches the query
- **THEN** `work-item search` returns that unchanged Work Item
- **AND** the Source and Work Item bytes remain unchanged
- **AND** no lifecycle, priority, or transition authority is created

### Requirement: Work Items Use Stable Per-Item Records

The built-in Work Registry SHALL persist each current Work Item as one exact,
canonical record under
`docs/work-registry/items/<created-year>/WORK-<ULID>.yaml`. The Work Item path
MUST remain stable across lifecycle changes. `stage`, `lane`, and `blockedBy`
SHALL remain independent facts, and the current interpretation SHALL identify
whether it is `agent-derived` or `maintainer-confirmed`. Source identities,
blockers, change identities, aliases, timeline events, and closure facts MUST
be canonical, internally coherent, and validated without inventing history.

#### Scenario: A new current Work Item is parked

- **WHEN** a caller creates one valid Work Item from explicit current input
- **THEN** the registry writes one `inbox` item at its creation-year path
- **AND** the initial interpretation remains visibly `agent-derived`
- **AND** no priority, planning, or transition authority is created

#### Scenario: A persisted relation is incoherent

- **WHEN** a Work Item path, canonical bytes, blocker, Source reference, change link, timeline, or closure disagrees
- **THEN** the registry rejects the record without moving or rewriting it

### Requirement: Reviewed Work Item Decisions Use Grant Core

Priority recommendation SHALL be read-only and SHALL expose its current lane,
recommended lane, and explicit reasons. Intake, priority application, and
promotion SHALL bind the exact current Work Item digest. When repository policy
classifies one of those operations as a protected continuation, the domain
SHALL submit a registered Central Grant transition and apply only the exact
accepted transition. A Source, Finding, recommendation, or Work Item MUST NOT
act as a second authority or bypass an accepted Grant Core result.

#### Scenario: Priority is inspected without application

- **WHEN** a caller requests the current priority recommendation
- **THEN** the registry returns explicit recommendation reasons
- **AND** no Work Item, projection, Git ref, or private journal is changed

#### Scenario: Protected review needs exact authorization

- **WHEN** current policy requires a Grant for the requested reviewed transition
- **THEN** the ordinary command emits one exact Fail-Grant challenge before mutation
- **AND** only the registered transition consumer may apply the accepted current decision

### Requirement: Promotion Atomically Links Work and Source Provenance

Promotion SHALL require one `maintainer-confirmed` `backlog` Work Item in lane
`now` or `next`, closed blockers, the exact expected item digest, and a current
survey of declared repository symbols. It SHALL atomically change the Work Item
to `active` and merge the Work Item's immutable `sourceRefs` plus its identity
into the existing change `origin.json` `sourceRefs` and `workItemRefs`.
Promotion MUST preserve unrelated origin relations, use compare-and-swap for
both tracked inputs, and recover the same prepared transaction after a crash.

#### Scenario: Current promotion succeeds

- **WHEN** an eligible reviewed Work Item, current survey, expected digest, and change identity still agree
- **THEN** the item and origin publish one bidirectional relationship
- **AND** the origin stores identities rather than copied Source or Work Item records

#### Scenario: Either tracked input changes

- **WHEN** the Work Item or origin no longer matches the prepared promotion
- **THEN** promotion fails or rolls back without a partial relationship
- **AND** retry never overwrites a concurrent canonical update

### Requirement: Work Registry Read Surfaces Are Deterministic

The built-in registry SHALL expose `list`, `show`, `search`, `trace`,
`recommend`, `inventory`, `render`, and `validate`. Every composite read MUST
use one coherent item/origin snapshot and validate every traversed Source and
relation. Render SHALL derive the backlog, inventory, history, and configured
handoff views deterministically from canonical records; those views and any
search cache SHALL NOT become authority.

#### Scenario: A caller traces one Work Item

- **WHEN** the Work Item and all cited records are canonical
- **THEN** trace returns the unchanged item, its canonical Sources, and linked current or archived origins
- **AND** the read creates no lifecycle or transition fact

#### Scenario: A projection drifts

- **WHEN** a generated backlog, inventory, history, or handoff byte no longer matches canonical records
- **THEN** validation rejects the projection rather than treating it as registry authority

### Requirement: Planning Prose Distinguishes Source-Backed Claims

The generated planning interface SHALL instruct callers to resolve cited
Sources through `source show`, preserve their exact selected wording, mark
claims grounded in those Sources as `source-backed`, and mark interpretations
or extensions as `agent-derived`. Planning and change artifacts SHALL retain
immutable Source identities without copying an entire Source record. This
provenance distinction SHALL NOT grant planning, policy, check, or transition
authority and SHALL NOT require a Work Item for an uncited change.

#### Scenario: A proposed change cites maintainer wording

- **WHEN** the request names a canonical Source identity
- **THEN** the planning guidance directs the caller to the current Source read surface
- **AND** source-backed wording remains distinguishable from agent-derived interpretation

### Requirement: Archive Reconciles Linked Work Items Deterministically

Archive reconciliation SHALL derive linked Work Items from the canonical
archived change origin, require the same bidirectional relationship admitted
before archive, close only those active items with outcome `delivered`, and
regenerate exact current projections. It SHALL preserve every Source and Work
Item timeline and SHALL be idempotent for the same archive facts. An archived
change with zero linked Work Items SHALL produce no Work Item effects.

#### Scenario: One linked change is archived

- **WHEN** current item, origin, archive identity, and compare-and-swap facts agree
- **THEN** each exactly linked active Work Item closes once with the archived change identity
- **AND** a second reconciliation preserves the same record and projection bytes

#### Scenario: An archived change has no linked Work Items

- **WHEN** the canonical archived origin has no `workItemRefs`
- **THEN** archive reconciliation returns no Work Item output paths
- **AND** Source, Work Registry, handoff, and Git bytes remain unchanged

### Requirement: Work Registry Is Always Available; Work Item Use Is Not Mandatory

A configured repository SHALL always have the built-in Work Registry available.
The repository MAY have zero Work Items, and a change MAY cite a Source directly
without first creating a Work Item. The `workRegistry` configuration key MAY be
omitted to select engine-owned default paths or MAY contain one exact current
path configuration. The value `workRegistry: null` MUST fail with
`REPOSITORY_CONSUMER_CONFIG_INVALID` under D-018 rather than disabling the
capability or preserving a dormant null branch.

#### Scenario: Configured consumer has zero Work Items

- **WHEN** a valid configured repository has no Work Item records or inventory projection
- **THEN** Work Item list and Source-to-work trace return empty Work Item facts
- **AND** Source capture, generic handoff, and archive processing remain available

#### Scenario: Work Registry configuration selects defaults

- **WHEN** a repository consumer configuration omits the `workRegistry` key
- **THEN** the engine supplies its exact current Work Registry default paths
- **AND** it does not infer a disabled capability

#### Scenario: Configured consumer attempts to disable the Work Registry

- **WHEN** a repository consumer configuration supplies `workRegistry: null`
- **THEN** configuration validation fails with `REPOSITORY_CONSUMER_CONFIG_INVALID`
- **AND** no Source, Work Item, projection, lock, or Git byte changes

### Requirement: Governance Source Ledger Path Is Engine-Owned

Every Governance Source writer, reader, list operation, Work Item citation,
backlog link, trace, and validator SHALL resolve the Source ledger only at
`workflow/source-ledger/objects/sha256`. Work Registry configuration MUST NOT
contain `sourceRoot`; an attempted override is an unknown extra key and MUST
fail with `REPOSITORY_CONSUMER_CONFIG_INVALID` before reading or writing either
the fixed ledger or the requested path.

#### Scenario: A configuration attempts to redirect Sources

- **WHEN** an otherwise valid Work Registry configuration supplies `sourceRoot`
- **THEN** configuration validation rejects the extra key
- **AND** the fixed Source ledger and requested path remain unchanged

#### Scenario: Core Source capture precedes repository consumer configuration

- **WHEN** a caller captures or reads an identity-valid Source before a repository consumer configuration exists
- **THEN** the engine uses the fixed core-owned ledger path
- **AND** it creates no Work Item or repository configuration

### Requirement: Findings Remain Independent of Task Write Scope

A Finding SHALL bind its exact text to the active session, change, branch, head,
and tree in engine-owned private runtime storage. Finding capture SHALL remain
available when the repository path is outside the current task's allowed write
scope. A Finding is an agent-authored observation and MUST be revalidated before
promotion into normative planning or transition facts.

#### Scenario: Mid-task observation is outside allowed paths

- **WHEN** an active session records a bounded Finding about work outside its task paths
- **THEN** the engine stores the Finding with current session and Git facts
- **AND** no repository lifecycle transition is authorized by the Finding

### Requirement: Finding Disposition Is Append-Only

Under D-019, the engine SHALL keep each original private `FND-*.json` record immutable. A
Finding read model SHALL expose exactly one `disposition` value from `pending`,
`converted`, `linked`, or `dismissed`, together with its reason, target, and
terminal time. Absence of a terminal receipt means `pending`; a terminal value
MUST come from one create-once canonical sidecar beside the original Finding.
The current `dismiss` command SHALL require a non-empty reason, write a null
target, preserve the original Finding bytes, and remain visible through
`finding list --all`. The ordinary `finding list` command SHALL return only
pending Findings across the repository's private runtime.

#### Scenario: A caller dismisses one pending Finding

- **WHEN** `finding dismiss <finding-id> --reason <reason>` resolves one identity-valid pending Finding
- **THEN** one immutable terminal receipt records `dismissed`, the exact reason, a null target, and the current time
- **AND** the original Finding, Source, Work Item, Git ref, and tracked projection bytes remain unchanged
- **AND** the Finding disappears from the default list but remains in `finding list --all`

#### Scenario: Finding storage is ambiguous or unsafe

- **WHEN** runtime-wide listing observes an unsafe directory, noncanonical name, path mismatch, hard link, mode drift, invalid bytes, orphan receipt, or duplicate identity
- **THEN** listing and disposition fail closed without choosing one record
- **AND** no Finding or disposition byte is repaired, deleted, or rewritten

### Requirement: Intent-Level Later Surface Is One Command

Under D-019, `later <original-text>` SHALL capture one direct-human Governance
Source and create one inbox Work Item in the always-available Work Registry
without requiring a JSON envelope. The facade SHALL use the exact fixed
authoring defaults `kind: improvement` and `lane: null`. Its title SHALL identify
the captured Source, and its agent-derived interpretation SHALL not duplicate
the original wording. Before capture, exact Source wording already cited by a
Work Item SHALL produce a deterministic attach suggestion and SHALL NOT create a
second Source or Work Item. The ordinary path SHALL require no Grant.

#### Scenario: Original wording is parked for later

- **WHEN** one caller invokes `later <original-text>` in a current repository
- **THEN** the original text exists only in one immutable Source and the returned inbox Work Item cites that Source ID
- **AND** the result returns the original text, Source ID, Work Item ID, and one exact next step
- **AND** repeating the same wording returns the existing Work Item as a dedupe match without changing Source, Work Item, Git ref, or Grant bytes

#### Scenario: Concurrent exact wording converges

- **WHEN** two `later` calls both pass their initial exact-wording search before either publishes a Work Item
- **THEN** a Work Registry locked recheck allows at most one inbox Work Item to cite that wording
- **AND** the loser returns the winning Work Item as a truthful dedupe match with an attach next step
- **AND** any Source captured by the loser remains an immutable unreferenced record and no Work Item relation is overwritten

### Requirement: Attach Adds a Source Without Reclassifying Work

Under D-019, `attach <work-item-id> <original-text>` SHALL capture or reuse one
exact Source and append its identity to the requested open Work Item under the
existing Work Registry lock. The update SHALL preserve kind, stage, lane, title,
relations, closure, and timeline. Its current interpretation SHALL become
agent-derived and SHALL bind only the canonically sorted Source identities; it
MUST NOT copy the original wording. Repeating the exact attachment SHALL be
byte-idempotent. A closed item or unsafe current record SHALL fail before
claiming an attachment.

#### Scenario: New wording supplements one inbox item

- **WHEN** `attach <work-item-id> <original-text>` names one current open Work Item
- **THEN** exactly one Source identity is added and the current interpretation binds all sorted Source IDs
- **AND** stage, lane, title, timeline, Git refs, and unrelated Work Items remain unchanged
- **AND** retry reuses the exact Source and leaves the Work Item bytes unchanged

### Requirement: Finding Conversion Has One Deterministic Target

`finding convert <finding-id>` SHALL preserve the immutable Finding, derive one
stable Work Item identity from it, persist an agent-authored Source for the
Finding text, and create or reuse the exact inbox item before publishing the
create-once `converted` receipt. A crash after the item publication but before
the receipt SHALL truthfully leave the Finding pending; retry SHALL converge to
the same item and then publish the receipt. A different record at that derived
identity SHALL fail closed without publishing or rewriting a receipt, Finding,
or Work Item. Any exact Source already captured before detecting that
collision remains a truthful append-only record and does not authorize a
relation of its own.

#### Scenario: Conversion resumes after its item is durable

- **WHEN** conversion stops after the deterministic inbox item is durable but before its receipt exists
- **THEN** default Finding listing still reports the Finding as pending
- **AND** retry reuses byte-identical Source and Work Item records and publishes one converted receipt targeting that item
- **AND** no second Work Item, migration record, Grant, or Git ref is created

### Requirement: Finding Link Is a Receipt-Only Relation

`finding link <finding-id> --change <change-id>` SHALL require one exact
existing plain change directory inside the configured change root, then publish
only the create-once `linked` Finding disposition receipt. The receipt SHALL
name the requested change and SHALL NOT write `origin.json`, add Source or Work
Item references, widen a task path, create a Grant, or mutate planning, Git, or
repository projection bytes. The same exact link SHALL be idempotent. Missing,
symbolic-link, escaped, or otherwise unsafe change targets and conflicting
terminal dispositions SHALL fail before receipt publication.

#### Scenario: A Finding links to a non-current existing change

- **WHEN** `finding link <finding-id> --change <change-id>` names a contained plain managed change directory
- **THEN** one immutable linked receipt records that change target and the original Finding remains byte-identical
- **AND** the target change, task scope, origin, Source, Work Item, Git ref, and Grant bytes remain unchanged
- **AND** retry returns the same terminal relation without another receipt

### Requirement: Governance Intake Counts Are Read-Only

The engine SHALL expose one stable read surface with exactly the current
`inbox`, `pendingFindings`, and `backlog` counts. Work Item counts SHALL come
from the validated current Work Registry inventory, and pending Finding counts
SHALL cover every safely validated session directory in the repository's
private runtime. Reading the aggregate MUST NOT create or update a Source,
Finding, disposition, Work Item, tracked projection, or Git ref of its own. It
MAY enter the existing Work Registry read boundary, which can finish one exact
previously prepared crash-recovery transaction before returning current counts.

#### Scenario: One Finding is dismissed

- **WHEN** the runtime contains two identity-valid pending Findings and one is dismissed
- **THEN** `pendingFindings` decreases by one while inbox and backlog counts remain exact
- **AND** every original Finding and tracked repository byte remains unchanged
