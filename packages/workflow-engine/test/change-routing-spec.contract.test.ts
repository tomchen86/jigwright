import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const specificationUrl = new URL(
  '../../../openspec/specs/change-routing/spec.md',
  import.meta.url,
);

test('active change-routing contract covers the current local routing surface', () => {
  const specification = fs.readFileSync(specificationUrl, 'utf8');
  const requirements = [
    '### Requirement: Routing Status Exposes Current Repository Inventory',
    '### Requirement: Controlled Lifecycle Source Owns Explicit Routing',
    '### Requirement: Routing Review Is Current and Recoverable',
    '### Requirement: Grant Core Owns Protected Continuation',
    '### Requirement: Writer Admission Requires Managed Routing',
    '### Requirement: Handoff Is a Derived Repository Projection',
  ];

  for (const requirement of requirements) {
    assert.match(
      specification,
      new RegExp(escapeRegExp(requirement)),
      requirement,
    );
  }

  for (const currentSurface of [
    '`route status`',
    '`primary`',
    '`concurrent`',
    '`ready`',
    '`blocked`',
    '`resume-available`',
    '`parked`',
    '`completed-awaiting-archive`',
    '`archived`',
    '`revising`',
    '`recovery-required`',
    '`change`',
    '`external`',
    '`CHANGE_ROUTING_REQUIRED`',
    '`nextSteps`',
    '`plan-review.json`',
  ]) {
    assert.match(
      specification,
      new RegExp(escapeRegExp(currentSurface)),
      currentSurface,
    );
  }

  assert.match(specification, /Manifest v3/u);
  assert.match(specification, /registered Central Grant transition/u);
  assert.match(specification, /compare-and-swap/u);
  assert.match(specification, /historical inspection is diagnostic only/iu);
  assert.doesNotMatch(
    specification,
    /issue blocker|blocker kind[^\n]*issue|migration reader/iu,
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
