import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  bindingFromRoleContextSharingGrantPayloadV1,
  type RoleContextSharingGrantEnvelopeV1,
  type RoleContextSharingGrantExpectedBindingV1,
  type RoleContextSharingGrantPayloadV1,
  type RoleContextSharingRolePairV1,
} from '@jigwright/grants/role-context-sharing-degradation';
import {
  ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1,
  ROLE_CONTEXT_SHARING_POLICY_DIGEST,
} from '../src/modules/authority/role-context-sharing-grant.ts';
import { sealAuthoritativeRoleContextSharingGrantVerifier } from '../src/modules/authority/role-context-sharing-grant-verifier-port.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import {
  consumeRoleContextSharingGrant,
  consumeOrReadExactRoleContextSharingGrant,
  listRoleContextSharingRecords,
  readRoleContextSharingRecord,
  reserveRoleContextSharingGrant,
  reserveOrReadExactRoleContextSharingGrant,
  roleContextSharingStorePaths,
  storeAvailableRoleContextSharingGrant,
} from '../src/runtime/storage-journal/role-context-sharing-store.ts';
import { createFixtureRepository } from './fixture.ts';

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

function envelope(
  grantId: string,
  rolePairs: readonly RoleContextSharingRolePairV1[] = [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
  ],
): RoleContextSharingGrantEnvelopeV1 {
  const payload: RoleContextSharingGrantPayloadV1 = {
    version: 1,
    signatureNamespace: ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
    grantId,
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
    rolePairs,
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
  return { payload, signature: 'fixture-signature' };
}

function transitionOptions(
  expected: RoleContextSharingGrantExpectedBindingV1,
  verifierCalls: { value: number },
) {
  return {
    now: NOW,
    expected,
    policy: POLICY,
    verifier: sealAuthoritativeRoleContextSharingGrantVerifier(
      {
        assertCurrent() {},
        verify() {
          verifierCalls.value += 1;
        },
      },
      `sha256:${'d'.repeat(64)}`,
    ),
    eligibility: {
      contractVersion: ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1,
      policyDigest: ELIGIBILITY_DIGEST,
      assertEligible() {},
    },
  } as const;
}

function exactUse(
  grant: RoleContextSharingGrantEnvelopeV1,
): Parameters<typeof consumeRoleContextSharingGrant>[2]['use'] {
  return {
    rolePairs: grant.payload.rolePairs,
    providerId: 'codex',
    sessionId: 'provider-session-1',
    sharedEngineSessionId: grant.payload.sharedEngineSessionId,
    contextGeneration: grant.payload.contextGeneration,
    sessionGeneration: grant.payload.sessionGeneration,
    providerDefinitionDigest: grant.payload.providerDefinitionDigest,
    invocationId: 'invocation-1',
    requestDigest: 'a'.repeat(64),
    assignmentDigest: 'b'.repeat(64),
    admissionDigest: 'c'.repeat(64),
  };
}

test('exact reserve and terminal consume replay are idempotent without duplicate receipts', () => {
  const repository = createFixtureRepository();
  const commonPath = `${repository}/.git`;
  fs.chmodSync(commonPath, 0o700);
  const common = fs.realpathSync(commonPath);
  const grant = envelope('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  const expected = bindingFromRoleContextSharingGrantPayloadV1(grant.payload);
  const verifierCalls = { value: 0 };
  const options = transitionOptions(expected, verifierCalls);
  const use = exactUse(grant);

  storeAvailableRoleContextSharingGrant(common, grant);
  const reserved = reserveOrReadExactRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    options,
  );
  const reservationReplay = reserveOrReadExactRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    options,
  );
  assert.equal(reserved.state, 'reserved');
  assert.equal(reservationReplay.recordDigest, reserved.recordDigest);
  assert.equal(reservationReplay.receipts.length, 1);
  assert.equal(verifierCalls.value, 1);

  const consumed = consumeOrReadExactRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    { ...options, use },
  );
  const terminalReplay = consumeOrReadExactRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    { expected, use },
  );
  assert.equal(consumed.state, 'consumed');
  assert.equal(terminalReplay.recordDigest, consumed.recordDigest);
  assert.equal(terminalReplay.receipts.length, 2);
  assert.equal(verifierCalls.value, 2);
});

