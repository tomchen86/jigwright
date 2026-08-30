import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '@jigwright/core/canonical-json';

import {
  CENTRAL_GRANT_PUBLIC_CONTRACT_VERSION,
  assertCentralGrantPublicDocumentV1,
  parseCanonicalGrantRecordV1,
} from '../src/central-grant-contracts.ts';

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

test('public Grant records reject an approval method outside the code-owned choice', () => {
  const parameters = { resume: true };
  const choicePayload = {
    transitionId: 'vector-transition',
    parameters,
    parameterDigest: sha256(canonicalJson(parameters)),
    parameterSchemaDigest: `sha256:${'b'.repeat(64)}`,
    consequenceDigest: `sha256:${'c'.repeat(64)}`,
    resolutionKind: 'non-retry',
    allowedApprovalMethods: ['ssh'],
    allowedReasonCodes: ['approved-for-vector'],
    reasonRequired: true,
    proposedReason: 'Continue the vector transition.',
  } as const;
  const choice = {
    choiceId: sha256(canonicalJson(choicePayload)),
    ...choicePayload,
  };
  const facts = { reason: 'fixture' };
  const challengePayload = {
    schemaVersion: 1,
    kind: 'grant-challenge.v1',
    challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sourceModuleId: 'vector-module',
    failureCode: 'vector-blocked',
    facts,
    factsDigest: sha256(canonicalJson(facts)),
    stateBinding: {
      kind: 'vector-state',
      digest,
    },
    choices: [choice],
    issuedAt: '2026-08-24T00:00:00.000Z',
    expiresAt: '2026-08-24T00:10:00.000Z',
  } as const;
  const challenge = {
    ...challengePayload,
    challengeDigest: sha256(canonicalJson(challengePayload)),
  };
  const reason = 'Continue once.';
  const record = {
    schemaVersion: 1,
    kind: 'grant-record.v1',
    state: 'prepared',
    challenge,
    recordedAt: challenge.issuedAt,
    operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    approvalSubject: {
      schemaVersion: 1,
      kind: 'grant-approval-subject.v1',
      challengeDigest: challenge.challengeDigest,
      choiceId: choice.choiceId,
      approvalMethod: 'human-presence',
      reasonCode: 'approved-for-vector',
      reason,
      reasonDigest: sha256(canonicalJson(reason)),
      stateDigest: digest,
      expiresAt: challenge.expiresAt,
      sessionNonce: 'a'.repeat(32),
    },
    proofModules: [
      {
        moduleId: 'grant-proof-human-presence',
        version: '1',
        claim: 'fresh-local-device-owner',
        proofDigest: digest,
        identity: null,
        portableEvidence: null,
      },
    ],
    preparedAt: '2026-08-24T00:01:00.000Z',
  } as const;

  assert.throws(
    () => parseCanonicalGrantRecordV1(`${canonicalJson(record)}\n`),
    /malformed/u,
  );
});

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
