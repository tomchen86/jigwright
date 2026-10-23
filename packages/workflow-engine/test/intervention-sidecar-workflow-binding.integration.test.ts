import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  abandonPersistedIntervention,
  capturePersistedWipIntervention,
  materializeInterventionChildWorktree,
} from '../src/application/control-plane/intervention-control-bootstrap.ts';
import {
  buildAndPersistInterventionEngineArtifact,
  persistInterventionEngineArtifact,
  preparePersistedEngineAdoptionFromArtifactRecord,
  readInterventionEngineArtifact,
} from '../src/application/control-plane/intervention-maintenance.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { createEngineArtifact } from '../src/modules/authority/intervention-control.ts';
import {
  advancePersistedEngineAdoption,
  persistedBootstrapSidecarSessionPath,
  preparePersistedEngineAdoption,
  readPersistedBootstrapSidecarWorkflow,
  readPersistedIntervention,
  recordBootstrapSidecarAbandoned,
  recoverPersistedEngineAdoption,
  rollbackPersistedEngineAdoption,
} from '../src/runtime/storage-journal/intervention-control-persistence.ts';
import {
  interventionEngineArtifactRecordPath,
  readStoredInterventionEngineArtifact,
} from '../src/runtime/storage-journal/intervention-engine-artifact-store.ts';

