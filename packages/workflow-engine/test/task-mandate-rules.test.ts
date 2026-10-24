import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import * as records from '../src/modules/authority/task-mandate-records.ts';
import * as policy from '../src/modules/authority/task-mandate-policy.ts';
import {
  inspectRecord,
  taskMandateBinding,
  assertTaskMandateRepositoryTrust,
} from '../src/modules/authority/task-mandate.ts';

import {
  type TaskMandateRecord,
  type TaskMandateProviderReservationOperation,
} from '../src/modules/authority/task-mandate-values.ts';

import { listBuiltInProviders } from '../src/modules/provider-orchestration/provider-registry.ts';

import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import {
  taskMandateAuthorizationAuditInput,
  taskMandateRevocationAuditInput,
  taskMandateProviderReservationAuditInput,
  taskMandateProviderInvocationAuditInput,
} from '../src/modules/authority/task-mandate-audit.ts';

const issuedAt = '2026-08-03T09:00:00.000Z';
const providerId = listBuiltInProviders()[0]!.id;
function record(): TaskMandateRecord {
  const mandateId = '44444444-4444-4444-8444-444444444444';
  return {
    schemaVersion: 2,
    state: 'active',
    mandateId,
    changeId: 'example-change',
    externalAuditRoot: '/audit',
    taskId: 'example-task',
    lastActivityAt: issuedAt,
    providerUsage: {
      [providerId]: { invocations: 0, budget: 0, reservations: [] },
    },
    revokedAt: null,
    revocationReason: null,
    envelope: {
      signature:
        '-----BEGIN SSH SIGNATURE-----\nYWJj\n-----END SSH SIGNATURE-----\n',
      payload: {
        kind: 'task-mandate.v2',
        mandateId,
        changeId: 'example-change',
        taskId: 'example-task',
        repositoryId: 'github:R_fixture',
        repositoryOrigin: 'https://github.com/example/fixture.git',
        externalAuditRoot: '/audit',
        policyBlob: 'b'.repeat(40),
        baseCommit: 'a'.repeat(40),
        intent: 'Prepare the example change',
        preparation: {
          repositoryRead: true,
          isolatedRepositoryWrites: true,
          addDeleteRenameFiles: true,
          localCommands: true,
          draftCommits: true,
          candidateAndDesignArtifacts: true,
          providerCalls: {
            [providerId]: {
              maxInvocations: 1,
              maxBudget: 4,
              dataTypes: ['task-intent'],
              sourceCode: false,
              secrets: false,
              retryOnFailure: true,
              retryRequiresHuman: false,
            },
          },
          readOnlyConnectors: true,
        },
        authoritativeEffects: false,
        controlPlaneMutation: false,
        secretScopes: [],
        validUntil: {
          taskClosed: true,
          humanRevokes: true,
          repositoryIdentityChanges: true,
          intentReplaced: true,
          inactivityDays: 14,
        },
        auditRequired: true,
        issuedAt,
        signer: 'maintainer',
      },
    },
  };
}

test('direct record rules preserve canonical newline bytes, binding digest and mutable parsed data', () => {
  const value = record();
  const raw = records.canonicalTaskMandateEnvelope(value.envelope);
  assert.equal(raw.at(-1), '\n');
  assert.equal(raw.at(-2), '}');
  assert.deepEqual(records.parseTaskMandateEnvelope(raw), value.envelope);
  assert.throws(() => records.parseTaskMandateEnvelope(raw.slice(0, -1)), {
    code: 'TASK_MANDATE_INVALID',
  });
  assert.equal(
    taskMandateBinding(value).mandateDigest,
    crypto.createHash('sha256').update(raw).digest('hex'),
  );
  const parsed = records.parseCurrentTaskMandateRecord(
    records.canonicalTaskMandateRecord(value),
  );
  assert.deepEqual(parsed, value);
  parsed.lastActivityAt = '2026-08-03T09:00:01.000Z';
  assert.equal(value.lastActivityAt, issuedAt);
});

test('direct provider rules record exact granted excess but retain monetary limits and digest identity', () => {
  const value = record();
  const operation: TaskMandateProviderReservationOperation = {
    providerId,
    dataTypes: ['task-intent'],
    sourceCode: false,
    secrets: false,
    retry: false,
    budget: 2,
    requestDigest: 'c'.repeat(64),
  };
  const digest = policy.taskMandateProviderOperationDigest(operation);
  assert.deepEqual(
    policy.authorizeProviderCall(
      value,
      operation,
      'reservation-b',
      issuedAt,
      digest,
    ),
    { invocations: 1, budget: 2 },
  );
  const before = structuredClone(value);
  assert.throws(
    () =>
      policy.authorizeProviderCall(
        value,
        operation,
        'reservation-a',
        issuedAt,
        digest,
      ),
    { code: 'TASK_MANDATE_PROVIDER_BUDGET_EXHAUSTED' },
  );
  assert.deepEqual(value, before);
  const granted = { ...operation, executionGrant: { grantId: '5'.repeat(64) } };
  assert.equal(policy.taskMandateProviderOperationDigest(granted), digest);
  policy.authorizeProviderCall(
    value,
    granted,
    'reservation-a',
    issuedAt,
    digest,
  );
  assert.deepEqual(
    value.providerUsage[providerId]!.reservations.map(
      ({ reservationId }) => reservationId,
    ),
    ['reservation-a', 'reservation-b'],
  );
  assert.equal(
    value.providerUsage[providerId]!.reservations[0]!.executionGrantId,
    granted.executionGrant.grantId,
  );
  assert.throws(
    () =>
      policy.authorizeProviderCall(
        value,
        granted,
        'reservation-c',
        issuedAt,
        digest,
      ),
    { code: 'TASK_MANDATE_PROVIDER_BUDGET_EXHAUSTED' },
  );
});

