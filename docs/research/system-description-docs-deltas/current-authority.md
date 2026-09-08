# Current authority — baseline reconciliation delta

Date: 2026-09-08. The raw requirements remain in migration commit `9c63c49`. Four retired procedures are replaced with the current candidate, portable receipt, Central Grant and release-readiness behavior. The public authority-session commands and `authority-maintenance` transition no longer authorize work; the V2 profile's policy limits are not a second veto after Central Grant accepts exact observations. No runtime policy changes here. No pilot was run, and local fixture verification does not establish real human or remote pilot completion.

## REMOVED Requirements

### Requirement: Isolated authority session

**Reason**: The current CLI removes `authority-start`, `authority-check` and `authority-commit`; current preparation and Apply operate on exact candidate evidence.
**Migration**: Use Current Authority Uses Exact Candidate Apply below. Retain the original procedure in Git history.

### Requirement: Exact authority commit isolation

**Reason**: Current signed candidates use the `authority-candidate` form and portable application receipts. A path's product or document category alone does not invalidate an exact authorized candidate.
**Migration**: Use Exact Authority Candidates Carry Portable Evidence below; existing attestation requirements still cover protected-main rebase identity.

### Requirement: Bootstrap and sealed trust phases

**Reason**: An unconditional rollback prohibition contradicts the existing Central Grant Apply path. Profile restrictions and grantable observed facts have distinct roles.
**Migration**: Use Policy Transitions Preserve Observations and Exact Grant Authority below; retain current historical replay and signer-lineage requirements.

### Requirement: Real Bootstrap Pilot Evidence

**Reason**: The old scenario sequence assumes retired authority-session commands and a particular live pilot. Current release verification explicitly preserves pending pilot status and rejects fabricated completion claims.
**Migration**: Use Local Verification Does Not Claim Real Pilot Evidence below. Retain the dated procedure as historical intent; do not reinterpret local tests as evidence that it happened.

## ADDED Requirements

### Requirement: Current Authority Uses Exact Candidate Apply
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The engine SHALL prepare and apply current authority through exact candidate bindings, required check evidence and recoverable Grant consumption. Public legacy authority-session commands MUST NOT authorize new work. Preparation SHALL derive its scope and checks from the selected trust base without modifying the working tree.

#### Scenario: Retired authority commands are absent
covers: #Requirement: Current Authority Uses Exact Candidate Apply
test: packages/workflow-engine/test/human-grant-cli.contract.test.ts#current CLI exposes no legacy authority or human-resolution entrypoints

- **WHEN** the current CLI is asked to run `authority-start`, `authority-check` or `authority-commit`
- **THEN** it reports invalid usage instead of opening a legacy authority session

#### Scenario: Preflight derives exact scope without writing
covers: #Requirement: Current Authority Uses Exact Candidate Apply
test: packages/workflow-engine/test/maintainer-grant-v2-preapproval.contract.test.ts#v2 preflight is read-only and derives exact overlay and checks from the trust base

- **WHEN** current V2 preflight inspects a candidate and capability profile
- **THEN** it reports the exact manifest, evidence overlay, checks and trust-base identity
- **AND** the repository's working state remains unchanged

#### Scenario: Apply checks precede signing and consumption
covers: #Requirement: Current Authority Uses Exact Candidate Apply
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#approve-and-apply checks before signing and atomically consumes the exact grant

- **WHEN** a current candidate is approved and applied
- **THEN** required checks finish before candidate and Grant signing
- **AND** the branch reaches the exact candidate commit with a consumed Grant and bound application receipt

#### Scenario: Interrupted consumption resumes the same application
covers: #Requirement: Current Authority Uses Exact Candidate Apply
test: packages/workflow-engine/test/maintainer-grant-v2-recovery.contract.test.ts#transient consume failure resumes completion without applying twice

- **WHEN** consumption temporarily fails after the exact candidate was applied
- **THEN** recovery completes the same application without a second commit or another use

### Requirement: Exact Authority Candidates Carry Portable Evidence
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Current signed V2 authority candidates SHALL use the canonical `authority-candidate` transition and retain an exact portable application receipt. CI replay SHALL verify the receipt, Grant, candidate and trusted signer bindings from Git evidence. An approved candidate MUST NOT silently adopt later path, tree or check drift. A protected-main derivative SHALL satisfy the existing exact attestation identity rules.

#### Scenario: A fresh clone verifies the signed candidate
covers: #Requirement: Exact Authority Candidates Carry Portable Evidence
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** a fresh clone contains a signed candidate and its portable Git receipts
- **THEN** replay recognizes the `authority-candidate` transition and exact Grant
- **AND** missing, altered or untrusted application receipts are rejected

