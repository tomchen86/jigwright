# Repository contracts
capabilities: [agent-skill-governance, ci-check-authority, repository-governance]

## Purpose

Keep repository governance, reviewed agent entry points, and registered check execution consistent across source packages and repository configuration.
## Requirements
### Requirement: Repository Agent Skill Surface
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The repository SHALL expose `openspec-explore` and `openspec-propose` as its managed SDD skills under `.agents/skills/`. Each skill MUST be a manifest-governed mirror that is byte-identical to its canonical counterpart under `.codex/skills/`. The repository MUST NOT track or retain Spectra agent-skill entries under `.agents/skills/`.

#### Scenario: Approved OpenSpec skill mirrors are present
covers: #Requirement: Repository Agent Skill Surface
test: packages/workflow-engine/test/public-contract-surface.test.ts#repository exposes only reviewed planning and workflow routing skills

- **WHEN** the repository agent-skill surface is validated
- **THEN** both approved OpenSpec skills exist, are listed as `.agents` delivery targets in the OpenSpec asset manifest, and match their canonical Codex skill files byte for byte

#### Scenario: Spectra skill is reintroduced
covers: #Requirement: Repository Agent Skill Surface
test: packages/workflow-engine/test/public-contract-surface.test.ts#repository exposes only reviewed planning and workflow routing skills

- **WHEN** a Spectra-prefixed agent skill exists under `.agents/skills/`
- **THEN** the repository contract fails and identifies the conflicting agent surface

#### Scenario: OpenSpec mirror diverges
covers: #Requirement: Repository Agent Skill Surface
test: packages/workflow-engine/test/openspec-planning-assets.integration.test.ts#source, overlay, final, target, and mirror drift all fail closed

- **WHEN** an approved `.agents` OpenSpec skill differs from its canonical `.codex` source or its manifest final-byte digest
- **THEN** the repository contract fails before the change can pass managed checks

#### Scenario: Agent mirror is omitted from the manifest
covers: #Requirement: Repository Agent Skill Surface
test: packages/workflow-engine/test/openspec-planning-assets.integration.test.ts#schema-v2 manifest structure and final pins fail closed

- **WHEN** either approved `.agents` skill is absent from the manifest delivery closure
- **THEN** generated-asset validation fails even if a separate byte copy exists in the worktree

### Requirement: Historical Spectra Data Has No Execution Authority
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The tracked root `.spectra.yaml` MUST be treated only as historical
compatibility data. Agent instructions and maintenance guidance MUST prohibit
Spectra commands, skills, adapters, generated lifecycle assets, and lifecycle
state from authorizing repository work. Nested `.spectra.yaml` metadata MUST
NOT exist under `openspec/`.

#### Scenario: Agent reads repository governance
covers: #Requirement: Historical Spectra Data Has No Execution Authority
test: packages/workflow-engine/test/public-contract-surface.test.ts#repository exposes only reviewed planning and workflow routing skills

- **WHEN** an agent determines the planning and execution workflow from repository instructions
- **THEN** it is directed to OpenSpec for planning and `pnpm workflow` for execution without a Spectra execution path

#### Scenario: Nested Spectra metadata is introduced
covers: #Requirement: Historical Spectra Data Has No Execution Authority
test: packages/workflow-engine/test/public-contract-surface.test.ts#repository exposes only reviewed planning and workflow routing skills

- **WHEN** `.spectra.yaml` exists at `openspec/` or below it
- **THEN** the repository contract fails and the nested metadata grants no lifecycle authority

#### Scenario: Historical root configuration remains
covers: #Requirement: Historical Spectra Data Has No Execution Authority
test: packages/workflow-engine/test/public-contract-surface.test.ts#repository exposes only reviewed planning and workflow routing skills

- **WHEN** the tracked root `.spectra.yaml` is encountered
- **THEN** repository guidance classifies it as historical-only and does not invoke or regenerate Spectra assets

### Requirement: Registered Checks Are the Sole CI Command Authority
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

