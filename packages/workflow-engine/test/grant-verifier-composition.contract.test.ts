import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  COLLABORATION_GRANT_POLICY_DIGEST,
  TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST,
} from '../src/modules/authority/collaboration-grant.ts';
import {
  createAuthoritativeCollaborationGrantVerifier,
  createCurrentAuthoritativeRoleContextSharingGrantVerifier,
} from '../src/composition-root/grant-verifier-composition.ts';
import { loadProtectedCapabilitiesFromWorktree } from '../src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import { isWorkflowError, sourceRepositoryRoot } from './fixture.ts';
import { createSshSignedFixture } from './support/ssh-signed-fixture.ts';

const POLICY_DIGESTS = {
  collaborationPolicyDigest: COLLABORATION_GRANT_POLICY_DIGEST,
  taskDiffReviewPolicyDigest: TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST,
};
const SSH_SIGNING = createSshSignedFixture('fixture-maintainer');
const POLICY = { trustedSigners: [SSH_SIGNING.trustedSigner] };
const ROLE_CONTEXT_SHARING_PROTECTED_SOURCE_PATHS = [
  'packages/agent-runtime/package.json',
  'packages/agent-runtime/src/built-in-provider-definition.ts',
  'packages/agent-runtime/src/index.ts',
  'packages/agent-runtime/src/provider-definition-snapshot.ts',
  'packages/core/package.json',
  'packages/core/src/canonical-json.ts',
  'packages/grants/package.json',
  'packages/grants/src/grant-envelope-verifier.ts',
  'packages/grants/src/grant-lifecycle.ts',
  'packages/grants/src/role-context-sharing-degradation.ts',
  'packages/workflow-engine/src/adapters/planning/openspec/documents/managed-change-contract.ts',
  'packages/workflow-engine/src/adapters/providers/built-in-provider-definition.ts',
  'packages/workflow-engine/src/adapters/signing/ssh/maintainer-signer.ts',
  'packages/workflow-engine/src/application/propose/plan-review-role-topology.ts',
  'packages/workflow-engine/src/application/propose/role-context-sharing-plan-review.ts',
  'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-grant-approval-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-grant-lifecycle-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-terminal-receipt-production.ts',
  'packages/workflow-engine/src/composition-root/role-topology-resolution-production.ts',
  'packages/workflow-engine/src/composition-root/validated-contract-context.ts',
  'packages/workflow-engine/src/entrypoints/ci/ci-attestation.ts',
  'packages/workflow-engine/src/entrypoints/ci/ci-planning.ts',
  'packages/workflow-engine/src/entrypoints/ci/ci.ts',
  'packages/workflow-engine/src/entrypoints/cli/role-context-sharing-grant-cli.ts',
  'packages/workflow-engine/src/modules/assurance/planning-assurance-validator.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-consumed-replay.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-lifecycle-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-verifier-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/agent-role-plan.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-scheduler.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-topology-resolution.ts',
  'packages/workflow-engine/src/runtime/repository-transaction/agent-role-plan-store.ts',
  'packages/workflow-engine/src/runtime/storage-journal/role-context-sharing-store.ts',
] as const;
after(() => SSH_SIGNING.dispose());

test('R-007 verifier currentness pins the exact production authority source closure', () => {
  const source = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
    ),
    'utf8',
  );
  const start = source.indexOf(
    'const REQUIRED_ROLE_CONTEXT_SHARING_SOURCES = Object.freeze([',
  );
  const end = source.indexOf('] as const);', start);
  assert.ok(start >= 0 && end > start);
  const declared = [...source.slice(start, end).matchAll(/'([^']+)'/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(declared, ROLE_CONTEXT_SHARING_PROTECTED_SOURCE_PATHS);
});

