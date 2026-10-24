import { execFileSync } from 'node:child_process';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  readPersistedIntervention,
  persistedBootstrapSidecarSessionPath,
} from '../src/runtime/storage-journal/intervention-control-persistence.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dispatchBootstrapInterventionCommand } from '../src/entrypoints/cli/intervention-control-bootstrap-cli.ts';
import { readMaintenanceGrantForParent } from '../src/application/control-plane/intervention-maintenance.ts';
import { revokeMaintenanceGrantForParent } from '../src/composition-root/human-revocation-production.ts';
import { readLocalEngineBinding } from '../src/runtime/storage-journal/intervention-parent-binding.ts';
import { readPersistedBootstrapSidecarWorkflow } from '../src/runtime/storage-journal/intervention-control-persistence.ts';
import {
  metadataFixture,
  humanDependencies,
  digest,
  withDigest,
  writeRecord,
  NOW,
  EXPIRES,
} from './intervention-metadata-fixture.ts';

const ARGS = [
  'change',
  'revoke-intervention',
  'parent-A',
  '--reason',
  'Retire existing repair',
];
const LATER = new Date('2026-08-03T11:00:00.000Z');
function metadataSnapshot(root: string) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [
        path.relative(root, file),
        fs.readFileSync(file).toString('base64'),
      ];
    })
    .sort((left, right) => left[0]!.localeCompare(right[0]!));
}
function replaceCheckpoint(f: ReturnType<typeof metadataFixture>) {
  const { checkpointId: originalId, ...payload } = f.checkpoint;
  const nextPayload = {
    ...payload,
    worktreeFingerprint: digest('different-valid-checkpoint'),
  };
  const checkpoint = {
    ...nextPayload,
    checkpointId: digest(canonicalJson(nextPayload)),
  };
  assert.notEqual(checkpoint.checkpointId, originalId);
  writeRecord(
    path.join(
      f.stateRoot,
      'checkpoints',
      checkpoint.checkpointId.slice(7) + '.json',
    ),
    checkpoint,
  );
  const { metadataDigest: _digest, ...child } = f.intervention.childWorkspace;
  const identity = {
    kind: 'intervention-child-worktree-identity.v1',
    parentChangeId: child.parentChangeId,
    interventionChangeId: child.interventionChangeId,
    checkpointId: checkpoint.checkpointId,
    parentWorkspacePath: child.parentWorkspacePath,
    childWorkspacePath: child.childWorkspacePath,
    changeRef: child.changeRef,
  };
  const nextChild = {
    ...child,
    checkpointId: checkpoint.checkpointId,
    workspaceId: digest(canonicalJson(identity)),
  };
  writeRecord(
    f.interventionFile,
    withDigest({
      ...f.intervention,
      parent: {
        ...f.intervention.parent,
        blocker: {
          ...f.intervention.parent.blocker,
          checkpointId: checkpoint.checkpointId,
        },
      },
      relationship: {
        ...f.intervention.relationship,
        checkpointId: checkpoint.checkpointId,
      },
      checkpoint,
      childWorkspace: {
        ...nextChild,
        metadataDigest: digest(canonicalJson(nextChild)),
      },
    }),
  );
  writeRecord(
    f.bindingFile,
    withDigest({
      ...f.binding,
      checkpointId: checkpoint.checkpointId,
      blocker:
        f.binding.blocker === null
          ? null
          : { ...f.binding.blocker, checkpointId: checkpoint.checkpointId },
    }),
  );
  assert.equal(
    readPersistedIntervention(f.stateRoot, 'parent-A').checkpoint.checkpointId,
    checkpoint.checkpointId,
  );
  assert.equal(
    readLocalEngineBinding(f.bindingFile).checkpointId,
    checkpoint.checkpointId,
  );
}
function expired(f: ReturnType<typeof metadataFixture>) {
  writeRecord(
    f.grantFile,
    withDigest({
      ...f.grant,
      state: 'expired',
      expiredAt: EXPIRES,
      updatedAt: EXPIRES,
    }),
  );
}
for (const state of ['absent', 'active', 'adopted'] as const) {
  test(`signed metadata disposition clears ${state} binding without touching WIP or child data`, () => {
    const f = metadataFixture(state);
    try {
      const before = f.protectedBytes();
      const human = humanDependencies();
      const status = dispatchBootstrapInterventionCommand(
        ['status', 'parent-A'],
        f.repositoryRoot,
        {
          get now(): never {
            throw new Error('Status must not observe a clock.');
          },
          get maintenanceSigner(): never {
            throw new Error('Status must not resolve a signer.');
          },
          get verifyHumanSignature(): never {
            throw new Error('Status must not inspect signature capabilities.');
          },
          get testHooks(): never {
            throw new Error('Status must not inspect mutation hooks.');
          },
        },
      );
      assert.deepEqual(status, {
        kind: 'bootstrap-intervention-cli-result.v1',
        action: 'status',
        stateRoot: f.stateRoot,
        bindingPath: f.bindingFile,
        parentChangeId: 'parent-A',
        checkpointId: f.checkpoint.checkpointId,
        workspaceId: f.intervention.childWorkspace.workspaceId,
        intervention: f.intervention,
        parentSession: state === 'absent' ? null : f.binding,
        effectsPerformed: false,
      });
      assert.deepEqual(f.protectedBytes(), before);
      const result = dispatchBootstrapInterventionCommand(
        ARGS,
        f.repositoryRoot,
        human.dependencies,
      );
      assert.deepEqual(result, {
        kind: 'bootstrap-intervention-cli-result.v1',
        action: 'revoke-intervention',
        stateRoot: f.stateRoot,
        bindingPath: f.bindingFile,
        parentChangeId: 'parent-A',
        checkpointId: f.checkpoint.checkpointId,
        workspaceId: null,
        intervention: null,
        parentSession: null,
        effectsPerformed: true,
      });
      assert.equal(human.signatures(), 1);
      assert.equal(fs.existsSync(f.bindingFile), false);
      assert.equal(fs.existsSync(f.interventionFile), false);
      assert.equal(
        readPersistedBootstrapSidecarWorkflow(f.stateRoot, 'parent-A').state,
        'abandoned',
      );
      assert.equal(
        readMaintenanceGrantForParent(f.stateRoot, 'parent-A').state,
        'revoked',
      );
      assert.deepEqual(f.protectedBytes(), before);
      assert.equal(fs.existsSync(f.marker), false);
      assert.equal(
        dispatchBootstrapInterventionCommand(
          ARGS,
          f.repositoryRoot,
          human.dependencies,
        ).effectsPerformed,
        false,
      );
      assert.equal(human.signatures(), 1);
      assert.deepEqual(f.protectedBytes(), before);
    } finally {
      f.cleanup();
    }
  });
}
test('expired authority can be signed for metadata disposition while retaining expiredAt', () => {
  const f = metadataFixture('adopted');
  try {
    expired(f);
    const before = f.protectedBytes();
    dispatchBootstrapInterventionCommand(
      ARGS,
      f.repositoryRoot,
      humanDependencies({ now: LATER }).dependencies,
    );
    const grant = readMaintenanceGrantForParent(f.stateRoot, 'parent-A');
    assert.equal(grant.state, 'revoked');
    assert.equal(grant.expiredAt, EXPIRES);
    assert.equal(grant.revokedAt, LATER.toISOString());
    assert.deepEqual(f.protectedBytes(), before);
  } finally {
    f.cleanup();
  }
});
test('prepared pre-expiry revocation replays after expiry without rewriting signed time', () => {
  const f = metadataFixture();
  try {
    const before = f.protectedBytes();
    const first = humanDependencies({
      afterAuthorityAuditRecorded() {
        throw new Error('after signed audit');
      },
    });
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          ARGS,
          f.repositoryRoot,
          first.dependencies,
        ),
      /after signed audit/,
    );
    expired(f);
    const replay = humanDependencies({ now: LATER });
    dispatchBootstrapInterventionCommand(
      ARGS,
      f.repositoryRoot,
      replay.dependencies,
    );
    const grant = readMaintenanceGrantForParent(f.stateRoot, 'parent-A');
    assert.equal(grant.expiredAt, EXPIRES);
    assert.equal(grant.revokedAt, NOW.toISOString());
    assert.equal(replay.signatures(), 0);
    assert.deepEqual(f.protectedBytes(), before);
    assert.equal(
      dispatchBootstrapInterventionCommand(
        ARGS,
        f.repositoryRoot,
        replay.dependencies,
      ).effectsPerformed,
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('signed disposal preserves adopted sidecar evidence and appends one abandonment event', () => {
  const f = metadataFixture('adopted');
  try {
    const source = readPersistedIntervention(f.stateRoot, 'parent-A');
    const identity = {
      parentChangeId: 'parent-A',
      interventionChangeId: 'repair-A',
      checkpointId: f.checkpoint.checkpointId,
      workspaceId: source.childWorkspace.workspaceId,
    };
    const workflowPayload = {
      kind: 'bootstrap-maintenance-workflow.v1' as const,
      workflowType: 'bootstrap-maintenance' as const,
      workflowId: digest(
        canonicalJson({
          kind: 'bootstrap-maintenance-workflow-identity.v1',
          changeId: 'repair-A',
          parentChangeId: 'parent-A',
          checkpointId: identity.checkpointId,
          workspaceId: identity.workspaceId,
        }),
      ),
      changeId: 'repair-A',
      parentChangeId: 'parent-A',
      checkpointId: identity.checkpointId,
      workspaceId: identity.workspaceId,
      repositoryRoot: f.child,
      changeRef: 'refs/heads/work/repair-A',
      baselineOid: f.checkpoint.baseOid,
      status: 'repair-active' as const,
    };
    const sidecar = {
      kind: 'bootstrap-sidecar-session.v2' as const,
      sidecarSessionId: digest(
        canonicalJson({
          kind: 'bootstrap-sidecar-session-identity.v2',
          ...identity,
          workflowId: workflowPayload.workflowId,
        }),
      ),
      identity,
      workflowBinding: {
        ...workflowPayload,
        workflowBindingDigest: digest(canonicalJson(workflowPayload)),
      },
      parentUnblock: {
        kind: 'sidecar-unblocks-parent.v1' as const,
        parentChangeId: 'parent-A',
      },
      workspace: {
        childWorkspacePath: f.child,
        changeRef: 'refs/heads/work/repair-A',
      },
      promotion: null,
      history: [
        {
          sequence: 1,
          eventKind: 'sidecar-created' as const,
          evidenceDigest: source.recordDigest,
          recordedAt: NOW.toISOString(),
        },
      ],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const { workflowBindingDigest: _, ...workflow } = sidecar.workflowBinding;
    const workflowBinding = { ...workflow, status: 'adopted' as const };
    const events = [
      'workspace-materialized',
      'artifact-ready',
      'adopted-by-parent',
    ] as const;
    const adopted = withDigest({
      ...sidecar,
      state: 'adopted' as const,
      workflowBinding: {
        ...workflowBinding,
        workflowBindingDigest: digest(canonicalJson(workflowBinding)),
      },
      workspace: {
        ...sidecar.workspace,
        state: 'materialized' as const,
        receiptDigest: digest('workspace receipt'),
        materializedAt: NOW.toISOString(),
      },
      artifacts: [
        {
          artifactId: f.binding.activeArtifact.artifactId,
          sourceDigest: digest('source'),
          executableDigest: f.binding.activeArtifact.executableDigest,
          evidenceDigest: digest('artifact evidence'),
          readyAt: NOW.toISOString(),
          workflowBindingDigest: sidecar.workflowBinding.workflowBindingDigest,
          workflowStatus: 'repair-active' as const,
        },
      ],
      adoption: {
        txId: f.binding.txId,
        artifactId: f.binding.activeArtifact.artifactId,
        journalDigest: digest('journal'),
        adoptedAt: NOW.toISOString(),
        workflowBindingDigest: sidecar.workflowBinding.workflowBindingDigest,
        workflowStatus: 'repair-active' as const,
      },
      parentUnblock: {
        ...sidecar.parentUnblock,
        state: 'unblocked' as const,
        resolution: 'local-adoption' as const,
        resolvedByTxId: f.binding.txId,
        resolvedAt: NOW.toISOString(),
      },
      history: [
        ...sidecar.history,
        ...events.map((eventKind, i) => ({
          sequence: i + 2,
          eventKind,
          evidenceDigest: digest(eventKind),
          recordedAt: NOW.toISOString(),
        })),
      ],
    });
    writeRecord(
      persistedBootstrapSidecarSessionPath(f.stateRoot, 'parent-A'),
      adopted,
    );
    assert.equal(
      readPersistedBootstrapSidecarWorkflow(f.stateRoot, 'parent-A').state,
      'adopted',
    );
    const before = f.protectedBytes();
    execFileSync(process.execPath, [f.candidate]);
    assert.equal(fs.existsSync(f.marker), true);
    fs.unlinkSync(f.marker);
    dispatchBootstrapInterventionCommand(
      ARGS,
      f.repositoryRoot,
      humanDependencies().dependencies,
    );
    const after = readPersistedBootstrapSidecarWorkflow(
      f.stateRoot,
      'parent-A',
    );
    assert.equal(after.state, 'abandoned');
    assert.deepEqual(after.adoption, adopted.adoption);
    assert.deepEqual(after.history.slice(0, -1), adopted.history);
    assert.equal(after.history.at(-1)?.eventKind, 'intervention-abandoned');
    assert.equal(fs.existsSync(f.marker), false);
    assert.deepEqual(f.protectedBytes(), before);
    dispatchBootstrapInterventionCommand(
      ARGS,
      f.repositoryRoot,
      humanDependencies().dependencies,
    );
    assert.deepEqual(
      readPersistedBootstrapSidecarWorkflow(f.stateRoot, 'parent-A'),
      after,
    );
  } finally {
    f.cleanup();
  }
});

test('metadata disposition rejects a different valid checkpoint before signing or replay', () => {
  for (const state of ['available', 'expired', 'revoked-before-intent']) {
    const f = metadataFixture('adopted');
    try {
      if (state === 'expired') expired(f);
      if (state === 'revoked-before-intent') {
        const human = humanDependencies().dependencies;
        revokeMaintenanceGrantForParent(
          f.repositoryRoot,
          f.stateRoot,
          'parent-A',
          {
            reason: ARGS.at(-1)!,
            now: NOW,
            signer: human.maintenanceSigner,
            verifyHumanSignature: human.verifyHumanSignature!,
          },
        );
      }
      const grant = fs.readFileSync(f.grantFile);
      replaceCheckpoint(f);
      assert.deepEqual(fs.readFileSync(f.grantFile), grant);
      const before = metadataSnapshot(f.root);
      const human = humanDependencies();
      assert.throws(
        () =>
          dispatchBootstrapInterventionCommand(
            ARGS,
            f.repositoryRoot,
            human.dependencies,
          ),
        { code: 'INTERVENTION_ABANDONMENT_AUTHORITY_MISMATCH' },
      );
      assert.equal(human.signatures(), 0);
      assert.deepEqual(metadataSnapshot(f.root), before);
    } finally {
      f.cleanup();
    }
  }
});

test('metadata disposition rechecks the authorized checkpoint before writing its intent', () => {
  const f = metadataFixture('adopted');
  try {
    const before = f.protectedBytes();
    let binding: Buffer | undefined;
    let intervention: Buffer | undefined;
    const human = humanDependencies({
      afterAuthorityAuditRecorded() {
        replaceCheckpoint(f);
        binding = fs.readFileSync(f.bindingFile);
        intervention = fs.readFileSync(f.interventionFile);
      },
    });
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          ARGS,
          f.repositoryRoot,
          human.dependencies,
        ),
      { code: 'INTERVENTION_ABANDONMENT_AUTHORITY_MISMATCH' },
    );
    assert.equal(human.signatures(), 1);
    assert.deepEqual(fs.readFileSync(f.bindingFile), binding);
    assert.deepEqual(fs.readFileSync(f.interventionFile), intervention);
    assert.equal(
      readMaintenanceGrantForParent(f.stateRoot, 'parent-A').state,
      'revoked',
    );
    assert.deepEqual(f.protectedBytes(), before);
    assert.equal(
      fs.existsSync(path.join(f.stateRoot, 'intervention-abandonments')),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('revoked maintenance metadata requires its exact human revocation authorization', () => {
  for (const variant of ['missing-authorization', 'mismatched-time']) {
    const f = metadataFixture();
    try {
      dispatchBootstrapInterventionCommand(
        ARGS,
        f.repositoryRoot,
        humanDependencies().dependencies,
      );
      const revoked = readMaintenanceGrantForParent(f.stateRoot, 'parent-A');
      assert.equal(revoked.state, 'revoked');
      const {
        revocationAuthorization: _authorization,
        ...withoutAuthorization
      } = revoked;
      writeRecord(
        f.grantFile,
        withDigest(
          variant === 'missing-authorization'
            ? withoutAuthorization
            : { ...revoked, revokedAt: LATER.toISOString() },
        ),
      );
      const before = metadataSnapshot(f.root);
      const replay = humanDependencies();
      assert.throws(
        () =>
          dispatchBootstrapInterventionCommand(
            ARGS,
            f.repositoryRoot,
            replay.dependencies,
          ),
        { code: 'MAINTENANCE_GRANT_RECORD_CORRUPT' },
      );
      assert.equal(replay.signatures(), 0);
      assert.deepEqual(metadataSnapshot(f.root), before);
    } finally {
      f.cleanup();
    }
  }
});

test('metadata disposal rejects wrong bindings, signature, signer and expiry before mutation', () => {
  for (const variant of [
    'parent',
    'checkpoint',
    'signature',
    'signer',
    'expiry',
  ] as const) {
    const f = metadataFixture();
    try {
      const human = humanDependencies({
        signatureValid: variant !== 'signature',
      });
      if (variant === 'parent')
        writeRecord(
          f.bindingFile,
          withDigest({ ...f.binding, parentWorkspacePath: f.child }),
        );
      if (variant === 'checkpoint')
        writeRecord(
          f.interventionFile,
          withDigest({
            ...f.intervention,
            checkpoint: { ...f.checkpoint, baseOid: 'a'.repeat(40) },
          }),
        );
      if (variant === 'signer')
        human.dependencies.maintenanceSigner!.identity = () =>
          'untrusted@example.test';
      if (variant === 'expiry')
        writeRecord(
          f.grantFile,
          withDigest({
            ...f.grant,
            state: 'expired',
            expiredAt: '2026-08-03T10:29:00.000Z',
          }),
        );
      const before = f.protectedBytes(),
        grant = fs.readFileSync(f.grantFile),
        binding = fs.readFileSync(f.bindingFile),
        intervention = fs.readFileSync(f.interventionFile);
      assert.throws(() =>
        dispatchBootstrapInterventionCommand(
          ARGS,
          f.repositoryRoot,
          human.dependencies,
        ),
      );
      assert.equal(human.signatures(), 0);
      assert.deepEqual(fs.readFileSync(f.grantFile), grant);
      assert.deepEqual(fs.readFileSync(f.bindingFile), binding);
      assert.deepEqual(fs.readFileSync(f.interventionFile), intervention);
      assert.deepEqual(f.protectedBytes(), before);
    } finally {
      f.cleanup();
    }
  }
});

test('durable abandonment detects binding drift and resumes from the exact original metadata', () => {
  const f = metadataFixture('adopted');
  try {
    const before = f.protectedBytes();
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          ARGS,
          f.repositoryRoot,
          humanDependencies({
            afterAbandonmentIntentPersisted() {
              throw new Error('intent interruption');
            },
          }).dependencies,
        ),
      /intent interruption/,
    );
    const original = fs.readFileSync(f.bindingFile);
    writeRecord(
      f.bindingFile,
      withDigest({ ...f.binding, generation: f.binding.generation + 1 }),
    );
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          ARGS,
          f.repositoryRoot,
          humanDependencies().dependencies,
        ),
      { code: 'INTERVENTION_ABANDONMENT_BINDING_DRIFT' },
    );
    assert.equal(fs.existsSync(f.interventionFile), true);
    fs.writeFileSync(f.bindingFile, original);
    const replay = humanDependencies();
    dispatchBootstrapInterventionCommand(
      ARGS,
      f.repositoryRoot,
      replay.dependencies,
    );
    assert.equal(replay.signatures(), 0);
    assert.deepEqual(f.protectedBytes(), before);
    assert.throws(() =>
      dispatchBootstrapInterventionCommand(
        [...ARGS.slice(0, -1), 'Different reason'],
        f.repositoryRoot,
        replay.dependencies,
      ),
    );
  } finally {
    f.cleanup();
  }
});

for (const partial of [
  'intent',
  'binding-cleared',
  'active-records-cleared',
] as const) {
  test(`signed abandonment resumes after ${partial} without changing retained bytes`, () => {
    const f = metadataFixture('adopted');
    try {
      const before = f.protectedBytes();
      assert.throws(
        () =>
          dispatchBootstrapInterventionCommand(
            ARGS,
            f.repositoryRoot,
            humanDependencies({
              afterAbandonmentIntentPersisted() {
                if (partial !== 'intent') fs.unlinkSync(f.bindingFile);
                if (partial === 'active-records-cleared')
                  fs.unlinkSync(f.interventionFile);
                throw new Error('interrupted metadata disposition');
              },
            }).dependencies,
          ),
        /interrupted metadata disposition/,
      );
      const replay = humanDependencies();
      dispatchBootstrapInterventionCommand(
        ARGS,
        f.repositoryRoot,
        replay.dependencies,
      );
      assert.equal(replay.signatures(), 0);
      assert.equal(fs.existsSync(f.bindingFile), false);
      assert.equal(fs.existsSync(f.interventionFile), false);
      assert.equal(
        dispatchBootstrapInterventionCommand(
          ARGS,
          f.repositoryRoot,
          replay.dependencies,
        ).effectsPerformed,
        false,
      );
      assert.deepEqual(f.protectedBytes(), before);
    } finally {
      f.cleanup();
    }
  });
}
