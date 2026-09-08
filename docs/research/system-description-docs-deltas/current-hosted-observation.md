# Hosted observation — system description boundary

Date: 2026-09-08. Three prior requirements describe owner-operated GitHub setup, eligibility and activation rather than a current engine implementation. Their exact text is retained in [the dated external prerequisites](../hosting-prerequisites-2026-09-08.md) and raw migration commit `9c63c49`. They are not declared satisfied, removed from the owner's setup responsibilities or replaced by a weaker hosted policy. The current implementation exposes authenticated ruleset observation and local preparations with an explicit pending remote state; it does not expose the claimed owner-eligibility or maintainer-count activation procedure. This delta separates that observable software behavior from unverified external operations. No pilot or hosted mutation occurs.

## REMOVED Requirements

### Requirement: Valid Repository Code Ownership

**Reason**: GitHub user/team eligibility and write access are external facts, and the current engine has no CODEOWNERS eligibility verifier. Assigning a local configuration test would falsely claim that those facts had been checked.
**Migration**: Retain the exact operator prerequisite in the dated record. Current software evidence covers only the implemented authenticated observation boundary below.

### Requirement: Maintainer-Aware Pull Request Enforcement

**Reason**: Counting eligible maintainers and configuring their review policy is a hosted setup responsibility, not a current engine operation or a fact proved by local fixtures.
**Migration**: Preserve both solo- and multi-maintainer policies verbatim in the dated external prerequisites; do not claim their activation.

### Requirement: Staged Governance Activation

**Reason**: The current engine does not activate a GitHub ruleset or prove that a real protected pull request enforced it. The requested task explicitly excludes a pilot.
**Migration**: Preserve the activation conditions verbatim in the dated record. Local preparation continues to report the remote gate as pending.

## ADDED Requirements

### Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
sources: [SRC-5a56b9d773c073a429dfbc7d271fdd00d18d873752bb86ca0540662433bfb1ba, SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The shipped GitHub archive adapter SHALL bind a hosted ruleset observation to the exact repository and protected-base commit, authenticated evidence, observation lifetime and canonical digest. Its production observer SHALL read applicable active rulesets and require the existing `workflow-assurance` check and absence of bypass actors. A disabled, expired, unauthenticated or differently bound observation MUST NOT be accepted as current evidence. These checks do not establish CODEOWNERS eligibility or activate a hosted review policy. A local archive preparation SHALL retain an explicit unobserved remote state and pending operational gate until separate remote evidence exists.

#### Scenario: The production observer derives authenticated ruleset facts
covers: #Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
test: packages/workflow-engine/test/archive-publication-adapters.integration.test.ts#production ruleset observer authenticates a current no-bypass workflow-assurance ruleset

- **WHEN** the configured observer reads active applicable rulesets through its authenticated GitHub boundary
- **THEN** its result binds the protected base, required check, zero bypass actors and bounded observation lifetime
- **AND** unavailable credentials do not produce an observation

#### Scenario: The adapter preserves the exact observer binding
covers: #Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
test: packages/github-adapter/test/archive-pull-request.test.ts#ruleset observation is injected, authenticated, exact, and current

- **WHEN** archive publication requests an observation for a protected base
- **THEN** the configured observer receives that exact repository, branch and commit
- **AND** the adapter preserves the validated observation facts

#### Scenario: Missing or invalid hosted observations remain unavailable
covers: #Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
test: packages/github-adapter/test/archive-pull-request.test.ts#ruleset observation fails closed when disabled, stale, replayed, or unauthenticated

- **WHEN** the observer is disabled or its evidence is expired, unauthenticated or bound to another base
- **THEN** the adapter rejects the observation instead of inferring hosted enforcement from repository files

#### Scenario: Local archive preparation does not imply a remote result
covers: #Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#archive-pr dry-run creates only a local canonical preparation and reports the remote gate pending

- **WHEN** the archive dry-run creates a valid local preparation
- **THEN** it reports `remoteState: not-observed` and a pending operational gate
- **AND** it makes no remote calls or claims that a hosted pull request passed
