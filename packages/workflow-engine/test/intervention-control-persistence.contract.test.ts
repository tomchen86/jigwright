import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEngineArtifact,
  type HarnessMaintenanceGrantEnvelope,
} from '../src/modules/authority/intervention-control.ts';
import {
  advancePersistedEngineAdoption,
  interventionControlPersistencePaths,
  interventionRecordPath,
  persistInterventionPlan,
  preparePersistedEngineAdoption,
  readPersistedIntervention,
  recoverPersistedEngineAdoption,
  rollbackPersistedEngineAdoption,
} from '../src/runtime/storage-journal/intervention-control-persistence.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

function temporaryFixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-control-persistence-')),
  );
  fs.chmodSync(root, 0o700);
  const parentWorkspacePath = path.join(root, 'parent-worktree');
  const childWorkspacePath = path.join(root, 'intervention-worktree');
  fs.mkdirSync(parentWorkspacePath, { mode: 0o700 });
  return {
    root,
    storeRoot: path.join(root, 'state'),
    parentWorkspacePath,
    childWorkspacePath,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function interventionInput(fixture: ReturnType<typeof temporaryFixture>) {
  return {
    parent: {
      changeId: 'parent-A',
      status: 'active' as const,
      engineBinding: digest('engine-E1'),
      sessionSchema: 'v4',
      blocker: null,
    },
    interventionChangeId: 'intervention-B',
    checkpoint: {
      parentChangeId: 'parent-A',
      baseOid: 'a'.repeat(40),
      worktreeFingerprint: digest('worktree'),
      trackedTreeDigest: digest('tracked'),
      untrackedBundleDigest: digest('untracked'),
      sessionStateDigest: digest('session'),
      pendingIntentDigest: digest('pending-intent'),
      engineDigest: digest('engine-E1'),
      policyDigest: digest('policy'),
      createdAt: NOW.toISOString(),
    },
    childWorkspace: {
      parentWorkspacePath: fixture.parentWorkspacePath,
      childWorkspacePath: fixture.childWorkspacePath,
      changeRef: 'refs/heads/work/intervention-B',
    },
    now: NOW,
  };
}

test('checkpoint and child worktree plan persist atomically without creating the worktree', () => {
  const fixture = temporaryFixture();
  try {
    const record = persistInterventionPlan(
      fixture.storeRoot,
      interventionInput(fixture),
    );
    assert.equal(record.kind, 'persisted-harness-intervention.v1');
    assert.equal(record.parent.status, 'active');
    assert.equal(record.childWorkspace.state, 'planned');
    assert.equal(record.childWorkspace.effectsPerformed, false);
    assert.equal(
      record.childWorkspace.childWorkspacePath,
      fixture.childWorkspacePath,
    );
    assert.equal(fs.existsSync(fixture.childWorkspacePath), false);

    const paths = interventionControlPersistencePaths(fixture.storeRoot);
    assert.equal(fs.readdirSync(paths.checkpoints).length, 1);
    assert.equal(
      fs.statSync(interventionRecordPath(fixture.storeRoot, 'parent-A')).mode &
        0o777,
      0o600,
    );
    assert.deepEqual(
      readPersistedIntervention(fixture.storeRoot, 'parent-A'),
      record,
    );
    assert.deepEqual(
      persistInterventionPlan(fixture.storeRoot, interventionInput(fixture)),
      record,
    );

    assert.throws(
      () =>
        persistInterventionPlan(fixture.storeRoot, {
          ...interventionInput(fixture),
          interventionChangeId: 'intervention-C',
          childWorkspace: {
            ...interventionInput(fixture).childWorkspace,
            childWorkspacePath: path.join(fixture.root, 'other-child'),
            changeRef: 'refs/heads/work/intervention-C',
          },
        }),
      hasCode('INTERVENTION_PERSISTENCE_ACTIVE_CONFLICT'),
    );

    const otherParentWorkspace = path.join(fixture.root, 'other-parent');
    fs.mkdirSync(otherParentWorkspace, { mode: 0o700 });
    const other = interventionInput(fixture);
    assert.throws(
      () =>
        persistInterventionPlan(fixture.storeRoot, {
          ...other,
          parent: { ...other.parent, changeId: 'parent-D' },
          interventionChangeId: 'intervention-D',
          checkpoint: {
            ...other.checkpoint,
            parentChangeId: 'parent-D',
          },
          childWorkspace: {
            parentWorkspacePath: otherParentWorkspace,
            childWorkspacePath: fixture.childWorkspacePath,
            changeRef: 'refs/heads/work/intervention-D',
          },
        }),
      hasCode('INTERVENTION_CHILD_WORKSPACE_RESERVATION_CONFLICT'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('persisted intervention corruption and overlapping workspace paths fail closed', () => {
  const fixture = temporaryFixture();
  try {
    assert.throws(
      () =>
        persistInterventionPlan(fixture.storeRoot, {
          ...interventionInput(fixture),
          childWorkspace: {
            ...interventionInput(fixture).childWorkspace,
            childWorkspacePath: path.join(
              fixture.parentWorkspacePath,
              'nested-child',
            ),
          },
        }),
      hasCode('INTERVENTION_CHILD_WORKSPACE_NOT_ISOLATED'),
    );

    persistInterventionPlan(fixture.storeRoot, interventionInput(fixture));
    const recordPath = interventionRecordPath(fixture.storeRoot, 'parent-A');
    const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as {
      recordDigest: string;
      relationship: { interventionChangeId: string };
    };
    parsed.relationship.interventionChangeId = 'tampered-intervention';
    fs.writeFileSync(recordPath, `${JSON.stringify(parsed)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => readPersistedIntervention(fixture.storeRoot, 'parent-A'),
      hasCode('INTERVENTION_PERSISTENCE_RECORD_CORRUPT'),
    );
  } finally {
    fixture.cleanup();
  }
});

function maintenanceEnvelope(
  engineFromDigest: `sha256:${string}`,
): HarnessMaintenanceGrantEnvelope {
  return {
    payload: {
      kind: 'harness-maintenance-grant.v1',
      grantId: 'maintenance-persist-1',
      parentChangeId: 'parent-A',
      interventionChangeId: 'intervention-B',
      scope: {
        paths: ['packages/harness-runtime/**', 'packages/workflow-engine/**'],
        operations: [
          'adopt-engine-into-parent',
          'build-engine-artifact',
          'create-isolated-workspace',
          'modify-engine',
          'run-engine-tests',
        ],
      },
      waivers: [
        'active-change-exclusivity',
        'clean-worktree-required',
        'engine-path-protection',
      ],
      engineFromDigest,
      sessionSchema: 'v4',
      maxLocalAdoptions: 1,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
      reason: 'Repair the blocked engine through a recoverable intervention.',
    },
    signature: 'maintenance-human-signature',
  };
}

test('adoption journal persists CAS transitions and crash recovery through rollback', () => {
  const fixture = temporaryFixture();
  try {
    const intervention = persistInterventionPlan(
      fixture.storeRoot,
      interventionInput(fixture),
    );
    const artifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('source-E2'),
      executableDigest: digest('engine-E2'),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('smoke-E2'),
    });
    const prepared = preparePersistedEngineAdoption(
      fixture.storeRoot,
      {
        txId: 'adoption-persist-1',
        parentChangeId: 'parent-A',
        artifact,
        maintenanceGrantEnvelope: maintenanceEnvelope(
          intervention.parent.engineBinding,
        ),
        priorLocalAdoptions: 0,
      },
      {
        now: () => NOW,
        verifyHumanSignature(_payload, signature, _signer, namespace) {
          assert.equal(signature, 'maintenance-human-signature');
          assert.equal(namespace, 'jigwright.harness-maintenance-grant.v1');
          return true;
        },
      },
    );
    assert.equal(prepared.journal.state, 'PREPARED');
    assert.equal(prepared.observations.length, 0);
    assert.throws(
      () =>
        preparePersistedEngineAdoption(
          fixture.storeRoot,
          {
            txId: 'adoption-persist-replay',
            parentChangeId: 'parent-A',
            artifact,
            maintenanceGrantEnvelope: maintenanceEnvelope(
              intervention.parent.engineBinding,
            ),
            priorLocalAdoptions: 0,
          },
          {
            now: () => NOW,
            verifyHumanSignature: () => true,
          },
        ),
      hasCode('INTERVENTION_ADOPTION_ALREADY_ACTIVE'),
    );

    const checkpointed = advancePersistedEngineAdoption(fixture.storeRoot, {
      txId: prepared.journal.txId,
      expectedJournalDigest: prepared.journal.journalDigest,
      event: {
        kind: 'parent-checkpointed',
        at: '2026-08-03T10:01:00.000Z',
      },
      evidenceDigest: digest('checkpoint-observation'),
    });
    assert.throws(
      () =>
        advancePersistedEngineAdoption(fixture.storeRoot, {
          txId: prepared.journal.txId,
          expectedJournalDigest: prepared.journal.journalDigest,
          event: {
            kind: 'engine-binding-updated',
            at: '2026-08-03T10:02:00.000Z',
          },
          evidenceDigest: digest('stale-binding-observation'),
        }),
      hasCode('INTERVENTION_ADOPTION_CAS_MISMATCH'),
    );
    let current = advancePersistedEngineAdoption(fixture.storeRoot, {
      txId: prepared.journal.txId,
      expectedJournalDigest: checkpointed.journal.journalDigest,
      event: {
        kind: 'engine-binding-updated',
        at: '2026-08-03T10:02:00.000Z',
      },
      evidenceDigest: digest('binding-observation'),
    });
    assert.deepEqual(
      recoverPersistedEngineAdoption(fixture.storeRoot, prepared.journal.txId)
        .decision,
      {
        action: 'start-new-engine',
        authoritativeEngineDigest: artifact.executableDigest,
        blockerCleared: false,
      },
    );

    for (const [event, evidenceDigest] of [
      [
        {
          kind: 'new-engine-started',
          at: '2026-08-03T10:03:00.000Z',
        },
        digest('engine-start-observation'),
      ],
      [
        {
          kind: 'health-check-failed',
          at: '2026-08-03T10:04:00.000Z',
        },
        digest('health-failure-observation'),
      ],
    ] as const) {
      current = advancePersistedEngineAdoption(fixture.storeRoot, {
        txId: current.journal.txId,
        expectedJournalDigest: current.journal.journalDigest,
        event,
        evidenceDigest,
      });
    }
    assert.equal(
      recoverPersistedEngineAdoption(fixture.storeRoot, current.journal.txId)
        .decision.action,
      'rollback-engine-binding',
    );
    const rolledBack = rollbackPersistedEngineAdoption(fixture.storeRoot, {
      txId: current.journal.txId,
      expectedJournalDigest: current.journal.journalDigest,
      at: '2026-08-03T10:05:00.000Z',
      evidenceDigest: digest('rollback-observation'),
    });
    assert.equal(rolledBack.journal.state, 'ENGINE_BINDING_ROLLED_BACK');
    assert.equal(rolledBack.observations.length, 5);
    assert.equal(
      recoverPersistedEngineAdoption(fixture.storeRoot, rolledBack.journal.txId)
        .decision.authoritativeEngineDigest,
      intervention.parent.engineBinding,
    );
  } finally {
    fixture.cleanup();
  }
});

test('persisted adoption cannot start without an injected human verifier', () => {
  const fixture = temporaryFixture();
  try {
    const intervention = persistInterventionPlan(
      fixture.storeRoot,
      interventionInput(fixture),
    );
    const artifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('source-no-verifier'),
      executableDigest: digest('engine-no-verifier'),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('smoke-no-verifier'),
    });
    assert.throws(
      () =>
        preparePersistedEngineAdoption(
          fixture.storeRoot,
          {
            txId: 'adoption-no-verifier',
            parentChangeId: 'parent-A',
            artifact,
            maintenanceGrantEnvelope: maintenanceEnvelope(
              intervention.parent.engineBinding,
            ),
            priorLocalAdoptions: 0,
          },
          { now: () => NOW },
        ),
      hasCode('INTERVENTION_PERSISTENCE_HUMAN_VERIFIER_REQUIRED'),
    );
  } finally {
    fixture.cleanup();
  }
});
