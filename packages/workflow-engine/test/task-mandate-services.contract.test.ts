import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskMandateOperations } from '../src/application/control-plane/task-mandate.ts';
import {
  parseCurrentTaskMandateRecord,
  canonicalTaskMandateRecord,
  canonicalTaskMandatePayload,
} from '../src/modules/authority/task-mandate-records.ts';

import { type TaskMandateRecord } from '../src/modules/authority/task-mandate-values.ts';
import type { TaskMandateServices } from '../src/modules/authority/task-mandate-services.ts';
import { type AuthorityAuditRecordedEvent } from '../src/modules/authority/authority-audit-contract.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import {
  appendTaskMandateAuthorizationAudit,
  appendTaskMandateRevocationAudit,
  appendTaskMandateProviderReservationAudit,
  appendTaskMandateProviderInvocationAudit,
} from '../src/application/control-plane/task-mandate-audit.ts';
import { validateTaskMandateEnvelopeForRepository } from '../src/application/control-plane/task-mandate-trust.ts';

import { listBuiltInProviders } from '../src/modules/provider-orchestration/provider-registry.ts';

function fixture() {
  const events: string[] = [];
  const files = new Map<string, string>();
  const now = new Date('2026-08-03T09:00:00.000Z');
  let owned = false;
  let assertFailure: unknown;
  let assertionCount = 0;
  let failAssertionAt = Infinity;
  let liveOrigin = 'https://github.com/example/fixture.git';
  const runtime = {
    root: '/runtime',
    locks: '/locks',
    operations: '/operations',
    sessions: '/sessions',
    reports: '/reports',
    taskRevisions: '/revisions',
  };
  const paths = {
    runtime,
    root: '/mandates',
    active: '/mandates/active',
    terminal: '/mandates/terminal',
    history: '/mandates/history',
  };
  const receipt = Object.freeze({}) as AuthorityAuditRecordedEvent;
  const signer = {
    assertHumanPresent() {
      events.push('human');
    },
    identity() {
      return 'maintainer';
    },
    sign() {
      events.push('sign');
      return '-----BEGIN SSH SIGNATURE-----\nYWJj\n-----END SSH SIGNATURE-----\n';
    },
    verify() {
      events.push('verify');
    },
  };
  const policy = {
    schemaVersion: 1 as const,
    repository: {
      id: 'github:R_fixture',
      origin: 'https://github.com/example/fixture.git',
    },
    phase: 'bootstrap' as const,
    auditTagPrefix: 'refs/tags/grant/',
    signatureNamespace: 'other',
    maxTtlMinutes: 30 as const,
    maxUses: 1 as const,
    bootstrapEligiblePaths: [],
    sealedImmutablePaths: [],
    requiredChecks: [],
    trustedSigners: [
      { identity: 'maintainer', publicKey: 'fixture', fingerprint: 'fixture' },
    ],
  };
  const services: TaskMandateServices = {
    now() {
      events.push('clock');
      return now;
    },
    newMandateId() {
      return '44444444-4444-4444-8444-444444444444';
    },
    repository: {
      discoverRepository() {
        events.push('discover');
        return {
          repositoryRoot: '/repo',
          gitCommonDirectory: '/common',
          head: 'a'.repeat(40),
        };
      },
      loadPolicyAt() {
        events.push('policy');
        return { policy, policyBlob: 'b'.repeat(40) };
      },
      repositoryHead() {
        events.push('head');
        return 'a'.repeat(40);
      },
      repositoryOrigin() {
        events.push('origin');
        return liveOrigin;
      },
      createInteractiveSshSigner() {
        return signer;
      },
      isPostApprovalAdmissionFailure(error) {
        return error === assertFailure;
      },
    },
    store: {
      taskMandateStorePaths() {
        return paths;
      },
      ensureStore() {
        events.push('ensure');
      },
      taskRecordPath(directory, taskId) {
        return directory + '/' + taskId + '.json';
      },
      taskHistoryPath(directory, taskId, id) {
        return directory + '/' + taskId + '.' + id + '.json';
      },
      readTaskRecord(paths, taskId) {
        events.push('read:' + owned);
        return parseCurrentTaskMandateRecord(
          files.get(paths.active + '/' + taskId + '.json') ??
            files.get(paths.terminal + '/' + taskId + '.json')!,
        );
      },
      createPrivateFileAtomic(file, content) {
        events.push('create:' + owned);
        files.set(file, content);
      },
      replacePrivateFileAtomic(file, content) {
        events.push('replace:' + owned);
        files.set(file, content);
      },
      readPrivateFile(file) {
        events.push('private-read');
        return files.get(file)!;
      },
      fsyncDirectory() {
        events.push('fsync');
      },
      exists(file) {
        return files.has(file);
      },
      move(source, destination) {
        events.push('move:' + owned);
        files.set(destination, files.get(source)!);
        files.delete(source);
      },
    },
    audit: {
      scanAuthorityAuditLedger() {
        events.push('scan');
      },
      recordAuthorityAuditEvent(_scope, input) {
        events.push('audit:' + input.eventType + ':' + owned);
        return receipt;
      },

      withAuthorityRefusalAudit(_binding, _options, operation) {
        return operation();
      },
    },
    withRepositoryLifecycleOperation(_runtime, operation) {
      events.push('lock');
      owned = true;
      try {
        return operation(() => {
          events.push('owned');
          if (++assertionCount === failAssertionAt) throw assertFailure;
        });
      } finally {
        owned = false;
        events.push('release');
      }
    },
  };
  const operations = createTaskMandateOperations(services);
  function authorize() {
    return operations.authorizeTaskMandate(
      '/repo',
      {
        changeId: 'change',
        taskId: 'task',
        intent: 'Implement task',
        providerCalls: {},
      },
      { externalAuditRoot: '/audit', signer },
    );
  }
  function record(): TaskMandateRecord {
    return parseCurrentTaskMandateRecord(
      files.get('/mandates/active/task.json')!,
    );
  }
  return {
    services,
    operations,
    authorize,
    events,
    files,
    record,
    receipt,
    now,
    signer,
    changeOrigin(value: string) {
      liveOrigin = value;
    },
    loseLockAfter(assertions: number, error: unknown) {
      assertionCount = 0;
      failAssertionAt = assertions;
      assertFailure = error;
    },
  };
}

