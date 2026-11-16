# Authority
capabilities: [authority-tree-attestation, break-glass-maintainer-mode]

## Purpose

Bind maintainer authorization and retained transition evidence to the exact operation, trusted inputs, and durable recovery state.
## Requirements
### Requirement: Actor Identity Is Resolved Once and Reported Honestly
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-a0050aa57c1a5f5fd83361c1a033ffc98529ecebf92ad977e73b506ead644ae0, SRC-0af41f94cfd4d4b5de9f5532a58d6e53268916fc1e16aa631569e16895c59dc4, SRC-a56ac1533168972a6383b21bd8ed414ffe5d4360ca14a080cd854f2af5b7af70, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9, SRC-7d9b1c9e61d4f43d2c5c4be96f9ba57cff79e9833ed339aef537334a79ef11ce, SRC-581c9289ce5361d1052b0c507a331b20c6d468b861c03716cb91c7fb8ac56e87, SRC-baa079861a38b5a7932c0e0fdbcca89ca6b73b16a02fedff2084b66f7a55bf98]

At each investigation or task-session boundary, the workflow engine SHALL collect explicit actor selection and recognized runtime hints, resolve the selected actor, record all observed signals and assurance levels, and pin the result for that session. Runtime hints or explicit claims MUST NOT be represented as cryptographic provider identity.

Contradictory recognized signals MUST pause or fail actor resolution rather than being used to manufacture role independence.

#### Scenario: Runtime hint identifies the caller
covers: #Requirement: Actor Identity Is Resolved Once and Reported Honestly
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#actor resolution preserves all agreeing soft signals and their grade

- **GIVEN** no explicit actor was supplied and one recognized runtime hint identifies a provider
- **WHEN** the session opens
- **THEN** that provider is recorded as actor
- **AND** its assurance is recorded as `runtime-hint`

#### Scenario: Explicit actor is supplied without stronger proof
covers: #Requirement: Actor Identity Is Resolved Once and Reported Honestly
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#actor resolution distinguishes explicit-only, missing, and conflicts

- **GIVEN** a valid explicit actor selection with no contradictory signal
- **WHEN** the session opens
- **THEN** the provider is pinned as actor
- **AND** its assurance is no stronger than self-declared

#### Scenario: Actor signals conflict
covers: #Requirement: Actor Identity Is Resolved Once and Reported Honestly
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#actor resolution distinguishes explicit-only, missing, and conflicts

- **GIVEN** explicit selection and recognized runtime evidence name different providers
- **WHEN** actor resolution runs
- **THEN** the transition enters an actor-resolution-required outcome or fails with the conflict
- **AND** the disputed identity cannot satisfy provider-independence policy

#### Scenario: Routine transition follows session creation
covers: #Requirement: Actor Identity Is Resolved Once and Reported Honestly
test: packages/workflow-engine/test/provider-worker-native-evidence.integration.test.ts#async provider worker completes the exact durable invocation through ProviderWorkerRuntimePort on sha256

- **GIVEN** actor identity is already pinned for a session
- **WHEN** a routine sub-transition runs
- **THEN** the engine does not ask for actor identity again
- **AND** the stored actor does not change implicitly

### Requirement: Protected Base Initialization Offers a Local Grant Choice
sources: [SRC-7f4a02c3f1a74cd4fc7265248dbeffda01979e4193c30e8ff32372000f3f11f2]

An unavailable protected base SHALL offer a precise Grant choice to initialize
`refs/jigwright/protected-base` at the exact current commit. The choice SHALL
bind repository identity, source commit and tree, and the absent local ref.
Local initialization SHALL execute inside the approved Grant transaction,
verify the source HEAD and create the ref atomically, and perform no network
request or remote publication. Its completed Grant outcome SHALL retain the
actual local effect. Prepared recovery MAY confirm the exact created ref;
if a competing state prevents recovery, it SHALL preserve that state and
report any prior effect as unknown rather than claiming it never happened.

A configured canonical remote SHALL remain a separate explicit choice.
Selecting it SHALL retain exact empty-remote validation, completed-Grant
publication authority, the absent-ref lease, and publication receipts.
Requesting or choosing the local option SHALL NOT require an origin remote
or a successful remote observation.

