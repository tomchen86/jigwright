# Shared workflow contracts
capabilities: [bootstrap-task-evidence, collaboration-continuation-grant, engine-test-fixture-independence, investigation-evidence-and-why, openspec-workflow-integration, planning-tree-hygiene, planning-tree-integrity, planning-tree-repair, post-merge-archive-pr, safe-concurrent-task-worktrees, workflow-assurance]

## Purpose

Define the contracts shared by planning, investigation evidence, managed execution, concurrent workspaces, archive, and their independent replay paths.
## Requirements
### Requirement: Collaboration Grants Are Human-Issued and Exactly Bound
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5cdc4849e2c39d2af2dce4a96fd95b92fac190f87813f6ac59779ece7ab8aafb]

A collaboration continuation grant SHALL be distinct from an authority-maintenance grant. It SHALL require an eligible human issuer at the controlling TTY and MUST bind repository, canonical origin, change, optional task, baseline or target, lifecycle phase, conflicting role pair, available provider or caller, degraded form, reason, expiry, and allowed-use count.

An agent MUST NOT issue, sign, approve, or satisfy controlling-TTY requirements for its own collaboration grant.

#### Scenario: Eligible maintainer issues an exact grant
covers: #Requirement: Collaboration Grants Are Human-Issued and Exactly Bound
test: packages/workflow-engine/test/collaboration-grant.integration.test.ts#collaboration issuance is canonical, domain-separated, and has no authority side effects

- **GIVEN** a transition is waiting for provider-independent assignment
- **WHEN** an eligible human at the controlling TTY issues a grant for the exact facts
- **THEN** the signed grant records its expiry, one use, role conflict, and degraded form
- **AND** it may be considered only for those facts

#### Scenario: Agent attempts to issue its own grant
covers: #Requirement: Collaboration Grants Are Human-Issued and Exactly Bound
test: packages/workflow-engine/test/collaboration-grant.integration.test.ts#collaboration grant CLI requires a controlling TTY and has no unattended escape hatch

- **GIVEN** an agent would benefit from degraded independence
- **WHEN** it attempts issuance without the eligible controlling-TTY human
- **THEN** issuance fails
- **AND** the workflow remains paused

#### Scenario: Grant binding differs from transition
covers: #Requirement: Collaboration Grants Are Human-Issued and Exactly Bound
test: packages/workflow-engine/test/collaboration-grant.integration.test.ts#signed collaboration binding rejects every substituted transition fact

- **GIVEN** a grant binds one repository, change, target, phase, or role pair
- **WHEN** it is presented for different facts
- **THEN** it is rejected

### Requirement: Collaboration Grants Authorize Only Visible Independence Degradation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5cdc4849e2c39d2af2dce4a96fd95b92fac190f87813f6ac59779ece7ab8aafb]

A grant MAY authorize reuse of the only callable provider in a fresh session for one exact role conflict. It MAY instead authorize a typed caller-supplied or direct-human contribution when no provider adapter is callable and policy permits that exact degraded form.

The actual achieved independence and orchestration MUST be recorded. A grant MUST NOT create a false claim that the engine launched an independent agent, and it MUST NOT bypass the search floor, term contributions, union scan, hit dispositions, WHY ledger, required structured review content, challenge disposition, checks, scope, freshness, or managed transition authority.

#### Scenario: Same provider continues in a fresh session
covers: #Requirement: Collaboration Grants Authorize Only Visible Independence Degradation
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#same-provider grants require the only callable provider and a fresh engine session

- **GIVEN** a valid grant authorizes one provider-independence conflict
- **WHEN** the only callable provider runs in a fresh session
- **THEN** the assignment is recorded as degraded and session-independent
- **AND** it is not recorded as provider-independent

#### Scenario: No provider adapter is callable
covers: #Requirement: Collaboration Grants Authorize Only Visible Independence Degradation
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#no-callable degraded forms record no provider invocation or independence

- **GIVEN** a valid grant authorizes caller-supplied or direct-human contribution for an exact transition
- **WHEN** the structured contribution is admitted
- **THEN** it is recorded with no provider or session independence unless independently established
- **AND** the engine does not claim a provider invocation occurred

#### Scenario: Grant is used to omit required review content
covers: #Requirement: Collaboration Grants Authorize Only Visible Independence Degradation
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#grant consumption requires structured survey or review content and retains every assurance obligation

- **GIVEN** plan commit requires a current structured PlanReview
- **AND** a grant authorizes reduced independence
- **WHEN** plan commit is requested without the required review content or eligible direct-human review
- **THEN** plan commit fails
- **AND** the grant does not satisfy review presence by itself

#### Scenario: Grant is used to suppress investigation evidence
covers: #Requirement: Collaboration Grants Authorize Only Visible Independence Degradation
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#grant consumption requires structured survey or review content and retains every assurance obligation

- **GIVEN** a grant is valid for one role conflict
- **WHEN** a transition lacks a current scan, disposition, WHY row, or challenge disposition
- **THEN** the transition fails
- **AND** the grant does not suppress the missing assurance

### Requirement: Granted Role Results Have Exact Distinct Content Forms
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5cdc4849e2c39d2af2dce4a96fd95b92fac190f87813f6ac59779ece7ab8aafb]

The workflow SHALL represent ordinary engine-spawned provider results, granted same-provider engine-spawned results, granted caller-supplied typed results, and direct-human signed attestations as a closed discriminated union. Only the two provider forms MAY create or satisfy a provider invocation request. Caller-supplied or direct-human work MUST NOT fabricate an executable identity, provider session, invocation, or unchanged-provider-projection claim.

Every form MUST bind semantic author, participants, actual orchestration, required and achieved independence, exact transition and target, content parent, output schema/evaluator/policy identities, canonical content digest, and any grant/use. A direct-human attestation MUST additionally carry a separate eligible signature bound to the exact transition, target, result/node identity, and content digest.

#### Scenario: Caller-supplied survey is admitted under a grant
covers: #Requirement: Granted Role Results Have Exact Distinct Content Forms
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#no-callable degraded forms record no provider invocation or independence

- **GIVEN** an exact grant permits caller-supplied survey content because no provider is callable
- **WHEN** the typed result is validated
- **THEN** its structured content may become the survey evidence parent
- **AND** orchestration records caller-supplied with no provider or session independence
- **AND** no provider invocation is recorded

#### Scenario: Direct human reviews an exact plan
covers: #Requirement: Granted Role Results Have Exact Distinct Content Forms
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#direct-human review requires the current explicit signature namespace

- **GIVEN** policy and an exact grant permit direct-human review content
- **WHEN** an eligible human signs the complete bound attestation
- **THEN** the structured PlanReview content may be admitted for that exact target
- **AND** the separate signature, semantic author, transition, target, node/result identity, and content digest remain replayable

#### Scenario: Result form and orchestration conflict
covers: #Requirement: Granted Role Results Have Exact Distinct Content Forms
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#no-callable degraded forms record no provider invocation or independence

- **GIVEN** a caller-supplied or direct-human result claims an engine-spawned provider invocation
- **WHEN** result admission runs
- **THEN** the result is rejected

### Requirement: Grant Use Is Atomic, Bounded, and Replay-Resistant
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5cdc4849e2c39d2af2dce4a96fd95b92fac190f87813f6ac59779ece7ab8aafb]

The workflow engine SHALL reserve and record a grant use atomically at the exact conflicting transition. Reservation authorizes only an attempt. The use SHALL be consumed only after the exact result form and independently derived semantic content pass the shared pure admission validator and match the reserved transition; invalid content SHALL fail the reservation without publishing successful evidence. Expired, revoked, exhausted, consumed, mismatched, failed, or duplicate uses MUST NOT authorize another transition.

Repeated cleanup or inspection MAY be idempotent, but authorization MUST remain bounded by the signed grant.

#### Scenario: Valid grant use is reserved
covers: #Requirement: Grant Use Is Atomic, Bounded, and Replay-Resistant
test: packages/workflow-engine/test/collaboration-grant.integration.test.ts#collaboration store reserves once across worktrees and rejects replay

- **GIVEN** an unexpired grant has one use for the exact transition
- **WHEN** the conflicting assignment begins
- **THEN** the use is atomically reserved and recorded
- **AND** concurrent transitions cannot claim it

#### Scenario: Grant is replayed after consumption
covers: #Requirement: Grant Use Is Atomic, Bounded, and Replay-Resistant
test: packages/workflow-engine/test/collaboration-grant.integration.test.ts#collaboration store reserves once across worktrees and rejects replay

- **GIVEN** a grant use was consumed
- **WHEN** another transition presents the grant
- **THEN** authorization fails

#### Scenario: Reserved result fails content admission
covers: #Requirement: Grant Use Is Atomic, Bounded, and Replay-Resistant
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#invalid content admission terminally fails a reserved grant

- **GIVEN** a use is reserved for one exact degraded transition
- **WHEN** the submitted result has invalid structure, content binding, signature, target, orchestration, or achieved independence
- **THEN** no successful role evidence is published
- **AND** the reservation becomes terminally failed rather than consumed as success

#### Scenario: One grant use appears twice in replayed evidence
covers: #Requirement: Grant Use Is Atomic, Bounded, and Replay-Resistant
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#aggregate grant uses reject a duplicate claim across one subject

- **GIVEN** two tracked evidence records claim the same signed grant and use identity
- **WHEN** aggregate use-set validation runs
- **THEN** validation fails even if each record is individually well formed

#### Scenario: Grant expires or is revoked while unused
covers: #Requirement: Grant Use Is Atomic, Bounded, and Replay-Resistant
test: packages/workflow-engine/test/collaboration-grant.integration.test.ts#expired and revoked collaboration grants never authorize a transition

- **GIVEN** a grant expired or was revoked
- **WHEN** a transition attempts reservation
- **THEN** authorization fails
- **AND** the transition remains paused or requires an eligible provider

### Requirement: Degraded Independence Remains Verifiable Downstream
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5cdc4849e2c39d2af2dce4a96fd95b92fac190f87813f6ac59779ece7ab8aafb]

Every tracked artifact, report, and assurance summary derived from a collaboration-granted transition SHALL identify the signed grant, exact use, admitted result form, actual orchestration, and achieved independence. Plan, task, CI, merge, and archive validation MUST NOT relabel a granted same-provider, caller-supplied, or direct-human result as provider-independent or engine-spawned.

Policy MAY require direct human review for a trust-critical transition even when a grant is otherwise valid.

#### Scenario: Degraded plan reaches CI
covers: #Requirement: Degraded Independence Remains Verifiable Downstream
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#no-callable degraded forms record no provider invocation or independence

- **GIVEN** planning continued under a valid collaboration grant
- **WHEN** local or CI assurance is rendered
- **THEN** the signed grant reference and degraded independence remain visible
- **AND** CI does not upgrade identity, orchestration, or independence claims

#### Scenario: Trust-critical policy requires human review
covers: #Requirement: Degraded Independence Remains Verifiable Downstream
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#grant consumption requires structured survey or review content and retains every assurance obligation

- **GIVEN** a grant authorizes degraded continuation and policy independently requires direct human review
- **WHEN** eligibility is evaluated without that human review
- **THEN** the transition remains blocked
- **AND** the grant is not treated as a substitute

### Requirement: Engine tests are independent of mutable planning state
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Workflow-engine test suites MUST NOT read an active repository change under
`openspec/changes/` as a test fixture. Suites that validate change-shaped
inputs MUST construct synthetic fixtures in temporary repositories.

#### Scenario: Fixture change is archived
covers: #Requirement: Engine tests are independent of mutable planning state
test: packages/workflow-engine/test/openspec-adapter.integration.test.ts#real pinned OpenSpec adapter validates package, schema, status, and change

- **WHEN** any repository change completes its lifecycle and its directory
  moves to the archive container
- **THEN** every registered engine test suite still passes without
  modification

#### Scenario: No active change exists
covers: #Requirement: Engine tests are independent of mutable planning state
test: packages/workflow-engine/test/openspec-adapter.integration.test.ts#real pinned OpenSpec adapter validates package, schema, status, and change

- **WHEN** the repository has zero active changes
- **THEN** the adapter and managed-contract suites still construct and
  validate their own synthetic change fixtures

### Requirement: Pinned adapter validation stays end-to-end
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The adapter suite MUST continue to execute the real pinned OpenSpec CLI
against a schema-valid synthetic change so that package, schema, status, and
change validation remain covered end to end.

#### Scenario: Synthetic change violates the schema
covers: #Requirement: Pinned adapter validation stays end-to-end
test: packages/workflow-engine/test/openspec-adapter.integration.test.ts#real pinned OpenSpec adapter validates package, schema, status, and change

- **WHEN** the synthetic fixture omits a required artifact or breaks the
  repository schema
- **THEN** the pinned CLI validation fails and the test surfaces the exact
  diagnostic

### Requirement: Every Investigation Hit Has Exactly One Effective Disposition
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL organize current search hits into semantic evidence groups and SHALL require every current hit to be covered by exactly one effective disposition.

Each disposition MUST identify its covered hits, complete source blobs, classification, rationale, selector evidence, and explicit exceptions. Ambiguous, missing, or overlapping effective coverage MUST fail closed.

#### Scenario: One group covers related hits
covers: #Requirement: Every Investigation Hit Has Exactly One Effective Disposition
test: packages/workflow-engine/test/class-disposition-mounting.integration.test.ts#one rationale can cover a class of hits a machine can show are alike

- **GIVEN** several current hits belong to one reviewed semantic evidence group
- **WHEN** the group receives an effective disposition
- **THEN** each hit is covered through that group without a duplicate semantic answer
- **AND** the group records the exact covered hit identities

#### Scenario: One hit has overlapping dispositions
covers: #Requirement: Every Investigation Hit Has Exactly One Effective Disposition
test: packages/workflow-engine/test/class-disposition.contract.test.ts#two classes may not claim the same group

- **GIVEN** a current hit is covered by more than one effective disposition
- **WHEN** coverage is validated
- **THEN** validation fails
- **AND** investigation cannot be sealed

#### Scenario: One hit has no disposition
covers: #Requirement: Every Investigation Hit Has Exactly One Effective Disposition
test: packages/workflow-engine/test/class-disposition-mounting.integration.test.ts#one rationale can cover a class of hits a machine can show are alike

- **GIVEN** a current hit has no effective disposition
- **WHEN** coverage is validated
- **THEN** validation fails
- **AND** investigation cannot be sealed

### Requirement: Load-Bearing Evidence Requires a Full-Blob WHY Ledger
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

