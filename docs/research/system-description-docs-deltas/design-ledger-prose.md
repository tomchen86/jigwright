# Design ledger prose — contract delta

Date: 2026-09-08. This is the explicit MODIFIED delta for system-description-docs-plan §9 decision 5. Apply it to the colocated successor of `investigation-evidence-and-why`; the original contract migration remains independently auditable.

## MODIFIED Requirements

### Requirement: Design Ledger Is an Engine-Managed Projection
sources: [SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e]

The workflow engine SHALL render one marked investigation-ledger region of the authoritative design as readable prose from the authoritative Manifest v3 WHY overlays. The engine SHALL own the markers and all projection bytes inside that region.

The prose MUST present the inspected path, source byte locations, WHY, protected invariant, reviewer question, and answer as reviewed, actor-attested claims. Technical identities, content digests, groups, terms, and actor provenance MUST remain in the structured Manifest rather than being printed as JSON, hashes, or author identities in the prose. The projection MUST NOT become investigation evidence or claim engine-verified understanding.

#### Scenario: Managed ledger matches structured evidence
covers: #Requirement: Design Ledger Is an Engine-Managed Projection
test: packages/workflow-engine/test/investigation-why.integration.test.ts#Manifest v3 WHY overlays render and validate the exact managed design region

- **GIVEN** current structured evidence and WHY overlays
- **WHEN** the design ledger is rendered
- **THEN** its readable paths, source byte locations, and semantic fields match the structured source exactly
- **AND** technical identities and actor provenance remain in the authoritative Manifest

#### Scenario: Managed ledger is edited manually
covers: #Requirement: Design Ledger Is an Engine-Managed Projection
test: packages/workflow-engine/test/investigation-why.integration.test.ts#Manifest v3 WHY overlays render and validate the exact managed design region

- **GIVEN** the rendered design ledger differs from its current structured source
- **WHEN** planning validation runs
- **THEN** validation fails
- **AND** the manual projection does not become evidence

#### Scenario: Managed markers are ambiguous
covers: #Requirement: Design Ledger Is an Engine-Managed Projection
test: packages/workflow-engine/test/investigation-why.integration.test.ts#Manifest v3 projection rejects malformed managed ledger markers

- **GIVEN** design contains missing, duplicate, nested, or malformed ledger markers
- **WHEN** planning validation runs
- **THEN** validation fails without guessing an authored/managed boundary
