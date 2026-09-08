# Investigation
capabilities: [investigation-first-planning]

## Purpose

Make investigation and its declared exceptions explicit before planning authority, with bounded term discovery and complete tracked-tree scanning.
## Requirements
### Requirement: Current Investigation Applicability Gates Authoritative Planning
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL bind each investigation applicability decision to a structured change intent and pinned repository baseline. It MUST NOT authorize or materialize the authoritative design or planning transition until the current applicability ref selects either a current sealed investigation or a current eligible structured investigation exemption.

Non-authoritative scratch material MUST NOT be adopted automatically as authoritative planning input.

#### Scenario: Design is requested before investigation seal
covers: #Requirement: Current Investigation Applicability Gates Authoritative Planning
test: packages/workflow-engine/test/investigation-propose-flow.integration.test.ts#collects breadth, dispositions and WHY evidence before sealing

- **GIVEN** a change has neither a current sealed investigation nor an eligible current investigation exemption
- **WHEN** authoritative design materialization is requested
- **THEN** the operation fails without authorizing a design or planning transition
- **AND** any scratch or unmanaged design remains non-authoritative and unmodified

#### Scenario: Investigation inputs drift after sealing
covers: #Requirement: Current Investigation Applicability Gates Authoritative Planning
test: packages/workflow-engine/test/investigation-session.integration.test.ts#baseline drift and unsafe durable files fail closed

- **GIVEN** an investigation was sealed for one intent and repository baseline
- **WHEN** the material intent or pinned baseline changes
- **THEN** the prior investigation becomes stale
- **AND** planning remains blocked until the changed investigation is sealed

### Requirement: Investigation Exemption Is Structured, Narrow, and Reviewed
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL permit an `investigation-exemption` only for documentation-only, formatting-only, deterministic-generated-projection, or time-boxed-research work that neither modifies nor relies on existing non-trivial behavior. The exemption MUST bind category, exact baseline and normalized intent, normalized declared paths/scope, bounded non-empty rationale, semantic author/provenance, `nonTrivialBehaviorReliance: none-declared`, applicable research budget, and the code-owned exemption-policy digest.

Security, migration, shared-contract, public-API, rename/removal, and behavioral work MUST be ineligible. The exact-plan review target MUST contain and challenge the exemption. Only scan, hit disposition, and WHY-ledger requirements are exempted; every other planning and execution gate remains required. The engine MUST NOT represent an exemption as an empty sealed investigation or claim that exemption proves breadth or depth.

#### Scenario: Eligible documentation-only change uses an exemption
covers: #Requirement: Investigation Exemption Is Structured, Narrow, and Reviewed
test: packages/workflow-engine/test/investigation-propose-admission.integration.test.ts#structured investigation exemption starts a durable planning branch without manufactured survey evidence

- **GIVEN** a documentation-only change neither changes nor relies on non-trivial behavior
- **WHEN** its exact structured exemption and PlanReview are validated
- **THEN** planning may proceed without scan, disposition, or WHY nodes
- **AND** all non-investigation planning, review, task, check, and Git gates still apply

#### Scenario: Behavioral work requests an exemption
covers: #Requirement: Investigation Exemption Is Structured, Narrow, and Reviewed
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#investigation applicability admits only exact reviewed low-risk exemptions

- **GIVEN** a change modifies behavior, security, migration, a shared contract, public API, or a rename/removal
- **WHEN** investigation exemption eligibility is evaluated
- **THEN** the exemption is rejected
- **AND** the ordinary sealed-investigation path remains required

#### Scenario: Exemption contains empty investigation stand-ins
covers: #Requirement: Investigation Exemption Is Structured, Narrow, and Reviewed
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#v3 exemption is a strict separate branch with no synthetic proof collections

- **GIVEN** an exemption artifact contains empty term, scan, disposition, or WHY nodes as if they were completed evidence
- **WHEN** the applicability branch is validated
- **THEN** validation fails
- **AND** the empty nodes do not satisfy breadth or depth claims

### Requirement: Investigation Uses Three Term Sources With a Reviewer Pre-Anchor Turn
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL derive a non-removable engine search floor, accept a typed Author term contribution, and obtain a session-independent Reviewer pre-anchor contribution before sealing the effective term union. Blind is the Reviewer's sealed first turn, not a fourth role: its request MUST be sealed before Author terms, conclusions, plan drafts, or Builder transcripts become visible. The ordinary Reviewer MAY use the same provider as the Author when it runs in a fresh engine-spawned session, and the achieved independence MUST be recorded honestly. A reviewed risk policy MAY strengthen the floor to provider independence; only an eligible exact Grant may authorize a visible below-policy continuation. Every Author term MUST include normalized kind/value plus bounded non-empty rationale and expected relationship to the change.

