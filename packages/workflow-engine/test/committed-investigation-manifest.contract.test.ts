import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  loadChangeContract,
  loadCommittedChangeContract,
} from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { readCommittedInvestigationManifestV3 } from '../src/runtime/repository-transaction/committed-investigation-manifest.ts';
import {
  createFixtureRepository,
  fixtureCurrentSchemaName,
  git,
  isWorkflowError,
  runtimeRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';

const CHANGE_ID = 'demo-change';
const MANIFEST_PATH = `openspec/changes/${CHANGE_ID}/investigation.json`;
const COMMITTED_CHECKOUT_MESSAGE =
  'Committed change replay requires one exact clean checkout that remains unchanged.';

test('committed change loading binds canonical v3 bytes to an immutable Git tree without private runtime', () => {
  const repository = committedV3Fixture();
  try {
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    const tree = git(repository, ['rev-parse', `${commit}^{tree}`]).trim();
    const blob = git(repository, [
      'rev-parse',
      `${commit}:${MANIFEST_PATH}`,
    ]).trim();
    const bytes = fs.readFileSync(path.join(repository, MANIFEST_PATH));
    fs.rmSync(runtimeRoot(repository), { recursive: true, force: true });

    const contract = loadCommittedChangeContract(
      repository,
      commit,
      CHANGE_ID,
      fixtureCurrentSchemaName(repository),
    );

    assert.equal(contract.investigation?.manifest.schemaVersion, 3);
    assert.deepEqual(contract.investigation?.currentTreeObservation, {
      kind: 'immutable-git-tree',
      commit,
      tree,
      path: MANIFEST_PATH,
      blob,
      contentDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    assert.throws(
      () => loadChangeContract(repository, CHANGE_ID),
      (error) => isWorkflowError(error, 'REVIEW_TARGET_STALE'),
      'the live loader must still require the exact private current ref',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed v3 loading rejects noncanonical, tampered, and historical schemas without fallback', () => {
  for (const fixture of [
    {
      name: 'noncanonical',
      mutate(value: Record<string, unknown>): string {
        return `${JSON.stringify(value, null, 2)}\n`;
      },
      code: 'CI_COMMITTED_INVESTIGATION_NONCANONICAL',
    },
    {
      name: 'tampered',
      mutate(value: Record<string, unknown>): string {
        return `${canonicalJson({ ...value, manifestDigest: 'f'.repeat(64) })}\n`;
      },
      code: 'RECONSTRUCTION_MISMATCH',
    },
    {
      name: 'schema-v1',
      mutate(): string {
        return `${canonicalJson({ schemaVersion: 1 })}\n`;
      },
      code: 'SCHEMA_V1_FORBIDDEN',
    },
    {
      name: 'schema-v2',
      mutate(): string {
        return `${canonicalJson({ schemaVersion: 2 })}\n`;
      },
      code: 'PROJECTION_PIPELINE_FORBIDDEN',
    },
  ] as const) {
    const repository = committedV3Fixture();
    try {
      const manifestPath = path.join(repository, MANIFEST_PATH);
      const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<
        string,
        unknown
      >;
      fs.writeFileSync(manifestPath, fixture.mutate(value));
      git(repository, ['add', '--', MANIFEST_PATH]);
      git(repository, ['commit', '-m', `Create ${fixture.name} fixture`]);
      const commit = git(repository, ['rev-parse', 'HEAD']).trim();

      assert.throws(
        () =>
          loadCommittedChangeContract(
            repository,
            commit,
            CHANGE_ID,
            fixtureCurrentSchemaName(repository),
          ),
        (error) => isWorkflowError(error, fixture.code),
        fixture.name,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('committed v3 loading requires the derived exact path and a 100644 blob', () => {
  const repository = committedV3Fixture();
  try {
    git(repository, ['update-index', '--chmod=+x', '--', MANIFEST_PATH]);
    git(repository, ['commit', '-m', 'Make committed Manifest executable']);
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readCommittedInvestigationManifestV3({
          repositoryRoot: repository,
          commit,
          changeRoot: 'openspec/changes',
          changeId: CHANGE_ID,
          expectedRepositoryId: 'fixture',
        }),
      (error) => isWorkflowError(error, 'CI_COMMITTED_INVESTIGATION_INVALID'),
    );
    assert.throws(
      () =>
        readCommittedInvestigationManifestV3({
          repositoryRoot: repository,
          commit,
          changeRoot: '../openspec/changes',
          changeId: CHANGE_ID,
          expectedRepositoryId: 'fixture',
        }),
      (error) =>
        isWorkflowError(error, 'CI_COMMITTED_INVESTIGATION_PATH_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed v3 loading rejects a 40-character prefix in a SHA-256 repository', (context) => {
  if (!supportsSha256Repositories()) {
    context.skip('The installed Git does not support SHA-256 repositories.');
    return;
  }
  const repository = committedV3Fixture('sha256');
  try {
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(commit.length, 64);
    assert.throws(
      () =>
        readCommittedInvestigationManifestV3({
          repositoryRoot: repository,
          commit: commit.slice(0, 40),
          changeRoot: 'openspec/changes',
          changeId: CHANGE_ID,
          expectedRepositoryId: 'fixture',
        }),
      (error) => isWorkflowError(error, 'CI_COMMITTED_INVESTIGATION_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed contract loading rejects a different clean checkout before reading its PlanReview', () => {
  const repository = committedV3Fixture();
  try {
    const committed = git(repository, ['rev-parse', 'HEAD']).trim();
    writeCanonicalValue(
      path.join(repository, 'openspec/changes/demo-change/plan-review.json'),
      { schemaVersion: 1 },
    );
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Create a different checkout']);

    assert.throws(
      () =>
        loadCommittedChangeContract(
          repository,
          committed,
          CHANGE_ID,
          fixtureCurrentSchemaName(repository),
        ),
      isGenericCommittedCheckoutError,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed contract loading rejects a dirty checkout before reading its artifacts', () => {
  const repository = committedV3Fixture();
  try {
    const committed = git(repository, ['rev-parse', 'HEAD']).trim();
    writeCanonicalValue(
      path.join(repository, 'openspec/changes/demo-change/plan-review.json'),
      { schemaVersion: 1 },
    );

    assert.throws(
      () =>
        loadCommittedChangeContract(
          repository,
          committed,
          CHANGE_ID,
          fixtureCurrentSchemaName(repository),
        ),
      isGenericCommittedCheckoutError,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed contract loading rejects an ignored PlanReview that is absent from the commit tree', () => {
  const repository = committedV3Fixture();
  try {
    const planReviewPath = 'openspec/changes/demo-change/plan-review.json';
    git(repository, ['rm', '--cached', '--', planReviewPath]);
    fs.appendFileSync(
      path.join(repository, '.gitignore'),
      `/${planReviewPath}\n`,
    );
    git(repository, ['add', '--', '.gitignore']);
    git(repository, ['commit', '-m', 'Remove committed PlanReview']);
    const committed = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(
      git(repository, ['status', '--porcelain=v1', '--untracked-files=all']),
      '',
      'the replacement PlanReview must be hidden from the clean-status check',
    );
    assert.equal(
      fs.statSync(path.join(repository, planReviewPath)).isFile(),
      true,
    );

    assert.throws(
      () =>
        loadCommittedChangeContract(
          repository,
          committed,
          CHANGE_ID,
          fixtureCurrentSchemaName(repository),
        ),
      isGenericCommittedCheckoutError,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed contract loading rejects an ignored delta spec outside the commit tree', () => {
  const repository = committedV3Fixture();
  try {
    const injectedSpecPath =
      'openspec/changes/demo-change/specs/ignored/spec.md';
    fs.appendFileSync(
      path.join(repository, '.gitignore'),
      `/${injectedSpecPath}\n`,
    );
    git(repository, ['add', '--', '.gitignore']);
    git(repository, ['commit', '-m', 'Ignore a tree-external delta spec']);
    fs.mkdirSync(path.dirname(path.join(repository, injectedSpecPath)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repository, injectedSpecPath),
      [
        '## ADDED Requirements',
        '',
        '### Requirement: Ignored contract injection',
        '',
        '#### Scenario: Hidden from status',
        '',
        '- **WHEN** committed replay scans checkout specs',
        '- **THEN** an ignored tree-external contract must be rejected',
        '',
      ].join('\n'),
    );
    const committed = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(
      git(repository, ['status', '--porcelain=v1', '--untracked-files=all']),
      '',
      'the injected spec must be hidden from the clean-status check',
    );

    assert.throws(
      () =>
        loadCommittedChangeContract(
          repository,
          committed,
          CHANGE_ID,
          fixtureCurrentSchemaName(repository),
        ),
      isGenericCommittedCheckoutError,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed contract loading replaces a mid-read checkout mutation with the fixed generic error', () => {
  const repository = committedV3Fixture();
  const committed = git(repository, ['rev-parse', 'HEAD']).trim();
  const planReviewPath = fs.realpathSync(
    path.join(repository, 'openspec/changes/demo-change/plan-review.json'),
  );
  const mutableFs = fs as unknown as Record<string, unknown>;
  const originalReadFileSync = mutableFs.readFileSync as (
    ...args: unknown[]
  ) => unknown;
  let planReviewReads = 0;
  mutableFs.readFileSync = (...args: unknown[]): unknown => {
    const result = Reflect.apply(originalReadFileSync, fs, args);
    if (
      typeof args[0] === 'string' &&
      path.resolve(args[0]) === planReviewPath &&
      ++planReviewReads === 1
    ) {
      writeCanonicalValue(planReviewPath, { schemaVersion: 1 });
    }
    return result;
  };
  try {
    assert.throws(
      () =>
        loadCommittedChangeContract(
          repository,
          committed,
          CHANGE_ID,
          fixtureCurrentSchemaName(repository),
        ),
      isGenericCommittedCheckoutError,
    );
    assert.equal(planReviewReads >= 1, true);
  } finally {
    mutableFs.readFileSync = originalReadFileSync;
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function committedV3Fixture(objectFormat: 'sha1' | 'sha256' = 'sha1'): string {
  const repository = createFixtureRepository({ objectFormat });
  writeReadyV3ExemptChange(repository);
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Record committed v3 planning fixture']);
  return repository;
}

function supportsSha256Repositories(): boolean {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-sha256-probe-'),
  );
  try {
    return (
      childProcess.spawnSync(
        'git',
        ['init', '--object-format=sha256', repository],
        { encoding: 'utf8' },
      ).status === 0
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}

function isGenericCommittedCheckoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    isWorkflowError(error, 'CI_COMMITTED_CHECKOUT_INVALID') &&
    error.message === COMMITTED_CHECKOUT_MESSAGE
  );
}

function writeCanonicalValue(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`);
}
