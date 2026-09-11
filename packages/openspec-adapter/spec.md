# OpenSpec adapter

## Purpose

Translate the supported OpenSpec planning and archive document surfaces into neutral provider facts.

## Requirements

### Requirement: OpenSpec Validation Preserves Provider Facts

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The OpenSpec adapter SHALL parse its supported validation payload into exact diagnostics, item identities and summary totals. It SHALL preserve the current planning path grammar and reject foreign or invalid paths.

#### Scenario: Validation facts survive translation

covers: #Requirement: OpenSpec Validation Preserves Provider Facts
test: packages/openspec-adapter/test/validation-payload.contract.test.ts#OpenSpec validation payload parser preserves exact public validation facts

- **WHEN** the adapter reads a supported native validation payload
- **THEN** its normalized result preserves the provider diagnostics and validation facts

#### Scenario: Planning paths remain exact

covers: #Requirement: OpenSpec Validation Preserves Provider Facts
test: packages/openspec-adapter/test/planning-paths.contract.test.ts#OpenSpec planning paths preserve current-v3 grammar and reject foreign paths

- **WHEN** a planning artifact path is classified
- **THEN** only paths admitted by the current planning grammar are accepted

### Requirement: Archive Projection Reads Through Supplied Ports

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-adfb310a0167161d27aa5cab617b425f9bb366020a00f3e7d06d8f2487759a96]

The archive projection adapter SHALL derive its result from the caller-supplied pinned and current text readers. It SHALL report neutral typed facts while repository mutation, currentness checks and workflow authorization remain the caller's responsibility.

#### Scenario: Archive output retains exact inputs

covers: #Requirement: Archive Projection Reads Through Supplied Ports
test: packages/openspec-adapter/test/archive-projection.contract.test.ts#OpenSpec archive projection reads exact paths and preserves totals and digest bytes

- **WHEN** an archive projection reads the pinned and current document views
- **THEN** the requested paths, totals and established output identities are preserved
