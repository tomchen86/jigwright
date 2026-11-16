# Provider Orchestration
capabilities: [managed-provider-orchestration]

## Purpose

Bind provider execution to reviewed adapters, honest actor identity, role independence, exact invocations, and unchanged read-only source projections.

## Requirements

### Requirement: Provider Execution Uses a Reviewed Built-In Registry
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-a0050aa57c1a5f5fd83361c1a033ffc98529ecebf92ad977e73b506ead644ae0, SRC-0af41f94cfd4d4b5de9f5532a58d6e53268916fc1e16aa631569e16895c59dc4, SRC-a56ac1533168972a6383b21bd8ed414ffe5d4360ca14a080cd854f2af5b7af70, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9, SRC-7d9b1c9e61d4f43d2c5c4be96f9ba57cff79e9833ed339aef537334a79ef11ce, SRC-581c9289ce5361d1052b0c507a331b20c6d468b861c03716cb91c7fb8ac56e87, SRC-baa079861a38b5a7932c0e0fdbcca89ca6b73b16a02fedff2084b66f7a55bf98]

The workflow engine SHALL select AI providers only from a reviewed built-in provider registry. The initial registry MUST provide Codex and Claude adapters with declared capabilities.

Repository configuration MAY enable or disable a built-in provider and lower bounded resource policy. It MUST NOT supply a provider ID, executable path, shell fragment, dynamic module path, command template, prompt implementation, or result parser.

#### Scenario: Enabled built-in provider is selected
covers: #Requirement: Provider Execution Uses a Reviewed Built-In Registry
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#ordinary role scheduling uses fresh sessions and preserves explicit provider diversity

- **GIVEN** a registered provider is enabled and supports the required capability
- **WHEN** the scheduler assigns that capability
- **THEN** the engine uses the reviewed built-in adapter

#### Scenario: Repository config supplies a provider command
covers: #Requirement: Provider Execution Uses a Reviewed Built-In Registry
test: packages/workflow-engine/test/ai-adapter-evaluation.integration.test.ts#AI adapter policy changes fail closed instead of enabling a launcher

- **GIVEN** repository configuration contains an executable, shell string, module path, or command template
- **WHEN** provider configuration is validated
- **THEN** validation fails
- **AND** the supplied value cannot become executable authority

#### Scenario: Unknown provider is requested
covers: #Requirement: Provider Execution Uses a Reviewed Built-In Registry
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#built-in provider registry is exact, immutable, and capability-scoped

- **GIVEN** a provider ID is absent from the reviewed registry
- **WHEN** an invocation or role assignment requests it
- **THEN** the request fails before process launch

### Requirement: Built-In Adapters Resolve Only Reviewed Executable Candidates
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-a0050aa57c1a5f5fd83361c1a033ffc98529ecebf92ad977e73b506ead644ae0, SRC-0af41f94cfd4d4b5de9f5532a58d6e53268916fc1e16aa631569e16895c59dc4, SRC-a56ac1533168972a6383b21bd8ed414ffe5d4360ca14a080cd854f2af5b7af70, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9, SRC-7d9b1c9e61d4f43d2c5c4be96f9ba57cff79e9833ed339aef537334a79ef11ce, SRC-581c9289ce5361d1052b0c507a331b20c6d468b861c03716cb91c7fb8ac56e87, SRC-baa079861a38b5a7932c0e0fdbcca89ca6b73b16a02fedff2084b66f7a55bf98]

Each built-in adapter SHALL resolve its provider from code-reviewed platform candidates, canonicalize and inspect the resulting executable, and verify the required version/capability surface. It MUST NOT search caller-controlled `PATH` or accept a repository-provided executable.

#### Scenario: Compatible reviewed candidate exists
covers: #Requirement: Built-In Adapters Resolve Only Reviewed Executable Candidates
test: packages/workflow-engine/test/provider-adapters.integration.test.ts#provider preflight inspects only fixed candidates and records canonical identity

