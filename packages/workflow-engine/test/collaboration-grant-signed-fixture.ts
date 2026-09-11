/** Shared signing, exact Grant bindings, repository reservation, and store observation fixtures. */
import { createSshSignedFixture } from './support/ssh-signed-fixture.ts';
import { after } from 'node:test';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  git,
  createFixtureRepository,
  authoritativeCollaborationGrantVerifierForTest,
} from './fixture.ts';
import { issueCollaborationGrant } from '../src/runtime/grants/collaboration-grant-issuance.ts';
import type {
  CollaborationGrantRequest,
  CollaborationGrantEnvelope,
  CollaborationGrantExpectedBinding,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import type { MaintainerSignerProvider } from '../src/adapters/signing/ssh/maintainer-signer.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { reserveCollaborationGrant } from '../src/runtime/storage-journal/collaboration-grant-reservation.ts';

export const NOW = new Date('2026-07-24T00:00:00.000Z');

export const GRANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const TARGET_DIGEST = '1'.repeat(64);

export const CONTENT_NODE_ID = '2'.repeat(64);

export const CONTENT_RESULT_DIGEST = '3'.repeat(64);

export const TRANSITION_DIGEST = '4'.repeat(64);

export const NEUTRAL_COLLABORATION_GRANT_NAMESPACE =
  'workflow.collaboration-grant.v2';

const SSH_SIGNING = createSshSignedFixture('fixture-maintainer');

after(() => SSH_SIGNING.dispose());

export const POLICY: MaintainerPolicy = {
  schemaVersion: 1,
  repository: {
    id: 'github:R_fixture',
    origin: 'https://github.com/example/fixture.git',
  },
  phase: 'bootstrap',
  auditTagPrefix: 'refs/tags/workflow-grant/',
  signatureNamespace: 'workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: [
    'packages/workflow-engine/src/**',
    'workflow/maintainer-policy.json',
  ],
  sealedImmutablePaths: [
    'packages/workflow-engine/src/modules/authority/maintainer-policy.ts',
    'workflow/maintainer-policy.json',
  ],
  requiredChecks: ['fixture'],
  trustedSigners: [SSH_SIGNING.trustedSigner],
};

export function minimalCollaborationGrantRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-collaboration-minimal-'),
  );
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'Fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.test']);
  fs.mkdirSync(path.join(repository, 'workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(POLICY, null, 2)}\n`,
  );
  git(repository, ['add', 'workflow/maintainer-policy.json']);
  git(repository, ['commit', '-m', 'Add fixture maintainer policy']);
  git(repository, ['remote', 'add', 'origin', POLICY.repository.origin]);
  return repository;
}

