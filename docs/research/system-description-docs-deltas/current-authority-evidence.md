# Current authority evidence — baseline reconciliation delta

Date: 2026-09-09. The original requirements and scenario wording remain in raw migration commit `9c63c49` (A migration `de18d10`). This delta records observed current behavior under the plan's authorized baseline reconciliation. It changes no runtime policy and restores no retired API.

The original signer-rotation scenario described a sealing operation with an old-key cross-signing exception. Current replay verifies historical signed evidence against the selected base trust; it does not implement that standalone sealing ceremony. The original grant default was at most 30 minutes and rejected every untracked path. Current V2 issuance defaults to seven days with one use, and its manifest permits profile-authorized evidence additions. The original check-registry scenarios described authority edits flowing directly into CI. Current V2 Apply classifies those edits as control-plane, while the Central Apply CI receipt cutover remains incomplete. The retained historical verifier's definition-supersession branch does not establish that the current ordinary issuer admits those edits.

## REMOVED Requirements

### Requirement: Base-owned historical replay gates sealing

**Reason**: Replayable history, remote readiness and a signer-rotation sealing ceremony were combined into one requirement. The current implementation verifies retained originals and attestation mappings, but it does not execute the stated sealing ceremony or cross-signing exception.
**Migration**: Use Historical Authority Replay Retains Required Trust below. Preserve the original four scenarios in the dated baseline; repository readiness remains separately evidenced.

### Requirement: Canonical single-purpose grant

**Reason**: The 30-minute default and unconditional untracked-path rejection describe retired grant behavior. V2 signs an exact candidate and profile manifest, defaults to seven days and permits explicitly eligible evidence additions.
**Migration**: Use V2 Grants Bind One Exact Profile Candidate below. The previous Default grant bounds are narrow, Altered authorization is rejected and Unsafe grant path is rejected scenarios remain in the dated baseline.

### Requirement: Authority commits carry check-definition transitions

**Reason**: The current ordinary V2 issuer rejects check-registry edits before checks and signing. The existing Central Apply operation and its not-yet-admitted CI receipt path must not be described as a completed ordinary authority-to-CI transition.
**Migration**: Use Check Registry Changes Preserve Current Authority Boundaries below. Retain the original required-definition, unused-definition, later-activation and definition-drift scenarios as historical requirements. Current activation and drift behavior remain explicit in the replacement.

## ADDED Requirements

### Requirement: Historical Authority Replay Retains Required Trust
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The base-history verifier SHALL scan first-parent authority transitions and accept either a directly valid current signed candidate or an exact protected attestation mapping to its retained original. It SHALL verify the required Grant tags, signatures, candidate bindings and original-to-main base mappings. Missing or untrusted historical evidence MUST fail replay. Successful local replay MUST NOT claim remote protection, a real human ceremony or operational sealing readiness.

#### Scenario: A retained signed candidate replays directly
covers: #Requirement: Historical Authority Replay Retains Required Trust
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** a clone contains the retained signed candidate and its valid portable application evidence
- **THEN** base-history verification reports that direct authority without requiring a rebase attestation

#### Scenario: A rebased candidate retains its exact lineage
covers: #Requirement: Historical Authority Replay Retains Required Trust
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#maintainer attestation accepts the current signed v2 authority grant

- **WHEN** the signed original has a protected-main derivative and a valid exact attestation
- **THEN** replay reports the original and main commits and verifies the explicit original-base to main-base mapping

#### Scenario: Missing portable evidence prevents replay
covers: #Requirement: Historical Authority Replay Retains Required Trust
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** the required application receipt is missing, altered or signed outside the governing trust
- **THEN** current authority replay rejects that evidence instead of trusting private runtime reports

#### Scenario: Removing historical signer trust invalidates replay
covers: #Requirement: Historical Authority Replay Retains Required Trust
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#maintainer attestation accepts the current signed v2 authority grant

- **WHEN** the selected replay base no longer trusts the signer of a required historical Grant
- **THEN** base-history verification rejects the historical Grant evidence
- **AND** a valid earlier attestation does not restore the missing signer trust

### Requirement: V2 Grants Bind One Exact Profile Candidate
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

A current V2 Apply Grant SHALL bind the canonical exact candidate, manifest, profile, checks, repository, trusted base, signer, reason and signed lifetime. Its default lifetime SHALL be seven days and its use count SHALL be one. Profile-authorized evidence additions SHALL retain exact before-and-after file identity; an untracked file MUST NOT be accepted merely because it is called evidence. Manifest validation SHALL reject ambiguous path identities and paths outside the governing profile or within its forbidden roots.

#### Scenario: Default V2 issuance has one use and a seven-day lifetime
covers: #Requirement: V2 Grants Bind One Exact Profile Candidate
test: packages/workflow-engine/test/maintainer-grant-v2.contract.test.ts#v2 issue signs every binding and stores a canonical one-shot grant

