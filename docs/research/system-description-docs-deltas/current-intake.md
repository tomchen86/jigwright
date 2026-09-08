# Current intake provenance — Phase C implementation delta

Date: 2026-09-08. This delta binds the completed dedicated Finding branch, current Source correction command, existing-Source attachment and active provenance transaction. The original canonical blocks remain in `9c63c49`; exact Source wording is unchanged. Existing normative scenarios are retained, with storage facts updated to the implemented Git representation. The user-authorized one-time migration of 15 agent Sources is recorded separately and does not grant runtime Source deletion.

## MODIFIED Requirements

### Requirement: Findings Remain Independent of Task Write Scope
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

A Finding SHALL bind its exact text to the active session, change, branch, head,
and tree in immutable Git records on the dedicated `refs/heads/jigwright/findings` branch. When no task is active, the existing repository scope supplies the actual repository context. Finding capture SHALL remain
available when the repository path is outside the current task's allowed write
scope. Capture SHALL update only the dedicated Finding ref while preserving the task HEAD, index and working tree. Ordinary clones SHALL discover the retained records through the fetched remote-tracking Finding branch without requiring private runtime files. A Finding is an agent-authored observation and MUST be revalidated before
promotion into normative planning or transition facts.

#### Scenario: Mid-task observation is outside allowed paths
covers: #Requirement: Findings Remain Independent of Task Write Scope
test: packages/workflow-engine/test/governance-findings.integration.test.ts#finding capture binds active session and Git facts outside task paths

- **WHEN** an active session records a bounded Finding about work outside its task paths
- **THEN** the engine stores the Finding with current session and Git facts
- **AND** no repository lifecycle transition is authorized by the Finding

#### Scenario: An ordinary clone retains the observations
covers: #Requirement: Findings Remain Independent of Task Write Scope
test: packages/workflow-engine/test/governance-finding-ref.integration.test.ts#ordinary clone retains immutable Findings and receipts without task-tree files

- **WHEN** an ordinary clone reads Findings after the original repository and its private runtime are removed
- **THEN** it still reads the exact immutable records and receipts from Git
- **AND** recording another Finding preserves the clone task HEAD, index and worktree

### Requirement: Finding Disposition Is Append-Only
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Under D-019, the engine SHALL keep each original `FND-*.json` Git record immutable. A
Finding read model SHALL expose exactly one `disposition` value from `pending`,
`converted`, `linked`, or `dismissed`, together with its reason, target, and
terminal time. Absence of a terminal receipt means `pending`; a terminal value
MUST come from one create-once canonical sidecar beside the original Finding.
The current `dismiss` command SHALL require a non-empty reason, write a null
target, preserve the original Finding bytes, and remain visible through
`finding list --all`. The ordinary `finding list` command SHALL return only
pending Findings across the repository Finding branch and available remote-tracking copies. Conflicting terminal receipts SHALL be reported without choosing a winner or rewriting history.

#### Scenario: A caller dismisses one pending Finding
covers: #Requirement: Finding Disposition Is Append-Only
test: packages/workflow-engine/test/governance-findings.integration.test.ts#Finding disposition is append-only and runtime-wide counts stay read-only

- **WHEN** `finding dismiss <finding-id> --reason <reason>` resolves one identity-valid pending Finding
- **THEN** one immutable terminal receipt records `dismissed`, the exact reason, a null target, and the current time
- **AND** the original Finding, Source, Work Item, task HEAD, index, working tree and tracked projection bytes remain unchanged; only the dedicated Finding ref advances
- **AND** the Finding disappears from the default list but remains in `finding list --all`

#### Scenario: Finding storage is ambiguous or unsafe
covers: #Requirement: Finding Disposition Is Append-Only
test: packages/workflow-engine/test/governance-findings.integration.test.ts#Finding readers report invalid Git records and receipts without repair

- **WHEN** repository-wide listing observes a noncanonical Git path, path mismatch, invalid blob mode or bytes, orphan receipt, conflicting terminal receipts, or duplicate identity
- **THEN** listing and disposition fail closed without choosing one record
- **AND** no Finding or disposition byte is repaired, deleted, or rewritten

#### Scenario: Concurrent writers preserve distinct records
covers: #Requirement: Finding Disposition Is Append-Only
test: packages/workflow-engine/test/governance-finding-ref.integration.test.ts#concurrent Finding writers converge through Git ref CAS

- **WHEN** concurrent writers append distinct Findings to the same dedicated ref
- **THEN** compare-and-swap retries preserve each published record

#### Scenario: Remote terminal conflicts remain explicit
covers: #Requirement: Finding Disposition Is Append-Only
test: packages/workflow-engine/test/governance-finding-ref.integration.test.ts#Finding writes merge remote divergence and preserve conflicting terminal receipts

- **WHEN** local and fetched Finding histories contain unrelated records or conflicting terminal receipts
- **THEN** unrelated records remain visible and conflicting dispositions are reported
- **AND** the engine does not rewrite a terminal receipt

### Requirement: Attach Adds a Source Without Reclassifying Work
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

