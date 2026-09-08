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
