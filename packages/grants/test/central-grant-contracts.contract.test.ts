import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CENTRAL_GRANT_PUBLIC_CONTRACT_VERSION,
  assertCentralGrantPublicDocumentV1,
} from '../src/central-grant-contracts.ts';
import {
  COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  canonicalCollaborationGrantEnvelopeBytesV1,
  type CollaborationGrantPayloadCodecV1,
} from '../src/collaboration-grant-envelope-reader.ts';
import {
  HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1,
  HistoricalGrantAdapterError,
  createHistoricalCollaborationGrantAdapterV1,
  type HistoricalGrantAdapterV1,
  type HistoricalGrantStorePortV1,
  type HistoricalGrantStoreStateV1,
} from '../src/historical-grant-adapter.ts';

const digest = `sha256:${'a'.repeat(64)}` as const;

test('Central Grant public documents reject unknown schemas and kinds', () => {
  assert.equal(
    CENTRAL_GRANT_PUBLIC_CONTRACT_VERSION,
    'jigwright.central-grant.public.v1',
  );
  assert.equal(
    assertCentralGrantPublicDocumentV1({
      schemaVersion: 1,
      kind: 'grant-approval-subject.v1',
      challengeDigest: digest,
      choiceId: digest,
      approvalMethod: 'human-presence',
      reasonCode: 'continue',
      reason: 'Continue once.',
      reasonDigest: sha256(JSON.stringify('Continue once.')),
      stateDigest: digest,
      expiresAt: '2026-08-24T06:00:00.000Z',
      sessionNonce: 'a'.repeat(32),
    }).kind,
    'grant-approval-subject.v1',
  );
  assert.throws(
    () =>
      assertCentralGrantPublicDocumentV1({
        schemaVersion: 2,
        kind: 'grant-approval-subject.v1',
      }),
    /unsupported/u,
  );
  assert.throws(
    () =>
      assertCentralGrantPublicDocumentV1({
        schemaVersion: 1,
        kind: 'legacy-grant-issuance.v1',
      }),
    /unsupported/u,
  );
});

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

test('historical Grant adapters expose read, verify, and cleanup only', () => {
  const store = historicalStore('consumed', historicalEnvelope(V1_PAYLOAD));
  const adapter: HistoricalGrantAdapterV1 = historicalAdapter(store.port);
  assert.deepEqual(adapter.capabilities, ['inspect', 'verify', 'cleanup']);
  assert.equal(adapter.authorityScope, 'historical-only');
  assert.equal('issue' in adapter, false);
  assert.equal('approve' in adapter, false);
  assert.equal('reserve' in adapter, false);
  assert.equal('consume' in adapter, false);
  assert.equal('requestGrant' in adapter, false);
  assert.equal('resolveChallenge' in adapter, false);
  assert.equal('recoverChallenge' in adapter, false);
});

const HISTORICAL_GRANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HISTORICAL_SIGNATURE = 'fixture-signature';
const V1_PAYLOAD = {
  version: 1 as const,
  grantId: HISTORICAL_GRANT_ID,
  authorizedEffect: HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1,
  signer: 'fixture-maintainer',
};
const V2_PAYLOAD = {
  version: 2 as const,
  signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  grantId: HISTORICAL_GRANT_ID,
  authorizedEffect: HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1,
  signer: 'fixture-maintainer',
};
type HistoricalFixturePayload = typeof V1_PAYLOAD | typeof V2_PAYLOAD;

const HISTORICAL_CODEC: CollaborationGrantPayloadCodecV1<HistoricalFixturePayload> =
  {
    v1PayloadKeys: ['version', 'grantId', 'authorizedEffect', 'signer'],
    v2PayloadKeys: [
      'version',
      'signatureNamespace',
      'grantId',
      'authorizedEffect',
      'signer',
    ],
    parsePayload(value) {
      if (
        !isRecord(value) ||
        (value.version !== 1 && value.version !== 2) ||
        value.grantId !== HISTORICAL_GRANT_ID ||
        value.authorizedEffect !==
          HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1 ||
        value.signer !== 'fixture-maintainer'
      ) {
        throw new Error('historical fixture payload invalid');
      }
      return value as HistoricalFixturePayload;
    },
    projectPayloadFields(payload) {
      return {
        grantId: payload.grantId,
        authorizedEffect: payload.authorizedEffect,
        signer: payload.signer,
      };
    },
    validateSignature(signature) {
      if (signature !== HISTORICAL_SIGNATURE) {
        throw new Error('historical fixture signature invalid');
      }
    },
  };

