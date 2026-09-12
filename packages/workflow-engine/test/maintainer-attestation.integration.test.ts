import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { issueAuthorityAttestation } from '../bootstrap/maintainer-authority-production.ts';
import type { MaintainerSignerProvider } from '../src/adapters/signing/ssh/maintainer-signer.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const GRANT_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_NAMESPACE = 'workflow.maintainer-grant.v1';

type RetiredV1GrantPayloadFixture = Readonly<{
  version: 1;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  baseCommit: string;
  policyBlob: string;
  changeId: string;
  allowedPaths: readonly string[];
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  reason: string;
  signer: string;
}>;

type RetiredV1GrantEnvelopeFixture = Readonly<{
  payload: RetiredV1GrantPayloadFixture;
  signature: string;
}>;

function retiredV1GrantPayloadBytes(
  payload: RetiredV1GrantPayloadFixture,
): string {
  return `${JSON.stringify(payload)}\n`;
}

function retiredV1GrantEnvelopeBytes(
  envelope: RetiredV1GrantEnvelopeFixture,
): string {
  return `${JSON.stringify(envelope)}\n`;
}

function sh(
  repository: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...options.env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function createSigningKey(directory: string): {
  privateKey: string;
  trustedSigner: MaintainerPolicy['trustedSigners'][number];
} {
  const privateKey = path.join(directory, 'id_ed25519');
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs
    .readFileSync(`${privateKey}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprint = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${privateKey}.pub`],
    { encoding: 'utf8' },
  ).stdout.match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
  assert.ok(fingerprint);
  return {
    privateKey,
    trustedSigner: {
      identity: 'fixture-maintainer',
      publicKey,
      fingerprint,
    },
  };
}

function sign(privateKey: string, payload: string, namespace: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-v1-sign-'));
  const payloadPath = path.join(directory, 'payload');
  try {
    fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
    const result = spawnSync(
      '/usr/bin/ssh-keygen',
      ['-Y', 'sign', '-f', privateKey, '-n', namespace, payloadPath],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function rewriteCommit(
  repository: string,
  source: string,
  parent: string,
): string {
  const raw = sh(repository, ['cat-file', 'commit', source]);
  const boundary = raw.indexOf('\n\n');
  assert.notEqual(boundary, -1);
  return sh(repository, ['commit-tree', `${source}^{tree}`, '-p', parent], {
    input: raw.slice(boundary + 2),
    env: {
      GIT_COMMITTER_NAME: 'GitHub',
      GIT_COMMITTER_EMAIL: 'noreply@github.com',
      GIT_COMMITTER_DATE: '2026-07-17T05:00:00Z',
    },
  }).trim();
}

function fixtureSigner(
  privateKey: string,
  policy: MaintainerPolicy,
): MaintainerSignerProvider {
  const trusted = policy.trustedSigners[0];
  assert.ok(trusted);
  return {
    assertHumanPresent() {},
    identity: () => trusted.identity,
    sign(payload, namespace) {
      return sign(privateKey, payload, namespace ?? GRANT_NAMESPACE);
    },
    verify() {},
  };
}

test('signed V1 tag cannot issue an attestation or rewrite tag bytes or refs', () => {
  const repository = createFixtureRepository();
  const signingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-v1-key-'),
  );
  try {
    const key = createSigningKey(signingDirectory);
    const policy: MaintainerPolicy = {
      schemaVersion: 1,
      repository: {
        id: 'github:R_fixture',
        origin: 'https://github.com/example/fixture.git',
      },
      phase: 'bootstrap',
      auditTagPrefix: 'refs/tags/workflow-grant/',
      signatureNamespace: GRANT_NAMESPACE,
      maxTtlMinutes: 30,
      maxUses: 1,
      bootstrapEligiblePaths: [
        'packages/workflow-engine/src/**',
        'workflow/checks.json',
      ],
      sealedImmutablePaths: [],
      requiredChecks: ['fixture'],
      trustedSigners: [key.trustedSigner],
    };
    fs.writeFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      `${JSON.stringify(policy, null, 2)}\n`,
    );
    git(repository, ['remote', 'add', 'origin', policy.repository.origin]);
    git(repository, ['add', '--all']);
    git(repository, ['commit', '-m', 'Add V1 grant fixture']);
    git(repository, ['config', 'gpg.format', 'ssh']);
    git(repository, ['config', 'user.signingkey', key.privateKey]);
    const baseCommit = sh(repository, ['rev-parse', 'HEAD']).trim();

    const checksPath = path.join(repository, 'workflow/checks.json');
    fs.writeFileSync(checksPath, ` ${fs.readFileSync(checksPath, 'utf8')}`);
    git(repository, ['add', '--all']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change\n\nChange: demo-change\nTransition: plan',
    ]);
    const originalBase = sh(repository, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(checksPath, ` ${fs.readFileSync(checksPath, 'utf8')}`);
    git(repository, ['add', '--all']);
    git(repository, [
      'commit',
      '-S',
      '-m',
      'Repair workflow authority\n\nChange: demo-change\nTransition: authority-maintenance\n' +
        `Grant: ${GRANT_ID}`,
    ]);
    const originalCommit = sh(repository, ['rev-parse', 'HEAD']).trim();
    const rebasedBase = rewriteCommit(repository, originalBase, baseCommit);
    const mainCommit = rewriteCommit(repository, originalCommit, rebasedBase);
    sh(repository, ['update-ref', 'refs/remotes/origin/main', mainCommit]);

    const now = new Date('2026-08-03T09:00:00.000Z');
    const policyBlob = sh(repository, [
      'rev-parse',
      `${originalBase}:workflow/maintainer-policy.json`,
    ]).trim();
    const payload: RetiredV1GrantPayloadFixture = {
      version: 1,
      grantId: GRANT_ID,
      repositoryId: policy.repository.id,
      repositoryOrigin: policy.repository.origin,
      baseCommit: originalBase,
      policyBlob,
      changeId: 'demo-change',
      allowedPaths: ['workflow/checks.json'],
      issuedAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      maxUses: 1,
      reason: 'Signed retired maintainer grant fixture',
      signer: 'fixture-maintainer',
    };
    const envelope: RetiredV1GrantEnvelopeFixture = {
      payload,
      signature: sign(
        key.privateKey,
        retiredV1GrantPayloadBytes(payload),
        GRANT_NAMESPACE,
      ),
    };
    const tagRef = `${policy.auditTagPrefix}${GRANT_ID}`;
    const messagePath = path.join(signingDirectory, 'message');
    fs.writeFileSync(messagePath, retiredV1GrantEnvelopeBytes(envelope), {
      mode: 0o600,
    });
    git(repository, [
      'tag',
      '--annotate',
      '--cleanup=verbatim',
      '--file',
      messagePath,
      tagRef.slice('refs/tags/'.length),
      originalBase,
    ]);
    const beforeRef = git(repository, ['rev-parse', tagRef]).trim();
    const beforeTag = git(repository, ['cat-file', 'tag', tagRef]);
    assert.throws(
      () =>
        issueAuthorityAttestation(
          repository,
          {
            originalCommit,
            mainCommit,
            grantBasePairs: [{ originalBase, mainBase: rebasedBase }],
          },
          { now, signer: fixtureSigner(key.privateKey, policy) },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
    assert.equal(git(repository, ['rev-parse', tagRef]).trim(), beforeRef);
    assert.equal(git(repository, ['cat-file', 'tag', tagRef]), beforeTag);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(signingDirectory, { recursive: true, force: true });
  }
});
