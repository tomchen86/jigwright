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

import { commitArchiveTransition as commitArchiveTransitionWithHandoff } from '../src/application/archive/archive-transition.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  syncOriginMain,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { commitCurrentFixtureTask } from './support/task-diff-review-fixture.ts';

const SCENARIOS = Array.from(
  { length: 6 },
  (_, index) => `Preserved scenario ${index + 1}`,
);

test('plan-commit refuses a modified requirement that drops exact scenario identities', () => {
  const repository = createScenarioFixture();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeDroppingDelta(repository);
    writeReadyV3ExemptChange(repository);
    const before = repositoryState(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error: unknown) =>
        isWorkflowError(error, 'SPEC_SCENARIO_PRESERVATION_FAILED') &&
        SCENARIOS.every((scenario) =>
          JSON.stringify((error as { details?: unknown }).details).includes(
            scenario,
          ),
        ),
    );

    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive refuses the same scenario loss before applying or staging its transformation', () => {
  const repository = createScenarioFixture();
  try {
    commitScenarioPlanRevision(repository);
    commitCurrentFixtureTask(repository, {
      message: 'Complete scenario fixture',
    });
    writeDroppingDelta(repository);
    writeReadyV3ExemptChange(repository);
    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Record invalid scenario revision',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const completed = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--ff-only', completed]);
    syncOriginMain(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);
    const before = repositoryState(repository);

    assert.throws(
      () => commitArchiveTransition(repository, 'demo-change'),
      (error: unknown) =>
        isWorkflowError(error, 'SPEC_SCENARIO_PRESERVATION_FAILED') &&
        SCENARIOS.every((scenario) =>
          JSON.stringify((error as { details?: unknown }).details).includes(
            scenario,
          ),
        ),
    );

    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive returns every rejected rebuilt-spec issue without mutating the real repository', () => {
  const repository = createScenarioFixture();
  try {
    commitScenarioPlanRevision(repository);
    commitCurrentFixtureTask(repository, {
      message: 'Complete rebuilt-spec fixture',
    });
    const completed = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--ff-only', completed]);
    syncOriginMain(repository);
    git(repository, ['checkout', '-b', 'work/archive-diagnostics']);
    const before = repositoryState(repository);

    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          aroundProjectedSpecValidation: (invoke) =>
            withRejectedSpecValidation(repository, invoke),
        }),
      (error: unknown) =>
        isWorkflowError(error, 'ARCHIVE_REBUILT_SPECS_INVALID') &&
        SCENARIOS.every((scenario) =>
          JSON.stringify((error as { details?: unknown }).details).includes(
            scenario,
          ),
        ),
    );

    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function commitScenarioPlanRevision(repository: string): void {
  git(repository, ['checkout', '-b', 'work/demo-change']);
  fs.appendFileSync(
    path.join(repository, 'openspec/changes/demo-change/design.md'),
    '\nScenario-preservation review baseline.\n',
  );
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
}

function createScenarioFixture(): string {
  const repository = createFixtureRepository();
  fs.mkdirSync(path.join(repository, 'openspec/specs/demo'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, 'openspec/specs/demo/spec.md'),
    [
      '# Demo',
      '',
      '### Requirement: Existing behavior',
      '',
      'The existing behavior remains specified.',
      '',
      ...SCENARIOS.flatMap((scenario) => [
        `#### Scenario: ${scenario}`,
        '',
        '- **THEN** the scenario remains present',
        '',
      ]),
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    preservingDelta(),
  );
  const currentSchemaName = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/repository-consumer.json'),
      'utf8',
    ),
  ) as { planning: { currentSchemaName: string } };
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/.openspec.yaml'),
    `schema: ${currentSchemaName.planning.currentSchemaName}\ncreated: 2026-07-15\n`,
  );
  writeReadyV3ExemptChange(repository);
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Configure scenario fixture']);
  syncOriginMain(repository);
  return repository;
}

function preservingDelta(): string {
  return [
    '# Delta',
    '',
    '## MODIFIED Requirements',
    '',
    '### Requirement: Existing behavior',
    '',
    'The behavior has reviewed wording.',
    '',
    ...SCENARIOS.flatMap((scenario) => [
      `#### Scenario: ${scenario}`,
      '',
      '- **THEN** the scenario remains present',
      '',
    ]),
  ].join('\n');
}

function writeDroppingDelta(repository: string): void {
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    [
      '# Delta',
      '',
      '## MODIFIED Requirements',
      '',
      '### Requirement: Existing behavior',
      '',
      'The behavior has reviewed wording but replaces every prior scenario.',
      '',
      '#### Scenario: Replacement behavior',
      '',
      '- **THEN** only the replacement scenario remains present',
      '',
    ].join('\n'),
  );
}

function withRejectedSpecValidation<T>(repository: string, action: () => T): T {
  const executablePath = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const source = fs.readFileSync(executablePath, 'utf8');
  const validationBranch =
    "if (process.argv[2] === 'validate' && process.argv.includes('--specs')) {";
  assert.equal(source.includes(validationBranch), true);
  const issues = SCENARIOS.map((scenario) => ({
    level: 'ERROR',
    path: 'openspec/specs/demo/spec.md',
    message: `Missing exact scenario identity: ${scenario}`,
  }));
  const injected = [
    validationBranch,
    `  const issues = ${JSON.stringify(issues)};`,
    '  process.stdout.write(JSON.stringify({',
    "    items: [{ id: 'demo', type: 'spec', valid: false, issues, durationMs: 1 }],",
    '    summary: {',
    '      totals: { items: 1, passed: 0, failed: 1 },',
    '      byType: { spec: { items: 1, passed: 0, failed: 1 } }',
    '    },',
    "    version: '1.0',",
    "    root: { path: process.cwd(), source: 'nearest' }",
    '  }));',
    '  process.exit(1);',
    '}',
    validationBranch,
  ].join('\n');
  fs.writeFileSync(executablePath, source.replace(validationBranch, injected));
  try {
    return action();
  } finally {
    fs.writeFileSync(executablePath, source);
  }
}

function repositoryState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
  };
}
