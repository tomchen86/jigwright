import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  COLLABORATION_GRANT_POLICY_DIGEST,
  TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import {
  createAuthoritativeCollaborationGrantVerifier,
  createCurrentAuthoritativeRoleContextSharingGrantVerifier,
} from '../src/composition-root/grant-verifier-composition.ts';
import { loadProtectedCapabilitiesFromWorktree } from '../src/adapters/consumer/repository/work-registry/protected-capabilities.ts';
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
  'packages/core/src/built-in-provider-definition.ts',
  'packages/core/src/canonical-json.ts',
  'packages/core/src/collaboration-grant-envelope-codec.ts',
  'packages/core/src/grant-envelope-contracts.ts',
  'packages/core/src/grant-lifecycle-contracts.ts',
  'packages/core/src/role-context-sharing-grant-codec.ts',
  'packages/core/src/signed-attestation-envelope-codec.ts',
  'packages/grants/package.json',
  'packages/grants/src/collaboration-grant-envelope-reader.ts',
  'packages/grants/src/grant-envelope-verifier.ts',
  'packages/grants/src/grant-lifecycle.ts',
  'packages/grants/src/role-context-sharing-degradation.ts',
  'packages/grants/src/signed-attestation-envelope-reader.ts',
  'packages/workflow-engine/src/adapters/planning/openspec/documents/managed-change-contract.ts',
  'packages/workflow-engine/src/adapters/signing/ssh/maintainer-signer.ts',
  'packages/workflow-engine/src/application/propose/plan-review-role-topology.ts',
  'packages/workflow-engine/src/application/propose/role-context-sharing-plan-review.ts',
  'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
  'packages/workflow-engine/src/composition-root/role-admission-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-grant-approval-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-grant-lifecycle-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-terminal-receipt-production.ts',
  'packages/workflow-engine/src/composition-root/role-topology-resolution-production.ts',
  'packages/workflow-engine/src/composition-root/validated-contract-context.ts',
  'packages/workflow-engine/src/application/assurance/base-authority-attestation.ts',
  'packages/workflow-engine/src/modules/assurance/commit-replay/ci-planning.ts',
  'packages/workflow-engine/src/runtime/repository-validation/commit-replay/ci-planning.ts',
  'packages/workflow-engine/src/runtime/repository-validation/commit-replay/services.ts',
  'packages/workflow-engine/src/composition-root/ci-replay-production.ts',
  'packages/workflow-engine/src/application/assurance/pull-request-verification.ts',
  'packages/workflow-engine/src/entrypoints/cli/role-context-sharing-grant-cli.ts',
  'packages/workflow-engine/src/modules/assurance/planning-assurance-validator.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-codec.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-records.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-use.ts',
  'packages/workflow-engine/src/modules/authority/grant-errors.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-consumed-replay.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-lifecycle-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-verifier-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/agent-role-plan.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-admission-contracts.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-scheduler.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-topology-resolution.ts',
  'packages/workflow-engine/src/runtime/grants/collaboration-grant-issuance.ts',
  'packages/workflow-engine/src/runtime/grants/grant-services.ts',
  'packages/workflow-engine/src/runtime/grants/optional-grants-package.ts',
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

