# safe-concurrent-task-worktrees Specification

## Purpose

Define the current local execution contract for inspecting, admitting, and
maintaining a bounded pair of isolated task writers. The engine owns admission,
durable leases, recovery, and base-update reassessment; routing and planning
artifacts remain the authority inputs and advisory commands never create
execution authority.

## Requirements

### Requirement: Preflight and Status Are Read-Only

The engine SHALL expose `task-preflight` as a production read-only inspection
of the same repository, Git, routing, planning, task, policy, scope, check, and
isolation facts that task ingress later revalidates. Its result SHALL identify
the exact change and task, repository and common-directory identities, branch,
HEAD and tree, routing role and workset, allowed paths, required checks,
authorization requirement, and proposed isolation binding. It SHALL label the
result advisory and SHALL NOT acquire or reclaim a lock, publish a lease or
session, request a Grant, create a journal, or mutate Git.

The engine SHALL expose `status <session-id>` as a read-only projection of the
named durable session, its own registered worktree, current task state, and any
recoverable ingress or finalize transaction. Status MUST NOT substitute the
caller's current worktree for the session's bound worktree and MUST NOT infer a
writer from an unrelated branch.

#### Scenario: A candidate writer is inspected

- **WHEN** an agent runs `task-preflight` for a current selected task
- **THEN** the engine reports the exact observed admission and isolation facts
- **AND** repository, runtime, Grant, index, and ref bytes remain unchanged
- **AND** a later ingress repeats admission under the lifecycle locks

#### Scenario: Concurrent session status is inspected

- **WHEN** two current sessions are active in distinct registered worktrees
- **THEN** status resolves each session against its own durable worktree binding
- **AND** inspection creates no new execution authority

### Requirement: Writer Admission Is Bounded and Isolated

The engine SHALL admit at most two write-capable task sessions in one
repository. The pair SHALL have distinct change, branch, and worktree
identities and disjoint write scopes. They SHALL NOT share a serialized policy,
base-spec, generated-document, or remote-effect class, and SHALL own distinct
exclusive resources, including distinct disposable database resources for
destructive checks.

The active routing workset SHALL select the primary writer and, when enabled,
exactly one concurrent writer. A third writer, a second writer for one change,
an unselected change, overlapping path scope, shared serialized class, shared
resource, branch collision, or worktree collision SHALL fail before a session
or lease is published. Admission MUST NOT silently narrow a declared scope,
switch the selected change, or serialize work after accepting it as concurrent.

#### Scenario: Two isolated writers are admitted

- **GIVEN** routing selects one primary and one concurrent current change
- **AND** their branches, worktrees, path scopes, serialized classes, and exclusive resources are disjoint
- **WHEN** task ingress creates both sessions
- **THEN** both sessions own exact durable isolation bindings
- **AND** each writer remains confined to its declared worktree and resources

#### Scenario: A third or overlapping writer is requested

- **WHEN** capacity is full or any required isolation dimension conflicts
- **THEN** admission returns the exact conflict before publication
- **AND** existing sessions, leases, worktrees, index, and refs remain unchanged

### Requirement: Current Planning Authority Owns Admission

Every writer admission SHALL validate the selected current change, task, and
routing role against current Manifest v3 authority and the independent current
`plan-review.json` binding. It SHALL also bind the exact task strategy, task
policy, allowed paths, required checks, assignment identity, and any current
Grant use required by the protected transition. Grant Core remains the sole
authority for protected continuation; local concurrency policy MUST NOT add a
permanent veto after an exact accepted Grant.

Historical inspection is diagnostic only. A historical plan, review, session,
handoff, or prior status result MUST NOT authorize a new writer or replace any
current admission fact.

#### Scenario: Current authority changes after preflight

- **WHEN** Manifest, PlanReview, routing, task, policy, or assignment facts drift before ingress
- **THEN** ingress rejects the stale candidate under the lifecycle locks
- **AND** the advisory preflight result grants no fallback authority

### Requirement: Session Leases and Recovery Are Durable

An admitted writer SHALL atomically bind its session to the exact change,
branch, worktree, routing role, write scope, serialized classes, exclusive
resources, and repository state. The engine SHALL maintain distinct change,
session, worktree, and resource leases in the Git common directory and SHALL
use compare-and-swap publication so concurrent admission cannot overwrite a
newer owner.

Crash recovery SHALL reconcile a partially published current session to the
same exact identities or fail closed. It MAY reclaim a lease only through the
defined dead-owner recovery path and MUST NOT follow an untrusted alias, guess
a replacement worktree, absorb caller changes, or transfer a live lease.

#### Scenario: Admission stops between durable phases

- **WHEN** the process stops after publishing only a current subset of session and lease state
- **THEN** retry either completes the same exact admission or reports recovery-required
- **AND** it never creates a second owner for the change, worktree, or resource

### Requirement: Update Base Is Local and Sequential

The engine SHALL expose `update-base <change-id> --onto <ref>` only for one
exact committed finished managed task branch with no active or revising task
session. The target SHALL resolve to a local Git ref whose commit advances the
shared history. The exact registered task worktree and branch SHALL be clean,
and the engine SHALL revalidate those facts after acquiring the repository
lifecycle lock before changing history.

Base updates SHALL run sequentially. They MUST NOT operate on an active writer,
fetch an absent target, select a hosted ref by guess, or use concurrency to
combine task branches.

#### Scenario: A finished branch advances to a local base

- **GIVEN** the finished session, branch, worktree, and target commit remain exact and clean
- **WHEN** update-base acquires the lifecycle lock and repeats its observations
- **THEN** it replays that branch onto the specified advancing local commit
- **AND** one concurrent change cannot alter the checked identities during the transition

#### Scenario: A writer appears before locked replay

- **WHEN** a task session becomes active before update-base repeats admission under the lock
- **THEN** update-base refuses before changing branch history
- **AND** no receipt claims that the base advanced

### Requirement: Rebased Work Is Reassessed or Rolled Back

After replaying the finished branch, update-base SHALL recompute the current
change contract, Manifest v3 and `plan-review.json` authority, task scope,
required checks, planning assurance, and managed repository projections. It
SHALL publish an exact durable receipt only when the reassessed branch preserves
those bindings and the requested target remains current.

If reassessment fails, authority drifts, a generated projection requires its
own reviewed transition, or any compare-and-swap observation changes, the
engine SHALL fail closed and roll back the branch and worktree to their exact
pre-operation state. Retry of an already accepted exact receipt SHALL be
idempotent.

Real multi-agent pilots, hosted-service interaction, consumer cutover, and
protected-branch exercises remain `operational-gate-pending`. This local
contract neither performs nor authorizes those operations.

#### Scenario: Rebase changes a managed projection

- **WHEN** replay would require a separate reviewed generated transition
- **THEN** update-base rolls back the replay and reports the required transition
- **AND** current planning authority, branch, worktree, index, refs, and receipt state remain truthful
