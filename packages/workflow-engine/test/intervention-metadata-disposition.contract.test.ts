import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSessionRuntimeLayoutPort } from '@jigwright/core/session-runtime-layout-port';
import { createInterventionMetadataDisposition } from '../src/application/control-plane/intervention-metadata-disposition.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import type { BootstrapInterventionCliDependencies } from '../src/modules/authority/intervention-bootstrap-contract.ts';

type Operations = Parameters<typeof createInterventionMetadataDisposition>[0];
const stateRoot = '/git-common/workflow-engine/intervention-control';
const bindingPath = `${stateRoot}/local-parent-sessions/47f75a2e2411996d90ac65ebd48fc5d9036b8124c5b39949155f538e70947375.json`;
const checkpointId = `sha256:${'a'.repeat(64)}` as const;
const workspaceId = `sha256:${'b'.repeat(64)}` as const;
const recordDigest = `sha256:${'c'.repeat(64)}` as const;
const signedAt = '2026-08-03T10:00:00.000Z';

function unexpectedOperation(): never {
  throw new Error('Unexpected external operation');
}

function operations(overrides: Partial<Operations> = {}): Operations {
  return {
    discoverRepository: unexpectedOperation,
    runtimePaths: unexpectedOperation,
    readMaintenanceGrantForParent: unexpectedOperation,
    assertPersistedInterventionAbandonable: unexpectedOperation,
    verifyAuthorityAuditEvents: unexpectedOperation,
    revokeMaintenanceGrantForParent: unexpectedOperation,
    authorizeHumanRevocation: unexpectedOperation,
    abandonPersistedIntervention: unexpectedOperation,
    readPersistedIntervention: unexpectedOperation,
    readLocalEngineBinding: unexpectedOperation,
    ...overrides,
  };
}

