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

- **WHEN** the repository agent-skill surface is validated
- **THEN** both approved OpenSpec skills exist, are listed as `.agents` delivery targets in the OpenSpec asset manifest, and match their canonical Codex skill files byte for byte

#### Scenario: Spectra skill is reintroduced
covers: #Requirement: Repository Agent Skill Surface

- **WHEN** a Spectra-prefixed agent skill exists under `.agents/skills/`
- **THEN** the repository contract fails and identifies the conflicting agent surface

#### Scenario: OpenSpec mirror diverges
covers: #Requirement: Repository Agent Skill Surface

- **WHEN** an approved `.agents` OpenSpec skill differs from its canonical `.codex` source or its manifest final-byte digest
- **THEN** the repository contract fails before the change can pass managed checks

#### Scenario: Agent mirror is omitted from the manifest
covers: #Requirement: Repository Agent Skill Surface

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

- **WHEN** an agent determines the planning and execution workflow from repository instructions
- **THEN** it is directed to OpenSpec for planning and `pnpm workflow` for execution without a Spectra execution path

#### Scenario: Nested Spectra metadata is introduced
covers: #Requirement: Historical Spectra Data Has No Execution Authority

- **WHEN** `.spectra.yaml` exists at `openspec/` or below it
- **THEN** the repository contract fails and the nested metadata grants no lifecycle authority

#### Scenario: Historical root configuration remains
covers: #Requirement: Historical Spectra Data Has No Execution Authority

- **WHEN** the tracked root `.spectra.yaml` is encountered
- **THEN** repository guidance classifies it as historical-only and does not invoke or regenerate Spectra assets

### Requirement: Registered Checks Are the Sole CI Command Authority
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

External CI and local verification SHALL resolve a named check through the versioned workflow check registry and execute it through the repository-owned workflow runner. An adapter command or CI workflow MUST NOT maintain a second command, runner, or path-scope definition for that check.

#### Scenario: GitHub runs the formatting check
covers: #Requirement: Registered Checks Are the Sole CI Command Authority

- **WHEN** the GitHub formatting job invokes its local verification entry point
- **THEN** the workflow engine resolves `workflow-format` from `workflow/checks.json`
- **THEN** the registered command and path scope are executed

#### Scenario: Task runs generated-asset validation
covers: #Requirement: Registered Checks Are the Sole CI Command Authority

- **WHEN** a managed task or CI evidence set requires `openspec-assets`
- **THEN** the workflow engine resolves it from `workflow/checks.json`
- **THEN** the registered command is the only task-level OpenSpec asset validation command executed

#### Scenario: Historical definition is replayed
covers: #Requirement: Registered Checks Are the Sole CI Command Authority

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

- **WHEN** an operator executes a known non-destructive check in a clean checkout
- **THEN** the engine executes the registered command through its pinned runner
- **THEN** the result identifies the check, outcome, runner digest, and database
  classification

#### Scenario: Check ID is unknown
covers: #Requirement: Standalone Registered Check Execution Is Fail-Closed

- **WHEN** standalone execution names a check absent from the registry
- **THEN** the command fails before spawning a process

#### Scenario: Check is destructive
covers: #Requirement: Standalone Registered Check Execution Is Fail-Closed

- **WHEN** standalone execution names a check marked `destructiveDatabase`
- **THEN** the command fails without accepting database credentials or executing
  the check

#### Scenario: Checkout is dirty or mutated
covers: #Requirement: Standalone Registered Check Execution Is Fail-Closed

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

- **WHEN** the maintainer authority commit removes the archived bootstrap
  planning tree from the registered command
- **THEN** the dual-form contract assertion and every registered check pass
  unchanged

#### Scenario: Ordinary task attempts the same edit
covers: #Requirement: Registered format scope excludes archived bootstrap trees

- **WHEN** an ordinary task changes a required check definition
- **THEN** the engine fails closed at check time and in CI replay

### Requirement: Formatting and Generated Asset Validation Have Disjoint Scope
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The registered `workflow-format` check SHALL own workflow-engine sources and explicitly listed human-maintained policy, schema, package, and governance documents. It MUST exclude the generated OpenSpec asset home. The registered `openspec-assets` check SHALL be the task-level validity authority for that generated asset home and every delivered target.

#### Scenario: Human-maintained workflow files are formatted
covers: #Requirement: Formatting and Generated Asset Validation Have Disjoint Scope

- **WHEN** `workflow-format` executes after the authority transition
- **THEN** it checks each declared human-maintained workflow policy and schema path
- **AND** it does not traverse `workflow/openspec-assets/`

#### Scenario: Generated assets are validated
covers: #Requirement: Formatting and Generated Asset Validation Have Disjoint Scope

- **WHEN** a task guard requires `openspec-assets`
- **THEN** the workflow runner executes the registered read-only asset check
- **AND** managed evidence and CI use that same registered definition without an alternate formatter scope

#### Scenario: Ordinary task changes required check ownership
covers: #Requirement: Formatting and Generated Asset Validation Have Disjoint Scope