External CI and local verification SHALL resolve a named check through the versioned workflow check registry and execute it through the repository-owned workflow runner. An adapter command or CI workflow MUST NOT maintain a second command, runner, or path-scope definition for that check.

#### Scenario: GitHub runs the formatting check
covers: #Requirement: Registered Checks Are the Sole CI Command Authority
test: packages/workflow-engine/test/public-contract-surface.test.ts#format verification delegates to the registered canonical authority

- **WHEN** the GitHub formatting job invokes its local verification entry point
- **THEN** the workflow engine resolves `workflow-format` from `workflow/checks.json`
- **THEN** the registered command and path scope are executed

#### Scenario: Task runs generated-asset validation
covers: #Requirement: Registered Checks Are the Sole CI Command Authority
test: packages/workflow-engine/test/check-registry-package-boundaries.contract.test.ts#registered OpenSpec asset validation runs the read-only authority without an alternate formatter

- **WHEN** a managed task or CI evidence set requires `openspec-assets`
- **THEN** the workflow engine resolves it from `workflow/checks.json`
- **THEN** the registered command is the only task-level OpenSpec asset validation command executed

#### Scenario: Historical definition is replayed
covers: #Requirement: Registered Checks Are the Sole CI Command Authority
test: packages/workflow-engine/test/ci.integration.test.ts#registered format and asset definitions activate in planning and replay from committed evidence

- **WHEN** historical task evidence references `workflow-format` or `openspec-assets`
- **THEN** replay continues to use the definition committed with that evidence
- **THEN** the CI adapter introduces no alternate formatting or asset-validation scope

### Requirement: Standalone Registered Check Execution Is Fail-Closed
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow CLI SHALL allow exactly one registered non-destructive check to be
executed by ID against a clean current checkout. It MUST pin the registered
runner, bind execution to current HEAD, reject unknown or destructive checks,
reject checkout mutation, and return structured evidence without granting task,
completion, staging, commit, or archive authority.

#### Scenario: Registered non-destructive check passes
covers: #Requirement: Standalone Registered Check Execution Is Fail-Closed
test: packages/workflow-engine/test/session-check.integration.test.ts#registered check execution returns pinned non-destructive evidence

- **WHEN** an operator executes a known non-destructive check in a clean checkout
- **THEN** the engine executes the registered command through its pinned runner
- **THEN** the result identifies the check, outcome, runner digest, and database
  classification

#### Scenario: Check ID is unknown
covers: #Requirement: Standalone Registered Check Execution Is Fail-Closed
test: packages/workflow-engine/test/session-check.integration.test.ts#registered check execution rejects unknown and destructive checks

- **WHEN** standalone execution names a check absent from the registry
- **THEN** the command fails before spawning a process

#### Scenario: Check is destructive
covers: #Requirement: Standalone Registered Check Execution Is Fail-Closed
test: packages/workflow-engine/test/session-check.integration.test.ts#registered check execution rejects unknown and destructive checks

- **WHEN** standalone execution names a check marked `destructiveDatabase`
- **THEN** the command fails without accepting database credentials or executing
  the check

#### Scenario: Checkout is dirty or mutated
covers: #Requirement: Standalone Registered Check Execution Is Fail-Closed
test: packages/workflow-engine/test/session-check.integration.test.ts#registered check execution rejects dirty and mutated checkouts

- **WHEN** the checkout is dirty before execution or the check changes it
- **THEN** the command fails and produces no authoritative passing result

### Requirement: Registered format scope excludes archived bootstrap trees
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The registered `workflow-format` check command SHALL NOT name the planning
tree of an archived change. Retiring such an entry is a maintainer authority
edit to `workflow/checks.json` through a break-glass grant, and the rebased
authority commit MUST be attested before the next pull request is evaluated.

#### Scenario: Bootstrap path is retired
covers: #Requirement: Registered format scope excludes archived bootstrap trees
test: packages/workflow-engine/test/public-contract-surface.test.ts#format verification delegates to the registered canonical authority

- **WHEN** the maintainer authority commit removes the archived bootstrap
  planning tree from the registered command
- **THEN** the dual-form contract assertion and every registered check pass
  unchanged