test('sealed package-integrity composition gates current V2 verification with no unsealed fallback', () => {
  const manifest = loadProtectedCapabilitiesFromWorktree(sourceRepositoryRoot);
  const composition = manifest.grantVerifierComposition;
  assert.ok(composition);
  assert.deepEqual(composition.signatureNamespaces, [
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
  const readSource = (name: string, owner = 'runtime/storage-journal') =>
    fs.readFileSync(
      path.join(
        sourceRepositoryRoot,
        `packages/workflow-engine/src/${owner}/collaboration-grant-${name}.ts`,
      ),
      'utf8',
    );
  const source = readSource('revocation', 'application/control-plane');
  const revocationStoreSource = readSource('revocation-store');
  const productionSource = readSource('production', 'composition-root');
  const reservationSource = readSource('reservation');
  const consumptionSource = readSource('consumption');
  const recordsSource = readSource('records');
  const section = (text: string, startMarker: string, endMarker: string) => {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker, start);
    assert.ok(
      start >= 0 && end > start,
      `missing source section: ${startMarker}`,
    );
    return text.slice(start, end);
  };
  const reserve = section(
    reservationSource,
    'export function reserveCollaborationGrantUnderLifecycleLock',
    'export function selectAndReserveCollaborationGrantUnderLifecycleLock',
  );
  const consume = section(
    consumptionSource,
    'export function consumeCollaborationGrantUnderLifecycleLock',
    'export function readExactConsumedCollaborationGrantUse',
  );
  const revoke = section(
    source,
    'function revokeCollaborationGrant',
    'return revokeCollaborationGrant;',
  );
  const inspect = section(
    recordsSource,
    'export function inspectCollaborationGrants',
    'export function readAvailable',
  );

  assert.match(
    productionSource,
    /export const revokeCollaborationGrant = createCollaborationGrantRevoker\(\{[\s\S]*?withStoreLock: withCollaborationRevocationStore/,
  );
  assert.match(
    productionSource,
    /import\s*\{\s*withCollaborationRevocationStore\s*\}\s*from '\.\.\/runtime\/storage-journal\/collaboration-grant-revocation-store\.ts'/,
  );
  assert.match(
    revocationStoreSource,
    /assertTarget:\s*\(envelope, now\)\s*=>\s*assertIndependentHumanRevocationTarget\(repositoryRoot, envelope, now\)/,
  );

  assert.doesNotMatch(
    [
      source,
      revocationStoreSource,
      reservationSource,
      consumptionSource,
      recordsSource,
      readSource('private-files'),
      ...['records', 'values', 'use'].map((name) =>
        readSource(name, 'modules/authority'),
      ),
    ].join('\n'),
    /composition-root\/grant-verifier-composition/,
    'runtime storage must receive an opaque authoritative verifier instead of importing the composition root',
  );

  assert.match(reserve, /assertAuthoritativeCollaborationGrantVerifier/);
  assert.match(consume, /assertAuthoritativeCollaborationGrantVerifier/);
  assert.match(reserve, /verifier\.assertCurrent\(\)/);
  assert.match(consume, /verifier\.assertCurrent\(\)/);
  assert.match(consume, /verifyCollaborationGrantCapability/);
  for (const operation of [reserve, consume]) {
    assert.match(operation, /if \(fs\.existsSync\(terminalPath\)\)/);
  }
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
  assert.match(revoke, /store\.assertTarget\(/);
  assert.ok(
    revoke.indexOf('store.assertTarget(') <
      revoke.indexOf('services.authorizeHumanRevocation('),
    'independent target admission must precede human revocation authorization',
  );
  assert.doesNotMatch(revoke, /authoritativeVerifier/);
  assert.doesNotMatch(revoke, /verifyCollaborationGrantCapability/);
  assert.doesNotMatch(inspect, /authoritativeVerifier/);
  assert.doesNotMatch(inspect, /verifyCollaborationGrantCapability/);
  for (const operation of [revoke, inspect]) {
    assert.doesNotMatch(
      operation,
      /assertAuthoritativeCollaborationGrantVerifier|\.assertCurrent\(/,
    );
  }
});

test('authority-plan and sealed recovery retain an independent repair path', () => {
  for (const filePath of [
    'packages/workflow-engine/src/application/control-plane/authority-plan.ts',
    'packages/workflow-engine/src/application/control-plane/maintainer-recovery.ts',
    'packages/workflow-engine/src/modules/authority/control-plane-recovery-grant.ts',
    'packages/workflow-engine/src/modules/authority/control-plane-recovery-grant-values.ts',
    'packages/workflow-engine/src/modules/authority/control-plane-recovery-grant-records.ts',
    'packages/workflow-engine/src/runtime/storage-journal/control-plane-recovery-grant.ts',
    'packages/workflow-engine/src/runtime/storage-journal/control-plane-recovery-grant-storage.ts',
    'packages/workflow-engine/src/application/control-plane/control-plane-updater-recovery.ts',
    'packages/workflow-engine/src/application/control-plane/harness-bootstrap-production.ts',
    'packages/workflow-engine/src/application/control-plane/harness-bootstrap-recovery-commands.ts',
    'packages/workflow-engine/src/composition-root/harness-bootstrap-production.ts',
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