- **GIVEN** one reviewed candidate resolves to a compatible canonical executable
- **WHEN** provider preflight runs
- **THEN** the adapter records the real executable identity and version
- **AND** the provider may be reported available for its reviewed capabilities

#### Scenario: PATH contains a fake provider executable
covers: #Requirement: Built-In Adapters Resolve Only Reviewed Executable Candidates
test: packages/workflow-engine/test/provider-adapters.integration.test.ts#provider preflight inspects only fixed candidates and records canonical identity

- **GIVEN** caller `PATH` contains a fake executable named `codex` or `claude`
- **WHEN** provider preflight runs
- **THEN** the fake PATH entry is not selected

#### Scenario: No compatible candidate exists
covers: #Requirement: Built-In Adapters Resolve Only Reviewed Executable Candidates
test: packages/workflow-engine/test/provider-adapters.integration.test.ts#provider preflight preserves shared executable observation states

- **GIVEN** no reviewed candidate is present and compatible
- **WHEN** provider preflight runs
- **THEN** the provider is reported unavailable
- **AND** no arbitrary fallback is launched

Actor identity resolution and assurance are defined in the [Authority contract](../authority/spec.md#requirement-actor-identity-is-resolved-once-and-reported-honestly). Provider orchestration consumes the resolved identity when assigning roles.

### Requirement: Independence Is Enforced Relative to Roles
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-a0050aa57c1a5f5fd83361c1a033ffc98529ecebf92ad977e73b506ead644ae0, SRC-0af41f94cfd4d4b5de9f5532a58d6e53268916fc1e16aa631569e16895c59dc4, SRC-a56ac1533168972a6383b21bd8ed414ffe5d4360ca14a080cd854f2af5b7af70, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9, SRC-7d9b1c9e61d4f43d2c5c4be96f9ba57cff79e9833ed339aef537334a79ef11ce, SRC-581c9289ce5361d1052b0c507a331b20c6d468b861c03716cb91c7fb8ac56e87, SRC-baa079861a38b5a7932c0e0fdbcca89ca6b73b16a02fedff2084b66f7a55bf98]

The workflow engine SHALL express every role-separation requirement at an explicit dimension, including principal independence, provider independence, session independence, or no independence. The ordinary Author, Builder, and Reviewer floor SHALL be session independence between logical roles. Blind survey is the Reviewer's sealed pre-anchor turn, not a fourth role or a mandatory alternate-provider call. Repository or caller policy MUST NOT lower the ordinary floor; reviewed risk policy MAY strengthen an exact transition to provider independence. The scheduler MUST satisfy the effective dimension, or pause for an eligible exact Grant whose result remains visibly below that policy.

Provider inequality and session inequality MUST NOT be treated as interchangeable.

#### Scenario: Plan reviewer uses a fresh session
covers: #Requirement: Independence Is Enforced Relative to Roles
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#ordinary role scheduling uses fresh sessions and preserves explicit provider diversity

- **GIVEN** provider A authored the plan and ordinary review policy requires session independence
- **WHEN** the scheduler assigns a reviewer
- **THEN** it selects a fresh eligible session, which may use provider A or another provider
- **AND** records session or provider independence according to the actual assignment

#### Scenario: Reviewer begins with a sealed pre-anchor turn
covers: #Requirement: Independence Is Enforced Relative to Roles
test: packages/workflow-engine/test/investigation-session.integration.test.ts#start seals a manifest-bound blind request before accepting main terms

- **GIVEN** provider A is the investigation author
- **WHEN** the scheduler assigns the Reviewer's survey-purpose pre-anchor turn
- **THEN** it selects a fresh eligible Reviewer session before Author conclusions or Builder transcripts become visible
- **AND** it does not create a fourth logical role

#### Scenario: Repository attempts to lower an ordinary role
covers: #Requirement: Independence Is Enforced Relative to Roles
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#ordinary role scheduling uses fresh sessions and preserves explicit provider diversity

- **GIVEN** repository or caller configuration requests principal-only or no independence for an ordinary role
- **WHEN** role policy is validated
- **THEN** validation fails
- **AND** the ordinary session-independence requirement remains effective