For every file represented by a load-bearing evidence group, the workflow engine SHALL require a ledger row bound to the complete pinned source blob.

The row MUST identify path, blob digest and size, relevant element or location, covered hits, relationship to the change, WHY explanation, protected invariant, sharp reviewer question, answer, and semantic-author provenance. The complete pinned file MUST be available to the assigned actor when semantic fields are produced.

#### Scenario: Load-bearing row is complete and current
covers: #Requirement: Load-Bearing Evidence Requires a Full-Blob WHY Ledger
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#every load-bearing path/blob has exactly one complete WHY overlay or fresh knowledge reuse

- **GIVEN** a load-bearing file has every required field and is bound to the current complete source blob
- **WHEN** WHY-ledger validation runs
- **THEN** the row is accepted

#### Scenario: Load-bearing row uses a stale blob
covers: #Requirement: Load-Bearing Evidence Requires a Full-Blob WHY Ledger
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#every load-bearing path/blob has exactly one complete WHY overlay or fresh knowledge reuse

- **GIVEN** a load-bearing row is bound to an older source-blob digest
- **WHEN** WHY-ledger validation runs
- **THEN** the row is rejected as stale

#### Scenario: Semantic field is absent or a placeholder
covers: #Requirement: Load-Bearing Evidence Requires a Full-Blob WHY Ledger
test: packages/workflow-engine/test/investigation-propose-flow.integration.test.ts#collects breadth, dispositions and WHY evidence before sealing

- **GIVEN** a load-bearing row lacks WHY, invariant, reviewer question, or answer
- **OR** a required field contains an unfilled template placeholder
- **WHEN** WHY-ledger validation runs
- **THEN** the row is rejected
- **AND** investigation cannot be sealed

#### Scenario: Engine reports a completed semantic row
covers: #Requirement: Load-Bearing Evidence Requires a Full-Blob WHY Ledger
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#every load-bearing path/blob has exactly one complete WHY overlay or fresh knowledge reuse

- **GIVEN** an actor supplied a structurally complete WHY row
- **WHEN** the engine stores or renders it
- **THEN** it preserves the actor as semantic author
- **AND** it does not claim that the engine proved the WHY true or proved that the actor understood the file

### Requirement: Non-Load-Bearing Evidence Remains Explicit
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

A non-load-bearing group MUST have an explicit classification and concrete rationale. It MUST NOT require a full WHY row unless policy or review promotes the group or one of its exceptions to load-bearing.

#### Scenario: Incidental group has a concrete rationale
covers: #Requirement: Non-Load-Bearing Evidence Remains Explicit
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#ordinary v3 is built directly, sealed separately, and replayed from pinned Git

- **GIVEN** a group is classified as incidental or irrelevant with a concrete reason
- **WHEN** investigation evidence is validated
- **THEN** the group may pass without a full WHY row

#### Scenario: Reviewer promotes an exception to load-bearing
covers: #Requirement: Non-Load-Bearing Evidence Remains Explicit
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#every load-bearing path/blob has exactly one complete WHY overlay or fresh knowledge reuse

- **GIVEN** a reviewer identifies one exception inside a non-load-bearing group
- **WHEN** that exception is accepted as load-bearing
- **THEN** it requires current full-blob WHY coverage
- **AND** the remaining group retains only its effective covered hits

### Requirement: Investigation Exemption Does Not Manufacture Evidence
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

When the current applicability ref selects an eligible `investigation-exemption`, the tracked investigation artifact SHALL contain the exact exemption subject and SHALL omit sealed-investigation term, scan, hit-disposition, and WHY-ledger nodes. An empty collection, placeholder row, or synthetic zero-hit result MUST NOT be used to claim that those gates executed.

#### Scenario: Exemption is rendered as its own branch
covers: #Requirement: Investigation Exemption Does Not Manufacture Evidence
test: packages/workflow-engine/test/investigation-propose-admission.integration.test.ts#structured investigation exemption starts a durable planning branch without manufactured survey evidence

- **GIVEN** a current eligible investigation exemption
- **WHEN** the tracked investigation projection is rendered
- **THEN** it identifies the exemption category, exact scope, baseline, intent, rationale, author, policy, and behavior-reliance declaration
- **AND** it does not contain fabricated scan, disposition, or WHY evidence

#### Scenario: Exempt plan reports breadth or depth completion
covers: #Requirement: Investigation Exemption Does Not Manufacture Evidence
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#v3 exemption is a strict separate branch with no synthetic proof collections

- **GIVEN** a plan used an investigation exemption
- **WHEN** its assurance summary claims sealed-term scan or WHY binding completed
- **THEN** validation fails
- **AND** the summary must label those claims inapplicable rather than satisfied

### Requirement: Design Ledger Is an Engine-Managed Projection
sources: [SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e]

The workflow engine SHALL render one marked investigation-ledger region of the authoritative design as readable prose from the authoritative Manifest v3 WHY overlays. The engine SHALL own the markers and all projection bytes inside that region.

The prose MUST present the inspected path, source byte locations, WHY, protected invariant, reviewer question, and answer as reviewed, actor-attested claims. Technical identities, content digests, groups, terms, and actor provenance MUST remain in the structured Manifest rather than being printed as JSON, hashes, or author identities in the prose. The projection MUST NOT become investigation evidence or claim engine-verified understanding.

#### Scenario: Managed ledger matches structured evidence
covers: #Requirement: Design Ledger Is an Engine-Managed Projection
test: packages/workflow-engine/test/investigation-why.integration.test.ts#Manifest v3 WHY overlays render and validate the exact managed design region

- **GIVEN** current structured evidence and WHY overlays
- **WHEN** the design ledger is rendered
- **THEN** its readable paths, source byte locations, and semantic fields match the structured source exactly
- **AND** technical identities and actor provenance remain in the authoritative Manifest

#### Scenario: Managed ledger is edited manually
covers: #Requirement: Design Ledger Is an Engine-Managed Projection
test: packages/workflow-engine/test/investigation-why.integration.test.ts#Manifest v3 WHY overlays render and validate the exact managed design region

- **GIVEN** the rendered design ledger differs from its current structured source
- **WHEN** planning validation runs
- **THEN** validation fails
- **AND** the manual projection does not become evidence

#### Scenario: Managed markers are ambiguous
covers: #Requirement: Design Ledger Is an Engine-Managed Projection
test: packages/workflow-engine/test/investigation-why.integration.test.ts#Manifest v3 projection rejects malformed managed ledger markers

- **GIVEN** design contains missing, duplicate, nested, or malformed ledger markers
- **WHEN** planning validation runs
- **THEN** validation fails without guessing an authored/managed boundary

### Requirement: Investigation Evidence Uses Provenance and Semantic Digests
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Every investigation evidence node SHALL have a provenance-sensitive `nodeId` and a semantic `resultDigest`. Runtime-only timestamps, retry counts, latency, process IDs, mutable ref names, and UI metadata MUST NOT enter either digest unless reviewed policy explicitly makes them semantic.

An exact input or provenance-parent change MUST produce a new `nodeId`.

#### Scenario: Input changes but semantic output converges
covers: #Requirement: Investigation Evidence Uses Provenance and Semantic Digests
test: packages/workflow-engine/test/evidence-node.contract.test.ts#evidence nodeId binds exact inputs and provenance while resultDigest binds semantic output

- **GIVEN** a recomputed node has a changed exact input or provenance parent
- **AND** compatible evaluation produces the same canonical semantic output
- **WHEN** node identity is calculated
- **THEN** the new `nodeId` differs from the old one
- **AND** the `resultDigest` is equal

#### Scenario: Runtime metadata changes
covers: #Requirement: Investigation Evidence Uses Provenance and Semantic Digests
test: packages/workflow-engine/test/evidence-node.contract.test.ts#evidence identity excludes runtime metadata and property insertion order

- **GIVEN** only timestamp, retry, latency, process, or display metadata changes
- **WHEN** semantic node identity is evaluated
- **THEN** the semantic `nodeId` and `resultDigest` remain unchanged

### Requirement: Tracked Investigation Manifest Replays Deterministic Facts From Pinned Git
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The tracked schema-v3 investigation Manifest SHALL store a strict replay contract bound to the exact baseline commit and tree for deterministic tree-inventory, scan, hit, mechanical-grouping, and coverage facts. Loading the current Manifest SHALL verify the commit-to-tree binding, read source content only from pinned Git objects, regenerate those facts under the recorded policies, and materialize the exact process-local evidence view before assurance validation.

The materialized evidence view MUST match the Manifest's recorded roots, counts, and derived commitments. The Manifest MUST retain irreducible semantic term contributions, provider results, decisions, WHY overlays, reviews, approval, and provenance in its semantic delta and attestation. Replay MUST NOT infer or regenerate actor judgment from Git source. Missing Git objects, malformed replay data, commitment mismatch, incomplete grouping, or provenance collision MUST fail closed. Any active non-v3 top-level input is refused under the stable unsupported-schema contract, while archived bytes remain untouched and read-only historical inspection cannot confer authority.

#### Scenario: Current Manifest has an intact pinned Git baseline
covers: #Requirement: Tracked Investigation Manifest Replays Deterministic Facts From Pinned Git
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#ordinary v3 is built directly, sealed separately, and replayed from pinned Git

- **GIVEN** a tracked schema-v3 Manifest names an existing commit, its exact tree, and a valid replay contract
- **WHEN** the Manifest is loaded for validation or execution
- **THEN** the engine regenerates every deterministic fact from the pinned Git tree
- **AND** the materialized evidence view has the recorded roots, counts, derived commitments, and provenance closure

#### Scenario: Pinned Git content is unavailable
covers: #Requirement: Tracked Investigation Manifest Replays Deterministic Facts From Pinned Git
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#ordinary v3 is built directly, sealed separately, and replayed from pinned Git

- **GIVEN** a current Manifest names a commit, tree, or blob that is not available in the repository
- **WHEN** the Manifest is loaded
- **THEN** loading fails closed
- **AND** current working-tree bytes are not substituted for the missing pinned content

#### Scenario: Replay no longer produces the recorded evidence
covers: #Requirement: Tracked Investigation Manifest Replays Deterministic Facts From Pinned Git
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#production builder deterministically seals raw domain facts and rejects stale authority

- **GIVEN** replay code, policy, or the current Manifest contract produces a different scan, group, disposition, coverage, root, count, or derived commitment
- **WHEN** reconstruction is validated
- **THEN** the Manifest is rejected as invalid
- **AND** the differing reconstruction does not become current evidence

#### Scenario: Semantic evidence is present beside the replay contract
covers: #Requirement: Tracked Investigation Manifest Replays Deterministic Facts From Pinned Git
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#production builder deterministically seals raw domain facts and rejects stale authority

- **GIVEN** the investigation contains actor-authored WHY overlays or provider and review evidence
- **WHEN** the tracked schema-v3 Manifest is written
- **THEN** its semantic delta and attestation retain the exact irreducible inputs, decisions, approval, and provenance
- **AND** only eligible deterministic facts are represented by the replay contract

### Requirement: Investigation v3 Is Manifest-First
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The v3 writer SHALL consume `InvestigationAuthoringState` directly and persist only exact Git replay inputs, irreducible semantic decisions and provenance, derived roots/counts, and the final investigation attestation. It MUST NOT accept or first construct a schema-v1/v2 artifact, complete `EvidenceNode[]`, or full evidence DAG. Git objects are the sole source-content authority.

A `MaterializedEvidenceView` MAY exist only in process-local memory for replay and comparison. It MUST throw or fail closed if serialization is attempted and MUST NOT be written to the runtime, tracked tree, cache, journal, or authority store.

#### Scenario: v3 ordinary Manifest is built
covers: #Requirement: Investigation v3 Is Manifest-First
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#ordinary v3 is built directly, sealed separately, and replayed from pinned Git

- **GIVEN** common raw authoring inputs, a pinned commit/tree, and complete semantic decisions
- **WHEN** the v3 writer builds the ordinary branch
- **THEN** it scans and groups directly into domain facts
- **AND** it persists replay contract, semantic delta, derived commitments, and attestation without generic evidence envelopes

#### Scenario: Process-local replay view reaches a serializer
covers: #Requirement: Investigation v3 Is Manifest-First
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#MaterializedEvidenceView is process-local and the direct writer has no projection dependency

- **GIVEN** a materialized v3 replay view exists in memory
- **WHEN** code attempts to serialize or persist it
- **THEN** the operation fails with `PROJECTION_PIPELINE_FORBIDDEN`
- **AND** no replay view bytes become durable

### Requirement: v3 Applicability and Validation Boundaries Are Exact
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The v3 Manifest SHALL select exactly one closed applicability branch. The ordinary branch contains `replayContract`, `semanticDelta`, and `derivedCommitments`; the exemption branch contains only the exact eligible exemption subject and MUST NOT manufacture empty replay, Group, Disposition, coverage, or WHY proof.

The engine SHALL expose distinct draft-seal validation, current authority validation, and read-only historical inspection. Current authority validation MUST re-resolve `commitOid^{tree}`, reconstruct terms and deterministic facts from pinned Git, verify every root and compact root-bound Group reference, enforce exact Hit→final-Group→Disposition cardinality, verify WHY/reuse completeness, and bind the exact lifecycle snapshot, target, seal, and Manifest digest. Historical inspection can never satisfy a current lifecycle gate.

#### Scenario: Ordinary semantic coverage is incomplete
covers: #Requirement: v3 Applicability and Validation Boundaries Are Exact
test: packages/workflow-engine/test/investigation-propose-flow.integration.test.ts#collects breadth, dispositions and WHY evidence before sealing

- **GIVEN** a current Hit is missing a final Group or a final Group is missing exactly one Disposition
- **WHEN** v3 authority validation runs
- **THEN** validation returns a structured semantic-completeness failure
- **AND** no partial or synthetic coverage becomes authority

#### Scenario: Exemption is validated
covers: #Requirement: v3 Applicability and Validation Boundaries Are Exact
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#v3 exemption is a strict separate branch with no synthetic proof collections

- **GIVEN** an eligible structured exemption bound to exact intent and baseline
- **WHEN** the v3 exemption branch is validated
- **THEN** replay and semantic-proof collections are absent
- **AND** investigation breadth/depth claims remain inapplicable rather than satisfied

### Requirement: Every v3 Failure Delegates Continuation to Central Grant Core
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Every v3 failure outcome under engine control, including validation, reconstruction, publication/CAS, and recoverable crash-state classification, SHALL emit exact failure identity, attempted transition, candidate digest, non-exhaustive failure code, details digest, and missing-assurance facts in a shape consumable by the published central Grant Core producer contract.

