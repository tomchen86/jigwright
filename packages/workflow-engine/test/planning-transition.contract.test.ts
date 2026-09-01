import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertPlanningPaths,
  assertPlanningTaskHistory,
} from '../src/application/propose/planning-transition.ts';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import { planningProviderBindingPath } from '../src/modules/source/planning-paths.ts';
import { isWorkflowError } from './fixture.ts';

test('OpenSpec planning path grammar is package-owned behind the engine facade', () => {
  const facade = fs.readFileSync(
    path.join(import.meta.dirname, '../src/modules/source/planning-paths.ts'),
    'utf8',
  );

  assert.match(facade, /@jigwright\/openspec-adapter\/planning-paths/u);
  assert.doesNotMatch(
    facade,
    /['"](?:\.openspec\.yaml|proposal\.md|design\.md|tasks\.md|guard\.json|investigation\.json|execution\.json|plan-review\.json|spec\.md)['"]/u,
  );

  assert.equal(
    planningProviderBindingPath('demo-change'),
    'workflow/change-providers/demo-change.json',
  );
  for (const invalidChangeId of ['archive', 'Demo-change']) {
    assert.throws(
      () => planningProviderBindingPath(invalidChangeId),
      (error) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, 'PLANNING_CHANGE_ID_INVALID');
        assert.equal(error.exitCode, ExitCode.guard);
        assert.equal(
          error.message,
          'Planning-provider binding requires one valid non-reserved change ID.',
        );
        return true;
      },
    );
  }
});

test('planning paths accept only the exact named OpenSpec planning grammar', () => {
  assert.doesNotThrow(() =>
    assertPlanningPaths(
      'openspec/changes',
      'demo-change',
      [
        'openspec/changes/demo-change/.openspec.yaml',
        'openspec/changes/demo-change/design.md',
        'openspec/changes/demo-change/guard.json',
        'openspec/changes/demo-change/proposal.md',
        'openspec/changes/demo-change/specs/demo/spec.md',
        'openspec/changes/demo-change/tasks.md',
        'workflow/change-providers/demo-change.json',
      ],
      [],
      'jigwright',
      'jigwright',
    ),
  );

  for (const invalidPath of [
    'src/feature.ts',
    'openspec/specs/demo/spec.md',
    'openspec/changes/archive/2026-07-15-demo-change/tasks.md',
    'openspec/changes/other-change/tasks.md',
    'openspec/changes/demo-change/README.md',
    'openspec/changes/demo-change/specs/demo/notes.md',
    'openspec/changes/demo-change/specs/spec.md',
    'workflow/change-providers/other-change.json',
    'workflow/agent-plans/demo-change.json',
  ]) {
    assert.throws(
      () =>
        assertPlanningPaths(
          'openspec/changes',
          'demo-change',
          [invalidPath],
          [],
          'jigwright',
          'jigwright',
        ),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
      invalidPath,
    );
  }
});

test('planning paths select current or non-current grammar explicitly', () => {
  const investigationPath = 'openspec/changes/demo-change/investigation.json';
  const v2Paths = [
    investigationPath,
    'openspec/changes/demo-change/execution.json',
    'openspec/changes/demo-change/origin.json',
    'openspec/changes/demo-change/plan-review.json',
    'openspec/changes/demo-change/survey.json',
  ];

  assert.doesNotThrow(() =>
    assertPlanningPaths(
      'openspec/changes',
      'demo-change',
      v2Paths,
      [],
      'jigwright',
      'jigwright',
    ),
  );
  for (const v2Path of v2Paths.filter(
    (candidate) =>
      !candidate.endsWith('/origin.json') &&
      !candidate.endsWith('/survey.json'),
  )) {
    assert.throws(
      () =>
        assertPlanningPaths(
          'openspec/changes',
          'demo-change',
          [v2Path],
          [],
          'historical-schema',
          'jigwright',
        ),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
      v2Path,
    );
  }
});

