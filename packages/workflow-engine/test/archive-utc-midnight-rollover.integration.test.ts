import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { createArchiveProjectionDependencies } from '../src/composition-root/planning-archive-projection-production.ts';
import { loadStableValidatedChangeContract } from '../src/composition-root/validated-contract-context.ts';
import { archiveEligibilityReplayServices } from '../src/composition-root/ci-replay-production.ts';
import { productionPlanningArchiveSourcePolicy } from '../src/composition-root/planning-archive-projection-production.ts';
import { collaborationGrantCodec as productionArchiveGrantCodec } from '../src/runtime/grants/grant-services.ts';
import { reconcileArchivedWorkItems as productionArchivedWorkItemReconciler } from '../src/composition-root/work-registry-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { renderHandoffFromTrackedFacts as productionTrackedHandoffRenderer } from '../src/composition-root/handoff-production.ts';
const commitArchiveTransition = commitArchiveTransitionWithHandoff.bind(
  undefined,
  loadStableValidatedChangeContract,
  productionPlanningExecution,
  createArchiveProjectionDependencies(),
  archiveEligibilityReplayServices,
  productionArchiveGrantCodec,
  productionTrackedHandoffRenderer,
  productionArchivedWorkItemReconciler,
);
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';

import { commitArchiveTransition as commitArchiveTransitionWithHandoff } from '../src/application/archive/archive-transition.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/runtime/planning-transition/planning-transition.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  prepareCurrentV3IntroductionFixture,
  runtimeRoot,
  syncOriginMain,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { commitCurrentFixtureTask } from './support/task-diff-review-fixture.ts';

const START_DATE = '2026-08-09T23:59:59.999Z';
const ROLLOVER_DATE = '2026-08-10T00:00:00.001Z';
const SECOND_ROLLOVER_DATE = '2026-08-11T00:00:00.001Z';
const ARCHIVE_DATE = '2026-08-10';

