import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
import test from 'node:test';
import { startSession } from '../src/application/execute-task/session.ts';
import path from 'node:path';
import fs from 'node:fs';
import {
  sealTaskStrategyRed,
  inspectTaskStrategyTransaction,
} from '../src/application/execute-task/task-strategy-execution.ts';
import assert from 'node:assert/strict';
import {
  validateTaskStrategyPatch,
  importTaskStrategyPatch,
} from '../src/application/execute-task/task-strategy-patch.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import {
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchImportReceipt,
} from '../src/runtime/storage-journal/task-strategy-patch-store.ts';
import { checkSession } from './support/local-engine-selection-host.ts';
import { runtimeRoot } from './fixture.ts';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createCrossAgentFixture,
  diffAgainstTree,
  hasCode,
  sha256Buffer,
} from './support/task-strategy-execution-fixture.ts';

test('cross-agent patch validation derives one bounded implementation tree without touching the task worktree', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    assert.throws(
      () =>
        validateTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch,
            explicitActor: 'codex',
            environment: {},
          },
        ),
      hasCode('TASK_STRATEGY_IMPLEMENTER_REQUIRED'),
    );
    const validation = validateTaskStrategyPatch(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        patch,
        explicitActor: 'claude',
        environment: {},
      },
    );
    assert.equal(validation.sourceTree, red.red.candidateTree);
    assert.notEqual(validation.candidateTree, validation.sourceTree);
    assert.deepEqual(validation.changedPaths, ['src/feature.ts']);
    assert.equal(validation.implementer.providerId, 'claude');
    assert.match(validation.patchDigest, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(implementationPath), false);
    assert.deepEqual(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      red,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('patch validation rejects frozen tests, path escape, and unsafe file modes from the derived tree', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    const originalTest =
      "throw new Error('feature behavior is not implemented');\n";
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, originalTest);
    const red = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );

    fs.writeFileSync(testPath, "throw new Error('weakened');\n");
    const frozenPatch = diffAgainstTree(repository, red.red.candidateTree, [
      'test/feature.test.mjs',
    ]);
    fs.writeFileSync(testPath, originalTest);
    assert.throws(
      () =>
        validateTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch: frozenPatch,
            explicitActor: 'claude',
            environment: {},
          },
        ),
      hasCode('TASK_STRATEGY_PATCH_FROZEN_PATH'),
    );

    const escapedPath = path.join(repository, 'docs/escape.md');
    fs.mkdirSync(path.dirname(escapedPath), { recursive: true });
    fs.writeFileSync(escapedPath, 'escape\n');
    const escapedPatch = diffAgainstTree(repository, red.red.candidateTree, [
      'docs/escape.md',
    ]);
    fs.rmSync(escapedPath);
    assert.throws(
      () =>
        validateTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch: escapedPatch,
            explicitActor: 'claude',
            environment: {},
          },
        ),
      hasCode('TASK_STRATEGY_PATCH_SCOPE_INVALID'),
    );

    const symlinkPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
    fs.symlinkSync('../test/feature.test.mjs', symlinkPath);
    const symlinkPatch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(symlinkPath);
    assert.throws(
      () =>
        validateTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch: symlinkPatch,
            explicitActor: 'claude',
            environment: {},
          },
        ),
      hasCode('TASK_STRATEGY_PATCH_MODE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent patch validation permits the RED author without weakening patch boundaries', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    const validation = validateTaskStrategyPatch(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        patch,
        explicitActor: 'codex',
        environment: {},
      },
    );
    assert.equal(validation.implementer.providerId, 'codex');
    assert.deepEqual(validation.changedPaths, ['src/feature.ts']);
    assert.equal(fs.existsSync(implementationPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent patch validation rejects an actor other than the sealed RED author', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    assert.throws(
      () =>
        validateTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch,
            explicitActor: 'claude',
            environment: {},
          },
        ),
      hasCode('TASK_STRATEGY_IMPLEMENTER_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('patch import persists authority before mutation and exact replay reaches engine GREEN once', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    const patchDigest = sha256Buffer(patch);

    assert.throws(
      () =>
        importTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch,
            explicitActor: 'codex',
            environment: {},
            testCrashAfter: 'reservation-persisted',
          },
        ),
      /reservation-persisted/,
    );
    assert.equal(fs.existsSync(implementationPath), false);
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    assert.equal(
      readTaskStrategyPatchRecord(
        runtime,
        session.sessionId,
        patchDigest,
        red.red.candidateTree,
      ),
      null,
    );
    assert.throws(
      () =>
        importTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch,
            explicitActor: 'codex',
            environment: {},
            testCrashAfter: 'record-persisted',
          },
        ),
      /record-persisted/,
    );
    const prepared = readTaskStrategyPatchRecord(
      runtime,
      session.sessionId,
      patchDigest,
      red.red.candidateTree,
    );
    assert.equal(prepared?.patchDigest, patchDigest);
    assert.equal(
      readTaskStrategyPatchImportReceipt(
        runtime,
        session.sessionId,
        patchDigest,
        red.red.candidateTree,
      ),
      null,
    );

    const imported = importTaskStrategyPatch(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        patch,
        explicitActor: 'codex',
        environment: {},
      },
    );
    assert.equal(imported.receipt.candidateTree, imported.record.candidateTree);
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    assert.deepEqual(
      importTaskStrategyPatch(
        productionChangeRoutingAdmissionReader,
        repository,
        session.sessionId,
        {
          patch,
          explicitActor: 'codex',
          environment: {},
        },
      ),
      imported,
    );

    const checked = checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        environment: {},
      },
    );
    assert.equal(checked.passed, true);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('patch-applied crash reconciles the exact candidate and later drift stales the receipt', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    assert.throws(
      () =>
        importTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch,
            explicitActor: 'codex',
            environment: {},
            testCrashAfter: 'patch-applied',
          },
        ),
      /patch-applied/,
    );
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    const recovered = importTaskStrategyPatch(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        patch,
        explicitActor: 'codex',
        environment: {},
      },
    );
    assert.notEqual(recovered.receipt, null);

    fs.writeFileSync(implementationPath, 'export const feature = false;\n');
    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          { environment: {} },
        ),
      hasCode('TASK_STRATEGY_PATCH_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a durable prepared patch reservation rejects a different patch before either can mutate the worktree', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patchA = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.writeFileSync(implementationPath, 'export const feature = 2;\n');
    const patchB = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    assert.throws(
      () =>
        importTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch: patchA,
            explicitActor: 'claude',
            environment: {},
            testCrashAfter: 'reservation-persisted',
          },
        ),
      /reservation-persisted/,
    );
    assert.throws(
      () =>
        importTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch: patchB,
            explicitActor: 'claude',
            environment: {},
          },
        ),
      hasCode('TASK_STRATEGY_PATCH_RESERVATION_CONFLICT'),
    );
    assert.equal(fs.existsSync(implementationPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('patch replay rejects independently redigested reservation metadata', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(
      testPath,
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    const imported = importTaskStrategyPatch(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        patch,
        explicitActor: 'claude',
        environment: {},
      },
    );
    const reservationPath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategy-patches',
      session.sessionId,
      'sources',
      imported.record.sourceTree,
      'reservation.json',
    );
    const reservation = JSON.parse(
      fs.readFileSync(reservationPath, 'utf8'),
    ) as Record<string, unknown>;
    reservation.createdAt = new Date(
      Date.parse(String(reservation.createdAt)) + 1_000,
    ).toISOString();
    const { reservationDigest: _oldDigest, ...body } = reservation;
    reservation.reservationDigest = createHash('sha256')
      .update(canonicalJson(body))
      .digest('hex');
    fs.writeFileSync(reservationPath, `${canonicalJson(reservation)}\n`);

    assert.throws(
      () =>
        importTaskStrategyPatch(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            patch,
            explicitActor: 'claude',
            environment: {},
          },
        ),
      hasCode('TASK_STRATEGY_PATCH_STATE_CORRUPT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
