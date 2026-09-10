# Core contracts

## Purpose

Define consumer-neutral data, deterministic representations and explicit ports shared by engine integrations.

## Requirements

### Requirement: Canonical Values Preserve Deterministic Bytes

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The core package SHALL provide one deterministic representation of supported JSON values and portable repository paths. Invalid values and non-portable paths SHALL retain their typed contract errors; consumers SHALL NOT need an engine-specific configuration to use these primitives.

#### Scenario: Canonical JSON is independent of property insertion order

covers: #Requirement: Canonical Values Preserve Deterministic Bytes
test: packages/core/test/canonical-json.contract.test.ts#core canonical JSON preserves the landed deterministic byte contract

- **WHEN** a consumer encodes nested JSON values
- **THEN** object keys are ordered deterministically and the resulting bytes match the public contract

#### Scenario: Invalid paths retain typed errors

covers: #Requirement: Canonical Values Preserve Deterministic Bytes
test: packages/core/test/repository-path.contract.test.ts#core repository paths reject non-portable policy and exact paths with typed errors

- **WHEN** a consumer supplies an absolute, escaping or unsupported repository path
- **THEN** the public path codec rejects it with the matching typed contract error

### Requirement: Governance Source Identity Preserves Wording

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e]

The core Source codec SHALL preserve the supplied text exactly and derive a recomputable identity from its canonical record. Interpretation and storage adapters SHALL NOT replace that original wording.

#### Scenario: Original whitespace remains part of the Source

covers: #Requirement: Governance Source Identity Preserves Wording
test: packages/core/test/governance-source.contract.test.ts#governance Source preserves exact wording and recomputable identity

- **WHEN** a Source is created and parsed through the public codec
- **THEN** the text remains unchanged and its identity can be recomputed
