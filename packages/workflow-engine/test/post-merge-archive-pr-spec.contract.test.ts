import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const specificationUrl = new URL(
  '../../../openspec/specs/post-merge-archive-pr/spec.md',
  import.meta.url,
);

test('active post-merge-archive-pr contract covers current local orchestration', () => {
  const specification = fs.readFileSync(specificationUrl, 'utf8');
  const normalizedSpecification = specification.replace(/\s+/gu, ' ');
  const requirements = [
    '### Requirement: Candidate Discovery Is Read-Only and Current',
    '### Requirement: Local Preparation Reuses Core Archive Authority',
    '### Requirement: Prepared Publication Payload Is Exact and Durable',
    '### Requirement: Local Status Replays Git Truth Without Remote Authority',
    '### Requirement: Publication Is Create-Only and Grant-Bound',
    '### Requirement: Remote Activation Remains Operationally Gated',
  ];

  for (const requirement of requirements) {
    assert.match(
      normalizedSpecification,
      new RegExp(escapeRegExp(requirement)),
      requirement,
    );
  }

  for (const currentSurface of [
    '`archive-pr doctor`',
    '`archive-pr dry-run <change-id>`',
    '`archive-pr status <sha256:preparation-identity>`',
    '`after-merge <change-id>`',
    '`work/archive-<change-id>`',
    'Manifest v3',
    '`plan-review.json`',
    '`provider-independent`',
    '`already-archived`',
    '`candidateIdentity`',
    '`protectedBase`',
    '`assurance`',
    'compare-and-swap',
    'Central Grant',
    'create-only',
    '`operational-gate-pending`',
  ]) {
    assert.match(
      normalizedSpecification,
      new RegExp(escapeRegExp(currentSurface), 'iu'),
      currentSurface,
    );
  }

  assert.match(
    normalizedSpecification,
    /historical inspection is diagnostic only/iu,
  );
  assert.match(
    normalizedSpecification,
    /same exact commit, report, and path identity/iu,
  );
  assert.match(
    normalizedSpecification,
    /MUST NOT[^.]*approve, bypass, or merge/iu,
  );
  assert.match(
    normalizedSpecification,
    /fake and bare-remote[^.]*acceptance evidence/iu,
  );
  assert.doesNotMatch(normalizedSpecification, /migration reader/iu);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
