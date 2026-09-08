# Projection
capabilities: [projection-service]

## Purpose

Provide deterministic, shared projection services that preserve their canonical inputs, existing document boundaries, and user-owned content.
## Requirements
### Requirement: Declarative Projection Catalog
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5a56b9d773c073a429dfbc7d271fdd00d18d873752bb86ca0540662433bfb1ba]

Each projection SHALL declare its identity, version, target ownership, placement,
triggers and drift policy in the projection module. Pure source bindings SHALL
derive bytes from loaded source snapshots. The catalog SHALL include handoff,
WHY ledger, registry backlog/inventory/history, and native agent guidance.
Existing transition authority SHALL remain limited to its reviewed entries.

#### Scenario: A source selects an undeclared engine path
covers: #Requirement: Declarative Projection Catalog

- **WHEN** its output differs from the fixed catalog path or explicit configured target binding
- **THEN** projection fails before any write
- **AND** user target configuration cannot add privileged lifecycle output paths

### Requirement: Deterministic Shared Projection Services
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5a56b9d773c073a429dfbc7d271fdd00d18d873752bb86ca0540662433bfb1ba]

Project SHALL write derived bytes, validate SHALL recompute them, remove SHALL
only remove user-declared regions, and status SHALL report every declaration
and its current targets. User-declared targets SHALL use region placement only.
Validation SHALL NOT trust a stored digest as proof of currentness.

#### Scenario: Concurrent editing during diff review
covers: #Requirement: Deterministic Shared Projection Services

- **WHEN** a target changes after preparation or during an earlier target write
- **THEN** the next target comparison reports a conflict instead of overwriting the new content
- **AND** no cross-file atomic transaction is claimed

### Requirement: Preserve Existing Projection Contracts
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5a56b9d773c073a429dfbc7d271fdd00d18d873752bb86ca0540662433bfb1ba]

The WHY ledger SHALL retain its existing markers and byte output; its new
identity belongs to catalog metadata. Work Registry projections SHALL retain
their current configured paths, bytes, source validation, mutation locks,
activation rules, stale-history checks and handoff refresh behavior.
Source and semantic ledgers SHALL NOT be migrated as projections. OpenSpec
skill/prompt manifests SHALL remain separate.

#### Scenario: Registry source is unchanged
covers: #Requirement: Preserve Existing Projection Contracts

- **WHEN** work-item render uses the shared service
- **THEN** backlog, inventory and history match the previous renderer byte for byte

#### Scenario: Unexpected historical output
covers: #Requirement: Preserve Existing Projection Contracts

- **WHEN** a history directory contains a file absent from the source snapshot
- **THEN** status/doctor report it as unexpected and validation rejects stale output
- **AND** inspection does not delete or repair the file

### Requirement: Curated Refresh Shares Region Splicing
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5a56b9d773c073a429dfbc7d271fdd00d18d873752bb86ca0540662433bfb1ba]

Curated document refresh SHALL reuse the common byte-preserving region splice
after its existing heading locator and replacement checks. Its proposal,
review, policy/source digests, target lock and apply boundaries SHALL remain
unchanged. This reuse SHALL NOT silently add markers to existing curated files.

#### Scenario: Approved scoped replacement
covers: #Requirement: Curated Refresh Shares Region Splicing

- **WHEN** a current reviewed curated replacement is applied
- **THEN** it has the same output bytes and scope as before the refactor
- **AND** stale or rejected proposals remain rejected

### Requirement: System Maps Project One Readable Contract Authority
sources: [SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e]

The engine SHALL generate SPEC_MAP, COVERAGE and REQUIREMENTS through its existing projection registry from one system-description snapshot. These views SHALL expose contract locations, scenario coverage and exact cited Source wording using readable titles and text. Opaque Source, Finding and Work Item identities or content hashes MUST NOT replace wording on the human-readable surface; structured validation results MAY retain technical identities. Generated views MUST NOT create a second canonical Source or contract authority.

#### Scenario: Maps retain exact wording without opaque identities
covers: #Requirement: System Maps Project One Readable Contract Authority
test: packages/workflow-engine/test/system-documents.contract.test.ts#system document projections share the registry and print wording without opaque identities

- **WHEN** the system document projections are generated
- **THEN** they use the registered projection service and print the underlying wording
- **AND** human-readable maps do not substitute opaque identities for that wording

#### Scenario: Test, render and validation use the same contracts
covers: #Requirement: System Maps Project One Readable Contract Authority
test: packages/workflow-engine/test/system-documents-cli.contract.test.ts#documents CLI produces proof before validation and renders from the same canonical snapshot

- **WHEN** the documents CLI produces proof and refreshes its generated views
- **THEN** validation consumes the matching canonical snapshot and actual test evidence
