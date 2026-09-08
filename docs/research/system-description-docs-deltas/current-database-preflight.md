# Current disposable database preflight

Date: 2026-09-09. The former final scenario describes a retired consumer-specific API harness choosing a target after a connection failure. This repository no longer contains that harness; the engine validates an explicit target and delegates the registered command. This delta records that boundary without inventing a database connection probe or fallback implementation. It retains the existing required disposable identity and redaction rules and binds a real native negative case where development and compose URLs cannot replace the missing explicit test URL. No database-writing test is run. The original scenario remains in the raw specification migration commit `9c63c49`.

## REMOVED Requirements

### Requirement: Disposable Database Preflight

**Reason**: The final scenario belongs to the retired consumer API harness, which is absent from the current engine. Its scenario identity cannot be relabeled by a MODIFIED delta.
**Migration**: Preserve the original in commit `9c63c49`; the replacement retains the engine's preflight and redaction obligations and describes only its implemented target-selection boundary.

## ADDED Requirements

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
