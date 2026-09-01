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