Under D-019, `attach <work-item-id> <original-text>` SHALL capture or reuse one
exact Source and append its identity to the requested open Work Item under the
existing Work Registry lock. The update SHALL preserve kind, stage, lane, title,
relations, closure, and timeline. Its current interpretation SHALL become
agent-derived and SHALL bind only the canonically sorted Source identities; it
MUST NOT copy the original wording. Repeating the exact attachment SHALL be
byte-idempotent, including after a later accepted interpretation. An active item and its change origin SHALL receive their Source references through the existing recoverable Work Registry transaction. An open backlog or active item with a changed agent-derived interpretation MAY be confirmed again through `accept` without changing its stage. A closed item or unsafe current record SHALL fail before
claiming an attachment.

`attach <work-item-id> <SRC-id>` SHALL link that existing Source without
minting another, and `attach <work-item-id> <original-text> --supersedes
<SRC-id>` SHALL capture the wording as a correction that supersedes the named
Source while the Work Item keeps citing both records. Repeating the same
correction SHALL reuse the existing Source. Attaching a Source to an observation
kind SHALL preserve the observation's interpretation summary.

#### Scenario: New wording supplements one inbox item
covers: #Requirement: Attach Adds a Source Without Reclassifying Work
test: packages/workflow-engine/test/governance-intake-commands.integration.test.ts#D-019 later and attach preserve original wording only in Sources and converge exactly

- **WHEN** `attach <work-item-id> <original-text>` names one current open Work Item
- **THEN** exactly one Source identity is added and the current interpretation binds all sorted Source IDs
- **AND** stage, lane, title, timeline, Git refs, and unrelated Work Items remain unchanged
- **AND** retry reuses the exact Source and leaves the Work Item bytes unchanged

#### Scenario: Active attachment keeps shared provenance and later confirmation
covers: #Requirement: Attach Adds a Source Without Reclassifying Work
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#correction preserves shared origin citations and attachment replays preserve confirmation

- **WHEN** an existing Source is attached to an active Work Item sharing an origin with another item
- **THEN** the existing Source is reused and the origin retains the other item’s provenance
- **AND** an exact attachment retry preserves a subsequently confirmed interpretation

### Requirement: Finding Conversion Has One Deterministic Target
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

`finding convert <finding-id>` SHALL preserve the immutable Finding, derive one
stable Work Item identity from it, and create or reuse the exact inbox item
before publishing the create-once `converted` receipt. A Finding is an
observation, so conversion SHALL NOT mint a Source: the inbox item carries the
Finding text as its interpretation summary, defaults to `kind: bug` unless
`--kind <kind>` names another registered kind, and cites only the Sources the
Finding already cited. A crash after the item publication but before
the receipt SHALL truthfully leave the Finding pending; retry SHALL converge to
the same item and then publish the receipt. A different record at that derived
identity SHALL fail closed without publishing or rewriting a receipt, Finding,
or Work Item. `finding convert <finding-id> --now` SHALL first complete that
same durable inbox item and converted receipt, then start the stable immediate
change whose intent cites only the Finding's already-cited Sources. The
intent summary SHALL retain the complete Finding text. The converted item
SHALL remain inbox, and no maintainer-authored duplicate of the Finding text
may be created.

#### Scenario: Conversion resumes after its item is durable
covers: #Requirement: Finding Conversion Has One Deterministic Target
test: packages/workflow-engine/test/governance-findings.integration.test.ts#D-019 finding convert resumes one deterministic item before publishing its receipt

- **WHEN** conversion stops after the deterministic inbox item is durable but before its receipt exists
- **THEN** default Finding listing still reports the Finding as pending
- **AND** retry reuses the byte-identical Work Item record, mints no Source, and publishes one converted receipt targeting that item
- **AND** no second Work Item, migration record, Grant, or unrelated Git ref is created; only the dedicated Finding ref advances for its receipt

#### Scenario: Converted Finding is escalated immediately
covers: #Requirement: Finding Conversion Has One Deterministic Target
test: packages/workflow-engine/test/propose-planning-workspace.integration.test.ts#finding-converted immediate Source bootstrap resumes a source-only crash into one exact cited planning origin

- **WHEN** `finding convert <finding-id> --now` names one pending or exactly converted Finding
- **THEN** conversion first publishes or reuses its deterministic inbox item and receipt
- **AND** the stable immediate change carries only the Finding's already-cited Sources while the Work Item remains inbox
- **AND** the result echoes the original Finding text and one truthful propose next step

### Requirement: Finding Link Is a Receipt-Only Relation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

`finding link <finding-id> --change <change-id>` SHALL require one exact
existing plain change directory inside the configured change root. `finding link <finding-id> --work-item <work-item-id>` SHALL instead resolve one existing valid Work Item. Both forms SHALL publish
only the create-once `linked` Finding disposition receipt. The receipt SHALL
name the requested change or Work Item and SHALL NOT write `origin.json`, add Source or Work
Item references, widen a task path, create a Grant, or mutate planning, the task HEAD, index, working tree or
repository projection bytes. Only the dedicated Finding ref SHALL advance. The same exact link SHALL be idempotent. Missing,
symbolic-link, escaped, or otherwise unsafe change targets and conflicting
terminal dispositions SHALL fail before receipt publication.

