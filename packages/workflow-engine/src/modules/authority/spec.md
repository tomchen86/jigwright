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

- **WHEN** a clean fetched repository contains one valid signed original authority commit, its rebase-produced protected-main equivalent, every explicitly mapped grant base, and the required protected grant tags
- **THEN** `pnpm workflow maintainer attest` validates the complete mapping before requesting a human signature
- **AND** it creates one canonical local attestation tag and returns its exact publication command

#### Scenario: Non-interactive or unattended creation is attempted
covers: #Requirement: Canonical human-present authority attestation

- **WHEN** attestation creation lacks a controlling input or output TTY, uses an unattended signer path, or cannot verify human presence
- **THEN** the engine creates no envelope or tag

#### Scenario: Encoding is ambiguous
covers: #Requirement: Canonical human-present authority attestation

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

- **WHEN** `tree(O) == tree(M)`, `tree(parent(O)) == tree(parent(M))`, both messages are byte-identical canonical authority messages, `O` verifies against its exact grant and trusted signer, and `M` is on protected-main first-parent history
- **THEN** replay recognizes `M` as the unique protected-main derivative of `O`

#### Scenario: Only the result tree matches
covers: #Requirement: Exact authority transition identity

- **WHEN** result trees are equal but parent trees, commit messages, change IDs, grant IDs, signatures, or single-parent shape differ
- **THEN** replay rejects the mapping as a different or ambiguous authority transition

#### Scenario: Candidate adds its own trust
covers: #Requirement: Exact authority transition identity

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

- **WHEN** the exact tag name, headers, target, canonical envelope, signature, and primary grant agree
- **THEN** the original signed commit remains reachable and replay may evaluate the mapping

#### Scenario: Evidence is missing or conflicting
covers: #Requirement: Protected retention and unique mapping

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

- **WHEN** a protected grant envelope is now expired but its signature and issuance bounds are valid, its `baseCommit` equals the attested original base, and any successful authority commit occurred within the signed lifetime
- **THEN** historical replay may use the explicitly attested protected-main equivalent without treating the grant as currently usable

#### Scenario: Grant mapping is inferred or incomplete
covers: #Requirement: Explicit grant-base identity mapping

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

- **WHEN** a protected-main authority transition is the exact human-signed commit and its parent policy, protected grant tag, signature, paths, unique claim, and commit-time grant lifetime all validate
- **THEN** historical replay accepts the transition directly without requiring an authority attestation

#### Scenario: Complete historical lineage is replayable
covers: #Requirement: Base-owned historical replay gates sealing

- **WHEN** every protected-main authority commit either validates directly as the retained signed original or resolves through a unique valid protected attestation, and every referenced original grant base has the required explicit mapping under the trusted signer lineage
- **THEN** base-owned replay succeeds and reports the covered authority grants and mappings

#### Scenario: Historical lineage is incomplete
covers: #Requirement: Base-owned historical replay gates sealing

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

- **WHEN** grant issuance lacks a controlling input or output TTY
- **THEN** the engine rejects the request before signing or writing grant state

#### Scenario: Unattended signer is rejected
covers: #Requirement: Human-present grant issuance

- **WHEN** the configured software key can sign without an interactive secret or the request attempts to use an SSH agent, askpass program, environment bypass, or force option
- **THEN** the engine rejects the request and creates no grant

#### Scenario: Human-present issuance succeeds
covers: #Requirement: Human-present grant issuance

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

- **WHEN** a maintainer omits TTL and use-count options
- **THEN** the engine issues a grant valid for no more than 30 minutes and exactly one use

#### Scenario: Altered authorization is rejected
covers: #Requirement: Canonical single-purpose grant

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

- **WHEN** CI cannot resolve the exact grant tag or its envelope differs from the locally claimed grant
- **THEN** the authority commit fails verification

#### Scenario: Candidate key cannot validate its own envelope
covers: #Requirement: Protected audit envelope

- **WHEN** a candidate branch adds or changes a signer while claiming an authority grant
- **THEN** CI verifies the envelope only with signers trusted by the authority commit parent

#### Scenario: Rebased grant base is replayed
covers: #Requirement: Protected audit envelope

- **WHEN** a historical grant tag references an original base commit that is not on protected-main history
- **THEN** replay requires an explicit attested protected-main base with equal result and parent trees, an identical canonical managed message, and the exact grant ID binding

### Requirement: Isolated authority session
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The engine SHALL expose `authority-start`, `authority-check`, and
`authority-commit` as a state machine separate from ordinary task, plan, and
archive transitions.

#### Scenario: Start reserves a valid grant
covers: #Requirement: Isolated authority session

- **WHEN** a clean eligible branch at the exact grant base starts the matching change with the matching audit envelope and no lifecycle conflict
- **THEN** the engine atomically reserves the grant and pins the repository, policy, contract, paths, signer, and checks in an authority session

#### Scenario: Authority check preserves normal checks
covers: #Requirement: Isolated authority session

- **WHEN** an active authority session has changes only to exact granted paths
- **THEN** the engine runs every normally required schema, lint, test, document, secret, safety, and non-destructive database-policy check and records content-addressed evidence

#### Scenario: Failed operation closes authority
covers: #Requirement: Isolated authority session

- **WHEN** start after reservation, check, commit, cancellation, expiry, signature validation, base validation, path validation, or lock validation fails
- **THEN** the session closes, the reservation becomes terminally revoked or consumed, and the grant cannot become available again

### Requirement: Exact authority commit isolation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

