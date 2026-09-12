import { recordAuthorityRefusal } from '../src/runtime/storage-journal/authority-refusal-audit.ts';
import { withAuthorityRefusalAudit } from '../src/composition-root/authority-refusal-production.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deriveAuthorityAuditRepositoryId } from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import { authorityRefusalDigest } from '../src/modules/authority/authority-refusal-audit.ts';
import { verifyAuthorityAuditEvents } from '../src/runtime/storage-journal/authority-audit-service.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';

function fixture(): {
  root: string;
  binding: AuthorityRefusalAuditBinding;
  cleanup: () => void;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'authority-refusal-audit-')),
  );
  fs.chmodSync(root, 0o700);
  const repositoryRoot = path.join(root, 'repository');
  const externalAuditRoot = path.join(root, 'audit');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  fs.mkdirSync(externalAuditRoot, { mode: 0o700 });
  const bindingDigest = authorityRefusalDigest({
    mandateId: 'mandate-1',
    taskId: 'task-1',
  });
  return {
    root,
    binding: {
      scope: {
        repositoryRoot,
        externalAuditRoot,
        repositoryId: deriveAuthorityAuditRepositoryId(
          'github:example/authority-refusal-audit',
        ),
      },
      family: 'task-mandate',
      operation: 'task-mandate.operation',
      subjectId: 'mandate-1',
      actor: { kind: 'engine', identity: 'workflow-engine' },
      taskId: 'task-1',
      changeId: 'change-1',
      workflowId: 'mandate-1',
      grantDigest: digest('grant'),
      bindingDigest,
      refusalIdentity: {
        mandateId: 'mandate-1',
        effectKind: 'managed-commit',
      },
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function digest(seed: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

test('trusted authority refusals retain the stable error code and exact durable retry identity', () => {
  const value = fixture();
  try {
    const refusal = workflowError(
      'TASK_MANDATE_EFFECT_NOT_ALLOWED',
      'The active Task Mandate does not authorize this effect.',
      ExitCode.guard,
    );

    assert.throws(
      () =>
        withAuthorityRefusalAudit(
          value.binding,
          {
            now: new Date('2026-08-04T01:02:03.000Z'),
            serviceHooks: {
              testAfterLedgerAppend() {
                throw new Error('simulated-audit-projection-crash');
              },
            },
          },
          () => {
            throw refusal;
          },
        ),
      (error) =>
        error === refusal &&
        error instanceof WorkflowError &&
        error.code === 'TASK_MANDATE_EFFECT_NOT_ALLOWED' &&
        error.cause instanceof Error &&
        error.cause.message === 'simulated-audit-projection-crash',
    );

    const recovered = recordAuthorityRefusal(value.binding, refusal, {
      now: new Date('2026-08-04T09:10:11.000Z'),
    });
    const duplicate = recordAuthorityRefusal(value.binding, refusal, {
      now: new Date('2026-08-05T09:10:11.000Z'),
    });

    assert.deepEqual(duplicate, recovered);
    assert.equal(recovered.ledger.record.sequence, 1);
    assert.equal(recovered.event.occurredAt, '2026-08-04T01:02:03.000Z');
    assert.equal(recovered.event.eventType, 'error');
    assert.equal(recovered.event.result, 'failed');
    assert.equal(recovered.event.errorCode, refusal.code);
    assert.equal(recovered.event.prestateDigest, value.binding.bindingDigest);
    assert.equal(verifyAuthorityAuditEvents(value.binding.scope).ok, true);
  } finally {
    value.cleanup();
  }
});

test('non-workflow and audit-infrastructure failures are never recast as authority refusals', () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        withAuthorityRefusalAudit(value.binding, {}, () => {
          throw new TypeError('malformed-unbound-input');
        }),
      /malformed-unbound-input/,
    );
    assert.throws(
      () =>
        withAuthorityRefusalAudit(value.binding, {}, () => {
          throw workflowError(
            'AUTHORITY_AUDIT_SCOPE_INVALID',
            'Audit scope is not trusted.',
            ExitCode.verification,
          );
        }),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AUTHORITY_AUDIT_SCOPE_INVALID',
    );
    assert.equal(
      fs.existsSync(path.join(value.binding.scope.externalAuditRoot, 'v1')),
      false,
    );
  } finally {
    value.cleanup();
  }
});

