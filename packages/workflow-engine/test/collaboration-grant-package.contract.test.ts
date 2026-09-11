import { observeChangeRoutingContinuationState } from '../src/runtime/repository-observation/change-routing.ts';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyChangeRoutingReview,
  prepareChangeRoutingReview,
} from '../src/composition-root/change-routing-production.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import { parseGrantPolicyV2Document } from '../src/modules/authority/grant-policy.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import { COLLABORATION_GRANT_AUTHORIZED_EFFECT } from '../src/modules/provider-orchestration/role-independence.ts';
import {
  COLLABORATION_GRANT_POLICY_DIGEST,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  type CollaborationGrantEnvelope,
  type CollaborationGrantPayload,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import {
  canonicalCollaborationGrantPayload,
  parseCollaborationGrantEnvelope,
  verifyCollaborationGrantCapability,
} from '../src/runtime/grants/grant-services.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import {
  changeRoutingGrantTransitionDefinitions,
  createChangeRoutingContinuationGrantRequest,
} from '../src/modules/lifecycle/change-routing-grant.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../src/runtime/storage-journal/grant-store.ts';
import {
  createFixtureRepository,
  git,
  runtimeRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';

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
  signatureNamespace: 'workflow.maintainer-grant.v1',
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

test('the production collaboration boundary accepts current V2 and rejects retired V1 before verification', () => {
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

  const envelope = collaborationEnvelope();
  const capability = verifyCollaborationGrantCapability(envelope, POLICY, {
    now: NOW,
    expected: expectedBinding(envelope),
    verifier,
  });
  assert.equal(capability.envelope.payload.version, 2);
  assert.equal(
    capability.verification.receipt.signatureNamespace,
    COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
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
  assert.deepEqual(namespaces, [COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE]);

  const retiredV1 = structuredClone(envelope) as unknown as {
    payload: Record<string, unknown>;
    signature: string;
  };
  retiredV1.payload.version = 1;
  delete retiredV1.payload.signatureNamespace;
  assert.throws(
    () => parseCollaborationGrantEnvelope(`${JSON.stringify(retiredV1)}\n`),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'COLLABORATION_GRANT_INVALID',
  );
  const retiredEnvelope = retiredV1 as unknown as CollaborationGrantEnvelope;
  assert.throws(
    () =>
      verifyCollaborationGrantCapability(retiredEnvelope, POLICY, {
        now: NOW,
        expected: expectedBinding(retiredEnvelope),
        verifier,
      }),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'COLLABORATION_GRANT_INVALID',
  );
  assert.deepEqual(namespaces, [COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE]);
});

test('@jigwright/grants remains optional for generic Central Grant inspection and recovery while package-dependent routes fail closed', async () => {
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
    for (const packageName of Object.keys({
      ...packageManifest.dependencies,
      ...packageManifest.optionalDependencies,
    })
      .filter(
        (name) =>
          name.startsWith('@jigwright/') && name !== '@jigwright/grants',
      )
      .map((name) => name.slice('@jigwright/'.length))) {
      fs.symlinkSync(
        path.join(WORKSPACE_ROOT, 'packages', packageName),
        path.join(fixtureScope, packageName),
        'dir',
      );
    }

    const cliPath = fs.realpathSync(
      path.join(fixtureEngineRoot, 'src/entrypoints/cli/workflow-cli.ts'),
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
    const archiveConfigPath = path.join(fixtureRoot, 'github-adapter.json');
    fs.writeFileSync(archiveConfigPath, '{}\n');
    const fixturePreimage = fs
      .readdirSync(fixtureRoot, { recursive: true, encoding: 'utf8' })
      .sort();
    const packageDependentHumanGrantRoutes = [
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
        '--config',
        archiveConfigPath,
        '--reason',
        'Request the registered archive publication transition.',
      ],
    ] as const;
    for (const route of packageDependentHumanGrantRoutes) {
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

    const repository = createFixtureRepository();
    try {
      const completed =
        await createCompletedGenericCentralChallenge(repository);
      const terminalBytes = fs.readFileSync(completed.recordPath, 'utf8');

      const inspect = runCopiedHumanGrantCli(
        cliPath,
        repository,
        'inspect',
        completed.challengeId,
      );
      assert.equal(inspect.status, 0, inspect.stderr);
      assert.equal(inspect.stdoutJson.ok, true);
      assert.equal(inspect.stdoutJson.action, 'inspect');
      const inspection = inspect.stdoutJson.result as {
        challenge?: { challengeId?: unknown };
        choices?: readonly { transitionId?: unknown }[];
      };
      assert.equal(inspection.challenge?.challengeId, completed.challengeId);
      assert.equal(
        inspection.choices?.[0]?.transitionId,
        completed.transitionId,
      );

      const decide = runCopiedHumanGrantCli(
        cliPath,
        repository,
        'decide',
        completed.challengeId,
      );
      assert.notEqual(decide.status, 0);
      assert.deepEqual(decide.stderrJson, {
        ok: false,
        error: {
          code: 'GRANT_CHALLENGE_UNAVAILABLE',
          message: `Grant challenge ${completed.challengeId} is not available.`,
        },
      });

      const recover = runCopiedHumanGrantCli(
        cliPath,
        repository,
        'recover',
        completed.challengeId,
      );
      assert.equal(recover.status, 0, recover.stderr);
      assert.equal(recover.stdoutJson.ok, true);
      assert.equal(recover.stdoutJson.action, 'recover');
      assert.deepEqual(recover.stdoutJson.result, {
        challengeId: completed.challengeId,
        operationId: completed.operationId,
        transitionId: completed.transitionId,
        outcome: 'completed',
        poststateDigest: completed.poststateDigest,
        recovered: true,
      });
      assert.equal(
        fs.readFileSync(completed.recordPath, 'utf8'),
        terminalBytes,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

async function createCompletedGenericCentralChallenge(repository: string) {
  fs.copyFileSync(
    path.join(WORKSPACE_ROOT, 'workflow/grant-policy.json'),
    path.join(repository, 'workflow/grant-policy.json'),
  );
  git(repository, ['add', '--', 'workflow/grant-policy.json']);
  git(repository, ['commit', '-m', 'Configure generic Central Grant policy']);
  writeReadyV3ExemptChange(repository);
  const blocked = prepareChangeRoutingReview(repository, {
    schemaVersion: 1,
    action: {
      kind: 'block',
      changeId: 'demo-change',
      taskId: '1.1',
      reason: 'Wait for the exact external decision.',
      blocker: {
        kind: 'external',
        id: 'generic-central-grant-fixture',
        resumeCondition: 'manual',
      },
    },
  });
  applyChangeRoutingReview(repository, blocked);

  const now = new Date();
  const ids = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ];
  const coordinator = createGrantCoordinatorKernel({
    store: createFileGrantRecordStore(grantStorePaths(runtimeRoot(repository))),
    registry: createTransitionRegistry(
      changeRoutingGrantTransitionDefinitions(
        observeChangeRoutingContinuationState,
        repository,
      ),
    ),
    policy: parseGrantPolicyV2Document(
      fs.readFileSync(
        path.join(repository, 'workflow/grant-policy.json'),
        'utf8',
      ),
    ).policy,
    now: () => new Date(now),
    randomUUID: () => ids.shift()!,
    openApprovalSession(presentation) {
      return {
        async collectDecision() {
          return {
            choiceId: presentation.choices[0]!.choiceId,
            reasonCode: 'manual-continuation-reviewed',
            reason: 'The exact generic Central continuation was reviewed.',
            approvalMethod: 'human-presence' as const,
            sessionNonce: 'nonce-66666666666666666666666666666666',
          };
        },
        async authenticate({ approvalSubjectDigest }) {
          return [
            {
              moduleId: 'human-gate-macos',
              version: '1',
              claims: ['fresh-local-device-owner'] as const,
              approvalSubjectDigest,
              proofDigest: `sha256:${'4'.repeat(64)}` as const,
              verifiedAt: now.toISOString(),
              identity: null,
              portableEvidence: null,
            },
          ];
        },
        async close() {},
      };
    },
    async withLifecycleOperation(_challengeId, operation) {
      return operation(() => undefined);
    },
  });
  const requested = await coordinator.requestGrant(
    createChangeRoutingContinuationGrantRequest(
      observeChangeRoutingContinuationState,
      repository,
      'demo-change',
      'Continue after the exact external decision.',
    ),
  );
  const completed = await coordinator.resolveChallenge(requested.challengeId);
  assert.equal(completed.outcome, 'completed');
  const recordPath = path.join(
    grantStorePaths(runtimeRoot(repository)).records,
    `${completed.challengeId}.json`,
  );
  return { ...completed, recordPath };
}

function runCopiedHumanGrantCli(
  cliPath: string,
  repository: string,
  action: 'inspect' | 'decide' | 'recover',
  challengeId: string,
) {
  const result = childProcess.spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cliPath,
      'grant',
      'human',
      action,
      challengeId,
      '--json',
    ],
    { cwd: repository, encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutJson:
      result.stdout === ''
        ? {}
        : (JSON.parse(result.stdout) as Record<string, unknown>),
    stderrJson:
      result.stderr === ''
        ? {}
        : (JSON.parse(result.stderr) as Record<string, unknown>),
  };
}

function collaborationEnvelope(): CollaborationGrantEnvelope {
  const common = {
    grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    repositoryId: POLICY.repository.id,
    repositoryOrigin: POLICY.repository.origin,
    policyBlob: 'a'.repeat(40),
    collaborationPolicyDigest: COLLABORATION_GRANT_POLICY_DIGEST,
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
  const payload: CollaborationGrantPayload = {
    version: 2,
    signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    ...common,
  };
  return { payload, signature: SIGNATURE };
}

function expectedBinding(envelope: CollaborationGrantEnvelope) {
  return {
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
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