test('mandate required service construction does not observe repository, clock, signer or storage', () => {
  const f = fixture();
  assert.equal(f.events.length, 0);
  f.authorize();
  assert.ok(f.events.indexOf('human') < f.events.indexOf('sign'));
  assert.ok(f.events.indexOf('create:true') < f.events.indexOf('release'));
  assert.ok(
    f.events.indexOf('release') < f.events.indexOf('audit:task-mandate:false'),
  );
});

test('audit sink preserves plain-call receiver, hook arity and exact receipt or failure', () => {
  const f = fixture();
  f.authorize();
  const value = f.record();
  const calls: Parameters<
    TaskMandateServices['audit']['recordAuthorityAuditEvent']
  >[] = [];
  const audit = {
    recordAuthorityAuditEvent(
      this: unknown,
      ...args: Parameters<
        TaskMandateServices['audit']['recordAuthorityAuditEvent']
      >
    ) {
      assert.equal(this, undefined);
      calls.push(args);
      return f.receipt;
    },
  };
  assert.equal(
    appendTaskMandateAuthorizationAudit(audit, '/repo', value),
    f.receipt,
  );
  assert.equal(calls[0]!.length, 3);
  assert.deepEqual(calls[0]![2], {});
  appendTaskMandateAuthorizationAudit(audit, '/repo', value, f.now);
  assert.equal(calls[1]![2]!.now!(), f.now);
  assert.throws(() => appendTaskMandateRevocationAudit(audit, '/repo', value), {
    code: 'TASK_MANDATE_STORE_UNSAFE',
  });
  assert.equal(calls.length, 2);
  value.state = 'revoked';
  value.revokedAt = f.now.toISOString();
  value.revocationReason = 'Stop';
  appendTaskMandateRevocationAudit(audit, '/repo', value, f.now);
  assert.equal(calls[2]!.length, 3);
  assert.equal(calls[2]![2]!.now!(), f.now);
  const providerId = listBuiltInProviders()[0]!.id;
  const reservation = {
    reservationId: 'reservation-a',
    authorizedAt: f.now.toISOString(),
    requestDigest: 'c'.repeat(64),
    operationDigest: 'd'.repeat(64),
  };
  appendTaskMandateProviderReservationAudit(
    audit,
    '/repo',
    value,
    providerId,
    reservation,
  );
  appendTaskMandateProviderInvocationAudit(audit, '/repo', value, {
    providerId,
    invocationId: reservation.reservationId,
    requestDigest: reservation.requestDigest,
    occurredAt: f.now.toISOString(),
  });
  assert.equal(calls[3]!.length, 2);
  assert.equal(calls[4]!.length, 2);
  const failure = new Error('sink lost');
  assert.throws(
    () =>
      appendTaskMandateAuthorizationAudit(
        {
          recordAuthorityAuditEvent() {
            throw failure;
          },
        },
        '/repo',
        value,
      ),
    (error) => error === failure,
  );
});

