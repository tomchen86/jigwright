# Agent runtime

## Purpose

Describe host provider profiles and bounded native provider execution through the public runtime port.

## Requirements

### Requirement: Host Profiles Declare Capabilities and Ranking

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The agent runtime SHALL normalize explicit host provider profiles independently of registration order. Provider selection SHALL use declared capability and ranking facts; a profile alias SHALL NOT create a second logical provider identity.

#### Scenario: Equivalent host registrations normalize equally

covers: #Requirement: Host Profiles Declare Capabilities and Ranking
test: packages/agent-runtime/test/agent-provider-config.contract.test.ts#host provider config normalizes independently of registration order and ranks explicitly

- **WHEN** the same provider profiles are registered in a different order
- **THEN** their canonical configuration and explicit ranking remain equivalent

#### Scenario: Aliases cannot evade logical provider exclusion

covers: #Requirement: Host Profiles Declare Capabilities and Ranking
test: packages/agent-runtime/test/agent-provider-config.contract.test.ts#logical-provider exclusion removes every profile alias before ranking

- **WHEN** selection excludes a logical provider
- **THEN** all its profile aliases are excluded before ranking the remaining candidates

### Requirement: Session Receipts Bind Observed Native Execution

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The runtime protocol SHALL bind admitted session receipts to the requested execution identity and the observed native session. Fresh starts and resumes SHALL retain their separate declared capabilities; duplicate or mismatched session evidence SHALL NOT produce an accepted receipt.

#### Scenario: An engine-supplied session start yields a bound receipt

covers: #Requirement: Session Receipts Bind Observed Native Execution
test: packages/agent-runtime/test/harness-jsonl-v2.contract.test.ts#harness-jsonl-v2 binds an engine-supplied start identity into an immutable receipt

- **WHEN** a provider completes a valid engine-supplied start
- **THEN** the result contains the immutable receipt for that exact execution

#### Scenario: Conflicting session evidence is refused

covers: #Requirement: Session Receipts Bind Observed Native Execution
test: packages/agent-runtime/test/harness-jsonl-v2.contract.test.ts#harness-jsonl-v2 fails closed on duplicate, mismatched, missing, or post-terminal session evidence

- **WHEN** session evidence is duplicated, missing, mismatched or emitted after the terminal result
- **THEN** the protocol does not accept it as a valid session receipt