#### Scenario: Planning can request local authority without an origin
covers: #Requirement: Protected Base Initialization Offers a Local Grant Choice
test: packages/workflow-engine/test/protected-base-initialization-grant.integration.test.ts#an unavailable protected base offers a local choice without an origin

- **GIVEN** valid repository authority and no origin or protected tracking ref
- **WHEN** planning requests protected-base initialization
- **THEN** its durable Grant exposes the local choice without changing Git refs

#### Scenario: Exact local approval creates one replayable ref
covers: #Requirement: Protected Base Initialization Offers a Local Grant Choice
test: packages/workflow-engine/test/protected-base-selection-grant.integration.test.ts#a pending local protected-base Grant has no effect and exact approval creates one replayable ref

- **GIVEN** a pending local initialization Grant
- **WHEN** Grant Core validates the selected approval and executes it
- **THEN** the exact local ref is created and the durable outcome records completion
- **AND** a pending Grant has no ref effect and completed recovery does not duplicate it

#### Scenario: Remote selection retains create-only publication
covers: #Requirement: Protected Base Initialization Offers a Local Grant Choice
test: packages/workflow-engine/test/protected-base-selection-grant.integration.test.ts#the selected remote transition retains exact create-only publication

- **WHEN** the remote choice is approved for the exact empty canonical remote
- **THEN** the existing publisher creates only the authorized remote ref and records its exact receipt
- **AND** the local protected ref remains absent and publication retry reuses its receipt

### Requirement: Canonical human-present authority attestation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL create a versioned canonical authority attestation
only from a controlling interactive terminal through a trusted human-present
SSH signer. The signed payload MUST bind the repository, protected branch,
original and protected-main authority commits, grant-base mappings, trust
material, issuance time, and signer identity.

#### Scenario: Human creates a valid attestation
covers: #Requirement: Canonical human-present authority attestation
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#maintainer attestation accepts the current signed v2 authority grant

- **WHEN** a clean fetched repository contains one valid signed original authority commit, its rebase-produced protected-main equivalent, every explicitly mapped grant base, and the required protected grant tags
- **THEN** `pnpm workflow maintainer attest` validates the complete mapping before requesting a human signature
- **AND** it creates one canonical local attestation tag and returns its exact publication command

#### Scenario: Non-interactive or unattended creation is attempted
covers: #Requirement: Canonical human-present authority attestation
test: packages/workflow-engine/test/maintainer-signer-port-boundaries.contract.test.ts#current signer admission requires every controlling terminal

- **WHEN** attestation creation lacks a controlling input or output TTY, uses an unattended signer path, or cannot verify human presence
- **THEN** the engine creates no envelope or tag

#### Scenario: Encoding is ambiguous
covers: #Requirement: Canonical human-present authority attestation
test: packages/workflow-engine/test/authority-attestation.contract.test.ts#attestation parser rejects every ambiguous or noncanonical encoding

- **WHEN** an envelope has extra or missing fields, partial object IDs, unsorted or duplicate mappings, an invalid timestamp, a wrong signature namespace, a noncanonical serialization, or an oversized value
- **THEN** parsing and verification fail closed

### Requirement: Exact authority transition identity
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

An attested original commit `O` and protected-main commit `M` MUST have equal
result trees, single parents with equal parent trees, byte-identical canonical
managed messages, the same change and grant identity, and a valid original SSH
commit signature under trusted policy.

#### Scenario: Rebase preserves the authority transition
covers: #Requirement: Exact authority transition identity
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#maintainer attestation accepts the current signed v2 authority grant

- **WHEN** `tree(O) == tree(M)`, `tree(parent(O)) == tree(parent(M))`, both messages are byte-identical canonical authority messages, `O` verifies against its exact grant and trusted signer, and `M` is on protected-main first-parent history
- **THEN** replay recognizes `M` as the unique protected-main derivative of `O`

#### Scenario: Only the result tree matches
covers: #Requirement: Exact authority transition identity
test: packages/workflow-engine/test/authority-attestation.contract.test.ts#transition pairs fail closed on every identity mismatch

- **WHEN** result trees are equal but parent trees, commit messages, change IDs, grant IDs, signatures, or single-parent shape differ
- **THEN** replay rejects the mapping as a different or ambiguous authority transition

#### Scenario: Candidate adds its own trust
covers: #Requirement: Exact authority transition identity
test: packages/workflow-engine/test/git-authority-candidate-apply.integration.test.ts#production SSH proof rejects a signer added only by the candidate result

