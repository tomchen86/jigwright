# Planning provider

## Purpose

Adapt the neutral planning provider contracts to the engine error surface while preserving their bytes and evaluation results.

## Requirements

### Requirement: Planning Facades Preserve Core Contracts

sources: [SRC-763dd72e374ecaf4a822a2c650221d7e3b098835cc42103d1f7b134b5a27dbad, SRC-adfb310a0167161d27aa5cab617b425f9bb366020a00f3e7d06d8f2487759a96]

The workflow planning-provider facades SHALL preserve the public core binding bytes, evaluation identities and typed result shapes. Only presentation of recognized core contract errors SHALL be translated to the engine's WorkflowError and exit-code surface; authoring inspection SHALL NOT authorize repository transitions.

#### Scenario: Core bindings and evaluation survive the facade

covers: #Requirement: Planning Facades Preserve Core Contracts
test: packages/workflow-engine/test/planning-provider-package.contract.test.ts#workflow current facades preserve landed provider bytes and errors

- **WHEN** a valid provider or an invalid provider identity passes through a workflow facade
- **THEN** valid output retains its established representation and a recognized contract error maps to the corresponding workflow error

#### Scenario: Facades use the public package contract

covers: #Requirement: Planning Facades Preserve Core Contracts
test: packages/workflow-engine/test/planning-provider-package.contract.test.ts#production facades consume public core and OpenSpec package subpaths

- **WHEN** production planning facades are inspected
- **THEN** the neutral codecs and provider implementations come from their public package subpaths
