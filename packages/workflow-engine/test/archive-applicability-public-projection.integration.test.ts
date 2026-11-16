import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
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

import { validateCiPlanningCommit } from '../src/composition-root/ci-replay-production.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/runtime/planning-transition/planning-transition.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  writeReadyV3ExemptChange,
} from './fixture.ts';

test('plan applicability executes the pinned public OpenSpec archive projection', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nPublic archive projection is required.\n',
    );
    writeReadyV3ExemptChange(repository);
    rejectPublicArchive(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan applicability preserves SHA-256 Git object identity', () => {
  const repository = createFixtureRepository({ objectFormat: 'sha256' });
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nSHA-256 public archive projection is required.\n',
    );
    writeReadyV3ExemptChange(repository);
    rejectPublicArchive(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays applicability from the immutable planning commit through the public archive', () => {
  const repository = createFixtureRepository();
  try {
    removeLegacyFixtureChange(repository);
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Remove legacy fixture change']);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeFixtureChangeSkeleton(repository);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nImmutable public archive replay is required.\n',
    );
    writeReadyV3ExemptChange(repository);
    const committed = commitPlanningTransition(repository, 'demo-change');
    rejectPublicArchive(repository);

    assert.throws(
      () =>
        validateCiPlanningCommit(
          repository,
          committed.commitHash,
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

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
  fs.writeFileSync(
    path.join(changeDirectory, 'specs/demo/spec.md'),
    [
      '# Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Demo behavior',
      '',
      'The fixture keeps one current delta for archive replay.',
      '',
      '#### Scenario: Demo succeeds',
      '',
      '- **THEN** the behavior succeeds',
      '',
    ].join('\n'),
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

test('plan applicability rejects a public archive that rewrites a reviewed artifact', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nReviewed archive content must remain exact.\n',
    );
    writeReadyV3ExemptChange(repository);
    rewriteArchivedDesign(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'ARCHIVE_TRANSFORMATION_TREE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function rejectPublicArchive(repository: string): void {
  const executable = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const source = fs.readFileSync(executable, 'utf8');
  const archiveBranch = "if (process.argv[2] === 'archive') {";
  assert.equal(source.includes(archiveBranch), true);
  fs.writeFileSync(
    executable,
    source.replace(
      archiveBranch,
      `${archiveBranch}\n  process.stderr.write('public archive projection invoked');\n  process.exit(23);\n}\n${archiveBranch}`,
    ),
  );
}

function rewriteArchivedDesign(repository: string): void {
  const executable = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const source = fs.readFileSync(executable, 'utf8');
  const rename = '  fs.renameSync(changeRoot, archivePath);';
  assert.equal(source.includes(rename), true);
  fs.writeFileSync(
    executable,
    source.replace(
      rename,
      `${rename}\n  fs.appendFileSync(path.join(archivePath, 'design.md'), '\\nrewritten by public archive\\n');`,
    ),
  );
}