test('same-day archive and its existing replay do not read a rollover clock', () => {
  const repository = completedFixture();
  const clock = fixedClock(ROLLOVER_DATE);
  try {
    const worktrees = worktreeTopology(repository);
    const committed = commitArchiveTransition(
      repository,
      'demo-change',
      process.env,
      { now: clock.now },
    );
    assert.equal(committed.status, 'committed');
    assert.equal(clock.calls(), 1);

    const replay = commitArchiveTransition(
      repository,
      'demo-change',
      process.env,
      { now: clock.now },
    );
    assert.equal(replay.status, 'already-archived');
    assert.equal(replay.commitHash, committed.commitHash);
    assert.equal(replay.reportId, committed.reportId);
    assert.equal(replay.archivePath, committed.archivePath);
    assert.equal(clock.calls(), 1);
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('malformed rollover details preserve the original error without refresh or another clock read', () => {
  const repository = completedFixture();
  const clock = fixedClock(ROLLOVER_DATE);
  const failure = workflowError(
    'ARCHIVE_UTC_DATE_ROLLOVER',
    'Malformed rollover observation',
    ExitCode.verification,
    { details: { observedDate: '2026-02-30' } },
  );
  let attempts = 0;
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now: clock.now,
          beforeApply() {
            attempts += 1;
            throw failure;
          },
        }),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
    assert.equal(clock.calls(), 1);
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive retries once under the same operation when exact output crosses to the adjacent UTC day', () => {
  const repository = completedFixture();
  const clock = fixedClock(START_DATE, ROLLOVER_DATE);
  try {
    const worktrees = worktreeTopology(repository);
    const committed = commitArchiveTransition(
      repository,
      'demo-change',
      process.env,
      { now: clock.now },
    );

    assert.equal(committed.status, 'committed');
    assert.equal(clock.calls(), 2);
    assert.equal(
      committed.archivePath,
      `openspec/changes/archive/${ARCHIVE_DATE}-demo-change`,
    );
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
    assert.equal(worktreeTopology(repository), worktrees);

    const replay = commitArchiveTransition(repository, 'demo-change');
    assert.equal(replay.status, 'already-archived');
    assert.equal(replay.commitHash, committed.commitHash);
    assert.equal(replay.reportId, committed.reportId);
    assert.equal(replay.archivePath, committed.archivePath);
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive rollover refresh refuses to adopt a concurrent clean commit', () => {
  const repository = completedFixture();
  const before = git(repository, ['rev-parse', 'HEAD']).trim();
  let competingCommit = '';
  let calls = 0;
  const now = (): Date => {
    calls += 1;
    if (calls === 2) {
      competingCommit = git(repository, [
        'commit-tree',
        `${before}^{tree}`,
        '-p',
        before,
        '-m',
        'Concurrent clean commit',
      ]).trim();
      git(repository, [
        'update-ref',
        'refs/heads/work/archive-demo',
        competingCommit,
        before,
      ]);
      return new Date(ROLLOVER_DATE);
    }
    return new Date(START_DATE);
  };
  try {
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now,
        }),
      (error) =>
        isWorkflowError(error, 'ARCHIVE_HEAD_CHANGED') ||
        isWorkflowError(error, 'ARCHIVE_ELIGIBILITY_CHANGED'),
    );

    assert.equal(calls, 2);
    assert.notEqual(competingCommit, '');
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      competingCommit,
    );
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/demo-change')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/archive')),
      false,
    );
    assert.deepEqual(
      entriesIfPresent(path.join(runtimeRoot(repository), 'archive-reports')),
      [],
    );
    assert.deepEqual(
      entriesIfPresent(path.join(runtimeRoot(repository), 'archive-patches')),
      [],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive rejects an adjacent output date when the operation clock did not cross UTC midnight', () => {
  const repository = completedFixture();
  const clock = fixedClock(START_DATE, START_DATE);
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now: clock.now,
        }),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'),
    );

    assert.equal(clock.calls(), 2);
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive does not retry a non-adjacent payload date', () => {
  const repository = completedFixture();
  const clock = fixedClock('2026-08-08T23:59:59.999Z');
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now: clock.now,
        }),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'),
    );

    assert.equal(clock.calls(), 1);
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive does not reinterpret an escaped payload as a UTC rollover', () => {
  const repository = completedFixture('ARCHIVE_ESCAPE');
  const clock = fixedClock(START_DATE, ROLLOVER_DATE);
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now: clock.now,
          aroundArchivePreparation: (invoke) =>
            withPlanningFaultEnabled(repository, 'ARCHIVE_ESCAPE', invoke),
        }),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'),
    );

    assert.equal(clock.calls(), 1);
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive requires exact payload identity and shape before recognizing a UTC rollover', () => {
  const repository = completedFixture();
  const binPath = fixtureOpenSpecBin(repository);
  const exactSource = fs.readFileSync(binPath, 'utf8');
  const malformedSources = [
    replaceExactlyOnce(
      exactSource,
      '    archive: {\n      change: changeId,\n      archivedAs: archiveName,',
      "    archive: {\n      change: 'other-change',\n      archivedAs: archiveName,",
    ),
    replaceExactlyOnce(
      exactSource,
      '      totals: applied.totals\n    },',
      '      totals: applied.totals,\n      unexpected: true\n    },',
    ),
  ];
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    for (const malformedSource of malformedSources) {
      const clock = fixedClock(START_DATE, ROLLOVER_DATE);
      assert.throws(
        () =>
          commitArchiveTransition(repository, 'demo-change', process.env, {
            now: clock.now,
            aroundArchivePreparation: (invoke) =>
              withFixtureOpenSpecSource(repository, malformedSource, invoke),
          }),
        (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'),
      );
      assert.equal(clock.calls(), 1);
      assert.deepEqual(repositoryState(repository), before);
      assert.equal(worktreeTopology(repository), worktrees);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive bounds a second adjacent UTC rollover without a third attempt', () => {
  const repository = completedFixture();
  let archiveCalls = 0;
  const clock = fixedClock(START_DATE, ROLLOVER_DATE, SECOND_ROLLOVER_DATE);
  try {
    const before = repositoryState(repository);
    const worktrees = worktreeTopology(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          now: clock.now,
          aroundArchivePreparation: (invoke) => {
            const date = archiveCalls++ === 0 ? ARCHIVE_DATE : '2026-08-11';
            return withArchiveOutputDate(invoke, date);
          },
        }),
      (error) => isWorkflowError(error, 'ARCHIVE_UTC_DATE_ROLLOVER'),
    );

    assert.equal(clock.calls(), 3);
    assert.equal(archiveCalls, 2);
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(worktreeTopology(repository), worktrees);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function fixedClock(...timestamps: string[]) {
  let calls = 0;
  return {
    now(): Date {
      const timestamp = timestamps[Math.min(calls, timestamps.length - 1)];
      calls += 1;
      assert.ok(timestamp);
      return new Date(timestamp);
    },
    calls: () => calls,
  };
}

function completedFixture(marker = ''): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    `${addedDelta()}${marker ? `\n${marker}\n` : ''}`,
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure archive delta']);
  prepareCurrentV3IntroductionFixture(repository, 'demo-change');
  writeReadyV3ExemptChange(repository);
  withPlanningFaultDisabled(repository, marker, () =>
    commitPlanningTransition(repository, 'demo-change'),
  );
  const completed = withPlanningFaultDisabled(repository, marker, () =>
    commitCurrentFixtureTask(repository, {
      message: 'Complete demo task',
    }),
  );
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', completed]);
  syncOriginMain(repository);
  git(repository, ['checkout', '-b', 'work/archive-demo']);
  disablePlanningFault(repository, marker);
  pinFixtureArchiveDate(repository, ARCHIVE_DATE);
  return repository;
}