Investigation v3 MUST NOT define a local grant schema, candidate label, callback, signer, trusted UI, authentication step, reservation, consumption rule, audit journal, degraded-reference placement, or resume command. It only emits canonical failure facts and state binding; the central Transition Registry and Grant Core own choices, fresh local device-owner authentication, once-only consumption, recovery, and audit.

#### Scenario: Engine-produced v3 failure enters central Grant Core
covers: #Requirement: Every v3 Failure Delegates Continuation to Central Grant Core
test: packages/workflow-engine/test/investigation-v3-grant-publication.integration.test.ts#real publish authority-validation failures enter the central producer

- **GIVEN** a current v3 operation returns an exact structured blocker
- **WHEN** the central Grant producer is asked to create its human challenge from that blocker
- **THEN** Grant Core persists the durable challenge with a code-owned non-retry stop transition
- **AND** transition consumption re-observes the current failure state and rejects drift
- **AND** the v3 source state stores no challenge, approval, Grant reference, or audit state
- **AND** stopping preserves the failed assurance without relabelling it as verified

#### Scenario: Publication failure enters central Grant Core from its real source
covers: #Requirement: Every v3 Failure Delegates Continuation to Central Grant Core
test: packages/workflow-engine/test/investigation-v3-grant-publication.integration.test.ts#the production publication producer persists centrally and recovery rejects source drift

- **GIVEN** a v3 publish, inspect, resume, or current-ref read returns one emitter-bound failure envelope containing its structured publication blocker
- **WHEN** the central Grant producer creates a challenge from that envelope
- **THEN** the registered source observer re-reads the current durable investigation session/current ref and binds the lifecycle-owned publication namespace, exact journal, candidate, installed Manifest, publication current-ref, branch, Git baseline, index/worktree content fingerprint, and lifecycle identity
- **AND** a blocker/source or lifecycle/source cross-wire is rejected before any challenge is persisted
- **AND** changing any bound publication source before direct execution or recovery rejects the stop transition as stale
- **AND** deterministic prepared-state drift records a central audited terminal failure without applying or relabelling the v3 transition, while an effect-applied-before-receipt crash remains recoverable through the same idempotent transition
- **AND** no publication-specific Grant store, signer, authentication, or resume surface is created

#### Scenario: File publication crashes before current-ref installation
covers: #Requirement: Every v3 Failure Delegates Continuation to Central Grant Core
test: packages/workflow-engine/test/investigation-publication-v3.test.ts#a crash between Manifest install and ref publication is classified and resumable

- **GIVEN** v3 publication wrote a candidate, journal, or Manifest but did not install the intended current ref
- **WHEN** restart inspection classifies the residue
- **THEN** it returns a precise `PUBLICATION_RECOVERY_REQUIRED` blocker consumable by the central producer
- **AND** a later source mutation invalidates any already-issued challenge

#### Scenario: File publication crashes after current-ref installation
covers: #Requirement: Every v3 Failure Delegates Continuation to Central Grant Core
test: packages/workflow-engine/test/investigation-v3-grant-publication.integration.test.ts#recognized post-ref crash recovery remains idempotent and Grant-free

- **GIVEN** the exact v3 Manifest and current ref were installed but the file-publication journal remains prepared
- **WHEN** recovery reacquires the lifecycle lock
- **THEN** it accepts Grant-free recovery only when the failing invocation itself reached the post-ref phase and the fully revalidated transaction-installed Manifest and ref both match the journal with unchanged lifecycle identity
- **AND** it completes idempotently without creating or consuming a Grant
- **AND** a missing or corrupt installed Manifest returns a central-consumable blocker instead of being classified as Grant-free

#### Scenario: Publication parent moves while the lifecycle lock is held
covers: #Requirement: Every v3 Failure Delegates Continuation to Central Grant Core
test: packages/workflow-engine/test/investigation-publication-v3.test.ts#publication compensates a parent relocation during the exact Manifest rename

- **GIVEN** every cooperating publication writer holds the lifecycle lock
- **WHEN** a publication parent is relocated during one synchronous pathname replacement
- **THEN** the writer immediately revalidates repository containment and the complete parent identity chain
- **AND** it compensates a newly installed basename or restores the exact prior bytes before returning a structured blocker
- **AND** immutable candidates remain as recovery evidence instead of being destructively removed
- **AND** this is a fail-detecting compensating transaction, not a claim that POSIX can atomically prevent a hostile same-UID relocation or process crash

### Requirement: Reusable Knowledge Remains Separate From Per-Change WHY
sources: [SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e]

The v3 Manifest SHALL retain per-change WHY overlays or immutable `knowledgeRef` versions with an explicit current freshness decision. Reusable file responsibility and invariants SHALL live in the source header. The Semantic Ledger SHALL contain a binding and freshness index, including exact subject and source identities, import-derived dependencies, policy binding, provenance and supersession; it MUST NOT persist a second copy of explanatory prose.

Dependencies SHALL be derived from the supplied repository snapshot's literal imports and exports, including resolvable workspace package exports. Changes, removal or replacement of a dependency SHALL require freshness reassessment along reverse import edges. A stored entry MUST NOT prove current Git facts without current replay and exact source binding.

#### Scenario: Current replay cites an immutable knowledge version
covers: #Requirement: Reusable Knowledge Remains Separate From Per-Change WHY
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#every load-bearing path/blob has exactly one complete WHY overlay or fresh knowledge reuse

- **GIVEN** a load-bearing Git path/blob has an explicitly fresh reusable-knowledge decision
- **WHEN** the engine records the current Manifest's reuse decision
- **THEN** its `knowledgeRef` names the exact immutable ledger entry
- **AND** the Manifest records the current source binding and explicit freshness decision

#### Scenario: The ledger does not duplicate header explanations
covers: #Requirement: Reusable Knowledge Remains Separate From Per-Change WHY
test: packages/workflow-engine/test/system-semantic-ledger.contract.test.ts#semantic ledger is a binding index without a second copy of header prose

- **WHEN** the engine creates a reusable file entry
- **THEN** the entry binds its subject and source without copying the file's explanatory prose

#### Scenario: Dependency edges come from the supplied snapshot
covers: #Requirement: Reusable Knowledge Remains Separate From Per-Change WHY
test: packages/workflow-engine/test/system-semantic-ledger.contract.test.ts#literal imports resolve against the supplied snapshot including workspace exports

- **WHEN** the engine derives dependencies for literal imports and exports
- **THEN** it resolves their repository files and workspace exports from the same snapshot
- **AND** comments and strings resembling import statements do not create edges

#### Scenario: Changed or missing dependencies stale their consumers
covers: #Requirement: Reusable Knowledge Remains Separate From Per-Change WHY
test: packages/workflow-engine/test/system-semantic-ledger.contract.test.ts#missing dependencies stay stale and changes propagate through reverse import edges

- **WHEN** a dependency changes or can no longer be observed
- **THEN** its consumers require reassessment
- **AND** the change propagates through reverse import edges even when consumer source bytes are unchanged

#### Scenario: Export replacement changes the bound dependency
covers: #Requirement: Reusable Knowledge Remains Separate From Per-Change WHY
test: packages/workflow-engine/test/system-semantic-ledger.contract.test.ts#import options, division, and export condition order retain the actual dependency

- **WHEN** a workspace package export resolves to a different repository file
- **THEN** the importing entry is dependency-changed rather than reused solely because its own source bytes match

### Requirement: Exact Project-Local OpenSpec Surface
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The repository SHALL execute every managed OpenSpec planning operation through
the exact project-local version declared in the root manifest, with no fallback
to a global, floating, vendored, or user-selected OpenSpec source. Its optional
postinstall script MUST remain denied by repository supply-chain policy.

#### Scenario: Pinned planning command runs
covers: #Requirement: Exact Project-Local OpenSpec Surface
test: packages/workflow-engine/test/openspec-doctor.integration.test.ts#real workflow doctor reports the pinned local OpenSpec installation

- **GIVEN** the manifest, lockfile, build policy, and installed package resolve
  to the same exact version
- **WHEN** a managed planning or validation operation runs
- **THEN** it uses that project-local CLI without running the optional
  postinstall
- **AND** it reports the canonical repository as its planning root

#### Scenario: OpenSpec resolution drifts
covers: #Requirement: Exact Project-Local OpenSpec Surface
test: packages/workflow-engine/test/openspec-adapter.integration.test.ts#OpenSpec adapter requires the exact lock provenance and denied build script

- **GIVEN** the installed version, resolved schema source, build policy, or
  returned planning root differs from repository policy
- **WHEN** a managed OpenSpec operation is requested
- **THEN** the operation fails before creating a session or mutating Git state

### Requirement: Typed and Isolated OpenSpec Adapter
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Every workflow-owned OpenSpec subprocess SHALL use an operation-specific argv
contract, isolated machine state, bounded execution, and validated JSON output.
The adapter MUST NOT expose a generic command pass-through.

#### Scenario: Machine response matches its operation contract
covers: #Requirement: Typed and Isolated OpenSpec Adapter
test: packages/workflow-engine/test/openspec-adapter.integration.test.ts#OpenSpec adapter pins argv, cwd, environment, and temporary homes

- **GIVEN** the pinned CLI returns one valid JSON document with the expected
  payload, root, paths, version, exit status, and allowlisted diagnostics
- **WHEN** the typed adapter processes the operation
- **THEN** it returns validated typed data to the workflow consumer

#### Scenario: Machine response is ambiguous or unsafe
covers: #Requirement: Typed and Isolated OpenSpec Adapter
test: packages/workflow-engine/test/openspec-adapter.integration.test.ts#OpenSpec adapter rejects ambiguous output, stderr drift, and external roots

- **GIVEN** the process times out, exceeds its output limit, returns mixed
  prose/JSON, unexpected stderr, a malformed payload, or an external root/path
- **WHEN** the typed adapter processes the operation
- **THEN** it fails closed without accepting partial output or mutating Git

### Requirement: Project-Local Managed Change Schema
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Every managed change SHALL declare the validated repository-configured current schema. A fresh repository uses the current investigation-first graph immediately; no activation marker, legacy schema reader, or migration lineage participates in admission or replay.

The current apply graph MUST require engine-owned `investigation.json`, authored proposal and delta specs, mixed authored/managed design, tasks, task-only `guard.json`, engine-validated `execution.json`, and exact-target `plan-review.json`. The investigation artifact MUST select exactly one current `sealed-investigation` or eligible structured `investigation-exemption` branch. Repository execution readiness requires tasks, guard, the selected investigation applicability branch, execution, and plan review.

The built-in `spec-driven` graph SHALL remain a distinct named OpenSpec package graph. It MUST NOT substitute for a repository's configured current managed schema. Immutable planning replay SHALL read the repository policy and schema declaration committed in the replayed current-v3 tree and fail closed when either is missing, malformed, or non-current.

#### Scenario: Investigation-first managed change contains all required artifacts
covers: #Requirement: Project-Local Managed Change Schema
test: packages/workflow-engine/test/managed-change-contract.integration.test.ts#validated managed contract binds OpenSpec readiness to a full mode-aware snapshot

- **GIVEN** a change declares the repository-configured current schema
- **AND** its current investigation, proposal, delta specs, design, tasks, guard, execution, and plan review exist
- **WHEN** OpenSpec and repository validation compute readiness
- **THEN** the required planning graph is complete only when every engine-owned artifact also passes its workflow validator

#### Scenario: Eligible investigation exemption is selected
covers: #Requirement: Project-Local Managed Change Schema
test: packages/workflow-engine/test/planning-transition.integration.test.ts#plan-commit authorizes an exact reviewed current investigation exemption and binds its generation

- **GIVEN** a current managed change
- **AND** `investigation.json` selects a current eligible structured exemption
- **WHEN** OpenSpec and repository validation compute readiness
- **THEN** the artifact graph is complete without sealed scan/disposition/WHY nodes
- **AND** exact-plan review and every other current gate remain required

#### Scenario: Empty investigation masquerades as exemption
covers: #Requirement: Project-Local Managed Change Schema
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#ordinary v3 is built directly, sealed separately, and replayed from pinned Git

- **GIVEN** a current investigation artifact contains empty scan or WHY collections but no eligible typed exemption
- **WHEN** readiness is evaluated
- **THEN** the change is not ready

#### Scenario: Execution-policy artifact is absent
covers: #Requirement: Project-Local Managed Change Schema
test: packages/workflow-engine/test/managed-change-contract.integration.test.ts#managed readiness rejects a missing guard even when tasks and provider status are complete

- **GIVEN** a managed change has tasks but no `guard.json`
- **WHEN** readiness is evaluated
- **THEN** the change is not ready for workflow execution

#### Scenario: Investigation-first artifact is absent
covers: #Requirement: Project-Local Managed Change Schema
test: packages/workflow-engine/test/openspec-adapter.integration.test.ts#real pinned OpenSpec adapter validates package, schema, status, and change

- **GIVEN** a current change lacks investigation, execution, or plan-review artifact
- **WHEN** readiness is evaluated
- **THEN** the change is not ready for planning transition or execution

#### Scenario: Managed change selects a non-current schema
covers: #Requirement: Project-Local Managed Change Schema
test: packages/workflow-engine/test/managed-change-contract.integration.test.ts#validated managed contract rejects a non-managed schema at admission

- **GIVEN** the repository configuration names one validated current schema
- **WHEN** a planning introduction, revision, task, CI, or archive replay selects any other managed schema
- **THEN** validation fails closed without consulting a historical reader or activation lineage

#### Scenario: Immutable current planning generation is replayed
covers: #Requirement: Project-Local Managed Change Schema
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI replays a configured current schema from immutable consumer config

- **GIVEN** a governing current-v3 plan commit contains its repository policy and current schema declaration
- **WHEN** task, CI, or archive validation replays that generation
- **THEN** the same current graph and exact committed artifacts are validated
- **AND** no mutable checkout policy or historical schema fallback substitutes for the committed inputs

#### Scenario: Replayed repository policy is absent
covers: #Requirement: Project-Local Managed Change Schema
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI refuses a plan without committed repository policy despite valid checkout policy

- **GIVEN** a planning commit lacks the repository policy required to resolve its current schema
- **WHEN** immutable planning replay runs
- **THEN** replay fails closed rather than inferring a former consumer schema

#### Scenario: Schema source is shadowed
covers: #Requirement: Project-Local Managed Change Schema
test: packages/workflow-engine/test/openspec-adapter.integration.test.ts#OpenSpec adapter rejects schema payload extras and validity contradictions