- **WHEN** the current V2 issuer receives a complete exact candidate without a TTL override
- **THEN** the signed payload has version 2, maxUses 1 and an expiry exactly seven days after issuance
- **AND** the canonical envelope binds its manifest, patch, evidence overlay and required checks

#### Scenario: Altered canonical candidate bindings are rejected
covers: #Requirement: V2 Grants Bind One Exact Profile Candidate
test: packages/workflow-engine/test/maintainer-grant-v2.contract.test.ts#v2 issue signs every binding and stores a canonical one-shot grant

- **WHEN** a stored V2 envelope loses its signature namespace or its patch digest is changed independently of the bound candidate
- **THEN** parsing rejects the altered authorization

#### Scenario: Evidence additions require explicit profile permission
covers: #Requirement: V2 Grants Bind One Exact Profile Candidate
test: packages/workflow-engine/test/maintainer-manifest.contract.test.ts#manifest rejects untracked evidence additions unless the profile allows them

- **WHEN** a candidate includes a new evidence file
- **THEN** a profile that forbids evidence additions rejects it
- **AND** a profile that permits the addition records its add operation with no fabricated before blob

#### Scenario: Ambiguous file identities cannot enter the manifest
covers: #Requirement: V2 Grants Bind One Exact Profile Candidate
test: packages/workflow-engine/test/maintainer-manifest.contract.test.ts#manifest rejects Unicode-normalization and case-folding path aliases

- **WHEN** manifest paths contain noncanonical Unicode or case-folding aliases
- **THEN** manifest validation rejects the ambiguous file identities

#### Scenario: Profile boundaries constrain the exact file set
covers: #Requirement: V2 Grants Bind One Exact Profile Candidate
test: packages/workflow-engine/test/maintainer-manifest.contract.test.ts#manifest rejects paths outside profile roots and forbidden paths

- **WHEN** a candidate path falls outside the profile roots or matches a forbidden path
- **THEN** manifest construction rejects that candidate

### Requirement: Check Registry Changes Preserve Current Authority Boundaries
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Current ordinary V2 Apply SHALL classify edits to `workflow/checks.json` as control-plane and refuse them before executing checks, signing a Grant or publishing a commit. This V2 route classification MUST NOT be represented as a second veto on an exact accepted Central Grant. CI SHALL retain its current Central Apply receipt admission boundary explicitly. A validated planning transition MAY activate an already registered check, and task evidence SHALL use the committed registered definition. Ordinary required-check definition drift MUST fail at check time and in CI replay.

#### Scenario: Required-definition edits do not enter ordinary V2 Apply
covers: #Requirement: Check Registry Changes Preserve Current Authority Boundaries
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#V2 ordinary Apply refuses required and unused check-registry edits before checks or signing

- **WHEN** a V2 candidate changes the command of a required registered check
- **THEN** preflight classifies it as control-plane and ordinary Apply reports MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED
- **AND** no check, Grant signature or ref update is performed

#### Scenario: An unused definition does not bypass the route boundary
covers: #Requirement: Check Registry Changes Preserve Current Authority Boundaries
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#V2 ordinary Apply refuses required and unused check-registry edits before checks or signing

- **WHEN** a V2 candidate only adds an unused registered definition alongside its ordinary patch
- **THEN** ordinary Apply preserves the same control-plane refusal
- **AND** the added check is not executed or reported as successful evidence

#### Scenario: Later planning activates an existing registered definition
covers: #Requirement: Check Registry Changes Preserve Current Authority Boundaries
test: packages/workflow-engine/test/ci.integration.test.ts#registered format and asset definitions activate in planning and replay from committed evidence

- **WHEN** a validated later plan adds existing workflow-format and openspec-assets IDs to an incomplete task's required checks
- **THEN** historical authority resolves their committed definitions
- **AND** CI executes and reports those required IDs without executing other unused registry entries

#### Scenario: Ordinary definition drift fails independent replay
covers: #Requirement: Check Registry Changes Preserve Current Authority Boundaries
test: packages/workflow-engine/test/ci.integration.test.ts#ordinary required-check edits fail at check time and CI replay

- **WHEN** an ordinary task changes its required check definition even though the registry file is in its allowed path scope
- **THEN** check time rejects changed pinned artifacts
- **AND** independent CI reports CI_CHECK_DEFINITION_CHANGED for the committed drift

#### Scenario: Central Apply grammar does not claim the CI cutover is complete
covers: #Requirement: Check Registry Changes Preserve Current Authority Boundaries
test: packages/workflow-engine/test/managed-trailers.contract.test.ts#CI parses the exact Central Apply block and rejects pre-cutover replay

- **WHEN** the current CI sequence receives a canonical Central Apply commit
- **THEN** parsing retains the exact authority bindings but replay reports CI_AUTHORITY_COMMIT_INVALID
- **AND** successful parsing is not reported as successful CI admission
