# System document lifecycle — contract additions

Date: 2026-09-08. Phase C step 5. Apply to `packages/workflow-engine/spec.md`.

## ADDED Requirements

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
