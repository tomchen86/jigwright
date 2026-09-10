# Grant services

## Purpose

Implement the core-owned Grant verification and lifecycle ports with exact capabilities, receipts and one-use reservations.

## Requirements

### Requirement: Verification Produces Exact Typed Capabilities

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The Grant service SHALL verify the exact requested namespace, effect and contract before returning an immutable typed capability and receipt. A verifier refusal SHALL remain a refusal and SHALL NOT mint a capability.

#### Scenario: Successful verification returns the exact capability

covers: #Requirement: Verification Produces Exact Typed Capabilities
test: packages/grants/test/grant-envelope-verifier.contract.test.ts#returns one immutable typed capability and deterministic receipt after exact verification

- **WHEN** an envelope passes the requested exact verification
- **THEN** the service returns the immutable capability and deterministic receipt for that request

#### Scenario: Verifier refusal remains visible

covers: #Requirement: Verification Produces Exact Typed Capabilities
test: packages/grants/test/grant-envelope-verifier.contract.test.ts#normalizes verifier refusal without minting a capability

- **WHEN** the supplied verifier refuses an envelope
- **THEN** the service reports refusal without producing a capability

### Requirement: Grant Reservations Retain One Terminal Use

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The Grant lifecycle SHALL reserve, consume, revoke or fail a Grant through its supplied storage and clock ports. Its one-use reservation contract SHALL reject reuse, and expiry or an admission failure SHALL record the corresponding terminal state.

#### Scenario: Reservation uses the supplied ports

covers: #Requirement: Grant Reservations Retain One Terminal Use
test: packages/grants/test/grant-lifecycle.contract.test.ts#reserves one available grant through the storage and clock ports and projects a typed receipt

- **WHEN** an available Grant is reserved
- **THEN** the storage and clock ports determine the state transition and typed receipt

#### Scenario: Terminal state prevents reuse

covers: #Requirement: Grant Reservations Retain One Terminal Use
test: packages/grants/test/grant-lifecycle.contract.test.ts#revokes either active state, supports explicit failure, and rejects reuse or maxUses other than one

- **WHEN** a Grant is revoked or failed, or a caller requests reuse
- **THEN** the lifecycle retains the terminal decision and enforces its one-use contract