test('inspection preserves inclusive inactivity expiry and detached usage summaries', () => {
  const value = record();
  const inspection = inspectRecord(value, new Date('2026-08-17T09:00:00.000Z'));
  assert.equal(inspection.state, 'expired');
  inspection.providerUsage[providerId]!.invocations = 42;
  assert.equal(value.providerUsage[providerId]!.invocations, 0);
  assert.equal(
    inspectRecord(value, new Date('2026-08-17T08:59:59.999Z')).state,
    'active',
  );
});

test('observed trust rejects changed policy, live identity or signed-base signer without an effect service', () => {
  const payload = record().envelope.payload;
  const trusted: MaintainerPolicy = {
    schemaVersion: 1,
    repository: { id: payload.repositoryId, origin: payload.repositoryOrigin },
    phase: 'bootstrap',
    auditTagPrefix: 'refs/tags/grant/',
    signatureNamespace: 'other',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: [],
    sealedImmutablePaths: [],
    requiredChecks: [],
    trustedSigners: [
      {
        identity: payload.signer,
        publicKey: 'fixture',
        fingerprint: 'fixture',
      },
    ],
  };
  const base = { policy: trusted, policyBlob: payload.policyBlob };
  assertTaskMandateRepositoryTrust(
    payload,
    base,
    trusted,
    payload.repositoryOrigin,
  );
  for (const [signed, current, origin] of [
    [
      { ...base, policyBlob: '0'.repeat(40) },
      trusted,
      payload.repositoryOrigin,
    ],
    [
      base,
      { ...trusted, repository: { ...trusted.repository, id: 'changed' } },
      payload.repositoryOrigin,
    ],
    [base, trusted, 'changed'],
    [
      { ...base, policy: { ...trusted, trustedSigners: [] } },
      trusted,
      payload.repositoryOrigin,
    ],
  ] as Array<[typeof base, MaintainerPolicy, string]>)
    assert.throws(
      () => assertTaskMandateRepositoryTrust(payload, signed, current, origin),
      { code: 'TASK_MANDATE_REPOSITORY_MISMATCH' },
    );
  const unreadCurrent = {
    ...trusted,
    get repository(): MaintainerPolicy['repository'] {
      return assert.fail('read current policy after signed-base mismatch');
    },
  };
  assert.throws(
    () =>
      assertTaskMandateRepositoryTrust(
        payload,
        { ...base, policyBlob: '0'.repeat(40) },
        unreadCurrent,
        'changed',
      ),
    { code: 'TASK_MANDATE_REPOSITORY_MISMATCH' },
  );
});

test('audit inputs preserve authority identity, original timestamps and distinct reservation/invocation facts', () => {
  const value = record();
  const [scope, authorization] = taskMandateAuthorizationAuditInput(
    '/repo',
    value,
  );
  assert.deepEqual(scope, {
    externalAuditRoot: '/audit',
    repositoryRoot: '/repo',
    repositoryId: `sha256:${crypto.createHash('sha256').update('{"kind":"authority-audit-repository.v1","repositoryIdentity":"github:R_fixture","schemaVersion":1}').digest('hex')}`,
  });
  assert.equal(authorization.eventType, 'task-mandate');
  assert.equal(authorization.occurredAt, issuedAt);
  assert.deepEqual(authorization.actor, {
    kind: 'human',
    identity: 'maintainer',
  });
  assert.equal(
    authorization.grantDigest,
    `sha256:${taskMandateBinding(value).mandateDigest}`,
  );
  assert.equal(authorization.command?.name, 'task.authorize');
  assert.equal(authorization.providerInvocation, null);
  assert.throws(() => taskMandateRevocationAuditInput('/repo', value), {
    code: 'TASK_MANDATE_STORE_UNSAFE',
  });
  value.state = 'revoked';
  value.revokedAt = '2026-08-03T09:01:00.000Z';
  value.revocationReason = 'Stop preparation';
  const [, revocation] = taskMandateRevocationAuditInput('/repo', value);
  assert.equal(revocation.eventType, 'revoke');
  assert.equal(revocation.occurredAt, value.revokedAt);
  const reservation = {
    reservationId: 'reservation-a',
    authorizedAt: issuedAt,
    requestDigest: 'c'.repeat(64),
    operationDigest: 'd'.repeat(64),
  };
  const [, reserved] = taskMandateProviderReservationAuditInput(
    '/repo',
    value,
    providerId,
    reservation,
  );
  const input = {
    providerId,
    invocationId: reservation.reservationId,
    requestDigest: reservation.requestDigest,
    occurredAt: '2026-08-03T09:02:00.000Z',
  };
  const [, invocation] = taskMandateProviderInvocationAuditInput(
    '/repo',
    value,
    input,
  );
  assert.equal(reserved.eventType, 'grant-consume');
  assert.equal(reserved.occurredAt, issuedAt);
  assert.equal(invocation.eventType, 'provider-invocation');
  assert.equal(invocation.occurredAt, input.occurredAt);
  assert.deepEqual(invocation.providerInvocation, {
    providerId,
    invocationId: reservation.reservationId,
    requestDigest: `sha256:${reservation.requestDigest}`,
  });
  assert.notEqual(reserved.idempotencyKey, invocation.idempotencyKey);
});
