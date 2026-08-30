# investigation-evidence-and-why Specification

## Purpose

TBD - created by archiving change establish-investigation-first-planning. Update Purpose after archive.

## Requirements

### Requirement: Every Investigation Hit Has Exactly One Effective Disposition

The workflow engine SHALL organize current search hits into semantic evidence groups and SHALL require every current hit to be covered by exactly one effective disposition.

Each disposition MUST identify its covered hits, complete source blobs, classification, rationale, selector evidence, and explicit exceptions. Ambiguous, missing, or overlapping effective coverage MUST fail closed.

#### Scenario: One group covers related hits

- **GIVEN** several current hits belong to one reviewed semantic evidence group
- **WHEN** the group receives an effective disposition
- **THEN** each hit is covered through that group without a duplicate semantic answer
- **AND** the group records the exact covered hit identities

#### Scenario: One hit has overlapping dispositions

- **GIVEN** a current hit is covered by more than one effective disposition
- **WHEN** coverage is validated
- **THEN** validation fails
- **AND** investigation cannot be sealed

#### Scenario: One hit has no disposition

- **GIVEN** a current hit has no effective disposition
- **WHEN** coverage is validated
- **THEN** validation fails
- **AND** investigation cannot be sealed

### Requirement: Load-Bearing Evidence Requires a Full-Blob WHY Ledger

For every file represented by a load-bearing evidence group, the workflow engine SHALL require a ledger row bound to the complete pinned source blob.

The row MUST identify path, blob digest and size, relevant element or location, covered hits, relationship to the change, WHY explanation, protected invariant, sharp reviewer question, answer, and semantic-author provenance. The complete pinned file MUST be available to the assigned actor when semantic fields are produced.

#### Scenario: Load-bearing row is complete and current

- **GIVEN** a load-bearing file has every required field and is bound to the current complete source blob
- **WHEN** WHY-ledger validation runs
- **THEN** the row is accepted

#### Scenario: Load-bearing row uses a stale blob

- **GIVEN** a load-bearing row is bound to an older source-blob digest
- **WHEN** WHY-ledger validation runs
- **THEN** the row is rejected as stale

#### Scenario: Semantic field is absent or a placeholder

- **GIVEN** a load-bearing row lacks WHY, invariant, reviewer question, or answer
- **OR** a required field contains an unfilled template placeholder
- **WHEN** WHY-ledger validation runs
- **THEN** the row is rejected
- **AND** investigation cannot be sealed

#### Scenario: Engine reports a completed semantic row

- **GIVEN** an actor supplied a structurally complete WHY row
- **WHEN** the engine stores or renders it
- **THEN** it preserves the actor as semantic author
- **AND** it does not claim that the engine proved the WHY true or proved that the actor understood the file

### Requirement: Non-Load-Bearing Evidence Remains Explicit

A non-load-bearing group MUST have an explicit classification and concrete rationale. It MUST NOT require a full WHY row unless policy or review promotes the group or one of its exceptions to load-bearing.

#### Scenario: Incidental group has a concrete rationale

- **GIVEN** a group is classified as incidental or irrelevant with a concrete reason
- **WHEN** investigation evidence is validated
- **THEN** the group may pass without a full WHY row

#### Scenario: Reviewer promotes an exception to load-bearing

- **GIVEN** a reviewer identifies one exception inside a non-load-bearing group
- **WHEN** that exception is accepted as load-bearing
- **THEN** it requires current full-blob WHY coverage
- **AND** the remaining group retains only its effective covered hits

### Requirement: Investigation Exemption Does Not Manufacture Evidence

When the current applicability ref selects an eligible `investigation-exemption`, the tracked investigation artifact SHALL contain the exact exemption subject and SHALL omit sealed-investigation term, scan, hit-disposition, and WHY-ledger nodes. An empty collection, placeholder row, or synthetic zero-hit result MUST NOT be used to claim that those gates executed.

#### Scenario: Exemption is rendered as its own branch

- **GIVEN** a current eligible investigation exemption
- **WHEN** the tracked investigation projection is rendered
- **THEN** it identifies the exemption category, exact scope, baseline, intent, rationale, author, policy, and behavior-reliance declaration
- **AND** it does not contain fabricated scan, disposition, or WHY evidence

#### Scenario: Exempt plan reports breadth or depth completion

- **GIVEN** a plan used an investigation exemption
- **WHEN** its assurance summary claims sealed-term scan or WHY binding completed
- **THEN** validation fails
- **AND** the summary must label those claims inapplicable rather than satisfied

