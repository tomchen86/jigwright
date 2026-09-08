# Readable registry and module references — Phase C delta

Date: 2026-09-08. The previous refactor required byte-identical human projections. Phase C explicitly changes BACKLOG to original wording, kind and lanes, and changes the WHY view to readable prose. Their source, ownership and mutation boundaries remain unchanged. Machine inventory retains its existing representation. This delta separately adds the completed module README projections.

## MODIFIED Requirements

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

## ADDED Requirements

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