- **GIVEN** `spec-driven` does not resolve from the pinned package or either project schema does not resolve from its canonical reviewed path
- **WHEN** schema diagnostics or change validation runs
- **THEN** the operation fails even if a same-named user schema is valid

### Requirement: Combined Change Readiness
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL report an investigation-first change ready only when strict OpenSpec validation and repository investigation applicability, the selected sealed-investigation evidence and managed projection when applicable, exact-plan review, task, guard, execution strategy, check, path, metadata, content, and digest validation all succeed against the same planning generation.

#### Scenario: Valid delta has unsafe guard policy
covers: #Requirement: Combined Change Readiness
test: packages/workflow-engine/test/guard-contract.integration.test.ts#required check IDs reject malformed, unknown, and duplicate values

- **GIVEN** OpenSpec accepts a change's delta specifications
- **AND** its guard contains an unknown check, missing task, or unsafe path
- **WHEN** workflow change validation runs
- **THEN** validation fails
- **AND** no task session can start

#### Scenario: OpenSpec reports an engine-owned artifact as done
covers: #Requirement: Combined Change Readiness
test: packages/workflow-engine/test/change-loading.contract.test.ts#current change loading rejects a v3 Manifest whose digest no longer replays

- **GIVEN** OpenSpec readiness reports an investigation, execution, or plan-review artifact exists
- **AND** repository validation finds it malformed, unbound, stale, incomplete, or manually divergent
- **WHEN** workflow change validation runs
- **THEN** validation fails despite OpenSpec status

#### Scenario: OpenSpec reports an authored artifact as done
covers: #Requirement: Combined Change Readiness
test: packages/workflow-engine/test/managed-change-contract.integration.test.ts#managed contract rejects unsafe metadata and incomplete artifact trees before readiness is trusted

- **GIVEN** OpenSpec readiness reports an authored artifact exists
- **AND** repository semantic validation finds it empty or malformed
- **WHEN** workflow change validation runs
- **THEN** validation fails despite OpenSpec status

#### Scenario: Planning artifacts drift after validation
covers: #Requirement: Combined Change Readiness
test: packages/workflow-engine/test/managed-change-lifecycle.integration.test.ts#check rejects every combined-contract drift class before executing checks

- **GIVEN** a planning generation previously passed combined validation
- **WHEN** any semantic tracked change, schema, workflow policy, investigation dependency, role requirement, or check-registry input changes
- **THEN** dependent validation and review become stale
- **AND** the workflow requires current evidence for the resulting generation

#### Scenario: OpenSpec reports an empty artifact as done
covers: #Requirement: Combined Change Readiness
test: packages/workflow-engine/test/managed-change-contract.integration.test.ts#managed contract rejects unsafe metadata and incomplete artifact trees before readiness is trusted

- **GIVEN** OpenSpec readiness reports an artifact exists
- **AND** repository semantic validation finds it empty or malformed
- **WHEN** workflow change validation runs
- **THEN** validation fails despite the OpenSpec status

### Requirement: Authorized Planning Transition
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

A planning introduction or revision SHALL be commit-authorized only by a current workflow plan-transition report whose exact diff is confined to the named change's permitted schema-specific planning paths.

An investigation-first transition MUST also have a current sealed investigation or eligible structured investigation exemption, the exact managed design projection when applicable, valid execution strategies, immutable planning generation, current exact-target PlanReview, achieved required role separation or an eligible signed degraded result whose exact content admission and use validate, and current dispositions for every challenge. Grant presence alone and the advisory verdict itself MUST NOT be commit authority.

#### Scenario: New investigation-first planning baseline is authorized
covers: #Requirement: Authorized Planning Transition
test: packages/workflow-engine/test/planning-transition.integration.test.ts#plan-commit introduces an unchecked change through one exact managed commit

- **GIVEN** a current change passes combined validation and exact-plan review
- **AND** all newly introduced task checkboxes are unchecked
- **WHEN** the planning transition is requested
- **THEN** only its authorized planning paths are staged
- **AND** the commit uses `Change: <change-id>` and `Transition: plan`
- **AND** the planning report binds the exact planning generation

#### Scenario: Advisory verdict rejects an otherwise dispositioned plan
covers: #Requirement: Authorized Planning Transition
test: packages/workflow-engine/test/plan-review-dispositions.contract.test.ts#advisory verdict never replaces hard currentness and disposition gates

- **GIVEN** a current exact-target PlanReview has an advisory rejection verdict
- **AND** every structured challenge has a valid current disposition
- **WHEN** planning authorization runs
- **THEN** the verdict alone does not grant or deny commit authority
- **AND** all executable planning gates still apply

#### Scenario: Planning transition contains non-planning mutation
covers: #Requirement: Authorized Planning Transition
test: packages/workflow-engine/test/planning-transition.integration.test.ts#plan-commit rejects checkbox, code, staged-index, and OpenSpec-invalid drift without mutation

- **GIVEN** a proposed planning transition changes implementation code, base specs, archives, task checkbox state outside an authorized projection, or another change
- **WHEN** planning authorization runs
- **THEN** the transition is rejected without staging or committing

#### Scenario: Planning revision occurs after execution begins
covers: #Requirement: Authorized Planning Transition
test: packages/workflow-engine/test/task-revision-lease.integration.test.ts#resume-task commits only a freshly reviewed plan and rebinds the same session

- **GIVEN** implementation evidence exists for a change
- **WHEN** an authorized planning revision changes the contract
- **THEN** the revision requires no active task session under the current lifecycle
- **AND** dependent task evidence is invalidated before another task can rely on the changed contract

#### Scenario: New planning baseline is authorized
covers: #Requirement: Authorized Planning Transition
test: packages/workflow-engine/test/planning-transition.integration.test.ts#plan-commit introduces an unchecked change through one exact managed commit

- **GIVEN** a new OpenSpec change passes combined validation
- **AND** all of its task checkboxes are unchecked
- **WHEN** the planning transition is requested
- **THEN** only its authorized planning paths are staged
- **AND** the commit uses `Change: <change-id>` and `Transition: plan`

### Requirement: Workflow-Owned Archive Authorization
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The repository SHALL authorize an OpenSpec archive only through a current
workflow archive transition after completion, reachability, session, worktree,
artifact, and lock preconditions pass.

#### Scenario: Completed change is eligible for archive
covers: #Requirement: Workflow-Owned Archive Authorization
test: packages/workflow-engine/test/archive-eligibility.integration.test.ts#archive eligibility binds completed task evidence to the configured base

- **GIVEN** every task has current workflow completion evidence
- **AND** its task commits are reachable from the configured base
- **AND** no session, drift, dirty target, destination collision, or conflicting
  archive lock exists
- **WHEN** workflow archive is requested
- **THEN** the archive transformation may proceed

#### Scenario: Raw archive diff lacks workflow evidence
covers: #Requirement: Workflow-Owned Archive Authorization
test: packages/workflow-engine/test/ci-archive.integration.test.ts#a raw archive with valid projected content is rejected without workflow task evidence

- **GIVEN** an archive-shaped diff was produced outside the workflow transition
- **WHEN** commit or CI verification runs
- **THEN** the diff is rejected even if OpenSpec considers the archive valid

### Requirement: Isolated Archive Transformation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

An authorized archive SHALL mutate only a detached temporary worktree until an
exact OpenSpec result and path-constrained patch have been validated for
application to the real worktree.

#### Scenario: Archive transformation succeeds
covers: #Requirement: Isolated Archive Transformation
test: packages/workflow-engine/test/archive-transformation.integration.test.ts#archive transformation returns an exact full-index patch without mutating the real worktree

- **GIVEN** archive preconditions pass
- **WHEN** the pinned OpenSpec archive mechanism completes in the temporary
  worktree
- **THEN** the verified result contains only the active-change removal, one
  exact dated archive addition, and permitted base-spec promotions
- **AND** only the verified patch is offered to archive staging

#### Scenario: Temporary archive fails after partial mutation
covers: #Requirement: Isolated Archive Transformation
test: packages/workflow-engine/test/archive-transformation.integration.test.ts#archive transformation confines partial_failure faults

- **GIVEN** OpenSpec writes a partial result, times out, encounters a collision,
  or fails while moving files in the temporary worktree
- **WHEN** archive execution terminates
- **THEN** the real worktree and index remain unchanged
- **AND** no archive transition is authorized

#### Scenario: Archive patch escapes its permitted targets
covers: #Requirement: Isolated Archive Transformation
test: packages/workflow-engine/test/archive-transformation.integration.test.ts#archive transformation confines archive_escape faults

- **GIVEN** the temporary result contains an unexpected, external, symlinked,
  silently ignored, or digest-mismatched path or delta
- **WHEN** archive verification runs
- **THEN** the patch is rejected before real-worktree mutation

### Requirement: Stable Archive Identity
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Archive verification SHALL bind the logical change identity to archived-tree
and promoted-spec digests while normalizing only the valid UTC date prefix
generated by OpenSpec.

#### Scenario: CI replays archive on a later UTC date
covers: #Requirement: Stable Archive Identity
test: packages/workflow-engine/test/ci-archive.integration.test.ts#CI archive replay normalizes only the UTC date directory

- **GIVEN** CI reproduces the same logical archive and content on a different
  UTC date
- **WHEN** it compares the proposed archive with the replay
- **THEN** one valid date prefix is normalized
- **AND** the change suffix and content digests still match exactly

#### Scenario: Verified archive is requested again
covers: #Requirement: Stable Archive Identity
test: packages/workflow-engine/test/archive-transition.integration.test.ts#archive transition persists evidence, applies exact staging, commits, and is idempotent

- **GIVEN** exactly one previously verified archive matches the logical change
  and content identity
- **WHEN** workflow archive is requested again
- **THEN** it reports an already-archived result without mutation

### Requirement: Recomputed Transition Assurance
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Managed task, plan, and archive commits SHALL use mutually exclusive
trailer-and-evidence contracts whose exact changed paths and current validity
are recomputed from Git by CI.

#### Scenario: Local hook is bypassed
covers: #Requirement: Recomputed Transition Assurance
test: packages/workflow-engine/test/ci-archive.integration.test.ts#CI rejects mixed task and archive trailer forms even when hooks are bypassed

- **GIVEN** a commit reaches CI without local workflow verification
- **WHEN** CI recomputes its transition kind, trailers, changed paths, and
  required evidence
- **THEN** an invalid task, plan, or archive transition is rejected

#### Scenario: Commit mixes transition forms
covers: #Requirement: Recomputed Transition Assurance
test: packages/workflow-engine/test/ci-archive.integration.test.ts#CI rejects mixed task and archive trailer forms even when hooks are bypassed

- **GIVEN** a commit contains both a `Task:` trailer and a `Transition:` trailer
- **OR** its evidence kind does not match its diff
- **WHEN** managed-commit verification runs
- **THEN** the commit is rejected

### Requirement: Workflow Test Entrypoint Portability
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow test entrypoints MUST resolve repository fixtures and source paths
independently of the caller's current working directory.

#### Scenario: Root workflow tests run
covers: #Requirement: Workflow Test Entrypoint Portability
test: packages/workflow-engine/test/public-contract-surface.test.ts#runner security suite is portable to the package working directory

- **WHEN** the repository-owned workflow test command runs from the repository
  root
- **THEN** all configured workflow tests resolve the canonical repository files

#### Scenario: Package-filtered workflow tests run
covers: #Requirement: Workflow Test Entrypoint Portability
test: packages/workflow-engine/test/public-contract-surface.test.ts#runner security suite is portable to the package working directory

- **WHEN** the workflow package test command runs with the package directory as
  its current working directory
- **THEN** it resolves the same repository fixtures and source modules
- **AND** it produces the same passing test set as the root command

### Requirement: OpenSpec Change Root Compatibility
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow MUST distinguish active change directories from OpenSpec's
reserved archive container and MUST NOT parse the container itself as a change.

#### Scenario: Empty archive container exists
covers: #Requirement: OpenSpec Change Root Compatibility
test: packages/workflow-engine/test/handoff.integration.test.ts#reserved OpenSpec archive directory is not an active change

- **GIVEN** OpenSpec has created `openspec/changes/archive/` with no archived
  changes
- **WHEN** the workflow enumerates active changes for validation or handoff
- **THEN** it ignores the reserved container
- **AND** it continues to select only valid active change directories

#### Scenario: Archived changes exist
covers: #Requirement: OpenSpec Change Root Compatibility
test: packages/workflow-engine/test/handoff.integration.test.ts#committed managed-document validation replays a terminal handoff with zero active changes

- **GIVEN** dated change directories exist under `openspec/changes/archive/`
- **WHEN** the workflow enumerates active changes
- **THEN** neither the archive container nor its children are treated as active

### Requirement: Planning-Only OpenSpec Asset Interface
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Repository-delivered OpenSpec assets SHALL expose only exploration and proposal behavior across Codex, Claude Code, `.agents`, and reviewed Codex prompt targets, and MUST hand implementation authority to the repository workflow. Asset validity MUST be established by the versioned asset contract rather than by a formatting check.

#### Scenario: Tool-plural planning assets are regenerated
covers: #Requirement: Planning-Only OpenSpec Asset Interface
test: packages/workflow-engine/test/openspec-planning-assets.integration.test.ts#tool-plural generation is isolated, three-stage pinned, and byte deterministic

- **GIVEN** a clean temporary project and isolated home, XDG, Codex, and temporary directories
- **WHEN** the pinned generator selects Codex and Claude with the reviewed custom workflow allowlist
- **THEN** one upstream run produces the expected Codex and Claude source closures
- **AND** the repository receives only reviewed explore and propose skills, `.agents` mirrors, and Codex prompts
- **AND** no real user Codex or Claude state is modified

#### Scenario: Claude commands or lifecycle skills are generated upstream
covers: #Requirement: Planning-Only OpenSpec Asset Interface
test: packages/workflow-engine/test/openspec-planning-assets.integration.test.ts#upstream and discarded-command closures fail before repository writes

- **WHEN** the isolated upstream run emits its expected Claude command files or any source outside the reviewed closures
- **THEN** expected Claude commands are discarded rather than delivered
- **AND** any unexpected source causes generation to fail before repository files are written

#### Scenario: Asset stages are validated
covers: #Requirement: Planning-Only OpenSpec Asset Interface
test: packages/workflow-engine/test/openspec-planning-assets.integration.test.ts#tool-plural generation is isolated, three-stage pinned, and byte deterministic

- **WHEN** generated-asset verification runs
- **THEN** it verifies exact generator policy plus raw-source, reviewed-overlay, and delivered-final digests for every target
- **AND** it verifies canonical paths, exact target closure, mirror equality, and final reviewed content