### Requirement: Design Ledger Is an Engine-Managed Projection

The workflow engine SHALL render one marked investigation-ledger region of the authoritative design from structured investigation evidence. The engine SHALL own the markers, objective fields, and all projection bytes inside that region.

Semantic WHY, invariant, question, and answer fields MUST retain actor provenance and MUST be represented as reviewed claims rather than engine-authored or engine-verified understanding.

#### Scenario: Managed ledger matches structured evidence

- **GIVEN** current structured evidence and WHY rows
- **WHEN** the design ledger is rendered
- **THEN** its paths, locations, digests, groups, terms, and semantic fields match the structured source exactly

#### Scenario: Managed ledger is edited manually

- **GIVEN** the rendered design ledger differs from its current structured source
- **WHEN** planning validation runs
- **THEN** validation fails
- **AND** the manual projection does not become evidence

#### Scenario: Managed markers are ambiguous

- **GIVEN** design contains missing, duplicate, nested, or malformed ledger markers
- **WHEN** planning validation runs
- **THEN** validation fails without guessing an authored/managed boundary

### Requirement: Investigation Evidence Uses Provenance and Semantic Digests

Every investigation evidence node SHALL have a provenance-sensitive `nodeId` and a semantic `resultDigest`. Runtime-only timestamps, retry counts, latency, process IDs, mutable ref names, and UI metadata MUST NOT enter either digest unless reviewed policy explicitly makes them semantic.

An exact input or provenance-parent change MUST produce a new `nodeId`. Invalidation MAY stop at equal semantic output only when evaluator, policy, node schema, and output schema are compatible and a current convergence record proves the shared `resultDigest`.

#### Scenario: Input changes but semantic output converges

- **GIVEN** a recomputed node has a changed exact input or provenance parent
- **AND** compatible evaluation produces the same canonical semantic output
- **WHEN** node identity is calculated
- **THEN** the new `nodeId` differs from the old one
- **AND** the `resultDigest` is equal
- **AND** propagation stops only through a valid convergence record

#### Scenario: Runtime metadata changes

- **GIVEN** only timestamp, retry, latency, process, or display metadata changes
- **WHEN** semantic node identity is evaluated
- **THEN** the semantic `nodeId` and `resultDigest` remain unchanged

#### Scenario: Policy changes with equal output bytes

- **GIVEN** a node is recomputed under an incompatible evaluator, policy, node schema, or output schema
- **WHEN** output bytes happen to match
- **THEN** the old and new parent edges do not converge

### Requirement: Tracked Investigation Manifest Replays Deterministic Facts From Pinned Git

The tracked schema-v3 investigation Manifest SHALL store a strict replay contract bound to the exact baseline commit and tree for deterministic tree-inventory, scan, hit, mechanical-grouping, and coverage facts. Loading the current Manifest SHALL verify the commit-to-tree binding, read source content only from pinned Git objects, regenerate those facts under the recorded policies, and materialize the exact process-local evidence view before assurance validation.

The materialized evidence view MUST match the Manifest's recorded roots, counts, and derived commitments. The Manifest MUST retain irreducible semantic term contributions, provider results, decisions, WHY overlays, reviews, approval, and provenance in its semantic delta and attestation. Replay MUST NOT infer or regenerate actor judgment from Git source. Missing Git objects, malformed replay data, commitment mismatch, incomplete grouping, or provenance collision MUST fail closed. Any active non-v3 top-level input is refused under the stable unsupported-schema contract, while archived bytes remain untouched and read-only historical inspection cannot confer authority.

#### Scenario: Current Manifest has an intact pinned Git baseline

- **GIVEN** a tracked schema-v3 Manifest names an existing commit, its exact tree, and a valid replay contract
- **WHEN** the Manifest is loaded for validation or execution
- **THEN** the engine regenerates every deterministic fact from the pinned Git tree
- **AND** the materialized evidence view has the recorded roots, counts, derived commitments, and provenance closure

#### Scenario: Pinned Git content is unavailable

- **GIVEN** a current Manifest names a commit, tree, or blob that is not available in the repository
- **WHEN** the Manifest is loaded
- **THEN** loading fails closed
- **AND** current working-tree bytes are not substituted for the missing pinned content

#### Scenario: Replay no longer produces the recorded evidence