import { type AuthorityRefusalAuditBinding } from '../src/modules/authority/authority-audit-contract.ts';

import {
  createAuthorityRefusalIdentity,
  createAuthorityRefusalEventInput,
  withAuthorityRefusalAudit as withRefusalRecorder,
} from '../src/modules/authority/authority-refusal-audit.ts';
import type {
  AuthorityAuditRecordedEvent,
  RecordAuthorityRefusal,
} from '../src/modules/authority/authority-audit-contract.ts';
import { createHarnessBootstrapAudit } from '../src/application/control-plane/harness-bootstrap-audit.ts';
import type { HarnessRecoveryRefusalAuthority } from '../src/application/control-plane/harness-bootstrap-contracts.ts';

const memoryBinding: AuthorityRefusalAuditBinding = {
  scope: {
    repositoryRoot: '/fixture/repository',
    externalAuditRoot: '/fixture/audit',
    repositoryId: `sha256:${'a'.repeat(64)}`,
  },
  family: 'task-mandate',
  operation: 'task-mandate.operation',
  subjectId: 'mandate-1',
  actor: { kind: 'engine', identity: 'workflow-engine' },
  taskId: 'task-1',
  changeId: 'change-1',
  workflowId: 'mandate-1',
  grantDigest: `sha256:${'b'.repeat(64)}`,
  bindingDigest: `sha256:${'c'.repeat(64)}`,
  refusalIdentity: { mandateId: 'mandate-1', effectKind: 'managed-commit' },
};

function memoryRefusal() {
  return workflowError(
    'TASK_MANDATE_EFFECT_NOT_ALLOWED',
    'refused',
    ExitCode.guard,
  );
}

test('pure refusal builders reproduce stable event bytes without repository services or clocks', () => {
  const error = memoryRefusal();
  const identity = createAuthorityRefusalIdentity(memoryBinding, error);
  assert.equal(
    identity.idempotencyKey,
    'sha256:7f8a8f43780b94aae53a0c84030fa805d1c2cc5c5b655159a43c846e6b89fe98',
  );
  const occurredAt = '2026-08-04T01:02:03.000Z';
  const event = createAuthorityRefusalEventInput(
    memoryBinding,
    error,
    identity,
    occurredAt,
  );
  assert.deepEqual(event, {
    eventType: 'error',
    occurredAt,
    idempotencyKey:
      'sha256:7f8a8f43780b94aae53a0c84030fa805d1c2cc5c5b655159a43c846e6b89fe98',
    actor: memoryBinding.actor,
    taskId: 'task-1',
    changeId: 'change-1',
    workflowId: 'mandate-1',
    grantDigest: memoryBinding.grantDigest,
    candidateBundleDigest: null,
    prestateDigest: memoryBinding.bindingDigest,
    poststateDigest: null,
    command: {
      name: 'task-mandate.operation',
      argvDigest:
        'sha256:564333eb612d35743459feaaba3e9e7e1c3a5afe2d980ac5cd3109b7f9378aa1',
    },
    providerInvocation: null,
    externalEffect: null,
    result: 'failed',
    outcomeDigest:
      'sha256:2720c515b6aadd230f649df55cfffc1ecdd7f20ccd4147633d79754d53a94d9d',
    errorCode: 'TASK_MANDATE_EFFECT_NOT_ALLOWED',
  });
  const candidate = {
    ...memoryBinding,
    candidateBundleDigest: digest('candidate'),
  };
  assert.deepEqual(createAuthorityRefusalIdentity(candidate, error), identity);
  assert.deepEqual(
    createAuthorityRefusalEventInput(candidate, error, identity, 'later'),
    {
      ...event,
      candidateBundleDigest: candidate.candidateBundleDigest,
      occurredAt: 'later',
    },
  );
  assert.notEqual(
    createAuthorityRefusalIdentity(
      memoryBinding,
      workflowError('TASK_MANDATE_REVOKED', 'revoked', ExitCode.guard),
    ).idempotencyKey,
    identity.idempotencyKey,
  );
});

