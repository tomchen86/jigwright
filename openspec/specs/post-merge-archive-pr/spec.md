# post-merge-archive-pr Specification

## Purpose

Define current local orchestration from a completed protected-base change to
one assured archive branch and an exact publication preparation. The engine
automates deterministic archive mechanics and diagnostics while preserving the
core archive authority, Grant Core, repository rules, and human merge
authority.

## Requirements

### Requirement: Candidate Discovery Is Read-Only and Current

The engine SHALL expose `archive-pr doctor` as a production read-only inventory
over the exact configured protected remote base. Candidate discovery SHALL run
from one attached clean protected-base worktree whose local commit and tree
equal the exact configured remote-tracking commit and tree. It SHALL report
eligible, blocked, and verified already-archived changes in stable change-ID
order, including an exact blocker and next safe command when available.

An eligible candidate SHALL have every task complete under current Manifest v3
authority and the independent current `plan-review.json` binding. Its
PlanReview verdict SHALL approve and both required and achieved independence
SHALL be `provider-independent`. Historical inspection is diagnostic only and
MUST NOT make a candidate eligible, repair current authority, or replace the
protected-base identity.

Doctor SHALL NOT acquire a transition lock, create a branch or worktree, write
runtime state, contact a remote service, or mutate files, the index, commits,
or refs. A tracked archive directory without exact report-backed transition
evidence SHALL be blocked rather than inferred as archived.

#### Scenario: A completed current change is discovered

- **GIVEN** the clean protected branch and its configured remote-tracking identity have the same commit and tree
- **AND** the completed change passes current Manifest and PlanReview authority
- **WHEN** an agent runs `archive-pr doctor`
- **THEN** the candidate binds the repository, change, protected-base, Manifest, and PlanReview identities
- **AND** no local or remote state changes

#### Scenario: Historical or inferred archive state is observed

- **WHEN** only historical planning evidence or an unverified archive directory is available
- **THEN** doctor reports the exact current blocker
- **AND** it neither synthesizes authority nor modifies the repository

### Requirement: Local Preparation Reuses Core Archive Authority

The engine SHALL expose `archive-pr dry-run <change-id>` and the equivalent
local `after-merge <change-id>` caller. Each SHALL create or exactly reuse the
canonical isolated `work/archive-<change-id>` branch and registered worktree
from the discovered protected commit. An existing branch or worktree MAY be
reused only when its repository, common directory, branch, base ancestry,
clean state, and current report-backed archive identity all match; every
foreign or divergent identity SHALL fail before recovery writes.

Local orchestration SHALL invoke the existing core archive transition rather
than reimplementing task completion, delta application, archived-tree
materialization, configured Work Registry or handoff reconciliation, staging,
commit, report, or recovery authority. It SHALL invoke archive a second time
and require `already-archived` with the same exact commit, report, and path
identity. It SHALL then run local pull-request assurance over the exact
protected parent and archive head.

The local path SHALL stop before branch publication or pull-request creation
and SHALL perform no network request. `archive-pr dry-run` SHALL report its
remote state as unobserved and its operational gate as pending.

#### Scenario: A current candidate is prepared locally

- **WHEN** local preparation creates the canonical isolated archive worktree
- **THEN** core archive authority produces one archive commit and report
- **AND** exact replay returns the same identity
- **AND** local assurance binds the discovered protected parent to that archive head
- **AND** no hosted service is contacted

#### Scenario: A canonical branch belongs to another history

- **WHEN** the branch, worktree, remote-tracking base, or report evidence is foreign or divergent
- **THEN** preparation fails closed without rewriting, deleting, resetting, or adopting it

### Requirement: Prepared Publication Payload Is Exact and Durable

Successful local preparation SHALL persist one canonical content-addressed
payload under the Git common runtime. Its identity SHALL cover the repository
and change, `candidateIdentity`, exact `protectedBase` branch, origin tracking
ref, commit and tree, canonical archive branch, archive head and report, and
the exact local `assurance` report, base, and head identities.

The store SHALL accept only the exact current key set and canonical bytes,
create the record without overwrite, use a private regular file, reject links
or unsafe ancestry, and return the existing file only when every byte matches.
Publication and diagnostics SHALL revalidate the payload rather than treating
its digest as authority by itself.

