import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_POLICY_DIGEST,
  COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  LEGACY_COLLABORATION_GRANT_POLICY_DIGEST,
  canonicalCollaborationGrantPayload,
  verifyCollaborationGrantCapability,
  type CollaborationGrantEnvelope,
  type CollaborationGrantPayload,
} from '../src/modules/authority/collaboration-grant.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';

const NOW = new Date('2026-08-20T00:01:00.000Z');
const SIGNATURE = [
  '-----BEGIN SSH SIGNATURE-----',
  'fixture',
  '-----END SSH SIGNATURE-----',
  '',
].join('\n');

const ENGINE_ROOT = path.resolve(import.meta.dirname, '..');
const WORKSPACE_ROOT = path.resolve(ENGINE_ROOT, '../..');

const POLICY: MaintainerPolicy = {
  schemaVersion: 1,
  repository: {
    id: 'github:R_grants_package_fixture',
    origin: 'https://github.com/example/grants-package-fixture.git',
  },
  phase: 'bootstrap',
  auditTagPrefix: 'refs/tags/workflow-grant/',
  signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
  sealedImmutablePaths: ['workflow/maintainer-policy.json'],
  requiredChecks: ['fixture'],
  trustedSigners: [
    {
      identity: 'fixture-maintainer',
      publicKey: 'fixture-public-key',
      fingerprint: 'SHA256:fixture',
    },
  ],
};

test('the production collaboration validator emits typed capabilities for historical V1 and current V2 namespaces', () => {
  const namespaces: string[] = [];
  const verifier = {
    verify(
      payload: string,
      signature: string,
      identity: string,
      namespace: string,
    ) {
      assert.equal(signature, SIGNATURE);
      assert.equal(identity, 'fixture-maintainer');
      assert.equal(payload.endsWith('\n'), true);
      namespaces.push(namespace);
    },
  };

  for (const version of [1, 2] as const) {
    const envelope = collaborationEnvelope(version);
    const capability = verifyCollaborationGrantCapability(envelope, POLICY, {
      now: NOW,
      expected: {
        repositoryId: envelope.payload.repositoryId,
        repositoryOrigin: envelope.payload.repositoryOrigin,
        policyBlob: envelope.payload.policyBlob,
        collaborationPolicyDigest: envelope.payload.collaborationPolicyDigest,
        changeId: envelope.payload.changeId,
        taskId: envelope.payload.taskId,
        baselineCommit: envelope.payload.baselineCommit,
        baselineTree: envelope.payload.baselineTree,
        targetDigest: envelope.payload.targetDigest,
        lifecyclePhase: envelope.payload.lifecyclePhase,
        rolePair: envelope.payload.rolePair,
        availableActor: envelope.payload.availableActor,
        degradedForm: envelope.payload.degradedForm,
        reason: envelope.payload.reason,
      },
      verifier,
    });
    const expectedNamespace =
      version === 1
        ? COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
        : COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE;
    assert.equal(capability.envelope.payload.version, version);
    assert.equal(
      capability.verification.receipt.signatureNamespace,
      expectedNamespace,
    );
    assert.equal(
      capability.verification.receipt.authorizedEffect,
      COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    );
    assert.equal(
      capability.verification.receipt.signedPayloadDigest,
      sha256(canonicalCollaborationGrantPayload(envelope.payload)),
    );
    assert.equal(Object.isFrozen(capability), true);
  }

  assert.deepEqual(namespaces, [
    COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
    COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  ]);
});