#### Scenario: Ordinary task attempts the same edit
covers: #Requirement: Registered format scope excludes archived bootstrap trees
test: packages/workflow-engine/test/ci.integration.test.ts#ordinary required-check edits fail at check time and CI replay

- **WHEN** an ordinary task changes a required check definition
- **THEN** the engine fails closed at check time and in CI replay

### Requirement: Formatting and Generated Asset Validation Have Disjoint Scope
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The registered `workflow-format` check SHALL own workflow-engine sources and explicitly listed human-maintained policy, schema, package, and governance documents. It MUST exclude the generated OpenSpec asset home. The registered `openspec-assets` check SHALL be the task-level validity authority for that generated asset home and every delivered target.

#### Scenario: Human-maintained workflow files are formatted
covers: #Requirement: Formatting and Generated Asset Validation Have Disjoint Scope
test: packages/workflow-engine/test/public-contract-surface.test.ts#format verification delegates to the registered canonical authority

- **WHEN** `workflow-format` executes after the authority transition
- **THEN** it checks each declared human-maintained workflow policy and schema path
- **AND** it does not traverse `workflow/openspec-assets/`

#### Scenario: Generated assets are validated
covers: #Requirement: Formatting and Generated Asset Validation Have Disjoint Scope
test: packages/workflow-engine/test/check-registry-package-boundaries.contract.test.ts#registered OpenSpec asset validation runs the read-only authority without an alternate formatter

- **WHEN** a task guard requires `openspec-assets`
- **THEN** the workflow runner executes the registered read-only asset check
- **AND** managed evidence and CI use that same registered definition without an alternate formatter scope

#### Scenario: Ordinary task changes required check ownership
covers: #Requirement: Formatting and Generated Asset Validation Have Disjoint Scope
test: packages/workflow-engine/test/ci.integration.test.ts#ordinary required-check edits fail at check time and CI replay

- **WHEN** an ordinary task edits a check definition required by its policy or guard
- **THEN** task authorization and CI replay fail closed

### Requirement: Credential-Free Assurance Checkout Compatibility
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The pull-request assurance workflow SHALL check out the exact event head with
full reachable history without persisting repository credentials. The exact
event head and credential-free checkout properties MUST remain hard
preconditions for executing repository-controlled assurance commands.

#### Scenario: Exact event head is checked out safely
covers: #Requirement: Credential-Free Assurance Checkout Compatibility
test: packages/workflow-engine/test/ci.integration.test.ts#workflow assurance CI is read-only and policy paths have owners

- **WHEN** pull-request assurance prepares the candidate repository
- **THEN** the pinned checkout resolves the exact event head with full
  reachable history
- **AND** repository credentials are not persisted for later commands

#### Scenario: Safe checkout cannot be established
covers: #Requirement: Credential-Free Assurance Checkout Compatibility
test: packages/workflow-engine/test/ci.integration.test.ts#workflow assurance CI is read-only and policy paths have owners

- **WHEN** the assurance environment cannot establish the exact event head,
  full reachable history, or credential-free checkout
- **THEN** assurance fails before repository-controlled commands execute
- **AND** no compatibility fallback weakens any of those properties

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

### Requirement: Archive base resolves from the selected protected ref
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-7f4a02c3f1a74cd4fc7265248dbeffda01979e4193c30e8ff32372000f3f11f2]

Planning, archive eligibility, and the maintainer protected-base reader SHALL
select the Grant-initialized `refs/jigwright/protected-base` when it exists.
Otherwise they SHALL use the first protected branch's remote-tracking ref
(`refs/remotes/origin/<branch>`), without falling back to a local branch or
inventing remote publication. Resolution MUST require an actual commit, and
CI archive replay — which binds to the archive parent — MUST be unaffected.

Both modes SHALL require the selected base to be an ancestor of the archive
candidate. Remote mode SHALL retain its requirement that every canonical task
commit already be reachable from the remote base. Local mode SHALL verify
those task commits against the candidate HEAD with the same completion,
planning, review, and document evidence. Successful local archive SHALL
atomically advance the work branch and the local protected ref to the archive
commit using both observed old commits as compare-and-swap expectations.
Its report SHALL retain the local base binding. Retry SHALL verify that the
local ref still contains the exact archived commit without overwriting a
competing ref or claiming a remote effect.

