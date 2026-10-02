import os from 'node:os';
import { readFrozenFiles } from '../src/runtime/repository-observation/task-strategy-red-files.ts';
import { createTaskStrategyExecutionService } from '../src/application/execute-task/task-strategy-execution.ts';
import { taskStrategyExecutionOperations } from '../src/composition-root/task-strategy-execution-production.ts';
import { observeInvestigationRuntimeContext } from '../src/runtime/repository-observation/investigation-runtime-context.ts';
import { readEvidenceNode } from '../src/runtime/storage-journal/evidence-object-store.ts';
import { readTaskStrategyCurrentRef } from '../src/runtime/storage-journal/task-strategy-current-ref.ts';
import {
  canonicalEvidenceNodeEnvelope,
  type EvidenceNode,
} from '../src/foundation/evidence-node/evidence-node.ts';
import { productionTaskStrategyCorrection } from '../src/composition-root/task-strategy-correction-production.ts';
import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import test from 'node:test';
import { startSession } from '../src/application/execute-task/session.ts';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { finalizeTask } from './support/local-engine-selection-host.ts';
import {
  inspectTaskStrategyTransaction,
  sealTaskStrategyRed,
} from '../src/composition-root/task-strategy-execution-production.ts';
import { checkSession } from './support/local-engine-selection-host.ts';
import { runtimeRoot, sourceRepositoryRoot, git } from './fixture.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { importTaskStrategyPatch } from '../src/composition-root/task-strategy-patch-production.ts';
import { beginTaskDiffReview } from '../src/composition-root/task-diff-review-production.ts';
import {
  createCrossAgentFixture,
  hasCode,
  diffAgainstTree,
} from './support/task-strategy-execution-fixture.ts';

