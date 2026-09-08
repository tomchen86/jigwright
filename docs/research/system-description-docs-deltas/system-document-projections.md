# Readable system maps — contract addition

Date: 2026-09-08. Phase C step 4. Apply to `packages/workflow-engine/src/modules/projection/spec.md`.

## ADDED Requirements

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
