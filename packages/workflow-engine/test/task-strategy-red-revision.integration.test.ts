import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import test from 'node:test';
import { startSession } from '../src/application/execute-task/session.ts';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  inspectTaskStrategyTransaction,
  sealTaskStrategyRed,
} from '../src/application/execute-task/task-strategy-execution.ts';
import {
  adoptCurrentTaskStrategyImplementation,
  adoptCurrentTaskStrategyCorrection,
} from '../src/application/execute-task/task-strategy-patch.ts';
import { beginTaskStrategyRedRevision } from '../src/composition-root/task-strategy-red-revision-production.ts';
import { parseTaskStrategyRedRevisionRequest } from '../src/runtime/storage-journal/task-strategy-red-revision-store.ts';
import { checkSession } from './support/local-engine-selection-host.ts';
import {
  createCrossAgentFixture,
  runWorkflowCli,
  redRevisionInput,
  hasCode,
} from './support/task-strategy-execution-fixture.ts';

test('routine resume revises an in-scope sealed RED without a planning revision', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
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
      "throw new Error('first incorrect expectation');\n",
    );
    const sealed = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(sealed.status, 0, sealed.stderr);
    const predecessor = inspectTaskStrategyTransaction(
      repository,
      session.sessionId,
    )!;

    const opened = runWorkflowCli(
      repository,
      [
        'resume',
        session.sessionId,
        '--input',
        redRevisionInput({
          sessionId: session.sessionId,
          expectedTransactionDigest: predecessor.recordDigest,
          reason: 'Correct the sealed behavioral expectation',
        }),
        '--json',
      ],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(
      (JSON.parse(opened.stdout) as { result: { state: string } }).result.state,
      'red-authoring',
    );
    assert.equal(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      null,
    );

    fs.writeFileSync(
      testPath,
      "throw new Error('corrected behavioral expectation');\n",
    );
    const resealed = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(resealed.status, 0, resealed.stderr);
    const successor = inspectTaskStrategyTransaction(
      repository,
      session.sessionId,
    )!;
    assert.notEqual(successor.recordDigest, predecessor.recordDigest);
    assert.notEqual(successor.red.candidateTree, predecessor.red.candidateTree);
    assert.notEqual(
      successor.red.evidenceNodeId,
      predecessor.red.evidenceNodeId,
    );
    assert.equal(successor.taskContractDigest, predecessor.taskContractDigest);
    assert.equal(successor.author.providerId, 'codex');
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
    assert.equal(
      (JSON.parse(resealed.stdout) as { result: { state: string } }).result
        .state,
      'implementation-required',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary resume discovers every RED revision crash before current-ref publication', () => {
  const cuts = [
    'journal-persisted',
    'worktree-restored',
    'restoration-recorded',
  ] as const;
  for (const cut of cuts) {
    const { repository } = createCrossAgentFixture(
      'assertion',
      'tdd-single-agent',
    );
    try {
      const session = startSession(
        productionChangeContract,
        repository,
        'demo-change',
        '1.1',
      );
      const testPath = path.join(repository, 'test/feature.test.mjs');
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
      const predecessor = sealTaskStrategyRed(
        productionChangeContract,
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
      assert.ok(
        adoptCurrentTaskStrategyImplementation(
          productionChangeContract,
          repository,
          session.sessionId,
        ),
      );
      const request = {
        schemaVersion: 1 as const,
        kind: 'task-strategy-red-revision-request' as const,
        sessionId: session.sessionId,
        expectedTransactionDigest: predecessor.recordDigest,
        reason: `Recover the ${cut} crash cut`,
      };
      const crash = () => {
        throw new Error(cut);
      };
      assert.throws(
        () =>
          beginTaskStrategyRedRevision(repository, request, {
            ...(cut === 'journal-persisted'
              ? { testAfterJournalPersist: crash }
              : cut === 'worktree-restored'
                ? { testAfterWorktreeRestore: crash }
                : { testAfterRestorationRecorded: crash }),
          }),
        new RegExp(cut),
      );

      assert.throws(
        () =>
          beginTaskStrategyRedRevision(repository, {
            ...request,
            reason: `Conflicting ${cut} fork`,
          }),
        hasCode('TASK_STRATEGY_RED_REVISION_ACTIVE'),
      );
      const recovered = runWorkflowCli(
        repository,
        ['resume', session.sessionId, '--json'],
        { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
      );
      assert.notEqual(recovered.status, 0);
      assert.match(recovered.stderr, /TASK_STRATEGY_RED_REVISION_NO_CHANGE/);
      assert.equal(fs.existsSync(implementationPath), false);
      assert.equal(
        inspectTaskStrategyTransaction(repository, session.sessionId),
        null,
      );

      fs.writeFileSync(testPath, "throw new Error('corrected expectation');\n");
      const resealed = runWorkflowCli(
        repository,
        ['resume', session.sessionId, '--json'],
        { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
      );
      assert.equal(resealed.status, 0, resealed.stderr);
      assert.notEqual(
        inspectTaskStrategyTransaction(repository, session.sessionId)
          ?.recordDigest,
        predecessor.recordDigest,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('a rejected RED revision preflight cannot poison the next exact request', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    const predecessor = sealTaskStrategyRed(
      productionChangeContract,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );

    assert.throws(
      () =>
        beginTaskStrategyRedRevision(
          repository,
          parseTaskStrategyRedRevisionRequest({
            schemaVersion: 1,
            kind: 'task-strategy-red-revision-request',
            sessionId: session.sessionId,
            expectedTransactionDigest: '0'.repeat(64),
            reason: 'Reject the stale predecessor without publishing authority',
          }),
        ),
      hasCode('TASK_STRATEGY_RED_REVISION_STALE'),
    );

    const opened = beginTaskStrategyRedRevision(
      repository,
      parseTaskStrategyRedRevisionRequest({
        schemaVersion: 1,
        kind: 'task-strategy-red-revision-request',
        sessionId: session.sessionId,
        expectedTransactionDigest: predecessor.recordDigest,
        reason: 'Open the exact current RED revision',
      }),
    );
    assert.equal(opened.phase, 'session-evidence-cleared');
    assert.equal(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('RED revision removes only the exact imported implementation and never accepts a no-op reseal', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    sealTaskStrategyRed(
      productionChangeContract,
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
    assert.ok(
      adoptCurrentTaskStrategyImplementation(
        productionChangeContract,
        repository,
        session.sessionId,
      ),
    );
    const predecessor = inspectTaskStrategyTransaction(
      repository,
      session.sessionId,
    )!;

    const opened = runWorkflowCli(
      repository,
      [
        'resume',
        session.sessionId,
        '--input',
        redRevisionInput({
          sessionId: session.sessionId,
          expectedTransactionDigest: predecessor.recordDigest,
          reason: 'The sealed test is wrong',
        }),
        '--json',
      ],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(fs.existsSync(implementationPath), false);
    assert.equal(
      fs.readFileSync(testPath, 'utf8'),
      "throw new Error('sealed expectation');\n",
    );

    const noOp = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.notEqual(noOp.status, 0);
    assert.match(noOp.stderr, /TASK_STRATEGY_RED_REVISION_NO_CHANGE/);
    assert.equal(fs.existsSync(implementationPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('RED revision preserves out-of-scope bytes while refusing to reseal them', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    sealTaskStrategyRed(
      productionChangeContract,
      repository,
      session.sessionId,
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const predecessor = inspectTaskStrategyTransaction(
      repository,
      session.sessionId,
    )!;
    const opened = runWorkflowCli(
      repository,
      [
        'resume',
        session.sessionId,
        '--input',
        redRevisionInput({
          sessionId: session.sessionId,
          expectedTransactionDigest: predecessor.recordDigest,
          reason: 'Correct the test without changing scope',
        }),
        '--json',
      ],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(opened.status, 0, opened.stderr);
    fs.writeFileSync(testPath, "throw new Error('corrected expectation');\n");
    const escapedPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(escapedPath), { recursive: true });
    fs.writeFileSync(escapedPath, 'export const escaped = true;\n');

    const refused = runWorkflowCli(
      repository,
      ['resume', session.sessionId, '--json'],
      { AGENT: 'codex', WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /TASK_STRATEGY_RED_SCOPE_INVALID/);
    assert.equal(
      fs.readFileSync(escapedPath, 'utf8'),
      'export const escaped = true;\n',
    );
    assert.equal(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('RED revision restores every authenticated correction head in reverse order', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'tdd-single-agent',
    { codex: true, claude: true },
    false,
    true,
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, "throw new Error('sealed expectation');\n");
    const predecessor = sealTaskStrategyRed(
      productionChangeContract,
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
    assert.ok(
      adoptCurrentTaskStrategyImplementation(
        productionChangeContract,
        repository,
        session.sessionId,
      ),
    );
    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          { environment: {} },
        ),
      hasCode('CHECK_FAILED'),
    );
    fs.writeFileSync(implementationPath, 'export const corrected = true;\n');
    assert.ok(
      adoptCurrentTaskStrategyCorrection(
        productionChangeContract,
        repository,
        session.sessionId,
      ),
    );

    const opened = beginTaskStrategyRedRevision(repository, {
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: session.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'Correct the RED after one authenticated correction round',
    });
    assert.equal(opened.phase, 'session-evidence-cleared');
    assert.equal(fs.existsSync(implementationPath), false);
    assert.equal(
      inspectTaskStrategyTransaction(repository, session.sessionId),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
