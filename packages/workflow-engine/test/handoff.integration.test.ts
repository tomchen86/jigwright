import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import {
  productionChangeRoutingInspector,
  productionChangeRoutingAdmissionReader,
} from '../src/composition-root/change-routing-observation-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const renderHandoff = renderHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
const validateHandoff = validateHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  renderHandoff as renderHandoffWithContractReader,
  validateHandoff as validateHandoffWithContractReader,
} from '../src/adapters/consumer/repository/handoff/handoff.ts';
import { validateRepositoryStateAtCommit } from '../src/composition-root/repository-validation.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import { readSystemDescriptionSnapshot } from '../src/runtime/repository-transaction/system-description-snapshot.ts';
import { validateManagedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { finalizeTask } from '../src/composition-root/finalization-production.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  renderWorkRegistry,
  workItemDigest,
} from '../src/composition-root/work-registry-production.ts';
import {
  createFixtureRepository as createBareFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';
import {
  applyChangeRoutingReview,
  prepareChangeRoutingReview,
} from '../src/composition-root/change-routing-production.ts';

const cliPath = path.join(
  sourceRepositoryRoot,
  'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
);

function createFixtureRepository(): string {
  const repository = createBareFixtureRepository();
  writeReadyV3ExemptChange(repository);
  return repository;
}

test('generated handoff rejects direct edits and resolves colocated references from tracked facts', () => {
  for (const routed of [false, true]) {
    const repository = createFixtureRepository();
    try {
      fs.writeFileSync(
        path.join(repository, 'workflow/document-policy.json'),
        `${JSON.stringify({ schemaVersion: 1, enforcementMode: 'enforced', documents: { 'docs/CURRENT_AND_NEXT_STEPS.md': { mode: 'generated', enforcement: 'active', transition: 'completion' } } }, null, 2)}\n`,
      );
      const mapPath = path.join(repository, 'docs/SPEC_MAP.md');
      fs.mkdirSync(path.dirname(mapPath), { recursive: true });
      fs.writeFileSync(
        mapPath,
        '# Specification map\n\nFixture tracked contract index.\n',
      );
      if (routed)
        applyChangeRoutingReview(
          repository,
          prepareChangeRoutingReview(repository, {
            schemaVersion: 1,
            action: { kind: 'focus', changeId: 'demo-change' },
          }),
        );
      const projected = renderHandoff(repository);
      assert.match(projected, /\[Base specifications\]\(SPEC_MAP\.md\)/u);
      assert.doesNotMatch(projected, /\.\.\/openspec\/specs\//u);
      assert.deepEqual(validateManagedDocuments(repository), [
        'docs/CURRENT_AND_NEXT_STEPS.md',
      ]);
      const handoffPath = path.join(
        repository,
        'docs/CURRENT_AND_NEXT_STEPS.md',
      );
      const edited = `${projected}\nDirect edit outside the projection.\n`;
      fs.writeFileSync(handoffPath, edited);
      assert.throws(() => validateManagedDocuments(repository), {
        code: 'HANDOFF_DRIFT',
      });
      assert.equal(fs.readFileSync(handoffPath, 'utf8'), edited);
      assert.equal(renderHandoff(repository), projected);
      validateHandoff(repository);
      git(repository, ['add', '-A']);
      git(repository, [
        'commit',
        '-m',
        'Record generated handoff with specification map',
      ]);
      const commit = git(repository, ['rev-parse', 'HEAD']).trim();
      assert.deepEqual(
        validateRepositoryStateAtCommit(repository, commit).documents,
        ['docs/CURRENT_AND_NEXT_STEPS.md'],
      );
      const snapshot = readSystemDescriptionSnapshot(repository, commit);
      const contract = loadChangeContract(repository, 'demo-change');
      fs.rmSync(mapPath);
      validateHandoff(repository, {
        contracts: [{ changeId: contract.changeId, tasks: contract.tasks }],
        readText: (file) => snapshot.readText(file),
      });
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('current Work Registry handoff ignores poisoned legacy Issue data', () => {
  const repository = createFixtureRepository();
  try {
    const blocker = createWorkItem(
      repository,
      {
        schemaVersion: 1,
        kind: 'chore',
        lane: 'next',
        title: 'Resolve the registry prerequisite',
        summary: 'The current intake view must preserve this blocker.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T05:00:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000B',
      },
    ).item;
    const dependent = createWorkItem(
      repository,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Blocked registry delivery',
        summary: 'Expose the unresolved Work Item in the handoff.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T05:01:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000C',
      },
    ).item;
    const acceptedBlocker = applyWorkItemReview(
      repository,
      blocker.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(blocker),
        summary: blocker.interpretation.summary,
      },
      () => '2026-08-24T05:02:00.000Z',
    );
    const acceptedDependent = applyWorkItemReview(
      repository,
      dependent.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(dependent),
        summary: dependent.interpretation.summary,
      },
      () => '2026-08-24T05:03:00.000Z',
    );
    applyWorkItemReview(
      repository,
      dependent.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(acceptedDependent),
        lane: 'next',
        blockedBy: [acceptedBlocker.id],
      },
      () => '2026-08-24T05:04:00.000Z',
    );
    renderWorkRegistry(repository);
    const legacyIssuePath = path.join(repository, 'docs/issues/issues.yaml');
    const poisonedLegacyIssueBytes =
      '{"schemaVersion":1,"poisonedLegacyIssue":"ISS-999"}\n';
    fs.mkdirSync(path.dirname(legacyIssuePath), { recursive: true });
    fs.writeFileSync(legacyIssuePath, poisonedLegacyIssueBytes);
    fs.chmodSync(legacyIssuePath, 0o640);

    const handoff = renderHandoff(repository);
    assert.match(handoff, /Git-native Work Registry/);
    assert.match(handoff, /Blocked registry delivery/);
    assert.match(handoff, /\[Work backlog\]\(BACKLOG\.md\)/);
    assert.doesNotMatch(handoff, /\bISS-[0-9]+\b/u);
    assert.doesNotMatch(handoff, /structured issue data/u);
    assert.doesNotMatch(handoff, /\[Issue log\]/u);
    assert.equal(
      fs.readFileSync(legacyIssuePath, 'utf8'),
      poisonedLegacyIssueBytes,
    );
    assert.equal(fs.statSync(legacyIssuePath).mode & 0o777, 0o640);
    validateHandoff(repository);

    const validated = spawnSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, 'handoff', 'validate', '--json'],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(validated.status, 0, validated.stderr);
    assert.deepEqual(
      (JSON.parse(validated.stdout) as { intakeCounts: unknown }).intakeCounts,
      { schemaVersion: 1, inbox: 0, pendingFindings: 0, backlog: 2 },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed managed-document validation replays a v3 handoff without private runtime', () => {
  const repository = createFixtureRepository();
  try {
    const policyPath = path.join(repository, 'workflow/document-policy.json');
    fs.writeFileSync(
      policyPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/CURRENT_AND_NEXT_STEPS.md': {
              mode: 'generated',
              enforcement: 'active',
              transition: 'completion',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeReadyV3ExemptChange(repository);
    renderHandoff(repository);
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Record committed managed documents']);
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.rmSync(runtimeRoot(repository), { recursive: true, force: true });

    assert.deepEqual(validateRepositoryStateAtCommit(repository, commit), {
      repositoryRoot: fs.realpathSync(repository),
      changes: ['demo-change'],
      documents: ['docs/CURRENT_AND_NEXT_STEPS.md'],
    });
    assert.throws(() => validateManagedDocuments(repository), {
      code: 'REVIEW_TARGET_STALE',
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed managed-document validation replays a terminal handoff with zero active changes', () => {
  const repository = createFixtureRepository();
  try {
    const changeRoot = path.join(repository, 'openspec/changes');
    const archiveRoot = path.join(changeRoot, 'archive');
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.renameSync(
      path.join(changeRoot, 'demo-change'),
      path.join(archiveRoot, '2026-08-22-demo-change'),
    );
    fs.writeFileSync(
      path.join(repository, 'workflow/document-policy.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/CURRENT_AND_NEXT_STEPS.md': {
              mode: 'generated',
              enforcement: 'active',
              transition: 'completion',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    renderHandoff(repository);
    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Record terminal handoff without active changes',
    ]);
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.rmSync(runtimeRoot(repository), { recursive: true, force: true });

    assert.deepEqual(validateRepositoryStateAtCommit(repository, commit), {
      repositoryRoot: fs.realpathSync(repository),
      changes: [],
      documents: ['docs/CURRENT_AND_NEXT_STEPS.md'],
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed repository validation rejects a configured change root absent from the commit tree', () => {
  const repository = createFixtureRepository();
  try {
    const changeRoot = path.join(repository, 'openspec/changes');
    const archiveRoot = path.join(changeRoot, 'archive');
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.renameSync(
      path.join(changeRoot, 'demo-change'),
      path.join(archiveRoot, '2026-08-22-demo-change'),
    );
    renderHandoff(repository);
    const configPath = path.join(repository, 'workflow/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        { ...config, changeRoot: 'openspec/missing-changes' },
        null,
        2,
      )}\n`,
    );
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Point at a missing change root']);
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(() => validateRepositoryStateAtCommit(repository, commit), {
      code: 'CI_COMMITTED_CHECKOUT_INVALID',
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('zero-change committed validation rejects an ignored workflow check absent from the commit tree', () => {
  const repository = createFixtureRepository();
  try {
    const changeRoot = path.join(repository, 'openspec/changes');
    const archiveRoot = path.join(changeRoot, 'archive');
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.renameSync(
      path.join(changeRoot, 'demo-change'),
      path.join(archiveRoot, '2026-08-22-demo-change'),
    );
    renderHandoff(repository);
    const checksPath = 'workflow/checks.json';
    git(repository, ['rm', '--cached', '--', checksPath]);
    fs.appendFileSync(path.join(repository, '.gitignore'), `/${checksPath}\n`);
    git(repository, ['add', '--', '.gitignore', 'openspec', 'docs']);
    git(repository, [
      'commit',
      '-m',
      'Hide an uncommitted workflow check registry',
    ]);
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(
      git(repository, ['status', '--porcelain=v1', '--untracked-files=all']),
      '',
    );

    assert.throws(() => validateRepositoryStateAtCommit(repository, commit), {
      code: 'CI_COMMITTED_CHECKOUT_INVALID',
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed managed-document validation ignores checkout-only changes', () => {
  const repository = createFixtureRepository();
  try {
    fs.writeFileSync(
      path.join(repository, 'workflow/document-policy.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/CURRENT_AND_NEXT_STEPS.md': {
              mode: 'generated',
              enforcement: 'active',
              transition: 'completion',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeReadyV3ExemptChange(repository);
    renderHandoff(repository);
    fs.appendFileSync(
      path.join(repository, '.gitignore'),
      '/openspec/changes/fake-change/\n',
    );
    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Record committed managed-document projection',
    ]);
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.rmSync(runtimeRoot(repository), { recursive: true, force: true });

    writeChange(repository, 'fake-change', false);
    assert.equal(
      git(repository, ['status', '--porcelain=v1', '--untracked-files=all']),
      '',
    );

    assert.deepEqual(validateRepositoryStateAtCommit(repository, commit), {
      repositoryRoot: fs.realpathSync(repository),
      changes: ['demo-change'],
      documents: ['docs/CURRENT_AND_NEXT_STEPS.md'],
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('repository handoff has exactly six semantic sections and no hashes', () => {
  const repository = createFixtureRepository();
  try {
    renderHandoff(repository);
    validateHandoff(repository);
    const handoff = fs.readFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'utf8',
    );
    assert.deepEqual(
      [...handoff.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
      [
        'Current Change',
        'Current Task',
        'Next Task',
        'Current Focus',
        'Known Blockers',
        'References',
      ],
    );
    assert.doesNotMatch(handoff, /\b[0-9a-f]{40,64}\b/i);
    assert.doesNotMatch(handoff, /session-[A-Za-z0-9-]+/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion projection refreshes the handoff to no active change', () => {
  const repository = createFixtureRepository();
  try {
    const policyPath = path.join(repository, 'workflow/document-policy.json');
    fs.writeFileSync(
      policyPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/CURRENT_AND_NEXT_STEPS.md': {
              mode: 'generated',
              enforcement: 'active',
              transition: 'completion',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      path.join(repository, 'workflow/maintainer-policy.json'),
    );
    renderHandoff(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Enable generated handoff']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(repository, session.sessionId);
    finalizeTask(repository, session.sessionId);

    const handoff = fs.readFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'utf8',
    );
    assert.match(handoff, /## Current Change\n\nNone\./);
    assert.match(handoff, /## Current Task\n\nNone — no active change\./);
    validateHandoff(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('final completion renders an explicit no-active-change handoff', () => {
  const repository = createFixtureRepository();
  try {
    writeCompletedChange(repository, 'older-completed-change');
    const policyPath = path.join(repository, 'workflow/document-policy.json');
    fs.writeFileSync(
      policyPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/CURRENT_AND_NEXT_STEPS.md': {
              mode: 'generated',
              enforcement: 'active',
              transition: 'completion',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      path.join(repository, 'workflow/maintainer-policy.json'),
    );
    renderHandoff(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add completed change and handoff']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(repository, session.sessionId);
    assert.doesNotThrow(() => finalizeTask(repository, session.sessionId));
    const handoff = fs.readFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'utf8',
    );
    assert.match(handoff, /## Current Change\n\nNone\./);
    assert.match(handoff, /## Current Task\n\nNone — no active change\./);
    validateHandoff(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reserved OpenSpec archive directory is not an active change', () => {
  const repository = createFixtureRepository();
  try {
    fs.mkdirSync(path.join(repository, 'openspec/changes/archive'));

    const handoff = renderHandoff(repository);

    assert.match(handoff, /## Current Change\n\n`demo-change`/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('handoff ignores its previous output and selects the sole active change', () => {
  const repository = createFixtureRepository();
  try {
    completeExistingChange(repository, 'demo-change');
    writeChange(repository, 'selected-completed-change', true);
    writeChange(repository, 'another-active-change', false);
    writeSelectedHandoff(repository, 'selected-completed-change');

    const beforeArchive = renderHandoff(repository);
    archiveChange(repository, 'selected-completed-change', '2026-07-17');
    const afterArchive = renderHandoff(repository);

    assert.equal(afterArchive, beforeArchive);
    assert.match(afterArchive, /## Current Change\n\n`another-active-change`/);
    validateHandoff(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('handoff selection is stable when another work branch is checked out', () => {
  const repository = createFixtureRepository();
  try {
    completeExistingChange(repository, 'demo-change');
    writeChange(repository, 'selected-completed-change', true);
    archiveChange(repository, 'selected-completed-change', '2026-07-17');
    writeChange(repository, 'branch-selected-change', false);
    writeSelectedHandoff(repository, 'selected-completed-change');
    git(repository, ['checkout', '-b', 'work/branch-selected-change']);

    const handoff = renderHandoff(repository);

    assert.match(handoff, /## Current Change\n\n`branch-selected-change`/);
    validateHandoff(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a work branch cannot resolve an otherwise ambiguous handoff', () => {
  const repository = createFixtureRepository();
  try {
    writeChange(repository, 'another-active-change', false);
    git(repository, ['checkout', '-b', 'work/another-active-change']);

    assert.throws(() => renderHandoff(repository), {
      code: 'HANDOFF_CHANGE_AMBIGUOUS',
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('no active changes render an explicit state independent of prior handoff bytes', () => {
  const repository = createFixtureRepository();
  try {
    completeExistingChange(repository, 'demo-change');
    writeChange(repository, 'selected-completed-change', true);
    archiveChange(repository, 'selected-completed-change', '2026-07-17');
    writeSelectedHandoff(repository, 'selected-completed-change');

    const handoff = renderHandoff(repository);

    assert.match(handoff, /## Current Change\n\nNone\./);
    assert.match(handoff, /## Current Task\n\nNone — no active change\./);
    assert.doesNotMatch(handoff, /selected-completed-change/);
    validateHandoff(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function writeCompletedChange(repository: string, changeId: string): void {
  writeChange(repository, changeId, true);
}

function completeExistingChange(repository: string, changeId: string): void {
  const tasksPath = path.join(
    repository,
    'openspec/changes',
    changeId,
    'tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace(/- \[ \]/g, '- [x]'),
  );
}

function writeChange(
  repository: string,
  changeId: string,
  completed: boolean,
): void {
  const directory = path.join(repository, 'openspec/changes', changeId);
  fs.mkdirSync(path.join(directory, 'specs/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, '.openspec.yaml'),
    'schema: spec-driven\ncreated: 2026-07-15\n',
  );
  fs.writeFileSync(path.join(directory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(directory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(directory, 'tasks.md'),
    `# Tasks\n\n- [${completed ? 'x' : ' '}] 1.1 ${
      completed ? 'Completed' : 'Pending'
    } task\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'specs/demo/spec.md'),
    '# Delta\n\n## ADDED Requirements\n\n### Requirement: Handoff fixture\n\nThe handoff SHALL represent the current change.\n\n#### Scenario: Current change is selected\n\n- **WHEN** the handoff is rendered\n- **THEN** the current change is selected\n',
  );
  fs.writeFileSync(
    path.join(directory, 'guard.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['src/**'],
            requiredChecks: ['fixture'],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeReadyV3ExemptChange(repository, changeId);
}

function writeSelectedHandoff(repository: string, changeId: string): void {
  const filePath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `# Existing handoff\n\n## Current Change\n\n\`${changeId}\`\n`,
  );
}

function archiveChange(
  repository: string,
  changeId: string,
  date: string,
): void {
  const changeRoot = path.join(repository, 'openspec/changes');
  const archiveRoot = path.join(changeRoot, 'archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.renameSync(
    path.join(changeRoot, changeId),
    path.join(archiveRoot, `${date}-${changeId}`),
  );
}

function prepareCurrentV3Change(repository: string): void {
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
}