test('production historical adapter strictly inspects and verifies exact V1/V2 evidence without creating current authority', () => {
  const verifierCalls: unknown[][] = [];
  for (const payload of [V1_PAYLOAD, V2_PAYLOAD]) {
    const store = historicalStore('consumed', historicalEnvelope(payload));
    const adapter = historicalAdapter(store.port, verifierCalls);
    const inspection = adapter.inspect(HISTORICAL_GRANT_ID);
    const verification = adapter.verify(HISTORICAL_GRANT_ID);

    assert.deepEqual(inspection, {
      schemaVersion: 1,
      kind: 'jigwright.historical-grant-inspection.v1',
      evidenceFamily: 'legacy-collaboration-grant',
      evidenceId: HISTORICAL_GRANT_ID,
      payloadVersion: payload.version,
      signatureNamespace:
        payload.version === 1
          ? COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
          : COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
      authorizedEffect: HISTORICAL_COLLABORATION_GRANT_AUTHORIZED_EFFECT_V1,
      state: 'consumed',
      evidenceDigest: sha256(historicalEnvelope(payload)),
      authorityScope: 'historical-only',
    });
    assert.equal(
      verification.kind,
      'jigwright.verified-historical-grant-evidence.v1',
    );
    assert.equal(verification.authorityScope, 'historical-only');
    assert.equal(verification.currentAuthority, false);
    assert.equal(verification.planReviewAuthority, false);
    assert.equal('challengeId' in verification, false);
    assert.equal('transitionId' in verification, false);
    assert.equal('terminalOutcomeDigest' in verification, false);
    assert.throws(
      () => assertCentralGrantPublicDocumentV1(verification),
      /unsupported/u,
    );
    assert.equal(Object.isFrozen(inspection), true);
    assert.equal(Object.isFrozen(verification), true);
  }

  assert.deepEqual(
    verifierCalls.map((call) => [call[2], call[3]]),
    [
      ['fixture-maintainer', COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE],
      ['fixture-maintainer', COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE],
    ],
  );
});