function withPlanningFaultDisabled<T>(
  repository: string,
  marker: string,
  action: () => T,
): T {
  if (!marker) return action();
  const binaryPath = fixtureOpenSpecBin(repository);
  const original = fs.readFileSync(binaryPath, 'utf8');
  const disabled = original.replace(`'${marker}'`, `'DISABLED_${marker}'`);
  assert.notEqual(disabled, original);
  fs.writeFileSync(binaryPath, disabled);
  try {
    return action();
  } finally {
    fs.writeFileSync(binaryPath, original);
  }
}

function disablePlanningFault(repository: string, marker: string): void {
  if (!marker) return;
  const binaryPath = fixtureOpenSpecBin(repository);
  const source = fs.readFileSync(binaryPath, 'utf8');
  const disabled = source.replace(`'${marker}'`, `'DISABLED_${marker}'`);
  assert.notEqual(disabled, source);
  fs.writeFileSync(binaryPath, disabled);
}

function withPlanningFaultEnabled<T>(
  repository: string,
  marker: string,
  action: () => T,
): T {
  const binaryPath = fixtureOpenSpecBin(repository);
  const disabled = fs.readFileSync(binaryPath, 'utf8');
  const enabled = disabled.replace(`'DISABLED_${marker}'`, `'${marker}'`);
  assert.notEqual(enabled, disabled);
  fs.writeFileSync(binaryPath, enabled);
  try {
    return action();
  } finally {
    fs.writeFileSync(binaryPath, disabled);
  }
}

function withFixtureOpenSpecSource<T>(
  repository: string,
  source: string,
  action: () => T,
): T {
  const binaryPath = fixtureOpenSpecBin(repository);
  const original = fs.readFileSync(binaryPath, 'utf8');
  fs.writeFileSync(binaryPath, source);
  try {
    return action();
  } finally {
    fs.writeFileSync(binaryPath, original);
  }
}

function withArchiveOutputDate<T>(action: () => T, date: string): T {
  const projection = action() as {
    archiveName: string;
    archivePath: string;
  };
  const archiveName = `${date}-demo-change`;
  return {
    ...projection,
    archiveName,
    archivePath: path.posix.join('openspec/changes/archive', archiveName),
  } as T;
}

function pinFixtureArchiveDate(repository: string, date: string): void {
  const binPath = fixtureOpenSpecBin(repository);
  const source = fs.readFileSync(binPath, 'utf8');
  const expression = "new Date().toISOString().slice(0, 10) + '-' + changeId";
  const replacement = `'${date}' + '-' + changeId`;
  const updated = source.replace(expression, replacement);
  assert.notEqual(updated, source);
  assert.equal(updated.includes(expression), false);
  fs.writeFileSync(binPath, updated);
}

function fixtureOpenSpecBin(repository: string): string {
  return path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
}

function replaceExactlyOnce(
  source: string,
  expected: string,
  replacement: string,
): string {
  const index = source.indexOf(expected);
  assert.notEqual(index, -1);
  assert.equal(source.indexOf(expected, index + expected.length), -1);
  return `${source.slice(0, index)}${replacement}${source.slice(
    index + expected.length,
  )}`;
}

function addedDelta(): string {
  return [
    '# Delta',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: Demo',
    'The system SHALL provide a demo.',
    '',
    '#### Scenario: Demo works',
    '',
    '- **WHEN** the demo runs',
    '- **THEN** it succeeds',
    '',
  ].join('\n');
}

function repositoryState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
  };
}

function worktreeTopology(repository: string): string {
  return git(repository, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => !line.startsWith('HEAD '))
    .join('\n');
}

function entriesIfPresent(directory: string): string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}