#### Scenario: Same provider uses a fresh authorized session
covers: #Requirement: Independence Is Enforced Relative to Roles
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#same-provider grants require the only callable provider and a fresh engine session

- **GIVEN** the same provider is callable in a fresh engine-spawned session
- **WHEN** the assignment is recorded
- **THEN** it is labeled session-independent
- **AND** it is not labeled provider-independent

#### Scenario: Caller supplies work without a provider session
covers: #Requirement: Independence Is Enforced Relative to Roles
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#no-callable degraded forms record no provider invocation or independence

- **GIVEN** an exact human grant permits caller-supplied degraded work because no adapter is callable
- **WHEN** the role result is recorded
- **THEN** it is labeled with no provider or session independence
- **AND** no engine-spawned provider claim is recorded

### Requirement: Every Provider Call Uses a Bound Typed Invocation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-a0050aa57c1a5f5fd83361c1a033ffc98529ecebf92ad977e73b506ead644ae0, SRC-0af41f94cfd4d4b5de9f5532a58d6e53268916fc1e16aa631569e16895c59dc4, SRC-a56ac1533168972a6383b21bd8ed414ffe5d4360ca14a080cd854f2af5b7af70, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9, SRC-7d9b1c9e61d4f43d2c5c4be96f9ba57cff79e9833ed339aef537334a79ef11ce, SRC-581c9289ce5361d1052b0c507a331b20c6d468b861c03716cb91c7fb8ac56e87, SRC-baa079861a38b5a7932c0e0fdbcca89ca6b73b16a02fedff2084b66f7a55bf98]

Every provider call SHALL use a typed request and result contract bound to invocation identity, nonce, purpose, provider assignment, capability profile, repository, baseline, target, input manifest, output schema, evaluator/policy versions, and resource limits.

A malformed result, mismatched binding, excessive output, timeout, signal, spawn failure, or non-zero exit MUST NOT produce successful evidence.

Survey and PlanReview retries SHALL accept an agent failure assessment and planned action, preserve them in the immutable replacement request, and bind them to its digest. An unknown cause is valid; the engine MUST NOT judge whether the action is sufficiently different. Existing retry envelopes remain readable. Automatic retries SHALL record the observed failure and the selected default action without another model call.

Repeated failure fingerprints SHALL produce an informational warning, not an independent settings-change or early Grant requirement. Ordinary retries SHALL retain the current fixed attempt, reserved runtime, provider, cost, token, repair and deadline budgets and existing state/authorization checks. `job retry-preview` SHALL perform no reservation or dispatch, and `job retry-request --input` SHALL route Survey and PlanReview to their existing owning lifecycle. Unchanged admission inputs SHALL have consistent preview and submit outcomes; exact replays SHALL reuse the durable replacement.

A job-bound, single-use Grant SHALL allow another attempt with the original timeout. It SHALL enumerate every capacity limit that the next reservation would exceed, and only the capacity needed for that reservation. Limits with sufficient capacity SHALL remain absent from the exception. Timeout changes remain optional and existing timeout-changing Grants remain readable. Neither this exception nor a repeated failure SHALL rewrite default provider policy. The approved P08 discussion and additional budget decision are preserved in [the implementation plan](../../../../../docs/research/p08-retry-recovery.md).

#### Scenario: Repeated Survey failures retry through the job entry with an explanation
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/investigation-provider-retry.integration.test.ts#propose retry envelope authorizes one idempotent replacement survey

- **GIVEN** two retryable failures and remaining fixed budget
- **WHEN** the agent supplies its failure assessment and action through job retry-request
- **THEN** the next attempt may retain its timeout and the original failures remain intact
- **AND** replay creates no additional attempt, while changing the explanation makes it a different request

#### Scenario: PlanReview uses the same explained job retry entry
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/investigation-plan-review-retry.integration.test.ts#retries PlanReview with intact invocation and snapshot lineage