#### Scenario: Asset check runs without the formatter
covers: #Requirement: Planning-Only OpenSpec Asset Interface
test: packages/workflow-engine/test/openspec-planning-assets.integration.test.ts#checking never resolves the formatter and never rewrites success or failure

- **WHEN** the registered OpenSpec asset check validates a generated repository tree
- **THEN** it succeeds without resolving or invoking Prettier
- **AND** it does not rewrite the manifest or any delivered file

#### Scenario: Manifest or delivery state is missing or drifted
covers: #Requirement: Planning-Only OpenSpec Asset Interface
test: packages/workflow-engine/test/hooks.integration.test.ts#hooks fail closed when the OpenSpec asset manifest is missing or renamed

- **WHEN** the manifest is missing, renamed, malformed, stale, or inconsistent with any required target, digest, path, mirror, or closure
- **THEN** hook validation and pull-request regeneration fail closed

#### Scenario: Generated asset exposes forbidden authority
covers: #Requirement: Planning-Only OpenSpec Asset Interface
test: packages/workflow-engine/test/openspec-planning-assets.integration.test.ts#every delivered target rejects forbidden authority after digest repinning

- **GIVEN** any delivered asset invokes OpenSpec apply, update, sync, archive, bulk-archive, or store behavior, whether bare or executable-prefixed
- **OR** it invokes an external store, Spectra, an unreviewed slash command, a tool-wide OpenSpec permission, or an incompatible tool primitive
- **WHEN** generated-asset verification runs
- **THEN** verification fails for that delivery target
- **AND** the asset cannot satisfy repository CI

#### Scenario: Generated final is formatted after delivery
covers: #Requirement: Planning-Only OpenSpec Asset Interface
test: packages/workflow-engine/test/openspec-planning-assets.integration.test.ts#checking never resolves the formatter and never rewrites success or failure

- **WHEN** any tool rewrites a delivered generated file after generation
- **THEN** its final-byte digest no longer matches the reviewed manifest
- **AND** the read-only asset check fails rather than accepting or repairing it

### Requirement: Governing Planning Generation Is Resolved From Managed Git History
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Task start, CI, and archive replay SHALL resolve a change's effective planning generation from its latest reachable managed plan transition and SHALL reconstruct that immutable plan's schema-selection parent, component manifest, and planning-generation ID.

They MUST NOT infer the governing generation from a branch name, current working-tree prose, or engine-owned completion checkbox bytes.

#### Scenario: Task checkboxes change after plan commit
covers: #Requirement: Governing Planning Generation Is Resolved From Managed Git History
test: packages/workflow-engine/test/completion.integration.test.ts#current report authorizes completion, exact staging, and commit

- **GIVEN** a managed task completion changes only authorized checkbox projections
- **WHEN** a later task or CI resolves the governing plan
- **THEN** it resolves the immutable managed plan commit and unchanged authored task contract
- **AND** checkbox projection changes do not create a new planning generation

#### Scenario: A later plan revision exists
covers: #Requirement: Governing Planning Generation Is Resolved From Managed Git History
test: packages/workflow-engine/test/session-admission.integration.test.ts#task ingress pins the latest plan and rejects an older PlanReview after advisory preflight

- **GIVEN** a reachable newer managed plan commit supersedes an older generation
- **WHEN** task start resolves planning authority
- **THEN** it selects and pins the newer generation
- **AND** stale review for the older generation cannot authorize the task

### Requirement: Engine-Owned Planning Artifacts Cannot Be Prompt-Authored Authority
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

OpenSpec MAY represent investigation, execution, and plan-review files in its artifact graph, but only workflow transitions SHALL create or authorize their objective fields, digests, current refs, managed projections, and review bindings.

Prompt-authored or manually edited engine fields MUST fail repository validation even when OpenSpec reports the file present.

#### Scenario: User invokes artifact instructions for an engine-owned artifact
covers: #Requirement: Engine-Owned Planning Artifacts Cannot Be Prompt-Authored Authority
test: packages/workflow-engine/test/openspec-schema-contract.integration.test.ts#current schema has the exact investigation-first graph and route-back engine templates

- **WHEN** an engine-owned current artifact becomes ready in the OpenSpec graph
- **THEN** its reviewed instruction routes creation through `workflow propose`
- **AND** free-form authored content cannot satisfy workflow validation

#### Scenario: Engine-owned JSON is edited after projection
covers: #Requirement: Engine-Owned Planning Artifacts Cannot Be Prompt-Authored Authority
test: packages/workflow-engine/test/change-loading.contract.test.ts#current change loading rejects a v3 Manifest whose digest no longer replays

- **GIVEN** an investigation, execution, or plan-review projection was current
- **WHEN** its objective binding or managed bytes are edited outside the engine transition
- **THEN** combined validation fails

### Requirement: Planning transitions may delete non-canonical tree noise
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

A planning transition SHALL accept the deletion of a non-canonical file that
lies inside the named change's own tree. Additions or modifications of
non-canonical files MUST remain rejected, and deletions outside the named
change tree MUST remain rejected. CI plan replay MUST apply the identical
rule.

#### Scenario: Noise file is deleted
covers: #Requirement: Planning transitions may delete non-canonical tree noise
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI accepts a revision that deletes non-canonical planning noise

- **WHEN** a planning diff deletes a non-canonical file inside the named
  change's tree and the remaining artifact graph validates
- **THEN** the planning transition and its CI replay accept the diff

#### Scenario: Noise file is added or modified
covers: #Requirement: Planning transitions may delete non-canonical tree noise
test: packages/workflow-engine/test/planning-transition.contract.test.ts#planning paths accept only in-tree deletions of non-canonical files

- **WHEN** a planning diff adds or modifies a non-canonical file
- **THEN** the transition fails closed with the invalid paths named

#### Scenario: Deletion escapes the change tree
covers: #Requirement: Planning transitions may delete non-canonical tree noise
test: packages/workflow-engine/test/planning-transition.contract.test.ts#planning paths accept only in-tree deletions of non-canonical files

- **WHEN** a planning diff deletes a file outside the named change's tree
- **THEN** the transition fails closed

### Requirement: Generated OpenSpec Asset Format Scope Is Exact
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow-format contract assertion SHALL accept only the registered command that explicitly covers the reviewed human-maintained workflow paths and excludes the generated OpenSpec asset home. It MUST reject the former broad workflow-directory form and every other command.

#### Scenario: Asset-separated format scope is active
covers: #Requirement: Generated OpenSpec Asset Format Scope Is Exact
test: packages/workflow-engine/test/public-contract-surface.test.ts#format verification delegates to the registered canonical authority

- **WHEN** the post-authority repository contract validates `workflow-format`
- **THEN** the exact asset-separated command passes
- **AND** generated OpenSpec assets remain outside formatting ownership

#### Scenario: Broad or otherwise drifted format scope returns
covers: #Requirement: Generated OpenSpec Asset Format Scope Is Exact
test: packages/workflow-engine/test/public-contract-surface.test.ts#format verification delegates to the registered canonical authority

- **WHEN** `workflow-format` names the broad workflow directory, omits a required human-maintained path, includes the generated asset home, or otherwise changes
- **THEN** the repository contract fails

### Requirement: CI plan replay rejects duplicate planning-tree entries
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

CI plan replay SHALL fail closed when a planning tree's recursive listing
contains the same normalized path more than once, and MUST leave trees with
unique paths unaffected.

#### Scenario: Crafted duplicate entry
covers: #Requirement: CI plan replay rejects duplicate planning-tree entries
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI rejects a planning tree with duplicate entries

- **WHEN** a planning commit's tree carries two entries with the same path
  inside the named change's tree
- **THEN** CI plan replay fails closed before any structural assertion
  consumes the listing

#### Scenario: Unique trees are unaffected
covers: #Requirement: CI plan replay rejects duplicate planning-tree entries
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI accepts a revision that deletes non-canonical planning noise

- **WHEN** a planning commit's trees contain only unique paths
- **THEN** validation behaves exactly as before

### Requirement: Candidate Discovery Is Read-Only and Current
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Candidate Discovery Is Read-Only and Current
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#archive-pr doctor reuses exact local candidate discovery without writes or remote seams

- **GIVEN** the clean protected branch and its configured remote-tracking identity have the same commit and tree
- **AND** the completed change passes current Manifest and PlanReview authority
- **WHEN** an agent runs `archive-pr doctor`
- **THEN** the candidate binds the repository, change, protected-base, Manifest, and PlanReview identities
- **AND** no local or remote state changes

#### Scenario: Historical or inferred archive state is observed
covers: #Requirement: Candidate Discovery Is Read-Only and Current
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#archive-pr doctor rejects a tracked archive directory without verified transition evidence

- **WHEN** only historical planning evidence or an unverified archive directory is available
- **THEN** doctor reports the exact current blocker
- **AND** it neither synthesizes authority nor modifies the repository

### Requirement: Local Preparation Reuses Core Archive Authority
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Local Preparation Reuses Core Archive Authority
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#archive-pr dry-run creates only a local canonical preparation and reports the remote gate pending

- **WHEN** local preparation creates the canonical isolated archive worktree
- **THEN** core archive authority produces one archive commit and report
- **AND** exact replay returns the same identity
- **AND** local assurance binds the discovered protected parent to that archive head
- **AND** no hosted service is contacted

#### Scenario: A canonical branch belongs to another history
covers: #Requirement: Local Preparation Reuses Core Archive Authority
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#local archive rejects a foreign canonical branch descendant before recovery writes

- **WHEN** the branch, worktree, remote-tracking base, or report evidence is foreign or divergent
- **THEN** preparation fails closed without rewriting, deleting, resetting, or adopting it

### Requirement: Prepared Publication Payload Is Exact and Durable
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Prepared Publication Payload Is Exact and Durable
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#prepares, publishes, and recovers one exact archive PR identity

- **WHEN** retry derives the same canonical payload identity
- **THEN** persistence converges on the same private record and bytes
- **AND** no duplicate archive identity is created

#### Scenario: A stored field or byte is altered
covers: #Requirement: Prepared Publication Payload Is Exact and Durable
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#archive preparation storage rejects altered bytes and links without repairing or replacing them

- **WHEN** a preparation has an extra, missing, noncanonical, linked, or digest-inconsistent value
- **THEN** the store fails closed without repairing or replacing the record

### Requirement: Local Status Replays Git Truth Without Remote Authority
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Local Status Replays Git Truth Without Remote Authority
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#archive preparation status replays exact local Git truth without a worktree or runtime writes

- **WHEN** the stored preparation, protected refs, archive ref, report, tree, and assurance still agree
- **THEN** status returns the exact local archive identity and replay command
- **AND** its authority remains diagnostic

#### Scenario: Any bound Git fact drifts
covers: #Requirement: Local Status Replays Git Truth Without Remote Authority
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#archive preparation status replays exact local Git truth without a worktree or runtime writes

- **WHEN** a protected ref, archive ref, report, tree, configuration, or assurance identity differs
- **THEN** status reports the preparation stale
- **AND** all files, refs, worktrees, and runtime bytes remain unchanged

### Requirement: Publication Is Create-Only and Grant-Bound
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Publication Is Create-Only and Grant-Bound
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#prepares, publishes, and recovers one exact archive PR identity

- **GIVEN** an accepted exact Grant and unchanged target, ruleset, base, and archive head
- **WHEN** the explicit publisher observes the canonical archive ref absent
- **THEN** it creates only that ref and records the exact observed result
- **AND** retry confirms the same head without another effect

#### Scenario: Remote facts or authority drift
covers: #Requirement: Publication Is Create-Only and Grant-Bound
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#prepares, publishes, and recovers one exact archive PR identity

- **WHEN** any publication, ruleset, credential, Grant, branch, or pull-request identity differs
- **THEN** publication fails before broadening or replacing remote state

### Requirement: Remote Activation Remains Operationally Gated
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Remote Activation Remains Operationally Gated
test: packages/workflow-engine/test/archive-pr-orchestration.integration.test.ts#archive-pr dry-run creates only a local canonical preparation and reports the remote gate pending

- **WHEN** fake adapters and bare repositories prove preparation, collision, and recovery contracts
- **THEN** local implementation may be reported implemented and targeted-green
- **AND** every real hosted operation remains operational-gate-pending

### Requirement: Preflight and Status Are Read-Only
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Preflight and Status Are Read-Only
test: packages/workflow-engine/test/session-admission.integration.test.ts#task-session preflight reuses exact admission without mutating Git, runtime, or Grant state

- **WHEN** an agent runs `task-preflight` for a current selected task
- **THEN** the engine reports the exact observed admission and isolation facts
- **AND** repository, runtime, Grant, index, and ref bytes remain unchanged
- **AND** a later ingress repeats admission under the lifecycle locks

#### Scenario: Concurrent session status is inspected
covers: #Requirement: Preflight and Status Are Read-Only
test: packages/workflow-engine/test/session-concurrency.integration.test.ts#status inspects each concurrent active session in its own durable worktree

- **WHEN** two current sessions are active in distinct registered worktrees
- **THEN** status resolves each session against its own durable worktree binding
- **AND** inspection creates no new execution authority

### Requirement: Writer Admission Is Bounded and Isolated
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Writer Admission Is Bounded and Isolated
test: packages/workflow-engine/test/session-concurrency.integration.test.ts#two declared disjoint changes own durable isolated writers and an undeclared third writer is rejected

- **GIVEN** routing selects one primary and one concurrent current change
- **AND** their branches, worktrees, path scopes, serialized classes, and exclusive resources are disjoint
- **WHEN** task ingress creates both sessions
- **THEN** both sessions own exact durable isolation bindings
- **AND** each writer remains confined to its declared worktree and resources

#### Scenario: A third or overlapping writer is requested
covers: #Requirement: Writer Admission Is Bounded and Isolated
test: packages/workflow-engine/test/session-concurrency.integration.test.ts#two declared disjoint changes own durable isolated writers and an undeclared third writer is rejected

- **WHEN** capacity is full or any required isolation dimension conflicts
- **THEN** admission returns the exact conflict before publication
- **AND** existing sessions, leases, worktrees, index, and refs remain unchanged

### Requirement: Current Planning Authority Owns Admission
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Current Planning Authority Owns Admission
test: packages/workflow-engine/test/session-admission.integration.test.ts#task ingress pins the latest plan and rejects an older PlanReview after advisory preflight

