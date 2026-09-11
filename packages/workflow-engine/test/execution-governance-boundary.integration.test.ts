import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildContextManifest } from '../src/modules/authority/execution-governance-context.ts';
import { digest } from '../src/modules/authority/execution-governance-values.ts';
import type { EvidenceRetentionRecord } from '../src/modules/authority/execution-governance-retention.ts';
import { canonicalDurablePruneReceipt } from '../src/modules/authority/execution-governance-store-contracts.ts';
import { initializeDurableEpochContextStore } from '../src/runtime/storage-journal/execution-governance-epoch-store.ts';
import {
  inspectDurableRetentionCatalog,
  listDurablePruneReceipts,
  pruneDurableEvidence,
  storeDurableEvidence,
} from '../src/runtime/storage-journal/execution-governance-evidence-store.ts';
import {
  durableObjectPath,
  durableStatePath,
  ensureDurableGovernanceStore,
  readDurableGovernanceState,
} from '../src/runtime/storage-journal/execution-governance-store-objects.ts';
import { recoverPreparedPruneReceipts } from '../src/runtime/recovery/execution-governance-prune-recovery.ts';
import {
  withDurableGovernanceLock,
  withExecutionGrantLock,
} from '../src/runtime/storage-journal/execution-governance-locks.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const workflowId = 'prune-recovery';
const now = new Date('2026-08-12T09:00:00.000Z');

function fixture() {
  const store = fs.mkdtempSync(
    path.join(os.tmpdir(), 'execution-governance-phases-'),
  );
  const manifest = buildContextManifest({
    workflowId,
    epoch: 2,
    contractVersion: 1,
    baselineDigest: digest('baseline'),
    intentDigest: digest('intent'),
    termSetDigest: digest('terms'),
    planningSnapshotDigest: digest('plan'),
    items: [{ identity: 'intent', content: 'current context' }],
  });
  initializeDurableEpochContextStore(store, {
    workflow: {
      workflowId,
      currentEpoch: 2,
      contractVersion: 1,
      contextDigest: manifest.contextDigest,
      snapshotDigest: manifest.baselineDigest,
      status: 'active',
      checkpoint: 'main-terms',
      blocker: null,
    },
    manifest,
    items: [{ identity: 'intent', content: 'current context' }],
    now,
  });
  const content = 'expired historical evidence';
  const record: EvidenceRetentionRecord = {
    schemaVersion: 1,
    kind: 'evidence-retention',
    evidenceId: 'expired',
    itemIdentity: null,
    workflowId,
    epoch: 1,
    evidenceClass: 'raw',
    digest: digest(content),
    retention: 'expiring',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
    pin: null,
  };
  storeDurableEvidence(store, {
    workflowId,
    expectedCatalogGeneration: 1,
    record,
    content,
  });
  const paths = ensureDurableGovernanceStore(store);
  return {
    store,
    paths,
    content,
    objectPath: durableObjectPath(paths, workflowId, record.digest),
    prune: () =>
      pruneDurableEvidence(store, {
        workflowId,
        expectedContextGeneration: 1,
        expectedEpoch: 2,
        expectedContextDigest: manifest.contextDigest,
        expectedCatalogGeneration: 2,
        now,
      }),
    recover: () =>
      recoverPreparedPruneReceipts(
        paths,
        workflowId,
        readDurableGovernanceState(paths, workflowId),
      ),
  };
}

test('governance policy and canonical contracts have a complete pure dependency closure', () => {
  for (const name of [
    'execution-governance',
    'execution-governance-store-transitions',
    'execution-governance-epoch-port',
    'task-mandate-contract',
  ]) {
    assertPureDependencyClosure(
      fileURLToPath(
        new URL(`../src/modules/authority/${name}.ts`, import.meta.url),
      ),
    );
  }
});

