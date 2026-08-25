import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
  ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  RoleContextSharingGrantError,
  bindingFromRoleContextSharingGrantPayloadV1,
  canonicalRoleContextSharingGrantEnvelopeV1,
  canonicalRoleContextSharingGrantPayloadV1,
  parseRoleContextSharingGrantEnvelopeV1,
  verifyRoleContextSharingGrantCapabilityV1,
  type RoleContextSharingGrantEnvelopeV1,
  type RoleContextSharingGrantPayloadV1,
} from '../src/role-context-sharing-degradation.ts';

const payload: RoleContextSharingGrantPayloadV1 = {
  version: 1,
  signatureNamespace: ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  repositoryId: 'github:R_fixture',
  repositoryOrigin: 'https://github.com/example/fixture.git',
  policyBlob: 'a'.repeat(40),
  roleContextSharingPolicyDigest: '1'.repeat(64),
  centralRoleConfigurationDigest: '2'.repeat(64),
  changeOverrideDigest: '3'.repeat(64),
  providerRegistryDigest: '4'.repeat(64),
  eligibilityPolicyDigest: '5'.repeat(64),
  changeId: 'vector-change',
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

const vector = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/role-context-sharing-grant-v1.vector.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  schemaVersion: number;
  signatureNamespace: string;
  canonicalPayload: string;
  canonicalEnvelope: string;
  envelopeDigest: string;
};

test('preserves exact V1 bytes and verifies one canonical nonempty role-pair set', () => {
  const verifierCalls: unknown[][] = [];
  let domainValidations = 0;
  const raw = canonicalRoleContextSharingGrantEnvelopeV1(envelope);
  const verified = verifyRoleContextSharingGrantCapabilityV1({
    readerContractVersion:
      ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
    raw,
    expected: bindingFromRoleContextSharingGrantPayloadV1(payload),
    validatePayload(candidate) {
      domainValidations += 1;
      assert.deepEqual(candidate, payload);
    },
    verifier: {
      verify(...input) {
        verifierCalls.push(input);
      },
    },
  });

  assert.equal(
    canonicalRoleContextSharingGrantPayloadV1(payload),
    vector.canonicalPayload,
  );
  assert.equal(vector.schemaVersion, 1);
  assert.equal(
    vector.signatureNamespace,
    ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  );
  assert.equal(raw, vector.canonicalEnvelope);
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    vector.envelopeDigest,
  );
  assert.deepEqual(parseRoleContextSharingGrantEnvelopeV1(raw), envelope);
  assert.deepEqual(verified.envelope, envelope);
  assert.equal(
    verified.verification.receipt.authorizedEffect,
    'role-context-sharing-degradation',
  );
  assert.equal(domainValidations, 1);
  assert.deepEqual(verifierCalls, [
    [
      canonicalRoleContextSharingGrantPayloadV1(payload),
      envelope.signature,
      payload.signer,
      ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
    ],
  ]);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.envelope.payload.rolePairs), true);
});

test('rejects unknown schemas, effects, namespaces, malformed bindings, and noncanonical pair sets before verification', () => {
  let verifierCalls = 0;
  const invalidPayloads: Array<Record<string, unknown>> = [
    { ...payload, version: 2 },
    {
      ...payload,
      signatureNamespace: 'workflow.role-context-sharing-grant.v2',
    },
    { ...payload, authorizedEffect: 'role-independence-degradation-only' },
    { ...payload, rolePairs: [] },
    { ...payload, rolePairs: ['author-builder', 'author-builder'] },
    { ...payload, rolePairs: ['builder-reviewer', 'author-builder'] },
    { ...payload, rolePairs: ['author-builder', 'unknown-pair'] },
    { ...payload, sessionGeneration: 0 },
    { ...payload, planningGeneration: 3 },
    { ...payload, providerDefinitionDigest: 'not-a-digest' },
    { ...payload, executable: '/bin/sh' },
  ];

  for (const invalidPayload of invalidPayloads) {
    const raw = `${JSON.stringify({ payload: invalidPayload, signature: envelope.signature })}\n`;
    assert.throws(
      () =>
        verifyRoleContextSharingGrantCapabilityV1({
          readerContractVersion:
            ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
          raw,
          expected: bindingFromRoleContextSharingGrantPayloadV1(payload),
          validatePayload() {
            throw new Error('domain validation must not run');
          },
          verifier: {
            verify() {
              verifierCalls += 1;
            },
          },
        }),
      (error) => error instanceof RoleContextSharingGrantError,
    );
  }

  const wrongBinding = {
    ...bindingFromRoleContextSharingGrantPayloadV1(payload),
    sessionGeneration: payload.sessionGeneration + 1,
  };
  assert.throws(
    () =>
      verifyRoleContextSharingGrantCapabilityV1({
        readerContractVersion:
          ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
        raw: canonicalRoleContextSharingGrantEnvelopeV1(envelope),
        expected: wrongBinding,
        validatePayload() {
          throw new Error('domain validation must not run');
        },
        verifier: {
          verify() {
            verifierCalls += 1;
          },
        },
      }),
    isRoleContextError('ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH'),
  );
  assert.equal(verifierCalls, 0);
});

test('rejects noncanonical envelope bytes and verifier refusal without namespace fallback', () => {
  const raw = canonicalRoleContextSharingGrantEnvelopeV1(envelope);
  assert.throws(
    () => parseRoleContextSharingGrantEnvelopeV1(` ${raw}`),
    isRoleContextError('ROLE_CONTEXT_SHARING_GRANT_NON_CANONICAL'),
  );

  const namespaces: string[] = [];
  assert.throws(
    () =>
      verifyRoleContextSharingGrantCapabilityV1({
        readerContractVersion:
          ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
        raw,
        expected: bindingFromRoleContextSharingGrantPayloadV1(payload),
        validatePayload() {},
        verifier: {
          verify(_bytes, _signature, _signer, namespace) {
            namespaces.push(namespace);
            throw new Error('fixture rejection');
          },
        },
      }),
    isRoleContextError('ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_INVALID'),
  );
  assert.deepEqual(namespaces, [
    ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  ]);
});

function isRoleContextError(code: string) {
  return (error: unknown): boolean =>
    error instanceof RoleContextSharingGrantError && error.code === code;
}