test('exact replay rejects changed reservation binding or terminal use', () => {
  const repository = createFixtureRepository();
  const commonPath = `${repository}/.git`;
  fs.chmodSync(commonPath, 0o700);
  const common = fs.realpathSync(commonPath);
  const grant = envelope('ffffffff-ffff-4fff-8fff-ffffffffffff');
  const expected = bindingFromRoleContextSharingGrantPayloadV1(grant.payload);
  const verifierCalls = { value: 0 };
  const options = transitionOptions(expected, verifierCalls);
  const use = exactUse(grant);

  storeAvailableRoleContextSharingGrant(common, grant);
  reserveOrReadExactRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    options,
  );
  assert.throws(() =>
    reserveOrReadExactRoleContextSharingGrant(common, grant.payload.grantId, {
      ...options,
      expected: { ...expected, sessionGeneration: 99 },
    }),
  );
  consumeOrReadExactRoleContextSharingGrant(common, grant.payload.grantId, {
    ...options,
    use,
  });
  assert.throws(() =>
    consumeOrReadExactRoleContextSharingGrant(common, grant.payload.grantId, {
      expected,
      use: { ...use, requestDigest: 'c'.repeat(64) },
    }),
  );
  assert.throws(() =>
    consumeOrReadExactRoleContextSharingGrant(common, grant.payload.grantId, {
      expected: { ...expected, contextGeneration: 99 },
      use,
    }),
  );
  assert.equal(
    readRoleContextSharingRecord(common, grant.payload.grantId).receipts.length,
    2,
  );
});

