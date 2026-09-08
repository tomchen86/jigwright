# Current planning history — baseline reconciliation delta

Date: 2026-09-08. Current-schema CI already rejects an incomplete parent even when a later revision adds the missing artifact. The former bootstrap allowance is retained in raw migration commit `9c63c49`. This delta describes existing behavior and does not add an archive or planning veto.

## REMOVED Requirements

### Requirement: CI replay accepts bootstrap planning-tree repair revisions

**Reason**: The old acceptance scenarios contradict the current-schema parent validation in production CI replay.
**Migration**: Use the current completeness requirement below. Preserve the independent deletion-only allowance for noncanonical noise.

### Requirement: Single Integration Bootstrap Exception

**Reason**: This was a one-time historical integration allowance. The current-only engine has no change-ID exception or verifier for `integrate-openspec-with-workflow`; current lifecycle tests reject its historical task artifact map without upgrading private state. Re-advertising the consumed bootstrap path would promise a retired runtime capability.
**Migration**: Keep the original integration contract in `9c63c49`. The current planning authorization, governing-generation and immutable evidence requirements apply; this removal does not alter any current Grant authority.

## ADDED Requirements

### Requirement: Current Planning Replay Requires Complete Parent and Result Trees
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Current-schema CI planning replay SHALL require complete canonical planning artifacts in an existing revision's parent and result trees. Adding an artifact in the result SHALL NOT retroactively make an incomplete current-schema parent valid. The existing deletion-only allowance for noncanonical planning noise SHALL remain available when current required artifacts are otherwise valid.

#### Scenario: Adding an artifact does not repair the historical parent
covers: #Requirement: Current Planning Replay Requires Complete Parent and Result Trees
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI rejects a current-schema parent missing a required artifact even when the revision repairs it

- **WHEN** a revision adds `execution.json` that was absent from its current-schema parent
- **THEN** replay rejects the incomplete parent rather than accepting a bootstrap exception

#### Scenario: An unrepaired parent remains invalid
covers: #Requirement: Current Planning Replay Requires Complete Parent and Result Trees
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI still rejects a revision whose before tree stays incomplete

- **WHEN** required parent artifacts remain absent across a revision
- **THEN** replay reports the missing artifact

#### Scenario: An incomplete resulting tree is rejected
covers: #Requirement: Current Planning Replay Requires Complete Parent and Result Trees
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI rejects an incomplete planning tree and a non-canonical plan message

- **WHEN** a planning commit lacks a required resulting artifact
- **THEN** replay rejects the incomplete planning tree

#### Scenario: Removing noise preserves a complete planning revision
covers: #Requirement: Current Planning Replay Requires Complete Parent and Result Trees
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI accepts a revision that deletes non-canonical planning noise

- **WHEN** a valid current revision removes a noncanonical file inside its own planning tree
- **THEN** the existing deletion-only allowance accepts that removal
- **AND** required planning artifacts still satisfy their current contracts
