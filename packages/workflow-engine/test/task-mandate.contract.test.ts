import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from '../src/runtime/storage-journal/authority-audit-service.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import type { MaintainerSignerProvider } from '../src/adapters/signing/ssh/maintainer-signer.ts';
import {
  authorizeTaskMandate,
  authorizeTaskMandateOperation,
  authorizeTaskMandateProviderReservation,
  canonicalTaskMandateEnvelope,
  canonicalTaskMandatePayload,
  inspectActiveTaskMandateBinding,
  inspectTaskMandate,
  parseTaskMandateEnvelope,
  revokeTaskMandate,
  type TaskMandateEnvelope,
} from '../src/modules/authority/task-mandate.ts';
import { git, isWorkflowError, sourceRepositoryRoot } from './fixture.ts';
import {
  TASK_ID,
  CHANGE_ID,
  MANDATE_ID,
  ISSUED_AT,
  externalAuditRoot,
  cleanupRepository,
  auditScope,
  prepareRepository,
  request,
  fakeSigner,
} from './task-mandate-fixture.ts';

test('task mandate signs a safe preparation-only contract without changing HEAD', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  try {
    const beforeHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const beforeStatus = git(repository, ['status', '--porcelain=v1', '-z']);
    const result = authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer: fakeSigner(signed),
    });

    assert.equal(result.envelope.payload.kind, 'task-mandate.v2');
    assert.equal(result.envelope.payload.changeId, CHANGE_ID);
    assert.equal(
      result.envelope.payload.externalAuditRoot,
      externalAuditRoot(repository),
    );
    assert.equal(result.envelope.payload.taskId, TASK_ID);
    assert.equal(result.envelope.payload.authoritativeEffects, false);
    assert.equal(result.envelope.payload.controlPlaneMutation, false);
    assert.deepEqual(result.envelope.payload.secretScopes, []);
    assert.equal(
      result.envelope.payload.preparation.isolatedRepositoryWrites,
      true,
    );
    assert.equal(result.envelope.payload.validUntil.inactivityDays, 14);
    assert.equal(
      signed[0],
      canonicalTaskMandatePayload(result.envelope.payload),
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), beforeHead);
    assert.equal(
      git(repository, ['status', '--porcelain=v1', '-z']),
      beforeStatus,
    );

    const canonical = canonicalTaskMandateEnvelope(result.envelope);
    assert.deepEqual(parseTaskMandateEnvelope(canonical), result.envelope);
    assert.equal(
      fs.readFileSync(result.recordPath, 'utf8').includes(canonical.trim()),
      true,
    );
    assert.equal(result.audit.event.taskId, TASK_ID);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate'],
    );

    const tampered = JSON.parse(canonical) as TaskMandateEnvelope;
    tampered.payload.authoritativeEffects = true as false;
    assert.throws(
      () => parseTaskMandateEnvelope(`${JSON.stringify(tampered)}\n`),
      (error) => isWorkflowError(error, 'TASK_MANDATE_INVALID'),
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('current mandate parser and store reject canonical V1 bytes', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const authorized = authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });
    const legacy = JSON.parse(
      fs.readFileSync(authorized.recordPath, 'utf8'),
    ) as Record<string, any>;
    legacy.schemaVersion = 1;
    delete legacy.changeId;
    delete legacy.externalAuditRoot;
    legacy.envelope.payload.kind = 'task-mandate.v1';
    delete legacy.envelope.payload.changeId;
    delete legacy.envelope.payload.externalAuditRoot;
    for (const usage of Object.values(
      legacy.providerUsage as Record<string, Record<string, unknown>>,
    )) {
      delete usage.reservations;
    }
    assert.throws(
      () => parseTaskMandateEnvelope(`${canonicalJson(legacy.envelope)}\n`),
      (error) => isWorkflowError(error, 'TASK_MANDATE_INVALID'),
    );
    fs.writeFileSync(authorized.recordPath, `${canonicalJson(legacy)}\n`);

    assert.throws(
      () =>
        inspectTaskMandate(repository, TASK_ID, {
          now: new Date('2026-08-03T10:00:00.000Z'),
          signer,
        }),
      (error) => isWorkflowError(error, 'TASK_MANDATE_STORE_UNSAFE'),
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('task mandate evaluator permits bounded preparation and denies authority expansion', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });

    const local = authorizeTaskMandateOperation(
      repository,
      TASK_ID,
      { kind: 'local-command' },
      {
        changeId: CHANGE_ID,
        now: new Date('2026-08-03T10:00:00.000Z'),
        signer,
      },
    );
    assert.equal(local.authorized, true);
    assert.equal(local.binding.changeId, CHANGE_ID);
    assert.equal(local.binding.mandateTaskId, TASK_ID);
    assert.deepEqual(
      inspectActiveTaskMandateBinding(repository, TASK_ID, {
        now: new Date('2026-08-03T10:30:00.000Z'),
        signer,
      }),
      local.binding,
    );
    assert.throws(
      () =>
        authorizeTaskMandateOperation(
          repository,
          TASK_ID,
          { kind: 'repository-read' },
          {
            changeId: 'another-change',
            now: new Date('2026-08-03T10:30:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_CHANGE_MISMATCH'),
    );
    assert.throws(
      () =>
        authorizeTaskMandateProviderReservation(
          repository,
          { ...local.binding, changeId: 'another-change' },
          'cross-change-invocation',
          {
            providerId: 'codex',
            dataTypes: ['source-code'],
            sourceCode: true,
            secrets: false,
            retry: false,
            budget: null,
            requestDigest: 'c'.repeat(64),
          },
          { now: new Date('2026-08-03T10:30:00.000Z'), signer },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_BINDING_STALE'),
    );
    assert.throws(
      () =>
        authorizeTaskMandateProviderReservation(
          repository,
          { ...local.binding, mandateTaskId: 'another-task' },
          'cross-task-invocation',
          {
            providerId: 'codex',
            dataTypes: ['source-code'],
            sourceCode: true,
            secrets: false,
            retry: false,
            budget: null,
            requestDigest: 'd'.repeat(64),
          },
          { now: new Date('2026-08-03T10:30:00.000Z'), signer },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_NOT_FOUND'),
    );

    const provider = authorizeTaskMandateProviderReservation(
      repository,
      local.binding,
      'survey-invocation-1',
      {
        providerId: 'codex',
        dataTypes: ['source-code'],
        sourceCode: true,
        secrets: false,
        retry: false,
        budget: null,
        requestDigest: 'a'.repeat(64),
      },
      { now: new Date('2026-08-03T11:00:00.000Z'), signer },
    );
    assert.deepEqual(provider.providerUsage, {
      invocations: 1,
      budget: 0,
    });
    assert.deepEqual(
      authorizeTaskMandateProviderReservation(
        repository,
        local.binding,
        'survey-invocation-1',
        {
          providerId: 'codex',
          dataTypes: ['source-code'],
          sourceCode: true,
          secrets: false,
          retry: false,
          budget: null,
          requestDigest: 'a'.repeat(64),
        },
        { now: new Date('2026-08-03T11:30:00.000Z'), signer },
      ).providerUsage,
      { invocations: 1, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'error', 'grant-consume'],
    );
    assert.equal(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.find(
        ({ event }) => event.eventType === 'error',
      )?.event.errorCode,
      'TASK_MANDATE_CHANGE_MISMATCH',
    );

    assert.throws(
      () =>
        authorizeTaskMandateProviderReservation(
          repository,
          local.binding,
          'survey-invocation-2',
          {
            providerId: 'codex',
            dataTypes: ['source-code'],
            sourceCode: true,
            secrets: false,
            retry: false,
            budget: null,
            requestDigest: 'b'.repeat(64),
          },
          { now: new Date('2026-08-03T12:00:00.000Z'), signer },
        ),
      (error) =>
        isWorkflowError(error, 'TASK_MANDATE_PROVIDER_BUDGET_EXHAUSTED'),
    );
    assert.throws(
      () =>
        authorizeTaskMandateOperation(
          repository,
          TASK_ID,
          { kind: 'control-plane-mutation' },
          {
            changeId: CHANGE_ID,
            now: new Date('2026-08-03T12:00:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_EFFECT_NOT_AUTHORIZED'),
    );

    const status = inspectTaskMandate(repository, TASK_ID, {
      now: new Date('2026-08-03T12:00:00.000Z'),
      signer,
    });
    assert.equal(status.state, 'active');
    assert.equal(status.lastActivityAt, '2026-08-03T11:00:00.000Z');
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID)
        .events.filter(({ event }) => event.eventType === 'error')
        .map(({ event }) => event.errorCode),
      ['TASK_MANDATE_CHANGE_MISMATCH', 'TASK_MANDATE_EFFECT_NOT_AUTHORIZED'],
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('task mandate revoke records a trusted interactive refusal without mutating the mandate', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  const unattendedSigner: MaintainerSignerProvider = {
    ...signer,
    assertHumanPresent() {
      throw workflowError(
        'MAINTAINER_INTERACTIVE_REQUIRED',
        'A controlling interactive terminal is required.',
        ExitCode.unsafeEnvironment,
      );
    },
  };
  try {
    authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });

    assert.throws(
      () =>
        revokeTaskMandate(repository, TASK_ID, {
          reason: 'Attempt unattended revocation.',
          now: new Date('2026-08-03T10:00:00.000Z'),
          signer: unattendedSigner,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_INTERACTIVE_REQUIRED'),
    );

    assert.equal(
      inspectTaskMandate(repository, TASK_ID, {
        now: new Date('2026-08-03T10:01:00.000Z'),
        signer,
      }).state,
      'active',
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => ({
          eventType: event.eventType,
          errorCode: event.errorCode,
        }),
      ),
      [
        { eventType: 'task-mandate', errorCode: null },
        {
          eventType: 'error',
          errorCode: 'MAINTAINER_INTERACTIVE_REQUIRED',
        },
      ],
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('task mandate expires by inactivity and can be explicitly revoked', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });
    assert.equal(
      inspectTaskMandate(repository, TASK_ID, {
        now: new Date('2026-08-18T09:00:00.000Z'),
        signer,
      }).state,
      'expired',
    );
    assert.throws(
      () =>
        authorizeTaskMandateOperation(
          repository,
          TASK_ID,
          { kind: 'repository-read' },
          {
            changeId: CHANGE_ID,
            now: new Date('2026-08-18T09:00:00.000Z'),
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_MANDATE_EXPIRED'),
    );

    const revoked = revokeTaskMandate(repository, TASK_ID, {
      now: new Date('2026-08-18T10:00:00.000Z'),
      reason: 'Task is no longer required.',
      signer,
    });
    assert.equal(revoked.state, 'revoked');
    assert.equal(
      inspectTaskMandate(repository, TASK_ID, {
        now: new Date('2026-08-18T11:00:00.000Z'),
        signer,
      }).state,
      'revoked',
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'error', 'revoke'],
    );
    assert.equal(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.find(
        ({ event }) => event.eventType === 'error',
      )?.event.errorCode,
      'TASK_MANDATE_EXPIRED',
    );

    const replacement = authorizeTaskMandate(
      repository,
      {
        ...request(),
        intent: 'Replace the task intent after explicit revocation.',
      },
      {
        mandateId: '55555555-5555-4555-8555-555555555555',
        externalAuditRoot: externalAuditRoot(repository),
        now: new Date('2026-08-18T12:00:00.000Z'),
        signer,
      },
    );
    assert.equal(
      replacement.envelope.payload.mandateId.startsWith('5555'),
      true,
    );
    assert.equal(
      inspectTaskMandate(repository, TASK_ID, {
        now: new Date('2026-08-18T12:01:00.000Z'),
        signer,
      }).state,
      'active',
    );
    assert.equal(
      fs.readdirSync(
        path.join(repository, '.git/workflow-engine/task-mandates/history'),
      ).length,
      1,
    );
    assert.equal(verifyAuthorityAuditEvents(auditScope(repository)).ok, true);
  } finally {
    cleanupRepository(repository);
  }
});

test('task authorize CLI refuses unattended signing before creating mandate state', () => {
  const repository = prepareRepository();
  const manifest = path.join(repository, 'task-mandate.json');
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  fs.writeFileSync(manifest, `${JSON.stringify(request(), null, 2)}\n`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'task',
        'authorize',
        manifest,
        '--audit-root',
        externalAuditRoot(repository),
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(result.status, 12, result.stderr);
    const output = JSON.parse(result.stderr) as {
      error: { code: string };
    };
    assert.equal(output.error.code, 'MAINTAINER_INTERACTIVE_REQUIRED');
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/task-mandates'),
      ),
      false,
    );
  } finally {
    cleanupRepository(repository);
  }
});