- **WHEN** Manifest, PlanReview, routing, task, policy, or assignment facts drift before ingress
- **THEN** ingress rejects the stale candidate under the lifecycle locks
- **AND** the advisory preflight result grants no fallback authority

### Requirement: Session Leases and Recovery Are Durable
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Session Leases and Recovery Are Durable
test: packages/workflow-engine/test/open-task-atomic-ingress.integration.test.ts#ordinary open-task crash recovery preserves explicit no-mandate authority

- **WHEN** the process stops after publishing only a current subset of session and lease state
- **THEN** retry either completes the same exact admission or reports recovery-required
- **AND** it never creates a second owner for the change, worktree, or resource

### Requirement: Update Base Is Local and Sequential
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Update Base Is Local and Sequential
test: packages/workflow-engine/test/session-update-base.integration.test.ts#update-base replays a finished non-final task branch and recomputes local PR assurance

- **GIVEN** the finished session, branch, worktree, and target commit remain exact and clean
- **WHEN** update-base acquires the lifecycle lock and repeats its observations
- **THEN** it replays that branch onto the specified advancing local commit
- **AND** one concurrent change cannot alter the checked identities during the transition

#### Scenario: A writer appears before locked replay
covers: #Requirement: Update Base Is Local and Sequential
test: packages/workflow-engine/test/session-update-base.integration.test.ts#update-base revalidates active writers after acquiring the lifecycle lock

- **WHEN** a task session becomes active before update-base repeats admission under the lock
- **THEN** update-base refuses before changing branch history
- **AND** no receipt claims that the base advanced

### Requirement: Rebased Work Is Reassessed or Rolled Back
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

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
covers: #Requirement: Rebased Work Is Reassessed or Rolled Back
test: packages/workflow-engine/test/session-update-base.integration.test.ts#update-base rolls back when generated reconciliation needs a reviewed transition

- **WHEN** replay would require a separate reviewed generated transition
- **THEN** update-base rolls back the replay and reports the required transition
- **AND** current planning authority, branch, worktree, index, refs, and receipt state remain truthful

### Requirement: Canonical Planning Artifacts

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The repository SHALL use colocated `spec.md` contracts for normative requirements and one OpenSpec change directory under the configured change root for each active planning generation. Investigation-first current-v3 generations SHALL keep normalized investigation, proposal, design, delta specs, task list, execution strategy, guard, and exact-plan review in that canonical change tree. The repository SHALL NOT maintain a parallel workflow planning/task tree.

Detailed runtime transcripts, leases, and mutable refs MAY remain under the Git common directory, but every semantic fact required for remote planning assurance MUST be reconstructable from Git or retained in the compact tracked artifacts.

#### Scenario: Agent locates active work

covers: #Requirement: Canonical Planning Artifacts
test: packages/workflow-engine/test/system-spec.contract.test.ts#spec ownership follows nearest containment, common ancestors, and both sides of moves

- **WHEN** an agent locates the normative contract for a path or a cross-module change
- **THEN** ownership resolves to the nearest containing `spec.md` or the common containing contract
- **AND** a sibling directory prefix does not create a second owner

#### Scenario: Native planning retains one canonical authority tree

covers: #Requirement: Canonical Planning Artifacts
test: packages/workflow-engine/test/colocated-openspec.integration.test.ts#native OpenSpec validates and archives aliased deltas into one colocated spec without copying planning authority

- **GIVEN** reviewed OpenSpec change artifacts contain deltas for aliases of one colocated contract
- **WHEN** native validation and archive projection apply those deltas
- **THEN** the result updates that canonical contract without creating an `openspec/specs/` copy
- **AND** the archived planning artifacts preserve their reviewed bytes

#### Scenario: Current committed planning loads without private runtime

covers: #Requirement: Canonical Planning Artifacts
test: packages/workflow-engine/test/committed-investigation-manifest.contract.test.ts#committed change loading binds canonical v3 bytes to an immutable Git tree without private runtime

- **GIVEN** the current-v3 planning artifacts are committed and private investigation runtime has been removed
- **WHEN** committed change loading reconstructs planning authority
- **THEN** the Manifest observation binds the exact commit, tree, path, blob, and content digest from Git
- **AND** a live loader cannot substitute an absent private current ref for its own required live evidence

#### Scenario: CI validates investigation-first planning

covers: #Requirement: Canonical Planning Artifacts
test: packages/workflow-engine/test/session-schema.integration.test.ts#CI replays v3 planning assurance from Git with the live validator

- **GIVEN** a reviewed current-v3 planning generation was committed by the live transition
- **WHEN** CI replays that generation from Git objects
- **THEN** its planning assurance equals the exact assurance recorded by the live validator
- **AND** an exempt generation records an empty collaboration-grant use set rather than inventing a use

### Requirement: Blocking Session Preflight
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL refuse to create an active task session unless repository identity, branch, clean baseline, governing planning generation, change artifacts, a current sealed investigation or eligible structured investigation exemption, current PlanReview when applicable, task strategy, task policy, and exclusive lock invariants pass. For an investigation-first generation, the session SHALL pin `planningGenerationId`, exact investigation applicability node/digest, and exact current PlanReview node/digest.

#### Scenario: Advisory task preflight is read-only
covers: #Requirement: Blocking Session Preflight
test: packages/workflow-engine/test/session-admission.integration.test.ts#task-session preflight reuses exact admission without mutating Git, runtime, or Grant state

- **GIVEN** a current change and selected task
- **WHEN** an agent runs `task-preflight`
- **THEN** the engine reports the exact observed repository and Git identity, task and routing scope, allowed paths, required checks, Task Mandate requirement, and task-session isolation binding
- **AND** it does not acquire or reclaim a lifecycle lock, create a lease, session, journal, operation, or Grant, or authorize, reserve, or open the task
- **AND** a later `open-task` revalidates the same admission and isolation facts under the lifecycle locks before creating durable execution authority

#### Scenario: Dirty worktree is rejected
covers: #Requirement: Blocking Session Preflight
test: packages/workflow-engine/test/session.integration.test.ts#start rejects protected and dirty repositories without leaving runtime state

- **GIVEN** a valid change and task
- **AND** the working tree has a staged, unstaged, or untracked path
- **WHEN** session start is requested
- **THEN** the command exits with a guard failure
- **AND** it creates no active session or retained lock
- **AND** it does not stash, reset, delete, or absorb the existing work

#### Scenario: Valid investigation-first baseline creates a pinned session
covers: #Requirement: Blocking Session Preflight
test: packages/workflow-engine/test/session-schema.integration.test.ts#v3 sessions and every task report pin the exact planning assurance

- **GIVEN** a clean worktree on the exact change branch
- **AND** the latest managed plan generation, selected investigation applicability branch, proposal, design, delta specs, tasks, guard, execution strategy, and PlanReview validate
- **WHEN** session start is requested
- **THEN** one exclusive change lock is acquired
- **AND** an atomic session records repository, Git, planning generation, exact investigation applicability node/digest, exact PlanReview node/digest, artifact digest, task strategy/scope, actual orchestration and achieved independence, any grant/use/direct-human-attestation references, role constraints, and required checks

#### Scenario: Plan review belongs to an older generation
covers: #Requirement: Blocking Session Preflight
test: packages/workflow-engine/test/session-admission.integration.test.ts#task ingress pins the latest plan and rejects an older PlanReview after advisory preflight

- **GIVEN** a newer managed plan generation supersedes the generation named by PlanReview
- **WHEN** task start is requested
- **THEN** session creation fails before acquiring durable execution authority

#### Scenario: Valid baseline creates a pinned session
covers: #Requirement: Blocking Session Preflight
test: packages/workflow-engine/test/session.integration.test.ts#active session pins a clean baseline, enforces scope, and releases its lock

- GIVEN a clean worktree on the exact change branch
- AND proposal, design, delta specs, tasks, guard policy, and check IDs validate
- WHEN session start is requested
- THEN one exclusive change lock is acquired
- AND an atomic session records repository, Git, artifact digest, task scope,
  and required-check facts

### Requirement: Diff Scope Verification
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL compare changed and untracked paths with the selected
task's exact or segment-aware prefix allowlist.

#### Scenario: Out-of-scope path is detected
covers: #Requirement: Diff Scope Verification
test: packages/workflow-engine/test/session.integration.test.ts#active session pins a clean baseline, enforces scope, and releases its lock

- GIVEN an active session for one task
- WHEN a path outside that task's allowlist changes
- THEN workflow check fails with the unexpected path
- AND the task cannot be authorized complete

### Requirement: Evidence Owns Completion
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Task checkbox, completion, staging, commit, and archive transitions SHALL require
current engine evidence rather than an AI assertion or Markdown state alone.

#### Scenario: Checkbox has no matching report
covers: #Requirement: Evidence Owns Completion
test: packages/workflow-engine/test/ci.integration.test.ts#CI rejects a completed checkbox without an exact task trailer

- GIVEN a task checkbox is checked
- AND no current passing report matches the exact baseline and diff
- WHEN completion or CI verification runs
- THEN verification fails
- AND the checked box is treated as an invalid projection

### Requirement: Allowlisted Check Execution
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL execute every required check by resolving its ID from
the pinned check configuration and using only the current Node executable or a
declared workspace package bin invoked through that Node executable. It SHALL
NOT resolve bare executables from caller-controlled `PATH`, a global package
manager, a shell, interpolation, or evaluation. A non-zero exit, signal, spawn
error, or runner mutation SHALL fail verification with structured evidence.

#### Scenario: Shell syntax appears in an argument
covers: #Requirement: Allowlisted Check Execution
test: packages/workflow-engine/test/session-check.integration.test.ts#check executes required argv literally from the repository root

- GIVEN a required check contains shell metacharacters in one argv element
- WHEN verification executes the check
- THEN the metacharacters are delivered as a literal argument
- AND no shell side effect occurs

#### Scenario: A required check fails
covers: #Requirement: Allowlisted Check Execution
test: packages/workflow-engine/test/session-check.integration.test.ts#check fails on the first non-zero check and does not run later checks

- GIVEN a required check exits non-zero
- WHEN verification runs
- THEN verification fails with the check ID and exit outcome
- AND later required checks are not reported as passing

#### Scenario: PATH contains a fake executable
covers: #Requirement: Allowlisted Check Execution
test: packages/workflow-engine/test/session-check.integration.test.ts#node runner ignores caller-controlled PATH substitutes

- GIVEN a required check uses the `node` runner
- AND caller-controlled `PATH` points to a different executable named `node`
- WHEN verification runs
- THEN the engine uses its own `process.execPath`
- AND the PATH substitute is not executed

### Requirement: Immutable Evidence Chain
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Each passing check, planning evidence node, PlanReview, completion projection, finish projection, and managed commit SHALL produce or reference content-addressed immutable evidence. A transition SHALL validate the applicable node/report digest, kind, direct semantic inputs, provenance parents, session or planning-generation identity, pinned contract, Git baseline/target, changed paths, working-state fingerprint, role assurance, and required check evidence before relying on it. Every task check, completion, finish, and commit report for an investigation-first session SHALL reference the session-pinned `planningGenerationId` and exact PlanReview node/digest; changing or omitting either identity makes the report unusable.

#### Scenario: Task report omits the pinned plan review
covers: #Requirement: Immutable Evidence Chain
test: packages/workflow-engine/test/session-schema.integration.test.ts#completion rejects a check report with mismatched planning assurance

- **GIVEN** an investigation-first session pins one planning generation and exact PlanReview node
- **WHEN** check, completion, finish, or commit evidence omits or changes either identity
- **THEN** the evidence is rejected
- **AND** no later task transition relies on it

Planning evidence MUST distinguish a provenance-sensitive `nodeId` from a canonical semantic `resultDigest`; runtime-only metadata MUST NOT change semantic identity.

#### Scenario: Passing report payload is replaced
covers: #Requirement: Immutable Evidence Chain
test: packages/workflow-engine/test/completion.integration.test.ts#completion rejects stale and tampered check reports

- **GIVEN** a report ID is stored on an active session
- **AND** the file content no longer hashes to that ID
- **WHEN** the next transition is requested
- **THEN** the transition fails as stale state
- **AND** no checkbox, staging, ref update, or planning authorization is granted

#### Scenario: Report omits required check evidence
covers: #Requirement: Immutable Evidence Chain
test: packages/workflow-engine/test/completion.integration.test.ts#completion rejects a content-addressed report without check evidence

- **GIVEN** a content-addressed task report matches the current diff fingerprint
- **BUT** its check evidence omits a required ID or order
- **WHEN** completion or commit validation runs
- **THEN** the report is rejected

#### Scenario: Planning node exact input changes
covers: #Requirement: Immutable Evidence Chain
test: packages/workflow-engine/test/evidence-node.contract.test.ts#evidence nodeId binds exact inputs and provenance while resultDigest binds semantic output

- **GIVEN** a planning evidence node's exact input or provenance parent changes
- **WHEN** the node is recomputed
- **THEN** it receives a new `nodeId`
- **AND** no mutable pointer is rewritten to launder the old object as current

#### Scenario: Only runtime metadata changes
covers: #Requirement: Immutable Evidence Chain
test: packages/workflow-engine/test/evidence-node.contract.test.ts#evidence identity excludes runtime metadata and property insertion order

- **GIVEN** only timestamp, retry, latency, process, or display metadata differs
- **WHEN** semantic planning identity is recomputed under unchanged policy
- **THEN** `nodeId` and `resultDigest` remain unchanged

### Requirement: Serialized Completion Authority
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Only one state-changing operation SHALL act on a session at a time. The engine SHALL continue to support the legacy `check -> complete-task -> finish` sequence, in which completion changes only the exact unchecked checkbox and generated handoff bytes authorized by current evidence and finish reruns required checks before exact staging.

The engine SHALL additionally provide a projected single-pass path that constructs the exact implementation + checkbox + handoff prospective tree, executes every current-task required check exactly once against that complete projection, and stages only a tree proven identical to the checked prospective tree. Immediate-predecessor reconciliation MAY independently execute the predecessor's required checks and MUST keep that evidence distinct from the current task's finalization evidence. The single-pass path SHALL emit a schema-compatible check, completion, and finish evidence chain and SHALL leave managed commit as a separate transition that does not rerun required checks.

For a caught ordinary failure before successful final application, the single-pass path SHALL restore the exact pre-invocation engine-owned projection bytes and modes, leave the real index and session report pointers unchanged, remove its temporary state, and return the session to active use. It SHALL revalidate HEAD, session, contract, worktree, index, projection, runner inputs, and operation ownership before staging; a mismatch is stale state and MUST NOT cause partial staging. This substrate MUST NOT claim recovery from process death, machine loss, or mutation outside the governed projection; durable invocation recovery and commit transaction remain separate future requirements.