test('historical adapter rejects malformed, unknown, noncanonical, and current Grant documents before signature verification', () => {
  let verifierCalls = 0;
  const store = historicalStore('consumed', historicalEnvelope(V1_PAYLOAD));
  const adapter = historicalAdapter(store.port, {
    verify() {
      verifierCalls += 1;
    },
  });
  const invalidDocuments = [
    '{not-json}\n',
    `${JSON.stringify({
      payload: { ...V1_PAYLOAD, version: 3 },
      signature: HISTORICAL_SIGNATURE,
    })}\n`,
    `${JSON.stringify({
      payload: {
        ...V2_PAYLOAD,
        signatureNamespace: COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
      },
      signature: HISTORICAL_SIGNATURE,
    })}\n`,
    ` ${historicalEnvelope(V1_PAYLOAD)}`,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'grant-record.v1',
      state: 'completed',
    })}\n`,
  ];

  for (const raw of invalidDocuments) {
    store.setRaw(raw);
    assert.throws(() => adapter.inspect(HISTORICAL_GRANT_ID));
    assert.throws(() => adapter.verify(HISTORICAL_GRANT_ID));
  }
  assert.equal(verifierCalls, 0);
});

test('historical cleanup requires an exact verified terminal record and preserves its tombstone', () => {
  const raw = historicalEnvelope(V1_PAYLOAD);
  const store = historicalStore('consumed', raw);
  const adapter = historicalAdapter(store.port);
  const verification = adapter.verify(HISTORICAL_GRANT_ID);
  const cleanup = adapter.cleanup(verification);

  assert.deepEqual(cleanup, {
    schemaVersion: 1,
    kind: 'jigwright.historical-grant-terminal-cleanup.v1',
    evidenceFamily: 'legacy-collaboration-grant',
    evidenceId: HISTORICAL_GRANT_ID,
    state: 'consumed',
    evidenceDigest: sha256(raw),
    removedResiduals: 2,
    terminalPreserved: true,
    authorityScope: 'historical-only',
  });
  assert.deepEqual(store.cleanupCalls, [
    {
      evidenceId: HISTORICAL_GRANT_ID,
      expectedState: 'consumed',
      expectedEvidenceDigest: sha256(raw),
    },
  ]);
  assert.equal(Object.isFrozen(cleanup), true);

  for (const state of ['available', 'reserved'] as const) {
    const active = historicalStore(state, raw);
    const activeAdapter = historicalAdapter(active.port);
    assert.throws(
      () => activeAdapter.cleanup(activeAdapter.verify(HISTORICAL_GRANT_ID)),
      isHistoricalAdapterError('HISTORICAL_GRANT_CLEANUP_STATE_INVALID'),
    );
    assert.equal(active.cleanupCalls.length, 0);
  }
});

test('historical cleanup refuses forged receipts and evidence drift without touching storage', () => {
  const raw = historicalEnvelope(V1_PAYLOAD);
  const store = historicalStore('failed', raw);
  const adapter = historicalAdapter(store.port);
  const verification = adapter.verify(HISTORICAL_GRANT_ID);

  assert.throws(
    () => adapter.cleanup({ ...verification }),
    isHistoricalAdapterError('HISTORICAL_GRANT_VERIFICATION_REQUIRED'),
  );
  store.setRaw(historicalEnvelope(V2_PAYLOAD));
  assert.throws(
    () => adapter.cleanup(verification),
    isHistoricalAdapterError('HISTORICAL_GRANT_EVIDENCE_CHANGED'),
  );
  assert.equal(store.cleanupCalls.length, 0);
});

test('@jigwright/grants implements the core-owned ports without a reverse dependency', () => {
  const packageManifest = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../package.json'),
      'utf8',
    ),
  ) as { dependencies?: Record<string, string> };
  assert.equal(
    packageManifest.dependencies?.['@jigwright/core'],
    'workspace:*',
  );

  const coreManifest = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../../core/package.json'),
      'utf8',
    ),
  ) as { dependencies?: Record<string, string> };
  assert.equal(coreManifest.dependencies?.['@jigwright/grants'], undefined);

  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/central-grant-contracts.ts'),
    'utf8',
  );
  assert.match(source, /from '@jigwright\/core\/central-grant-port'/u);
});

function historicalAdapter(
  store: HistoricalGrantStorePortV1,
  verifierOrCalls:
    | { verify(...input: [string, string, string, string]): void }
    | unknown[][] = [],
): HistoricalGrantAdapterV1 {
  const verifier = Array.isArray(verifierOrCalls)
    ? {
        verify(...input: [string, string, string, string]) {
          verifierOrCalls.push(input);
        },
      }
    : verifierOrCalls;
  return createHistoricalCollaborationGrantAdapterV1({
    codec: HISTORICAL_CODEC,
    validatePayload() {},
    verifier,
    store,
  });
}

function historicalEnvelope(payload: HistoricalFixturePayload): string {
  return canonicalCollaborationGrantEnvelopeBytesV1(
    { payload, signature: HISTORICAL_SIGNATURE },
    HISTORICAL_CODEC,
  );
}

function historicalStore(
  state: HistoricalGrantStoreStateV1,
  initialRaw: string,
) {
  let raw = initialRaw;
  const cleanupCalls: unknown[] = [];
  const port: HistoricalGrantStorePortV1 = {
    readEvidence(evidenceId) {
      assert.equal(evidenceId, HISTORICAL_GRANT_ID);
      return { state, raw };
    },
    cleanupTerminalResiduals(input) {
      cleanupCalls.push(input);
      return { removedResiduals: 2, terminalPreserved: true };
    },
  };
  return {
    port,
    cleanupCalls,
    setRaw(value: string) {
      raw = value;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHistoricalAdapterError(code: string) {
  return (error: unknown): boolean =>
    error instanceof HistoricalGrantAdapterError && error.code === code;
}