#### Scenario: A Finding links to a non-current existing change
covers: #Requirement: Finding Link Is a Receipt-Only Relation
test: packages/workflow-engine/test/governance-findings.integration.test.ts#D-019 finding link records only one exact existing change target

- **WHEN** `finding link <finding-id> --change <change-id>` names a contained plain managed change directory
- **THEN** one immutable linked receipt records that change target and the original Finding remains byte-identical
- **AND** the target change, task scope, origin, Source, Work Item, task HEAD, index, working tree and Grant bytes remain unchanged
- **AND** retry returns the same terminal relation without another receipt

#### Scenario: An observation links to existing work without another inbox item
covers: #Requirement: Finding Link Is a Receipt-Only Relation
test: packages/workflow-engine/test/governance-finding-work-item.integration.test.ts#Finding links an existing Work Item once without creating another inbox item

- **WHEN** a Finding links to an existing Work Item
- **THEN** one create-once receipt names that item without mutating it or creating another
- **AND** an exact retry returns the same relation

### Requirement: Governance Intake Counts Are Read-Only
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

The engine SHALL expose `intakeCounts` with exactly the current `inbox`,
`pendingFindings`, and `backlog` counts in `status`, successful `open-task`
session-start, and `handoff validate` read outputs. Work Item counts SHALL come
from the validated current Work Registry inventory, and pending Finding counts
SHALL cover the validated records visible through the repository Finding ref and available remote-tracking copies. Reading the aggregate MUST NOT create or update a Source,
Finding, disposition, Work Item, tracked projection, or Git ref of its own. It
MAY enter the existing Work Registry read boundary, which can finish one exact
previously prepared crash-recovery transaction before returning current counts.

#### Scenario: One Finding is dismissed
covers: #Requirement: Governance Intake Counts Are Read-Only
test: packages/workflow-engine/test/governance-findings.integration.test.ts#Finding disposition is append-only and runtime-wide counts stay read-only

- **WHEN** the repository contains two identity-valid pending Findings and one is dismissed
- **THEN** `pendingFindings` decreases by one while inbox and backlog counts remain exact
- **AND** every original Finding and tracked repository byte remains unchanged

## ADDED Requirements

### Requirement: Selected Source Corrections Update Active Provenance Recoverably
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-0408dddc65a5758a691e9983cf58bd2ce8d4e57fdda050921ef8ae52c9cf008d, SRC-97b40d0f3a0dafef3ba209328634e01914d7eb7167b7b77846df66d7465f034c]

`correct <work-item-id> <old-SRC-id> <original-text>` SHALL preserve the exact new wording in a Source superseding the selected existing Source. It SHALL replace that reference only on the selected open Work Item, make its interpretation agent-derived and preserve every immutable Source. If the item is active, the same recoverable journal and compare-and-swap transaction SHALL update its origin. References still used by another linked Work Item MUST remain in that shared origin. A later `accept` MAY confirm the changed interpretation without changing backlog or active stage; exact correction retries SHALL preserve that subsequent confirmation.

Intake mutation responses SHALL expose canonical original wording and readable Work Item titles while retaining structured identities. A captured correction left by an interruption MAY be reused when its predecessor and exact wording match.


#### Scenario: Correcting active work preserves history and permits fresh confirmation
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#correct preserves exact Source history, replaces active provenance and can be re-confirmed

- **WHEN** the public correction command replaces a Source on an active item
- **THEN** both Source records stay exact and the item and origin cite the correction
- **AND** accepting the interpretation retains the active stage and subsequent retries preserve that acceptance

#### Scenario: An interrupted correction reuses its captured Source
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#correction reuses captured wording after interruption and reopens backlog interpretation

- **WHEN** correction stops after Source capture and before updating its Work Item
- **THEN** retry reuses the exact superseding Source
- **AND** the open item can obtain a fresh confirmed interpretation

#### Scenario: Paired source updates recover across write boundaries
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#active Source corrections recover after each journal and paired-write crash

- **WHEN** an active correction process stops after journal publication or either paired write
- **THEN** existing transaction recovery converges the selected Work Item and its origin

#### Scenario: Concurrent item edits survive correction rollback
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#correction CAS rolls back its origin update while preserving a concurrent item edit

- **WHEN** a concurrent item edit defeats the correction compare-and-swap
- **THEN** rollback preserves the foreign item and restores only its own origin write

#### Scenario: Mutation outputs retain human-readable wording
covers: #Requirement: Selected Source Corrections Update Active Provenance Recoverably
test: packages/workflow-engine/test/governance-source-correction.integration.test.ts#intake mutation results expose canonical wording and Work Item titles

- **WHEN** intake creates, attaches, links or corrects records
- **THEN** its response exposes the original wording and available Work Item title