#### Scenario: Single-pass completion succeeds
covers: #Requirement: Serialized Completion Authority
test: packages/workflow-engine/test/completion.integration.test.ts#projected single-pass finalize checks and stages one exact final tree

- **GIVEN** an active task session has an allowed implementation diff, an empty index, and current pinned inputs
- **WHEN** projected single-pass finalization succeeds
- **THEN** every current-task required check executes exactly once against the implementation, checked task row, and generated handoff that will be staged
- **AND** the staged tree equals the checked prospective tree
- **AND** compatible check, completion, and finish reports bind that same tree
- **AND** the session awaits the separate managed commit transition

#### Scenario: Required check rejects the final projection
covers: #Requirement: Serialized Completion Authority
test: packages/workflow-engine/test/completion.integration.test.ts#projected single-pass failure restores projections and leaves no evidence pointers

- **GIVEN** a required check would pass on the implementation-only tree but fails when the projected checkbox or handoff is present
- **WHEN** projected single-pass finalization runs
- **THEN** the command fails without staging
- **AND** the engine-owned worktree projection bytes and modes equal their pre-invocation state
- **AND** no check, completion, or finish report pointer is advanced

#### Scenario: Real state drifts before exact staging
covers: #Requirement: Serialized Completion Authority
test: packages/workflow-engine/test/completion.integration.test.ts#projected single-pass rejects post-check worktree drift and rolls back staging

- **GIVEN** all checks passed against one prospective tree
- **AND** HEAD, session, contract, worktree, index, projection, runner inputs, or operation ownership no longer matches the pinned inspection
- **WHEN** the engine attempts final application
- **THEN** it rejects the evidence as stale
- **AND** it creates no partial staging projection

#### Scenario: Legacy completion remains available
covers: #Requirement: Serialized Completion Authority
test: packages/workflow-engine/test/completion.integration.test.ts#current report authorizes completion, exact staging, and commit

- **GIVEN** a caller uses the existing serialized completion commands
- **WHEN** `check`, `complete-task`, and `finish` run under their existing preconditions
- **THEN** the engine retains their existing report and recovery semantics
- **AND** introduction of the single-pass path does not silently reinterpret legacy reports

#### Scenario: Concurrent transition is requested
covers: #Requirement: Serialized Completion Authority
test: packages/workflow-engine/test/completion.integration.test.ts#a held session operation rejects competing completion transitions without changing state

- GIVEN one state-changing session operation holds the operation lock
- WHEN another check, completion, finish, commit, or abort is requested
- THEN the second operation fails with a conflict
- AND it does not overwrite report pointers or projections

#### Scenario: Existing manual staging is present
covers: #Requirement: Serialized Completion Authority
test: packages/workflow-engine/test/completion.integration.test.ts#finish preserves manual staging when current completion evidence exists

- GIVEN a completion projection has current evidence
- AND the index already contains manually staged paths
- WHEN finish is requested
- THEN finish rejects the index
- AND only an engine-controlled finish may create the staging projection

### Requirement: Atomic Managed Commit
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The engine SHALL create and fully verify a commit object with the authorized
single parent, tree, changed paths, and exact canonical trailer block before it
atomically advances the current branch from the pinned baseline using a
compare-and-swap ref update. Repository hooks SHALL NOT be commit authority.

#### Scenario: Branch moves before commit authorization
covers: #Requirement: Atomic Managed Commit
test: packages/workflow-engine/test/completion.integration.test.ts#managed commit refuses a moved branch and its ref CAS preserves the competing commit

- GIVEN a verified finish report pins one baseline
- AND the branch no longer points to that baseline
- WHEN commit is requested
- THEN the compare-and-swap fails
- AND the engine does not overwrite the moved branch

#### Scenario: Local commit hook is hostile
covers: #Requirement: Atomic Managed Commit
test: packages/workflow-engine/test/completion.integration.test.ts#managed commit bypasses hooks and accepts explicit workflow identity

- GIVEN a repository hook exits non-zero or attempts to rewrite a message
- WHEN the engine creates an already-authorized managed commit
- THEN the engine uses Git plumbing without invoking that hook
- AND it verifies the exact commit object before updating the ref

### Requirement: Controlled Managed-Document Mutation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Managed documents SHALL declare generated, append-only, curated, normative,
reference, or immutable mutation policy, and blocking claims SHALL only be made
after the corresponding executable validator and CI check exist.

#### Scenario: Generated handoff is edited directly
covers: #Requirement: Controlled Managed-Document Mutation
test: packages/workflow-engine/test/handoff.integration.test.ts#generated handoff rejects direct edits and resolves colocated references from tracked facts

- GIVEN managed handoff validation is active
- WHEN `docs/CURRENT_AND_NEXT_STEPS.md` differs from its deterministic projection
- THEN validation fails
- AND the correction must be made through an authorized managed transition

#### Scenario: Active document policy has no registered validator
covers: #Requirement: Controlled Managed-Document Mutation
test: packages/workflow-engine/test/issues.integration.test.ts#retired active IssueLog policy fails generically without reading poisoned legacy issue data

- GIVEN an active managed-document policy names an unregistered document path
- WHEN managed-document validation runs
- THEN validation fails with `UNSUPPORTED_ACTIVE_DOCUMENT_POLICY`
- AND it does not read the unsupported document target

### Requirement: Whole-Change Documentation Closure
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

For every managed change, the workflow engine SHALL require one authenticated
TaskDiff review of the whole final change before final task completion. The
review subject SHALL bind the parent of the first managed task commit, its tree,
the final projected candidate tree, every non-projection changed path, their
canonical transition digest, and code-owned documentation hints. Hints are
advisory inputs and SHALL NOT themselves decide documentation impact.

The reviewer SHALL return exactly one structured documentation assessment:
`updated` with exact changed documentation paths, `generated-verified` with
exact changed source/generated paths and check evidence, `no-impact` with a
bounded rationale only when no documentation path changed, or `needs-changes`
with exact documentation remediation paths. The engine SHALL use the existing
TaskDiff provider, collaboration-grant, caller-supplied, and direct-human review
authority paths and SHALL preserve their actual achieved independence.

#### Scenario: Final product task has no documentation impact
covers: #Requirement: Whole-Change Documentation Closure
test: packages/workflow-engine/test/task-diff-review-provider-worker.integration.test.ts#activated final task review binds documentation closure into commit and CI replay

- **GIVEN** the final candidate changes no documentation path
- **WHEN** the authenticated reviewer returns `no-impact` with a concrete rationale
- **THEN** finalization may continue
- **AND** the final task commit records the exact review and assessment

#### Scenario: Reviewer requires a documentation path outside task scope
covers: #Requirement: Whole-Change Documentation Closure
test: packages/workflow-engine/test/task-diff-review-provider-worker.integration.test.ts#documentation review opens exact remediation scope and requires a fresh final review

- **GIVEN** the final review returns `needs-changes`
- **WHEN** it names exact canonical paths under `docs/**` or an exact `README.md`
- **THEN** only those paths are added to that session's remediation scope
- **AND** every other out-of-scope path remains rejected
- **AND** accepting the challenge does not satisfy the old candidate
- **AND** the corrected candidate requires fresh checks and a fresh final review

#### Scenario: Final closure is replayed from Git
covers: #Requirement: Whole-Change Documentation Closure
test: packages/workflow-engine/test/task-diff-review-provider-worker.integration.test.ts#activated final task review binds documentation closure into commit and CI replay

- **GIVEN** the final task has a satisfied documentation assessment
- **WHEN** the managed task commit is created
- **THEN** its canonical message embeds a closure bound to the whole-change
  base/tree/path/patch digest, reviewer authority, assessment, final-assurance
  commitment when present, and remediation lineage
- **AND** commit recovery compares it with content-addressed report evidence
- **AND** CI and archive independently replay the closure from Git objects

### Requirement: Semantic Handoff Traceability
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The current-state handoff SHALL contain exactly current change, current task,
next task, current focus, known blockers, and durable references. It SHALL NOT
store baseline, latest, or implementation commit hashes or runtime session
facts. Managed commit relationships SHALL be discoverable from Git using exact
`Change:` and `Task:` trailers.

#### Scenario: Work is handed to another agent
covers: #Requirement: Semantic Handoff Traceability
test: packages/workflow-engine/test/handoff.integration.test.ts#repository handoff has exactly six semantic sections and no hashes

- GIVEN managed work has a current change and task
- WHEN a new agent reads `docs/CURRENT_AND_NEXT_STEPS.md`
- THEN it can locate the active artifacts and exact next work from semantic IDs
- AND no commit hash or copied session fact is required in the document

#### Scenario: A managed task is committed
covers: #Requirement: Semantic Handoff Traceability
test: packages/workflow-engine/test/completion.integration.test.ts#current report authorizes completion, exact staging, and commit

- GIVEN current evidence authorizes a managed commit
- WHEN the commit is created
- THEN its message contains matching `Change:` and `Task:` trailers
- AND runtime status can resolve the matching commit from Git
- AND no follow-up commit is required solely to record its hash

### Requirement: Spectra Non-Participation
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The repository workflow SHALL NOT invoke or depend on Spectra commands, skills,
lifecycle state, or adapters, while retained installation files MAY remain.

#### Scenario: Workflow engine runs without Spectra
covers: #Requirement: Spectra Non-Participation
test: packages/workflow-engine/test/session-check.integration.test.ts#workflow validation and session authority ignore retained Spectra metadata

- GIVEN Spectra is unavailable or unused
- WHEN workflow validation and session commands run
- THEN their behavior and authorization decisions are unchanged

### Requirement: Canonical Git Ignored-Directory Records
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL remove at most one trailing directory marker from each raw ignored-path record produced by Git before applying strict repository-path normalization. It MUST keep direct trailing-slash repository paths invalid, MUST fail closed when the decoded record remains noncanonical, and SHALL include the canonical ignored-directory path and its existing filesystem identity evidence in the working-state fingerprint.

#### Scenario: Ignored nested repository is fingerprinted
covers: #Requirement: Canonical Git Ignored-Directory Records
test: packages/workflow-engine/test/ignored-state.integration.test.ts#ignored nested repositories use canonical directory records in fingerprints

- **WHEN** Git reports a repository-ignored nested repository as `memo/`
- **THEN** the ignored-path adapter validates canonical path `memo`
- **THEN** working-state fingerprinting and change validation complete without treating the Git marker as an invalid repository path

#### Scenario: Generic repository path remains strict
covers: #Requirement: Canonical Git Ignored-Directory Records
test: packages/workflow-engine/test/contracts.test.ts#generic changed paths reject Git directory markers

- **WHEN** `memo/` is supplied directly as a generic changed repository path
- **THEN** repository-path normalization rejects it

#### Scenario: Ignored directory identity changes
covers: #Requirement: Canonical Git Ignored-Directory Records
test: packages/workflow-engine/test/ignored-state.integration.test.ts#ignored nested repositories use canonical directory records in fingerprints

- **WHEN** an ignored nested directory is removed or renamed between working-state fingerprints
- **THEN** the resulting fingerprint differs

### Requirement: Planning Evidence Invalidation Is Dependency-Specific and Fail-Closed
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Every planning evidence node SHALL declare exact direct inputs, semantic parent result digests, exact provenance parent node IDs, evaluator/schema/policy identity, and canonical output. A changed input SHALL stale its dependent descendants.

Unknown dependencies, missing parents, ambiguous grouping coverage, incompatible versions, or unverifiable input digests MUST remain stale.

#### Scenario: Unrelated term is added
covers: #Requirement: Planning Evidence Invalidation Is Dependency-Specific and Fail-Closed
test: packages/workflow-engine/test/investigation-groups.contract.test.ts#zero-hit and unrelated terms preserve current grouping identities

- **GIVEN** current evidence exists for sealed terms and their descendants
- **WHEN** another independent term is sealed
- **THEN** only its scan and changed descendants are computed
- **AND** unrelated current nodes remain reusable

### Requirement: Live and CI Planning Assurance Share Content-Pure Validators
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Every replayable investigation or exemption, projection, planning-generation, PlanReview, actor/role result, collaboration-grant use, and evidence-DAG gate SHALL have one content-pure validator over a canonical subject, reviewed policy, immutable artifacts, and resolved Git objects. Live transitions and CI SHALL call the same validator semantics. Collaboration evidence SHALL additionally pass one aggregate validator that rejects duplicate grant/use identities across the complete replayed subject.

Provider invocation itself MUST NOT be replayed in CI. CI MUST NOT upgrade soft identity, orchestration, independence, containment, WHY truth, or reviewer judgment claims.

#### Scenario: Live and CI receive the same canonical subject
covers: #Requirement: Live and CI Planning Assurance Share Content-Pure Validators
test: packages/workflow-engine/test/evidence-dag.contract.test.ts#live and CI loaders share one canonical content-pure planning validator

- **GIVEN** live transition and CI loaders construct the same canonical subject and immutable artifact set
- **WHEN** planning validation runs
- **THEN** both callers produce the same pass/fail result and semantic result digest

#### Scenario: CI lacks provider credentials
covers: #Requirement: Live and CI Planning Assurance Share Content-Pure Validators
test: packages/workflow-engine/test/session-schema.integration.test.ts#CI replays v3 planning assurance from Git with the live validator

- **GIVEN** tracked PlanReview and investigation evidence are structurally current
- **WHEN** CI validates them without Codex, Claude, credentials, or local invocation transcripts
- **THEN** CI replays schema, digest, applicability/exemption, scan when applicable, projection, target, role-result admission, grant/use including aggregate uniqueness, and freshness gates
- **AND** it does not rerun or reinterpret AI judgment

#### Scenario: Candidate evidence requires runtime-only semantic data
covers: #Requirement: Live and CI Planning Assurance Share Content-Pure Validators
test: packages/workflow-engine/test/session-schema.integration.test.ts#CI fails closed when a v3 plan omits tracked semantic evidence

- **GIVEN** a candidate planning claim cannot be reconstructed from Git and omits that semantic fact from tracked evidence
- **WHEN** CI assurance runs
- **THEN** validation fails closed

### Requirement: Assurance Claims Preserve Their Actual Hardness
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Workflow artifacts and output SHALL use the stable claim-ID registry from the formal design and distinguish hard mechanical facts from soft semantic or local-identity claims. They SHALL preserve each claim's registered hardness and delivery owner; future T2 claims MUST be labeled undelivered until their owner is implemented. They SHALL distinguish self-declared, runtime-hint, adapter-assigned, provider-signed, and workload-attested identity when present, and SHALL distinguish provider independence, session independence, and no independence.

