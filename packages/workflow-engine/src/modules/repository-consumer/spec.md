# Repository consumer

## Purpose

Load explicit repository-owned configuration for planning, documents, Work Registry and database policy.

## Requirements

### Requirement: Consumer Configuration Preserves Explicit Selections

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The repository consumer loader SHALL use the tracked current configuration to select planning, document, Work Registry and database policy behavior. Only current configuration keys SHALL be admitted; the Work Registry SHALL retain its built-in default when omitted and SHALL NOT be disabled with null.

#### Scenario: Only current consumer fields are accepted

covers: #Requirement: Consumer Configuration Preserves Explicit Selections
test: packages/workflow-engine/test/consumer-configuration.contract.test.ts#repository consumer documents and Work Registry accept only current keys

- **WHEN** a consumer configuration is loaded with current, retired or omitted Work Registry fields
- **THEN** current fields and the built-in default are preserved while retired fields and null disablement are rejected

### Requirement: Consumer Paths Remain Within the Canonical Repository

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The consumer path resolver SHALL resolve configured relative paths within the canonical repository root. A symlink used to reach the repository itself MAY resolve to that root, without permitting configured paths to escape it.

#### Scenario: A repository alias retains contained paths

covers: #Requirement: Consumer Paths Remain Within the Canonical Repository
test: packages/workflow-engine/test/consumer-configuration.contract.test.ts#consumer paths canonicalize a symlinked repository root while remaining contained

- **WHEN** a consumer is opened through a symlink to its repository root
- **THEN** configured paths resolve inside the same canonical repository
