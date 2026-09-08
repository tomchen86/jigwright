# Current investigation terms — baseline reconciliation delta

Date: 2026-09-08. The raw contract in `9c63c49` described removing an agent term by reasoned supersession. The current term model has no supersession field or removal operation: it preserves a union of contributions, validates the engine floor and records immutable checkpoints. Reviewer-driven semantic reopening can add terms but is not evidence that an earlier term was removed. This delta preserves the current bounds and provenance behavior without promising the absent operation.

## REMOVED Requirements

### Requirement: Search Terms Have a Bounded Governed Lifecycle

**Reason**: The claimed agent-term supersession procedure is absent from the current contribution and checkpoint model.
**Migration**: Use the current bounded-union requirement below. Retain the former removal proposal in historical Git evidence rather than pretending another scan test proves it.

## ADDED Requirements

### Requirement: Search Terms Form Bounded Provenance-Preserving Unions
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL accept fixed typed terms with deterministic case-sensitive literal matching, normalize their identities, deduplicate equal terms and retain each distinct contribution's provenance. It SHALL preview source and effective resource bounds without silently dropping proposed terms. The engine-derived floor MUST remain complete under recomputation. Accepted checkpoint input SHALL replay exactly; divergent stale input MUST NOT rewrite the accepted contribution as a supersession.

#### Scenario: Proposed terms exceed a resource bound
covers: #Requirement: Search Terms Form Bounded Provenance-Preserving Unions
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#term preview reports source and effective overage without dropping proposals

- **WHEN** proposed source or effective term counts exceed their configured bounds
- **THEN** preview requires narrowing and reports the exceeded bound
- **AND** it retains the proposals instead of silently truncating the union

#### Scenario: The engine floor is recomputed exactly
covers: #Requirement: Search Terms Form Bounded Provenance-Preserving Unions
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#engine floor is complete, provenance-preserving, and validates by recomputation

- **WHEN** a purported floor omits a required derived term
- **THEN** recomputation rejects the incomplete floor
- **AND** valid floor terms retain their derivation provenance

#### Scenario: Equal terms retain all contribution provenance
covers: #Requirement: Search Terms Form Bounded Provenance-Preserving Unions
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#typed terms preserve exact bytes, deduplicate semantics, and retain every provenance

- **WHEN** multiple sources contribute the same typed literal
- **THEN** the union uses one semantic term identity with all distinct provenance
- **AND** a different kind or literal retains its own identity

#### Scenario: An accepted checkpoint cannot be overwritten by a divergent replay
covers: #Requirement: Search Terms Form Bounded Provenance-Preserving Unions
test: packages/workflow-engine/test/investigation-session.integration.test.ts#checkpoint transitions replay exactly and reject divergent stale input

- **WHEN** a caller repeats accepted main terms or changes a term in a stale checkpoint envelope
- **THEN** exact input returns the same result without changing its durable record
- **AND** divergent input is rejected rather than replacing the accepted terms
