import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commitArchiveTransition } from '../src/application/archive/archive-transition.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import {
  finalizeSession,
  finalizeTask,
} from '../src/application/finalize/lifecycle.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  beginTaskDiffReview,
  reconcileTaskDiffReview,
} from '../src/application/finalize/task-diff-review-lifecycle.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { validateCiArchiveCommit } from '../src/entrypoints/ci/ci-archive.ts';
import { verifyPullRequest } from '../src/entrypoints/ci/ci.ts';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import type { TaskDiffReviewSubmission } from '../src/modules/assurance/task-diff-review-artifact.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import {
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
  syncOriginMain,
  writeReadyV3ExemptChange,
} from './fixture.ts';

test('CI archive validation rejects a duplicate grant in base planning history', () => {
  const repository = createArchiveHistoryRepository();
  try {
    writeHistoricalPlanReviewGrant(repository, {
      grantId: '99999999-9999-4999-8999-999999999999',
      signedEnvelopeDigest: 'a'.repeat(64),
      transitionDigest: 'b'.repeat(64),
    });
    commitPlanClaim(repository);
    writeHistoricalPlanReviewGrant(repository, {
      grantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      signedEnvelopeDigest: 'd'.repeat(64),
      transitionDigest: 'e'.repeat(64),
    });
    commitHistory(repository, 'Record alternate planning evidence');
    writeHistoricalPlanReviewGrant(repository, {
      grantId: '99999999-9999-4999-8999-999999999999',
      signedEnvelopeDigest: 'a'.repeat(64),
      transitionDigest: 'b'.repeat(64),
    });
    commitPlanClaim(repository);
    git(repository, [
      'commit',
      '--allow-empty',
      '-m',
      'Archive demo-change',
      '-m',
      'Change: demo-change\nTransition: archive',
    ]);
    const archiveCommit = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiArchiveCommit(repository, archiveCommit, 'demo-change'),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_DUPLICATE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays an archive from Git without trusting local runtime evidence', () => {
  const fixture = archivedFixture();
  try {
    fs.rmSync(runtimeRoot(fixture.repository), {
      recursive: true,
      force: true,
    });

    const result = verifyPullRequest(
      fixture.repository,
      fixture.base,
      fixture.head,
    );

    assert.deepEqual(result.commits, [fixture.head]);
    assert.deepEqual(result.archivedChanges, ['demo-change']);
    assert.equal(result.runtimeReportsTrusted, false);
    assert.deepEqual(
      result.checks.map(({ checkId }) => checkId),
      ['fixture'],
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI archive replay normalizes only the UTC date directory', () => {
  const fixture = archivedFixture();
  try {
    const originalPath = path.join(fixture.repository, fixture.archivePath);
    const crossDatePath = path.join(
      fixture.repository,
      'openspec/changes/archive/2099-12-31-demo-change',
    );
    fs.renameSync(originalPath, crossDatePath);
    git(fixture.repository, ['add', '-A']);
    git(fixture.repository, ['commit', '--amend', '--no-edit']);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    const result = verifyPullRequest(fixture.repository, fixture.base, head);

    assert.deepEqual(result.archivedChanges, ['demo-change']);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects an archive commit whose diff mixes unrelated evidence', () => {
  const fixture = archivedFixture();
  try {
    fs.writeFileSync(path.join(fixture.repository, 'mixed.txt'), 'mixed\n');
    git(fixture.repository, ['add', '.']);
    git(fixture.repository, ['commit', '--amend', '--no-edit']);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'CI_ARCHIVE_REPLAY_MISMATCH'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects an archive with silently changed promoted content', () => {
  const fixture = archivedFixture();
  try {
    fs.appendFileSync(
      path.join(fixture.repository, 'openspec/specs/demo/spec.md'),
      '\nUnverified mutation.\n',
    );
    git(fixture.repository, ['add', '.']);
    git(fixture.repository, ['commit', '--amend', '--no-edit']);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'CI_ARCHIVE_REPLAY_MISMATCH'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects mixed task and archive trailer forms even when hooks are bypassed', () => {
  const fixture = archivedFixture();
  try {
    git(fixture.repository, [
      'commit',
      '--amend',
      '-m',
      'Archive demo-change',
      '-m',
      'Change: demo-change\nTask: 1.1\nTransition: archive',
    ]);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'CI_INVALID_MANAGED_TRAILERS'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects pinned dependency drift before archive replay', () => {
  const fixture = archivedFixture();
  try {
    const manifestPath = path.join(fixture.repository, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.devDependencies['@fission-ai/openspec'] = '^1.6.0';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const head = amendArchive(fixture.repository);

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'OPENSPEC_INSTALLATION_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects reviewed schema drift before archive replay', () => {
  const fixture = archivedFixture();
  try {
    const currentSchemaName = (
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.repository, 'workflow/repository-consumer.json'),
          'utf8',
        ),
      ) as { planning: { currentSchemaName: string } }
    ).planning.currentSchemaName;
    fs.appendFileSync(
      path.join(
        fixture.repository,
        'openspec/schemas',
        currentSchemaName,
        'schema.yaml',
      ),
      '\n# drift\n',
    );
    const head = amendArchive(fixture.repository);

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'OPENSPEC_SCHEMA_CONTRACT_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI regeneration fails closed when the OpenSpec asset manifest is missing or renamed', async (t) => {
  for (const operation of ['missing', 'renamed'] as const) {
    await t.test(operation, () => {
      const fixture = archivedFixture();
      try {
        const manifestPath = path.join(
          fixture.repository,
          'workflow/openspec-assets/manifest.json',
        );
        if (operation === 'missing') {
          fs.rmSync(manifestPath);
        } else {
          fs.renameSync(
            manifestPath,
            path.join(path.dirname(manifestPath), 'manifest.retired.json'),
          );
        }
        const head = amendArchive(fixture.repository);
        assert.throws(
          () => verifyPullRequest(fixture.repository, fixture.base, head),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_MANIFEST_INVALID'),
        );
      } finally {
        fs.rmSync(fixture.repository, { recursive: true, force: true });
      }
    });
  }
});

test('CI rejects forbidden generated lifecycle authority when hooks are bypassed', () => {
  const fixture = archivedFixture();
  try {
    fs.appendFileSync(
      path.join(fixture.repository, '.claude/skills/openspec-explore/SKILL.md'),
      '\nopenspec archive demo-change\n',
    );
    const head = amendArchive(fixture.repository);

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'OPENSPEC_ASSET_FORBIDDEN_AUTHORITY'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('current archive rejects pre-epoch task completions without current evidence', () => {
  const repository = createFixtureRepository();
  try {
    const deltaPath = path.join(
      repository,
      'openspec/changes/demo-change/specs/demo/spec.md',
    );
    fs.writeFileSync(deltaPath, addedDelta());
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Configure archive fixture']);

    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Bootstrap completion']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nEpoch revision.\n',
    );
    writeReadyV3ExemptChange(repository);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    syncOriginMain(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);
    assert.throws(
      () => commitArchiveTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'ARCHIVE_TASK_EVIDENCE_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function archivedFixture(): {
  repository: string;
  base: string;
  head: string;
  archivePath: string;
} {
  const repository = createFixtureRepository();
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/path-roles.json'),
    path.join(repository, 'workflow/path-roles.json'),
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  git(repository, [
    'add',
    'workflow/path-roles.json',
    'workflow/maintainer-policy.json',
  ]);
  git(repository, ['commit', '-m', 'Configure review policies']);
  syncOriginMain(repository);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  const deltaPath = path.join(
    repository,
    'openspec/changes/demo-change/specs/demo/spec.md',
  );
  fs.writeFileSync(deltaPath, addedDelta());
  writeReadyV3ExemptChange(repository);
  fs.chmodSync(runtimeRoot(repository), 0o700);
  commitPlanningTransition(repository, 'demo-change');
  const session = startSession(repository, 'demo-change', '1.1');
  fs.writeFileSync(
    path.join(repository, 'src/feature.ts'),
    'export const feature = "archived";\n',
  );
  assert.throws(
    () =>
      finalizeTask(repository, session.sessionId, process.env, {
        testCrashAfter: 'checked',
      }),
    /Simulated finalize interruption/,
  );
  const prepared = beginTaskDiffReview(repository, session.sessionId, {
    explicitActor: 'codex',
    environment: {},
  });
  assert.equal(prepared.state, 'waiting-for-provider');
  const sourceObjectId = prepared.subject.transitions.find(
    ({ path: changedPath }) => changedPath === 'src/feature.ts',
  )?.after?.objectId;
  assert.ok(sourceObjectId);
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
          blobObjectId: sourceObjectId,
          observation:
            'The exact archive fixture implements the reviewed task.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions: prepared.subject.reviewRequirement.riskPaths.map(
      ({ path: riskPath, role }) => ({
        path: riskPath,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'no-challenge' as const,
      }),
    ),
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact archive fixture candidate.',
    documentationAssessment: {
      decision: 'no-impact',
      notes:
        'The fixture changes no product or operator documentation contract.',
    },
  };
  const providerResult = runProviderWorker(repository, prepared.invocationId, {
    runner(input) {
      return {
        invocationId: prepared.invocationId,
        providerId: 'claude',
        purpose: 'task-diff-review',
        requestDigest: input.request.requestDigest,
        semanticOutput: submission,
        semanticOutputDigest: sha256(canonicalJson(submission)),
        assurance: 'unchanged-governed-projection',
        projection: {
          unchanged: true,
          changedCategories: [],
          beforeDigest: prepared.subject.subjectDigest,
          afterDigest: prepared.subject.subjectDigest,
        },
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: builtInProviderExecutableIdentityForTest('claude'),
        elapsedMs: 8,
        providerDefinitionSnapshot:
          builtInProviderDefinitionSnapshotForTest('claude'),
      };
    },
  });
  assert.equal(providerResult.state, 'succeeded');
  assert.equal(
    reconcileTaskDiffReview(repository, session.sessionId).state,
    'satisfied',
  );
  const completed = finalizeSession(
    repository,
    session.sessionId,
    'Complete archive fixture',
  );
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', completed.commitHash]);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  syncOriginMain(repository);
  git(repository, ['checkout', '-b', 'work/archive-demo']);
  const archived = commitArchiveTransition(repository, 'demo-change');
  return {
    repository,
    base,
    head: archived.commitHash,
    archivePath: archived.archivePath,
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
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

function amendArchive(repository: string): string {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '--amend', '--no-edit']);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function createArchiveHistoryRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-ci-archive-history-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  fs.mkdirSync(path.join(repository, 'workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'workflow/config.json'),
    `${canonicalJson({
      schemaVersion: 1,
      repositoryName: 'fixture',
      changeRoot: 'openspec/changes',
      runtimeDirectory: 'workflow-engine',
      protectedBranches: ['main', 'master'],
      branchTemplate: 'work/{changeId}',
    })}\n`,
  );
  commitHistory(repository, 'Create archive history fixture');
  return repository;
}

function writeHistoricalPlanReviewGrant(
  repository: string,
  grantUse: {
    grantId: string;
    signedEnvelopeDigest: string;
    transitionDigest: string;
  },
): void {
  const reviewNode = createEvidenceNode({
    type: 'fixture-plan-review',
    nodeSchema: 'fixture.plan-review.v1',
    evaluator: 'fixture.plan-review.v1',
    policyDigest: '1'.repeat(64),
    exactInputDigests: { target: '2'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.plan-review-output.v1',
    output: { verdict: 'advisory-approve' },
    runtimeMetadata: {},
  });
  const artifactPath = path.join(
    repository,
    'openspec/changes/demo-change/plan-review.json',
  );
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'plan-review-artifact',
      changeId: 'demo-change',
      nodes: [reviewNode],
      currentRefs: { planReview: reviewNode.nodeId },
      roleResults: [{ grantUse }],
    })}\n`,
  );
}

function commitPlanClaim(repository: string): void {
  git(repository, ['add', '-A']);
  git(repository, [
    'commit',
    '-m',
    'Plan demo-change',
    '-m',
    'Change: demo-change\nTransition: plan',
  ]);
}

function commitHistory(repository: string, message: string): void {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', message]);
}