- **GIVEN** a failed PlanReview and its recorded snapshot
- **WHEN** the agent submits the job retry preview with an explanation
- **THEN** the owning PlanReview lifecycle preserves snapshot and reservation lineage
- **AND** exact replay reuses the replacement

#### Scenario: One more attempt keeps the original timeout and consumes one Grant
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/execution-replacement.integration.test.ts#a one-attempt Grant keeps the 60 minute timeout and records every extra reservation exactly once

- **GIVEN** four attempts have consumed the fixed reserved budgets
- **WHEN** a single-use Grant explicitly authorizes the next reservation without changing timeout
- **THEN** the fifth attempt retains the 60 minute limit and the explanation
- **AND** crash recovery reuses one receipt and dispatch, leaving default policy unchanged

#### Scenario: A previously signed timeout Grant remains executable
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/execution-replacement.integration.test.ts#an already signed timeout Grant from the repeated-failure gate still executes once

- **GIVEN** a request signed under the previous repeated-failure rule
- **WHEN** the ordinary retry rule now also admits that work
- **THEN** its exact signed request and receipt still publish one replacement
- **AND** replay neither consumes another use nor changes the original signed bytes

#### Scenario: Sufficient capacity requires no extra exception
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/execution-core.contract.test.ts#a one-attempt budget exception lists only exhausted reservation dimensions

- **GIVEN** total attempt count is exhausted while other reservation dimensions have capacity
- **WHEN** the next attempt's exception is computed
- **THEN** only the total attempt count is listed
- **AND** the default policy remains unchanged

#### Scenario: Provider returns a mismatched nonce
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/provider-execution-wire.contract.test.ts#provider results reject every mismatched request binding

- **GIVEN** an invocation request contains one nonce
- **WHEN** the provider result contains another nonce
- **THEN** the result is rejected
- **AND** no successful lifecycle evidence is created

#### Scenario: Provider returns the wrong target
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/provider-execution-wire.contract.test.ts#provider results reject every mismatched request binding

- **GIVEN** an invocation is bound to one target and manifest
- **WHEN** the result names a different target or manifest
- **THEN** the result is rejected as unbound output

#### Scenario: Provider process fails
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/investigation-provider-retry.integration.test.ts#failed provider work can retry without discarding completed main input

- **GIVEN** a process times out, is signaled, exceeds output limits, or exits non-zero
- **WHEN** invocation completion is evaluated
- **THEN** no successful report is created
- **AND** the lifecycle exposes a durable retry, correction, or waiting outcome

#### Scenario: Provider and propose policies remain distinct
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/provider-worker-native-evidence.integration.test.ts#async provider worker completes the exact durable invocation through ProviderWorkerRuntimePort on sha256

- **GIVEN** a propose authorization node and one prepared provider invocation
- **WHEN** the lifecycle launches the invocation
- **THEN** the authorization node remains bound to the code-owned propose policy
- **AND** the provider request is bound to the exact raw adapter-policy digest and its effective lowered limits
- **AND** the authorization node ID links the two authorities without treating either policy digest as the other

#### Scenario: Durable prepared work is dispatched
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/provider-worker.integration.test.ts#provider dispatch is detached and replay targets the stored prepared request

- **GIVEN** a current prepared Reviewer pre-anchor or PlanReview invocation
- **WHEN** the resumable wrapper dispatches provider work
- **THEN** a lifecycle-owned worker claims that exact invocation under a fenced lease
- **AND** it uses the code-owned schema, validator, and fixed built-in adapter for the bound purpose
- **AND** replay does not replace the prepared request merely because a later wrapper process generated a different candidate ID

#### Scenario: Real runner output completes durable invocation state
covers: #Requirement: Every Provider Call Uses a Bound Typed Invocation
test: packages/workflow-engine/test/provider-worker-native-evidence.integration.test.ts#async provider worker completes the exact durable invocation through ProviderWorkerRuntimePort on sha256

