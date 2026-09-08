import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findContainingSpec,
  findCommonSpec,
  parseSystemSpec,
} from '../src/modules/source/spec-ownership.ts';

test('spec ownership follows nearest containment, common ancestors, and both sides of moves', () => {
  const base = ['spec.md', 'src/spec.md', 'src/modules/intake/spec.md'];
  const candidate = ['spec.md', 'src/spec.md', 'src/modules/registry/spec.md'];
  assert.equal(findContainingSpec('src/modules/intake/a.ts', base), base[2]);
  assert.equal(
    findContainingSpec('src/modules/intake-extra/a.ts', base),
    'src/spec.md',
  );
  assert.equal(findContainingSpec('README.md', base), 'spec.md');
  assert.equal(findContainingSpec('src/a.ts', []), null);
  assert.equal(
    findContainingSpec('src/modules/intake/a.ts', candidate),
    'src/spec.md',
  );
  assert.equal(
    findContainingSpec('src/modules/registry/a.ts', candidate),
    candidate[2],
  );
  assert.equal(
    findCommonSpec(
      ['src/modules/intake/a.ts', 'src/modules/registry/a.ts'],
      base,
    ),
    'src/spec.md',
  );
  assert.equal(findCommonSpec([], base), null);
  assert.throws(() => findContainingSpec('../outside/a.ts', base));
});

test('system spec parser keeps normative text and reads metadata outside fenced examples', () => {
  const wording = 'The engine SHALL preserve exact wording.\n';
  const spec = parseSystemSpec(
    'src/modules/intake/spec.md',
    [
      '# Intake',
      '',
      '## Purpose',
      'Preserve what the owner said.',
      '',
      '## Requirements',
      '### Requirement: Exact wording',
      'sources: [SRC-first, "SRC-second"]',
      '',
      wording,
      '#### Scenario: Original input',
      'covers: intake.ts#Invariants[1]',
      'sources: [SRC-second]',
      'test: ../../../test/intake.test.ts#exact wording',
      '',
      '- **WHEN** text is captured',
      '- **THEN** bytes stay unchanged',
      '',
      '```markdown',
      '### Requirement: Example only',
      'test: fake#test',
      '```',
      '',
      '#### Scenario: Shared promise',
      'covers: #Requirement: Exact wording',
      'test: ../../../test/intake.test.ts#shared promise',
      '',
      '- **THEN** the shared promise holds',
      '',
    ].join('\n'),
  );
  assert.equal(spec.path, 'src/modules/intake/spec.md');
  assert.equal(spec.title, 'Intake');
  assert.equal(spec.purpose, 'Preserve what the owner said.');
  assert.equal(spec.requirements.length, 1);
  const requirement = spec.requirements[0]!;
  assert.equal(requirement.title, 'Exact wording');
  assert.deepEqual(requirement.sources, ['SRC-first', 'SRC-second']);
  assert.ok(requirement.text.includes(wording));
  assert.equal(requirement.scenarios.length, 2);
  assert.deepEqual(requirement.scenarios[0]!.sources, ['SRC-second']);
  assert.equal(requirement.scenarios[0]!.covers, 'intake.ts#Invariants[1]');
  assert.equal(
    requirement.scenarios[0]!.test,
    '../../../test/intake.test.ts#exact wording',
  );
  assert.equal(requirement.scenarios[1]!.covers, '#Requirement: Exact wording');
  assert.deepEqual(requirement.scenarios[1]!.sources, []);
  assert.throws(() =>
    parseSystemSpec(
      'spec.md',
      '### Requirement: X\nsources: [SRC-first]\nsources: [SRC-second]\n',
    ),
  );
});
