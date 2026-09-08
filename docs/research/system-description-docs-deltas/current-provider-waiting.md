# Current provider waiting — baseline reconciliation delta

Date: 2026-09-09. The original requirement remains in raw migration commit `9c63c49` (A migration `de18d10`). Current scheduling distinguishes an unavailable eligible assignment (`collaboration-grant-required`) from an already prepared invocation awaiting its provider (`waiting-for-provider`). The original blanket waiting-state assertion is replaced below; the original requirement to preserve current evidence remains effective. This delta neither lowers requested independence nor changes runtime behavior.

## REMOVED Requirements

### Requirement: Provider Shortage Pauses Without Partial Transition

**Reason**: The ordinary role scheduler does not return `waiting-for-provider` when no eligible independent candidate exists. It requests exact collaboration authority. Prepared provider invocations have their own durable waiting and retry states.
**Migration**: Use Provider Assignment and Waiting Preserve Current Evidence below. Preserve Required alternate provider is unavailable and Alternate provider later becomes available in the dated baseline rather than claiming their old state names are current.

## ADDED Requirements

### Requirement: Provider Assignment and Waiting Preserve Current Evidence
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5cdc4849e2c39d2af2dce4a96fd95b92fac190f87813f6ac59779ece7ab8aafb]

Provider assignment SHALL satisfy the requested independence. When no eligible candidate exists, ordinary scheduling SHALL report `collaboration-grant-required` without silently assigning a conflicting provider. A later eligible assignment SHALL remain bound to the same target and requested independence. Prepared invocations and lifecycle operations waiting on them SHALL preserve durable current evidence. Waiting or retrying transport alone MUST NOT recreate a semantic subject or rerun already-current checks.

#### Scenario: Explicit provider independence has no eligible alternate
covers: #Requirement: Provider Assignment and Waiting Preserve Current Evidence
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#ordinary role scheduling uses fresh sessions and preserves explicit provider diversity

- **WHEN** provider-independent review is requested and only the author's provider is available
- **THEN** scheduling reports collaboration-grant-required with NO_REQUIRED_INDEPENDENCE_CANDIDATE
- **AND** it does not return a weaker assignment

#### Scenario: The eligible alternate becomes available
covers: #Requirement: Provider Assignment and Waiting Preserve Current Evidence
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#ordinary role scheduling uses fresh sessions and preserves explicit provider diversity

- **WHEN** the alternate becomes available for the same target and provider-independent request
- **THEN** scheduling assigns that alternate with the original target digest and required independence

#### Scenario: A waiting review resumes without repeating current checks
covers: #Requirement: Provider Assignment and Waiting Preserve Current Evidence
test: packages/workflow-engine/test/task-diff-review-provider-lifecycle.integration.test.ts#finalize pauses before staging for a required review and resumes without rerunning checks after the exact result is adopted

- **WHEN** finalize has durable passing checks and waits for its exact required provider review
- **THEN** staging remains unapplied during the wait
- **AND** adopting the exact provider result resumes finalize while the check execution count remains one

#### Scenario: A transport retry retains the durable semantic subject
covers: #Requirement: Provider Assignment and Waiting Preserve Current Evidence
test: packages/workflow-engine/test/task-strategy-provider-retry.integration.test.ts#routine resume replaces a failed implementation transport without changing its semantic subject

- **WHEN** implementation transport fails and the workflow resumes from the current durable state
- **THEN** the replacement invocation retains the input manifest, target digest and owner investigation
- **AND** only transport identity and nonce change before the exact result is adopted