test('prepared prune before catalog publication aborts without deleting evidence', (t) => {
  const f = fixture();
  try {
    const failure = new Error('catalog publication interrupted');
    const original = fs.renameSync;
    const mock = t.mock.method(
      fs,
      'renameSync',
      (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]) === durableStatePath(f.paths, workflowId))
          throw failure;
        return original(...args);
      },
    );
    assert.throws(f.prune, (error) => error === failure);
    mock.mock.restore();
    assert.equal(
      listDurablePruneReceipts(f.store, workflowId)[0]!.state,
      'prepared',
    );
    assert.equal(
      inspectDurableRetentionCatalog(f.store, workflowId).generation,
      2,
    );
    assert.equal(fs.readFileSync(f.objectPath, 'utf8'), f.content);
    f.recover();
    const [receipt] = listDurablePruneReceipts(f.store, workflowId);
    assert.equal(receipt!.state, 'aborted');
    assert.equal(
      receipt!.abortReason,
      'Pruning stopped before catalog publication.',
    );
    assert.equal(fs.readFileSync(f.objectPath, 'utf8'), f.content);
    f.recover();
    assert.deepEqual(listDurablePruneReceipts(f.store, workflowId), [receipt]);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(f.store, { recursive: true, force: true });
  }
});

test('prepared prune after catalog publication completes deletion once and preserves its receipt', (t) => {
  const f = fixture();
  try {
    const failure = new Error('object deletion interrupted');
    const original = fs.unlinkSync;
    const mock = t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
      if (String(file) === f.objectPath) throw failure;
      return original(file);
    });
    assert.throws(f.prune, (error) => error === failure);
    mock.mock.restore();
    assert.equal(
      listDurablePruneReceipts(f.store, workflowId)[0]!.state,
      'prepared',
    );
    assert.equal(
      inspectDurableRetentionCatalog(f.store, workflowId).generation,
      3,
    );
    assert.equal(fs.existsSync(f.objectPath), true);
    f.recover();
    const [receipt] = listDurablePruneReceipts(f.store, workflowId);
    assert.equal(receipt!.state, 'complete');
    assert.equal(fs.existsSync(f.objectPath), false);
    f.recover();
    assert.deepEqual(listDurablePruneReceipts(f.store, workflowId), [receipt]);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(f.store, { recursive: true, force: true });
  }
});

test('prepared prune with neither exact catalog digest refuses before deleting evidence', (t) => {
  const f = fixture();
  try {
    const original = fs.renameSync;
    const mock = t.mock.method(
      fs,
      'renameSync',
      (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]) === durableStatePath(f.paths, workflowId))
          throw new Error('interrupted');
        return original(...args);
      },
    );
    assert.throws(f.prune);
    mock.mock.restore();
    const [receipt] = listDurablePruneReceipts(f.store, workflowId);
    receipt!.catalogDigestBefore = digest('different before');
    receipt!.catalogDigestAfter = digest('different after');
    const directory = fs.readdirSync(f.paths.pruneReceipts)[0]!;
    fs.writeFileSync(
      path.join(f.paths.pruneReceipts, directory, `${receipt!.receiptId}.json`),
      canonicalDurablePruneReceipt(receipt!),
      { mode: 0o600 },
    );
    assert.throws(f.recover, { code: 'EXECUTION_GOVERNANCE_STORE_UNSAFE' });
    assert.equal(fs.readFileSync(f.objectPath, 'utf8'), f.content);
    assert.equal(
      listDurablePruneReceipts(f.store, workflowId)[0]!.state,
      'prepared',
    );
  } finally {
    t.mock.restoreAll();
    fs.rmSync(f.store, { recursive: true, force: true });
  }
});

for (const kind of ['workflow', 'grant'] as const) {
  test(`${kind} lock preserves operation error identity when release also fails`, (t) => {
    const store = fs.mkdtempSync(
      path.join(os.tmpdir(), 'execution-governance-lock-'),
    );
    const paths = ensureDurableGovernanceStore(store);
    const operationError = new Error('operation failed');
    const releaseError = new Error('release failed');
    const operation = () => {
      t.mock.method(fs, 'unlinkSync', () => {
        throw releaseError;
      });
      throw operationError;
    };
    try {
      assert.throws(
        () =>
          kind === 'workflow'
            ? withDurableGovernanceLock(paths, workflowId, operation)
            : withExecutionGrantLock(
                paths,
                '22222222-2222-4222-8222-222222222222',
                operation,
              ),
        (error) => error === operationError,
      );
      t.mock.restoreAll();
      assert.equal(fs.readdirSync(paths.locks).length, 1);
    } finally {
      t.mock.restoreAll();
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
}