The floor SHALL deterministically include every valid term derivable from available machine-readable facts: explicit paths, symbols, and configuration keys in normalized intent; both old and new identifiers for rename, removal, or transformation intent; renamed or removed path basenames and stems available from a pinned diff; and reviewed generated or mirror counterparts of a derived subject. Every floor term SHALL retain the source fact and derivation rule. If any qualifying fact exists, the engine MUST NOT emit an empty or incomplete floor.

If no qualifying fact exists, the engine SHALL record a typed `noDerivableFloorFacts` result naming every checked category. That result MUST NOT be represented as a breadth contribution, and sealing SHALL still require non-empty Author and Reviewer pre-anchor term contributions at the effective independence floor.

The Reviewer pre-anchor request MUST contain the normalized intent, pinned repository baseline, read-only repository access, and a structured architecture-level survey question. It MUST be sealed before the engine reads the Author contribution and MUST NOT contain the engine floor, Author terms, prior hit lists, prior conclusions, plan drafts, or Builder transcripts.

Term identity and scan deduplication SHALL depend on normalized kind, value, and matching semantics, while the contribution digest SHALL include rationale and expected relationship and preserve those fields per source. The engine validates their structure and binding but MUST NOT claim either explanation is true.

#### Scenario: Reviewer pre-anchor input is constructed
covers: #Requirement: Investigation Uses Three Term Sources With a Reviewer Pre-Anchor Turn
test: packages/workflow-engine/test/investigation-session.integration.test.ts#start seals a manifest-bound blind request before accepting main terms

- **GIVEN** a normalized intent and pinned baseline
- **WHEN** the Reviewer pre-anchor survey manifest is sealed
- **THEN** it contains the intent, baseline, read-only capability, and survey schema
- **AND** it does not contain the engine floor, main terms, prior hits, or prior conclusions

#### Scenario: Effective term union is sealed
covers: #Requirement: Investigation Uses Three Term Sources With a Reviewer Pre-Anchor Turn
test: packages/workflow-engine/test/investigation-session.integration.test.ts#main terms and provider result join deterministically in either order

- **GIVEN** current engine, Author, and Reviewer pre-anchor contributions
- **WHEN** the investigation term union is sealed
- **THEN** every accepted term from each source appears in the effective union
- **AND** every term retains all source provenance

#### Scenario: Main term omits semantic metadata
covers: #Requirement: Investigation Uses Three Term Sources With a Reviewer Pre-Anchor Turn
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#main terms require bounded rationale and expected relationship without changing term identity

- **GIVEN** a main-agent term has kind and value but lacks rationale or expected relationship
- **WHEN** the contribution is validated
- **THEN** it is rejected before term sealing

#### Scenario: Multiple sources contribute the same term
covers: #Requirement: Investigation Uses Three Term Sources With a Reviewer Pre-Anchor Turn
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#typed terms preserve exact bytes, deduplicate semantics, and retain every provenance

- **GIVEN** main and survey contributions normalize to the same term identity
- **WHEN** the effective union is built
- **THEN** the term is scanned once under its stable term identity
- **AND** each source contribution retains its own provenance and semantic metadata

#### Scenario: Qualifying floor facts exist
covers: #Requirement: Investigation Uses Three Term Sources With a Reviewer Pre-Anchor Turn
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#engine floor is complete, provenance-preserving, and validates by recomputation

- **GIVEN** normalized intent or pinned diff contains an explicit path, symbol, configuration key, rename/removal identifier, or reviewed generated/mirror counterpart
- **WHEN** the engine derives the search floor
- **THEN** every qualifying fact maps to its required typed term with provenance
- **AND** an empty or incomplete floor fails validation

#### Scenario: No floor fact is derivable
covers: #Requirement: Investigation Uses Three Term Sources With a Reviewer Pre-Anchor Turn
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#engine floor is complete, provenance-preserving, and validates by recomputation

- **GIVEN** every reviewed machine-readable derivation category is empty
- **WHEN** the engine derives the search floor
- **THEN** it records `noDerivableFloorFacts` with the checked categories
- **AND** investigation cannot seal without non-empty Author and Reviewer pre-anchor contributions at the effective independence floor

