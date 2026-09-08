# Authority
capabilities: [authority-tree-attestation, break-glass-maintainer-mode]

## Purpose

Bind maintainer authorization and retained transition evidence to the exact operation, trusted inputs, and durable recovery state.
## Requirements
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

### Requirement: Base-owned historical replay gates sealing
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The base-owned workflow verifier MUST scan protected-main first-parent history
for authority transitions and fail closed unless every transition either
retains a directly valid signed authority commit or has one valid attestation,
and every historical grant base referenced by a rewritten transition has a
valid explicit mapping. Sealed enforcement SHALL NOT be declared while
migration, protected tag control, environment binding, or trusted signer
lineage remains unproven.

#### Scenario: Protected history retains the signed authority commit
covers: #Requirement: Base-owned historical replay gates sealing
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** a protected-main authority transition is the exact human-signed commit and its parent policy, protected grant tag, signature, paths, unique claim, and commit-time grant lifetime all validate
- **THEN** historical replay accepts the transition directly without requiring an authority attestation

#### Scenario: Complete historical lineage is replayable
covers: #Requirement: Base-owned historical replay gates sealing
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#maintainer attestation accepts the current signed v2 authority grant

- **WHEN** every protected-main authority commit either validates directly as the retained signed original or resolves through a unique valid protected attestation, and every referenced original grant base has the required explicit mapping under the trusted signer lineage
- **THEN** base-owned replay succeeds and reports the covered authority grants and mappings

#### Scenario: Historical lineage is incomplete
covers: #Requirement: Base-owned historical replay gates sealing
test: packages/workflow-engine/test/maintainer-grant-v2-apply.contract.test.ts#remote CI verifies an applied v2 candidate from portable Git authority receipts

- **WHEN** any authority commit, original object, grant base, tag, signature, trust binding, mapping, or main reachability check is absent or invalid
- **THEN** workflow assurance fails closed and the repository remains undeclared or bootstrap-only

#### Scenario: Signer is rotated before sealing
covers: #Requirement: Base-owned historical replay gates sealing

- **WHEN** the sealed trust root would remove a signer required to validate an original authority commit or its attestation without an old-key-authorized cross-signing rule
- **THEN** the sealing transition is rejected because historical provenance would become unverifiable

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

### Requirement: Canonical single-purpose grant
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Every grant SHALL use a versioned canonical signed payload bound to the trusted
policy, stable repository identity, canonical origin, full base commit, OpenSpec
change, sorted unique exact paths, issue and expiry times, one use, reason, and
trusted signer identity.

#### Scenario: Default grant bounds are narrow
covers: #Requirement: Canonical single-purpose grant
test: packages/workflow-engine/test/maintainer-grant-v2.contract.test.ts#v2 issue signs every binding and stores a canonical one-shot grant

- **WHEN** a maintainer omits TTL and use-count options
- **THEN** the engine issues a grant valid for no more than 30 minutes and exactly one use

#### Scenario: Altered authorization is rejected
covers: #Requirement: Canonical single-purpose grant
test: packages/workflow-engine/test/maintainer-grant-v2.contract.test.ts#v2 issue signs every binding and stores a canonical one-shot grant

- **WHEN** any signed authorization field, schema version, policy blob, signature, repository, base, change, path, time, reason, use count, or signer differs from the trusted canonical payload
- **THEN** the engine rejects the grant

#### Scenario: Unsafe grant path is rejected
covers: #Requirement: Canonical single-purpose grant

- **WHEN** a path is absolute, traversing, globbed, a directory, missing, untracked, symlinked, case-ambiguous, non-exact-case, or outside bootstrap eligibility
- **THEN** the engine refuses to issue or reserve the grant

### Requirement: Git-common-directory grant state
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The engine MUST keep available tokens, reservations, terminal records, and
recovery journals in the Git common directory with restrictive permissions and
atomic persistence shared by all linked worktrees.

#### Scenario: Concurrent worktrees compete for one grant
covers: #Requirement: Git-common-directory grant state

- **WHEN** two worktrees attempt to reserve the same available grant
- **THEN** exactly one reservation succeeds and the other fails without obtaining authority

#### Scenario: Worktree contains no bearer token
covers: #Requirement: Git-common-directory grant state

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

### Requirement: Authority commits carry check-definition transitions
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

CI replay SHALL treat a validated authority commit whose grant covers `workflow/checks.json` as the authoritative source of required-check definitions from its own tree, superseding earlier recorded definitions in the range. A definition added by that commit but absent from the parent policy and guards MUST remain unexecuted until a later validated guard requires it. All other definition drift MUST still fail closed.

#### Scenario: Authority commit changes a required definition
covers: #Requirement: Authority commits carry check-definition transitions

- **WHEN** a fully validated authority commit edits a required check's definition and the head registry matches that edit
- **THEN** replay succeeds and reports the new definition

#### Scenario: Authority commit also adds an unused definition
covers: #Requirement: Authority commits carry check-definition transitions

- **WHEN** the same fully validated authority commit adds a structurally valid check ID that no parent policy or guard requires
- **THEN** the signed tree and complete registry remain validated
- **AND** replay does not report or execute the added definition as required-check evidence

#### Scenario: Later task activates the added definition
covers: #Requirement: Authority commits carry check-definition transitions

- **WHEN** a later planning transition validates an incomplete task guard that references the added check ID
- **AND** that task is executed against the post-authority registry
- **THEN** the engine pins and runs the registered definition
- **AND** CI records it as required evidence from that task onward

#### Scenario: Definition drifts without an authority transition
covers: #Requirement: Authority commits carry check-definition transitions

- **WHEN** required-check definitions differ across a range with no validated authority commit carrying the change
- **THEN** replay fails closed with the existing definition-drift error

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
