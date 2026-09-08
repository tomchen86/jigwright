# Semantic binding index — contract delta

Date: 2026-09-08. This MODIFIED delta implements system-description-docs-plan §9 decision 10 after Phase C step 5. Apply it to the colocated successor of `investigation-evidence-and-why`; preserve the separately committed original migration as the before evidence.

## MODIFIED Requirements

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