- **WHEN** a candidate commit changes verifier code, policy, or signer material while presenting an attestation
- **THEN** verification uses only base-owned code and previously trusted signer lineage and rejects candidate-self-authorization

### Requirement: Protected retention and unique mapping
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Each accepted authority attestation MUST be retained by the exact annotated tag
`refs/tags/workflow-attestation/<grant-id>` targeting the signed original
authority commit. Each original and each protected-main authority commit SHALL
participate in at most one accepted mapping.

#### Scenario: Protected tag retains the original
covers: #Requirement: Protected retention and unique mapping
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#maintainer attestation accepts the current signed v2 authority grant

- **WHEN** the exact tag name, headers, target, canonical envelope, signature, and primary grant agree
- **THEN** the original signed commit remains reachable and replay may evaluate the mapping

#### Scenario: Evidence is missing or conflicting
covers: #Requirement: Protected retention and unique mapping
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** the tag is absent, lightweight, malformed, differently targeted, replaced, duplicated, or conflicts with another original-to-main mapping
- **THEN** replay fails closed without selecting a same-tree alternative

### Requirement: Explicit grant-base identity mapping
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Historical grant replay SHALL map a signed grant's original `baseCommit` to a
protected-main equivalent only through an explicit attested pair whose result
trees, parent trees, and canonical managed messages match and whose sorted grant
IDs all resolve to exact protected audit tags bound to that original base.

#### Scenario: Expired historical grant is replayed
covers: #Requirement: Explicit grant-base identity mapping
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** a protected grant envelope is now expired but its signature and issuance bounds are valid, its `baseCommit` equals the attested original base, and any successful authority commit occurred within the signed lifetime
- **THEN** historical replay may use the explicitly attested protected-main equivalent without treating the grant as currently usable

#### Scenario: Grant mapping is inferred or incomplete
covers: #Requirement: Explicit grant-base identity mapping
test: packages/workflow-engine/test/authority-attestation.contract.test.ts#transition pairs fail closed on every identity mismatch

- **WHEN** replay finds only a same-tree main commit, omits a grant bound to the original base, names a grant bound to another base, or observes unequal parent trees or messages
- **THEN** replay rejects the grant-base mapping

### Requirement: Human-present grant issuance
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL keep maintainer mode closed by default and SHALL
issue a grant only from a controlling interactive terminal through a trusted
SSH signer that requires human presence.

#### Scenario: Non-interactive issuance is rejected
covers: #Requirement: Human-present grant issuance
test: packages/workflow-engine/test/maintainer-signer-port-boundaries.contract.test.ts#current signer admission requires every controlling terminal

- **WHEN** grant issuance lacks a controlling input or output TTY
- **THEN** the engine rejects the request before signing or writing grant state

#### Scenario: Unattended signer is rejected
covers: #Requirement: Human-present grant issuance
test: packages/workflow-engine/test/grant-proof-ssh.contract.test.ts#production SSH approval rejects an unencrypted software key and strips non-interactive credential channels

- **WHEN** the configured software key can sign without an interactive secret or the request attempts to use an SSH agent, askpass program, environment bypass, or force option
- **THEN** the engine rejects the request and creates no grant

#### Scenario: Human-present issuance succeeds
covers: #Requirement: Human-present grant issuance
test: packages/workflow-engine/test/maintainer-grant-v2.contract.test.ts#v2 issue signs every binding and stores a canonical one-shot grant

- **WHEN** a trusted encrypted SSH key or human-presence hardware key signs a valid canonical grant from an interactive terminal
- **THEN** the engine stores one local available token and creates one signed non-secret audit envelope

### Requirement: Git-common-directory grant state
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The engine MUST keep available tokens, reservations, terminal records, and
recovery journals in the Git common directory with restrictive permissions and
atomic persistence shared by all linked worktrees.

#### Scenario: Concurrent worktrees compete for one grant
covers: #Requirement: Git-common-directory grant state
test: packages/workflow-engine/test/maintainer-grant-v2.contract.test.ts#v2 issue signs every binding and stores a canonical one-shot grant

- **WHEN** two worktrees attempt to reserve the same available grant
- **THEN** exactly one reservation succeeds and the other fails without obtaining authority

