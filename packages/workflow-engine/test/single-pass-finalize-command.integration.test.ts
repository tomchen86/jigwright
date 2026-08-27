import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { commitFacts } from '../src/runtime/repository-transaction/git-transitions.ts';
import { renderHandoff } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import { finalizeSession } from '../src/application/finalize/lifecycle.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import {
  beginTaskDiffReview,
  reconcileTaskDiffReview,
} from '../src/application/finalize/task-diff-review-lifecycle.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';
import type { TaskDiffReviewSubmission } from '../src/modules/assurance/task-diff-review-artifact.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import {
  getSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
} from './fixture.ts';

test('workflow finalize checks, commits, and replays one exact candidate tree', () => {
  const repository = createFinalizeFixture();
  const counterPath = path.join(repository, '.git', 'single-pass-count');
  try {
    configureCountingCheck(repository, counterPath);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    const reviewRequired = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Complete demo task',
      '--json',
    ]);
    assert.notEqual(reviewRequired.status, 0);
    assert.equal(
      parseErrorCode(reviewRequired.stderr),
      'TASK_DIFF_REVIEW_REQUIRED',
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    satisfyCurrentTaskDiffReview(repository, session.sessionId);

    const first = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Complete demo task',
      '--json',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const firstResult = parseResult(first.stdout);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(
      firstResult.assurance,
      'projected-single-pass-ordinary-failure',
    );
    assert.match(firstResult.transactionId, /^[0-9a-f]{64}$/);
    assert.match(firstResult.commitHash, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      firstResult.commitHash,
    );
    assert.equal(
      git(repository, ['rev-parse', `${firstResult.commitHash}^{tree}`]).trim(),
      firstResult.tree,
    );
    assert.equal(
      commitFacts(repository, firstResult.commitHash).tree,
      firstResult.tree,
    );
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
    assert.equal(getSession(repository, session.sessionId).state, 'committed');

    const replay = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Complete demo task',
      '--json',
    ]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(parseResult(replay.stdout), firstResult);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');

    const mismatchedReplay = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Different subject',
      '--json',
    ]);
    assert.notEqual(mismatchedReplay.status, 0);
    assert.equal(
      parseErrorCode(mismatchedReplay.stderr),
      'COMMIT_POSTCONDITION_FAILED',
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      firstResult.commitHash,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize resumes after durable finalization without rerunning checks', () => {
  const repository = createFinalizeFixture();
  const counterPath = path.join(repository, '.git', 'single-pass-resume-count');
  try {
    configureCountingCheck(repository, counterPath);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
    const session = startSession(repository, 'demo-change', '1.1');
    const baseline = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    assert.throws(
      () =>
        finalizeSession(
          repository,
          session.sessionId,
          'Complete after interruption',
        ),
      hasWorkflowCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    satisfyCurrentTaskDiffReview(repository, session.sessionId);

    assert.throws(
      () =>
        finalizeSession(
          repository,
          session.sessionId,
          'Complete after interruption',
          process.env,
          { testCrashAfter: 'finalized' },
        ),
      /Simulated finalize interruption after finalized/,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), baseline);
    assert.equal(getSession(repository, session.sessionId).state, 'active');
    const transactionBefore = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeRoot(repository),
          'finalize-transactions',
          `${session.sessionId}.json`,
        ),
        'utf8',
      ),
    ) as { phase: string; transactionId: string };
    assert.equal(transactionBefore.phase, 'completed');

    const recovered = finalizeSession(
      repository,
      session.sessionId,
      'Complete after interruption',
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(recovered.transactionId, transactionBefore.transactionId);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      recovered.commitHash,
    );
    assert.equal(getSession(repository, session.sessionId).state, 'committed');
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow finalize validates the commit subject before projection or checks', () => {
  const repository = createFinalizeFixture();
  const counterPath = path.join(
    repository,
    '.git',
    'single-pass-invalid-count',
  );
  try {
    configureCountingCheck(repository, counterPath);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    const handoffPath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
    const tasksBefore = fs.readFileSync(tasksPath, 'utf8');
    const handoffBefore = fs.readFileSync(handoffPath, 'utf8');

    const rejected = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Change: forged',
      '--json',
    ]);
    assert.notEqual(rejected.status, 0);
    assert.equal(parseErrorCode(rejected.stderr), 'INVALID_COMMIT_SUBJECT');
    assert.equal(fs.existsSync(counterPath), false);
    assert.equal(fs.readFileSync(tasksPath, 'utf8'), tasksBefore);
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), handoffBefore);
    assert.equal(getSession(repository, session.sessionId).state, 'active');
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(repository),
          'finalize-transactions',
          `${session.sessionId}.json`,
        ),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createFinalizeFixture(): string {
  const repository = createFixtureRepository();
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
  documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement: 'active',
    transition: 'completion',
  };
  fs.writeFileSync(
    documentPolicyPath,
    `${JSON.stringify(documentPolicy, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  writeReadyV3ExemptChange(repository);
  renderHandoff(repository);
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  return repository;
}

function satisfyCurrentTaskDiffReview(
  repository: string,
  sessionId: string,
): void {
  const prepared = beginTaskDiffReview(repository, sessionId, {
    explicitActor: 'codex',
    environment: {
      ...process.env,
      WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
    },
  });
  assert.equal(prepared.state, 'waiting-for-provider');
  if (!('invocationId' in prepared)) {
    assert.fail('expected a provider TaskDiffReview reservation');
  }
  assert.equal(prepared.subject.documentationRequirement?.required, true);
  const reviewedBlobObjectId = prepared.subject.transitions.find(
    ({ path: changedPath }) => changedPath === 'src/feature.ts',
  )?.after?.objectId;
  assert.ok(reviewedBlobObjectId);
  const submission: TaskDiffReviewSubmission = {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: 'src/feature.ts',
          line: 1,
          blobObjectId: reviewedBlobObjectId,
          observation:
            'The exact candidate remains within the reviewed fixture task scope.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions: prepared.subject.reviewRequirement.riskPaths.map(
      ({ path: riskPath, role }) => ({
        path: riskPath,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'no-challenge',
      }),
    ),
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact checked fixture candidate.',
    documentationAssessment: {
      decision: 'no-impact',
      notes:
        'The synthetic implementation changes no public or operator documentation contract.',
    },
  };
  const worker = runProviderWorker(repository, prepared.invocationId, {
    runner(input) {
      writeFixtureProviderRuntime(input.invocationDirectory, submission);
      return {
        invocationId: prepared.invocationId,
        providerId: input.providerId,
        purpose: 'task-diff-review',
        requestDigest: input.request.requestDigest,
        semanticOutput: submission,
        semanticOutputDigest: crypto
          .createHash('sha256')
          .update(canonicalJson(submission))
          .digest('hex'),
        assurance: 'unchanged-governed-projection',
        projection: {
          unchanged: true,
          changedCategories: [],
          beforeDigest: prepared.subject.subjectDigest,
          afterDigest: prepared.subject.subjectDigest,
        },
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: builtInProviderExecutableIdentityForTest(input.providerId),
        elapsedMs: 7,
        providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
          input.providerId,
        ),
      };
    },
  });
  assert.equal(worker.state, 'succeeded', JSON.stringify(worker.failure));
  assert.equal(
    reconcileTaskDiffReview(repository, sessionId).state,
    'satisfied',
  );
}

function writeFixtureProviderRuntime(
  invocationDirectory: string,
  semanticOutput: unknown,
): void {
  const runtime = path.join(invocationDirectory, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', '{}\n'],
    ['schema.json', '{}\n'],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
  }
}

function hasWorkflowCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected;
}

function configureCountingCheck(repository: string, counterPath: string): void {
  fs.writeFileSync(
    path.join(repository, 'scripts/count-single-pass.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      "const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(current + 1));',
      "if (!fs.readFileSync('openspec/changes/demo-change/tasks.md', 'utf8').includes('- [x] 1.1')) process.exit(17);",
      "if (!fs.readFileSync('docs/CURRENT_AND_NEXT_STEPS.md', 'utf8').includes('None — no active change.')) process.exit(18);",
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      counted: {
        command: ['node', 'scripts/count-single-pass.mjs', counterPath],
        destructiveDatabase: false,
      },
    },
    ['counted'],
  );
}

function runCli(
  repository: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.resolve(import.meta.dirname, '../src/cli.ts'),
      ...args,
    ],
    { cwd: repository, encoding: 'utf8' },
  );
}

function parseResult(stdout: string): {
  assurance: string;
  transactionId: string;
  commitHash: string;
  tree: string;
  [key: string]: unknown;
} {
  return (JSON.parse(stdout) as { result: ReturnType<typeof parseResult> })
    .result;
}

function parseErrorCode(stdout: string): string {
  return (JSON.parse(stdout) as { error: { code: string } }).error.code;
}

function prepareCurrentV3Change(repository: string): void {
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
}
