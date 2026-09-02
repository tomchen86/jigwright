# change-routing Specification

## Purpose

Define current local repository routing as a deterministic, inspectable, and
recoverable engine capability. Routing selects a managed writer workset without
creating planning authority, guessing lifecycle state, or reading a previous
handoff as input.

## Requirements

### Requirement: Routing Status Exposes Current Repository Inventory

The engine SHALL expose a read-only `route status` command backed by the
production routing inspection boundary. It SHALL derive every current and
archived change in stable change-ID order from the controlled lifecycle source,
task facts, archive facts, private recovery facts, Manifest v3 validation, and
the separate current `plan-review.json` binding. The result SHALL report the
source presence and digest, primary and concurrent identities, exact tasks,
reason, affected task, blocker, and one of the current states `primary`,
`concurrent`, `ready`, `blocked`, `resume-available`, `parked`,
`completed-awaiting-archive`, `archived`, `revising`, or
`recovery-required`.

Status and its catalog-owned `nextSteps` MUST NOT write a Source, report,
journal, worktree, index, commit, or Git ref. A returned next step SHALL be an
executable current command with concrete known identities; when no unambiguous
transition exists, status SHALL direct the caller to the read-only guide rather
than inventing a change.

#### Scenario: Mixed repository state is inspected

- **WHEN** a repository contains ready, blocked, parked, resumable, completed, archived, or recovering changes
- **THEN** `route status` reports every change under its exact derived state
- **AND** reasons, blockers, affected tasks, and current writer identities remain visible
- **AND** no repository or private runtime byte changes

#### Scenario: Current planning authority is unavailable

- **WHEN** an unfinished change cannot pass current Manifest v3 and independent PlanReview validation
- **THEN** status reports that change as `recovery-required`
- **AND** historical inspection is diagnostic only and cannot make the change current

### Requirement: Controlled Lifecycle Source Owns Explicit Routing

Explicit routing SHALL be stored only in
`openspec/change-lifecycle.json`. The current source SHALL contain its exact
schema, monotonically increasing routing revision, `maxConcurrent: 1`, primary
identity, bounded concurrent identity set, and stable per-change records.
Records SHALL distinguish `ready`, `blocked`, and `parked`; a blocked record
SHALL retain its incomplete task, reason, one `change` or `external` blocker,
and the exact `done`, `merged`, `archived`, or `manual` resume condition.

The source SHALL NOT copy task completion, archive, revision, recovery, or
planning-authority facts that the engine can derive. An AI may author a routing
intent or review input, but it MUST NOT hand-edit or directly stage the
controlled source.

#### Scenario: A change is blocked explicitly

- **WHEN** a valid routing intent blocks one unfinished task on a canonical blocker
- **THEN** the next source preserves the reason, task, blocker identity, and resume condition
- **AND** satisfaction later yields `resume-available` without automatically resuming or focusing the change

#### Scenario: Controlled bytes are staged by hand

- **WHEN** a caller stages even an otherwise valid lifecycle source outside the managed routing transition
- **THEN** hooks and CI reject the unauthorized projection

### Requirement: Routing Review Is Current and Recoverable

`route prepare` SHALL produce one exact current routing review that binds the
observed source digest, repository-facts digest, intended action, next source
and digest, current authority facts, and any accepted continuation authority.
Focus, concurrent admission, and resume SHALL use current Manifest v3 authority
validation plus the independent PlanReview result; historical readers MUST NOT
authorize them.

`route apply` SHALL reproduce the review under the repository lifecycle lock,
use compare-and-swap for the source and repository facts, publish only the exact
lifecycle and configured handoff projections, and record one content-addressed
report and managed commit. If a crash occurs after a durable commit object or
partial private journal step, retry SHALL reconcile the same transition and
MUST NOT duplicate or guess it.

#### Scenario: Reviewed facts remain current

- **WHEN** the source, repository facts, current planning authority, and reviewed next source still agree
- **THEN** apply publishes one exact routing transition and its derived handoff
- **AND** replay returns the same source, report, and commit identity

#### Scenario: Reviewed facts drift

- **WHEN** the lifecycle source, task tree, Manifest, PlanReview, or intended workset changes after prepare
- **THEN** apply fails before source, handoff, index, or ref mutation

### Requirement: Grant Core Owns Protected Continuation

When a parked change or a manual external blocker requires an authorized
continuation, routing SHALL submit the exact state-bound candidate as a
registered Central Grant transition. The ordinary prepare path SHALL emit one
Fail-Grant challenge before mutation. A retry may consume only the matching
completed Central Grant record and SHALL bind its challenge, operation,
transition, consequence, and terminal outcome.

Routing MUST NOT introduce a local approval store, signer, permanent hard veto,
or post-Grant policy override. An accepted Grant may authorize continuation but
cannot change the recorded blocker, Source bytes, task facts, or current
planning-authority result.

#### Scenario: Manual continuation has no Grant

- **WHEN** a caller prepares resume for a protected current routing record without accepted authority
- **THEN** the engine returns one exact Fail-Grant challenge and retry command
- **AND** lifecycle, report, index, and Git refs remain unchanged

#### Scenario: Exact registered continuation is accepted

- **WHEN** retry supplies the one completed Grant record bound to the unchanged routing state
- **THEN** preparation may clear the blocked or parked disposition
- **AND** it still does not auto-focus the resumed change

### Requirement: Writer Admission Requires Managed Routing

When no controlled source exists and at most one unfinished change is present,
the engine MAY admit that change in the neutral single-writer role. Once the
repository has an explicit source or multiple unfinished changes, task ingress
SHALL admit only a current, ready change selected as `primary` or `concurrent`.
Every other request SHALL fail with `CHANGE_ROUTING_REQUIRED` and an exact
recovery direction; task ingress MUST NOT silently switch focus or edit routing.

#### Scenario: Multiple changes have no selected writer

- **WHEN** a caller opens a task for a ready change outside the managed workset
- **THEN** ingress fails with `CHANGE_ROUTING_REQUIRED`
- **AND** the caller can inspect status and prepare an explicit review without mutation

### Requirement: Handoff Is a Derived Repository Projection

The configured handoff SHALL be regenerated from the same coherent routing
inspection used by status plus current task, archive, and Work Registry
facts. It SHALL present current, concurrent, ready, resumable, blocked, parked,
and pending-archive groups without reading its previous bytes to select a
change. Archiving one identity SHALL remove only that identity from active
groups, and zero active changes SHALL remain explicit rather than guessed.

#### Scenario: Previous handoff names another change

- **WHEN** controlled source and repository facts select a different inventory
- **THEN** rendering ignores the old selection and emits the current derived groups
- **AND** committed replay produces the same handoff without private runtime state

#### Scenario: Built-in Work Registry has zero items

- **WHEN** the repository has no Work Item records or inventory projection
- **THEN** handoff renders the current routing and task facts without Work backlog rows
- **AND** it does not infer that the built-in Work Registry capability is unavailable