test('cross-agent TDD cannot enter finalize checks without an engine-sealed RED', () => {
  const { repository, counterPath } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const implementedWithoutRed = true;\n',
    );

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_STRATEGY_RED_REQUIRED'),
    );
    assert.equal(fs.existsSync(counterPath), false);
    assert.equal(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('seal RED runs the pinned check, freezes exact test bytes, and replays one immutable transaction state', () => {
  const { repository, counterPath } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeContract,
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

    const sealed = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(sealed.phase, 'red-sealed');
    assert.equal(sealed.strategy, 'cross-agent-tdd');
    assert.equal(sealed.red.checkId, 'red');
    assert.equal(sealed.red.failureCategory, 'assertion');
    assert.deepEqual(sealed.red.testPaths, ['test/feature.test.mjs']);
    assert.deepEqual(sealed.red.fixturePaths, []);
    assert.deepEqual(
      sealed.red.files.map(({ path: relativePath }) => relativePath),
      ['test/feature.test.mjs'],
    );
    assert.match(sealed.red.failureFingerprint, /^[0-9a-f]{64}$/);
    assert.match(sealed.red.evidenceNodeId, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    assert.deepEqual(
      sealTaskStrategyRed(repository, session.sessionId, {
        explicitActor: 'codex',
        environment: {},
      }),
      sealed,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    fs.writeFileSync(testPath, "throw new Error('silently weakened test');\n");
    assert.throws(
      () =>
        sealTaskStrategyRed(repository, session.sessionId, {
          explicitActor: 'codex',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_RED_STALE'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          {
            environment: { AGENT: 'claude' },
          },
        ),
      hasCode('TASK_STRATEGY_RED_STALE'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('seal RED rejects an unrelated or structurally invalid failure category', () => {
  const { repository, counterPath } = createCrossAgentFixture('syntax');
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, 'export {};\n');

    assert.throws(
      () =>
        sealTaskStrategyRed(repository, session.sessionId, {
          explicitActor: 'codex',
          environment: {},
        }),
      hasCode('TASK_STRATEGY_RED_FAILURE_INVALID'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sealed RED state is canonical and digest-bound before any gate trusts it', () => {
  const { repository } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const transaction = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const statePath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategy-transactions',
      session.sessionId,
      `${transaction.recordDigest}.json`,
    );
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      red: { failureCategory: string };
    };
    state.red.failureCategory = 'behavior-mismatch';
    fs.writeFileSync(statePath, `${canonicalJson(state)}\n`);

    assert.throws(
      () => inspectTaskStrategyTransaction(repository, session.sessionId),
      hasCode('TASK_STRATEGY_STATE_CORRUPT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('cross-agent TDD rejects manual implementation bytes without an engine-imported patch receipt', () => {
  const { repository, counterPath } = createCrossAgentFixture('assertion');
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );

    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          {
            environment: { AGENT: 'claude' },
          },
        ),
      hasCode('TASK_STRATEGY_PATCH_REQUIRED'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('single-agent TDD keeps the RED gate and uses a fresh Reviewer session', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
    { codex: true, claude: true },
    true,
  );
  try {
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/path-roles.json'),
      path.join(repository, 'workflow/path-roles.json'),
    );
    git(repository, ['add', 'workflow/path-roles.json']);
    git(repository, ['commit', '-m', 'Configure fixture path roles']);
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const transaction = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(transaction.strategy, 'tdd-single-agent');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    const patch = diffAgainstTree(repository, transaction.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(path.join(repository, 'src/feature.ts'));
    importTaskStrategyPatch(repository, session.sessionId, {
      patch,
      explicitActor: 'codex',
      environment: {},
    });

    assert.throws(
      () =>
        finalizeTask(
          repository,
          session.sessionId,
          { AGENT: 'codex' },
          {
            testCrashAfter: 'checked',
          },
        ),
      /Simulated finalize interruption/,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
    const review = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'claude',
      environment: {},
    });
    assert.equal(review.state, 'waiting-for-provider');
    if (review.state !== 'waiting-for-provider') return;
    assert.equal(review.implementationActor.providerId, 'codex');
    assert.equal(review.assignment.providerId, 'codex');
    assert.equal(review.assignment.requiredIndependence, 'session-independent');
    assert.equal(review.assignment.achievedIndependence, 'session-independent');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const scenario of [
  'evidence-later-clock',
  'evidence-same-clock',
  'transaction-return',
] as const) {
  test(`initial RED publication characterization: ${scenario}`, (t) => {
    const { repository, counterPath } = createCrossAgentFixture('assertion');
    try {
      const session = startSession(
        productionChangeContract,
        repository,
        'demo-change',
        '1.1',
      );
      fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
      fs.writeFileSync(
        path.join(repository, 'test/feature.test.mjs'),
        "throw new Error('unchanged deterministic RED');\n",
      );
      const paths = observeInvestigationRuntimeContext(repository).runtime;
      const base = taskStrategyExecutionOperations;
      const nodes: EvidenceNode[] = [];
      const evidenceReads: EvidenceNode[] = [];
      const publishedEvidence: EvidenceNode[] = [];
      const effects: string[] = [];
      const sentinel = new Error(`after real ${scenario} producer returned`);
      const t0 = new Date().toISOString();
      const t1 = new Date(Date.parse(t0) + 60_000).toISOString();
      let now = t0;
      let clockCalls = 0;
      let interrupted = false;
      const service = createTaskStrategyExecutionService({
        ...base,
        clock: {
          now: () => {
            clockCalls++;
            return new Date(now);
          },
        },
        observeJournal(cwd) {
          const journal = base.observeJournal(cwd);
          return {
            ...journal,
            evidence: {
              read(nodeId) {
                const stored = journal.evidence.read(nodeId);
                evidenceReads.push(stored);
                return stored;
              },
              write(node) {
                nodes.push(node);
                journal.evidence.write(node);
                effects.push('evidence-returned');
                if (!interrupted && scenario !== 'transaction-return') {
                  interrupted = true;
                  throw sentinel;
                }
              },
            },
            transaction: {
              ...journal.transaction,
              create(input) {
                publishedEvidence.push(input.red.evidenceNode);
                effects.push('transaction-entered');
                const stored = journal.transaction.create(input);
                effects.push('transaction-returned');
                if (!interrupted && scenario === 'transaction-return') {
                  interrupted = true;
                  throw sentinel;
                }
                return stored;
              },
            },
          };
        },
      });
      const seal = () =>
        service.sealTaskStrategyRed(repository, session.sessionId, {
          explicitActor: 'codex',
          environment: {},
        });
      assert.throws(seal, (error) => error === sentinel);
      assert.equal(nodes.length, 1);
      const first = nodes[0]!;
      const objectPath = path.join(
        paths.objects,
        first.nodeId.slice(0, 2),
        `${first.nodeId}.json`,
      );
      const bytesBefore = fs.readFileSync(objectPath);
      const objectStat = () => {
        const stat = fs.statSync(objectPath, { bigint: true });
        return { inode: stat.ino.toString(), mtimeNs: stat.mtimeNs.toString() };
      };
      const statBefore = objectStat();
      assert.deepEqual(readEvidenceNode(paths, first.nodeId), first);
      assert.equal(
        bytesBefore.toString('utf8'),
        canonicalEvidenceNodeEnvelope(first),
      );
      const before = {
        currentRef: readTaskStrategyCurrentRef(paths, session.sessionId),
        transaction: service.inspectTaskStrategyTransaction(
          repository,
          session.sessionId,
        ),
      };
      assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
      assert.equal(clockCalls, 1);
      assert.deepEqual(evidenceReads, []);
      if (scenario === 'transaction-return') {
        assert.ok(before.currentRef);
        assert.ok(before.transaction);
        assert.deepEqual(effects, [
          'evidence-returned',
          'transaction-entered',
          'transaction-returned',
        ]);
      } else {
        assert.equal(before.currentRef, null);
        assert.equal(before.transaction, null);
        assert.equal(
          fs.existsSync(
            path.join(
              paths.refs,
              'task-strategy-transactions',
              session.sessionId,
            ),
          ),
          false,
        );
        assert.deepEqual(effects, ['evidence-returned']);
      }
      now = scenario === 'evidence-same-clock' ? t0 : t1;
      let retryError: unknown;
      let recovered;
      try {
        recovered = seal();
      } catch (error) {
        retryError = error;
      }
      const after = {
        currentRef: readTaskStrategyCurrentRef(paths, session.sessionId),
        transaction: service.inspectTaskStrategyTransaction(
          repository,
          session.sessionId,
        ),
      };
      assert.deepEqual(fs.readFileSync(objectPath), bytesBefore);
      assert.deepEqual(objectStat(), statBefore);
      if (scenario !== 'transaction-return') {
        assert.equal(nodes.length, 2);
        assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
        assert.equal(clockCalls, 2);
        const second = nodes[1]!;
        assert.equal(second.nodeId, first.nodeId);
        assert.equal(second.resultDigest, first.resultDigest);
        assert.deepEqual(second.exactInputDigests, first.exactInputDigests);
        assert.deepEqual(second.output, first.output);
        assert.deepEqual(
          { ...second, runtimeMetadata: first.runtimeMetadata },
          first,
        );
        assert.deepEqual(first.runtimeMetadata, { createdAt: t0 });
        assert.deepEqual(second.runtimeMetadata, { createdAt: now });
      } else {
        assert.equal(nodes.length, 1);
        assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
        assert.equal(clockCalls, 1);
        assert.deepEqual(after, before);
      }
      t.diagnostic(
        `RED_SEAL_PUBLICATION_EVIDENCE ${JSON.stringify({
          scenario,
          t0,
          t1,
          first,
          second: nodes[1] ?? null,
          effects,
          clockCalls,
          counter: fs.readFileSync(counterPath, 'utf8'),
          before,
          after,
          statBefore,
          statAfter: objectStat(),
          evidenceReadCount: evidenceReads.length,
          retryError:
            retryError instanceof Error
              ? {
                  ...retryError,
                  name: retryError.name,
                  message: retryError.message,
                }
              : (retryError ?? null),
        })}`,
      );
      // Keep the original RED diagnostics when the ordinary replay regresses.
      if (scenario === 'evidence-later-clock' && retryError !== undefined) {
        assert.equal(after.currentRef, null);
        assert.equal(after.transaction, null);
        assert.equal(effects.includes('transaction-entered'), false);
        assert.equal(
          fs.existsSync(
            path.join(
              paths.refs,
              'task-strategy-transactions',
              session.sessionId,
            ),
          ),
          false,
        );
      }
      assert.equal(
        retryError,
        undefined,
        'ordinary public seal must resume its exact interrupted initial publication',
      );
      assert.ok(recovered);
      assert.deepEqual(recovered, after.transaction);
      assert.ok(after.currentRef);
      const transactionTime = scenario === 'transaction-return' ? t0 : now;
      assert.equal(recovered.createdAt, transactionTime);
      assert.equal(after.currentRef.updatedAt, transactionTime);
      assert.equal(recovered.sessionId, session.sessionId);
      assert.equal(recovered.changeId, session.changeId);
      assert.equal(recovered.taskId, session.taskId);
      assert.deepEqual(recovered.baseline, session.baseline);
      assert.deepEqual(recovered.red.evidenceNode, first);
      assert.equal(
        evidenceReads.length,
        scenario === 'evidence-later-clock' ? 1 : 0,
      );
      if (scenario === 'evidence-later-clock') {
        assert.strictEqual(publishedEvidence[0], evidenceReads[0]);
        assert.notStrictEqual(publishedEvidence[0], nodes[1]);
      }
      const counts = [
        nodes.length,
        evidenceReads.length,
        clockCalls,
        effects.length,
      ];
      now = new Date(Date.parse(t1) + 60_000).toISOString();
      assert.deepEqual(seal(), recovered);
      assert.deepEqual(
        [nodes.length, evidenceReads.length, clockCalls, effects.length],
        counts,
      );
      assert.equal(
        fs.readFileSync(counterPath, 'utf8'),
        scenario === 'transaction-return' ? '1' : '2',
      );
      assert.deepEqual(fs.readFileSync(objectPath), bytesBefore);
      assert.deepEqual(objectStat(), statBefore);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

for (const objectFormat of ['sha1', 'sha256']) {
  test(`frozen RED files observe literal paths, executable modes, ordered duplicates and ${objectFormat} object IDs`, () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'red-files-'));
    try {
      git(repository, ['init', `--object-format=${objectFormat}`]);
      const regular = 'test [literal]*.ts';
      const executable = 'runner.sh';
      fs.writeFileSync(path.join(repository, regular), 'literal bytes\n');
      fs.writeFileSync(
        path.join(repository, executable),
        '#!/bin/sh\nexit 1\n',
      );
      fs.chmodSync(path.join(repository, executable), 0o755);
      fs.symlinkSync(executable, path.join(repository, 'symlink'));
      git(repository, ['add', '--all']);
      const tree = git(repository, ['write-tree']).trim();
      const files = readFrozenFiles(repository, tree, [
        executable,
        regular,
        executable,
      ]);
      const expected = [
        {
          path: executable,
          mode: '100755',
          objectId: git(repository, [
            'rev-parse',
            `${tree}:${executable}`,
          ]).trim(),
        },
        {
          path: regular,
          mode: '100644',
          objectId: git(repository, ['rev-parse', `${tree}:${regular}`]).trim(),
        },
      ];
      assert.deepEqual(files, [...expected, expected[0]]);
      assert.equal(
        files[0]!.objectId.length,
        objectFormat === 'sha1' ? 40 : 64,
      );
      for (const candidate of ['missing', 'symlink', 'test *.ts']) {
        assert.throws(() => readFrozenFiles(repository, tree, [candidate]), {
          code: 'TASK_STRATEGY_RED_FILE_INVALID',
          details: { path: candidate },
        });
      }
      assert.throws(
        () => readFrozenFiles(repository, 'missing-tree', [regular]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /missing-tree/);
          assert.notEqual(
            (error as Error & { code?: string }).code,
            'TASK_STRATEGY_RED_FILE_INVALID',
          );
          return true;
        },
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}
