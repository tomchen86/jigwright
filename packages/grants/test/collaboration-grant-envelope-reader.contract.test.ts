import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  CollaborationGrantEnvelopeReaderError,
  canonicalCollaborationGrantEnvelopeBytesV1,
  canonicalCollaborationGrantPayloadBytesV1,
  parseCollaborationGrantEnvelopeV1,
  readAndVerifyCollaborationGrantEnvelopeV1,
  selectCollaborationGrantSignatureNamespaceV1,
  type CollaborationGrantPayloadCodecV1,
} from '../src/collaboration-grant-envelope-reader.ts';

const SIGNATURE = 'fixture-signature';
const V2_PAYLOAD = {
  version: 2 as const,
  signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  subject: 'fixture-subject',
  authorizedEffect: 'fixture-effect',
  signer: 'fixture-signer',
};
const V1_PAYLOAD_BYTES =
  '{"version":1,"subject":"fixture-subject","authorizedEffect":"fixture-effect","signer":"fixture-signer"}\n';
const V2_PAYLOAD_BYTES =
  '{"version":2,"signatureNamespace":"workflow.collaboration-grant.v2","subject":"fixture-subject","authorizedEffect":"fixture-effect","signer":"fixture-signer"}\n';

type FixturePayload = typeof V2_PAYLOAD;

const CODEC: CollaborationGrantPayloadCodecV1<FixturePayload> = {
  v2PayloadKeys: [
    'version',
    'signatureNamespace',
    'subject',
    'authorizedEffect',
    'signer',
  ],
  parsePayload(value) {
    if (
      !isRecord(value) ||
      value.version !== 2 ||
      value.signatureNamespace !== COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE ||
      typeof value.subject !== 'string' ||
      value.authorizedEffect !== 'fixture-effect' ||
      value.signer !== 'fixture-signer'
    ) {
      throw new Error('fixture payload invalid');
    }
    return value as FixturePayload;
  },
  projectPayloadFields(payload) {
    return {
      subject: payload.subject,
      authorizedEffect: payload.authorizedEffect,
      signer: payload.signer,
    };
  },
  validateSignature(signature) {
    if (signature !== SIGNATURE) throw new Error('fixture signature invalid');
  },
};

test('preserves current V2 canonical payload and envelope bytes', () => {
  assert.equal(
    canonicalCollaborationGrantPayloadBytesV1(V2_PAYLOAD, CODEC),
    V2_PAYLOAD_BYTES,
  );
  const v2EnvelopeBytes = `${JSON.stringify({
    payload: JSON.parse(V2_PAYLOAD_BYTES),
    signature: SIGNATURE,
  })}\n`;
  assert.equal(
    canonicalCollaborationGrantEnvelopeBytesV1(
      { payload: V2_PAYLOAD, signature: SIGNATURE },
      CODEC,
    ),
    v2EnvelopeBytes,
  );
  const parsedV2 = parseCollaborationGrantEnvelopeV1(v2EnvelopeBytes, CODEC);
  assert.deepEqual(parsedV2, { payload: V2_PAYLOAD, signature: SIGNATURE });
  assert.equal(Object.isFrozen(parsedV2), true);
  assert.equal(Object.isFrozen(parsedV2.payload), true);
  assert.equal(
    selectCollaborationGrantSignatureNamespaceV1(parsedV2.payload),
    COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  );
});

test('rejects V1 payloads before domain parsing or signature verification', () => {
  let domainParserCalls = 0;
  let verifierCalls = 0;
  const codec: CollaborationGrantPayloadCodecV1<FixturePayload> = {
    ...CODEC,
    parsePayload(value) {
      domainParserCalls += 1;
      return CODEC.parsePayload(value);
    },
  };
  assert.throws(
    () =>
      readAndVerifyCollaborationGrantEnvelopeV1({
        readerContractVersion:
          COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
        raw: envelopeBytes(JSON.parse(V1_PAYLOAD_BYTES)),
        codec,
        validatePayload: () => undefined,
        authorizedEffect: (parsed) => parsed.authorizedEffect,
        signer: (parsed) => parsed.signer,
        allowedAuthorizedEffects: ['fixture-effect'],
        verifier: {
          verify() {
            verifierCalls += 1;
          },
        },
      }),
    (error) =>
      error instanceof CollaborationGrantEnvelopeReaderError &&
      error.code === 'GRANT_PAYLOAD_VERSION_UNSUPPORTED',
  );
  assert.equal(domainParserCalls, 0);
  assert.equal(verifierCalls, 0);
});

test('unknown versions, wrong namespaces, extra keys, and non-canonical bytes fail closed', () => {
  const invalid = [
    envelopeBytes({ ...V2_PAYLOAD, version: 3 }),
    envelopeBytes({
      ...V2_PAYLOAD,
      signatureNamespace: 'workflow.collaboration-grant.v1',
    }),
    envelopeBytes({ ...V2_PAYLOAD, extra: true }),
    `${JSON.stringify({ signature: SIGNATURE, payload: V2_PAYLOAD })}\n`,
  ];
  for (const raw of invalid) {
    assert.throws(
      () => parseCollaborationGrantEnvelopeV1(raw, CODEC),
      (error) => error instanceof CollaborationGrantEnvelopeReaderError,
    );
  }
});

test('selects exactly the current namespace and performs one injected verifier call without fallback', () => {
  const calls: Array<readonly [string, string, string, string]> = [];
  const envelope = { payload: V2_PAYLOAD, signature: SIGNATURE };
  const result = readAndVerifyCollaborationGrantEnvelopeV1({
    readerContractVersion:
      COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
    raw: canonicalCollaborationGrantEnvelopeBytesV1(envelope, CODEC),
    codec: CODEC,
    validatePayload: () => undefined,
    authorizedEffect: (parsed) => parsed.authorizedEffect,
    signer: (parsed) => parsed.signer,
    allowedAuthorizedEffects: ['fixture-effect'],
    verifier: {
      verify(...input) {
        calls.push(input);
      },
    },
  });
  assert.equal(result.envelope.payload.version, 2);
  assert.equal(
    result.verification.receipt.signatureNamespace,
    COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  );
  assert.deepEqual(calls, [
    [
      V2_PAYLOAD_BYTES,
      SIGNATURE,
      'fixture-signer',
      COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    ],
  ]);
});

test('runs domain semantic validation before invoking the verifier', () => {
  const refusal = new Error('domain binding refused');
  let verifierCalls = 0;
  assert.throws(
    () =>
      readAndVerifyCollaborationGrantEnvelopeV1({
        readerContractVersion:
          COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
        raw: canonicalCollaborationGrantEnvelopeBytesV1(
          { payload: V2_PAYLOAD, signature: SIGNATURE },
          CODEC,
        ),
        codec: CODEC,
        validatePayload() {
          throw refusal;
        },
        authorizedEffect: (parsed) => parsed.authorizedEffect,
        signer: (parsed) => parsed.signer,
        allowedAuthorizedEffects: ['fixture-effect'],
        verifier: {
          verify() {
            verifierCalls += 1;
          },
        },
      }),
    (error) => error === refusal,
  );
  assert.equal(verifierCalls, 0);
});

function envelopeBytes(payload: unknown): string {
  return `${JSON.stringify({ payload, signature: SIGNATURE })}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