test('sealed package-integrity composition gates V1/V2 verification with no unsealed fallback', () => {
  const manifest = loadProtectedCapabilitiesFromWorktree(sourceRepositoryRoot);
  const composition = manifest.grantVerifierComposition;
  assert.ok(composition);
  assert.deepEqual(composition.signatureNamespaces, [
    'expense-app.workflow.collaboration-grant.v1',
    'workflow.collaboration-grant.v2',
  ]);
  assert.deepEqual(composition.authorizedEffects, [
    'role-independence-degradation-only',
  ]);
  assert.equal(
    composition.repairAuthority,
    'human-only-authority-plan-or-sealed-recovery',
  );
  const namespace = composition.signatureNamespaces[0];
  const payload = 'sealed verifier composition payload\n';
  const signature = SSH_SIGNING.sign(payload, namespace);
  const verifier = createAuthoritativeCollaborationGrantVerifier(
    POLICY,
    POLICY_DIGESTS,
  );
  verifier.verify(
    payload,
    signature,
    SSH_SIGNING.trustedSigner.identity,
    namespace,
  );
  assert.equal(verifier.compositionDigest, composition.compositionDigest);
  assert.throws(
    () =>
      verifier.verify(
        `${payload}tampered`,
        signature,
        SSH_SIGNING.trustedSigner.identity,
        namespace,
      ),
    (error) => isWorkflowError(error, 'MAINTAINER_SIGNATURE_INVALID'),
  );

  const oldAlwaysTrueVerifier = { verify() {} };
  type OldVerifierIsNotPolicy = typeof oldAlwaysTrueVerifier extends Parameters<
    typeof createAuthoritativeCollaborationGrantVerifier
  >[0]
    ? never
    : true;
  const oldVerifierIsNotPolicy: OldVerifierIsNotPolicy = true;
  assert.equal(oldVerifierIsNotPolicy, true);
  assert.throws(
    () =>
      createAuthoritativeCollaborationGrantVerifier(
        oldAlwaysTrueVerifier as unknown as Parameters<
          typeof createAuthoritativeCollaborationGrantVerifier
        >[0],
        POLICY_DIGESTS,
      ),
    (error) =>
      isWorkflowError(
        error,
        'COLLABORATION_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
      ),
  );

  assert.throws(
    () =>
      createAuthoritativeCollaborationGrantVerifier(POLICY, {
        ...POLICY_DIGESTS,
        collaborationPolicyDigest: '0'.repeat(64),
      }),
    (error) =>
      isWorkflowError(
        error,
        'COLLABORATION_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
      ),
  );
});

test('current protected composition mints only the exact role-context-sharing authority', () => {
  assert.doesNotThrow(() =>
    createCurrentAuthoritativeRoleContextSharingGrantVerifier(POLICY),
  );
});

test('reserve and consume are composition-gated while inspect and human-only revoke remain independent', () => {
  const source = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-store.ts',
    ),
    'utf8',
  );
  const reserve = source.slice(
    source.indexOf(
      'export function reserveCollaborationGrantUnderLifecycleLock',
    ),
    source.indexOf(
      'export function selectAndReserveCollaborationGrantUnderLifecycleLock',
    ),
  );
  const consume = source.slice(
    source.indexOf(
      'export function consumeCollaborationGrantUnderLifecycleLock',
    ),
    source.indexOf('export function readExactConsumedCollaborationGrantUse'),
  );
  const revoke = source.slice(
    source.indexOf('export function revokeCollaborationGrant'),
    source.indexOf('function readCollaborationRevocationTarget'),
  );
  const inspect = source.slice(
    source.indexOf('export function inspectCollaborationGrants'),
    source.indexOf('function ensureStoreDirectories'),
  );

  assert.doesNotMatch(
    source,
    /composition-root\/grant-verifier-composition/,
    'runtime storage must receive an opaque authoritative verifier instead of importing the composition root',
  );

  assert.match(reserve, /assertAuthoritativeCollaborationGrantVerifier/);
  assert.match(consume, /assertAuthoritativeCollaborationGrantVerifier/);
  assert.match(reserve, /verifier\.assertCurrent\(\)/);
  assert.match(consume, /verifier\.assertCurrent\(\)/);
  assert.match(consume, /verifyCollaborationGrantCapability/);
  assert.ok(
    reserve.indexOf('if (fs.existsSync(terminalPath))') <
      reserve.indexOf('assertAuthoritativeCollaborationGrantVerifier'),
    'terminal cleanup must remain reachable before composition enforcement',
  );
  assert.ok(
    consume.indexOf('if (fs.existsSync(terminalPath))') <
      consume.indexOf('assertAuthoritativeCollaborationGrantVerifier'),
    'consumed replay must remain reachable before composition enforcement',
  );
  assert.ok(
    reserve.indexOf('verifier.assertCurrent()') <
      reserve.indexOf('executeGrantLifecycleTransitionV1'),
    'reserve must reject drift before the lifecycle can mutate its journal',
  );
  assert.ok(
    consume.indexOf('verifier.assertCurrent()') <
      consume.indexOf('executeGrantLifecycleTransitionV1'),
    'consume must reject drift before the lifecycle can mutate its journal',
  );
  assert.match(revoke, /assertIndependentHumanRevocationTarget/);
  assert.doesNotMatch(revoke, /authoritativeVerifier/);
  assert.doesNotMatch(revoke, /verifyCollaborationGrantCapability/);
  assert.doesNotMatch(inspect, /authoritativeVerifier/);
  assert.doesNotMatch(inspect, /verifyCollaborationGrantCapability/);
});

test('authority-plan and sealed recovery retain an independent repair path', () => {
  for (const filePath of [
    'packages/workflow-engine/src/application/control-plane/authority-plan.ts',
    'packages/workflow-engine/src/application/control-plane/maintainer-recovery.ts',
    'packages/workflow-engine/src/modules/authority/control-plane-recovery-grant.ts',
    'packages/workflow-engine/src/application/control-plane/intervention-control-updater.ts',
  ]) {
    const source = fs.readFileSync(
      path.join(sourceRepositoryRoot, filePath),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /collaboration-grant-store|collaboration-grant\.ts/,
    );
  }
});
