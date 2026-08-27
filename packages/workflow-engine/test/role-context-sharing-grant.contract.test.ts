import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  bindingFromRoleContextSharingGrantPayloadV1,
  type RoleContextSharingGrantEnvelopeV1,
  type RoleContextSharingGrantPayloadV1,
} from '@jigwright/grants/role-context-sharing-degradation';

import {
  ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1,
  LEGACY_ROLE_CONTEXT_SHARING_POLICY_DIGEST,
  ROLE_CONTEXT_SHARING_POLICY_DIGEST,
  executeRoleContextSharingGrantTransitionV1,
  verifyRoleContextSharingGrantCapability,
  type RoleContextSharingEligibilityPortV1,
} from '../src/modules/authority/role-context-sharing-grant.ts';
import {
  sealAuthoritativeRoleContextSharingGrantVerifier,
  type AuthoritativeRoleContextSharingGrantVerifier,
} from '../src/modules/authority/role-context-sharing-grant-verifier-port.ts';
import type { GrantVerifierPort } from '../src/modules/authority/grant-verifier-port.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import type { GrantLifecycleState } from '@jigwright/grants/grant-lifecycle';
import { isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-21T00:01:00.000Z');
const ELIGIBILITY_DIGEST = '5'.repeat(64);

const POLICY: MaintainerPolicy = {
  schemaVersion: 1,
  repository: {
    id: 'github:R_fixture',
    origin: 'https://github.com/example/fixture.git',
  },
  phase: 'sealed',
  auditTagPrefix: 'refs/tags/workflow-grant/',
  signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: ['workflow/protected-capabilities.json'],
  sealedImmutablePaths: ['workflow/protected-capabilities.json'],
  requiredChecks: ['fixture'],
  trustedSigners: [
    {
      identity: 'fixture-maintainer',
      publicKey:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
      fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
    },
  ],
};

const payload: RoleContextSharingGrantPayloadV1 = {
  version: 1,
  signatureNamespace: ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  repositoryId: POLICY.repository.id,
  repositoryOrigin: POLICY.repository.origin,
  policyBlob: 'a'.repeat(40),
  roleContextSharingPolicyDigest: ROLE_CONTEXT_SHARING_POLICY_DIGEST,
  centralRoleConfigurationDigest: '2'.repeat(64),
  changeOverrideDigest: '3'.repeat(64),
  providerRegistryDigest: '4'.repeat(64),
  eligibilityPolicyDigest: ELIGIBILITY_DIGEST,
  changeId: 'eligible-change',
  taskId: null,
  baselineCommit: 'b'.repeat(40),
  baselineTree: 'c'.repeat(40),
  targetDigest: '6'.repeat(64),
  lifecyclePhase: 'plan-review',
  subjectDigest: '7'.repeat(64),
  planningGeneration: '9'.repeat(64),
  rolePairs: ['author-builder', 'author-reviewer', 'builder-reviewer'],
  contextGeneration: 4,
  sessionGeneration: 5,
  sharedEngineSessionId: 'session-vector-0001',
  providerDefinitionDigest: '8'.repeat(64),
  authorizedEffect: ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  reason: 'Exact three-role session sharing is explicitly approved.',
  issuedAt: '2026-08-21T00:00:00.000Z',
  expiresAt: '2026-08-21T00:30:00.000Z',
  maxUses: 1,
  signer: 'fixture-maintainer',
};

const envelope: RoleContextSharingGrantEnvelopeV1 = {
  payload,
  signature: 'fixture-signature',
};

function authoritativeVerifier(
  verifier: GrantVerifierPort,
): AuthoritativeRoleContextSharingGrantVerifier {
  return sealAuthoritativeRoleContextSharingGrantVerifier(
    {
      assertCurrent() {},
      verify: verifier.verify.bind(verifier),
    },
    `sha256:${'0'.repeat(64)}`,
  );
}

test('one exact three-pair envelope reserves and consumes exactly once', () => {
  let state: GrantLifecycleState = 'available';
  const transitions: string[] = [];
  const namespaces: string[] = [];
  let eligibilityChecks = 0;
  const options = {
    now: NOW,
    expected: bindingFromRoleContextSharingGrantPayloadV1(payload),
    verifier: authoritativeVerifier({
      verify(
        _bytes: string,
        _signature: string,
        _signer: string,
        namespace: string,
      ) {
        namespaces.push(namespace);
      },
    }),
    eligibility: eligibilityPort(() => {
      eligibilityChecks += 1;
    }),
  };
  const storage = {
    readState: () => state,
    applyTransition(input: {
      receipt: { toState: GrantLifecycleState };
      receiptDigest: string;
      validation: unknown;
    }) {
      transitions.push(input.receipt.toState);
      state = input.receipt.toState;
      return input.receipt.toState;
    },
  };

  const reserved = executeRoleContextSharingGrantTransitionV1(
    { envelope, policy: POLICY, options, event: 'reserve' },
    { clock: { now: () => NOW }, storage },
  );
  const consumed = executeRoleContextSharingGrantTransitionV1(
    { envelope, policy: POLICY, options, event: 'consume' },
    { clock: { now: () => NOW }, storage },
  );

  assert.equal(reserved.receipt.toState, 'reserved');
  assert.equal(consumed.receipt.toState, 'consumed');
  assert.deepEqual(transitions, ['reserved', 'consumed']);
  assert.deepEqual(namespaces, [
    ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
    ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  ]);
  assert.equal(eligibilityChecks, 2);

  assert.throws(
    () =>
      executeRoleContextSharingGrantTransitionV1(
        { envelope, policy: POLICY, options, event: 'consume' },
        { clock: { now: () => NOW }, storage },
      ),
    (error) =>
      error instanceof Error && error.name === 'GrantLifecycleTransitionError',
  );
  assert.deepEqual(transitions, ['reserved', 'consumed']);
});

test('missing or unlisted eligibility fails closed before signature verification', () => {
  let verifierCalls = 0;
  const base = {
    now: NOW,
    expected: bindingFromRoleContextSharingGrantPayloadV1(payload),
    verifier: authoritativeVerifier({
      verify() {
        verifierCalls += 1;
      },
    }),
  };

  assert.throws(
    () =>
      verifyRoleContextSharingGrantCapability(envelope, POLICY, {
        ...base,
        eligibility: undefined as never,
      }),
    (error) => isWorkflowError(error, 'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE'),
  );
  assert.throws(
    () =>
      verifyRoleContextSharingGrantCapability(envelope, POLICY, {
        ...base,
        eligibility: eligibilityPort(() => {
          throw new Error('not listed');
        }),
      }),
    (error) => isWorkflowError(error, 'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE'),
  );
  assert.equal(verifierCalls, 0);
});

test('current grant validation rejects legacy and unknown policy digests', () => {
  const legacyPayload = {
    ...payload,
    roleContextSharingPolicyDigest: LEGACY_ROLE_CONTEXT_SHARING_POLICY_DIGEST,
  };
  const legacyEnvelope = { ...envelope, payload: legacyPayload };
  let verifierCalls = 0;
  const common = {
    now: NOW,
    eligibility: eligibilityPort(() => {}),
    verifier: authoritativeVerifier({
      verify() {
        verifierCalls += 1;
      },
    }),
  };
  assert.throws(
    () =>
      verifyRoleContextSharingGrantCapability(legacyEnvelope, POLICY, {
        ...common,
        expected: bindingFromRoleContextSharingGrantPayloadV1(legacyPayload),
      }),
    (error) =>
      isWorkflowError(error, 'ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH'),
  );
  assert.throws(
    () => {
      const unknownPayload = {
        ...payload,
        roleContextSharingPolicyDigest: 'f'.repeat(64),
      };
      verifyRoleContextSharingGrantCapability(
        { ...envelope, payload: unknownPayload },
        POLICY,
        {
          ...common,
          expected: bindingFromRoleContextSharingGrantPayloadV1(unknownPayload),
        },
      );
    },
    (error) =>
      isWorkflowError(error, 'ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH'),
  );
  assert.equal(verifierCalls, 0);
});

test('configuration, registry, policy, subject, session, and provider-definition drift all fail closed', () => {
  const expected = bindingFromRoleContextSharingGrantPayloadV1(payload);
  const mutations: Array<Partial<typeof expected>> = [
    { centralRoleConfigurationDigest: '9'.repeat(64) },
    { changeOverrideDigest: '9'.repeat(64) },
    { providerRegistryDigest: '9'.repeat(64) },
    { eligibilityPolicyDigest: '9'.repeat(64) },
    { subjectDigest: '9'.repeat(64) },
    { contextGeneration: 9 },
    { sessionGeneration: 9 },
    { sharedEngineSessionId: 'another-session' },
    { providerDefinitionDigest: '9'.repeat(64) },
  ];
  let verifierCalls = 0;
  for (const mutation of mutations) {
    assert.throws(
      () =>
        verifyRoleContextSharingGrantCapability(envelope, POLICY, {
          now: NOW,
          expected: { ...expected, ...mutation },
          eligibility: eligibilityPort(() => {}),
          verifier: authoritativeVerifier({
            verify() {
              verifierCalls += 1;
            },
          }),
        }),
      (error) =>
        isWorkflowError(error, 'ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH'),
    );
  }
  assert.equal(verifierCalls, 0);
});

test('a raw role-context-sharing verifier is rejected before eligibility or signature work', () => {
  let verifierCalls = 0;
  let eligibilityCalls = 0;
  assert.throws(
    () =>
      verifyRoleContextSharingGrantCapability(envelope, POLICY, {
        now: NOW,
        expected: bindingFromRoleContextSharingGrantPayloadV1(payload),
        verifier: {
          verify() {
            verifierCalls += 1;
          },
        } as never,
        eligibility: eligibilityPort(() => {
          eligibilityCalls += 1;
        }),
      }),
    (error) =>
      isWorkflowError(
        error,
        'ROLE_CONTEXT_SHARING_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
      ),
  );
  assert.equal(verifierCalls, 0);
  assert.equal(eligibilityCalls, 0);
});

function eligibilityPort(
  assertEligible: RoleContextSharingEligibilityPortV1['assertEligible'],
): RoleContextSharingEligibilityPortV1 {
  return {
    contractVersion: ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1,
    policyDigest: ELIGIBILITY_DIGEST,
    assertEligible,
  };
}
