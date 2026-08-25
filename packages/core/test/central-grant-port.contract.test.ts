import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  CentralGrantChallengePortV1,
  CentralGrantChallengeRefV1,
  CentralGrantCompletedAuthorityRefV1,
  CentralGrantRequestInputV1,
  CentralGrantRequestPortV1,
  CentralGrantTransitionRegistryPortV1,
} from '../src/central-grant-port.ts';

const digest = `sha256:${'a'.repeat(64)}` as const;

test('core owns Central Grant request and registered-transition ports without an implementation dependency', async () => {
  const request: CentralGrantRequestInputV1 = {
    sourceModuleId: 'fixture-source',
    failureCode: 'fixture-blocked',
    facts: { blocked: true },
    stateBinding: { kind: 'fixture-state', digest },
    candidates: [
      {
        transitionId: 'fixture.continue',
        parameters: { changeId: 'demo' },
        allowedReasonCodes: ['continue'],
        reasonRequired: true,
        proposedReason: 'Continue the exact fixture operation.',
      },
    ],
  };
  const expected: CentralGrantChallengeRefV1 = {
    challengeId: 'fixture-challenge',
    challengeDigest: digest,
  };
  const port: CentralGrantRequestPortV1 = {
    contractVersion: 'central-grant-request-port.v1',
    requestGrant: async (input) => {
      assert.equal(input, request);
      return expected;
    },
  };
  const registry: CentralGrantTransitionRegistryPortV1 = {
    contractVersion: 'central-grant-transition-registry-port.v1',
    resolve(transitionId) {
      assert.equal(transitionId, 'fixture.continue');
      throw new Error('fixture definition intentionally omitted');
    },
  };
  const completed: CentralGrantCompletedAuthorityRefV1 = {
    contractVersion: 'central-grant-completed-authority-ref.v1',
    challengeId: expected.challengeId,
    challengeDigest: expected.challengeDigest,
    transitionId: 'fixture.continue',
    operationId: 'fixture-operation',
    terminalOutcomeDigest: digest,
  };
  const challengePort: CentralGrantChallengePortV1<
    CentralGrantChallengeRefV1,
    CentralGrantCompletedAuthorityRefV1
  > = {
    challengeContractVersion: 'central-grant-challenge-port.v1',
    inspectChallenge: () => expected,
    resolveChallenge: async () => completed,
    recoverChallenge: async () => completed,
  };

  assert.deepEqual(await port.requestGrant(request), expected);
  assert.equal(
    (await challengePort.resolveChallenge(expected.challengeId)).transitionId,
    'fixture.continue',
  );
  assert.throws(() => registry.resolve('fixture.continue'), /intentionally/u);

  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/central-grant-port.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /@jigwright\/grants|expense-app|ssh/iu);
  assert.doesNotMatch(
    source,
    /^\s*(?:export\s+)?(?:const|let|var|function|class|enum|namespace)\b|^\s*import(?!\s+type\b)|^\s*export\s+(?!type\b)(?:\*|\{)/m,
  );
});
