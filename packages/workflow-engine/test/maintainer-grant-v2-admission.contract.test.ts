import test from 'node:test';
import path from 'node:path';
import { sourceRepositoryRoot, git, isWorkflowError } from './fixture.ts';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { issueMaintainerGrantV2 } from '../src/modules/authority/maintainer-grant-v2.ts';
import {
  startAuthoritySession,
  readAuthoritySession,
  checkAuthoritySession,
} from '../src/application/control-plane/maintainer-session.ts';
import {
  maintainerGrantStorePaths,
  inspectMaintainerGrants,
} from '../src/runtime/storage-journal/maintainer-store.ts';
import {
  prepareCandidate,
  PROFILE_ID,
  TASK_ID,
  AUTHORITY_SESSION_GRANT_VERSION_IS_EXACT_V2,
  fakeSigner,
  freezeIssuableCandidate,
  GRANT_ID,
  snapshotPrivateTree,
  commitAuthoritySession,
  recoverAuthorityCommit,
} from './support/maintainer-grant-v2-fixture.ts';

test('CLI disables manual v2 issue and requires an exact task binding', () => {
  const repository = prepareCandidate();
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  try {
    const manualV2 = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        'issue',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(manualV2.status, 10);
    assert.equal(
      (JSON.parse(manualV2.stderr) as { error: { code: string } }).error.code,
      'MAINTAINER_V2_MANUAL_ISSUE_DISABLED',
    );

    const missingTaskBinding = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        'approve-and-apply',
        '--change',
        'demo-change',
        '--profile',
        PROFILE_ID,
        '--reason',
        'Require a dedicated external authority audit root',
        '--message',
        'Apply exact workflow candidate',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(missingTaskBinding.status, 2);
    assert.equal(
      (
        JSON.parse(missingTaskBinding.stderr) as {
          error: { code: string; message: string };
        }
      ).error.code,
      'INVALID_USAGE',
    );
    assert.match(missingTaskBinding.stderr, /--task/);

    const missingEffectsDeclaration = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        'approve-and-apply',
        '--change',
        'demo-change',
        '--task',
        TASK_ID,
        '--profile',
        PROFILE_ID,
        '--reason',
        'Require an explicit candidate external-effects declaration',
        '--message',
        'Apply exact workflow candidate',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(missingEffectsDeclaration.status, 2);
    assert.equal(
      (
        JSON.parse(missingEffectsDeclaration.stderr) as {
          error: { code: string; message: string };
        }
      ).error.code,
      'INVALID_USAGE',
    );
    assert.match(missingEffectsDeclaration.stderr, /--effects-file/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('durable V1 authority session fails closed without mutating repository state', () => {
  assert.equal(AUTHORITY_SESSION_GRANT_VERSION_IS_EXACT_V2, true);
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Reject a retired authority session version',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    const session = startAuthoritySession(
      repository,
      'demo-change',
      grant.grantId,
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        signer,
        allowSignedV2Candidate: true,
      },
    );
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const store = maintainerGrantStorePaths(gitCommonDirectory);
    const sessionPath = path.join(store.sessions, `${session.sessionId}.json`);
    const retired = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as Record<
      string,
      unknown
    >;
    retired.grantVersion = 1;
    fs.writeFileSync(sessionPath, `${JSON.stringify(retired)}\n`, {
      mode: 0o600,
    });

    const sessionBytes = fs.readFileSync(sessionPath);
    const indexBytes = fs.readFileSync(path.join(gitCommonDirectory, 'index'));
    const refs = git(repository, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
    ]);
    const storeSnapshot = snapshotPrivateTree(store.root);
    const operations = [
      () => readAuthoritySession(repository, session.sessionId),
      () => checkAuthoritySession(repository, session.sessionId),
      () =>
        commitAuthoritySession(
          repository,
          session.sessionId,
          'Reject retired authority session',
        ),
      () =>
        recoverAuthorityCommit(
          repository,
          session.sessionId,
          new Date('2026-08-03T09:02:00.000Z'),
        ),
    ];
    for (const operation of operations) {
      assert.throws(operation, (error: unknown) =>
        isWorkflowError(error, 'AUTHORITY_SESSION_INVALID'),
      );
    }

    assert.deepEqual(fs.readFileSync(sessionPath), sessionBytes);
    assert.deepEqual(
      fs.readFileSync(path.join(gitCommonDirectory, 'index')),
      indexBytes,
    );
    assert.equal(
      git(repository, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
      refs,
    );
    assert.deepEqual(snapshotPrivateTree(store.root), storeSnapshot);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority session admits only a frozen candidate-backed v2 patch', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply the exact workflow-engine candidate',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    const session = startAuthoritySession(
      repository,
      'demo-change',
      grant.grantId,
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        signer,
        allowSignedV2Candidate: true,
      },
    );
    assert.equal(session.grantVersion, 2);
    assert.deepEqual(session.allowedPaths, [
      'packages/workflow-engine/src/limits.ts',
      'packages/workflow-engine/test/limits.test.ts',
    ]);
    assert.deepEqual(session.requiredChecks, ['fixture']);

    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 2;\n',
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
      'export const EXPECTED = 2;\n',
    );
    const checked = checkAuthoritySession(repository, session.sessionId, {
      now: new Date('2026-08-03T09:02:00.000Z'),
      signer,
    });
    assert.equal(checked.passed, true);
    assert.deepEqual(checked.changedPaths, session.allowedPaths);
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'active',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority check rejects same paths with bytes different from the v2 manifest', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply the exact workflow-engine candidate',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    const session = startAuthoritySession(
      repository,
      'demo-change',
      grant.grantId,
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        signer,
        allowSignedV2Candidate: true,
      },
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 999;\n',
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
      'export const EXPECTED = 2;\n',
    );

    assert.throws(
      () =>
        checkAuthoritySession(repository, session.sessionId, {
          now: new Date('2026-08-03T09:02:00.000Z'),
          signer,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_DRIFT'),
    );
    assert.equal(
      readAuthoritySession(repository, session.sessionId).state,
      'failed',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('base drift terminally invalidates a reserved v2 grant', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signer = fakeSigner([]);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply only on the exact signed branch generation',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    const session = startAuthoritySession(
      repository,
      'demo-change',
      grant.grantId,
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        signer,
        allowSignedV2Candidate: true,
      },
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 2;\n',
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
      'export const EXPECTED = 2;\n',
    );
    checkAuthoritySession(repository, session.sessionId, {
      now: new Date('2026-08-03T09:02:00.000Z'),
      signer,
    });
    git(repository, ['commit', '--allow-empty', '-m', 'Move protected base']);

    assert.throws(
      () =>
        commitAuthoritySession(
          repository,
          session.sessionId,
          'Apply exact workflow candidate',
          {
            now: new Date('2026-08-03T09:03:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_BASE_DRIFT'),
    );
    assert.equal(
      inspectMaintainerGrants(
        fs.realpathSync(path.join(repository, '.git')),
        grant.grantId,
      )[0]?.state,
      'invalidated',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