- **GIVEN** the built-in runner returns a bound semantic result and unchanged governed projection
- **WHEN** lifecycle completion validates the runner report
- **THEN** the exact durable invocation records the semantic result and its projection, executable-identity, containment, residual, and runtime assurance
- **AND** tracked provider-result evidence retains the durable assurance
- **AND** the lifecycle does not fabricate a fake stdout process envelope to reconstruct success

### Requirement: Read-Only Provider Results Require an Unchanged Governed Projection
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-a0050aa57c1a5f5fd83361c1a033ffc98529ecebf92ad977e73b506ead644ae0, SRC-0af41f94cfd4d4b5de9f5532a58d6e53268916fc1e16aa631569e16895c59dc4, SRC-a56ac1533168972a6383b21bd8ed414ffe5d4360ca14a080cd854f2af5b7af70, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9, SRC-7d9b1c9e61d4f43d2c5c4be96f9ba57cff79e9833ed339aef537334a79ef11ce, SRC-581c9289ce5361d1052b0c507a331b20c6d468b861c03716cb91c7fb8ac56e87, SRC-baa079861a38b5a7932c0e0fdbcca89ca6b73b16a02fedff2084b66f7a55bf98]

Survey and plan-review providers SHALL receive the reviewed repository-read-only capability profile. The engine SHALL compare the governed current-worktree and runtime projection before and after invocation, including the current worktree's symbolic HEAD ref, resolved commit and tree, index, tracked/untracked/ignored worktree manifests, planning artifacts, and governed runtime inputs.

Refs not selected by the current worktree, including other linked-worktree branches, remote-tracking refs, and tags, SHALL remain outside this invocation projection so unrelated concurrent repository activity does not invalidate a bounded result. A lifecycle that consumes one of those refs as authority MUST validate it at that lifecycle's own transition boundary; provider projection equality MUST NOT substitute for that validation.

Any observed drift inside the governed current-worktree or runtime projection, outside the exact engine-owned invocation output, MUST make the result unusable. The resulting claim MUST be limited to observed projection equality and MUST NOT be described as shared-ref integrity or adversarial same-user containment.

#### Scenario: Read-only invocation preserves governed state
covers: #Requirement: Read-Only Provider Results Require an Unchanged Governed Projection
test: packages/workflow-engine/test/provider-runner.integration.test.ts#runner wraps provider-native output only after unchanged governed projection

- **GIVEN** a read-only provider invocation
- **WHEN** before and after governed fingerprints are identical and typed output is valid
- **THEN** the invocation may produce an immutable successful report

#### Scenario: Read-only invocation changes a governed path or current HEAD ref
covers: #Requirement: Read-Only Provider Results Require an Unchanged Governed Projection
test: packages/workflow-engine/test/provider-runner.integration.test.ts#runner derives drift itself and creates no successful provider result

- **GIVEN** a read-only provider invocation
- **WHEN** the current worktree, index, symbolic HEAD ref, resolved commit or tree, planning artifacts, or governed runtime inputs drift
- **THEN** the result is rejected
- **AND** it cannot become review or investigation evidence

#### Scenario: Unrelated shared ref changes concurrently
covers: #Requirement: Read-Only Provider Results Require an Unchanged Governed Projection
test: packages/workflow-engine/test/provider-governed-projection.integration.test.ts#governed refs projection ignores unrelated shared refs during linked-worktree activity

- **GIVEN** another linked worktree or background Git operation changes a ref not selected by the provider invocation's current worktree
- **WHEN** every governed current-worktree and runtime projection category remains unchanged
- **THEN** the result is not rejected solely because that shared ref changed
- **AND** the assurance does not claim that unrelated shared refs remained unchanged

#### Scenario: Assurance is displayed
covers: #Requirement: Read-Only Provider Results Require an Unchanged Governed Projection
test: packages/workflow-engine/test/provider-runner.integration.test.ts#runner wraps provider-native output only after unchanged governed projection

- **GIVEN** a read-only invocation passed observed fingerprint checks
- **WHEN** its assurance is rendered
- **THEN** it reports unchanged governed projection
- **AND** it does not claim proof that the same OS user could not perform unobserved writes