No report or documentation SHALL claim complete breadth, genuine depth, correct WHY, correct AI verdict, cryptographic local model identity, same-user adversarial confinement, or semantic closure from exact-term scans.

An investigation exemption MUST mark `C-TERM-SCAN`, `C-WHY-BINDING`, and related breadth/depth claims inapplicable for its exact scope rather than satisfied. It MUST NOT strengthen `C-TERM-COMPLETENESS`, `C-GRAPH-COMPLETENESS`, or any other soft claim.

#### Scenario: Runtime hint selects an actor
covers: #Requirement: Assurance Claims Preserve Their Actual Hardness
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#actor resolution preserves all agreeing soft signals and their grade

- **GIVEN** actor identity is supported only by a recognized runtime hint
- **WHEN** assurance is rendered locally or in CI
- **THEN** the identity remains labeled `runtime-hint`
- **AND** CI does not upgrade it

#### Scenario: Every sealed term was scanned
covers: #Requirement: Assurance Claims Preserve Their Actual Hardness
test: packages/workflow-engine/test/public-contract-surface.test.ts#public guidance preserves the assurance registry and keeps exemptions distinct

- **GIVEN** deterministic scan validation proves every effective sealed term has a current node
- **WHEN** breadth assurance is summarized
- **THEN** the report claims complete execution of the sealed term set
- **AND** it does not claim that every semantically relevant term or dependency was found

#### Scenario: WHY fields are present and blob-bound
covers: #Requirement: Assurance Claims Preserve Their Actual Hardness
test: packages/workflow-engine/test/public-contract-surface.test.ts#public guidance preserves the assurance registry and keeps exemptions distinct

- **GIVEN** structural WHY validation passes
- **WHEN** depth assurance is summarized
- **THEN** the report claims current exact-blob field binding
- **AND** it does not claim that the explanation is true or that cognition was proved

#### Scenario: Exempt investigation renders assurance
covers: #Requirement: Assurance Claims Preserve Their Actual Hardness
test: packages/workflow-engine/test/public-contract-surface.test.ts#public guidance preserves the assurance registry and keeps exemptions distinct

- **GIVEN** the current plan used an eligible structured investigation exemption
- **WHEN** local or CI assurance is rendered
- **THEN** scan and WHY claims are labeled inapplicable rather than passed
- **AND** the exemption does not imply semantic completeness or understanding

#### Scenario: Future claim is rendered before its owner is implemented
covers: #Requirement: Assurance Claims Preserve Their Actual Hardness
test: packages/workflow-engine/test/public-contract-surface.test.ts#public guidance preserves the assurance registry and keeps exemptions distinct

- **GIVEN** the registry assigns a claim such as exact closure or coverage composition to a future T2 change
- **WHEN** T1.5 assurance is rendered
- **THEN** the claim is labeled undelivered
- **AND** no synonym promotes it to a current hard guarantee

### Requirement: Current archive requires canonical task evidence
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Archive eligibility and CI archive replay SHALL require exactly one canonical workflow commit for every completed task in the current task execution generation. A completion that predates the earliest canonical plan commit MUST NOT substitute for current task evidence. The engine SHALL preserve canonical recording and configured-base reachability verification for every accepted task commit.

#### Scenario: Bootstrap-era completions still need current evidence
covers: #Requirement: Current archive requires canonical task evidence
test: packages/workflow-engine/test/archive-eligibility.integration.test.ts#archive eligibility rejects pre-epoch task completions without current evidence

- **WHEN** a task was marked complete before a canonical plan revision but has no canonical workflow commit in the current task execution generation
- **THEN** live archive eligibility reports missing task evidence
- **AND** the historical completion does not create an exemption

#### Scenario: Canonical-era completions stay enforced
covers: #Requirement: Current archive requires canonical task evidence
test: packages/workflow-engine/test/archive-eligibility.integration.test.ts#archive eligibility keeps canonical-era completions enforced

- **WHEN** a task was marked complete after a canonical plan revision without a canonical workflow commit
- **THEN** archive eligibility reports missing task evidence

#### Scenario: Replay also requires current evidence for historical completions
covers: #Requirement: Current archive requires canonical task evidence
test: packages/workflow-engine/test/ci-archive.integration.test.ts#current archive rejects pre-epoch task completions without current evidence

- **WHEN** CI replays an archive containing pre-epoch task completion without current canonical task evidence
- **THEN** replay rejects the archive instead of deriving a historical exempt set

### Requirement: Open Task Presents Pinned System Meaning
sources: [SRC-9e0335a71c67a8c57e3d03c9fe6070503f73b89d92c0426cd40a6c5aad615d8e, SRC-4e187741d599681280dac6aebd8f47c4f47baf81ba6f137d8eec2c67a12e1b84]

Open-task results SHALL include readable system meaning from the task's pinned baseline: applicable containing contracts, exact cited Source wording, managed README explanations and shallow file-header responsibilities and invariants. The context SHALL include declared future paths through their containing scopes, omit sibling-only contracts, and keep technical metadata out of the readable contract prose. Reading this context MUST NOT fabricate explanation or test evidence.

#### Scenario: Scoped context includes exact wording and containing contracts
covers: #Requirement: Open Task Presents Pinned System Meaning
test: packages/workflow-engine/test/system-document-context.contract.test.ts#task context resolves ancestor contracts and exact Source wording without opaque metadata

- **WHEN** a task reads the system meaning for its allowed paths
- **THEN** it receives the applicable ancestor contracts and exact Source wording
- **AND** unrelated sibling contracts and machine-only metadata are omitted

#### Scenario: Working edits do not change the pinned context
covers: #Requirement: Open Task Presents Pinned System Meaning
test: packages/workflow-engine/test/system-document-context.contract.test.ts#task context uses committed baseline bytes after working documents change

- **WHEN** checkout documents change after the task baseline was committed
- **THEN** open-task context still reads the pinned baseline bytes

### Requirement: Finalize Records Exact Contract and Explanation Dispositions
sources: [SRC-1b0a1a298bf1d96185dacacad60dab92d4213d7713a167911e8ae60181dc322d, SRC-be69144599ec1bdbbe9a4ee5e6636d0a044e7404b465f5fc5c209ffa4381ca77]

For any diff within a containing system contract, including documents, moves and deletions, finalize SHALL collect the affected contract and managed README explanation obligations from both the before and after snapshots. Each obligation SHALL receive one disposition: `still-valid`, an observed `updated`, or `later` with an explicit reason. A planned spec delta counts as an update only when it changes the actual contract; generated README content or a changed confirmation commit alone MUST NOT count as an explanation update.

Document dispositions SHALL bind the exact task, baseline, implementation fingerprint, document bytes and applicable delta bytes. A changed candidate SHALL require a new decision. Missing obligations SHALL expose an exact Central Grant transition. An accepted Grant SHALL retain a recoverable `skipped-by-grant` exception and MUST NOT be described as a successful review or passing test.

#### Scenario: Finalize uses exact decisions before required checks
covers: #Requirement: Finalize Records Exact Contract and Explanation Dispositions
test: packages/workflow-engine/test/system-document-finalize.integration.test.ts#finalize requires exact document decisions before checks and recovers the admitted projection

- **WHEN** finalize observes missing decisions or a candidate changed after review
- **THEN** it requests current document dispositions before running the task checks
- **AND** after valid disposition, single-pass finalization keeps the admitted projection and check evidence

#### Scenario: Grant recovery preserves the actual exception
covers: #Requirement: Finalize Records Exact Contract and Explanation Dispositions
test: packages/workflow-engine/test/system-document-finalize.integration.test.ts#Central Grant document exception recovers its exact receipt and never marks review passed

- **WHEN** Grant execution is interrupted after the durable document exception
- **THEN** recovery reuses the exact receipt
- **AND** the exception remains skipped-by-grant and cannot authorize a changed candidate

#### Scenario: A missing explanation is not still valid
covers: #Requirement: Finalize Records Exact Contract and Explanation Dispositions
test: packages/workflow-engine/test/system-document-disposition.contract.test.ts#a removed or unreadable handwritten explanation cannot be confirmed as still valid

- **WHEN** a README remains but its managed explanation is removed or unreadable
- **THEN** the document still needs disposition and cannot be confirmed as still-valid
- **AND** an explicit reason can defer that obligation

### Requirement: Current Planning Replay Requires Complete Parent and Result Trees
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Current-schema CI planning replay SHALL require complete canonical planning artifacts in an existing revision's parent and result trees. Adding an artifact in the result SHALL NOT retroactively make an incomplete current-schema parent valid. The existing deletion-only allowance for noncanonical planning noise SHALL remain available when current required artifacts are otherwise valid.

#### Scenario: Adding an artifact does not repair the historical parent
covers: #Requirement: Current Planning Replay Requires Complete Parent and Result Trees
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI rejects a current-schema parent missing a required artifact even when the revision repairs it

- **WHEN** a revision adds `execution.json` that was absent from its current-schema parent
- **THEN** replay rejects the incomplete parent rather than accepting a bootstrap exception

#### Scenario: An unrepaired parent remains invalid
covers: #Requirement: Current Planning Replay Requires Complete Parent and Result Trees
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI still rejects a revision whose before tree stays incomplete

- **WHEN** required parent artifacts remain absent across a revision
- **THEN** replay reports the missing artifact

#### Scenario: An incomplete resulting tree is rejected
covers: #Requirement: Current Planning Replay Requires Complete Parent and Result Trees
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI rejects an incomplete planning tree and a non-canonical plan message

- **WHEN** a planning commit lacks a required resulting artifact
- **THEN** replay rejects the incomplete planning tree

#### Scenario: Removing noise preserves a complete planning revision
covers: #Requirement: Current Planning Replay Requires Complete Parent and Result Trees
test: packages/workflow-engine/test/ci-planning.integration.test.ts#CI accepts a revision that deletes non-canonical planning noise

- **WHEN** a valid current revision removes a noncanonical file inside its own planning tree
- **THEN** the existing deletion-only allowance accepts that removal
- **AND** required planning artifacts still satisfy their current contracts

### Requirement: Engine-Owned Disposable Database Preflight
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

Before executing any destructive database check, the workflow engine SHALL
require `WORKFLOW_DISPOSABLE_DATABASE=1`, parse an explicit PostgreSQL
`TEST_DATABASE_URL`, require a disposable database-name token, reject
development/shared/staging/production identities, and reject the same
server/database identity as `DATABASE_URL`. It SHALL expose only a redacted
database identity in results and errors.

#### Scenario: One destructive check has an unsafe database
covers: #Requirement: Engine-Owned Disposable Database Preflight
test: packages/workflow-engine/test/session-check.integration.test.ts#destructive database preflight runs before any required check

- GIVEN at least one required check is marked `destructiveDatabase`
- AND the database preflight is missing or unsafe
- WHEN verification is requested
- THEN no required check starts
- AND the failure does not reveal credentials or the raw URL

#### Scenario: Disposable database is explicitly confirmed
covers: #Requirement: Engine-Owned Disposable Database Preflight
test: packages/workflow-engine/test/session-check.integration.test.ts#destructive check evidence includes only the redacted database identity

- GIVEN `WORKFLOW_DISPOSABLE_DATABASE=1`
- AND `TEST_DATABASE_URL` names a disposable PostgreSQL database distinct from
  `DATABASE_URL`
- WHEN verification executes destructive checks
- THEN each destructive check receives the explicit test URL
- AND evidence contains only its redacted identity

#### Scenario: Alternate URLs cannot replace an explicit test target
covers: #Requirement: Engine-Owned Disposable Database Preflight
test: packages/workflow-engine/test/contracts.test.ts#disposable database policy fails closed without leaking connection secrets

- **GIVEN** destructive database execution is explicitly confirmed
- **AND** only development or compose URLs are supplied, without `TEST_DATABASE_URL`
- **WHEN** the engine validates the check environment
- **THEN** it reports `TEST_DATABASE_URL_REQUIRED` without selecting either alternate URL
- **AND** the failure contains neither connection credentials nor the raw URL

### Requirement: Provider Assignment and Waiting Preserve Current Evidence
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-5cdc4849e2c39d2af2dce4a96fd95b92fac190f87813f6ac59779ece7ab8aafb]

Provider assignment SHALL satisfy the requested independence. When no eligible candidate exists, ordinary scheduling SHALL report `collaboration-grant-required` without silently assigning a conflicting provider. A later eligible assignment SHALL remain bound to the same target and requested independence. Prepared invocations and lifecycle operations waiting on them SHALL preserve durable current evidence. Waiting or retrying transport alone MUST NOT recreate a semantic subject or rerun already-current checks.

#### Scenario: Explicit provider independence has no eligible alternate
covers: #Requirement: Provider Assignment and Waiting Preserve Current Evidence
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#ordinary role scheduling uses fresh sessions and preserves explicit provider diversity

- **WHEN** provider-independent review is requested and only the author's provider is available
- **THEN** scheduling reports collaboration-grant-required with NO_REQUIRED_INDEPENDENCE_CANDIDATE
- **AND** it does not return a weaker assignment

#### Scenario: The eligible alternate becomes available
covers: #Requirement: Provider Assignment and Waiting Preserve Current Evidence
test: packages/workflow-engine/test/provider-orchestration.contract.test.ts#ordinary role scheduling uses fresh sessions and preserves explicit provider diversity

- **WHEN** the alternate becomes available for the same target and provider-independent request
- **THEN** scheduling assigns that alternate with the original target digest and required independence

#### Scenario: A waiting review resumes without repeating current checks
covers: #Requirement: Provider Assignment and Waiting Preserve Current Evidence
test: packages/workflow-engine/test/task-diff-review-provider-lifecycle.integration.test.ts#finalize pauses before staging for a required review and resumes without rerunning checks after the exact result is adopted

- **WHEN** finalize has durable passing checks and waits for its exact required provider review
- **THEN** staging remains unapplied during the wait
- **AND** adopting the exact provider result resumes finalize while the check execution count remains one

#### Scenario: A transport retry retains the durable semantic subject
covers: #Requirement: Provider Assignment and Waiting Preserve Current Evidence
test: packages/workflow-engine/test/task-strategy-provider-retry.integration.test.ts#routine resume replaces a failed implementation transport without changing its semantic subject

- **WHEN** implementation transport fails and the workflow resumes from the current durable state
- **THEN** the replacement invocation retains the input manifest, target digest and owner investigation
- **AND** only transport identity and nonce change before the exact result is adopted