test('@jigwright/grants is optional at install time while non-grant CLI loading remains available and grant routes fail closed', () => {
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  assert.equal(packageManifest.dependencies?.['@jigwright/grants'], undefined);
  assert.equal(
    packageManifest.optionalDependencies?.['@jigwright/grants'],
    'workspace:*',
  );

  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-optional-grants-'),
  );
  try {
    const fixtureEngineRoot = path.join(
      fixtureRoot,
      'packages',
      'workflow-engine',
    );
    fs.mkdirSync(fixtureEngineRoot, { recursive: true });
    fs.cpSync(
      path.join(ENGINE_ROOT, 'src'),
      path.join(fixtureEngineRoot, 'src'),
      {
        recursive: true,
      },
    );
    fs.cpSync(
      path.join(ENGINE_ROOT, 'bootstrap'),
      path.join(fixtureEngineRoot, 'bootstrap'),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(ENGINE_ROOT, 'package.json'),
      path.join(fixtureEngineRoot, 'package.json'),
    );
    const fixtureScope = path.join(
      fixtureEngineRoot,
      'node_modules',
      '@jigwright',
    );
    fs.mkdirSync(fixtureScope, { recursive: true });
    for (const packageName of ['agent-runtime', 'core', 'openspec-adapter']) {
      fs.symlinkSync(
        path.join(WORKSPACE_ROOT, 'packages', packageName),
        path.join(fixtureScope, packageName),
        'dir',
      );
    }

    const cliPath = fs.realpathSync(
      path.join(fixtureEngineRoot, 'src', 'cli.ts'),
    );
    const help = childProcess.spawnSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, '--help'],
      { cwd: WORKSPACE_ROOT, encoding: 'utf8' },
    );
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/u);

    const guide = childProcess.spawnSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, 'guide', '--json'],
      { cwd: WORKSPACE_ROOT, encoding: 'utf8' },
    );
    assert.equal(guide.status, 0, guide.stderr);
    assert.equal(
      (JSON.parse(guide.stdout) as { command?: unknown }).command,
      'guide',
    );

    const grant = childProcess.spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cliPath,
        'maintainer',
        'collaboration-grant',
        '--json',
      ],
      { cwd: WORKSPACE_ROOT, encoding: 'utf8' },
    );
    assert.equal(grant.status, 10, grant.stderr);
    assert.match(grant.stderr, /JIGWRIGHT_OPTIONAL_GRANTS_UNAVAILABLE/u);

    const reviewPath = path.join(fixtureRoot, 'review.json');
    fs.writeFileSync(reviewPath, '{}\n');
    const fixturePreimage = fs
      .readdirSync(fixtureRoot, { recursive: true, encoding: 'utf8' })
      .sort();
    const challengeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const humanGrantRoutes = [
      [
        'request-investigation-v3',
        'investigation-fixture',
        '--reason',
        'Request the registered recovery transition.',
      ],
      [
        'request-work-item-review',
        'work-item-fixture',
        '--input',
        reviewPath,
        '--reason',
        'Request the registered review transition.',
      ],
      [
        'request-work-item-promotion',
        'work-item-fixture',
        '--change',
        'change-fixture',
        '--expected',
        `sha256:${'a'.repeat(64)}`,
        '--reason',
        'Request the registered promotion transition.',
      ],
      [
        'request-archive-publication',
        `sha256:${'b'.repeat(64)}`,
        '--reason',
        'Request the registered archive publication transition.',
      ],
      ['inspect', challengeId],
      ['decide', challengeId],
      ['recover', challengeId],
    ] as const;
    for (const route of humanGrantRoutes) {
      const result = childProcess.spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          cliPath,
          'grant',
          'human',
          ...route,
          '--json',
        ],
        { cwd: fixtureRoot, encoding: 'utf8' },
      );
      assert.equal(result.status, 10, `${route[0]}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stderr), {
        ok: false,
        error: {
          code: 'JIGWRIGHT_OPTIONAL_GRANTS_UNAVAILABLE',
          message:
            'This route requires the optional @jigwright/grants package. Install that package before using grant functionality.',
          details: { packageName: '@jigwright/grants' },
        },
      });
    }
    assert.deepEqual(
      fs.readdirSync(fixtureRoot, { recursive: true, encoding: 'utf8' }).sort(),
      fixturePreimage,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function collaborationEnvelope(version: 1 | 2): CollaborationGrantEnvelope {
  const common = {
    grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    repositoryId: POLICY.repository.id,
    repositoryOrigin: POLICY.repository.origin,
    policyBlob: 'a'.repeat(40),
    collaborationPolicyDigest:
      version === 1
        ? LEGACY_COLLABORATION_GRANT_POLICY_DIGEST
        : COLLABORATION_GRANT_POLICY_DIGEST,
    changeId: 'package-grant-fixture',
    taskId: null,
    baselineCommit: 'b'.repeat(40),
    baselineTree: 'c'.repeat(40),
    targetDigest: 'd'.repeat(64),
    lifecyclePhase: 'plan-review' as const,
    rolePair: {
      authorRole: 'plan-author' as const,
      conflictingRole: 'plan-reviewer' as const,
    },
    availableActor: {
      kind: 'provider' as const,
      providerId: 'codex' as const,
      assurance: 'runtime-hint' as const,
    },
    degradedForm: 'same-provider-fresh-session' as const,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    reason: 'Use an exact fresh provider session.',
    issuedAt: '2026-08-20T00:00:00.000Z',
    expiresAt: '2026-08-20T00:30:00.000Z',
    maxUses: 1 as const,
    signer: 'fixture-maintainer',
  };
  const payload: CollaborationGrantPayload =
    version === 1
      ? { version: 1, ...common }
      : {
          version: 2,
          signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
          ...common,
        };
  return { payload, signature: SIGNATURE };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