#### Scenario: Strengthened provider floor is unavailable under an eligible Grant
covers: #Requirement: Investigation Uses Three Term Sources With a Reviewer Pre-Anchor Turn
test: packages/workflow-engine/test/collaboration-grant-role-use.integration.test.ts#same-provider grants require the only callable provider and a fresh engine session

- **GIVEN** reviewed risk policy has strengthened the Reviewer pre-anchor turn to provider independence and no alternate provider is callable
- **WHEN** an exact Grant authorizes a below-policy Reviewer contribution
- **THEN** the contribution replaces rather than satisfies the strengthened provider-independent requirement
- **AND** its actual independence level remains explicit
- **AND** the engine does not describe the contribution as provider-independent when it was not

### Requirement: Every Sealed Term Is Scanned Across the Governed Tracked Tree
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL deterministically scan every effective sealed term against the pinned Git-tracked tree. The scan SHALL include tracked paths and text blobs across source, tests, documentation, configuration, hooks, mirrors, generated contracts, and every governed mutation class.

The scan MUST NOT use task `allowedPaths` as a breadth boundary and MUST NOT read untracked files, ignored files, repository-external paths, environment files, or credentials. Every effective sealed term MUST have a current scan result before investigation can be sealed.

#### Scenario: Relevant hit is outside planned task paths
covers: #Requirement: Every Sealed Term Is Scanned Across the Governed Tracked Tree
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#pinned scan ignores index, worktree, untracked, ignored, caller PATH, and allowedPaths

- **GIVEN** a sealed term matches a tracked file outside planned task paths
- **WHEN** the governed scan runs
- **THEN** the hit is recorded
- **AND** task `allowedPaths` do not hide it

#### Scenario: Untracked or ignored file contains a term
covers: #Requirement: Every Sealed Term Is Scanned Across the Governed Tracked Tree
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#pinned scan ignores index, worktree, untracked, ignored, caller PATH, and allowedPaths

- **GIVEN** a sealed term occurs only in an untracked or ignored file
- **WHEN** the governed scan runs
- **THEN** that file content is not read or reported as a tracked-tree hit

#### Scenario: Sealed term has no current scan
covers: #Requirement: Every Sealed Term Is Scanned Across the Governed Tracked Tree
test: packages/workflow-engine/test/investigation-manifest-v3.test.ts#production builder deterministically seals raw domain facts and rejects stale authority

- **GIVEN** an effective sealed term lacks a scan bound to the current tree and scan policy
- **WHEN** investigation sealing is requested
- **THEN** sealing fails

#### Scenario: Sealed term has zero hits
covers: #Requirement: Every Sealed Term Is Scanned Across the Governed Tracked Tree
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#literal scans are deterministic, per-term independent, and include zero-hit nodes

- **GIVEN** a sealed term was scanned against the complete governed tracked tree and has no hits
- **WHEN** currentness is evaluated
- **THEN** the zero-hit scan is accepted as a current result

#### Scenario: Blob cannot be scanned as governed text
covers: #Requirement: Every Sealed Term Is Scanned Across the Governed Tracked Tree
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#tree reader preserves raw paths and records every unsupported object

- **GIVEN** a tracked object is binary, invalid UTF-8, oversized, or otherwise unsupported by the governed text policy
- **WHEN** the scanner encounters it
- **THEN** the scanner records the exact object and skip reason
- **AND** it does not silently claim that the object's content was scanned

### Requirement: Propose Is a Durable Resumable Planning Wrapper
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The routine `workflow propose` surface SHALL persist investigation state, start the blind work before main-agent semantic input is consumed, emit typed caller work envelopes, and resume from the last durable checkpoint. It MUST NOT require one long-lived process or an interactive TTY questionnaire for routine agent input.

The wrapper SHALL assemble existing planning and plan-commit prerequisites without replacing their authority or exposing a separate routine review journey.

#### Scenario: Caller must provide main terms
covers: #Requirement: Propose Is a Durable Resumable Planning Wrapper
test: packages/workflow-engine/test/investigation-session.integration.test.ts#start seals a manifest-bound blind request before accepting main terms

- **GIVEN** an investigation has started and its blind request is sealed
- **WHEN** the wrapper needs the caller's term contribution
- **THEN** it returns an `awaiting-main-terms` state and a typed input schema
- **AND** the blind provider work may proceed independently

