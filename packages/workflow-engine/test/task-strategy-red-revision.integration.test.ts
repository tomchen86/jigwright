import { productionTaskStrategyCorrection } from '../src/composition-root/task-strategy-correction-production.ts';
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
} from '../src/composition-root/task-strategy-execution-production.ts';
import {
  adoptCurrentTaskStrategyImplementation,
  adoptCurrentTaskStrategyCorrection,
} from '../src/composition-root/task-strategy-patch-production.ts';
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
      const predecessor = sealTaskStrategyRed(repository, session.sessionId, {
        explicitActor: 'codex',
        environment: {},
      });
      const implementationPath = path.join(repository, 'src/feature.ts');
      fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
      fs.writeFileSync(implementationPath, 'export const feature = true;\n');
      assert.ok(
        adoptCurrentTaskStrategyImplementation(repository, session.sessionId),
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
    const predecessor = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });

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
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    assert.ok(
      adoptCurrentTaskStrategyImplementation(repository, session.sessionId),
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
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
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
    const predecessor = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    assert.ok(
      adoptCurrentTaskStrategyImplementation(repository, session.sessionId),
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
      adoptCurrentTaskStrategyCorrection(repository, session.sessionId),
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

import { taskStrategyRedRevisionOperations } from '../src/composition-root/task-strategy-red-revision-production.ts';
import { createTaskStrategyRedRevisionService } from '../src/application/execute-task/task-strategy-red-revision.ts';
import type { TaskStrategyRedRevisionOperations } from '../src/application/execute-task/task-strategy-red-revision-operations.ts';
import { assertCurrentImplementationReconciliation } from '../src/composition-root/implementation-reconciliation-production.ts';
import { observeInvestigationRuntimeContext } from '../src/runtime/repository-observation/investigation-runtime-context.ts';
import {
  readSessionFile,
  writeJsonAtomic,
} from '../src/runtime/session-workspace/session-store.ts';
import {
  readTaskStrategyRedRevisionJournal,
  readTaskStrategyCurrentRef,
  taskStrategyRedRevisionId,
  readActiveTaskStrategyRedRevision,
} from '../src/runtime/storage-journal/task-strategy-red-revision-store.ts';
import { readTaskStrategyTransactionByDigest } from '../src/runtime/storage-journal/task-strategy-store.ts';
import { readEvidenceNode } from '../src/runtime/storage-journal/evidence-object-store.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';

// Every decorator invokes its actual producer, then throws. Each replaced
// nested object is cloned; the exported production singleton is never mutated.
function crashAfter(
  effect: string,
  crash: Error,
): TaskStrategyRedRevisionOperations {
  const base = taskStrategyRedRevisionOperations;
  const after = <T>(name: string, value: T): T => {
    if (name === effect) throw crash;
    return value;
  };
  return {
    ...base,
    prepareSuccessor: (...args) =>
      after('prepare', base.prepareSuccessor(...args)),
    observeJournal(cwd) {
      const j = base.observeJournal(cwd);
      return {
        ...j,
        revision: {
          ...j.revision,
          persistRequest: (r) => after('request', j.revision.persistRequest(r)),
          create: (s) => after('prepared', j.revision.create(s)),
          update: (input) => after(input.next.phase, j.revision.update(input)),
        },
        currentRef: {
          ...j.currentRef,
          compareAndSwap: (input) =>
            after(input.next.state, j.currentRef.compareAndSwap(input)),
        },
        session: {
          ...j.session,
          write: (id, value) =>
            after('session-write', j.session.write(id, value)),
        },
        evidence: {
          ...j.evidence,
          write: (node) => after('evidence', j.evidence.write(node)),
        },
        transaction: {
          ...j.transaction,
          persist: (tx) => after('transaction', j.transaction.persist(tx)),
        },
      };
    },
  };
}
const durableCuts = [
  ['C01', 'request', 'begin', null],
  ['C05', 'red-authoring', 'begin', 'implementation-restored'],
  ['C06', 'current-authoring', 'begin', 'current-authoring'],
  ['C07', 'session-write', 'begin', 'current-authoring'],
  ['C08', 'session-evidence-cleared', 'begin', 'session-evidence-cleared'],
  ['C09', 'prepare', 'continue', 'session-evidence-cleared'],
  ['C10', 'reseal-prepared', 'continue', 'reseal-prepared'],
  ['C11', 'evidence', 'continue', 'reseal-prepared'],
  ['C12', 'transaction', 'continue', 'reseal-prepared'],
  ['C13', 'successor-persisted', 'continue', 'successor-persisted'],
  ['C14', 'red-sealed', 'continue', 'successor-persisted'],
  ['C15', 'current-sealed', 'continue', 'current-sealed'],
  ['C16', 'completed', 'continue', 'completed'],
] as const;
for (const [id, effect, operation, phase] of durableCuts)
  test(`durable RED ${id} resumes ordinary CLI after real ${effect} publication throws`, () => {
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
      fs.writeFileSync(testPath, "throw new Error('original expectation');\n");
      const predecessor = sealTaskStrategyRed(repository, session.sessionId, {
        explicitActor: 'codex',
        environment: {},
      });
      const context = observeInvestigationRuntimeContext(repository);
      const sessionPath = path.join(
        context.lifecycleRuntime.sessions,
        `${session.sessionId}.json`,
      );
      // Real session producer admits these full bytes. The evidence-engine field
      // makes before/after snapshots distinct; no fake journal phase is installed.
      writeJsonAtomic(sessionPath, {
        ...readSessionFile(sessionPath),
        checkEvidenceEngineDigest: `sha256:${'a'.repeat(64)}`,
      });
      const before = readSessionFile(sessionPath);
      const request = {
        schemaVersion: 1 as const,
        kind: 'task-strategy-red-revision-request' as const,
        sessionId: session.sessionId,
        expectedTransactionDigest: predecessor.recordDigest,
        reason: `Recover actual ${id} durable cut`,
      };
      if (operation === 'continue') {
        beginTaskStrategyRedRevision(repository, request);
        fs.writeFileSync(
          testPath,
          "throw new Error('corrected expectation');\n",
        );
      }
      const failure = new Error(`crash ${id}`);
      const decorated = crashAfter(effect, failure);
      const svc = createTaskStrategyRedRevisionService(
        decorated,
        assertCurrentImplementationReconciliation,
      );
      assert.notEqual(decorated, taskStrategyRedRevisionOperations);
      assert.throws(
        () =>
          operation === 'begin'
            ? svc.beginTaskStrategyRedRevision(repository, request)
            : svc.continueTaskStrategyRedRevision(
                repository,
                session.sessionId,
                {},
              ),
        (e) => e === failure,
      );
      const revisionId = taskStrategyRedRevisionId(request);
      const paused = readTaskStrategyRedRevisionJournal(
        context.runtime,
        session.sessionId,
        revisionId,
      );
      assert.equal(paused?.phase ?? null, phase);
      assert.equal(
        readSessionFile(sessionPath).checkEvidenceEngineDigest,
        operation === 'continue' || id === 'C07' || id === 'C08'
          ? undefined
          : before.checkEvidenceEngineDigest,
      );
      const pinned = paused?.successorTransaction ?? null;
      const ref = readTaskStrategyCurrentRef(
        context.runtime,
        session.sessionId,
      )!;
      assert.equal(
        ref.state,
        ['C14', 'C15', 'C16'].includes(id)
          ? 'red-sealed'
          : id === 'C01'
            ? 'red-sealed'
            : 'red-authoring',
      );
      assert.equal(
        inspectTaskStrategyTransaction(repository, session.sessionId)
          ?.recordDigest ?? null,
        ['C14', 'C15', 'C16'].includes(id)
          ? pinned!.recordDigest
          : id === 'C01'
            ? predecessor.recordDigest
            : null,
      );
      assert.deepEqual(
        readTaskStrategyTransactionByDigest(
          context.runtime,
          session.sessionId,
          predecessor.recordDigest,
        ),
        predecessor,
      );
      if (['C11', 'C12', 'C13', 'C14', 'C15', 'C16'].includes(id))
        assert.deepEqual(
          readEvidenceNode(context.runtime, pinned!.red.evidenceNodeId),
          pinned!.red.evidenceNode,
        );
      if (['C12', 'C13', 'C14', 'C15', 'C16'].includes(id))
        assert.deepEqual(
          readTaskStrategyTransactionByDigest(
            context.runtime,
            session.sessionId,
            pinned!.recordDigest,
          ),
          pinned,
        );
      else if (pinned)
        assert.equal(
          readTaskStrategyTransactionByDigest(
            context.runtime,
            session.sessionId,
            pinned.recordDigest,
          ),
          null,
        );
      assert.equal(
        fs.readFileSync(counterPath, 'utf8'),
        operation === 'begin' ? '1' : '2',
      );
      const resume = () =>
        runWorkflowCli(repository, ['resume', session.sessionId, '--json'], {
          AGENT: 'codex',
          WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
        });
      if (operation === 'begin') {
        const opening = resume();
        assert.notEqual(opening.status, 0);
        assert.match(opening.stderr, /TASK_STRATEGY_RED_REVISION_NO_CHANGE/);
        assert.equal(
          readTaskStrategyRedRevisionJournal(
            context.runtime,
            session.sessionId,
            revisionId,
          )!.phase,
          'session-evidence-cleared',
        );
        assert.equal(
          inspectTaskStrategyTransaction(repository, session.sessionId),
          null,
        );
        fs.writeFileSync(
          testPath,
          "throw new Error('corrected expectation');\n",
        );
      }
      const recovered = resume();
      assert.equal(recovered.status, 0, recovered.stderr);
      const completed = readTaskStrategyRedRevisionJournal(
        context.runtime,
        session.sessionId,
        revisionId,
      )!;
      assert.equal(completed.phase, 'completed');
      assert.equal(
        readActiveTaskStrategyRedRevision(context.runtime, session.sessionId),
        null,
      );
      const successor = inspectTaskStrategyTransaction(
        repository,
        session.sessionId,
      )!;
      assert.equal(
        successor.recordDigest,
        completed.successorTransaction!.recordDigest,
      );
      assert.notEqual(successor.recordDigest, predecessor.recordDigest);
      assert.notEqual(
        successor.red.candidateTree,
        predecessor.red.candidateTree,
      );
      assert.equal(
        canonicalJson(readSessionFile(sessionPath)),
        canonicalJson(completed.sessionTransition.after),
      );
      assert.notEqual(
        canonicalJson(completed.sessionTransition.before),
        canonicalJson(completed.sessionTransition.after),
      );
      assert.deepEqual(
        readTaskStrategyCurrentRef(context.runtime, session.sessionId),
        completed.successorRef,
      );
      if (pinned) {
        assert.equal(canonicalJson(successor), canonicalJson(pinned));
        assert.equal(successor.createdAt, pinned.createdAt);
      }
      assert.equal(
        fs.readFileSync(counterPath, 'utf8'),
        operation === 'begin' || id === 'C09' ? '3' : '2',
        'RED may rerun before successor pinning, never after pinning',
      );
      if (id === 'C07')
        assert.equal(
          readSessionFile(sessionPath).checkEvidenceEngineDigest,
          undefined,
        );
      assert.equal(
        beginTaskStrategyRedRevision(repository, request).phase,
        'completed',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