### Requirement: Provider Baselines Preserve the Repository Object Format
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-a0050aa57c1a5f5fd83361c1a033ffc98529ecebf92ad977e73b506ead644ae0, SRC-0af41f94cfd4d4b5de9f5532a58d6e53268916fc1e16aa631569e16895c59dc4, SRC-a56ac1533168972a6383b21bd8ed414ffe5d4360ca14a080cd854f2af5b7af70, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9, SRC-7d9b1c9e61d4f43d2c5c4be96f9ba57cff79e9833ed339aef537334a79ef11ce, SRC-581c9289ce5361d1052b0c507a331b20c6d468b861c03716cb91c7fb8ac56e87, SRC-baa079861a38b5a7932c0e0fdbcca89ca6b73b16a02fedff2084b66f7a55bf98]

Every provider request, propose authorization, durable checkpoint, and resume validator SHALL bind complete Git commit and tree object IDs. The lifecycle SHALL accept the repository-native 40-hex SHA-1 form or 64-hex SHA-256 form consistently and MUST NOT abbreviate, truncate, or silently translate either form.

#### Scenario: Propose runs in a SHA-256 repository
covers: #Requirement: Provider Baselines Preserve the Repository Object Format
test: packages/workflow-engine/test/provider-worker-native-evidence.integration.test.ts#async provider worker completes the exact durable invocation through ProviderWorkerRuntimePort on sha256

- **GIVEN** the repository HEAD, tree, and protected base are 64-hex Git object IDs
- **WHEN** propose starts, dispatches provider work, and resumes from a durable checkpoint
- **THEN** each request, authorization, stored baseline, and output envelope retains the complete 64-hex values
- **AND** the same validators continue to accept complete 40-hex values in a SHA-1 repository

### Requirement: Role Result Admission Distinguishes Provider and Non-Provider Work
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-a0050aa57c1a5f5fd83361c1a033ffc98529ecebf92ad977e73b506ead644ae0, SRC-0af41f94cfd4d4b5de9f5532a58d6e53268916fc1e16aa631569e16895c59dc4, SRC-a56ac1533168972a6383b21bd8ed414ffe5d4360ca14a080cd854f2af5b7af70, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9, SRC-7d9b1c9e61d4f43d2c5c4be96f9ba57cff79e9833ed339aef537334a79ef11ce, SRC-581c9289ce5361d1052b0c507a331b20c6d468b861c03716cb91c7fb8ac56e87, SRC-baa079861a38b5a7932c0e0fdbcca89ca6b73b16a02fedff2084b66f7a55bf98]

The role-result contract SHALL be a closed discriminated union. `ordinary-provider` and `granted-same-provider` results MUST reference an actual engine-spawned bound provider invocation. `granted-caller-supplied` and `direct-human-attestation` results MUST carry the required typed semantic content without creating a provider request or provider-runner report.

All forms SHALL preserve author, participants, actual orchestration, required and achieved independence, exact target, content identity, and any grant/use. The same content-pure admission validator SHALL be callable by live orchestration and CI; runtime launch metadata MAY strengthen an observed provider form but MUST NOT be required to replay caller-supplied or direct-human content.

#### Scenario: Granted same-provider result uses the provider runner
covers: #Requirement: Role Result Admission Distinguishes Provider and Non-Provider Work
test: packages/workflow-engine/test/provider-execution-wire.contract.test.ts#provider requests admit only ordinary or granted same-provider assignments

- **GIVEN** an exact grant permits the only callable provider in a fresh session
- **WHEN** the role runs
- **THEN** the engine creates and validates a bound provider invocation
- **AND** records actual orchestration as engine-spawned and achieved independence as session-independent

#### Scenario: Direct-human result reaches provider scheduling
covers: #Requirement: Role Result Admission Distinguishes Provider and Non-Provider Work
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#no-callable degraded forms record no provider invocation or independence

- **GIVEN** a direct-human signed result is selected for an eligible exact role
- **WHEN** orchestration advances
- **THEN** no provider invocation is prepared or launched
- **AND** the signed typed content enters result admission directly
