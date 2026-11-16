import assert from 'node:assert/strict';
import test from 'node:test';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import { assertPlanningPaths } from '../src/modules/source/planning-paths.ts';
import { openSpecPlanningPathPolicy } from '../src/adapters/planning/openspec/documents/planning-path-policy.ts';
import { readSystemSpecDeltaInputs } from '../src/adapters/planning/openspec/documents/system-spec-deltas.ts';

function validate(changeId: string, paths: string[]) {
  return assertPlanningPaths(
    openSpecPlanningPathPolicy.admit,
    'plans',
    changeId,
    paths,
    [],
    'configured-schema',
    'configured-schema',
  );
}

test('OpenSpec path adaptation keeps exact reserved, path syntax, and outside-tree workflow failures', () => {
  assert.throws(() => validate('archive', ['plans/archive/proposal.md']), {
    code: 'PLANNING_CHANGE_ID_RESERVED',
    message:
      'The OpenSpec archive container cannot be used as an active change ID.',
    exitCode: ExitCode.guard,
  });
  assert.throws(
    () => validate('demo', ['../escape']),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, 'INVALID_REPOSITORY_PATH');
      assert.equal(
        error.message,
        'Invalid repository path reported by Git: ../escape',
      );
      assert.equal(error.exitCode, ExitCode.guard);
      assert.deepEqual(error.details, { path: '../escape' });
      assert.equal(error.recovery, undefined);
      return true;
    },
  );
  assert.throws(
    () => validate('demo', ['src/z.ts', 'src/a.ts']),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, 'PLANNING_PATHS_INVALID');
      assert.equal(
        error.message,
        'Planning transition contains paths outside the named configured-schema planning tree.',
      );
      assert.deepEqual(error.details, {
        invalidPaths: ['src/a.ts', 'src/z.ts'],
      });
      return true;
    },
  );
});

test('selected OpenSpec policy owns required artifact grammar while immutable Source precedence remains in the engine', () => {
  const current = openSpecPlanningPathPolicy.requiredArtifactPaths(
    'plans',
    'demo',
    'configured-schema',
    'configured-schema',
  );
  assert.deepEqual(current, [
    'plans/demo/.openspec.yaml',
    'plans/demo/design.md',
    'plans/demo/execution.json',
    'plans/demo/guard.json',
    'plans/demo/investigation.json',
    'plans/demo/plan-review.json',
    'plans/demo/proposal.md',
    'plans/demo/tasks.md',
  ]);
  assert.doesNotThrow(() => validate('demo', current));
  const source = `SRC-${'a'.repeat(64)}` as const;
  const sourcePath = `workflow/source-ledger/objects/sha256/aa/${'a'.repeat(64)}.json`;
  assert.throws(
    () =>
      assertPlanningPaths(
        openSpecPlanningPathPolicy.admit,
        'plans',
        'archive',
        [],
        [sourcePath],
        'current',
        'current',
        [source],
      ),
    {
      code: 'PLANNING_PATHS_INVALID',
      message: 'Planning cannot delete an immutable cited Source object.',
    },
  );
});

test('OpenSpec combines sorted alias deltas only after reading every canonical group input', () => {
  const reads: string[] = [];
  const first = 'plans/demo/specs/old-alpha/spec.md';
  const last = 'plans/demo/specs/old-beta/spec.md';
  const inputs = readSystemSpecDeltaInputs(
    {
      listPaths: () => ['packages/current/spec.md'],
      readText(file) {
        reads.push(file);
        return 'capabilities: [old-alpha, old-beta]\n\n# Existing contract\n';
      },
    },
    [last, first],
    (file) => {
      reads.push(file);
      return file === first
        ? '## ADDED Requirements\n\n### Requirement: First\n'
        : '## MODIFIED Requirements\n\n### Requirement: Last\n';
    },
  );
  assert.deepEqual(reads, ['packages/current/spec.md', first, last]);
  assert.equal(inputs?.length, 1);
  assert.equal(inputs![0]!.capability, 'current');
  assert.equal(inputs![0]!.baseSpecPath, 'packages/current/spec.md');
  assert.equal(
    inputs![0]!.before,
    'capabilities: [old-alpha, old-beta]\n\n# Existing contract\n',
  );
  assert.match(
    inputs![0]!.delta,
    /## ADDED REQUIREMENTS[\s\S]*### Requirement: First[\s\S]*## MODIFIED REQUIREMENTS[\s\S]*### Requirement: Last/,
  );
});
