import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { withArchiveEligibility } from '../src/application/archive/archive-eligibility.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createDocumentationClosureRecord,
  encodeDocumentationClosure,
} from '../src/runtime/managed-documents/contracts/documentation-closure.ts';
import {
  createTaskDiffDocumentationClosureRequirement,
  createTaskDiffReviewSubject,
  TASK_DIFF_REVIEW_COVERAGE,
} from '../src/modules/assurance/task-diff-review.ts';
import { createTaskDiffReviewRecord } from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  prepareCurrentV3IntroductionFixture,
  runtimeRoot,
  syncOriginMain,
  writeReadyV3ExemptChange,
  writeManagedChangeArtifacts,
} from './fixture.ts';

test('archive eligibility binds completed task evidence to the configured base', () => {
  const repository = completedFixture();
  try {
    const result = withArchiveEligibility(
      repository,
      'demo-change',
      (eligibility) => eligibility,
    );

    assert.equal(result.changeId, 'demo-change');
    assert.equal(result.baseRef, 'refs/remotes/origin/main');
    assert.equal(
      result.base,
      git(repository, ['rev-parse', 'refs/remotes/origin/main']).trim(),
    );
    assert.equal(result.taskCommits.length, 1);
    assert.equal(result.changeRoot, 'openspec/changes');
    assert.equal(result.activeRoot, 'openspec/changes/demo-change');
    assert.equal(result.schemaName, 'jigwright');
    assert.deepEqual(result.activeArtifactPaths, [
      'openspec/changes/demo-change/.openspec.yaml',
      'openspec/changes/demo-change/design.md',
      'openspec/changes/demo-change/execution.json',
      'openspec/changes/demo-change/guard.json',
      'openspec/changes/demo-change/investigation.json',
      'openspec/changes/demo-change/plan-review.json',
      'openspec/changes/demo-change/proposal.md',
      'openspec/changes/demo-change/specs/demo/spec.md',
      'openspec/changes/demo-change/tasks.md',
    ]);
    assert.match(result.contractDigest, /^[0-9a-f]{64}$/);
    assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility rejects a non-managed schema', () => {
  const repository = legacyCompletedFixture();
  try {
    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'OPENSPEC_MANAGED_SCHEMA_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility requires documentation closure on the current path', () => {
  const repository = configuredFixture();
  try {
    completeTasks(repository);
    fs.writeFileSync(
      path.join(repository, 'src/archive-fixture.ts'),
      'export const archiveFixture = true;\n',
    );
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Complete demo task without documentation closure',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    syncOriginMain(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);

    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'TASK_EXECUTION_GENERATION_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility rejects a historical v1 investigation on the current-v3 tree', () => {
  const repository = createFixtureRepository();
  try {
    writeManagedChangeArtifacts(repository);
    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/investigation.json'),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'investigation-artifact',
        changeId: 'demo-change',
      })}\n`,
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Record v1 archive fixture']);
    git(repository, ['checkout', '-b', 'work/archive-demo']);

    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'SCHEMA_V1_FORBIDDEN'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility rejects incomplete and unevidenced task state', () => {
  const incomplete = configuredFixture();
  const unevidenced = configuredFixture();
  try {
    git(incomplete, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () => withArchiveEligibility(incomplete, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASKS_INCOMPLETE'),
    );

    completeTasks(unevidenced);
    git(unevidenced, ['add', '.']);
    git(unevidenced, ['commit', '-m', 'Forge completion']);
    git(unevidenced, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () => withArchiveEligibility(unevidenced, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_EVIDENCE_MISSING'),
    );
  } finally {
    fs.rmSync(incomplete, { recursive: true, force: true });
    fs.rmSync(unevidenced, { recursive: true, force: true });
  }
});

test('archive eligibility rejects task evidence not reachable from configured base', () => {
  const repository = configuredFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    completeTasks(repository);
    commitTask(repository);

    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_COMMIT_UNREACHABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility rejects dirty state, active sessions, and lock collisions', () => {
  const dirty = completedFixture();
  const active = configuredFixture();
  const locked = completedFixture();
  try {
    fs.writeFileSync(path.join(dirty, 'dirty.txt'), 'dirty\n');
    assert.throws(
      () => withArchiveEligibility(dirty, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_WORKTREE_DIRTY'),
    );

    git(active, ['checkout', '-b', 'work/demo-change']);
    startSession(active, 'demo-change', '1.1');
    assert.throws(
      () => withArchiveEligibility(active, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ACTIVE_SESSION_CONFLICT'),
    );

    const lockDirectory = path.join(runtimeRoot(locked), 'locks');
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(lockDirectory, 'demo-change.lock'),
      '{"transition":"archive"}\n',
    );
    assert.throws(
      () => withArchiveEligibility(locked, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TRANSITION_CONFLICT'),
    );
  } finally {
    fs.rmSync(dirty, { recursive: true, force: true });
    fs.rmSync(active, { recursive: true, force: true });
    fs.rmSync(locked, { recursive: true, force: true });
  }
});

test('archive eligibility rejects strict-validation failures and unsafe targets', () => {
  const invalid = configuredFixture();
  const unsafeTarget = configuredFixture();
  try {
    fs.appendFileSync(
      path.join(invalid, 'openspec/changes/demo-change/proposal.md'),
      'INVALID\n',
    );
    completeTasks(invalid);
    commitTask(invalid);
    git(invalid, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () => withArchiveEligibility(invalid, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_INVALID'),
    );

    const baseSpec = path.join(unsafeTarget, 'openspec/specs/demo/spec.md');
    fs.mkdirSync(path.dirname(baseSpec), { recursive: true });
    fs.writeFileSync(baseSpec, '# Base spec\n');
    fs.chmodSync(baseSpec, 0o755);
    git(unsafeTarget, ['add', '.']);
    git(unsafeTarget, ['commit', '-m', 'Add unsafe archive target']);
    completeTasks(unsafeTarget);
    commitTask(unsafeTarget);
    git(unsafeTarget, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () =>
        withArchiveEligibility(unsafeTarget, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TARGET_UNSAFE'),
    );
  } finally {
    fs.rmSync(invalid, { recursive: true, force: true });
    fs.rmSync(unsafeTarget, { recursive: true, force: true });
  }
});

test('archive eligibility rejects an exact dated destination collision', () => {
  const repository = configuredFixture();
  try {
    fs.mkdirSync(
      path.join(repository, 'openspec/changes/archive/2026-07-15-demo-change'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        repository,
        'openspec/changes/archive/2026-07-15-demo-change/proposal.md',
      ),
      '# Archived\n',
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add colliding archive']);
    completeTasks(repository);
    commitTask(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);

    assert.throws(
      () =>
        withArchiveEligibility(
          repository,
          'demo-change',
          () => undefined,
          new Date('2026-07-15T12:00:00.000Z'),
        ),
      (error) => isWorkflowError(error, 'ARCHIVE_DESTINATION_COLLISION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility rejects pre-epoch task completions without current evidence', () => {
  const repository = configuredFixture();
  try {
    completeTasks(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Bootstrap completion']);
    commitPlanRevision(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_EVIDENCE_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility ignores a backdated parallel plan commit as epoch', () => {
  const repository = configuredFixture();
  try {
    commitPlanRevision(repository);
    completeTasks(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Forge completion after epoch']);
    git(repository, ['checkout', '-b', 'side/backdated-plan']);
    commitPlanRevision(repository, '2020-01-01T00:00:00Z');
    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--no-ff', '--no-edit', 'side/backdated-plan']);
    git(repository, ['checkout', '-b', 'work/archive-demo']);

    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_EVIDENCE_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility keeps canonical-era completions enforced', () => {
  const repository = configuredFixture();
  try {
    commitPlanRevision(repository);
    completeTasks(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Forge completion after epoch']);
    git(repository, ['checkout', '-b', 'work/archive-demo']);

    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_EVIDENCE_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility resolves the base from the protected remote-tracking ref', () => {
  const repository = configuredFixture();
  try {
    completeTasks(repository);
    commitTask(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);
    const integrationTip = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['update-ref', 'refs/remotes/origin/main', integrationTip]);
    // The local protected branch falls behind the remote-tracking ref.
    git(repository, ['branch', '-f', 'main', `${integrationTip}~1`]);

    const result = withArchiveEligibility(
      repository,
      'demo-change',
      (eligibility) => eligibility,
    );

    assert.equal(result.base, integrationTip);
    assert.equal(result.taskCommits.length, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive eligibility fails closed when the remote-tracking base is unresolvable', () => {
  const repository = completedFixture();
  try {
    git(repository, ['update-ref', '-d', 'refs/remotes/origin/main']);
    assert.throws(
      () => withArchiveEligibility(repository, 'demo-change', () => undefined),
      (error) => isWorkflowError(error, 'ARCHIVE_BASE_UNRESOLVED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function configuredFixture(): string {
  const repository = createFixtureRepository();
  prepareCurrentV3IntroductionFixture(repository, 'demo-change');
  writeReadyV3ExemptChange(repository);
  fs.chmodSync(runtimeRoot(repository), 0o700);
  git(repository, ['add', '.']);
  git(repository, [
    'commit',
    '-m',
    'Plan demo-change',
    '-m',
    'Change: demo-change\nTransition: plan',
  ]);
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', 'work/demo-change']);
  git(repository, ['branch', '-d', 'work/demo-change']);
  syncOriginMain(repository);
  return repository;
}

function completedFixture(): string {
  const repository = configuredFixture();
  completeTasks(repository);
  commitTask(repository);
  git(repository, ['checkout', '-b', 'work/archive-demo']);
  return repository;
}

function legacyCompletedFixture(): string {
  const repository = createFixtureRepository();
  completeTasks(repository);
  commitTask(repository);
  git(repository, ['checkout', '-b', 'work/archive-legacy-demo']);
  return repository;
}

function completeTasks(repository: string): void {
  const tasksPath = path.join(
    repository,
    'openspec/changes/demo-change/tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
  );
}

function commitTask(repository: string): void {
  const sourcePath = 'src/archive-fixture.ts';
  fs.writeFileSync(
    path.join(repository, sourcePath),
    'export const archiveFixture = true;\n',
  );
  git(repository, ['add', '.']);
  const baseCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(repository, ['rev-parse', 'HEAD^{tree}']).trim();
  const candidateTree = git(repository, ['write-tree']).trim();
  const tasksPath = 'openspec/changes/demo-change/tasks.md';
  const beforeObjectId = git(repository, [
    'rev-parse',
    `${baseCommit}:${tasksPath}`,
  ]).trim();
  const afterObjectId = git(repository, ['rev-parse', `:${tasksPath}`]).trim();
  const sourceObjectId = git(repository, [
    'rev-parse',
    `:${sourcePath}`,
  ]).trim();
  const documentationTransitions = [
    {
      path: sourcePath,
      before: null,
      after: { mode: '100644' as const, objectId: sourceObjectId },
    },
  ];
  const requirement = createTaskDiffDocumentationClosureRequirement({
    required: true,
    changeBaseCommit: baseCommit,
    changeBaseTree: baseTree,
    candidateTree,
    changedPaths: [sourcePath],
    patchDigest: sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'task-diff-documentation-change-patch.v1',
        transitions: documentationTransitions,
      }),
    ),
    hints: [],
  });
  const subject = createTaskDiffReviewSubject({
    repositoryId: 'github:fixture/jigwright-archive',
    changeId: 'demo-change',
    taskId: '1.1',
    baseCommit,
    baseTree,
    candidateTree,
    transitions: [
      {
        path: tasksPath,
        before: { mode: '100644', objectId: beforeObjectId },
        after: { mode: '100644', objectId: afterObjectId },
      },
      ...documentationTransitions,
    ],
    taskContractDigest: '1'.repeat(64),
    requiredCheckPolicyDigest: '2'.repeat(64),
    checkEvidenceDigest: '3'.repeat(64),
    planningGenerationId: '4'.repeat(64),
    planTargetDigest: '5'.repeat(64),
    planReviewNodeId: '6'.repeat(64),
    planningAssuranceDigest: '7'.repeat(64),
    reviewRequirement: {
      required: true,
      basis: 'explicit',
      riskPaths: [],
    },
    documentationRequirement: requirement,
  });
  const review = createTaskDiffReviewRecord({
    subject,
    assignment: {
      implementerPrincipalId: 'provider-b:implementer',
      implementerProviderId: 'provider-b',
      implementationSessionId: 'implementation-session-1',
      reviewerPrincipalId: 'provider-a:reviewer',
      reviewerProviderId: 'provider-a',
      reviewerSessionId: 'review-session-2',
      achievedIndependence: 'provider-independent',
      degradedForm: null,
      grantUseDigest: null,
    },
    submission: {
      schemaVersion: 1,
      verdict: 'advisory-approve',
      coverage: [...TASK_DIFF_REVIEW_COVERAGE],
      scopeAssessment: {
        kind: 'no-challenge',
        evidence: [
          {
            kind: 'repository-location',
            path: sourcePath,
            line: 1,
            blobObjectId: sourceObjectId,
            observation:
              'The exact implementation blob completes the current task.',
          },
        ],
      },
      findings: [],
      suggestions: [],
      riskPathDispositions: [],
      residualRisk: 'No release-blocking documentation risk remains.',
      uncertainty: 'Review is limited to the exact current task projection.',
      documentationAssessment: {
        decision: 'no-impact',
        notes:
          'The task projection changes no operator or product documentation.',
      },
    },
  });
  const closure = createDocumentationClosureRecord({
    changeId: 'demo-change',
    taskId: '1.1',
    review,
    finalAssurance: null,
    remediation: null,
    projectedCommitTree: candidateTree,
    projectionPaths: [tasksPath],
  });
  git(repository, [
    'commit',
    '-m',
    [
      'Complete demo task',
      '',
      encodeDocumentationClosure(closure),
      '',
      'Change: demo-change',
      'Task: 1.1',
    ].join('\n'),
  ]);
  syncOriginMain(repository);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function commitPlanRevision(repository: string, committerDate?: string): void {
  fs.appendFileSync(
    path.join(repository, 'openspec/changes/demo-change/design.md'),
    '\nEpoch revision.\n',
  );
  writeReadyV3ExemptChange(repository);
  git(repository, ['add', '.']);
  execFileSync(
    'git',
    [
      '-C',
      repository,
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: committerDate
        ? {
            ...process.env,
            GIT_AUTHOR_DATE: committerDate,
            GIT_COMMITTER_DATE: committerDate,
          }
        : process.env,
    },
  );
}