const CAPTURED_AT = new Date('2026-08-10T03:00:00.000Z');

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(repository: string, args: string[]): string {
  return childProcess.execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function crash(label: string): () => never {
  return () => {
    throw new Error(`simulated crash: ${label}`);
  };
}

function humanDependencies(
  now: Date,
  testHooks: Record<string, () => void> = {},
) {
  return {
    now: () => now,
    verifyHumanSignature(
      _payload: string,
      signature: string,
      _signer: string,
      namespace: string,
    ) {
      assert.equal(signature, 'workflow-binding-human-signature');
      assert.equal(namespace, 'jigwright.harness-maintenance-grant.v1');
      return true;
    },
    testHooks,
  };
}

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-workflow-binding-')),
  );
  fs.chmodSync(root, 0o700);
  const repository = path.join(root, 'parent');
  const child = path.join(root, 'child');
  const stateRoot = path.join(root, 'state');
  const sessionSnapshotPath = path.join(stateRoot, 'parent-session.json');
  fs.mkdirSync(repository, { mode: 0o700 });
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  git(repository, ['init', '-b', 'work/parent-A']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'base\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Create workflow binding fixture']);
  fs.writeFileSync(sessionSnapshotPath, '{"step":"repair-required"}\n', {
    mode: 0o600,
  });

  const engineFromDigest = digest('workflow-binding-engine-E1');
  const captureInput = {
    repositoryRoot: repository,
    parent: {
      changeId: 'parent-A',
      status: 'active' as const,
      engineBinding: engineFromDigest,
      sessionSchema: 'v4',
      blocker: null,
    },
    interventionChangeId: 'intervention-B',
    childWorkspacePath: child,
    changeRef: 'refs/heads/work/intervention-B',
    untrackedAllowlist: [] as string[],
    sessionSnapshotPath,
    pendingIntent: 'Resume A only after B adopts a healthy engine.',
    policyDigest: digest('workflow-binding-policy'),
    now: CAPTURED_AT,
  };
  const maintenanceGrantEnvelope = {
    payload: {
      kind: 'harness-maintenance-grant.v1' as const,
      grantId: 'workflow-binding-maintenance-grant',
      parentChangeId: 'parent-A',
      interventionChangeId: 'intervention-B',
      scope: {
        paths: ['packages/harness-runtime/**', 'packages/workflow-engine/**'],
        operations: [
          'adopt-engine-into-parent' as const,
          'build-engine-artifact' as const,
          'create-isolated-workspace' as const,
          'modify-engine' as const,
          'run-engine-tests' as const,
        ],
      },
      waivers: [
        'active-change-exclusivity' as const,
        'clean-worktree-required' as const,
        'engine-path-protection' as const,
      ],
      engineFromDigest,
      sessionSchema: 'v4',
      maxLocalAdoptions: 1,
      issuedAt: '2026-08-10T02:55:00.000Z',
      expiresAt: '2026-08-10T05:00:00.000Z',
      humanSigner: 'maintainer@example.test',
      reason: 'Exercise the independent bootstrap-maintenance workflow.',
    },
    signature: 'workflow-binding-human-signature',
  };
  return {
    root,
    repository,
    child,
    stateRoot,
    captureInput,
    maintenanceGrantEnvelope,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function captureAndMaterialize(value: ReturnType<typeof fixture>) {
  const captured = capturePersistedWipIntervention(
    value.stateRoot,
    value.captureInput,
  );
  const materialized = materializeInterventionChildWorktree(
    value.stateRoot,
    {
      parentChangeId: 'parent-A',
      repositoryRoot: value.repository,
      maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
    },
    humanDependencies(new Date('2026-08-10T03:01:00.000Z')),
  );
  return { captured, materialized };
}

function writeEngineExecutable(child: string): string {
  const executablePath = path.join(
    child,
    'packages',
    'workflow-engine',
    'engine-probe.mjs',
  );
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(
    executablePath,
    `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--bootstrap-probe') {
  process.stdout.write(JSON.stringify({kind:'engine-bootstrap-probe.v1',started:true,sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
if (mode === '--health-check') {
  process.stdout.write(JSON.stringify({kind:'engine-health.v1',healthy:true,sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(executablePath, 0o755);
  return executablePath;
}

function buildArtifact(value: ReturnType<typeof fixture>) {
  return buildAndPersistInterventionEngineArtifact(value.stateRoot, {
    parentChangeId: 'parent-A',
    executablePath: writeEngineExecutable(value.child),
    protocolVersion: 3,
    policySchemaVersion: 2,
    now: new Date('2026-08-10T03:02:00.000Z'),
  });
}

function replaceSidecarRecord(
  stateRoot: string,
  mutate: (record: Record<string, any>) => void,
): string {
  const target = persistedBootstrapSidecarSessionPath(stateRoot, 'parent-A');
  const original = fs.readFileSync(target, 'utf8');
  const record = JSON.parse(original) as Record<string, any>;
  mutate(record);
  const { recordDigest: _recordDigest, ...payload } = record;
  record.recordDigest = digest(canonicalJson(payload));
  fs.writeFileSync(target, `${canonicalJson(record)}\n`, { mode: 0o600 });
  return original;
}

function restoreSidecarRecord(stateRoot: string, original: string): void {
  fs.writeFileSync(
    persistedBootstrapSidecarSessionPath(stateRoot, 'parent-A'),
    original,
    { mode: 0o600 },
  );
}

test('bootstrap sidecar v2 is an independent crash-replayable Workflow', () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        capturePersistedWipIntervention(value.stateRoot, {
          ...value.captureInput,
          testAfterInterventionPersistedBeforeSidecar: crash(
            'workflow binding creation',
          ),
        }),
      /simulated crash: workflow binding creation/,
    );
    assert.equal(
      fs.existsSync(
        persistedBootstrapSidecarSessionPath(value.stateRoot, 'parent-A'),
      ),
      false,
    );

    const captured = capturePersistedWipIntervention(
      value.stateRoot,
      value.captureInput,
    );
    const created = readPersistedBootstrapSidecarWorkflow(
      value.stateRoot,
      'parent-A',
    );
    assert.equal(created.kind, 'bootstrap-sidecar-session.v2');
    assert.equal(
      created.workflowBinding.kind,
      'bootstrap-maintenance-workflow.v1',
    );
    assert.equal(created.workflowBinding.workflowType, 'bootstrap-maintenance');
    assert.equal(created.workflowBinding.changeId, 'intervention-B');
    assert.equal(created.workflowBinding.parentChangeId, 'parent-A');
    assert.notEqual(created.workflowBinding.workflowId, 'parent-A');
    assert.equal(
      created.workflowBinding.checkpointId,
      captured.intervention.checkpoint.checkpointId,
    );
    assert.equal(created.workflowBinding.repositoryRoot, value.child);
    assert.equal(
      created.workflowBinding.changeRef,
      'refs/heads/work/intervention-B',
    );
    assert.equal(created.workflowBinding.status, 'repair-active');

    capturePersistedWipIntervention(value.stateRoot, value.captureInput);
    assert.equal(
      fs
        .readdirSync(
          path.dirname(
            persistedBootstrapSidecarSessionPath(value.stateRoot, 'parent-A'),
          ),
        )
        .filter((name) => name.endsWith('.json')).length,
      1,
    );

    assert.throws(
      () =>
        materializeInterventionChildWorktree(
          value.stateRoot,
          {
            parentChangeId: 'parent-A',
            repositoryRoot: value.repository,
            maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
          },
          humanDependencies(new Date('2026-08-10T03:01:00.000Z'), {
            afterWorktreeReceiptPersistedBeforeSidecar: crash(
              'workflow workspace projection',
            ),
          }),
        ),
      /simulated crash: workflow workspace projection/,
    );
    const replayed = materializeInterventionChildWorktree(
      value.stateRoot,
      {
        parentChangeId: 'parent-A',
        repositoryRoot: value.repository,
        maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
      },
      humanDependencies(new Date('2026-08-10T03:01:00.000Z')),
    );
    const materialized = readPersistedBootstrapSidecarWorkflow(
      value.stateRoot,
      'parent-A',
    );
    assert.equal(materialized.workspace.receiptDigest, replayed.receiptDigest);
    assert.equal(
      materialized.workflowBinding.workflowBindingDigest,
      created.workflowBinding.workflowBindingDigest,
    );
    assert.equal(
      materialized.history.filter(
        (entry) => entry.eventKind === 'workspace-materialized',
      ).length,
      1,
    );
  } finally {
    value.cleanup();
  }
});

test('build and adoption fail closed on a missing or tampered workflow binding', () => {
  const deleted = fixture();
  try {
    captureAndMaterialize(deleted);
    fs.unlinkSync(
      persistedBootstrapSidecarSessionPath(deleted.stateRoot, 'parent-A'),
    );
    assert.throws(
      () => buildArtifact(deleted),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_SIDECAR_SESSION_NOT_FOUND',
    );
    assert.equal(
      readPersistedIntervention(deleted.stateRoot, 'parent-A').parent.blocker
        ?.blockedBy,
      'intervention-B',
    );
  } finally {
    deleted.cleanup();
  }

  const tampered = fixture();
  try {
    captureAndMaterialize(tampered);
    const original = replaceSidecarRecord(tampered.stateRoot, (record) => {
      record.workflowBinding.changeId = 'intervention-C';
      const { workflowBindingDigest: _bindingDigest, ...bindingPayload } =
        record.workflowBinding;
      record.workflowBinding.workflowBindingDigest = digest(
        canonicalJson(bindingPayload),
      );
    });
    assert.throws(
      () => buildArtifact(tampered),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_SIDECAR_SESSION_CORRUPT',
    );
    restoreSidecarRecord(tampered.stateRoot, original);

    const artifactRecord = buildArtifact(tampered);
    const workflow = readPersistedBootstrapSidecarWorkflow(
      tampered.stateRoot,
      'parent-A',
    );
    assert.equal(
      artifactRecord.workflowBindingDigest,
      workflow.workflowBinding.workflowBindingDigest,
    );
    assert.equal(artifactRecord.workflowStatus, 'repair-active');
    assert.equal(
      artifactRecord.artifact.workflowBindingDigest,
      workflow.workflowBinding.workflowBindingDigest,
    );

    const prepared = preparePersistedEngineAdoption(
      tampered.stateRoot,
      {
        txId: 'workflow-bound-adoption',
        parentChangeId: 'parent-A',
        artifact: artifactRecord.artifact,
        maintenanceGrantEnvelope: tampered.maintenanceGrantEnvelope,
        priorLocalAdoptions: 0,
      },
      humanDependencies(new Date('2026-08-10T03:03:00.000Z')),
    );
    assert.equal(
      prepared.journal.workflowBindingDigest,
      workflow.workflowBinding.workflowBindingDigest,
    );
    assert.equal(prepared.journal.workflowStatus, 'repair-active');

    const validSidecar = fs.readFileSync(
      persistedBootstrapSidecarSessionPath(tampered.stateRoot, 'parent-A'),
      'utf8',
    );
    replaceSidecarRecord(tampered.stateRoot, (record) => {
      delete record.workflowBinding;
    });
    assert.throws(
      () =>
        recoverPersistedEngineAdoption(
          tampered.stateRoot,
          prepared.journal.txId,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_SIDECAR_SESSION_CORRUPT',
    );
    restoreSidecarRecord(tampered.stateRoot, validSidecar);

    let current = prepared;
    for (const transition of [
      ['parent-checkpointed', '2026-08-10T03:04:00.000Z'],
      ['engine-binding-updated', '2026-08-10T03:05:00.000Z'],
      ['new-engine-started', '2026-08-10T03:06:00.000Z'],
      ['health-check-failed', '2026-08-10T03:07:00.000Z'],
    ] as const) {
      current = advancePersistedEngineAdoption(tampered.stateRoot, {
        txId: current.journal.txId,
        expectedJournalDigest: current.journal.journalDigest,
        event: { kind: transition[0], at: transition[1] },
        evidenceDigest: digest(`workflow-binding-${transition[0]}`),
      });
    }
    assert.equal(current.journal.state, 'ROLLBACK_REQUIRED');

    const beforeRollbackTamper = replaceSidecarRecord(
      tampered.stateRoot,
      (record) => {
        record.workflowBinding.status = 'adopted';
        const { workflowBindingDigest: _bindingDigest, ...bindingPayload } =
          record.workflowBinding;
        record.workflowBinding.workflowBindingDigest = digest(
          canonicalJson(bindingPayload),
        );
      },
    );
    assert.throws(
      () =>
        rollbackPersistedEngineAdoption(tampered.stateRoot, {
          txId: current.journal.txId,
          expectedJournalDigest: current.journal.journalDigest,
          at: '2026-08-10T03:08:00.000Z',
          evidenceDigest: digest('workflow-binding-rollback'),
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_SIDECAR_SESSION_CORRUPT',
    );
    restoreSidecarRecord(tampered.stateRoot, beforeRollbackTamper);

    const rolledBack = rollbackPersistedEngineAdoption(tampered.stateRoot, {
      txId: current.journal.txId,
      expectedJournalDigest: current.journal.journalDigest,
      at: '2026-08-10T03:08:00.000Z',
      evidenceDigest: digest('workflow-binding-rollback'),
    });
    assert.equal(rolledBack.journal.state, 'ENGINE_BINDING_ROLLED_BACK');
    assert.equal(
      readPersistedBootstrapSidecarWorkflow(tampered.stateRoot, 'parent-A')
        .workflowBinding.status,
      'repair-active',
    );
    assert.equal(
      readPersistedIntervention(tampered.stateRoot, 'parent-A').parent.blocker
        ?.blockedBy,
      'intervention-B',
    );
  } finally {
    tampered.cleanup();
  }
});

test('v2 adoption authority requires the exact persisted artifact record', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const executablePath = writeEngineExecutable(value.child);
    const source = fs.readFileSync(executablePath);
    const genericArtifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('generic-unpersisted-source'),
      executableDigest: digest(source),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('generic-unpersisted-smoke'),
    });
    assert.throws(
      () =>
        preparePersistedEngineAdoptionFromArtifactRecord(
          value.stateRoot,
          {
            txId: 'unpersisted-artifact-adoption',
            parentChangeId: 'parent-A',
            artifactId: genericArtifact.artifactId,
            maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
            priorLocalAdoptions: 0,
          },
          humanDependencies(new Date('2026-08-10T03:03:00.000Z')),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_ENGINE_ARTIFACT_NOT_FOUND',
    );

    const persisted = persistInterventionEngineArtifact(value.stateRoot, {
      parentChangeId: 'parent-A',
      artifact: genericArtifact,
      executablePath,
      now: new Date('2026-08-10T03:02:00.000Z'),
    });
    const prepared = preparePersistedEngineAdoptionFromArtifactRecord(
      value.stateRoot,
      {
        txId: 'persisted-artifact-adoption',
        parentChangeId: 'parent-A',
        artifactId: genericArtifact.artifactId,
        maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
        priorLocalAdoptions: 0,
      },
      humanDependencies(new Date('2026-08-10T03:03:00.000Z')),
    );
    assert.equal(prepared.kind, 'persisted-engine-adoption.v2');
    const projected = readPersistedBootstrapSidecarWorkflow(
      value.stateRoot,
      'parent-A',
    ).artifacts.find(
      (artifact) => artifact.artifactId === genericArtifact.artifactId,
    );
    assert.equal(projected?.evidenceDigest, persisted.recordDigest);
    assert.equal(projected?.readyAt, persisted.createdAt);
  } finally {
    value.cleanup();
  }
});

test('artifact authority readers reject retired persisted V1 records', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const persisted = buildArtifact(value);
    const target = interventionEngineArtifactRecordPath(
      value.stateRoot,
      persisted.artifact.artifactId,
    );
    const legacyRecord = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<
      string,
      any
    >;
    legacyRecord.kind = 'persisted-intervention-engine-artifact.v1';
    delete legacyRecord.workflowBindingDigest;
    delete legacyRecord.workflowStatus;
    const { recordDigest: _recordDigest, ...legacyPayload } = legacyRecord;
    legacyRecord.recordDigest = digest(canonicalJson(legacyPayload));
    const legacyBytes = `${canonicalJson(legacyRecord)}\n`;
    fs.writeFileSync(target, legacyBytes, { mode: 0o600 });

    for (const read of [
      () =>
        readStoredInterventionEngineArtifact(
          value.stateRoot,
          persisted.artifact.artifactId,
        ),
      () =>
        readInterventionEngineArtifact(
          value.stateRoot,
          persisted.artifact.artifactId,
        ),
    ]) {
      assert.throws(
        read,
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'INTERVENTION_ENGINE_ARTIFACT_RECORD_CORRUPT',
      );
    }
    assert.equal(fs.readFileSync(target, 'utf8'), legacyBytes);
  } finally {
    value.cleanup();
  }
});

test('artifact projection evidence cannot be replaced by adoption fallback', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const persisted = buildArtifact(value);
    replaceSidecarRecord(value.stateRoot, (record) => {
      const projected = record.artifacts.find(
        (artifact: Record<string, unknown>) =>
          artifact.artifactId === persisted.artifact.artifactId,
      );
      projected.evidenceDigest = digest('synthetic-adoption-fallback');
      projected.readyAt = '2026-08-10T03:02:30.000Z';
    });
    assert.throws(
      () =>
        preparePersistedEngineAdoptionFromArtifactRecord(
          value.stateRoot,
          {
            txId: 'evidence-conflict-adoption',
            parentChangeId: 'parent-A',
            artifactId: persisted.artifact.artifactId,
            maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
            priorLocalAdoptions: 0,
          },
          humanDependencies(new Date('2026-08-10T03:03:00.000Z')),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_SIDECAR_SESSION_CONFLICT',
    );
  } finally {
    value.cleanup();
  }
});

test('retired global promotion pins cannot block abandonment or mutate parent data', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const pinDirectory = path.join(value.stateRoot, 'sidecar-promotion-pins');
    fs.mkdirSync(pinDirectory, { mode: 0o700 });
    const pinPath = path.join(pinDirectory, 'retired-pin.json');
    const pinBytes = Buffer.from(
      '{"state":"commit-intent","txId":"retired-global-promotion"}\n',
    );
    fs.writeFileSync(pinPath, pinBytes, { mode: 0o600 });
    const tracked = path.join(value.repository, 'tracked.txt');
    const untracked = path.join(value.repository, 'untracked-wip.txt');
    fs.writeFileSync(tracked, 'parent WIP remains\n');
    fs.writeFileSync(untracked, 'untracked parent WIP remains\n');
    const head = git(value.repository, ['rev-parse', 'HEAD']);
    const index = fs.readFileSync(path.join(value.repository, '.git/index'));
    const input = {
      parentChangeId: 'parent-A',
      grantId: 'abandon-with-retired-pin',
      grantRecordDigest: digest('abandon-with-retired-pin-authority'),
      reason: 'Abandon an intervention with inert retired global state.',
      at: '2026-08-10T03:04:00.000Z',
    };
    const bindingPath = path.join(
      value.stateRoot,
      'missing-parent-binding.json',
    );
    const result = abandonPersistedIntervention(
      value.stateRoot,
      bindingPath,
      input,
    );
    assert.equal(result.effectsPerformed, true);
    const replay = abandonPersistedIntervention(
      value.stateRoot,
      bindingPath,
      input,
    );
    assert.equal(replay.effectsPerformed, false);
    assert.deepEqual(replay.receipt, result.receipt);
    assert.deepEqual(fs.readFileSync(pinPath), pinBytes);
    assert.equal(fs.readFileSync(tracked, 'utf8'), 'parent WIP remains\n');
    assert.equal(
      fs.readFileSync(untracked, 'utf8'),
      'untracked parent WIP remains\n',
    );
    assert.equal(git(value.repository, ['rev-parse', 'HEAD']), head);
    assert.deepEqual(
      fs.readFileSync(path.join(value.repository, '.git/index')),
      index,
    );
  } finally {
    value.cleanup();
  }
});

test('PREPARED adoption blocks abandonment even before local binding exists', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const persisted = buildArtifact(value);
    preparePersistedEngineAdoptionFromArtifactRecord(
      value.stateRoot,
      {
        txId: 'prepared-before-binding',
        parentChangeId: 'parent-A',
        artifactId: persisted.artifact.artifactId,
        maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
        priorLocalAdoptions: 0,
      },
      humanDependencies(new Date('2026-08-10T03:03:00.000Z')),
    );
    assert.throws(
      () =>
        abandonPersistedIntervention(
          value.stateRoot,
          path.join(value.stateRoot, 'missing-parent-binding.json'),
          {
            parentChangeId: 'parent-A',
            grantId: 'abandon-prepared-grant',
            grantRecordDigest: digest('abandon-prepared-grant-record'),
            reason: 'Attempt to abandon a PREPARED adoption.',
            at: '2026-08-10T03:04:00.000Z',
          },
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_ABANDONMENT_ADOPTION_NOT_TERMINAL',
    );
    assert.equal(
      readPersistedIntervention(value.stateRoot, 'parent-A').parent.blocker
        ?.blockedBy,
      'intervention-B',
    );
  } finally {
    value.cleanup();
  }
});

test('artifact persistence rechecks active workflow after an interleaving', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const executablePath = writeEngineExecutable(value.child);
    const source = fs.readFileSync(executablePath);
    const artifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('interleaving-source'),
      executableDigest: digest(source),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('interleaving-smoke'),
    });
    assert.throws(
      () =>
        persistInterventionEngineArtifact(value.stateRoot, {
          parentChangeId: 'parent-A',
          artifact,
          executablePath,
          now: new Date('2026-08-10T03:02:00.000Z'),
          testAfterWorkflowBindingVerifiedBeforeArtifactPersisted() {
            recordBootstrapSidecarAbandoned(value.stateRoot, {
              parentChangeId: 'parent-A',
              intervention: readPersistedIntervention(
                value.stateRoot,
                'parent-A',
              ),
              evidenceDigest: digest('interleaving-abandonment'),
              abandonedAt: '2026-08-10T03:01:30.000Z',
            });
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_ENGINE_ARTIFACT_WORKFLOW_NOT_ACTIVE',
    );
  } finally {
    value.cleanup();
  }
});

test('artifact authority reader rejects a symlink substitution', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const persisted = buildArtifact(value);
    const target = interventionEngineArtifactRecordPath(
      value.stateRoot,
      persisted.artifact.artifactId,
    );
    const displaced = `${target}.displaced`;
    fs.renameSync(target, displaced);
    fs.symlinkSync(displaced, target);
    assert.throws(
      () =>
        readInterventionEngineArtifact(
          value.stateRoot,
          persisted.artifact.artifactId,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_ENGINE_ARTIFACT_RECORD_CORRUPT',
    );
  } finally {
    value.cleanup();
  }
});

test('artifact snapshot replacement before the parent lock stale-fails', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const persisted = buildArtifact(value);
    const target = interventionEngineArtifactRecordPath(
      value.stateRoot,
      persisted.artifact.artifactId,
    );
    assert.throws(
      () =>
        preparePersistedEngineAdoptionFromArtifactRecord(
          value.stateRoot,
          {
            txId: 'stale-artifact-snapshot',
            parentChangeId: 'parent-A',
            artifactId: persisted.artifact.artifactId,
            maintenanceGrantEnvelope: value.maintenanceGrantEnvelope,
            priorLocalAdoptions: 0,
            testAfterArtifactSnapshotBeforeParentLock() {
              const replacement = JSON.parse(
                fs.readFileSync(target, 'utf8'),
              ) as Record<string, any>;
              replacement.createdAt = '2026-08-10T03:02:01.000Z';
              const { recordDigest: _recordDigest, ...payload } = replacement;
              replacement.recordDigest = digest(canonicalJson(payload));
              fs.writeFileSync(target, `${canonicalJson(replacement)}\n`, {
                mode: 0o600,
              });
            },
          },
          humanDependencies(new Date('2026-08-10T03:03:00.000Z')),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_ADOPTION_ARTIFACT_AUTHORITY_STALE',
    );
  } finally {
    value.cleanup();
  }
});

test('artifact authority publication fsyncs its parent before crash-replay projection', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const executablePath = writeEngineExecutable(value.child);
    const sidecar = readPersistedBootstrapSidecarWorkflow(
      value.stateRoot,
      'parent-A',
    );
    const artifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('durable-artifact-source'),
      executableDigest: digest(fs.readFileSync(executablePath)),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('durable-artifact-smoke'),
      workflowBindingDigest: sidecar.workflowBinding.workflowBindingDigest,
    });
    const publication: string[] = [];
    const now = new Date('2026-08-10T03:02:00.000Z');
    const artifactRecordPath = interventionEngineArtifactRecordPath(
      value.stateRoot,
      artifact.artifactId,
    );

    assert.throws(
      () =>
        persistInterventionEngineArtifact(value.stateRoot, {
          parentChangeId: 'parent-A',
          artifact,
          executablePath,
          now,
          testObserveArtifactRecordPublication(phase) {
            assert.equal(
              fs.existsSync(artifactRecordPath),
              phase !== 'file-fsynced',
            );
            assert.equal(
              fs.existsSync(`${artifactRecordPath}.pending`),
              phase !== 'temporary-cleaned',
            );
            publication.push(phase);
          },
          testAfterArtifactPersistedBeforeSidecar: crash(
            'durable artifact before sidecar',
          ),
        }),
      /simulated crash: durable artifact before sidecar/,
    );
    assert.deepEqual(publication, [
      'file-fsynced',
      'target-linked',
      'target-directory-fsynced',
      'temporary-cleaned',
    ]);
    assert.equal(
      readPersistedBootstrapSidecarWorkflow(value.stateRoot, 'parent-A')
        .artifacts.length,
      0,
    );

    const replayed = persistInterventionEngineArtifact(value.stateRoot, {
      parentChangeId: 'parent-A',
      artifact,
      executablePath,
      now: new Date('2026-08-10T03:02:01.000Z'),
    });
    assert.equal(replayed.createdAt, now.toISOString());
    assert.equal(
      readPersistedBootstrapSidecarWorkflow(value.stateRoot, 'parent-A')
        .artifacts[0]?.evidenceDigest,
      replayed.recordDigest,
    );
  } finally {
    value.cleanup();
  }
});

test('artifact authority reconciles exact hard-link crash residue', () => {
  for (const crashPhase of [
    'target-linked',
    'target-directory-fsynced',
  ] as const) {
    const value = fixture();
    try {
      captureAndMaterialize(value);
      const executablePath = writeEngineExecutable(value.child);
      const sidecar = readPersistedBootstrapSidecarWorkflow(
        value.stateRoot,
        'parent-A',
      );
      const artifact = createEngineArtifact({
        sourceChangeId: 'intervention-B',
        sourceDigest: digest(`hard-link-residue-${crashPhase}`),
        executableDigest: digest(fs.readFileSync(executablePath)),
        protocolVersion: 3,
        canReadSessionSchemas: ['v4'],
        writesSessionSchema: 'v4',
        policySchemaVersion: 2,
        smokeReportDigest: digest(`hard-link-smoke-${crashPhase}`),
        workflowBindingDigest: sidecar.workflowBinding.workflowBindingDigest,
      });
      const target = interventionEngineArtifactRecordPath(
        value.stateRoot,
        artifact.artifactId,
      );
      const temporary = `${target}.pending`;
      const createdAt = new Date('2026-08-10T03:02:00.000Z');

      assert.throws(
        () =>
          persistInterventionEngineArtifact(value.stateRoot, {
            parentChangeId: 'parent-A',
            artifact,
            executablePath,
            now: createdAt,
            testObserveArtifactRecordPublication(phase) {
              if (phase === crashPhase) {
                throw new Error(`simulated crash: ${crashPhase}`);
              }
            },
          }),
        new RegExp(`simulated crash: ${crashPhase}`),
      );
      const targetStats = fs.lstatSync(target);
      const temporaryStats = fs.lstatSync(temporary);
      assert.equal(targetStats.ino, temporaryStats.ino);
      assert.equal(targetStats.dev, temporaryStats.dev);
      assert.equal(targetStats.nlink, 2);
      assert.equal(temporaryStats.nlink, 2);

      const replayed = persistInterventionEngineArtifact(value.stateRoot, {
        parentChangeId: 'parent-A',
        artifact,
        executablePath,
        now: new Date('2026-08-10T03:02:01.000Z'),
      });
      assert.equal(replayed.createdAt, createdAt.toISOString());
      assert.equal(fs.existsSync(temporary), false);
      assert.equal(fs.lstatSync(target).nlink, 1);
      assert.equal(
        readPersistedBootstrapSidecarWorkflow(value.stateRoot, 'parent-A')
          .artifacts[0]?.evidenceDigest,
        replayed.recordDigest,
      );
    } finally {
      value.cleanup();
    }
  }
});

test('artifact authority preserves foreign prepared residue and fails closed', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const executablePath = writeEngineExecutable(value.child);
    const sidecar = readPersistedBootstrapSidecarWorkflow(
      value.stateRoot,
      'parent-A',
    );
    const artifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('foreign-publication-source'),
      executableDigest: digest(fs.readFileSync(executablePath)),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('foreign-publication-smoke'),
      workflowBindingDigest: sidecar.workflowBinding.workflowBindingDigest,
    });
    const target = interventionEngineArtifactRecordPath(
      value.stateRoot,
      artifact.artifactId,
    );
    const temporary = `${target}.pending`;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(target), 0o700);
    fs.writeFileSync(temporary, 'foreign prepared bytes\n', { mode: 0o600 });

    assert.throws(
      () =>
        persistInterventionEngineArtifact(value.stateRoot, {
          parentChangeId: 'parent-A',
          artifact,
          executablePath,
          now: new Date('2026-08-10T03:02:00.000Z'),
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_ENGINE_ARTIFACT_PUBLICATION_CORRUPT',
    );
    assert.equal(
      fs.readFileSync(temporary, 'utf8'),
      'foreign prepared bytes\n',
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(
      readPersistedBootstrapSidecarWorkflow(value.stateRoot, 'parent-A')
        .artifacts.length,
      0,
    );

    fs.unlinkSync(temporary);
    const persisted = persistInterventionEngineArtifact(value.stateRoot, {
      parentChangeId: 'parent-A',
      artifact,
      executablePath,
      now: new Date('2026-08-10T03:02:00.000Z'),
    });
    const targetContent = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(temporary, 'foreign replacement bytes\n', { mode: 0o600 });
    assert.throws(
      () =>
        persistInterventionEngineArtifact(value.stateRoot, {
          parentChangeId: 'parent-A',
          artifact,
          executablePath,
          now: new Date('2026-08-10T03:02:01.000Z'),
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_ENGINE_ARTIFACT_PUBLICATION_CORRUPT',
    );
    assert.equal(fs.readFileSync(target, 'utf8'), targetContent);
    assert.equal(
      fs.readFileSync(temporary, 'utf8'),
      'foreign replacement bytes\n',
    );
    assert.equal(
      readPersistedBootstrapSidecarWorkflow(value.stateRoot, 'parent-A')
        .artifacts[0]?.evidenceDigest,
      persisted.recordDigest,
    );
  } finally {
    value.cleanup();
  }
});

test('artifact authority rejects a pathname swap after opening the executable', () => {
  const value = fixture();
  try {
    captureAndMaterialize(value);
    const executablePath = writeEngineExecutable(value.child);
    const originalBytes = fs.readFileSync(executablePath);
    const displacedPath = `${executablePath}.opened`;
    const outsidePath = path.join(value.root, 'outside-engine.mjs');
    fs.writeFileSync(outsidePath, originalBytes, { mode: 0o755 });
    fs.chmodSync(outsidePath, 0o755);
    const sidecar = readPersistedBootstrapSidecarWorkflow(
      value.stateRoot,
      'parent-A',
    );
    const artifact = createEngineArtifact({
      sourceChangeId: 'intervention-B',
      sourceDigest: digest('pathname-swap-source'),
      executableDigest: digest(originalBytes),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('pathname-swap-smoke'),
      workflowBindingDigest: sidecar.workflowBinding.workflowBindingDigest,
    });
    let swapped = false;

    assert.throws(
      () =>
        persistInterventionEngineArtifact(value.stateRoot, {
          parentChangeId: 'parent-A',
          artifact,
          executablePath,
          now: new Date('2026-08-10T03:02:00.000Z'),
          testAfterArtifactExecutableOpenedBeforeRead() {
            fs.renameSync(executablePath, displacedPath);
            fs.symlinkSync(outsidePath, executablePath);
            swapped = true;
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INTERVENTION_ENGINE_ARTIFACT_DRIFT',
    );
    assert.equal(swapped, true);
    assert.equal(
      fs.existsSync(
        interventionEngineArtifactRecordPath(
          value.stateRoot,
          artifact.artifactId,
        ),
      ),
      false,
    );
    assert.equal(
      readPersistedBootstrapSidecarWorkflow(value.stateRoot, 'parent-A')
        .artifacts.length,
      0,
    );
  } finally {
    value.cleanup();
  }
});