function memoryDisposition() {
  const trace: string[] = [];
  const failure = new Error('injected disposition interruption');
  let failAt: string | undefined;
  function observe(stage: string) {
    trace.push(stage);
    if (stage === failAt) throw failure;
  }
  // These verified records are opaque to this use case apart from the fields
  // below. Full record validation and durable replay have integration coverage.
  const intervention = {
    checkpoint: { checkpointId },
    childWorkspace: { workspaceId },
  } as ReturnType<Operations['readPersistedIntervention']>;
  const parentSession = {
    kind: 'local-parent-session-metadata.v2',
  } as ReturnType<Operations['readLocalEngineBinding']>;
  const before = {
    state: 'available',
    interventionChangeId: 'repair-A',
    checkpointId,
    envelope: { payload: { grantId: 'grant-A' } },
    authorityAudit: { externalAuditRoot: '/audit', repositoryId: recordDigest },
  } as ReturnType<Operations['readMaintenanceGrantForParent']>;
  const revoked = {
    ...before,
    state: 'revoked',
    recordDigest,
    revocationReason: 'Retire repair',
    revokedAt: signedAt,
  } as ReturnType<Operations['revokeMaintenanceGrantForParent']>;
  let abandonedEffects = true;
  const now = new Date('2026-08-03T11:00:00.000Z');
  const dependencies: BootstrapInterventionCliDependencies = {
    now() {
      observe('clock');
      return now;
    },
    verifyHumanSignature: unexpectedOperation,
    maintenanceSigner: {
      assertHumanPresent: unexpectedOperation,
      identity: unexpectedOperation,
      sign: unexpectedOperation,
      verify: unexpectedOperation,
    },
    testHooks: {
      afterAuthorityAuditRecorded: () => observe('after-audit'),
      afterAbandonmentIntentPersisted: () => observe('after-intent'),
    },
  };
  const services = operations({
    discoverRepository(cwd) {
      assert.equal(this, undefined);
      observe('discover');
      assert.equal(cwd, '/worktree');
      return {
        repositoryRoot: '/repository',
        repositoryRealPath: '/repository',
        gitCommonDirectory: '/git-common',
        branch: 'work/parent-A',
        head: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        statusEntries: [],
      };
    },
    runtimePaths(gitCommonDirectory, runtimeDirectory) {
      observe('paths');
      assert.equal(gitCommonDirectory, '/git-common');
      assert.equal(runtimeDirectory, 'workflow-engine');
      return defaultSessionRuntimeLayoutPort.resolve({
        gitCommonDirectory,
        runtimeDirectory,
      });
    },
    readPersistedIntervention(root, parentChangeId) {
      observe('intervention');
      assert.deepEqual([root, parentChangeId], [stateRoot, 'parent-A']);
      return intervention;
    },
    readLocalEngineBinding(file) {
      observe('binding');
      assert.equal(file, bindingPath);
      return parentSession;
    },
    readMaintenanceGrantForParent(root, parentChangeId) {
      observe('maintenance');
      assert.deepEqual([root, parentChangeId], [stateRoot, 'parent-A']);
      return before;
    },
    assertPersistedInterventionAbandonable(root, file, target) {
      observe('preflight');
      assert.deepEqual(
        [root, file, target],
        [
          stateRoot,
          bindingPath,
          {
            parentChangeId: 'parent-A',
            interventionChangeId: 'repair-A',
            checkpointId,
            grantId: 'grant-A',
          },
        ],
      );
    },
    verifyAuthorityAuditEvents(scope) {
      observe('audit');
      assert.deepEqual(scope, {
        externalAuditRoot: '/audit',
        repositoryRoot: '/repository',
        repositoryId: recordDigest,
      });
      return {} as ReturnType<Operations['verifyAuthorityAuditEvents']>;
    },
    revokeMaintenanceGrantForParent(
      authorize,
      cwd,
      root,
      parentChangeId,
      options,
    ) {
      assert.equal(this, undefined);
      observe('revoke');
      assert.equal(authorize, services.authorizeHumanRevocation);
      assert.deepEqual(
        [cwd, root, parentChangeId],
        ['/repository', stateRoot, 'parent-A'],
      );
      assert.equal(options.reason, 'Retire repair');
      assert.deepEqual(options.now, now);
      assert.notEqual(options.now, now);
      assert.equal(options.signer, dependencies.maintenanceSigner);
      assert.equal(
        options.verifyHumanSignature,
        dependencies.verifyHumanSignature,
      );
      assert.equal(
        options.testAfterAudit,
        dependencies.testHooks?.afterAuthorityAuditRecorded,
      );
      options.testAfterAudit?.();
      return revoked;
    },
    abandonPersistedIntervention(root, file, input) {
      observe('abandon');
      assert.deepEqual([root, file], [stateRoot, bindingPath]);
      assert.deepEqual(input, {
        parentChangeId: 'parent-A',
        interventionChangeId: 'repair-A',
        checkpointId,
        grantId: 'grant-A',
        grantRecordDigest: recordDigest,
        reason: 'Retire repair',
        at: signedAt,
        testAfterIntentPersisted:
          dependencies.testHooks?.afterAbandonmentIntentPersisted,
      });
      input.testAfterIntentPersisted?.();
      return { effectsPerformed: abandonedEffects } as ReturnType<
        Operations['abandonPersistedIntervention']
      >;
    },
  });
  return {
    services,
    trace,
    failure,
    dependencies,
    intervention,
    parentSession,
    before,
    now,
    fail(stage: string) {
      failAt = stage;
    },
    setAbandonedEffects(value: boolean) {
      abandonedEffects = value;
    },
  };
}

test('disposition construction does not observe a repository, authority, clock or store', () => {
  createInterventionMetadataDisposition(operations());
});

test('metadata inspection observes fresh state without signing, clock or mutations', () => {
  const f = memoryDisposition();
  const disposition = createInterventionMetadataDisposition(f.services);
  for (let attempt = 0; attempt < 2; attempt++) {
    f.trace.length = 0;
    const result = disposition.inspect('/worktree', 'parent-A');
    assert.deepEqual(f.trace, ['discover', 'paths', 'intervention', 'binding']);
    assert.deepEqual(result, {
      stateRoot,
      bindingPath,
      parentChangeId: 'parent-A',
      checkpointId,
      workspaceId,
      intervention: f.intervention,
      parentSession: f.parentSession,
      effectsPerformed: false,
    });
    assert.equal(result.intervention, f.intervention);
    assert.equal(result.parentSession, f.parentSession);
  }
});

test('inspection tolerates only the exact missing-binding WorkflowError', () => {
  for (const error of [
    workflowError('BOOTSTRAP_BINDING_NOT_FOUND', 'missing', ExitCode.conflict),
    workflowError(
      'BOOTSTRAP_BINDING_CORRUPT',
      'corrupt',
      ExitCode.verification,
    ),
    Object.assign(new Error('not a workflow failure'), {
      code: 'BOOTSTRAP_BINDING_NOT_FOUND',
    }),
  ]) {
    const f = memoryDisposition();
    f.services.readLocalEngineBinding = () => {
      throw error;
    };
    const disposition = createInterventionMetadataDisposition(f.services);
    if (error.code === 'BOOTSTRAP_BINDING_NOT_FOUND' && 'exitCode' in error) {
      assert.equal(
        disposition.inspect('/worktree', 'parent-A').parentSession,
        null,
      );
    } else {
      assert.throws(
        () => disposition.inspect('/worktree', 'parent-A'),
        (observed) => observed === error,
      );
    }
  }
});