test('trust observes original repository order and preserves the void verifier and admission sentinel', () => {
  const f = fixture();
  f.authorize();
  const envelope = f.record().envelope;
  f.events.length = 0;
  const signer = {
    ...f.signer,
    verify(
      bytes: string,
      signature: string,
      identity: string,
      namespace: string,
    ) {
      f.events.push('verify');
      assert.equal(bytes, canonicalTaskMandatePayload(envelope.payload));
      assert.equal(signature, envelope.signature);
      assert.equal(identity, envelope.payload.signer);
      assert.equal(namespace, 'HARNESS_TASK_MANDATE_V2');
    },
  };
  validateTaskMandateEnvelopeForRepository(
    f.services,
    '/repo',
    envelope,
    signer,
  );
  assert.deepEqual(f.events, [
    'policy',
    'head',
    'policy',
    'origin',
    'scan',
    'verify',
  ]);
  const admission = new Error('post-approval sentinel');
  f.loseLockAfter(1, admission);
  assert.throws(
    () =>
      validateTaskMandateEnvelopeForRepository(f.services, '/repo', envelope, {
        ...signer,
        verify() {
          throw admission;
        },
      }),
    (error) => error === admission,
  );
  assert.throws(
    () =>
      validateTaskMandateEnvelopeForRepository(f.services, '/repo', envelope, {
        ...signer,
        verify() {
          throw new Error('invalid signature');
        },
      }),
    { code: 'TASK_MANDATE_SIGNATURE_INVALID' },
  );
  f.events.length = 0;
  f.changeOrigin('changed');
  assert.throws(
    () =>
      validateTaskMandateEnvelopeForRepository(
        f.services,
        '/repo',
        envelope,
        signer,
      ),
    { code: 'TASK_MANDATE_REPOSITORY_MISMATCH' },
  );
  assert.deepEqual(f.events, ['policy', 'head', 'policy', 'origin']);
});

test('mandate admission reads fresh durable state under its lock and revalidates the live origin', () => {
  const f = fixture();
  f.authorize();
  f.events.length = 0;
  const binding = f.operations.inspectActiveTaskMandateBinding(
    '/repo',
    'task',
    { signer: f.signer },
  );
  assert.ok(f.events.indexOf('lock') < f.events.indexOf('read:true'));
  f.changeOrigin('https://example.test/changed');
  assert.throws(
    () =>
      f.operations.inspectActiveTaskMandateBinding('/repo', 'task', {
        signer: f.signer,
      }),
    { code: 'TASK_MANDATE_REPOSITORY_MISMATCH' },
  );
  f.changeOrigin('https://github.com/example/fixture.git');
  const revoked = f.record();
  revoked.state = 'revoked';
  revoked.revokedAt = f.now.toISOString();
  revoked.revocationReason = 'Revoked after first read';
  f.files.set(
    '/mandates/active/task.json',
    canonicalTaskMandateRecord(revoked),
  );
  assert.throws(
    () =>
      f.operations.withActiveTaskMandateBinding(
        '/repo',
        binding.mandateTaskId,
        { signer: f.signer },
        () => assert.fail('revoked mandate called continuation'),
      ),
    { code: 'TASK_MANDATE_REVOKED' },
  );
  assert.equal(f.events.at(-1), 'release');
});

test('mandate continuation errors keep object identity and release the lifecycle lock', () => {
  const f = fixture();
  f.authorize();
  const failure = workflowError(
    'TEST_CONTINUATION_FAILED',
    'exact failure',
    ExitCode.guard,
  );
  assert.throws(
    () =>
      f.operations.withActiveTaskMandateBinding(
        '/repo',
        'task',
        { signer: f.signer },
        () => {
          throw failure;
        },
      ),
    (error) => error === failure,
  );
  assert.equal(f.events.at(-1), 'release');
});

test('mandate lock loss after publication keeps committed bytes and the exact failure', () => {
  const f = fixture();
  f.authorize();
  f.events.length = 0;
  const failure = workflowError(
    'TEST_LEASE_LOST',
    'lease changed',
    ExitCode.conflict,
  );
  f.loseLockAfter(2, failure);
  assert.throws(
    () =>
      f.operations.authorizeTaskMandateOperation(
        '/repo',
        'task',
        { kind: 'local-command' },
        {
          changeId: 'change',
          signer: f.signer,
          now: new Date('2026-08-03T10:00:00.000Z'),
        },
      ),
    (error) => error === failure,
  );
  assert.equal(f.record().lastActivityAt, '2026-08-03T10:00:00.000Z');
  assert.deepEqual(
    f.events.filter(
      (x) =>
        x === 'lock' ||
        x === 'owned' ||
        x.startsWith('replace:') ||
        x === 'release',
    ),
    ['lock', 'owned', 'replace:true', 'owned', 'release'],
  );
});
