# Current task evidence — baseline reconciliation delta

Date: 2026-09-08. Phase C step 11 reconciles the preserved bootstrap-era contract with the already-delivered current-v3 archive path. This dated delta does not introduce a runtime exemption or change archive behavior. The original block remains in the independently recorded canonical migration commit.

## MODIFIED Requirements

### Requirement: Archive evidence honors the canonical-evidence epoch
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Archive eligibility and CI archive replay SHALL require exactly one canonical workflow commit for every completed task in the current task execution generation. A completion that predates the earliest canonical plan commit MUST NOT substitute for current task evidence. The engine SHALL preserve canonical recording and configured-base reachability verification for every accepted task commit.

#### Scenario: Bootstrap-era completions still need current evidence
covers: #Requirement: Archive evidence honors the canonical-evidence epoch
test: packages/workflow-engine/test/archive-eligibility.integration.test.ts#archive eligibility rejects pre-epoch task completions without current evidence

- **WHEN** a task was marked complete before a canonical plan revision but has no canonical workflow commit in the current task execution generation
- **THEN** live archive eligibility reports missing task evidence
- **AND** the historical completion does not create an exemption

#### Scenario: Canonical-era completions stay enforced
covers: #Requirement: Archive evidence honors the canonical-evidence epoch
test: packages/workflow-engine/test/archive-eligibility.integration.test.ts#archive eligibility keeps canonical-era completions enforced

- **WHEN** a task was marked complete after a canonical plan revision without a canonical workflow commit
- **THEN** archive eligibility reports missing task evidence

#### Scenario: Replay also requires current evidence for historical completions
covers: #Requirement: Archive evidence honors the canonical-evidence epoch
test: packages/workflow-engine/test/ci-archive.integration.test.ts#current archive rejects pre-epoch task completions without current evidence

- **WHEN** CI replays an archive containing pre-epoch task completion without current canonical task evidence
- **THEN** replay rejects the archive instead of deriving a historical exempt set
