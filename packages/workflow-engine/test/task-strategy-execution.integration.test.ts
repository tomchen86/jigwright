import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
import test from 'node:test';
import { startSession } from '../src/application/execute-task/session.ts';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { finalizeTask } from './support/local-engine-selection-host.ts';
import {
  inspectTaskStrategyTransaction,
  sealTaskStrategyRed,
} from '../src/application/execute-task/task-strategy-execution.ts';
import { checkSession } from './support/local-engine-selection-host.ts';
import { runtimeRoot, sourceRepositoryRoot, git } from './fixture.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { importTaskStrategyPatch } from '../src/application/execute-task/task-strategy-patch.ts';
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
      productionChangeRoutingAdmissionReader,
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

    const sealed = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
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
      sealTaskStrategyRed(
        productionChangeRoutingAdmissionReader,
        repository,
        session.sessionId,
        {
          explicitActor: 'codex',
          environment: {},
        },
      ),
      sealed,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    fs.writeFileSync(testPath, "throw new Error('silently weakened test');\n");
    assert.throws(
      () =>
        sealTaskStrategyRed(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            explicitActor: 'codex',
            environment: {},
          },
        ),
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
          productionChangeRoutingAdmissionReader,
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
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, 'export {};\n');

    assert.throws(
      () =>
        sealTaskStrategyRed(
          productionChangeRoutingAdmissionReader,
          repository,
          session.sessionId,
          {
            explicitActor: 'codex',
            environment: {},
          },
        ),
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
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const transaction = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
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
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
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
          productionChangeRoutingAdmissionReader,
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
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const transaction = sealTaskStrategyRed(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
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
    importTaskStrategyPatch(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      {
        patch,
        explicitActor: 'codex',
        environment: {},
      },
    );

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
