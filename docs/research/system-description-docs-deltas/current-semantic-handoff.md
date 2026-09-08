# Tracked semantic handoff — baseline reconciliation delta

Date: 2026-09-09. Apply to `spec.md`. The original **Archive-Stable Semantic Handoff** block is retained in commit `4541ef1`. This delta describes the existing tracked-state projection; it does not change handoff selection or archive behavior.

## REMOVED Requirements

### Requirement: Archive-Stable Semantic Handoff

**Reason**: The current renderer does not treat its previous selected-change text or the checked-out branch as selection authority. Without routing, it selects the sole unfinished change, reports no active change, or rejects ambiguity. Managed routing supplies explicit tracked focus when several changes exist.
**Migration**: Preserve the original requirement in Git history and use the current tracked-state requirement below.

## ADDED Requirements

### Requirement: Semantic Handoff Follows Tracked Change State

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The generated semantic handoff SHALL derive change, task, focus, blocker, and reference state from current tracked change contracts and managed routing, including an explicit change selected by an engine-owned lifecycle transition. Existing handoff text and a checked-out branch name MUST NOT create selection authority.

Without managed routing or an explicit lifecycle selection, rendering SHALL select the sole unfinished active change, represent no unfinished active changes explicitly, and reject multiple unfinished changes rather than choosing one arbitrarily. Moving a completed contract into the archive SHALL NOT preserve an obsolete selection from generated output. Managed routing SHALL retain its tracked primary selection and distinguish work awaiting archive from archived work. Committed validation SHALL reproduce the semantic projection without private runtime evidence.

#### Scenario: Archiving a completed change does not preserve stale output selection

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/handoff.integration.test.ts#handoff ignores its previous output and selects the sole active change

- **GIVEN** the handoff names a completed change and one other change has unfinished tasks
- **WHEN** the completed contract moves into the archive
- **THEN** rendering before and after the move selects the same unfinished change
- **AND** validation accepts that projection independently of the old handoff selection

#### Scenario: A branch name cannot resolve ambiguous active work

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/handoff.integration.test.ts#a work branch cannot resolve an otherwise ambiguous handoff

- **GIVEN** multiple unfinished changes have no managed routing selection
- **WHEN** the checked-out branch names one of those changes
- **THEN** rendering reports the ambiguous handoff instead of choosing that change

#### Scenario: Managed routing preserves focus across an archive move

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/change-routing.integration.test.ts#managed routing projects mixed repository state and recovers idempotently

- **GIVEN** tracked routing selects a primary change among blocked, resumable, and completed changes
- **WHEN** a completed contract moves from pending archival into the archive
- **THEN** routing recognizes the archived state and retains the same primary change
- **AND** the generated handoff derives its work categories from the managed routing facts

#### Scenario: Committed routing replays without private runtime

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/change-routing.integration.test.ts#committed routing and handoff replay without private runtime

- **GIVEN** the tracked routing and semantic handoff were committed
- **WHEN** committed repository validation runs after private runtime is removed
- **THEN** it reconstructs the same tracked change selection and accepts the projection

#### Scenario: An archived last change leaves an explicit terminal handoff

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/handoff.integration.test.ts#committed managed-document validation replays a terminal handoff with zero active changes

- **GIVEN** the last active change has moved into the dated archive
- **WHEN** the terminal semantic handoff is committed and private runtime is removed
- **THEN** committed validation reports zero active changes and accepts the managed handoff
