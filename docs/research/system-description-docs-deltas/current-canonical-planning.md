# Canonical planning artifacts — baseline reconciliation delta

Date: 2026-09-09. Apply to `packages/workflow-engine/spec.md`. This delta retains the single planning tree and Git-reconstructable semantic evidence requirements from commit `4541ef1`, replacing only the retired base-spec path and v2 planning description with the delivered colocated/current-v3 contracts.

## MODIFIED Requirements

### Requirement: Canonical Planning Artifacts

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The repository SHALL use colocated `spec.md` contracts for normative requirements and one OpenSpec change directory under the configured change root for each active planning generation. Investigation-first current-v3 generations SHALL keep normalized investigation, proposal, design, delta specs, task list, execution strategy, guard, and exact-plan review in that canonical change tree. The repository SHALL NOT maintain a parallel workflow planning/task tree.

Detailed runtime transcripts, leases, and mutable refs MAY remain under the Git common directory, but every semantic fact required for remote planning assurance MUST be reconstructable from Git or retained in the compact tracked artifacts.

#### Scenario: Agent locates active work

covers: #Requirement: Canonical Planning Artifacts
test: packages/workflow-engine/test/system-spec.contract.test.ts#spec ownership follows nearest containment, common ancestors, and both sides of moves

- **WHEN** an agent locates the normative contract for a path or a cross-module change
- **THEN** ownership resolves to the nearest containing `spec.md` or the common containing contract
- **AND** a sibling directory prefix does not create a second owner

#### Scenario: Native planning retains one canonical authority tree

covers: #Requirement: Canonical Planning Artifacts
test: packages/workflow-engine/test/colocated-openspec.integration.test.ts#native OpenSpec validates and archives aliased deltas into one colocated spec without copying planning authority

- **GIVEN** reviewed OpenSpec change artifacts contain deltas for aliases of one colocated contract
- **WHEN** native validation and archive projection apply those deltas
- **THEN** the result updates that canonical contract without creating an `openspec/specs/` copy
- **AND** the archived planning artifacts preserve their reviewed bytes

#### Scenario: Current committed planning loads without private runtime

covers: #Requirement: Canonical Planning Artifacts
test: packages/workflow-engine/test/committed-investigation-manifest.contract.test.ts#committed change loading binds canonical v3 bytes to an immutable Git tree without private runtime

- **GIVEN** the current-v3 planning artifacts are committed and private investigation runtime has been removed
- **WHEN** committed change loading reconstructs planning authority
- **THEN** the Manifest observation binds the exact commit, tree, path, blob, and content digest from Git
- **AND** a live loader cannot substitute an absent private current ref for its own required live evidence

#### Scenario: CI validates investigation-first planning

covers: #Requirement: Canonical Planning Artifacts
test: packages/workflow-engine/test/session-schema.integration.test.ts#CI replays v3 planning assurance from Git with the live validator

- **GIVEN** a reviewed current-v3 planning generation was committed by the live transition
- **WHEN** CI replays that generation from Git objects
- **THEN** its planning assurance equals the exact assurance recorded by the live validator
- **AND** an exempt generation records an empty collaboration-grant use set rather than inventing a use
