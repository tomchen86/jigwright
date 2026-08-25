import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
} from './fixture.ts';

const LEGACY_MIGRATION_MODULE =
  'packages/workflow-engine/src/adapters/compatibility/investigation-v2/legacy-plan-migration.ts';

test('propose CLI rejects the retired legacy migration flag as invalid usage', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-retired-legacy-migration-cli-'),
  );
  try {
    git(repository, ['checkout', '-b', 'work/retired-legacy-migration']);
    const intentPath = path.join(inputDirectory, 'intent.json');
    fs.writeFileSync(
      intentPath,
      JSON.stringify({
        schemaVersion: 1,
        summary: 'Confirm the retired migration action stays unavailable.',
        explicitPaths: [],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      }),
    );
    const rejected = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'propose',
        'retired-legacy-migration',
        '--intent',
        intentPath,
        '--actor',
        'codex',
        '--migrate-legacy',
        '--json',
      ],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT: undefined,
          CLAUDECODE: undefined,
          CLAUDE_CODE_ENTRYPOINT: undefined,
          CODEX_SANDBOX: undefined,
          WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_USAGE');

    const help = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'help',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(help.status, 0, help.stderr);
    assert.doesNotMatch(JSON.parse(help.stdout).usage, /migrate-legacy/u);
  } finally {
    fs.rmSync(inputDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('production has no active legacy plan migration module, import, or option', () => {
  const cli = readSource('packages/workflow-engine/src/cli.ts');
  const orchestrator = readSource(
    'packages/workflow-engine/src/application/propose/propose-orchestrator.ts',
  );
  const planReview = readSource(
    'packages/workflow-engine/src/modules/assurance/plan-review.ts',
  );

  assert.doesNotMatch(cli, /--migrate-legacy|migrateLegacy/u);
  assert.doesNotMatch(
    orchestrator,
    /legacy-plan-migration|LegacyPlanMigrationSubject|migrateLegacy/u,
  );
  assert.doesNotMatch(
    planReview,
    /legacy-plan-migration|LegacyPlanMigrationSubject/u,
  );
  assert.equal(
    fs.existsSync(path.join(sourceRepositoryRoot, LEGACY_MIGRATION_MODULE)),
    false,
  );
});

test('historical v1 and v2 artifact parsers retain independent legacyMigration bytes', () => {
  const contracts = readSource(
    'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/contracts.ts',
  );
  const projection = readSource(
    'packages/workflow-engine/src/adapters/compatibility/investigation-v2/investigation-artifact-projection.ts',
  );

  assert.match(contracts, /typeof value\.legacyMigration !== 'boolean'/u);
  assert.match(projection, /legacyMigration: false/u);
});

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(sourceRepositoryRoot, relativePath), 'utf8');
}
