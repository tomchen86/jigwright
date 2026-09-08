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
test: packages/workflow-engine/test/projection-service.contract.test.ts#engine source paths require the catalog target or explicit resolved adapter targets

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
test: packages/workflow-engine/test/projection-service.contract.test.ts#a later target edited during an earlier write is not overwritten

- **WHEN** a target changes after preparation or during an earlier target write
- **THEN** the next target comparison reports a conflict instead of overwriting the new content
- **AND** no cross-file atomic transaction is claimed

### Requirement: Preserve Existing Projection Contracts
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5a56b9d773c073a429dfbc7d271fdd00d18d873752bb86ca0540662433bfb1ba, SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e]

The WHY ledger SHALL retain its engine-owned region markers and derive its current readable explanation from canonical WHY facts. Work Registry projections SHALL retain their configured paths, source validation, mutation locks, activation rules, stale-history checks and handoff refresh behavior. BACKLOG SHALL project original Source wording, kind and lane groupings instead of opaque identities; machine inventory SHALL retain its existing representation. Source records SHALL NOT become mutable projections. The semantic ledger SHALL remain the separately specified derived binding and freshness index. OpenSpec skill/prompt manifests SHALL remain separate.

#### Scenario: Registry source is unchanged
covers: #Requirement: Preserve Existing Projection Contracts
test: packages/workflow-engine/test/registry-projection.contract.test.ts#registry service renders readable backlog lanes and recomputes drift without changing inventory

- **WHEN** work-item render uses the shared service
- **THEN** BACKLOG follows its current readable lane and kind contract
- **AND** the machine inventory remains byte-identical to its established representation
- **AND** recomputation reports modified output as drift

#### Scenario: Unexpected historical output
covers: #Requirement: Preserve Existing Projection Contracts
test: packages/workflow-engine/test/registry-projection.contract.test.ts#registry service renders readable backlog lanes and recomputes drift without changing inventory

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
test: packages/workflow-engine/test/document-refresh.integration.test.ts#approved refresh replaces exactly one reviewed document section

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

### Requirement: Module References Combine Reviewed Explanations and Generated Facts
sources: [SRC-a341f8c2a6a2c42cebd5d199b134ac105c13247829294c14a8fc9fcc63702ec0, SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e]

The governance-intake and authority module READMEs SHALL retain one handwritten explanation and its confirmation commit. The existing projection service SHALL derive Commands, Data, Contracts and Files from usage descriptions, source unions, containing contracts and shallow leading file headers. It SHALL report the files changed since confirmation using the selected source snapshot, without counting regenerated sections or a confirmation-only edit as explanation changes. Header history MAY flag possibly stale prose by comparing Git blame at the confirmation with current snapshot bytes; missing history SHALL remain informational and MUST NOT become a new gate or a claim that prose was verified.

#### Scenario: Reference sections derive from existing facts
covers: #Requirement: Module References Combine Reviewed Explanations and Generated Facts
test: packages/workflow-engine/test/module-readme-projection.contract.test.ts#module README derives commands, union data, contracts and header facts while retaining the handwritten why

- **WHEN** a module reference is rendered
- **THEN** all four reference sections are generated from their existing inputs
- **AND** the handwritten explanation and confirmation remain intact

#### Scenario: Change counts use the selected snapshot
covers: #Requirement: Module References Combine Reviewed Explanations and Generated Facts
test: packages/workflow-engine/test/module-readme-projection.contract.test.ts#README change counts use the pinned source and ignore generated or confirmation-only edits

- **WHEN** a README is generated for a pinned source snapshot
- **THEN** changes in another checkout state do not affect its changed-file count
- **AND** generated output and confirmation-only edits do not count as explanation changes

#### Scenario: Header age is a hint from immutable history
covers: #Requirement: Module References Combine Reviewed Explanations and Generated Facts
test: packages/workflow-engine/test/module-readme-projection.contract.test.ts#README header age uses Git history and fixed snapshot bytes without treating prose as verified

- **WHEN** code is newer than its leading header or history is unavailable
- **THEN** the reference reports the observed hint without certifying the explanation
- **AND** later checkout commits do not alter a fixed snapshot's hint
