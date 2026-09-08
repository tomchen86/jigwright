import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import * as governanceFindings from '../src/modules/governance-intake/governance-findings.ts';
import * as governanceIntake from '../src/modules/governance-intake/governance-intake.ts';

const specificationUrl = new URL(
  '../src/modules/governance-intake/spec.md',
  import.meta.url,
);
const changeRoutingSpecificationUrl = new URL(
  '../src/modules/lifecycle/spec.md',
  import.meta.url,
);
const readmeUrl = new URL('../../../README.md', import.meta.url);
const agentsUrl = new URL('../../../AGENTS.md', import.meta.url);
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
  ...[
    'governance-findings.ts',
    'governance-intake-storage.ts',
    'work-registry-promotion-preparation.ts',
    'work-registry-projections.ts',
    'work-registry-queries.ts',
    'work-registry-storage.ts',
  ].map(
    (file) =>
      new URL(`../src/modules/governance-intake/${file}`, import.meta.url),
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
    '### Requirement: Intent-Level Now Starts One Source-Bound Change',
    '### Requirement: Intent-Level Now Promotes One Eligible Work Item',
    '### Requirement: Intent-Level Later Surface Is One Command',
    '### Requirement: Attach Adds a Source Without Reclassifying Work',
    '### Requirement: Finding Conversion Has One Deterministic Target',
    '### Requirement: Finding Link Is a Receipt-Only Relation',
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
    '`now <original-text>`',
    '`now <work-item-id>`',
    '`attach <work-item-id> <original-text>`',
    '`finding convert <finding-id> --now`',
    '`finding link <finding-id> --change <change-id>`',
    '`intakeCounts`',
    '`status`',
    '`open-task`',
    '`handoff validate`',
  ]) {
    assert.match(
      specification,
      new RegExp(escapeRegExp(currentSurface)),
      currentSurface,
    );
  }

  assert.match(specification, /registered Central Grant transition/u);
  assert.match(specification, /compare-and-swap/u);
  assert.match(
    specification,
    /agent-authored Source SHALL bind a current survey/u,
  );
  assert.match(
    specification,
    /authored solely by maintainers SHALL bind `not-required`/u,
  );
  assert.match(specification, /SHALL NOT create survey bytes/u);
  assert.match(
    specification,
    /Fail-Grant challenge before creating the change\s+directory, survey, origin/u,
  );
  assert.match(
    specification,
    /foreign target entry or metadata drift fails stale without overwrite/u,
  );
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
  for (const operation of [
    'listGovernanceFindings',
    'dismissGovernanceFinding',
    'convertGovernanceFinding',
    'linkGovernanceFinding',
  ] as const) {
    assert.equal(typeof governanceIntake[operation], 'function', operation);
  }
  for (const module of [governanceIntake, governanceFindings]) {
    assert.equal(
      Object.hasOwn(module, 'recordGovernanceFindingDisposition'),
      false,
    );
  }
  assert.doesNotMatch(
    governanceIntakeSource,
    /export function recordGovernanceFindingDisposition/u,
  );
});

test('active repository guidance states the always-built-in Work Registry contract', () => {
  for (const guidanceUrl of [readmeUrl, agentsUrl]) {
    const guidance = fs.readFileSync(guidanceUrl, 'utf8');
    assert.match(guidance, /Work Registry is always built in/u);
    assert.match(guidance, /Work Item use is not mandatory/u);
    assert.doesNotMatch(guidance, /optional Work Registry/iu);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