- **WHEN** an ordinary task edits a check definition required by its policy or guard
- **THEN** task authorization and CI replay fail closed

### Requirement: Valid Repository Code Ownership
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Every CODEOWNER assigned to a protected repository path SHALL resolve to an
existing GitHub user or team with explicit write access to the repository. The
repository MUST retain an ownership rule for the CODEOWNERS file itself.

#### Scenario: Configured owner is eligible
covers: #Requirement: Valid Repository Code Ownership

- **GIVEN** the repository ownership file assigns a protected path to an owner
- **WHEN** GitHub validates the CODEOWNERS file on the default branch
- **THEN** the owner resolves without a CODEOWNERS diagnostic
- **AND** the owner has explicit write access to the repository

#### Scenario: Configured owner is unknown or ineligible
covers: #Requirement: Valid Repository Code Ownership

- **GIVEN** an ownership entry names a missing user, hidden team, or identity
  without explicit write access
- **WHEN** repository governance is reviewed for activation
- **THEN** remote enforcement remains inactive
- **AND** the invalid ownership entry is corrected through a managed change

### Requirement: Maintainer-Aware Pull Request Enforcement
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The protected default branch SHALL require pull requests, the strict
`workflow-assurance` status check against an up-to-date base, and no bypass.
Code-owner approval with stale-review dismissal SHALL additionally be required
only when at least two independent eligible human maintainers exist.

#### Scenario: Repository has one eligible human maintainer
covers: #Requirement: Maintainer-Aware Pull Request Enforcement

- **GIVEN** the pull-request author is the repository's only eligible human
  maintainer
- **WHEN** protected-branch rules are configured
- **THEN** zero approving reviews are required
- **AND** code-owner review and stale-review dismissal are disabled
- **AND** pull-request, strict status-check, current-base, and no-bypass rules
  remain enforced

#### Scenario: Repository has an independent eligible reviewer
covers: #Requirement: Maintainer-Aware Pull Request Enforcement

- **GIVEN** at least two independent eligible human maintainers exist
- **WHEN** protected-branch rules are configured
- **THEN** a code-owner approval from an eligible human other than the author
  is required
- **AND** new reviewable pushes dismiss stale approval

### Requirement: Staged Governance Activation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Remote merge enforcement SHALL be activated only after a valid
CODEOWNERS file is present on the default branch and GitHub reports no
CODEOWNERS diagnostics. Activation evidence MUST include the effective ruleset
state and a pull request whose required `workflow-assurance` check is enforced.

#### Scenario: Valid ownership reaches the base
covers: #Requirement: Staged Governance Activation

- **GIVEN** the valid ownership configuration has merged into the default branch
- **AND** GitHub reports no CODEOWNERS errors for that branch
- **WHEN** the maintainer activates the repository ruleset
- **THEN** the configured solo- or multi-maintainer review policy becomes
  effective
- **AND** an archive pull request proves the required status check before
  workflow support is declared

### Requirement: Credential-Free Assurance Checkout Compatibility
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The pull-request assurance workflow SHALL check out the exact event head with
full reachable history without persisting repository credentials. The exact
event head and credential-free checkout properties MUST remain hard
preconditions for executing repository-controlled assurance commands.

#### Scenario: Exact event head is checked out safely
covers: #Requirement: Credential-Free Assurance Checkout Compatibility

- **WHEN** pull-request assurance prepares the candidate repository
- **THEN** the pinned checkout resolves the exact event head with full
  reachable history
- **AND** repository credentials are not persisted for later commands

#### Scenario: Safe checkout cannot be established
covers: #Requirement: Credential-Free Assurance Checkout Compatibility

- **WHEN** the assurance environment cannot establish the exact event head,
  full reachable history, or credential-free checkout
- **THEN** assurance fails before repository-controlled commands execute
- **AND** no compatibility fallback weakens any of those properties

### Requirement: Authority maintenance is a fourth managed commit kind
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]
Repository governance SHALL recognize task, plan, archive, and
authority-maintenance as the complete mutually exclusive managed commit kinds.

#### Scenario: Authority trailers are canonical
covers: #Requirement: Authority maintenance is a fourth managed commit kind
- **WHEN** the workflow engine creates an authority-maintenance commit
- **THEN** its final trailer block contains exactly `Change`, `Transition: authority-maintenance`, and `Grant` in canonical order

#### Scenario: Ordinary managed semantics remain unchanged
covers: #Requirement: Authority maintenance is a fourth managed commit kind
- **WHEN** CI validates task, plan, or archive commits after authority-maintenance support is installed
- **THEN** their existing trailer, scope, ordering, completion, and replay semantics remain unchanged

### Requirement: Authority verification is base-owned
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]
The required workflow-assurance job MUST execute authority and attestation
verification code and load signer, policy, phase, immutable-path trust, and
historical replay rules from the exact pull-request base or authority commit
parent rather than the candidate branch. The base-owned verifier MUST reject a
protected-main authority commit that lacks a unique valid retained signed
original and explicit grant-base mappings.