#### Scenario: The same local preparation is retried

- **WHEN** retry derives the same canonical payload identity
- **THEN** persistence converges on the same private record and bytes
- **AND** no duplicate archive identity is created

#### Scenario: A stored field or byte is altered

- **WHEN** a preparation has an extra, missing, noncanonical, linked, or digest-inconsistent value
- **THEN** the store fails closed without repairing or replacing the record

### Requirement: Local Status Replays Git Truth Without Remote Authority

The engine SHALL expose
`archive-pr status <sha256:preparation-identity>` as a read-only diagnostic.
Status SHALL load the exact durable preparation and recompute the configured
repository identity, local and remote-tracking protected refs, archive ref,
archive transition report, archive tree, and recorded assurance relationship.
It SHALL report current local preparation only when every identity still
matches.

Status SHALL NOT load the optional remote adapter, read credentials, contact a
network, create a worktree, or mutate Git or runtime state. Its result SHALL
state that remote state was not observed and that publication remains pending;
it MUST NOT claim a pull request exists or that publication is authorized.

#### Scenario: Exact local preparation remains current

- **WHEN** the stored preparation, protected refs, archive ref, report, tree, and assurance still agree
- **THEN** status returns the exact local archive identity and replay command
- **AND** its authority remains diagnostic

#### Scenario: Any bound Git fact drifts

- **WHEN** a protected ref, archive ref, report, tree, configuration, or assurance identity differs
- **THEN** status reports the preparation stale
- **AND** all files, refs, worktrees, and runtime bytes remain unchanged

### Requirement: Publication Is Create-Only and Grant-Bound

Any explicit publication attempt SHALL consume the exact local preparation
and revalidate the canonical repository origin, optional adapter
configuration, protected-base ref, archive source ref, current hosted ruleset,
required assurance check, and absence of bypass actors. It SHALL publish only
the absent canonical archive ref or confirm the same exact head. A divergent
ref, changed protected base, changed configuration, stale ruleset, unknown
effect, or foreign pull request SHALL stop without overwrite.

Remote publication SHALL require one completed registered Central Grant
transition bound to the exact preparation, publication target, ruleset facts,
credential boundary, and consequence. The adapter MUST NOT choose an approval
method or reason, create a second approval record, approve, bypass, or merge a
pull request. Its capability remains create-only for one branch and one
idempotent pull-request identity, using a bounded short-lived credential only
at the explicit publication boundary.

Every local or remote state transition SHALL use compare-and-swap observations
and content-addressed receipts. Retry MAY confirm the exact branch or pull
request already created, but MUST NOT force-update a divergent branch, delete a
foreign ref, close a foreign request, or broaden the accepted Grant.

#### Scenario: The exact absent archive ref is published

- **GIVEN** an accepted exact Grant and unchanged target, ruleset, base, and archive head
- **WHEN** the explicit publisher observes the canonical archive ref absent
- **THEN** it creates only that ref and records the exact observed result
- **AND** retry confirms the same head without another effect

#### Scenario: Remote facts or authority drift

- **WHEN** any publication, ruleset, credential, Grant, branch, or pull-request identity differs
- **THEN** publication fails before broadening or replacing remote state

### Requirement: Remote Activation Remains Operationally Gated

The presence of publication code and optional adapter contracts SHALL NOT be
reported as evidence that hosted automation is enabled or proven. GitHub App
installation, live credentials, workflow activation, manual dispatch against
a hosted repository, event-trigger enablement, branch publication,
pull-request creation, protected checks, and the real end-to-end pilot remain
`operational-gate-pending` until separately authorized and observed.

Fake and bare-remote tests are local acceptance evidence for deterministic
payloads, create-only collision behavior, retry, and authority boundaries;
they are not evidence of live permissions, hosted event delivery, ruleset
behavior, or protected pull-request success. Automation MAY open a request only
after the operational gate, and MUST NOT approve, bypass, or merge it.

#### Scenario: Local acceptance passes without hosted access

- **WHEN** fake adapters and bare repositories prove preparation, collision, and recovery contracts
- **THEN** local implementation may be reported implemented and targeted-green
- **AND** every real hosted operation remains operational-gate-pending
