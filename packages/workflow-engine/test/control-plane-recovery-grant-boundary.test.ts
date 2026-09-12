import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  canonicalDigest,
  rawDigest,
  type ControlPlaneRecoveryGrantEnvelope,
  type ControlPlaneRecoveryGrantPersistence,
  type ControlPlaneRecoveryFailure,
} from '../src/modules/authority/control-plane-recovery-grant-values.ts';
import {
  createControlPlaneRecoveryGrantPayload,
  createControlPlaneRecoveryReceipt,
  createControlPlaneRecoveryFailure,
} from '../src/modules/authority/control-plane-recovery-grant-records.ts';
import { controlPlaneRecoveryGrantPersistence } from '../src/runtime/storage-journal/control-plane-recovery-grant.ts';
import { createHarnessBootstrapRecoveryProduction } from '../src/application/control-plane/harness-bootstrap-production.ts';
import { createHarnessBootstrapProduction } from '../src/composition-root/harness-bootstrap-production.ts';
import { preflightControlPlaneRecoveryRollback } from '../src/application/control-plane/intervention-control-updater.ts';
import { RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE } from '../src/modules/authority/recovery-trust-root-values.ts';
import type { MaintainerSignerProvider } from '../src/modules/authority/maintainer-signer-port.ts';

const now = new Date('2026-08-10T10:00:00.000Z');
const completedAt = '2026-08-10T10:01:00.000Z';
const source = 'source-control-plane-grant';

function privateRoot(t: TestContext): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-grant-boundary-')),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function envelopeFor(
  root: string,
  sourceControlPlaneGrantId = source,
): ControlPlaneRecoveryGrantEnvelope {
  return {
    signature: 'human-signature',
    payload: createControlPlaneRecoveryGrantPayload({
      repositoryId: 'github:example/repository',
      sourceControlPlaneGrantId,
      previousClosureDigest: canonicalDigest('previous'),
      currentClosureDigest: canonicalDigest('current'),
      promotionBundleDigest: canonicalDigest('promotion'),
      recoveryBundleDigest: canonicalDigest('recovery'),
      controlPlaneUpdateRecordDigest: canonicalDigest('update'),
      controlPlaneJournalDigest: canonicalDigest('journal'),
      supervisorStateDigest: canonicalDigest('supervisor'),
      supervisorGeneration: 2,
      sourceTransactionState: 'ROLLBACK_REQUIRED',
      externalAuditRoot: root,
      issuedAt: now.toISOString(),
      humanSigner: 'maintainer@example.test',
    }),
  };
}

function recordPath(root: string, recoveryGrantId: string): string {
  return path.join(
    root,
    'control-plane-recovery-grants',
    rawDigest(`control-plane-recovery\0${recoveryGrantId}`).slice(
      'sha256:'.length,
    ) + '.json',
  );
}

test('recovery Grant record rules have a pure value and type dependency closure', () => {
  for (const name of [
    'control-plane-recovery-grant.ts',
    'control-plane-recovery-grant-values.ts',
    'control-plane-recovery-grant-records.ts',
  ]) {
    assertPureDependencyClosure(
      path.resolve(import.meta.dirname, '../src/modules/authority', name),
    );
  }
});

test('recovery rule closure rejects deliberate value and type-only outward imports', () => {
  const entry = path.resolve(
    import.meta.dirname,
    '../src/modules/authority/control-plane-recovery-grant.ts',
  );
  for (const additional of [
    "import fs from 'node:fs';",
    "import type { Stats } from 'node:fs';",
    "import type { ControlPlaneRecoveryExecutorDependencies } from '../../application/control-plane/intervention-control-updater.ts';",
  ])
    assert.throws(
      () => assertPureDependencyClosure(entry, additional),
      /Effect import|Outward pure dependency/,
    );
});

test('production assembly provides the required persistence capability and actual preflight calls the injected lookup', (t) => {
  const root = privateRoot(t);
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      assert.fail('lookup must precede signing');
    },
    identity() {
      return 'maintainer@example.test';
    },
    sign() {
      assert.fail('lookup must precede signing');
    },
    verify() {},
  };
  const overrides = {
    now: () => now,
    recoverySigner: signer,
    verifyHumanSignature: () => true,
    controlPlaneAuditSink: {
      append() {
        assert.fail('lookup must precede audit');
      },
    },
    recoveryAuditSink: {
      append() {
        assert.fail('lookup must precede audit');
      },
    },
  };
  const production = createHarnessBootstrapProduction(
    canonicalDigest('built-in closure'),
  );
  const real = production.createHarnessRecoveryDependencies(
    root,
    root,
    overrides,
  );
  assert.equal(
    real.dependencies.recoveryGrants,
    controlPlaneRecoveryGrantPersistence,
  );
  const sentinel = new Error('injected lookup reached');
  const calls: string[][] = [];
  const injected: ControlPlaneRecoveryGrantPersistence = {
    ...controlPlaneRecoveryGrantPersistence,
    findForSource(storageRoot, sourceId) {
      calls.push([storageRoot, sourceId]);
      throw sentinel;
    },
  };
  const assembly = createHarnessBootstrapRecoveryProduction({
    ...production,
    recoveryGrants: injected,
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    verifySshSignatureWithPublicKey() {
      assert.fail('lookup must precede signature verification');
    },
  });
  const { dependencies } = assembly.createHarnessRecoveryDependencies(
    root,
    root,
    overrides,
  );
  assert.equal(dependencies.recoveryGrants, injected);
  assert.throws(
    () =>
      preflightControlPlaneRecoveryRollback(
        root,
        source,
        { humanSigner: signer.identity(), issuedAt: now.toISOString() },
        dependencies,
      ),
    (error) => error === sentinel,
  );
  assert.deepEqual(calls, [[root, source]]);
});