#### Scenario: Candidate modifies its verifier
covers: #Requirement: Authority verification is base-owned
- **WHEN** a candidate authority commit changes verifier or trust-loading code
- **THEN** the base-owned verifier applies the previous trusted rules to that commit before the candidate code can become authoritative

#### Scenario: All normal checks remain required
covers: #Requirement: Authority verification is base-owned
- **WHEN** an authority-maintenance commit is otherwise valid
- **THEN** workflow-assurance still runs the complete check set required by trusted policy and the active change

#### Scenario: Historical main authority is replayed
covers: #Requirement: Authority verification is base-owned
- **WHEN** workflow-assurance evaluates a pull request whose base first-parent history contains a rebase-produced authority commit
- **THEN** base-owned code verifies the protected attestation, retained signed original, exact transition identity, grant lineage, and protected-main reachability before evaluating candidate commits

#### Scenario: Candidate supplies missing history evidence
covers: #Requirement: Authority verification is base-owned
- **WHEN** an attestation, signer, original object, or mapping is available only from candidate-controlled history or trust material
- **THEN** workflow-assurance rejects it as candidate-self-authorized evidence

### Requirement: Authority audit prerequisites remain maintainer-owned
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]
Repository documentation SHALL distinguish checked-in enforcement from GitHub
grant-tag and attestation-tag protection, protected-environment approval,
required-check configuration, human-present signing, and
repository-administrator recovery that only a maintainer can prove. Sealed
support MUST remain undeclared until those remote controls and complete
historical attestation replay are independently evidenced.

#### Scenario: Repository files are merged before remote controls
covers: #Requirement: Authority audit prerequisites remain maintainer-owned
- **WHEN** the implementation is present but grant-tag protection, attestation-tag protection, historical migration, or the sealed approval environment has not been independently verified
- **THEN** project status describes maintainer mode as bootstrap-only and does not claim sealed enforcement

#### Scenario: Attestation migration is remotely proven
covers: #Requirement: Authority audit prerequisites remain maintainer-owned
- **WHEN** the maintainer protects and publishes the migration tag and a later pull request passes the base-owned historical replay without bypass
- **THEN** retained evidence may mark authority tree attestation proven while environment, signer, and sealed-transition gates remain separate

### Requirement: Archive-Stable Semantic Handoff
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The generated semantic handoff SHALL preserve an explicitly selected completed
change when its tracked OpenSpec contract moves from the active change root to
the immutable archive, and normal hooks SHALL validate the same semantic
projection without local runtime evidence.

#### Scenario: Selected completed change is archived among multiple active changes
covers: #Requirement: Archive-Stable Semantic Handoff

- **WHEN** the selected completed change has exactly one valid tracked archive
  contract and two or more unrelated active changes remain
- **THEN** handoff rendering and validation preserve the selected semantic
  change without choosing an unrelated active change
- **AND** the completed focus and references remain valid before and after the
  archive move

#### Scenario: New managed change takes ownership
covers: #Requirement: Archive-Stable Semantic Handoff

- **WHEN** the selected change is archived and the current named branch exactly
  matches a valid active `work/<change-id>` change
- **THEN** the handoff selects that branch-bound active change through the
  normal generated-document transition

#### Scenario: Archived selection is unsafe or ambiguous
covers: #Requirement: Archive-Stable Semantic Handoff

- **WHEN** the selected archived change is missing, duplicated, symlinked,
  malformed, or contains an incomplete task
- **THEN** handoff rendering and validation fail closed without selecting an
  arbitrary active change

### Requirement: Archive base resolves from the protected remote-tracking ref
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Archive eligibility SHALL resolve its verification base from the first
protected branch's remote-tracking ref (`refs/remotes/origin/<branch>`),
using the same protected-base ref spelling as maintainer attestation.
Resolution MUST remain fail-closed, and CI archive replay — which binds to
the archive parent — MUST be unaffected.

#### Scenario: Stale local branch no longer blocks archive
covers: #Requirement: Archive base resolves from the protected remote-tracking ref

- GIVEN the local protected branch is behind the remote-tracking ref
- AND every canonical task commit is reachable from the remote-tracking ref
- WHEN archive eligibility runs
- THEN the base resolves from the remote-tracking ref
- AND the archive is not blocked by the stale local branch

#### Scenario: Unresolvable base fails closed
covers: #Requirement: Archive base resolves from the protected remote-tracking ref

- GIVEN the protected branch's remote-tracking ref does not resolve to a
  commit
- WHEN archive eligibility runs
- THEN it fails with the archive base resolution error

#### Scenario: Task commit off the base is still rejected
covers: #Requirement: Archive base resolves from the protected remote-tracking ref

- GIVEN a canonical task commit is not reachable from the protected
  remote-tracking ref
- WHEN archive eligibility runs
- THEN it fails closed on unreachable task evidence

#### Scenario: One shared spelling across authority paths
covers: #Requirement: Archive base resolves from the protected remote-tracking ref

- GIVEN maintainer attestation and archive eligibility both resolve the
  protected base
- WHEN either resolves the protected branch ref
- THEN both use the identical `refs/remotes/origin/<branch>` spelling from a
  single shared definition