- **GIVEN** replay code, policy, or the current Manifest contract produces a different scan, group, disposition, coverage, root, count, or derived commitment
- **WHEN** reconstruction is validated
- **THEN** the Manifest is rejected as invalid
- **AND** the differing reconstruction does not become current evidence

#### Scenario: Semantic evidence is present beside the replay contract

- **GIVEN** the investigation contains actor-authored WHY overlays or provider and review evidence
- **WHEN** the tracked schema-v3 Manifest is written
- **THEN** its semantic delta and attestation retain the exact irreducible inputs, decisions, approval, and provenance
- **AND** only eligible deterministic facts are represented by the replay contract

### Requirement: Investigation v3 Is Manifest-First

The v3 writer SHALL consume `InvestigationAuthoringState` directly and persist only exact Git replay inputs, irreducible semantic decisions and provenance, derived roots/counts, and the final investigation attestation. It MUST NOT accept or first construct a schema-v1/v2 artifact, complete `EvidenceNode[]`, or full evidence DAG. Git objects are the sole source-content authority.

A `MaterializedEvidenceView` MAY exist only in process-local memory for replay and comparison. It MUST throw or fail closed if serialization is attempted and MUST NOT be written to the runtime, tracked tree, cache, journal, or authority store.

#### Scenario: v3 ordinary Manifest is built

- **GIVEN** common raw authoring inputs, a pinned commit/tree, and complete semantic decisions
- **WHEN** the v3 writer builds the ordinary branch
- **THEN** it scans and groups directly into domain facts
- **AND** it persists replay contract, semantic delta, derived commitments, and attestation without generic evidence envelopes

#### Scenario: Process-local replay view reaches a serializer

- **GIVEN** a materialized v3 replay view exists in memory
- **WHEN** code attempts to serialize or persist it
- **THEN** the operation fails with `PROJECTION_PIPELINE_FORBIDDEN`
- **AND** no replay view bytes become durable

### Requirement: v3 Applicability and Validation Boundaries Are Exact

The v3 Manifest SHALL select exactly one closed applicability branch. The ordinary branch contains `replayContract`, `semanticDelta`, and `derivedCommitments`; the exemption branch contains only the exact eligible exemption subject and MUST NOT manufacture empty replay, Group, Disposition, coverage, or WHY proof.

The engine SHALL expose distinct draft-seal validation, current authority validation, and read-only historical inspection. Current authority validation MUST re-resolve `commitOid^{tree}`, reconstruct terms and deterministic facts from pinned Git, verify every root and compact root-bound Group reference, enforce exact Hit→final-Group→Disposition cardinality, verify WHY/reuse completeness, and bind the exact lifecycle snapshot, target, seal, and Manifest digest. Historical inspection can never satisfy a current lifecycle gate.

#### Scenario: Ordinary semantic coverage is incomplete

- **GIVEN** a current Hit is missing a final Group or a final Group is missing exactly one Disposition
- **WHEN** v3 authority validation runs
- **THEN** validation returns a structured semantic-completeness failure
- **AND** no partial or synthetic coverage becomes authority

#### Scenario: Exemption is validated

- **GIVEN** an eligible structured exemption bound to exact intent and baseline
- **WHEN** the v3 exemption branch is validated
- **THEN** replay and semantic-proof collections are absent
- **AND** investigation breadth/depth claims remain inapplicable rather than satisfied

### Requirement: Every v3 Failure Delegates Continuation to Central Grant Core

Every v3 failure outcome under engine control, including validation, reconstruction, publication/CAS, and recoverable crash-state classification, SHALL emit exact failure identity, attempted transition, candidate digest, non-exhaustive failure code, details digest, and missing-assurance facts in a shape consumable by the published central Grant Core producer contract.

Investigation v3 MUST NOT define a local grant schema, candidate label, callback, signer, trusted UI, authentication step, reservation, consumption rule, audit journal, degraded-reference placement, or resume command. It only emits canonical failure facts and state binding; the central Transition Registry and Grant Core own choices, fresh local device-owner authentication, once-only consumption, recovery, and audit.

#### Scenario: Engine-produced v3 failure enters central Grant Core

- **GIVEN** a current v3 operation returns an exact structured blocker
- **WHEN** the central Grant producer is asked to create its human challenge from that blocker
- **THEN** Grant Core persists the durable challenge with a code-owned non-retry stop transition
- **AND** transition consumption re-observes the current failure state and rejects drift
- **AND** the v3 source state stores no challenge, approval, Grant reference, or audit state
- **AND** stopping preserves the failed assurance without relabelling it as verified

