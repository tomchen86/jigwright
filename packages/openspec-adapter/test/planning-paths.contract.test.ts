import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

test('OpenSpec planning paths are a public adapter contract', () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'packages/openspec-adapter/package.json'),
      'utf8',
    ),
  ) as { exports?: Record<string, string> };

  assert.equal(
    manifest.exports?.['./planning-paths'],
    './src/planning-paths.ts',
  );
  assert.equal(
    fs.existsSync(
      path.join(
        repositoryRoot,
        'packages/openspec-adapter/src/planning-paths.ts',
      ),
    ),
    true,
  );
});

test('OpenSpec planning paths preserve current-v3 grammar and reject foreign paths', async () => {
  const {
    OpenSpecPlanningPathError,
    assertOpenSpecPlanningPaths,
    requiredOpenSpecPlanningArtifactPaths,
  } = await import('../src/planning-paths.ts');
  const required = requiredOpenSpecPlanningArtifactPaths(
    'plans',
    'demo-change',
    'orbit-spec-v1',
    'orbit-spec-v1',
  );

  assert.deepEqual(required, [
    'plans/demo-change/.openspec.yaml',
    'plans/demo-change/design.md',
    'plans/demo-change/execution.json',
    'plans/demo-change/guard.json',
    'plans/demo-change/investigation.json',
    'plans/demo-change/plan-review.json',
    'plans/demo-change/proposal.md',
    'plans/demo-change/tasks.md',
  ]);
  assert.doesNotThrow(() =>
    assertOpenSpecPlanningPaths({
      changeRoot: 'plans',
      changeId: 'demo-change',
      changedPaths: [
        ...required,
        'plans/demo-change/origin.json',
        'plans/demo-change/survey.json',
        'plans/demo-change/specs/demo/spec.md',
        'workflow/change-providers/demo-change.json',
      ],
      deletedPaths: [],
      schemaName: 'orbit-spec-v1',
      currentSchemaName: 'orbit-spec-v1',
      additionalExactPaths: ['workflow/change-providers/demo-change.json'],
    }),
  );

  for (const invalidPath of [
    'plans/demo-change/README.md',
    'plans/demo-change/specs/demo/notes.md',
    'plans/other-change/tasks.md',
    'workflow/change-providers/other-change.json',
  ]) {
    assert.throws(
      () =>
        assertOpenSpecPlanningPaths({
          changeRoot: 'plans',
          changeId: 'demo-change',
          changedPaths: [invalidPath],
          deletedPaths: [],
          schemaName: 'orbit-spec-v1',
          currentSchemaName: 'orbit-spec-v1',
          additionalExactPaths: ['workflow/change-providers/demo-change.json'],
        }),
      (error) =>
        error instanceof OpenSpecPlanningPathError &&
        error.code === 'PLANNING_PATHS_INVALID' &&
        JSON.stringify(error.invalidPaths) === JSON.stringify([invalidPath]),
      invalidPath,
    );
  }
  assert.throws(
    () =>
      assertOpenSpecPlanningPaths({
        changeRoot: 'plans',
        changeId: 'demo-change',
        changedPaths: ['../escape'],
        deletedPaths: [],
        schemaName: 'orbit-spec-v1',
        currentSchemaName: 'orbit-spec-v1',
      }),
    (error) =>
      error instanceof OpenSpecPlanningPathError &&
      error.code === 'PLANNING_PATH_SYNTAX_INVALID' &&
      JSON.stringify(error.invalidPaths) === JSON.stringify(['../escape']),
  );
});

test('OpenSpec planning paths preserve current deletion and reserved-root refusals', async () => {
  const { OpenSpecPlanningPathError, assertOpenSpecPlanningPaths } =
    await import('../src/planning-paths.ts');
  const input = {
    changeRoot: 'plans',
    changeId: 'demo-change',
    changedPaths: ['plans/demo-change/retired-note.md'],
    deletedPaths: ['plans/demo-change/retired-note.md'],
    schemaName: 'orbit-spec-v1',
    currentSchemaName: 'orbit-spec-v1',
    additionalExactPaths: ['workflow/change-providers/demo-change.json'],
  } as const;

  assert.doesNotThrow(() => assertOpenSpecPlanningPaths(input));
  assert.throws(
    () =>
      assertOpenSpecPlanningPaths({
        ...input,
        changeId: 'archive',
        changedPaths: ['plans/archive/proposal.md'],
        deletedPaths: [],
      }),
    (error) =>
      error instanceof OpenSpecPlanningPathError &&
      error.code === 'PLANNING_CHANGE_ID_RESERVED',
  );
});