test('required recorder receives exact trusted objects while successful operations and bypasses stay untouched', () => {
  const calls: Parameters<RecordAuthorityRefusal>[] = [];
  // The policy treats the recorder's durable result as opaque.
  const recorded = Object.freeze({}) as AuthorityAuditRecordedEvent;
  const record: RecordAuthorityRefusal = (...args) => {
    calls.push(args);
    return recorded;
  };
  const options = { now: new Date('2026-08-04T01:02:03.000Z') };
  const result = { accepted: true };
  assert.equal(
    withRefusalRecorder(record, memoryBinding, options, () => result),
    result,
  );
  const promise = Promise.resolve(result);
  assert.equal(
    withRefusalRecorder(record, memoryBinding, options, () => promise),
    promise,
  );
  for (const error of [
    new TypeError('unbound'),
    workflowError('AUTHORITY_AUDIT_SCOPE_INVALID', 'audit', ExitCode.guard),
  ]) {
    assert.throws(
      () =>
        withRefusalRecorder(record, memoryBinding, options, () => {
          throw error;
        }),
      (actual) => actual === error,
    );
  }
  assert.equal(calls.length, 0);
  const error = memoryRefusal();
  assert.throws(
    () =>
      withRefusalRecorder(record, memoryBinding, options, () => {
        throw error;
      }),
    (actual) => actual === error,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], memoryBinding);
  assert.equal(calls[0]![1], error);
  assert.equal(calls[0]![2], options);
  assert.equal(error.cause, undefined);
});

test('audit failure is secondary with exact cause ordering and property descriptors', () => {
  const auditFailure = new Error('audit failed');
  const record: RecordAuthorityRefusal = () => {
    throw auditFailure;
  };
  for (const previous of [undefined, null, new Error('previous cause')]) {
    const error = memoryRefusal();
    if (previous !== undefined)
      Object.defineProperty(error, 'cause', {
        value: previous,
        configurable: true,
      });
    assert.throws(
      () =>
        withRefusalRecorder(record, memoryBinding, {}, () => {
          throw error;
        }),
      (actual) => actual === error,
    );
    if (previous === undefined) assert.equal(error.cause, auditFailure);
    else {
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.message, 'Authority refusal audit also failed.');
      assert.deepEqual(error.cause.errors, [previous, auditFailure]);
    }
    assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'cause'), {
      value: error.cause,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }
});

test('frozen or unreadable refusal causes cannot replace the original error', () => {
  const frozen = Object.freeze(memoryRefusal());
  const unreadable = memoryRefusal();
  Object.defineProperty(unreadable, 'cause', {
    get() {
      throw new Error('unreadable cause');
    },
  });
  for (const error of [frozen, unreadable]) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    assert.throws(
      () =>
        withRefusalRecorder(
          () => {
            throw new Error('append failed');
          },
          memoryBinding,
          {},
          () => {
            throw error;
          },
        ),
      (actual) => actual === error,
    );
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(error, 'cause'),
      descriptor,
    );
  }
});

test('durable occurrence bypasses invalid caller time while the explicit service clock retains priority', () => {
  const value = fixture();
  try {
    const error = memoryRefusal();
    const first = recordAuthorityRefusal(value.binding, error, {
      now: new Date('2026-08-04T01:02:03.000Z'),
    });
    let reads = 0;
    const retry = recordAuthorityRefusal(value.binding, error, {
      now: new Date(NaN),
      serviceHooks: {
        now() {
          reads += 1;
          return new Date('2026-08-04T09:10:11.000Z');
        },
      },
    });
    assert.deepEqual(retry, first);
    assert.equal(reads, 1);
  } finally {
    value.cleanup();
  }
});

