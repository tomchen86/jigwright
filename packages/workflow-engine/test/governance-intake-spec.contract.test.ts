import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const specificationUrl = new URL(
  '../../../openspec/specs/governance-intake/spec.md',
  import.meta.url,
);
const changeRoutingSpecificationUrl = new URL(
  '../../../openspec/specs/change-routing/spec.md',
  import.meta.url,
);
const currentWorkRegistrySources = [
  new URL('../../core/src/repository-consumer-port.ts', import.meta.url),
  new URL('../../fixture-adapter/src/repository-consumer.ts', import.meta.url),
  new URL(
    '../src/modules/repository-consumer/repository-consumer-config.ts',
    import.meta.url,
  ),
  new URL(
    '../src/modules/governance-intake/governance-intake.ts',
    import.meta.url,
  ),
  new URL('../src/modules/governance-intake/work-registry.ts', import.meta.url),
  new URL(
    '../src/adapters/consumer/repository/handoff/handoff.ts',
    import.meta.url,
  ),
] as const;

test('active governance intake contract covers the current Source-to-work lifecycle', () => {
  const specification = fs.readFileSync(specificationUrl, 'utf8');
  const requirements = [
    '### Requirement: Work Items Use Stable Per-Item Records',
    '### Requirement: Reviewed Work Item Decisions Use Grant Core',
    '### Requirement: Promotion Atomically Links Work and Source Provenance',
    '### Requirement: Work Registry Read Surfaces Are Deterministic',
    '### Requirement: Planning Prose Distinguishes Source-Backed Claims',
    '### Requirement: Archive Reconciles Linked Work Items Deterministically',
    '### Requirement: Work Registry Is Always Available; Work Item Use Is Not Mandatory',
    '### Requirement: Governance Source Ledger Path Is Engine-Owned',
    '### Requirement: Finding Disposition Is Append-Only',
    '### Requirement: Intent-Level Later Surface Is One Command',
    '### Requirement: Attach Adds a Source Without Reclassifying Work',
    '### Requirement: Finding Conversion Has One Deterministic Target',
    '### Requirement: Governance Intake Counts Are Read-Only',
  ];

  for (const requirement of requirements) {
    assert.match(
      specification,
      new RegExp(escapeRegExp(requirement)),
      requirement,
    );
  }

  for (const currentSurface of [
    '`list`',
    '`show`',
    '`search`',
    '`trace`',
    '`recommend`',
    '`inventory`',
    '`render`',
    '`validate`',
    '`source-backed`',
    '`agent-derived`',
    '`sourceRefs`',
    '`workItemRefs`',
    '`workflow/source-ledger/objects/sha256`',
    '`workRegistry: null`',
    'D-018',
    'D-019',
    '`later <original-text>`',
    '`attach <work-item-id> <original-text>`',
    '`finding convert <finding-id>`',
  ]) {
    assert.match(
      specification,
      new RegExp(escapeRegExp(currentSurface)),
      currentSurface,
    );
  }

  assert.match(specification, /registered Central Grant transition/u);
  assert.match(specification, /compare-and-swap/u);
  assert.match(specification, /current survey/u);
  assert.doesNotMatch(
    specification,
    /issues? v1|ISS-\d+|workflow issue|migration window|WORK_REGISTRY_UNAVAILABLE|optional Work Registry/iu,
  );

  const changeRoutingSpecification = fs.readFileSync(
    changeRoutingSpecificationUrl,
    'utf8',
  );
  assert.match(
    changeRoutingSpecification,
    /current task, archive, and Work Registry\s+facts/u,
  );
  assert.match(
    changeRoutingSpecification,
    /#### Scenario: Built-in Work Registry has zero items/u,
  );
  assert.doesNotMatch(changeRoutingSpecification, /optional Work Registry/iu);
});

test('production has no disableable Work Registry or configurable Source-root surface', () => {
  for (const sourceUrl of currentWorkRegistrySources) {
    const source = fs.readFileSync(sourceUrl, 'utf8');
    assert.doesNotMatch(
      source,
      /repositoryWorkRegistryConfigurationOrNull|WORK_REGISTRY_UNAVAILABLE|\bsourceRoot\b|withOptionalWorkRegistryPromotionLock/u,
      sourceUrl.pathname,
    );
  }

  assert.match(
    fs.readFileSync(currentWorkRegistrySources[0], 'utf8'),
    /GOVERNANCE_SOURCE_LEDGER_ROOT/u,
  );
  const workRegistrySource = fs.readFileSync(
    currentWorkRegistrySources[4],
    'utf8',
  );
  assert.match(workRegistrySource, /export function attachSourceToWorkItem/u);
  assert.match(
    workRegistrySource,
    /export function ensureFindingConversionWorkItem/u,
  );
  const governanceIntakeSource = fs.readFileSync(
    currentWorkRegistrySources[3],
    'utf8',
  );
  assert.match(
    governanceIntakeSource,
    /export function listGovernanceFindings/u,
  );
  assert.match(
    governanceIntakeSource,
    /export function dismissGovernanceFinding/u,
  );
  assert.match(
    governanceIntakeSource,
    /export function convertGovernanceFinding/u,
  );
  assert.doesNotMatch(
    governanceIntakeSource,
    /export function recordGovernanceFindingDisposition/u,
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