test('raw verifier is rejected before an available record mutates', () => {
  const repository = createFixtureRepository();
  const commonPath = `${repository}/.git`;
  fs.chmodSync(commonPath, 0o700);
  const common = fs.realpathSync(commonPath);
  const grant = envelope('11111111-1111-4111-8111-111111111111');
  const expected = bindingFromRoleContextSharingGrantPayloadV1(grant.payload);
  const verifierCalls = { value: 0 };
  const options = transitionOptions(expected, verifierCalls);

  storeAvailableRoleContextSharingGrant(common, grant);
  assert.throws(
    () =>
      reserveRoleContextSharingGrant(common, grant.payload.grantId, {
        ...options,
        verifier: {
          verify() {
            verifierCalls.value += 1;
          },
        } as never,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code ===
        'ROLE_CONTEXT_SHARING_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
  );
  assert.equal(
    readRoleContextSharingRecord(common, grant.payload.grantId).state,
    'available',
  );
  assert.equal(verifierCalls.value, 0);
});

test('reserved replay and consume require current opaque authority without mutating reserved bytes', () => {
  const repository = createFixtureRepository();
  const commonPath = `${repository}/.git`;
  fs.chmodSync(commonPath, 0o700);
  const common = fs.realpathSync(commonPath);
  const grant = envelope('22222222-2222-4222-8222-222222222222');
  const expected = bindingFromRoleContextSharingGrantPayloadV1(grant.payload);
  const verifierCalls = { value: 0 };
  const options = transitionOptions(expected, verifierCalls);
  const use = exactUse(grant);

  storeAvailableRoleContextSharingGrant(common, grant);
  const reserved = reserveOrReadExactRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    options,
  );
  const recordPath = path.join(
    roleContextSharingStorePaths(common).records,
    `${grant.payload.grantId}.json`,
  );
  const reservedBytes = fs.readFileSync(recordPath);
  const rawVerifier = {
    assertCurrent() {},
    verify() {},
  } as never;
  const staleVerifier = sealAuthoritativeRoleContextSharingGrantVerifier(
    {
      assertCurrent() {
        throw new Error('stale R-007 verifier composition');
      },
      verify() {
        throw new Error('stale verifier must not verify');
      },
    },
    `sha256:${'e'.repeat(64)}`,
  );

  assert.throws(
    () =>
      reserveOrReadExactRoleContextSharingGrant(common, grant.payload.grantId, {
        ...options,
        verifier: rawVerifier,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code ===
        'ROLE_CONTEXT_SHARING_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
  );
  assert.throws(
    () =>
      reserveOrReadExactRoleContextSharingGrant(common, grant.payload.grantId, {
        ...options,
        verifier: staleVerifier,
      }),
    /stale R-007 verifier composition/,
  );
  assert.throws(
    () =>
      consumeOrReadExactRoleContextSharingGrant(common, grant.payload.grantId, {
        ...options,
        verifier: rawVerifier,
        use,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code ===
        'ROLE_CONTEXT_SHARING_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
  );
  assert.throws(
    () =>
      consumeOrReadExactRoleContextSharingGrant(common, grant.payload.grantId, {
        ...options,
        verifier: staleVerifier,
        use,
      }),
    /stale R-007 verifier composition/,
  );
  assert.deepEqual(fs.readFileSync(recordPath), reservedBytes);
  assert.equal(
    readRoleContextSharingRecord(common, grant.payload.grantId).recordDigest,
    reserved.recordDigest,
  );

  const consumed = consumeOrReadExactRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    { ...options, use },
  );
  const terminalReplay = consumeOrReadExactRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    { expected, use, verifier: staleVerifier },
  );
  assert.equal(terminalReplay.recordDigest, consumed.recordDigest);
  assert.equal(
    readRoleContextSharingRecord(common, grant.payload.grantId).recordDigest,
    consumed.recordDigest,
  );
  assert.equal(listRoleContextSharingRecords(common).length, 1);
});

test('publishes one canonical journal and moves available to reserved to consumed', () => {
  const repository = createFixtureRepository();
  const commonPath = `${repository}/.git`;
  fs.chmodSync(commonPath, 0o700);
  const common = fs.realpathSync(commonPath);
  const grant = envelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const expected = bindingFromRoleContextSharingGrantPayloadV1(grant.payload);
  const verifierCalls = { value: 0 };

  storeAvailableRoleContextSharingGrant(common, grant);
  assert.equal(
    readRoleContextSharingRecord(common, grant.payload.grantId).state,
    'available',
  );

  reserveRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    transitionOptions(expected, verifierCalls),
  );
  assert.equal(
    readRoleContextSharingRecord(common, grant.payload.grantId).state,
    'reserved',
  );

  consumeRoleContextSharingGrant(common, grant.payload.grantId, {
    ...transitionOptions(expected, verifierCalls),
    use: {
      rolePairs: ['author-builder', 'author-reviewer', 'builder-reviewer'],
      providerId: 'codex',
      sessionId: 'provider-session-1',
      sharedEngineSessionId: grant.payload.sharedEngineSessionId,
      contextGeneration: grant.payload.contextGeneration,
      sessionGeneration: grant.payload.sessionGeneration,
      providerDefinitionDigest: grant.payload.providerDefinitionDigest,
      invocationId: 'invocation-1',
      requestDigest: 'a'.repeat(64),
      assignmentDigest: 'b'.repeat(64),
      admissionDigest: 'c'.repeat(64),
    },
  });
  const record = readRoleContextSharingRecord(common, grant.payload.grantId);
  assert.equal(record.state, 'consumed');
  assert.deepEqual(record.use?.rolePairs, [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
  ]);
  assert.equal(verifierCalls.value, 2);
  assert.equal(listRoleContextSharingRecords(common).length, 1);
});

test('persists and consumes a single exact role-pair set', () => {
  const repository = createFixtureRepository();
  const commonPath = `${repository}/.git`;
  fs.chmodSync(commonPath, 0o700);
  const common = fs.realpathSync(commonPath);
  const grant = envelope('dddddddd-dddd-4ddd-8ddd-dddddddddddd', [
    'author-builder',
  ]);
  const expected = bindingFromRoleContextSharingGrantPayloadV1(grant.payload);
  const verifierCalls = { value: 0 };
  storeAvailableRoleContextSharingGrant(common, grant);
  reserveRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    transitionOptions(expected, verifierCalls),
  );
  const record = consumeRoleContextSharingGrant(common, grant.payload.grantId, {
    ...transitionOptions(expected, verifierCalls),
    use: {
      rolePairs: ['author-builder'],
      providerId: 'codex',
      sessionId: 'provider-session-1',
      sharedEngineSessionId: grant.payload.sharedEngineSessionId,
      contextGeneration: grant.payload.contextGeneration,
      sessionGeneration: grant.payload.sessionGeneration,
      providerDefinitionDigest: grant.payload.providerDefinitionDigest,
      invocationId: 'invocation-1',
      requestDigest: 'a'.repeat(64),
      assignmentDigest: 'b'.repeat(64),
      admissionDigest: 'c'.repeat(64),
    },
  });
  assert.deepEqual(record.use?.rolePairs, ['author-builder']);
  assert.equal(record.state, 'consumed');
});

test('binding drift and replay fail while read/list remain verifier-independent', () => {
  const repository = createFixtureRepository();
  const commonPath = `${repository}/.git`;
  fs.chmodSync(commonPath, 0o700);
  const common = fs.realpathSync(commonPath);
  const grant = envelope('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const expected = bindingFromRoleContextSharingGrantPayloadV1(grant.payload);
  const verifierCalls = { value: 0 };
  storeAvailableRoleContextSharingGrant(common, grant);
  reserveRoleContextSharingGrant(
    common,
    grant.payload.grantId,
    transitionOptions(expected, verifierCalls),
  );
  assert.throws(() =>
    consumeRoleContextSharingGrant(common, grant.payload.grantId, {
      ...transitionOptions(expected, verifierCalls),
      use: {
        rolePairs: ['author-builder'],
        providerId: 'codex',
        sessionId: 'provider-session-1',
        sharedEngineSessionId: grant.payload.sharedEngineSessionId,
        contextGeneration: grant.payload.contextGeneration,
        sessionGeneration: grant.payload.sessionGeneration,
        providerDefinitionDigest: grant.payload.providerDefinitionDigest,
        invocationId: 'invocation-1',
        requestDigest: 'a'.repeat(64),
        assignmentDigest: 'b'.repeat(64),
        admissionDigest: 'c'.repeat(64),
      },
    }),
  );
  assert.equal(verifierCalls.value, 1);
  assert.throws(() =>
    consumeRoleContextSharingGrant(common, grant.payload.grantId, {
      ...transitionOptions(
        { ...expected, sessionGeneration: 99 },
        verifierCalls,
      ),
      use: {
        rolePairs: ['author-builder', 'author-reviewer', 'builder-reviewer'],
        providerId: 'codex',
        sessionId: 'provider-session-1',
        sharedEngineSessionId: grant.payload.sharedEngineSessionId,
        contextGeneration: grant.payload.contextGeneration,
        sessionGeneration: grant.payload.sessionGeneration,
        providerDefinitionDigest: grant.payload.providerDefinitionDigest,
        invocationId: 'invocation-1',
        requestDigest: 'a'.repeat(64),
        assignmentDigest: 'b'.repeat(64),
        admissionDigest: 'c'.repeat(64),
      },
    }),
  );
  assert.equal(
    readRoleContextSharingRecord(common, grant.payload.grantId).state,
    'reserved',
  );
  assert.equal(verifierCalls.value, 1);
  assert.equal(listRoleContextSharingRecords(common).length, 1);
});

test('read rejects extra keys, executable mode, symlink, and hardlink records', () => {
  const repository = createFixtureRepository();
  const commonPath = `${repository}/.git`;
  fs.chmodSync(commonPath, 0o700);
  const common = fs.realpathSync(commonPath);
  const grant = envelope('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  storeAvailableRoleContextSharingGrant(common, grant);
  const target = path.join(
    roleContextSharingStorePaths(common).records,
    `${grant.payload.grantId}.json`,
  );
  const original = fs.readFileSync(target);
  try {
    const extra = JSON.parse(original.toString('utf8')) as Record<
      string,
      unknown
    >;
    extra.extra = true;
    fs.writeFileSync(target, `${JSON.stringify(extra)}\n`);
    assert.throws(() =>
      readRoleContextSharingRecord(common, grant.payload.grantId),
    );
    fs.writeFileSync(target, original);

    fs.chmodSync(target, 0o700);
    assert.throws(() =>
      readRoleContextSharingRecord(common, grant.payload.grantId),
    );
    fs.chmodSync(target, 0o600);

    const backup = `${target}.backup`;
    fs.renameSync(target, backup);
    fs.symlinkSync(backup, target);
    assert.throws(() =>
      readRoleContextSharingRecord(common, grant.payload.grantId),
    );
    fs.unlinkSync(target);
    fs.renameSync(backup, target);

    const hardlink = `${target}.hardlink`;
    fs.linkSync(target, hardlink);
    fs.renameSync(target, backup);
    fs.renameSync(hardlink, target);
    assert.throws(() =>
      readRoleContextSharingRecord(common, grant.payload.grantId),
    );
    fs.unlinkSync(target);
    fs.renameSync(backup, target);
  } finally {
    fs.chmodSync(target, 0o600);
  }
});
