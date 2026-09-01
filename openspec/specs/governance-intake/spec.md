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

#### Scenario: Sources are listed without optional governance

- **WHEN** a repository has Source records but no Work Registry configuration
- **THEN** `source list` returns their exact selected wording in stable Source-ID order
- **AND** every returned Source passes the same identity and canonical-byte validation as `source show`

#### Scenario: Immediate work cites a Source directly

- **WHEN** an existing change `origin.json` cites a Source without a parking Work Item
- **THEN** `source trace` reports that change origin
- **AND** the Source gains no lifecycle, priority, check, or transition authority

#### Scenario: Optional Work Registry is absent

- **WHEN** a repository has Source records but no Work Registry configuration
- **THEN** `source list`, `source show`, and correction-chain `source trace` remain available
- **AND** optional Work Item and change-origin relations are returned as empty

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

An installed Work Registry SHALL allow a caller to find a Work Item by the
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

### Requirement: Work Registry Is an Explicit Optional Capability

A configured repository SHALL represent an installed Work Registry with its
strict adapter configuration and SHALL represent a disabled Work Registry with
the required exact value `workRegistry: null`. Omitting the key or supplying an
unknown adapter MUST remain invalid. Disabling the Work Registry MUST NOT
disable Governance Source capture or reading, generic handoff rendering, or
archive processing that has no Work Items to reconcile.

#### Scenario: Configured consumer disables the Work Registry

- **WHEN** a valid repository consumer configuration sets `workRegistry` to `null`
- **THEN** Source capture, list, show, and correction-only trace remain available
- **AND** generic handoff and archive processing omit Work Registry projections
- **AND** a Work Item command fails with `WORK_REGISTRY_UNAVAILABLE` before mutation

#### Scenario: Work Registry capability key is missing

- **WHEN** a repository consumer configuration omits `workRegistry`
- **THEN** configuration validation fails rather than inferring enabled or disabled behavior

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
