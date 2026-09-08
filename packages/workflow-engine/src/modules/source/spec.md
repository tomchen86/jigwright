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

### Requirement: Canonical Contracts Follow Directory Containment
sources: [SRC-b0efc48e78660c1393b1d806f0331a58a3a721a8d9b0629608c1ff047a6c3887]

System contracts SHALL live with their code as `spec.md`. The nearest containing spec SHALL own a path, a module without a local spec SHALL inherit a containing spec, and a cross-module promise SHALL be placed at the lowest common containing directory. Historical capability aliases MAY resolve to that same canonical document without creating another normative copy. Native OpenSpec validation and archive projection SHALL operate on those canonical contracts while preserving reviewed planning artifact bytes.

#### Scenario: Ownership follows the containing tree
covers: #Requirement: Canonical Contracts Follow Directory Containment
test: packages/workflow-engine/test/system-spec.contract.test.ts#spec ownership follows nearest containment, common ancestors, and both sides of moves

- **WHEN** the engine resolves ownership for local, inherited, cross-module or moved paths
- **THEN** it selects the nearest applicable containing contract
- **AND** a sibling directory prefix does not imply ownership

#### Scenario: Old capability names resolve to one contract
covers: #Requirement: Canonical Contracts Follow Directory Containment
test: packages/workflow-engine/test/system-document-boundaries.contract.test.ts#capability aliases resolve to one canonical spec while directory containment remains ownership

- **WHEN** a legacy capability name identifies a colocated spec
- **THEN** it resolves to that exact canonical file
- **AND** ambiguous aliases are reported instead of selecting a second authority

#### Scenario: Native archive updates the colocated contract
covers: #Requirement: Canonical Contracts Follow Directory Containment
test: packages/workflow-engine/test/colocated-openspec.integration.test.ts#native OpenSpec validates and archives aliased deltas into one colocated spec without copying planning authority

- **WHEN** reviewed deltas under two historical capability names modify one containing contract
- **THEN** native archive writes the result to that canonical file
- **AND** the archived planning artifacts retain their reviewed bytes

### Requirement: System Scenarios Bind Existing Meaning and Observed Test Proof
sources: [SRC-a341f8c2a6a2c42cebd5d199b134ac105c13247829294c14a8fc9fcc63702ec0]

Each system requirement SHALL cite resolvable Governance Sources. Each scenario SHALL name an existing file-header invariant or a requirement in the same spec through `covers`, and an exact test path and name through `test`. Validation SHALL report absent contracts, unresolved Sources, missing or invalid bindings and a TBD Purpose. Metadata in fenced examples MUST NOT become declarations.

`documents validate` SHALL require actual passing evidence for each bound test at the same source snapshot. A skipped, cancelled, failed, absent or stale result MUST NOT count as passed. A current exact native full-gate receipt MAY supply that evidence; editing contract or source bytes SHALL invalidate earlier proof. A newer failed or unexecuted selected test MUST NOT fall back to an older pass.

#### Scenario: Structural bindings are executable
covers: #Requirement: System Scenarios Bind Existing Meaning and Observed Test Proof
test: packages/workflow-engine/test/system-documents.contract.test.ts#documents reject dangling references, missing coverage, TBD purpose and non-passing evidence

- **WHEN** a Source, containing contract, invariant, exact test binding or Purpose is absent or invalid
- **THEN** validation identifies the unresolved obligation

#### Scenario: Fenced examples preserve their literal meaning
covers: #Requirement: System Scenarios Bind Existing Meaning and Observed Test Proof
test: packages/workflow-engine/test/system-spec.contract.test.ts#system spec parser keeps normative text and reads metadata outside fenced examples

- **WHEN** a spec contains fenced metadata examples
- **THEN** the parser preserves normative text and only reads declarations outside those examples

#### Scenario: Native outcomes and contract changes govern proof
covers: #Requirement: System Scenarios Bind Existing Meaning and Observed Test Proof
test: packages/workflow-engine/test/system-document-evidence.contract.test.ts#bounded documents tests retain exact native outcomes and reject stale source evidence

- **WHEN** the selected tests run, fail to execute, or have repeated names with a nonpassing result
- **THEN** the evidence retains their actual outcomes
- **AND** source or contract changes prevent reuse of a prior passing result

#### Scenario: Full-gate evidence names the same snapshot
covers: #Requirement: System Scenarios Bind Existing Meaning and Observed Test Proof
test: packages/workflow-engine/test/system-document-evidence.contract.test.ts#documents reuse native full-gate telemetry only at the matching source snapshot

- **WHEN** system documents consume a full-gate result
- **THEN** the native receipt, telemetry and source identities must match the selected snapshot
