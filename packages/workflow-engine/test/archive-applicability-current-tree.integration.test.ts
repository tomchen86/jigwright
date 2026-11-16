import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const commitPlanAmendment = commitPlanAmendmentWithContractReader.bind(
  undefined,
  productionPlanningExecution,
  managedDocuments,
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
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  commitPlanAmendment as commitPlanAmendmentWithContractReader,
  commitPlanningTransition as commitPlanningTransitionWithContractReader,
} from '../src/runtime/planning-transition/planning-transition.ts';
import {
  createPlanningAmendmentDecision,
  replacePlanningAmendmentDecisionMarker,
} from '../src/modules/lifecycle/planning-amendment-decision.ts';
import { committedPlanningGeneration } from '../src/runtime/repository-transaction/planning-generation-history.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  syncOriginMain,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { commitCurrentFixtureTask } from './support/task-diff-review-fixture.ts';

const BASE_SPEC_PATH = 'openspec/specs/demo/spec.md';
const DELTA_SPEC_PATH = 'openspec/changes/demo-change/specs/demo/spec.md';

test('a proposal-only plan revision records provenance for every current delta spec', () => {
  const repository = createCurrentDeltaFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nFirst reviewed planning revision.\n',
    );
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');

    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nSecond reviewed planning revision.\n',
    );
    writeReadyV3ExemptChange(repository);
    const result = commitPlanningTransition(repository, 'demo-change');
    assert.equal(result.archiveApplicability.status, 'passed');
    if (result.archiveApplicability.status !== 'passed') {
      assert.fail('Current planning transition did not run the preflight.');
    }
    assert.equal(
      result.archiveApplicability.validatorVersion,
      'spec-delta-preflight-v3-public-archive',
    );

    assert.match(
      result.archiveApplicability.validatedBaseSpecDigests[BASE_SPEC_PATH] ??
        '',
      /^[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      Object.keys(result.archiveApplicability.validatedBaseSpecDigests).sort(),
      [BASE_SPEC_PATH],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a proposal-only plan revision fails closed when an unchanged current delta no longer applies', () => {
  const repository = createCurrentDeltaFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nInitial governed planning generation.\n',
    );
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    removeCurrentBaseSpec(repository);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/proposal.md'),
      '\nRevision after base drift.\n',
    );
    writeReadyV3ExemptChange(repository);
    const before = repositoryState(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error: unknown) => isWorkflowError(error, 'SPEC_DELTA_NOT_APPLICABLE'),
    );
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('amend-plan replays an unchanged current delta instead of recording an empty pass', () => {
  const repository = createCurrentDeltaFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    completeTask(repository);
    removeCurrentBaseSpec(repository);
    prepareReviewedCorrection(repository);
    const before = repositoryState(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'archive-applicability-failure',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'SPEC_DELTA_NOT_APPLICABLE'),
    );
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('amend-plan executes the pinned public OpenSpec archive projection', () => {
  const repository = createCurrentDeltaFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');
    completeTask(repository);
    prepareReviewedCorrection(repository);

    assert.throws(
      () =>
        commitPlanAmendment(
          repository,
          'demo-change',
          {
            reason: 'archive-applicability-failure',
            executionImpact: 'none',
          },
          process.env,
          {
            aroundArchiveApplicability: (invoke) =>
              withRejectedPublicArchive(repository, invoke),
          },
        ),
      (error: unknown) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createCurrentDeltaFixture(): string {
  const repository = createFixtureRepository();
  removeLegacyFixtureChange(repository);
  fs.mkdirSync(path.join(repository, 'openspec/specs/demo'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, BASE_SPEC_PATH),
    [
      '# Demo',
      '',
      '### Requirement: Existing behavior',
      '',
      'The existing behavior remains specified.',
      '',
      '#### Scenario: Existing behavior succeeds',
      '',
      '- **THEN** the behavior succeeds',
      '',
    ].join('\n'),
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Configure current delta fixture']);
  syncOriginMain(repository);
  writeFixtureChangeSkeleton(repository);
  fs.writeFileSync(
    path.join(repository, DELTA_SPEC_PATH),
    [
      '# Delta',
      '',
      '## MODIFIED Requirements',
      '',
      '### Requirement: Existing behavior',
      '',
      'The existing behavior has reviewed wording.',
      '',
      '#### Scenario: Existing behavior succeeds',
      '',
      '- **THEN** the behavior succeeds',
      '',
    ].join('\n'),
  );
  return repository;
}

function removeLegacyFixtureChange(repository: string): void {
  fs.rmSync(path.join(repository, 'openspec/changes/demo-change'), {
    recursive: true,
    force: true,
  });
  fs.rmSync(
    path.join(repository, 'workflow/change-providers/demo-change.json'),
    { force: true },
  );
  fs.mkdirSync(path.join(repository, 'openspec/changes'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(repository, 'openspec/changes/.gitkeep'), '');
}

function writeFixtureChangeSkeleton(repository: string): void {
  const changeDirectory = path.join(repository, 'openspec/changes/demo-change');
  fs.mkdirSync(path.join(changeDirectory, 'specs/demo'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(changeDirectory, 'proposal.md'), '# Proposal\n');
  fs.writeFileSync(path.join(changeDirectory, 'design.md'), '# Design\n');
  fs.writeFileSync(
    path.join(changeDirectory, 'tasks.md'),
    '# Tasks\n\n- [ ] 1.1 Demo task\n',
  );
  fs.writeFileSync(
    path.join(changeDirectory, 'guard.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId: 'demo-change',
        tasks: {
          '1.1': { allowedPaths: ['src/**'], requiredChecks: ['fixture'] },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.mkdirSync(path.join(repository, 'workflow/change-providers'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, 'workflow/change-providers/demo-change.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId: 'demo-change',
        providerId: 'openspec',
        adapterContractVersion: 1,
        providerRequirement: {
          package: '@fission-ai/openspec',
          version: '1.6.0',
        },
        planningRoot: 'openspec/changes/demo-change',
      },
      null,
      2,
    )}\n`,
  );
}

function removeCurrentBaseSpec(repository: string): void {
  git(repository, ['rm', '--quiet', '--', BASE_SPEC_PATH]);
  git(repository, ['commit', '-m', 'Simulate current base drift']);
}

function completeTask(repository: string): void {
  commitCurrentFixtureTask(repository);
}

function prepareReviewedCorrection(repository: string): void {
  const proposalPath = path.join(
    repository,
    'openspec/changes/demo-change/proposal.md',
  );
  const amendsPlanningGeneration = committedPlanningGeneration(
    repository,
    'HEAD',
    'openspec/changes',
    'demo-change',
  );
  assert.notEqual(amendsPlanningGeneration, null);
  const decision = createPlanningAmendmentDecision({
    reason: 'archive-applicability-failure',
    executionImpact: 'none',
    rationale:
      'The correction restores archive applicability without invalidating completed execution.',
    amendsPlanningGeneration: amendsPlanningGeneration!,
  });
  fs.writeFileSync(
    proposalPath,
    replacePlanningAmendmentDecisionMarker(
      `${fs.readFileSync(proposalPath, 'utf8').trimEnd()}\n\nReviewed archive correction.\n`,
      decision,
    ),
  );
  writeReadyV3ExemptChange(repository);
}

function withRejectedPublicArchive<T>(repository: string, action: () => T): T {
  const executable = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const source = fs.readFileSync(executable, 'utf8');
  const archiveBranch = "if (process.argv[2] === 'archive') {";
  assert.equal(source.includes(archiveBranch), true);
  const rejected = source.replace(
    archiveBranch,
    `${archiveBranch}\n  process.stderr.write('public amendment archive projection invoked');\n  process.exit(23);\n}\n${archiveBranch}`,
  );
  fs.writeFileSync(executable, rejected);
  try {
    return action();
  } finally {
    fs.writeFileSync(executable, source);
  }
}

function repositoryState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
  };
}