test('revocation preserves operation order, capability identity, signed time and effects composition', () => {
  for (const state of ['available', 'expired', 'revoked'] as const) {
    for (const abandonedEffects of [false, true]) {
      const f = memoryDisposition();
      f.before.state = state;
      f.setAbandonedEffects(abandonedEffects);
      const disposition = createInterventionMetadataDisposition(f.services);
      const result = disposition.revoke(
        '/worktree',
        'parent-A',
        'Retire repair',
        f.dependencies,
      );
      assert.deepEqual(f.trace, [
        'discover',
        'paths',
        'maintenance',
        'preflight',
        'audit',
        'clock',
        'revoke',
        'after-audit',
        'abandon',
        'after-intent',
      ]);
      assert.deepEqual(result, {
        stateRoot,
        bindingPath,
        parentChangeId: 'parent-A',
        checkpointId,
        effectsPerformed: state !== 'revoked' || abandonedEffects,
      });
    }
  }
});

test('one disposition service uses each invocation clock and signer independently', () => {
  const f = memoryDisposition();
  const disposition = createInterventionMetadataDisposition(f.services);
  for (let invocation = 0; invocation < 2; invocation++) {
    f.trace.length = 0;
    f.now.setUTCMinutes(invocation);
    f.dependencies.maintenanceSigner = {
      assertHumanPresent: unexpectedOperation,
      identity: unexpectedOperation,
      sign: unexpectedOperation,
      verify: unexpectedOperation,
    };
    f.dependencies.verifyHumanSignature = () => true;
    disposition.revoke('/worktree', 'parent-A', 'Retire repair', {
      ...f.dependencies,
    });
    assert.equal(f.trace.filter((stage) => stage === 'clock').length, 1);
  }
});

test('revocation stops at each failed operation or hook and preserves the original error', () => {
  const stages = [
    'discover',
    'paths',
    'maintenance',
    'preflight',
    'audit',
    'clock',
    'revoke',
    'after-audit',
    'abandon',
    'after-intent',
  ];
  for (const [index, stage] of stages.entries()) {
    const f = memoryDisposition();
    f.fail(stage);
    const disposition = createInterventionMetadataDisposition(f.services);
    assert.throws(
      () =>
        disposition.revoke(
          '/worktree',
          'parent-A',
          'Retire repair',
          f.dependencies,
        ),
      (error) => error === f.failure,
    );
    assert.deepEqual(f.trace, stages.slice(0, index + 1));
  }
});

test('missing verifier fails after maintenance observation and before preflight or clock', () => {
  const f = memoryDisposition();
  const disposition = createInterventionMetadataDisposition(f.services);
  assert.throws(
    () => disposition.revoke('/worktree', 'parent-A', 'Retire repair', {}),
    {
      code: 'INTERVENTION_MAINTENANCE_APPROVAL_UI_REQUIRED',
      message:
        'Maintenance revocation requires a trusted historical signature verifier.',
      exitCode: ExitCode.unsafeEnvironment,
    },
  );
  assert.deepEqual(f.trace, ['discover', 'paths', 'maintenance']);
});

test('invalid disposition clock fails after audit and before authorization', () => {
  for (const now of [new Date(NaN), {} as Date]) {
    const f = memoryDisposition();
    const disposition = createInterventionMetadataDisposition(f.services);
    assert.throws(
      () =>
        disposition.revoke('/worktree', 'parent-A', 'Retire repair', {
          ...f.dependencies,
          now: () => {
            f.trace.push('clock');
            return now;
          },
        }),
      {
        code: 'INTERVENTION_BOOTSTRAP_CLOCK_INVALID',
        message: 'Bootstrap CLI clock returned an invalid date.',
        exitCode: ExitCode.unsafeEnvironment,
      },
    );
    assert.deepEqual(f.trace, [
      'discover',
      'paths',
      'maintenance',
      'preflight',
      'audit',
      'clock',
    ]);
  }
});
