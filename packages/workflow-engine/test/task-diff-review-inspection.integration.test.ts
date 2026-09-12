import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { finalizeTask } from './support/local-engine-selection-host.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { inspectTaskDiffReviewSubject } from '../src/composition-root/task-diff-review-production.ts';
import { createTaskDiffDocumentationClosureRequirement } from '../src/modules/assurance/task-diff-review.ts';
import { git, runtimeRoot } from './fixture.ts';
import {
  createReviewFixture,
  runCli,
  snapshotRepositoryObservation,
  hasCode,
} from './task-diff-review-inspection-fixture.ts';

test('review-diff inspect derives one exact checked candidate subject without rerunning checks', () => {
  const { repository, counterPath } = createReviewFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    fs.chmodSync(path.join(repository, 'src/feature.ts'), 0o755);

    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const first = inspectTaskDiffReviewSubject(repository, session.sessionId);
    const replay = inspectTaskDiffReviewSubject(repository, session.sessionId);
    assert.deepEqual(replay, first);
    assert.equal(first.changeId, 'demo-change');
    assert.equal(first.taskId, '1.1');
    assert.equal(first.repositoryId, 'github:R_kgDOUHqyNQ');
    assert.equal(first.reviewRequirement.required, true);
    assert.equal(first.reviewRequirement.basis, 'risk-role');
    assert.match(first.subjectDigest, /^[0-9a-f]{64}$/);
    assert.match(first.checkEvidenceDigest, /^[0-9a-f]{64}$/);
    assert.match(first.taskContractDigest, /^[0-9a-f]{64}$/);
    assert.match(first.requiredCheckPolicyDigest, /^[0-9a-f]{64}$/);
    const transaction = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeRoot(repository),
          'finalize-transactions',
          `${session.sessionId}.json`,
        ),
        'utf8',
      ),
    ) as { candidateTree: string };
    assert.equal(first.candidateTree, transaction.candidateTree);
    assert.deepEqual(
      first.transitions.find(
        ({ path: changedPath }) => changedPath === 'src/feature.ts',
      ),
      {
        path: 'src/feature.ts',
        before: null,
        after: {
          mode: '100755',
          objectId: git(repository, [
            'rev-parse',
            `${first.candidateTree}:src/feature.ts`,
          ]).trim(),
        },
      },
    );

    const observationBeforeInspection =
      snapshotRepositoryObservation(repository);
    const inspected = runCli(repository, [
      'review-diff',
      'inspect',
      session.sessionId,
      '--json',
    ]);
    assert.equal(inspected.status, 0, inspected.stderr);
    const inspectedOutput = JSON.parse(inspected.stdout) as {
      result: unknown;
      nextSteps: Array<{ command: string; why: string }>;
    };
    assert.deepEqual(inspectedOutput.result, first);
    const expectedNextSteps = [
      `pnpm workflow review-diff ${session.sessionId} --json`,
      `pnpm workflow status ${session.sessionId} --json`,
    ];
    assert.deepEqual(
      inspectedOutput.nextSteps.map(({ command }) => command),
      expectedNextSteps,
    );
    const status = runCli(repository, [
      'review-diff',
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(
      (
        JSON.parse(status.stdout) as {
          nextSteps: Array<{ command: string; why: string }>;
        }
      ).nextSteps.map(({ command }) => command),
      expectedNextSteps,
    );
    assert.deepEqual(
      snapshotRepositoryObservation(repository),
      observationBeforeInspection,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = false;\n',
    );
    assert.throws(
      () => inspectTaskDiffReviewSubject(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CANDIDATE_DIVERGED'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('final documentation closure activates review for an ordinary candidate', () => {
  const { repository, counterPath } = createReviewFixture({
    configurePathRoles(registry) {
      registry.roles.ordinary.unshift('src/**');
    },
  });
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const documented = true;\n',
    );

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const subject = inspectTaskDiffReviewSubject(repository, session.sessionId);
    assert.equal(subject.reviewRequirement.required, true);
    assert.equal(subject.reviewRequirement.basis, 'explicit');
    assert.equal(subject.documentationRequirement?.required, true);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('final documentation closure uses only the current roadmap hint identity', () => {
  const { repository } = createReviewFixture({
    additionalAllowedPaths: ['docs/ROADMAP.md'],
  });
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'docs/ROADMAP.md'),
      '# Roadmap\n\nCurrent product direction.\n',
    );

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const requirement = inspectTaskDiffReviewSubject(
      repository,
      session.sessionId,
    ).documentationRequirement;
    assert.equal(requirement?.required, true);
    if (requirement?.required !== true) {
      assert.fail('Expected a final documentation closure requirement.');
    }
    assert.throws(
      () =>
        createTaskDiffDocumentationClosureRequirement({
          required: true,
          changeBaseCommit: requirement.changeBaseCommit,
          changeBaseTree: requirement.changeBaseTree,
          candidateTree: requirement.candidateTree,
          changedPaths: requirement.changedPaths,
          patchDigest: requirement.patchDigest,
          hints: [
            {
              reason: 'issue-or-roadmap-state-changed',
              suggestedPaths: ['docs/ROADMAP.md'],
            },
          ] as never,
        }),
      hasCode('TASK_DIFF_REVIEW_SUBJECT_INVALID'),
    );
    assert.deepEqual(requirement.hints, [
      {
        reason: 'roadmap-state-changed',
        suggestedPaths: ['docs/ROADMAP.md'],
      },
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff inspect is unavailable before checks freeze a candidate', () => {
  const { repository } = createReviewFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    assert.throws(
      () => inspectTaskDiffReviewSubject(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_NOT_READY'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
