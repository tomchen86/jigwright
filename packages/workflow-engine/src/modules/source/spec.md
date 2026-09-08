# Source
capabilities: [openspec-base-spec-validity]

## Purpose

Keep canonical system contracts structurally valid under the pinned OpenSpec validator while preserving their normative requirement semantics.

## Requirements

### Requirement: Normative Base Specs Pass Pinned Strict Validation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The repository SHALL keep every normative OpenSpec base specification
compatible with the repository-pinned strict validator. Each base
specification MUST contain the required `Purpose` and `Requirements` sections,
and validation failure MUST block managed archive readiness rather than being
ignored or bypassed.

#### Scenario: Repository baseline is valid
covers: #Requirement: Normative Base Specs Pass Pinned Strict Validation

- **WHEN** the registered repository contract validates all normative base
  specifications with the pinned OpenSpec adapter
- **THEN** strict validation succeeds for the complete base-spec set
- **THEN** the result is eligible to serve as evidence for a later
  engine-owned archive transition

#### Scenario: A base spec loses required structure
covers: #Requirement: Normative Base Specs Pass Pinned Strict Validation

- **WHEN** any normative base specification lacks a schema-required section
- **THEN** the registered repository contract fails
- **THEN** the workflow engine continues to reject archive readiness until a
  managed repair restores validity

### Requirement: Structural Repairs Preserve Requirement Semantics
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

A repair for legacy base-spec structure SHALL preserve the existing purpose
prose, requirements, and scenarios unless a separate delta explicitly changes
their semantics. A documentation-only repair MUST remain limited to the exact
invalid structural elements.

#### Scenario: Legacy scope heading is repaired
covers: #Requirement: Structural Repairs Preserve Requirement Semantics

- **WHEN** an existing scope paragraph already states a specification's
  purpose but uses a nonconforming section heading
- **THEN** the repair renames that heading to `Purpose`
- **THEN** all requirement and scenario content remains unchanged
