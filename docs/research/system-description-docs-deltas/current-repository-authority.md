# Current repository authority — baseline reconciliation delta

Date: 2026-09-08. Phase C step 11 reconciles three repository-governance requirements against the existing canonical trailer grammar, current CI authority verifier and separately reported release gates. The original requirements remain in migration commit `9c63c49`. This delta changes documentation only. It neither enables Central Apply in CI nor establishes remote controls, real human signing or pilot completion. Current authority-module reconciliation `40b891b` remains complementary.

## REMOVED Requirements

### Requirement: Authority maintenance is a fourth managed commit kind

**Reason**: The public grammar also recognizes route, amend-plan, authority-candidate and Central Apply forms. Parsing a retired authority-maintenance form does not admit it to current CI. A complete four-kind list and the old Grant trailer therefore misdescribe current behavior.
**Migration**: Use Managed Commit Kinds Follow the Canonical Grammar below. Keep historical parsing and its original evidence in Git; do not restore retired execution authority.

### Requirement: Authority audit prerequisites remain maintainer-owned

**Reason**: The old blanket bootstrap-only status conflates implementation, exact authority replay, remote configuration and operational readiness. Current release evidence records those readiness limits separately and does not infer that a real pilot or remote ceremony happened.
**Migration**: Use Authority Readiness Distinguishes Local and External Evidence below. Maintainers still provide evidence of controls and ceremonies that repository files alone cannot prove.

## MODIFIED Requirements

### Requirement: Authority verification is base-owned
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The required workflow-assurance job SHALL execute verification code from the exact pull-request base. Current authority-candidate verification SHALL load signer and policy authority from the candidate's exact parent and verify its portable application receipt, Grant and committed candidate bindings. Candidate-controlled verifier code, runtime reports or newly introduced signers MUST NOT supply the authority needed to approve that candidate. Protected-base history SHALL retain verifiable signed originals and exact attestation mappings for rebased authority candidates. Required checks SHALL remain bound to the governing committed evidence; recognizing an authority candidate SHALL NOT itself waive those checks.

#### Scenario: Candidate modifies its verifier
covers: #Requirement: Authority verification is base-owned
test: packages/workflow-engine/test/ci.integration.test.ts#workflow assurance CI is read-only and policy paths have owners

- **WHEN** workflow-assurance checks a pull request whose candidate may alter verification code
- **THEN** its job invokes the CLI from the exact base checkout and imports protected authority tags from that checkout
- **AND** the candidate's verifier and tag namespace do not replace that selection

#### Scenario: Candidate-only signing authority is rejected
covers: #Requirement: Authority verification is base-owned
test: packages/workflow-engine/test/git-authority-candidate-apply.integration.test.ts#production SSH proof rejects a signer added only by the candidate result

- **WHEN** an authority proof uses a signer introduced only by the candidate result
- **THEN** verification uses the exact base policy and rejects that candidate-only authority

#### Scenario: All normal checks remain required
covers: #Requirement: Authority verification is base-owned
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#approve-and-apply checks before signing and atomically consumes the exact grant

- **WHEN** the current V2 candidate path prepares and applies a checked authority candidate
- **THEN** required checks finish before signing and application
- **AND** retained check evidence binds the exact source tree, base commit and runner definitions

#### Scenario: Historical main authority is replayed
covers: #Requirement: Authority verification is base-owned
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#maintainer attestation accepts the current signed v2 authority grant

- **WHEN** a current signed V2 candidate has a protected-main derivative and a retained signed attestation
- **THEN** base-history verification resolves the exact signed original, main commit and original-to-main base mapping
- **AND** successful local replay identifies those commits without claiming a real remote ceremony occurred

#### Scenario: Candidate supplies missing history evidence
covers: #Requirement: Authority verification is base-owned
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** a clone evaluates an authority candidate whose application receipt is missing, altered, replayed or signed by a signer absent from the parent authority
- **THEN** current CI authority verification rejects that evidence
- **AND** private runtime state is not a substitute for the exact portable Git receipt

## ADDED Requirements

### Requirement: Managed Commit Kinds Follow the Canonical Grammar
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Repository governance SHALL use the public canonical managed-trailer grammar to distinguish task, plan, amend-plan, archive, route, authority-candidate and Central Apply forms, while retaining historical authority-maintenance parsing. Current CI authority admission SHALL accept only the current authority-candidate path with valid portable application evidence. Parsing a managed form MUST NOT by itself authorize replay. Existing task, planning and archive evidence obligations SHALL remain effective.

