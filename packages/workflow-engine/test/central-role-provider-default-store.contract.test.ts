import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
  type CentralRoleProviderDefaultV1,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  CENTRAL_ROLE_PROVIDER_DEFAULT_PATH,
  readCurrentCentralRoleProviderDefault,
  readPinnedCentralRoleProviderDefault,
  readPinnedCentralRoleProviderDefaultSnapshot,
  replaceCurrentCentralRoleProviderDefault,
} from '../src/runtime/repository-transaction/central-role-provider-default-store.ts';
import { git, isWorkflowError } from './fixture.ts';

test('central default storage owns its pinned snapshot without assignment dependencies', () => {
  const source = fs.readFileSync(
    path.join(
      import.meta.dirname,
      '../src/runtime/repository-transaction/central-role-provider-default-store.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /change-role-assignment-record/u);
});

function configuration(
  ranking: readonly string[] = ['claude', 'codex'],
): CentralRoleProviderDefaultV1 {
  return createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author'],
        sessionGroups: [['author']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['builder'],
        sessionGroups: [['builder']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: null,
        },
      },
      {
        roles: ['reviewer'],
        sessionGroups: [['reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: ranking[0]!,
        },
      },
    ],
    globalProviderRanking: [...ranking],
  });
}

function repositoryWithConfiguration(
  value: CentralRoleProviderDefaultV1 = configuration(),
): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'central-role-provider-default-store-'),
  );
  const destination = path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, renderCentralRoleProviderDefault(value), {
    mode: 0o644,
  });
  return repository;
}

test('current and pinned readers admit only the exact canonical tracked default', () => {
  const repository = repositoryWithConfiguration();
  try {
    assert.deepEqual(
      readCurrentCentralRoleProviderDefault(repository),
      configuration(),
    );

    git(repository, ['init', '-q']);
    git(repository, ['config', 'user.email', 'role-default@example.test']);
    git(repository, ['config', 'user.name', 'Role Default Test']);
    git(repository, ['add', CENTRAL_ROLE_PROVIDER_DEFAULT_PATH]);
    git(repository, [
      'commit',
      '-q',
      '-m',
      'Add central role provider default',
    ]);
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    const blobObjectId = git(repository, [
      'rev-parse',
      `${commit}:${CENTRAL_ROLE_PROVIDER_DEFAULT_PATH}`,
    ]).trim();
    const source = renderCentralRoleProviderDefault(configuration());
    const pinnedSnapshot = readPinnedCentralRoleProviderDefaultSnapshot(
      repository,
      commit,
    );

    assert.deepEqual(
      readPinnedCentralRoleProviderDefault(repository, commit),
      configuration(),
    );
    assert.deepEqual(pinnedSnapshot, {
      schemaVersion: 1,
      kind: 'central-role-provider-default-snapshot.v1',
      pinnedCommit: commit,
      artifactPath: CENTRAL_ROLE_PROVIDER_DEFAULT_PATH,
      blobObjectId,
      sourceDigest: crypto.createHash('sha256').update(source).digest('hex'),
      configuration: configuration(),
      snapshotDigest: pinnedSnapshot.snapshotDigest,
    });
    assert.match(pinnedSnapshot.snapshotDigest, /^[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(pinnedSnapshot), true);
    const changedWorktree = configuration(['codex', 'claude', 'gemini']);
    fs.writeFileSync(
      path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH),
      renderCentralRoleProviderDefault(changedWorktree),
    );
    assert.deepEqual(
      readCurrentCentralRoleProviderDefault(repository),
      changedWorktree,
    );
    assert.deepEqual(
      readPinnedCentralRoleProviderDefault(repository, commit),
      configuration(),
    );
    assert.deepEqual(
      readPinnedCentralRoleProviderDefaultSnapshot(repository, commit),
      pinnedSnapshot,
    );
    assert.throws(
      () => readPinnedCentralRoleProviderDefault(repository, 'HEAD'),
      (error) =>
        isWorkflowError(error, 'CENTRAL_ROLE_PROVIDER_DEFAULT_PIN_INVALID'),
    );
    const tree = git(repository, ['rev-parse', `${commit}^{tree}`]).trim();
    assert.throws(
      () => readPinnedCentralRoleProviderDefaultSnapshot(repository, tree),
      (error) =>
        isWorkflowError(error, 'CENTRAL_ROLE_PROVIDER_DEFAULT_PIN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current reader rejects missing, linked, executable, and noncanonical files', () => {
  for (const mutate of [
    (repository: string, destination: string) => fs.rmSync(destination),
    (repository: string, destination: string) => {
      const target = path.join(repository, 'role-default-target.json');
      fs.renameSync(destination, target);
      fs.symlinkSync(target, destination);
    },
    (repository: string, destination: string) =>
      fs.linkSync(
        destination,
        path.join(repository, 'role-default-alias.json'),
      ),
    (_repository: string, destination: string) =>
      fs.chmodSync(destination, 0o755),
    ...((process.platform === 'win32'
      ? []
      : [
          (_repository: string, destination: string) =>
            fs.chmodSync(destination, 0o600),
        ]) as Array<(repository: string, destination: string) => void>),
    (_repository: string, destination: string) =>
      fs.writeFileSync(
        destination,
        renderCentralRoleProviderDefault(configuration()).replace(
          /^\{/u,
          '{\n ',
        ),
      ),
  ]) {
    const repository = repositoryWithConfiguration();
    try {
      const destination = path.join(
        repository,
        CENTRAL_ROLE_PROVIDER_DEFAULT_PATH,
      );
      mutate(repository, destination);
      assert.throws(
        () => readCurrentCentralRoleProviderDefault(repository),
        (error) =>
          isWorkflowError(error, 'CENTRAL_ROLE_PROVIDER_DEFAULT_UNSAFE') ||
          isWorkflowError(error, 'CENTRAL_ROLE_PROVIDER_DEFAULT_UNAVAILABLE') ||
          isWorkflowError(error, 'CENTRAL_ROLE_PROVIDER_DEFAULT_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('CAS replacement preserves mode and rejects a stale expected digest without mutation', () => {
  const before = configuration();
  const after = configuration(['codex', 'claude', 'gemini']);
  const repository = repositoryWithConfiguration(before);
  const destination = path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH);
  try {
    const result = replaceCurrentCentralRoleProviderDefault(
      repository,
      before.configurationDigest,
      after,
    );
    assert.deepEqual(result, {
      path: CENTRAL_ROLE_PROVIDER_DEFAULT_PATH,
      previousConfigurationDigest: before.configurationDigest,
      configurationDigest: after.configurationDigest,
    });
    assert.equal(fs.statSync(destination).mode & 0o777, 0o644);
    assert.equal(
      fs.readFileSync(destination, 'utf8'),
      renderCentralRoleProviderDefault(after),
    );
    const admitted = readCurrentCentralRoleProviderDefault(repository);
    assert.deepEqual(admitted, after);

    const exactBytes = fs.readFileSync(destination);
    assert.throws(
      () =>
        replaceCurrentCentralRoleProviderDefault(
          repository,
          before.configurationDigest,
          before,
        ),
      (error) => isWorkflowError(error, 'CENTRAL_ROLE_PROVIDER_DEFAULT_STALE'),
    );
    assert.deepEqual(fs.readFileSync(destination), exactBytes);
    assert.deepEqual(fs.readdirSync(path.dirname(destination)).sort(), [
      path.basename(destination),
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
