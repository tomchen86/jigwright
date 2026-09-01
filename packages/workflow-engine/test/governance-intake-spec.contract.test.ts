import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const specificationUrl = new URL(
  '../../../openspec/specs/governance-intake/spec.md',
  import.meta.url,
);

test('active governance intake contract covers the current Source-to-work lifecycle', () => {
  const specification = fs.readFileSync(specificationUrl, 'utf8');
  const requirements = [
    '### Requirement: Work Items Use Stable Per-Item Records',
    '### Requirement: Reviewed Work Item Decisions Use Grant Core',
    '### Requirement: Promotion Atomically Links Work and Source Provenance',
    '### Requirement: Work Registry Read Surfaces Are Deterministic',
    '### Requirement: Planning Prose Distinguishes Source-Backed Claims',
    '### Requirement: Archive Reconciles Linked Work Items Deterministically',
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
    '`WORK_REGISTRY_UNAVAILABLE`',
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
    /issues? v1|ISS-\d+|workflow issue|migration window/iu,
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