test('invalid fresh time writes no refusal and onRecord runs only after durable append', () => {
  const value = fixture();
  try {
    const error = memoryRefusal();
    assert.throws(
      () =>
        recordAuthorityRefusal(value.binding, error, { now: new Date(NaN) }),
      {
        name: 'TypeError',
        message: 'Authority refusal audit time is invalid.',
      },
    );
    assert.equal(
      verifyAuthorityAuditEvents(value.binding.scope).events.length,
      0,
    );
    const callbackFailure = new Error('consumer projection failed');
    assert.throws(
      () =>
        withAuthorityRefusalAudit(
          value.binding,
          {
            now: new Date('2026-08-04T01:02:03.000Z'),
            onRecord(entry) {
              assert.equal(
                verifyAuthorityAuditEvents(value.binding.scope).events[0]!
                  .eventDigest,
                entry.eventDigest,
              );
              throw callbackFailure;
            },
          },
          () => {
            throw error;
          },
        ),
      (actual) => actual === error && error.cause === callbackFailure,
    );
    assert.equal(
      verifyAuthorityAuditEvents(value.binding.scope).events.length,
      1,
    );
  } finally {
    value.cleanup();
  }
});

test('harness uses its injected recorder and preserves its distinct clock and secondary-cause policy', () => {
  const trace: string[] = [];
  const previous = new Error('original cause');
  const auditFailure = new Error('record failed');
  const now = new Date('2026-08-04T01:02:03.000Z');
  const authority: HarnessRecoveryRefusalAuthority = {
    repositoryRoot: memoryBinding.scope.repositoryRoot,
    marker: {
      kind: 'recovery-quarantine-marker.v1',
      repositoryId: 'github:example/recovery',
      authorityDescriptorDigest: digest('descriptor'),
      authorityGeneration: 1,
      recoveryRuntimeDigest: digest('runtime'),
      externalAuditRoot: memoryBinding.scope.externalAuditRoot,
      enterGrantId: 'enter-1',
      enterEnvelopeDigest: digest('envelope'),
      enteredAt: now.toISOString(),
      markerDigest: digest('marker'),
    },
  };
  const audit = createHarnessBootstrapAudit({
    deriveAuthorityAuditRepositoryId() {
      trace.push('repository-id');
      return memoryBinding.scope.repositoryId;
    },
    recordAuthorityAuditEvent() {
      assert.fail('unrelated event writer');
    },
    recordAuthorityRefusal(binding, error, options) {
      trace.push('record');
      assert.equal(binding.scope.repositoryRoot, authority.repositoryRoot);
      assert.equal(binding.bindingDigest, authority.marker.markerDigest);
      assert.equal(binding.operation, 'harness-bootstrap.rejection');
      assert.equal(binding.family, 'recovery-authority');
      assert.equal(error, refusal);
      assert.equal(options!.now, now);
      throw auditFailure;
    },
  });
  const overrides = {
    now() {
      trace.push('clock');
      return now;
    },
  };
  const refusal = memoryRefusal();
  Object.defineProperty(refusal, 'cause', {
    value: previous,
    configurable: true,
  });
  audit.auditHarnessRecoveryRefusal(authority, ['restore'], refusal, overrides);
  assert.deepEqual(trace, ['repository-id', 'clock', 'record']);
  assert.ok(refusal.cause instanceof AggregateError);
  assert.equal(refusal.cause.message, 'Recovery refusal audit also failed.');
  assert.deepEqual(refusal.cause.errors, [previous, auditFailure]);
  trace.length = 0;
  audit.auditHarnessRecoveryRefusal(
    authority,
    [],
    workflowError('AUTHORITY_AUDIT_SCOPE_INVALID', 'audit', ExitCode.guard),
    overrides,
  );
  assert.deepEqual(trace, []);
});