export function collaborationFixture(): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(POLICY, null, 2)}\n`,
  );
  git(repository, ['remote', 'add', 'origin', POLICY.repository.origin]);
  git(repository, ['add', 'workflow/maintainer-policy.json']);
  git(repository, ['commit', '-m', 'Add fixture maintainer policy']);
  return repository;
}

export function sameProviderRequest(
  repository: string,
): CollaborationGrantRequest {
  const baselineCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  return {
    changeId: 'demo-change',
    taskId: null,
    baselineCommit,
    baselineTree: git(repository, [
      'rev-parse',
      `${baselineCommit}^{tree}`,
    ]).trim(),
    targetDigest: TARGET_DIGEST,
    lifecyclePhase: 'blind-survey',
    rolePair: {
      authorRole: 'investigation-author',
      conflictingRole: 'plan-reviewer',
    },
    availableActor: {
      kind: 'provider',
      providerId: 'codex',
      assurance: 'runtime-hint',
    },
    degradedForm: 'same-provider-fresh-session',
    reason: 'No alternate provider is callable for this exact survey.',
    ttlMinutes: 30,
    maxUses: 1,
  };
}

export function expectedBinding(
  envelope: CollaborationGrantEnvelope,
): CollaborationGrantExpectedBinding {
  const payload = envelope.payload;
  return {
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    policyBlob: payload.policyBlob,
    collaborationPolicyDigest: payload.collaborationPolicyDigest,
    changeId: payload.changeId,
    taskId: payload.taskId,
    baselineCommit: payload.baselineCommit,
    baselineTree: payload.baselineTree,
    targetDigest: payload.targetDigest,
    lifecyclePhase: payload.lifecyclePhase,
    rolePair: payload.rolePair,
    availableActor: payload.availableActor,
    degradedForm: payload.degradedForm,
    reason: payload.reason,
  };
}

export function fixtureSigner(
  namespaces: string[] = [],
): MaintainerSignerProvider {
  return SSH_SIGNING.signer(namespaces);
}

export function fixtureSignature(payload: string, namespace: string): string {
  return SSH_SIGNING.sign(payload, namespace);
}

export function vectorSigner(
  namespaces: string[] = [],
): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign(payload, namespace) {
      assert.ok(namespace);
      namespaces.push(namespace);
      return vectorSignature(payload, namespace);
    },
    verify(payload, signature, identity, namespace) {
      assert.ok(namespace);
      namespaces.push(namespace);
      if (
        identity !== 'fixture-maintainer' ||
        signature !== vectorSignature(payload, namespace)
      ) {
        const error = new Error('invalid collaboration signature') as Error & {
          code: string;
        };
        error.code = 'MAINTAINER_SIGNATURE_INVALID';
        throw error;
      }
    },
  };
}

export function vectorSignature(payload: string, namespace: string): string {
  const encoded = crypto
    .createHash('sha256')
    .update(`${namespace}\0${payload}`)
    .digest('base64');
  return [
    '-----BEGIN SSH SIGNATURE-----',
    encoded,
    '-----END SSH SIGNATURE-----',
    '',
  ].join('\n');
}

export function reservedFixture(
  degradedForm:
    'same-provider-fresh-session' | 'caller-supplied' | 'direct-human-review',
) {
  const repository = collaborationFixture();
  const grantId =
    degradedForm === 'same-provider-fresh-session'
      ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      : degradedForm === 'caller-supplied'
        ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
        : 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const namespaces: string[] = [];
  const signer = fixtureSigner(namespaces);
  const base = sameProviderRequest(repository);
  const request: CollaborationGrantRequest =
    degradedForm === 'same-provider-fresh-session'
      ? base
      : degradedForm === 'caller-supplied'
        ? {
            ...base,
            availableActor: {
              kind: 'caller',
              callerId: 'fixture-caller',
              assurance: 'self-declared',
            },
            degradedForm,
          }
        : {
            ...base,
            lifecyclePhase: 'plan-review',
            rolePair: {
              authorRole: 'plan-author',
              conflictingRole: 'plan-reviewer',
            },
            availableActor: {
              kind: 'direct-human',
              identity: 'fixture-maintainer',
              assurance: 'maintainer-signed',
            },
            degradedForm,
          };
  const issued = issueCollaborationGrant(repository, request, {
    now: NOW,
    grantId,
    signer,
  });
  const common = fs.realpathSync(path.join(repository, '.git'));
  const verifier = authoritativeCollaborationGrantVerifierForTest(signer);
  const reservation = reserveCollaborationGrant(repository, grantId, {
    transitionDigest: TRANSITION_DIGEST,
    now: new Date(NOW.getTime() + 60_000),
    expected: expectedBinding(issued.envelope),
    verifier,
  });
  return {
    repository,
    common,
    grantId,
    signer,
    verifier,
    namespaces,
    reservation,
    cleanup() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

export function collaborationCliArguments(
  cli: string,
  request: CollaborationGrantRequest,
): string[] {
  if (request.availableActor.kind !== 'provider') {
    throw new Error('fixture expects provider actor');
  }
  return [
    '--experimental-strip-types',
    cli,
    'maintainer',
    'collaboration-grant',
    '--change',
    request.changeId,
    '--base',
    request.baselineCommit,
    '--target',
    request.targetDigest,
    '--phase',
    request.lifecyclePhase,
    '--author-role',
    request.rolePair.authorRole,
    '--conflicting-role',
    request.rolePair.conflictingRole,
    '--provider',
    request.availableActor.providerId,
    '--actor-assurance',
    request.availableActor.assurance,
    '--degraded',
    request.degradedForm,
    '--reason',
    request.reason,
    '--ttl',
    '30m',
    '--uses',
    '1',
    '--json',
  ];
}

export function snapshotGrantStore(root: string): Array<{
  path: string;
  mode: number;
  content: string;
}> {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files.map((absolute) => ({
    path: path.relative(root, absolute),
    mode: fs.lstatSync(absolute).mode & 0o777,
    content: fs.readFileSync(absolute, 'utf8'),
  }));
}
