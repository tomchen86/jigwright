import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const specificationUrl = new URL('../spec.md', import.meta.url);

test('active safe-concurrent-task-worktrees contract covers current local execution', () => {
  const specification = fs.readFileSync(specificationUrl, 'utf8');
  const normalizedSpecification = specification.replace(/\s+/gu, ' ');
  const requirements = [
    '### Requirement: Preflight and Status Are Read-Only',
    '### Requirement: Writer Admission Is Bounded and Isolated',
    '### Requirement: Current Planning Authority Owns Admission',
    '### Requirement: Session Leases and Recovery Are Durable',
    '### Requirement: Update Base Is Local and Sequential',
    '### Requirement: Rebased Work Is Reassessed or Rolled Back',
  ];

  for (const requirement of requirements) {
    assert.match(
      normalizedSpecification,
      new RegExp(escapeRegExp(requirement)),
      requirement,
    );
  }

  for (const currentSurface of [
    '`task-preflight`',
    '`status <session-id>`',
    '`update-base <change-id> --onto <ref>`',
    'at most two write-capable task sessions',
    'distinct change, branch, and worktree identities',
    'disjoint write scopes',
    'serialized policy, base-spec, generated-document, or remote-effect class',
    'distinct exclusive resources',
    'Manifest v3',
    '`plan-review.json`',
    'compare-and-swap',
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
  assert.match(normalizedSpecification, /local Git ref/iu);
  assert.match(normalizedSpecification, /rolls back/iu);
  assert.doesNotMatch(
    normalizedSpecification,
    /migration reader|remote push|protected remote mutation/iu,
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
