# Hosting prerequisites retained for external verification

Date: 2026-09-08. These are the unmodified hosting requirements from the initial canonical migration (`9c63c49`). They remain requirements for an owner performing hosted setup; this implementation task did not configure GitHub, verify owner eligibility, activate rules, publish a pull request or run a pilot. Local test passes cannot establish those external facts.

The system-description baseline now describes the implemented authenticated ruleset observation and explicit pending remote state. It does not advertise an automatic CODEOWNERS eligibility checker, maintainer-count configurator or ruleset activation procedure that the current engine does not provide. Retaining the external requirements here does not mark them satisfied or authorize a weaker hosted configuration.

## Original external prerequisites

### Requirement: Valid Repository Code Ownership
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Every CODEOWNER assigned to a protected repository path SHALL resolve to an
existing GitHub user or team with explicit write access to the repository. The
repository MUST retain an ownership rule for the CODEOWNERS file itself.

#### Scenario: Configured owner is eligible
covers: #Requirement: Valid Repository Code Ownership

- **GIVEN** the repository ownership file assigns a protected path to an owner
- **WHEN** GitHub validates the CODEOWNERS file on the default branch
- **THEN** the owner resolves without a CODEOWNERS diagnostic
- **AND** the owner has explicit write access to the repository

#### Scenario: Configured owner is unknown or ineligible
covers: #Requirement: Valid Repository Code Ownership

- **GIVEN** an ownership entry names a missing user, hidden team, or identity
  without explicit write access
- **WHEN** repository governance is reviewed for activation
- **THEN** remote enforcement remains inactive
- **AND** the invalid ownership entry is corrected through a managed change

### Requirement: Maintainer-Aware Pull Request Enforcement
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The protected default branch SHALL require pull requests, the strict
`workflow-assurance` status check against an up-to-date base, and no bypass.
Code-owner approval with stale-review dismissal SHALL additionally be required
only when at least two independent eligible human maintainers exist.

#### Scenario: Repository has one eligible human maintainer
covers: #Requirement: Maintainer-Aware Pull Request Enforcement

- **GIVEN** the pull-request author is the repository's only eligible human
  maintainer
- **WHEN** protected-branch rules are configured
- **THEN** zero approving reviews are required
- **AND** code-owner review and stale-review dismissal are disabled
- **AND** pull-request, strict status-check, current-base, and no-bypass rules
  remain enforced

#### Scenario: Repository has an independent eligible reviewer
covers: #Requirement: Maintainer-Aware Pull Request Enforcement

- **GIVEN** at least two independent eligible human maintainers exist
- **WHEN** protected-branch rules are configured
- **THEN** a code-owner approval from an eligible human other than the author
  is required
- **AND** new reviewable pushes dismiss stale approval

### Requirement: Staged Governance Activation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Remote merge enforcement SHALL be activated only after a valid
CODEOWNERS file is present on the default branch and GitHub reports no
CODEOWNERS diagnostics. Activation evidence MUST include the effective ruleset
state and a pull request whose required `workflow-assurance` check is enforced.

#### Scenario: Valid ownership reaches the base
covers: #Requirement: Staged Governance Activation

- **GIVEN** the valid ownership configuration has merged into the default branch
- **AND** GitHub reports no CODEOWNERS errors for that branch
- **WHEN** the maintainer activates the repository ruleset
- **THEN** the configured solo- or multi-maintainer review policy becomes
  effective
- **AND** an archive pull request proves the required status check before
  workflow support is declared