#### Scenario: Publication failure enters central Grant Core from its real source

- **GIVEN** a v3 publish, inspect, resume, or current-ref read returns one emitter-bound failure envelope containing its structured publication blocker
- **WHEN** the central Grant producer creates a challenge from that envelope
- **THEN** the registered source observer re-reads the current durable investigation session/current ref and binds the lifecycle-owned publication namespace, exact journal, candidate, installed Manifest, publication current-ref, branch, Git baseline, index/worktree content fingerprint, and lifecycle identity
- **AND** a blocker/source or lifecycle/source cross-wire is rejected before any challenge is persisted
- **AND** changing any bound publication source before direct execution or recovery rejects the stop transition as stale
- **AND** deterministic prepared-state drift records a central audited terminal failure without applying or relabelling the v3 transition, while an effect-applied-before-receipt crash remains recoverable through the same idempotent transition
- **AND** no publication-specific Grant store, signer, authentication, or resume surface is created

#### Scenario: File publication crashes before current-ref installation

- **GIVEN** v3 publication wrote a candidate, journal, or Manifest but did not install the intended current ref
- **WHEN** restart inspection classifies the residue
- **THEN** it returns a precise `PUBLICATION_RECOVERY_REQUIRED` blocker consumable by the central producer
- **AND** a later source mutation invalidates any already-issued challenge

#### Scenario: File publication crashes after current-ref installation

- **GIVEN** the exact v3 Manifest and current ref were installed but the file-publication journal remains prepared
- **WHEN** recovery reacquires the lifecycle lock
- **THEN** it accepts Grant-free recovery only when the failing invocation itself reached the post-ref phase and the fully revalidated transaction-installed Manifest and ref both match the journal with unchanged lifecycle identity
- **AND** it completes idempotently without creating or consuming a Grant
- **AND** a missing or corrupt installed Manifest returns a central-consumable blocker instead of being classified as Grant-free

#### Scenario: Publication parent moves while the lifecycle lock is held

- **GIVEN** every cooperating publication writer holds the lifecycle lock
- **WHEN** a publication parent is relocated during one synchronous pathname replacement
- **THEN** the writer immediately revalidates repository containment and the complete parent identity chain
- **AND** it compensates a newly installed basename or restores the exact prior bytes before returning a structured blocker
- **AND** immutable candidates remain as recovery evidence instead of being destructively removed
- **AND** this is a fail-detecting compensating transaction, not a claim that POSIX can atomically prevent a hostile same-UID relocation or process crash

### Requirement: Reusable Knowledge Remains Separate From Per-Change WHY

The v3 Manifest SHALL persist only per-change WHY overlays or immutable `knowledgeRef` versions plus an explicit current freshness decision. The separate Semantic Knowledge Graph owns reusable subject meaning, responsibilities, invariants, failure modes, dependencies, freshness, and supersession. Reusable knowledge MUST NOT prove current Git facts without exact current replay and source binding.

#### Scenario: Current replay cites an immutable knowledge version

- **GIVEN** a load-bearing Git path/blob has one explicitly fresh reusable-knowledge decision
- **WHEN** v3 authority validation replays the current Manifest
- **THEN** the exact `knowledgeRef` version and freshness provenance bind that current source tuple
- **AND** reusable subject content remains in the separate Semantic Knowledge Graph rather than being copied into the Manifest

### Requirement: Descendant Reuse Preserves Original Provenance

An existing descendant MAY remain current across a converged parent only when its current evidence path contains a valid reuse proof for every changed parent edge. The descendant's immutable object and original parent provenance MUST NOT be rewritten.

#### Scenario: Every changed parent has a valid reuse proof

- **GIVEN** an existing descendant semantically depends on converged parent outputs
- **AND** each changed parent edge has a proof naming the descendant, old and new parents, convergence record, shared result digest, and validator version
- **WHEN** currentness is evaluated
- **THEN** the original descendant may be reused through that complete proof path

#### Scenario: One changed parent lacks proof

- **GIVEN** a descendant has multiple changed parent edges
- **AND** at least one edge lacks a current compatible proof
- **WHEN** currentness is evaluated
- **THEN** the descendant is stale

#### Scenario: Reuse attempts to rewrite descendant provenance

- **GIVEN** an old descendant names an old immutable parent
- **WHEN** reuse is recorded
- **THEN** the engine retains the original descendant object and parent link
- **AND** it records the new evidence path in separate immutable proof objects