#### Scenario: Process exits while provider work is pending
covers: #Requirement: Propose Is a Durable Resumable Planning Wrapper
test: packages/workflow-engine/test/investigation-propose-admission.integration.test.ts#propose CLI persists a fake-backed wait for read-only status in a fresh process

- **GIVEN** a durable investigation has pending provider work
- **WHEN** the initiating CLI process exits or is interrupted
- **THEN** status and resume preserve every current completed node
- **AND** the caller is not required to restart investigation from the beginning

#### Scenario: Planning prerequisites become current
covers: #Requirement: Propose Is a Durable Resumable Planning Wrapper
test: packages/workflow-engine/test/investigation-plan-review-dispositions.integration.test.ts#requires current review evidence and authorized dispositions before commit

- **GIVEN** investigation, planning materialization, PlanReview, and challenge dispositions are current
- **WHEN** the propose wrapper reaches its terminal planning step
- **THEN** it invokes the existing managed plan transition
- **AND** it does not hand-author a commit or bypass plan-transition validation

### Requirement: Manifest v3 and PlanReview Remain Separate Authorities
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

`investigation.json` SHALL contain only the current schema-v3 Manifest and its investigation attestation. `plan-review.json` SHALL remain a separate artifact bound to the exact `manifestDigest`, `investigationTargetDigest`, planning generation, complete plan target, reviewer result, challenges, dispositions, and provenance. A change to baseline, intent, terms, evaluator/policy versions, roots, Groups, Dispositions, WHY, knowledge references, exceptions, or provenance MUST stale both the investigation seal and any PlanReview that targeted it.

Any degraded-continuation reference SHALL appear only where the published central Fail-Grant contract requires it. Investigation v3 MUST NOT invent a local reference field or placement rule.

#### Scenario: Manifest semantics change after PlanReview
covers: #Requirement: Manifest v3 and PlanReview Remain Separate Authorities
test: packages/workflow-engine/test/planning-generation-subject.contract.test.ts#planning generation and review subject bind exact v3 Manifest identities

- **GIVEN** PlanReview binds one exact v3 Manifest target
- **WHEN** any replay input, semantic delta, derived commitment, provenance, or attestation changes
- **THEN** the old PlanReview is stale
- **AND** a fresh exact-plan review is required independently of investigation validation

### Requirement: Search Terms Form Bounded Provenance-Preserving Unions
sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad]

The workflow engine SHALL accept fixed typed terms with deterministic case-sensitive literal matching, normalize their identities, deduplicate equal terms and retain each distinct contribution's provenance. It SHALL preview source and effective resource bounds without silently dropping proposed terms. The engine-derived floor MUST remain complete under recomputation. Accepted checkpoint input SHALL replay exactly; divergent stale input MUST NOT rewrite the accepted contribution as a supersession.

#### Scenario: Proposed terms exceed a resource bound
covers: #Requirement: Search Terms Form Bounded Provenance-Preserving Unions
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#term preview reports source and effective overage without dropping proposals

- **WHEN** proposed source or effective term counts exceed their configured bounds
- **THEN** preview requires narrowing and reports the exceeded bound
- **AND** it retains the proposals instead of silently truncating the union

#### Scenario: The engine floor is recomputed exactly
covers: #Requirement: Search Terms Form Bounded Provenance-Preserving Unions
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#engine floor is complete, provenance-preserving, and validates by recomputation

- **WHEN** a purported floor omits a required derived term
- **THEN** recomputation rejects the incomplete floor
- **AND** valid floor terms retain their derivation provenance

#### Scenario: Equal terms retain all contribution provenance
covers: #Requirement: Search Terms Form Bounded Provenance-Preserving Unions
test: packages/workflow-engine/test/investigation-scanner.integration.test.ts#typed terms preserve exact bytes, deduplicate semantics, and retain every provenance

- **WHEN** multiple sources contribute the same typed literal
- **THEN** the union uses one semantic term identity with all distinct provenance
- **AND** a different kind or literal retains its own identity

#### Scenario: An accepted checkpoint cannot be overwritten by a divergent replay
covers: #Requirement: Search Terms Form Bounded Provenance-Preserving Unions
test: packages/workflow-engine/test/investigation-session.integration.test.ts#checkpoint transitions replay exactly and reject divergent stale input

- **WHEN** a caller repeats accepted main terms or changes a term in a stale checkpoint envelope
- **THEN** exact input returns the same result without changing its durable record
- **AND** divergent input is rejected rather than replacing the accepted terms
