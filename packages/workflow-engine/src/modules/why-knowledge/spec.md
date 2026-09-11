# WHY knowledge

## Purpose

Keep reusable source bindings and freshness decisions separate from per-change explanations and observed evidence.

## Requirements

### Requirement: Semantic Entries Index Source Meaning Without Copying It

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e]

The semantic ledger SHALL retain source bindings, dependencies, policy identity and provenance as a reusable index. File explanations SHALL remain in the source header rather than a second WHY prose field in the ledger.

#### Scenario: A ledger entry remains a binding index

covers: #Requirement: Semantic Entries Index Source Meaning Without Copying It
test: packages/workflow-engine/test/system-semantic-ledger.contract.test.ts#semantic ledger is a binding index without a second copy of header prose

- **WHEN** a current file ledger entry is created
- **THEN** the entry binds its source path without duplicating header prose

### Requirement: Reuse Reassesses Changed Import Dependencies

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e]

Semantic reuse SHALL distinguish changed subjects from changed dependencies using the observed source and import bindings. Missing or changed dependencies SHALL invalidate dependent reuse, including consumers reached through reverse import edges.

#### Scenario: Dependency changes propagate to callers

covers: #Requirement: Reuse Reassesses Changed Import Dependencies
test: packages/workflow-engine/test/system-semantic-ledger.contract.test.ts#missing dependencies stay stale and changes propagate through reverse import edges

- **WHEN** a dependency disappears or its source changes
- **THEN** the subject and its dependent entries receive their respective subject-changed or dependency-changed decisions
