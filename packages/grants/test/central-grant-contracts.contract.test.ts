import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CENTRAL_GRANT_PUBLIC_CONTRACT_VERSION,
  assertCentralGrantPublicDocumentV1,
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

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