#### Scenario: Forged observations and later drift do not become the approved candidate
covers: #Requirement: Exact Authority Candidates Carry Portable Evidence
test: packages/workflow-engine/test/git-authority-candidate-apply.integration.test.ts#forged check observations and post-challenge Git drift fail closed without an Apply journal or Git publication

- **WHEN** supplied check observations are forged or Git state changes after the candidate challenge
- **THEN** Apply does not publish an altered candidate under the original authorization

#### Scenario: Attestation preserves a rebased candidate's exact identity
covers: #Requirement: Exact Authority Candidates Carry Portable Evidence
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#maintainer attestation accepts the current signed v2 authority grant

- **WHEN** a current signed V2 candidate is mapped to its protected-main derivative
- **THEN** the original Grant and exact tree, parent, message and retained attestation bindings remain verifiable

### Requirement: Policy Transitions Preserve Observations and Exact Grant Authority
sources: [SRC-5a56b9d773c073a429dfbc7d271fdd00d18d873752bb86ca0540662433bfb1ba, SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The engine SHALL preserve observed policy changes as candidate facts. Current V2 profile validation SHALL retain its configured identity, sealed-phase, immutable-path and required-check limits. Central Grant MAY authorize the exact observed rollback or removal through its existing Apply operation; the engine MUST NOT impose those profile limits as a second veto after accepting that Grant. Candidate changes SHALL NOT supply their own base authority.

#### Scenario: V2 profile validation retains its transition limits
covers: #Requirement: Policy Transitions Preserve Observations and Exact Grant Authority
test: packages/workflow-engine/test/maintainer-grant-v2-preapproval.contract.test.ts#current V2 CI refuses stable identity and sealed trust rollback

- **WHEN** current V2 profile validation evaluates a repository identity mutation, sealed rollback, immutable-path removal or required-check removal
- **THEN** the profile transition is rejected under its existing policy

#### Scenario: Central Grant authorizes exact policy observations
covers: #Requirement: Policy Transitions Preserve Observations and Exact Grant Authority
test: packages/workflow-engine/test/git-authority-candidate-apply.integration.test.ts#Central Grant applies sealed rollback, immutable-path removal, and required-check removal as exact facts

- **WHEN** Central Grant accepts an exact candidate containing a recorded sealed rollback, immutable-path removal or required-check removal
- **THEN** Apply completes the authorized candidate and retains the observations
- **AND** the observed exception is not represented as an unchanged policy

#### Scenario: Candidate signer additions do not authorize themselves
covers: #Requirement: Policy Transitions Preserve Observations and Exact Grant Authority
test: packages/workflow-engine/test/git-authority-candidate-apply.integration.test.ts#production SSH proof rejects a signer added only by the candidate result

- **WHEN** an Apply proof uses a signer introduced only by the candidate result
- **THEN** verification uses the exact base policy and rejects the candidate-only authority

### Requirement: Local Verification Does Not Claim Real Pilot Evidence
sources: [SRC-5a56b9d773c073a429dfbc7d271fdd00d18d873752bb86ca0540662433bfb1ba, SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Release and adoption evidence SHALL distinguish local implementation verification from real maintainer and remote pilot completion. A locally reproducible package or passing fixture suite MUST NOT turn pending real-pilot evidence into a completed fact. The current release verifier SHALL reject tampered pilot-completion claims. Skipping a pilot SHALL leave its evidence explicitly pending.

#### Scenario: Release bindings do not invent a consumer pilot record
covers: #Requirement: Local Verification Does Not Claim Real Pilot Evidence
test: packages/workflow-engine/test/release-v1.contract.test.ts#release bindings do not claim consumer pilot evidence while the real pilot is pending

- **WHEN** current release bindings have no real consumer pilot evidence
- **THEN** they do not cite a fabricated provider availability pilot record

#### Scenario: Reproducibility retains pending pilot readiness
covers: #Requirement: Local Verification Does Not Claim Real Pilot Evidence
test: packages/workflow-engine/test/release-v1.contract.test.ts#single-package v1 candidate binds reproducibility and stays fail closed for publish

- **WHEN** local package preparation and source-versus-installed comparison succeed
- **THEN** the candidate still records `real-pilot-pending`
- **AND** local implementation readiness alone does not become publication readiness

#### Scenario: Altered pilot completion claims are rejected
covers: #Requirement: Local Verification Does Not Claim Real Pilot Evidence
test: packages/workflow-engine/test/release-v1.contract.test.ts#release verifier rejects independently tampered source, adoption, and supply-chain facts

- **WHEN** a release candidate or adoption report is edited to claim that the real pilot completed
- **THEN** verification rejects the altered claim instead of manufacturing pilot evidence
