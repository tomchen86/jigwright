# Fixture adapter

## Purpose

Exercise the public package ports with disposable repositories and explicitly selected fixture policies.

## Requirements

### Requirement: Fixture Consumers Exercise Public Package Boundaries

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-b22a65010565f7f7758291b4aa29991f3cf7a3dd0fbdd2b1fe343c1369d83bb9]

The fixture adapter SHALL implement the public consumer and runtime ports without importing engine internals. A fixture consumer SHALL be able to select its own protected base, branch, planning schema, document adapter and check definitions.

#### Scenario: Fixture imports remain public

covers: #Requirement: Fixture Consumers Exercise Public Package Boundaries
test: packages/fixture-adapter/test/package-boundary.contract.test.ts#@jigwright/fixture-adapter has one-way public package dependencies

- **WHEN** the fixture package dependency surface is inspected
- **THEN** only its public package dependencies supply shared contracts

#### Scenario: Another consumer selects its own configuration

covers: #Requirement: Fixture Consumers Exercise Public Package Boundaries
test: packages/fixture-adapter/test/package-boundary.contract.test.ts#a neutral consumer binds a different base, branch, planning schema, document adapter, and check

- **WHEN** a disposable consumer uses different repository and adapter settings
- **THEN** the public ports preserve those selections without a product-specific fallback