#### Scenario: Worktree contains no bearer token
covers: #Requirement: Git-common-directory grant state
test: packages/workflow-engine/test/maintainer-grant-v2.contract.test.ts#v2 issue signs every binding and stores a canonical one-shot grant

- **WHEN** a grant is issued, reserved, consumed, revoked, or recovered
- **THEN** no reusable grant or reservation token is written to or committed from the worktree

### Requirement: Protected audit envelope
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Grant issuance SHALL create an immutable namespaced Git audit tag containing
the signed non-secret envelope, and authority CI SHALL require that exact tag
and verify it against parent/base trust material. When rebase merge changes a
grant's referenced base identity, later replay MUST accept a protected-main
equivalent only through an explicit valid authority tree attestation.

#### Scenario: Missing or different audit tag is rejected
covers: #Requirement: Protected audit envelope
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** CI cannot resolve the exact grant tag or its envelope differs from the locally claimed grant
- **THEN** the authority commit fails verification

#### Scenario: Candidate key cannot validate its own envelope
covers: #Requirement: Protected audit envelope
test: packages/workflow-engine/test/git-authority-candidate-apply.integration.test.ts#production SSH proof rejects a signer added only by the candidate result

- **WHEN** a candidate branch adds or changes a signer while claiming an authority grant
- **THEN** CI verifies the envelope only with signers trusted by the authority commit parent

#### Scenario: Rebased grant base is replayed
covers: #Requirement: Protected audit envelope
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#maintainer attestation accepts the current signed v2 authority grant

- **WHEN** a historical grant tag references an original base commit that is not on protected-main history
- **THEN** replay requires an explicit attested protected-main base with equal result and parent trees, an identical canonical managed message, and the exact grant ID binding

### Requirement: Fail-closed commit recovery
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Authority commit creation and grant consumption MUST be one recoverable logical
operation with durable journal states and exact compare-and-swap ref updates.

#### Scenario: Crash occurs after commit object creation
covers: #Requirement: Fail-closed commit recovery
test: packages/workflow-engine/test/maintainer-grant-v2-recovery.contract.test.ts#recovery applies the exact signed commit created before ref update once

- **WHEN** recovery finds a valid signed commit object journaled for the still-exact base but the branch ref was not updated
- **THEN** recovery may perform the one pending exact-old-OID ref update and then consume the grant

#### Scenario: Crash occurs after ref update
covers: #Requirement: Fail-closed commit recovery
test: packages/workflow-engine/test/maintainer-grant-v2-recovery.contract.test.ts#transient consume failure resumes completion without applying twice

- **WHEN** recovery proves the branch points to the exact journaled valid commit
- **THEN** recovery idempotently records consumption and never reactivates the grant

#### Scenario: Recovery state is ambiguous
covers: #Requirement: Fail-closed commit recovery
test: packages/workflow-engine/test/maintainer-grant-v2-recovery.contract.test.ts#external ref ABA during an uncertain CAS cannot replay the candidate

- **WHEN** the journal, branch, commit, signature, tree, base, or reservation does not match exactly
- **THEN** recovery revokes the use and refuses to create or accept another commit

### Requirement: Revocation and replay resistance
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The engine SHALL provide read-only inspection and idempotent explicit
revocation. Operational use SHALL reject expired, revoked, consumed,
reserved-by-other, previously committed, or duplicate grants. Historical CI
replay MAY accept an expired grant only when the authority commit was created
within its original signed lifetime; the expired grant cannot authorize another
operation.

#### Scenario: CI evaluates a timely commit after grant expiry
covers: #Requirement: Revocation and replay resistance
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** an exact signed authority commit was created within the grant's signed lifetime but CI evaluates it after expiry
- **THEN** historical replay may validate the commit without making the grant operationally reusable

#### Scenario: Revoke is repeated
covers: #Requirement: Revocation and replay resistance
test: packages/workflow-engine/test/maintainer-grant-v2-audit.contract.test.ts#v2 revoke is human-trusted, audit-first, task-bound, and replay-safe

- **WHEN** the maintainer revokes the same available, reserved, revoked, or consumed grant more than once
- **THEN** cleanup remains safe and the grant never returns to available state

#### Scenario: Grant is claimed twice
covers: #Requirement: Revocation and replay resistance
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#approve-and-apply checks before signing and atomically consumes the exact grant

- **WHEN** local state or a pull-request range claims one grant for more than one session or commit
- **THEN** the engine rejects every duplicate use

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