test('planning paths derive the investigation-first grammar from the configured current schema', () => {
  const currentPaths = [
    'plans/demo-change/investigation.json',
    'plans/demo-change/execution.json',
    'plans/demo-change/origin.json',
    'plans/demo-change/plan-review.json',
    'plans/demo-change/survey.json',
  ];

  assert.doesNotThrow(() =>
    assertPlanningPaths(
      'plans',
      'demo-change',
      currentPaths,
      [],
      'orbit-spec-v1',
      'orbit-spec-v1',
    ),
  );
  assert.throws(
    () =>
      assertPlanningPaths(
        'plans',
        'demo-change',
        currentPaths,
        [],
        'historical-schema',
        'orbit-spec-v1',
      ),
    (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
  );
});

test('planning paths reject the reserved OpenSpec archive container as a change', () => {
  assert.throws(
    () =>
      assertPlanningPaths(
        'openspec/changes',
        'archive',
        ['openspec/changes/archive/proposal.md'],
        [],
        'jigwright',
        'jigwright',
      ),
    (error) => isWorkflowError(error, 'PLANNING_CHANGE_ID_RESERVED'),
  );
});

test('planning path package errors retain exact workflow error bytes', () => {
  assert.throws(
    () =>
      assertPlanningPaths(
        'openspec/changes',
        'demo-change',
        ['../escape'],
        [],
        'jigwright',
        'jigwright',
      ),
    (error) => {
      assert.equal(error instanceof WorkflowError, true);
      const workflow = error as WorkflowError;
      assert.equal(workflow.code, 'INVALID_REPOSITORY_PATH');
      assert.equal(
        workflow.message,
        'Invalid repository path reported by Git: ../escape',
      );
      assert.equal(workflow.exitCode, ExitCode.guard);
      assert.deepEqual(workflow.details, { path: '../escape' });
      assert.equal(workflow.recovery, undefined);
      return true;
    },
  );
});

test('planning introductions require every task to be unchecked', () => {
  assert.doesNotThrow(() =>
    assertPlanningTaskHistory(undefined, [
      { id: '1.1', completed: false, title: 'First task' },
      { id: '1.2', completed: false, title: 'Second task' },
    ]),
  );
  assert.throws(
    () =>
      assertPlanningTaskHistory(undefined, [
        { id: '1.1', completed: true, title: 'Already complete' },
      ]),
    (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
  );
});

test('planning revisions preserve shared state and add only unchecked tasks', () => {
  const before = [
    { id: '1.1', completed: true, title: 'Completed task' },
    { id: '1.2', completed: false, title: 'Planned task' },
  ];
  assert.doesNotThrow(() =>
    assertPlanningTaskHistory(before, [
      { ...before[0], title: 'Retitled completed task' },
      { id: '1.3', completed: false, title: 'New task' },
    ]),
  );

  for (const after of [
    [{ ...before[0], completed: false }, before[1]],
    [before[1]],
    [...before, { id: '1.3', completed: true, title: 'New but checked' }],
  ]) {
    assert.throws(
      () => assertPlanningTaskHistory(before, after),
      (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
    );
  }
});

test('planning paths accept only in-tree deletions of non-canonical files', () => {
  assert.doesNotThrow(() =>
    assertPlanningPaths(
      'openspec/changes',
      'demo-change',
      [
        'openspec/changes/demo-change/design.md',
        'openspec/changes/demo-change/requirement-audit.md',
      ],
      ['openspec/changes/demo-change/requirement-audit.md'],
      'jigwright',
      'jigwright',
    ),
  );
  assert.throws(
    () =>
      assertPlanningPaths(
        'openspec/changes',
        'demo-change',
        ['openspec/changes/demo-change/requirement-audit.md'],
        [],
        'jigwright',
        'jigwright',
      ),
    (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
  );
  assert.throws(
    () =>
      assertPlanningPaths(
        'openspec/changes',
        'demo-change',
        ['openspec/changes/other-change/noise.md'],
        ['openspec/changes/other-change/noise.md'],
        'jigwright',
        'jigwright',
      ),
    (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
  );
});
