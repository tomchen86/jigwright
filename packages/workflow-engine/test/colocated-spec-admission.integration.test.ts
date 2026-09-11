import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { abortSession } from '../src/composition-root/task-session-production.ts';
import {
  addConcurrentChangeSkeleton,
  declareConcurrentWorkset,
  prepareConcurrentTaskWorktree,
  removeConcurrentTaskWorktree,
} from './support/session-lifecycle-fixture.ts';

test('explicit colocated contract writers serialize while disjoint module implementation scopes remain concurrent', () => {
  for (const explicitContract of [true, false]) {
    const repository = createFixtureRepository();
    const worktrees: Array<{ parent: string; worktree: string }> = [];
    try {
      addConcurrentChangeSkeleton(repository, 'second-change');
      git(repository, ['add', '.']);
      git(repository, ['commit', '-m', 'Add concurrent contract fixture']);
      declareConcurrentWorkset(repository, 'second-change');
      const suffix = explicitContract ? 'spec.md' : '**';
      const first = prepareConcurrentTaskWorktree(
        repository,
        'demo-change',
        `src/modules/first/${suffix}`,
      );
      const second = prepareConcurrentTaskWorktree(
        repository,
        'second-change',
        `src/modules/second/${suffix}`,
      );
      worktrees.push(first, second);
      const active = startSession(
        productionChangeRoutingAdmissionReader,
        first.worktree,
        'demo-change',
        '1.1',
      );
      if (explicitContract) {
        assert.throws(
          () =>
            startSession(
              productionChangeRoutingAdmissionReader,
              second.worktree,
              'second-change',
              '1.1',
            ),
          (error) =>
            isWorkflowError(error, 'TASK_SESSION_SERIALIZED_SCOPE_CONFLICT'),
        );
      } else {
        const concurrent = startSession(
          productionChangeRoutingAdmissionReader,
          second.worktree,
          'second-change',
          '1.1',
        );
        assert.notEqual(active.repositoryRoot, concurrent.repositoryRoot);
        abortSession(
          second.worktree,
          concurrent.sessionId,
          'Module scope regression cleanup.',
        );
      }
      abortSession(
        first.worktree,
        active.sessionId,
        'Contract scope regression cleanup.',
      );
    } finally {
      for (const fixture of worktrees.reverse())
        removeConcurrentTaskWorktree(repository, fixture);
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});