`authority-commit` MUST create one signed commit with exactly the granted
authority diff and canonical mutually exclusive `Change`,
`Transition: authority-maintenance`, and `Grant` trailers. If required rebase
merge changes that commit identity, the protected-main commit SHALL derive
authority only from a valid unique tree attestation to the retained signed
original.

#### Scenario: Exact authority commit succeeds
covers: #Requirement: Exact authority commit isolation

- **WHEN** at least one granted file changed, no ungranted path changed, current evidence passes, HEAD remains the grant base, and the trusted signer signs the commit
- **THEN** the engine atomically advances the branch to one authority-maintenance commit and consumes the grant

#### Scenario: Mixed work is rejected
covers: #Requirement: Exact authority commit isolation

- **WHEN** the diff contains product code, ordinary documentation, task completion, generated files, or any path absent from the exact grant
- **THEN** the engine rejects the commit and terminally closes that grant use

#### Scenario: Managed trailer forms are mixed
covers: #Requirement: Exact authority commit isolation

- **WHEN** an authority commit also contains `Task`, `plan`, `archive`, another transition, or a non-canonical reserved trailer
- **THEN** local hooks and CI reject the commit

#### Scenario: Signed original is rebased onto protected main
covers: #Requirement: Exact authority commit isolation

- **WHEN** GitHub creates a different main commit from a signed authority original
- **THEN** later replay accepts the main commit only when the original signature, exact grant, result tree, parent tree, complete canonical message, protected-main reachability, and unique protected attestation all verify

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

- **WHEN** recovery proves the branch points to the exact journaled valid commit
- **THEN** recovery idempotently records consumption and never reactivates the grant

#### Scenario: Recovery state is ambiguous
covers: #Requirement: Fail-closed commit recovery

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

- **WHEN** an exact signed authority commit was created within the grant's signed lifetime but CI evaluates it after expiry
- **THEN** historical replay may validate the commit without making the grant operationally reusable

#### Scenario: Revoke is repeated
covers: #Requirement: Revocation and replay resistance

- **WHEN** the maintainer revokes the same available, reserved, revoked, or consumed grant more than once
- **THEN** cleanup remains safe and the grant never returns to available state

#### Scenario: Grant is claimed twice
covers: #Requirement: Revocation and replay resistance

- **WHEN** local state or a pull-request range claims one grant for more than one session or commit
- **THEN** the engine rejects every duplicate use

### Requirement: Bootstrap and sealed trust phases
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The trusted maintainer policy SHALL begin in bootstrap and SHALL permit only a
one-way, old-key-authorized transition to sealed mode with immutable verifier
and trust-root paths. The sealed transition MUST preserve a signer lineage that
validates every retained authority original and attestation and MUST NOT proceed
until base-owned historical replay is complete.

#### Scenario: Bootstrap grant targets eligible authority
covers: #Requirement: Bootstrap and sealed trust phases

- **WHEN** a valid bootstrap grant lists exact files under reviewed eligible authority paths and none under immutable paths
- **THEN** the authority session may modify only those exact files while preserving all checks

#### Scenario: Sealed grant targets immutable trust root
covers: #Requirement: Bootstrap and sealed trust phases

- **WHEN** a grant in sealed phase includes the verifier, trusted-key loader, policy loader, or immutable-path enforcement
- **THEN** issuance, local execution, and CI all reject it using parent/base policy

#### Scenario: Phase rollback is attempted
covers: #Requirement: Bootstrap and sealed trust phases

- **WHEN** a candidate changes policy phase from sealed to bootstrap
- **THEN** CI rejects the change regardless of grant or signer

#### Scenario: Trusted key rotates
covers: #Requirement: Bootstrap and sealed trust phases

- **WHEN** an existing trusted key authorizes an otherwise valid policy change that introduces a replacement key without weakening immutable paths or historical attestation verification
- **THEN** the replacement becomes trusted only after the authority commit merges

#### Scenario: Historical authority is not replayable
covers: #Requirement: Bootstrap and sealed trust phases

- **WHEN** a candidate changes policy phase to sealed while any protected-main authority commit or grant-base identity lacks valid base-owned direct-or-attested historical replay
- **THEN** CI rejects the sealing transition

### Requirement: Real Bootstrap Pilot Evidence
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Before break-glass maintainer mode can be described as remotely proven, the
repository SHALL retain evidence from a real maintainer-owned, non-database
bootstrap pilot under the configured protected branch, audit-tag, signer, and
base-owned CI boundaries.

#### Scenario: Negative grant lifecycle is terminal
covers: #Requirement: Real Bootstrap Pilot Evidence

- **WHEN** separate real grants are explicitly revoked twice, expire after one minute, or fail a harmless pre-commit check
- **THEN** every use reaches a terminal non-reusable state and its protected signed audit tag remains available for investigation

#### Scenario: Successful authority transition is independently verified
covers: #Requirement: Real Bootstrap Pilot Evidence

- **WHEN** the active pilot's semantic handoff is first refreshed through its scoped ordinary task and a fresh human-signed grant then authorizes one exact harmless authority file
- **AND** all pinned checks pass, the signed authority commit is created, and recovery is called again
- **THEN** the grant is consumed exactly once, recovery returns the same commit identity, and no ordinary or product path is included
- **AND** the pull request passes the strict base-owned `workflow-assurance` check without a ruleset exception

#### Scenario: Evidence closes only after merge
covers: #Requirement: Real Bootstrap Pilot Evidence

- **WHEN** local pilot evidence exists but the protected pull request has not yet passed and merged
- **THEN** the post-merge evidence task and archive remain incomplete
- **AND** the repository remains explicitly in bootstrap phase

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