test('persistence replay preserves the existing inode and bytes for prepared failed and expired records', (t) => {
  for (const state of ['completion-pending', 'failed', 'expired']) {
    const root = privateRoot(t);
    const envelope = envelopeFor(root);
    const payload = envelope.payload;
    const reserved = controlPlaneRecoveryGrantPersistence.reserve(
      root,
      envelope,
      now.toISOString(),
    );
    const input = {
      recoveryGrantId: payload.grantId,
      expectedRecordDigest: reserved.recordDigest,
    };
    const receipt = createControlPlaneRecoveryReceipt({
      payload,
      poststateDigest: canonicalDigest('post'),
      controlPlaneJournalDigestAfter: canonicalDigest('journal after'),
      supervisorStateDigestAfter: canonicalDigest('supervisor after'),
      completedAt,
    });
    const failure = createControlPlaneRecoveryFailure({
      payload,
      errorCode: 'RESTART_PROBE_FAILED',
      selectedClosureDigest: payload.previousClosureDigest,
      selectedArtifactId: 'previous',
      supervisorStateDigest: canonicalDigest('failed supervisor'),
      supervisorGeneration: 3,
      controlPlaneJournalDigest: canonicalDigest('failed journal'),
      failedAt: completedAt,
    });
    const current =
      state === 'completion-pending'
        ? controlPlaneRecoveryGrantPersistence.prepareConsumption(root, {
            ...input,
            receipt,
          })
        : state === 'failed'
          ? controlPlaneRecoveryGrantPersistence.fail(root, {
              ...input,
              failure,
            })
          : controlPlaneRecoveryGrantPersistence.expire(root, {
              ...input,
              expiredAt: payload.expiresAt,
            });
    const file = recordPath(root, payload.grantId);
    function snapshot() {
      const value = fs.statSync(file, { bigint: true });
      return {
        dev: value.dev,
        ino: value.ino,
        size: value.size,
        mode: value.mode,
        uid: value.uid,
        nlink: value.nlink,
        mtimeNs: value.mtimeNs,
        ctimeNs: value.ctimeNs,
        bytes: fs.readFileSync(file),
        entries: fs.readdirSync(path.dirname(file)).sort(),
        rootEntries: fs.readdirSync(root).sort(),
      };
    }
    const before = snapshot();
    const staleInput = {
      ...input,
      expectedRecordDigest: canonicalDigest('stale'),
    };
    const replay =
      state === 'completion-pending'
        ? controlPlaneRecoveryGrantPersistence.prepareConsumption(root, {
            ...staleInput,
            receipt,
          })
        : state === 'failed'
          ? controlPlaneRecoveryGrantPersistence.fail(root, {
              ...staleInput,
              failure: {} as ControlPlaneRecoveryFailure,
            })
          : controlPlaneRecoveryGrantPersistence.expire(root, {
              ...staleInput,
              expiredAt: 'invalid',
            });
    assert.deepEqual(replay, current, state);
    assert.deepEqual(snapshot(), before, state);
  }
});

test('source lookup rejects an unrelated corrupt final record before filtering by source', (t) => {
  const root = privateRoot(t);
  const requested = envelopeFor(root);
  const unrelated = envelopeFor(root, 'another-source');
  controlPlaneRecoveryGrantPersistence.reserve(
    root,
    requested,
    now.toISOString(),
  );
  controlPlaneRecoveryGrantPersistence.reserve(
    root,
    unrelated,
    now.toISOString(),
  );
  const file = recordPath(root, unrelated.payload.grantId);
  const corrupt = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(
    corrupt.envelope.payload.sourceControlPlaneGrantId,
    'another-source',
  );
  corrupt.recordDigest = canonicalDigest('corrupt unrelated record');
  fs.writeFileSync(file, `${canonicalJson(corrupt)}\n`);
  const before = fs.readFileSync(file);
  assert.throws(
    () => controlPlaneRecoveryGrantPersistence.findForSource(root, source),
    { code: 'HARNESS_RECOVERY_RECORD_CORRUPT' },
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

test('family factories and concrete persistence entries are absent from the old fixed binding boundary', () => {
  const sourceRoot = path.resolve(import.meta.dirname, '../src');
  for (const name of [
    'control-plane-recovery-grant.ts',
    'control-plane-recovery-grant-records.ts',
  ]) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(sourceRoot, 'modules/authority', name), 'utf8'),
      /createControlPlaneRecoveryGrantRecords|createControlPlaneRecoveryGrantStorage|ControlPlaneRecoveryGrantRecordsBindings|ControlPlaneRecoveryGrantStorageBindings/,
    );
  }
  assert.equal(
    fs.existsSync(
      path.join(
        sourceRoot,
        'modules/authority/control-plane-recovery-grant-storage.ts',
      ),
    ),
    false,
  );
  const updater = fs.readFileSync(
    path.join(
      sourceRoot,
      'application/control-plane/intervention-control-updater.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(
    updater,
    /(?:find|reserve|consume|expire|fail|prepare)PersistedControlPlaneRecoveryGrant/,
  );
});