#### Scenario: Canonical grammar distinguishes the landed forms
covers: #Requirement: Managed Commit Kinds Follow the Canonical Grammar
test: packages/core/test/managed-transition-trailers.contract.test.ts#managed transition trailer grammar preserves every landed transition form

- **WHEN** the public parser receives a canonical managed transition block
- **THEN** it returns that exact transition kind and its corresponding provenance fields
- **AND** an authority-candidate uses its own canonical Change and Transition fields rather than a fabricated legacy Grant trailer

#### Scenario: Retired authority parsing does not authorize current CI
covers: #Requirement: Managed Commit Kinds Follow the Canonical Grammar
test: packages/workflow-engine/test/maintainer-grant-v2.contract.test.ts#CI rejects the retired V1 authority commit branch before reading Git state

- **WHEN** current CI authority validation receives the historical authority-maintenance form
- **THEN** it rejects the retired branch before consulting repository state

#### Scenario: Central Apply parsing does not imply CI cutover
covers: #Requirement: Managed Commit Kinds Follow the Canonical Grammar
test: packages/workflow-engine/test/managed-trailers.contract.test.ts#CI parses the exact Central Apply block and rejects pre-cutover replay

- **WHEN** a canonical git.authority-candidate.apply.v1 commit reaches the current CI sequence replay
- **THEN** the grammar preserves its exact candidate, challenge, operation, approval-subject and prepared-Grant bindings
- **AND** sequence replay reports CI_AUTHORITY_COMMIT_INVALID because this CI path does not yet admit Central Apply receipts

#### Scenario: A current signed candidate replays from portable evidence
covers: #Requirement: Managed Commit Kinds Follow the Canonical Grammar
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** a clone contains an applied authority-candidate and its valid signed application receipt
- **THEN** current CI recognizes the exact candidate and Grant from committed evidence

#### Scenario: Ordinary task replay continues to recompute its evidence
covers: #Requirement: Managed Commit Kinds Follow the Canonical Grammar
test: packages/workflow-engine/test/ci.integration.test.ts#CI recomputes task, scope, trailers, and checks without runtime reports

- **WHEN** current CI validates an ordinary managed task commit
- **THEN** it recomputes the exact task transition, scope, trailers and registered checks
- **AND** caller-created runtime reports do not authorize that transition

### Requirement: Authority Readiness Distinguishes Local and External Evidence
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Repository documentation and release evidence SHALL distinguish checked-in verification from maintainer-provided evidence of remote tag protection, protected-environment approvals, required-check configuration, real human-present signing and administrator recovery. A local fixture, successful attestation replay or reproducible package MUST NOT claim those external controls or ceremonies were performed. Operational readiness SHALL retain separate implementation, independent-review, signed-provenance, real-pilot, full-gate and publication statuses. Missing evidence SHALL remain explicitly pending rather than being inferred from another successful check.

#### Scenario: Local implementation readiness preserves pending operational gates
covers: #Requirement: Authority Readiness Distinguishes Local and External Evidence
test: packages/workflow-engine/test/release-v1.contract.test.ts#single-package v1 candidate binds reproducibility and stays fail closed for publish

- **WHEN** a local package candidate is reproducible and its adoption comparison succeeds
- **THEN** its operational report keeps independent review, signed provenance, real pilot and full gate separately pending where unproven
- **AND** local implementation readiness does not establish publication readiness

#### Scenario: A missing real pilot has no invented record
covers: #Requirement: Authority Readiness Distinguishes Local and External Evidence
test: packages/workflow-engine/test/release-v1.contract.test.ts#release bindings do not claim consumer pilot evidence while the real pilot is pending

- **WHEN** release bindings have no completed real consumer pilot
- **THEN** they do not cite a fabricated availability-pilot record

#### Scenario: Edited completion claims do not become evidence
covers: #Requirement: Authority Readiness Distinguishes Local and External Evidence
test: packages/workflow-engine/test/release-v1.contract.test.ts#release verifier rejects independently tampered source, adoption, and supply-chain facts

- **WHEN** a local release or adoption report is edited to mark an unproven real pilot complete
- **THEN** verification rejects the modified claim
- **AND** the report cannot substitute for the missing external evidence