#### Scenario: Stale local branch no longer blocks archive
covers: #Requirement: Archive base resolves from the selected protected ref
test: packages/workflow-engine/test/archive-eligibility.integration.test.ts#archive eligibility resolves the base from the protected remote-tracking ref

- GIVEN the local protected branch is behind the remote-tracking ref
- AND every canonical task commit is reachable from the remote-tracking ref
- WHEN archive eligibility runs
- THEN the base resolves from the remote-tracking ref
- AND the archive is not blocked by the stale local branch

#### Scenario: Unresolvable base fails closed
covers: #Requirement: Archive base resolves from the selected protected ref
test: packages/workflow-engine/test/archive-eligibility.integration.test.ts#archive eligibility fails closed when the remote-tracking base is unresolvable

- GIVEN the protected branch's remote-tracking ref does not resolve to a
  commit
- WHEN archive eligibility runs
- THEN it fails with the archive base resolution error

#### Scenario: Task commit off the base is still rejected
covers: #Requirement: Archive base resolves from the selected protected ref
test: packages/workflow-engine/test/archive-eligibility.integration.test.ts#archive eligibility rejects task evidence not reachable from configured base

- GIVEN a canonical task commit is not reachable from the protected
  remote-tracking ref
- WHEN archive eligibility runs
- THEN it fails closed on unreachable task evidence

#### Scenario: One shared spelling across authority paths
covers: #Requirement: Archive base resolves from the selected protected ref
test: packages/workflow-engine/test/archive-eligibility.integration.test.ts#archive and attestation resolve the same configured protected ref without local fallback

- GIVEN no local protected base has been selected and maintainer attestation
  and archive eligibility both resolve the protected base
- WHEN either resolves the protected branch ref
- THEN both use the identical `refs/remotes/origin/<branch>` spelling from a
  single shared definition

#### Scenario: Local archive publishes verified work-branch history
covers: #Requirement: Archive base resolves from the selected protected ref
test: packages/workflow-engine/test/archive-transition.integration.test.ts#local protected base archives unmerged managed tasks and advances both refs idempotently

- **GIVEN** the local protected base remains at the initial floor and the completed managed task commits exist only on the work branch
- **WHEN** native archive verifies and commits that change
- **THEN** one Git transaction advances the work branch and local protected base to the same archive commit
- **AND** exact retry returns the same archive evidence without a remote or tracking scaffold

#### Scenario: A competing local base cannot be overwritten
covers: #Requirement: Archive base resolves from the selected protected ref
test: packages/workflow-engine/test/archive-transition.integration.test.ts#local protected-base drift rolls back archive without overwriting either ref

- **WHEN** the local protected ref changes before archive compare-and-swap
- **THEN** neither ref is updated by the failed transaction
- **AND** archive restores its uncommitted projection and preserves the competing ref

### Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
sources: [SRC-5a56b9d773c073a429dfbc7d271fdd00d18d873752bb86ca0540662433bfb1ba, SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The shipped GitHub archive adapter SHALL bind a hosted ruleset observation to the exact repository and protected-base commit, authenticated evidence, observation lifetime and canonical digest. Its production observer SHALL read applicable active rulesets and require the existing `workflow-assurance` check and absence of bypass actors. A disabled, expired, unauthenticated or differently bound observation MUST NOT be accepted as current evidence. These checks do not establish CODEOWNERS eligibility or activate a hosted review policy. A local archive preparation SHALL retain an explicit unobserved remote state and pending operational gate until separate remote evidence exists.

#### Scenario: The production observer derives authenticated ruleset facts
covers: #Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
test: packages/workflow-engine/test/archive-publication-adapters.integration.test.ts#production ruleset observer authenticates a current no-bypass workflow-assurance ruleset

- **WHEN** the configured observer reads active applicable rulesets through its authenticated GitHub boundary
- **THEN** its result binds the protected base, required check, zero bypass actors and bounded observation lifetime
- **AND** unavailable credentials do not produce an observation

#### Scenario: The adapter preserves the exact observer binding
covers: #Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
test: packages/github-adapter/test/archive-pull-request.test.ts#ruleset observation is injected, authenticated, exact, and current

- **WHEN** archive publication requests an observation for a protected base
- **THEN** the configured observer receives that exact repository, branch and commit
- **AND** the adapter preserves the validated observation facts

#### Scenario: Missing or invalid hosted observations remain unavailable
covers: #Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
test: packages/github-adapter/test/archive-pull-request.test.ts#ruleset observation fails closed when disabled, stale, replayed, or unauthenticated

- **WHEN** the observer is disabled or its evidence is expired, unauthenticated or bound to another base
- **THEN** the adapter rejects the observation instead of inferring hosted enforcement from repository files

#### Scenario: Local archive preparation does not imply a remote result
covers: #Requirement: Hosted Enforcement Observations Remain Exact and Separate From Local Preparation
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#archive-pr dry-run creates only a local canonical preparation and reports the remote gate pending

- **WHEN** the archive dry-run creates a valid local preparation
- **THEN** it reports `remoteState: not-observed` and a pending operational gate
- **AND** it makes no remote calls or claims that a hosted pull request passed

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

### Requirement: Semantic Handoff Follows Tracked Change State

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The generated semantic handoff SHALL derive change, task, focus, blocker, and reference state from current tracked change contracts and managed routing, including an explicit change selected by an engine-owned lifecycle transition. Existing handoff text and a checked-out branch name MUST NOT create selection authority.

Without managed routing or an explicit lifecycle selection, rendering SHALL select the sole unfinished active change, represent no unfinished active changes explicitly, and reject multiple unfinished changes rather than choosing one arbitrarily. Moving a completed contract into the archive SHALL NOT preserve an obsolete selection from generated output. Managed routing SHALL retain its tracked primary selection and distinguish work awaiting archive from archived work. Committed validation SHALL reproduce the semantic projection without private runtime evidence.

#### Scenario: Archiving a completed change does not preserve stale output selection

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/handoff.integration.test.ts#handoff ignores its previous output and selects the sole active change

- **GIVEN** the handoff names a completed change and one other change has unfinished tasks
- **WHEN** the completed contract moves into the archive
- **THEN** rendering before and after the move selects the same unfinished change
- **AND** validation accepts that projection independently of the old handoff selection

#### Scenario: A branch name cannot resolve ambiguous active work

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/handoff.integration.test.ts#a work branch cannot resolve an otherwise ambiguous handoff

- **GIVEN** multiple unfinished changes have no managed routing selection
- **WHEN** the checked-out branch names one of those changes
- **THEN** rendering reports the ambiguous handoff instead of choosing that change

#### Scenario: Managed routing preserves focus across an archive move

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/change-routing.integration.test.ts#managed routing projects mixed repository state and recovers idempotently

- **GIVEN** tracked routing selects a primary change among blocked, resumable, and completed changes
- **WHEN** a completed contract moves from pending archival into the archive
- **THEN** routing recognizes the archived state and retains the same primary change
- **AND** the generated handoff derives its work categories from the managed routing facts

#### Scenario: Committed routing replays without private runtime

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/change-routing.integration.test.ts#committed routing and handoff replay without private runtime

- **GIVEN** the tracked routing and semantic handoff were committed
- **WHEN** committed repository validation runs after private runtime is removed
- **THEN** it reconstructs the same tracked change selection and accepts the projection

#### Scenario: An archived last change leaves an explicit terminal handoff

covers: #Requirement: Semantic Handoff Follows Tracked Change State
test: packages/workflow-engine/test/handoff.integration.test.ts#committed managed-document validation replays a terminal handoff with zero active changes

- **GIVEN** the last active change has moved into the dated archive
- **WHEN** the terminal semantic handoff is committed and private runtime is removed
- **THEN** committed validation reports zero active changes and accepts the managed handoff
