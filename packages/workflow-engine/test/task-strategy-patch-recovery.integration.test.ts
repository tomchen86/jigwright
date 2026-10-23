import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { productionTaskStrategyCorrection } from '../src/composition-root/task-strategy-correction-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import {
  beginTaskStrategyRedRevision,
  taskStrategyRedRevisionOperations,
} from '../src/composition-root/task-strategy-red-revision-production.ts';
import { assertCurrentImplementationReconciliation } from '../src/composition-root/implementation-reconciliation-production.ts';
import { createTaskStrategyRedRevisionService } from '../src/application/execute-task/task-strategy-red-revision.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  inspectTaskStrategyTransaction,
  sealTaskStrategyRed,
} from '../src/composition-root/task-strategy-execution-production.ts';
import {
  adoptCurrentTaskStrategyImplementation,
  adoptCurrentTaskStrategyCorrection,
} from '../src/composition-root/task-strategy-patch-production.ts';
import { inspectSession } from '../src/application/session-inspection/session-inspection.ts';
import type { ImportedTaskStrategyPatch } from '../src/modules/assurance/task-strategy-patch-contract.ts';
import { observeInvestigationRuntimeContext } from '../src/runtime/repository-observation/investigation-runtime-context.ts';
import { previewExactStaging } from '../src/runtime/repository-transaction/git-transitions.ts';
import { listTaskStrategyCorrectionRounds } from '../src/runtime/storage-journal/task-strategy-correction-round-store.ts';
import {
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchReservation,
  readTaskStrategyPatchImportReceipt,
  readTaskStrategyPatchCurrentBinding,
} from '../src/runtime/storage-journal/task-strategy-patch-store.ts';
import {
  readTaskStrategyRedRevisionJournal,
  readTaskStrategyCurrentRef,
  readActiveTaskStrategyRedRevision,
  taskStrategyRedRevisionId,
} from '../src/runtime/storage-journal/task-strategy-red-revision-store.ts';
import { checkSession } from './support/session-lifecycle-host.ts';
import { sourceRepositoryRoot } from './fixture.ts';
import {
  createCrossAgentFixture,
  hasCode,
  runWorkflowCli,
  snapshotPersistentTree,
} from './support/task-strategy-execution-fixture.ts';

for (const layout of ['overlapping', 'disjoint'] as const) {
  test(`ordinary resume recovers fully reversed ${layout} implementation and correction patches`, (t) => {
    const { repository, counterPath } = createCrossAgentFixture(
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
      const redBytes = "throw new Error('sealed expectation');\n";
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, redBytes);
      const predecessor = sealTaskStrategyRed(repository, session.sessionId, {
        explicitActor: 'codex',
        environment: {},
      });
      const implementationPath = path.join(repository, 'src/feature.ts');
      const correctionRelativePath =
        layout === 'overlapping' ? 'src/feature.ts' : 'src/correction.ts';
      const correctionPath = path.join(repository, correctionRelativePath);
      fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
      fs.writeFileSync(implementationPath, 'export const feature = true;\n');
      const initial = adoptCurrentTaskStrategyImplementation(
        repository,
        session.sessionId,
      );
      assert.ok(initial);
      assert.deepEqual(initial.record.changedPaths, ['src/feature.ts']);
      assert.equal(initial.record.sourceTree, predecessor.red.candidateTree);
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
      fs.writeFileSync(correctionPath, 'export const corrected = true;\n');
      const correction = adoptCurrentTaskStrategyCorrection(
        repository,
        session.sessionId,
      );
      assert.ok(correction);
      assert.deepEqual(correction.record.changedPaths, [
        correctionRelativePath,
      ]);
      assert.equal(correction.record.sourceTree, initial.record.candidateTree);
      const context = observeInvestigationRuntimeContext(repository);
      const readPatch = (imported: ImportedTaskStrategyPatch) => {
        const { sourceTree, patchDigest } = imported.record;
        return {
          record: readTaskStrategyPatchRecord(
            context.runtime,
            session.sessionId,
            patchDigest,
            sourceTree,
          ),
          reservation: readTaskStrategyPatchReservation(
            context.runtime,
            session.sessionId,
            sourceTree,
          ),
          receipt: readTaskStrategyPatchImportReceipt(
            context.runtime,
            session.sessionId,
            patchDigest,
            sourceTree,
          ),
          binding: readTaskStrategyPatchCurrentBinding(
            context.runtime,
            session.sessionId,
            sourceTree,
          ),
        };
      };
      const readRounds = () =>
        listTaskStrategyCorrectionRounds(
          context.runtime,
          session.sessionId,
          predecessor.recordDigest,
        );
      assert.deepEqual(readPatch(initial), initial);
      assert.deepEqual(readPatch(correction), correction);
      const rounds = readRounds();
      assert.equal(rounds.length, 1);
      assert.equal(rounds[0]!.reservation.authority.kind, 'sealed-local');
      assert.equal(
        rounds[0]!.result?.patchResult.patchRecordDigest,
        correction.record.recordDigest,
      );
      assert.equal(
        rounds[0]!.importRecord?.currentPatchHead.recordDigest,
        correction.record.recordDigest,
      );
      const projection =
        productionTaskStrategyCorrection.resolveCurrentTaskStrategyCorrection(
          inspectSession(
            productionChangeContract,
            repository,
            session.sessionId,
          ),
        );
      assert.equal(projection.completedCorrectionRounds, 1);
      assert.equal(
        projection.head?.record.recordDigest,
        correction.record.recordDigest,
      );

      const request = {
        schemaVersion: 1 as const,
        kind: 'task-strategy-red-revision-request' as const,
        sessionId: session.sessionId,
        expectedTransactionDigest: predecessor.recordDigest,
        reason: `Recover fully restored ${layout} correction lineage`,
      };
      const revisionId = taskStrategyRedRevisionId(request);
      const observe = () => {
        const inspection = inspectSession(
          productionChangeContract,
          repository,
          session.sessionId,
        );
        return {
          candidate: previewExactStaging(
            repository,
            inspection.session.baseline.head,
            [...inspection.changedPaths],
          ),
          journal: readTaskStrategyRedRevisionJournal(
            context.runtime,
            session.sessionId,
            revisionId,
          ),
          currentRef: readTaskStrategyCurrentRef(
            context.runtime,
            session.sessionId,
          ),
          active: readActiveTaskStrategyRedRevision(
            context.runtime,
            session.sessionId,
          ),
          session: inspection.session,
          redBytes: fs.readFileSync(testPath, 'utf8'),
          implementationExists: fs.existsSync(implementationPath),
          correctionExists: fs.existsSync(correctionPath),
          initialPatch: readPatch(initial),
          correctionPatch: readPatch(correction),
          rounds: readRounds(),
          redCheckCount: fs.readFileSync(counterPath, 'utf8'),
        };
      };
      const before = observe();
      assert.equal(before.candidate.tree, correction.record.candidateTree);
      const crash = new Error(`after complete ${layout} worktree restoration`);
      let hookCalls = 0;
      assert.throws(
        () =>
          beginTaskStrategyRedRevision(repository, request, {
            testAfterWorktreeRestore() {
              hookCalls += 1;
              throw crash;
            },
          }),
        (error) => error === crash,
      );
      assert.equal(hookCalls, 1);
      const restored = observe();
      t.diagnostic(
        `PATCH_RECOVERY_EVIDENCE ${JSON.stringify({
          layout,
          stage: 'after-complete-reverse-before-resume',
          repository,
          sessionId: session.sessionId,
          revisionId,
          predecessor,
          before,
          restored,
        })}`,
      );
      assert.equal(restored.candidate.tree, predecessor.red.candidateTree);
      assert.equal(
        restored.candidate.previousIndexTree,
        before.candidate.previousIndexTree,
      );
      assert.equal(restored.redBytes, redBytes);
      assert.equal(restored.implementationExists, false);
      assert.equal(restored.correctionExists, false);
      assert.equal(restored.journal?.phase, 'prepared');
      assert.equal(
        restored.journal.restoration.patchRecordDigest,
        initial.record.recordDigest,
      );
      assert.equal(
        restored.active?.journal?.journalDigest,
        restored.journal.journalDigest,
      );
      assert.deepEqual(restored.currentRef, before.currentRef);
      assert.deepEqual(restored.session, before.session);
      assert.deepEqual(restored.initialPatch, before.initialPatch);
      assert.deepEqual(restored.correctionPatch, before.correctionPatch);
      assert.deepEqual(restored.rounds, before.rounds);
      assert.equal(restored.redCheckCount, before.redCheckCount);

      const args = ['resume', session.sessionId, '--json'];
      const environment = {
        AGENT: 'codex',
        WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
      };
      const opening = runWorkflowCli(repository, args, environment);
      const afterResume = observe();
      t.diagnostic(
        `PATCH_RECOVERY_EVIDENCE ${JSON.stringify({
          layout,
          stage: 'after-ordinary-resume',
          repository,
          command: {
            argv: [
              process.execPath,
              '--experimental-strip-types',
              path.join(
                sourceRepositoryRoot,
                'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
              ),
              ...args,
            ],
            cwd: repository,
            environment,
          },
          result: opening,
          observed: afterResume,
        })}`,
      );
      assert.equal(afterResume.candidate.tree, predecessor.red.candidateTree);
      assert.equal(afterResume.redBytes, redBytes);
      assert.equal(afterResume.implementationExists, false);
      assert.equal(afterResume.correctionExists, false);
      assert.deepEqual(afterResume.initialPatch, restored.initialPatch);
      assert.deepEqual(afterResume.correctionPatch, restored.correctionPatch);
      assert.deepEqual(afterResume.rounds, restored.rounds);
      // No new RED expectation exists yet. Recovery must advance opening, then
      // refuse a no-op reseal; nonzero alone is not evidence of a recovery bug.
      assert.equal(
        afterResume.journal?.phase,
        'session-evidence-cleared',
        opening.stderr,
      );
      assert.equal(afterResume.currentRef?.state, 'red-authoring');
      assert.equal(
        inspectTaskStrategyTransaction(repository, session.sessionId),
        null,
      );
      assert.notEqual(opening.status, 0);
      assert.match(opening.stderr, /TASK_STRATEGY_RED_REVISION_NO_CHANGE/);

      fs.writeFileSync(testPath, "throw new Error('corrected expectation');\n");
      const recovered = runWorkflowCli(repository, args, environment);
      assert.equal(recovered.status, 0, recovered.stderr);
      const completed = observe();
      assert.equal(completed.journal?.phase, 'completed');
      assert.equal(completed.active, null);
      assert.equal(completed.currentRef?.state, 'red-sealed');
      assert.equal(completed.implementationExists, false);
      assert.equal(completed.correctionExists, false);
      assert.deepEqual(completed.initialPatch, restored.initialPatch);
      assert.deepEqual(completed.correctionPatch, restored.correctionPatch);
      assert.deepEqual(completed.rounds, restored.rounds);
      assert.equal(
        inspectTaskStrategyTransaction(repository, session.sessionId)
          ?.recordDigest,
        completed.journal.successorTransaction?.recordDigest,
      );
      assert.notEqual(
        completed.journal.successorTransaction?.recordDigest,
        predecessor.recordDigest,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

for (const layout of ['overlapping', 'disjoint'] as const) {
  test(`ordinary resume finishes the remaining ${layout} prefix after one real reverse`, (t) => {
    const fixture = createRecoveryFixture(layout);
    const {
      repository,
      session,
      predecessor,
      initial,
      correction,
      request,
      observe,
      resume,
      testPath,
    } = fixture;
    try {
      const before = observe();
      const crash = new Error('after first actual reverse');
      let ownershipChecks = 0;
      const service = createTaskStrategyRedRevisionService(
        {
          ...taskStrategyRedRevisionOperations,
          restoreImplementationToRed(cwd, sessionId, transaction, assertOwned) {
            return taskStrategyRedRevisionOperations.restoreImplementationToRed(
              cwd,
              sessionId,
              transaction,
              () => {
                assertOwned();
                ownershipChecks += 1;
                // The original restore checks once on entry and once after
                // its first real reverse, before expected-session inspection.
                if (ownershipChecks === 2) throw crash;
              },
            );
          },
        },
        assertCurrentImplementationReconciliation,
      );
      assert.throws(
        () => service.beginTaskStrategyRedRevision(repository, request),
        (error) => error === crash,
      );
      assert.equal(ownershipChecks, 2);
      const partial = observe();
      assert.equal(before.candidate.tree, correction.record.candidateTree);
      assert.equal(partial.candidate.tree, initial.record.candidateTree);
      assert.notEqual(partial.candidate.tree, predecessor.red.candidateTree);
      assert.equal(partial.journal?.phase, 'prepared');
      assert.deepEqual(partial.currentRef, before.currentRef);
      assert.deepEqual(partial.session, before.session);
      assert.deepEqual(partial.immutable, before.immutable);
      assert.equal(partial.redBytes, before.redBytes);
      assert.equal(partial.redCheckCount, before.redCheckCount);
      assert.equal(
        partial.candidate.previousIndexTree,
        before.candidate.previousIndexTree,
      );
      assert.equal(
        fs.readFileSync(path.join(repository, 'src/feature.ts'), 'utf8'),
        'export const feature = true;\n',
      );
      if (layout === 'disjoint') {
        assert.equal(
          fs.existsSync(path.join(repository, 'src/correction.ts')),
          false,
        );
      }
      const opening = resume();
      const opened = observe();
      t.diagnostic(
        `PATCH_PREFIX_RECOVERY ${JSON.stringify({ layout, partial, opening, opened })}`,
      );
      assert.equal(
        opened.journal?.phase,
        'session-evidence-cleared',
        opening.stderr,
      );
      assert.equal(opened.currentRef?.state, 'red-authoring');
      assert.equal(opened.candidate.tree, predecessor.red.candidateTree);
      assert.equal(opened.redBytes, before.redBytes);
      assert.deepEqual(opened.immutable, before.immutable);
      assert.equal(
        fs.existsSync(path.join(repository, 'src/feature.ts')),
        false,
      );
      assert.equal(
        fs.existsSync(path.join(repository, 'src/correction.ts')),
        false,
      );
      assert.equal(
        inspectTaskStrategyTransaction(repository, session.sessionId),
        null,
      );
      assert.notEqual(opening.status, 0);
      assert.match(opening.stderr, /TASK_STRATEGY_RED_REVISION_NO_CHANGE/);

      fs.writeFileSync(testPath, "throw new Error('corrected expectation');\n");
      const recovered = resume();
      const completed = observe();
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(completed.journal?.phase, 'completed');
      assert.equal(completed.active, null);
      assert.equal(completed.currentRef?.state, 'red-sealed');
      assert.deepEqual(completed.immutable, before.immutable);
      assert.equal(
        fs.existsSync(path.join(repository, 'src/feature.ts')),
        false,
      );
      assert.equal(
        fs.existsSync(path.join(repository, 'src/correction.ts')),
        false,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  test(`foreign full tree refuses ${layout} restoration before any reverse`, (t) => {
    const fixture = createRecoveryFixture(layout);
    const {
      repository,
      predecessor,
      initial,
      correction,
      request,
      observe,
      resume,
    } = fixture;
    try {
      const ambientPath = path.join(repository, 'src/ambient.ts');
      const ambientBytes = 'export const ambient = "preserve exactly";\n';
      fs.writeFileSync(ambientPath, ambientBytes);
      assert.equal(
        initial.record.changedPaths.includes('src/ambient.ts'),
        false,
      );
      assert.equal(
        correction.record.changedPaths.includes('src/ambient.ts'),
        false,
      );
      const before = observe();
      assert.equal(
        [
          predecessor.red.candidateTree,
          initial.record.candidateTree,
          correction.record.candidateTree,
        ].includes(before.candidate.tree),
        false,
      );
      let ownershipChecks = 0;
      const service = createTaskStrategyRedRevisionService(
        {
          ...taskStrategyRedRevisionOperations,
          restoreImplementationToRed(cwd, sessionId, transaction, assertOwned) {
            return taskStrategyRedRevisionOperations.restoreImplementationToRed(
              cwd,
              sessionId,
              transaction,
              () => {
                assertOwned();
                ownershipChecks += 1;
              },
            );
          },
        },
        assertCurrentImplementationReconciliation,
      );
      assert.throws(
        () => service.beginTaskStrategyRedRevision(repository, request),
        hasCode('TASK_STRATEGY_PATCH_STALE'),
      );
      assert.equal(
        ownershipChecks,
        1,
        'only entry ownership check; no reverse effect',
      );
      const refused = observe();
      assert.equal(refused.journal?.phase, 'prepared');
      assert.deepEqual(refused.candidate, before.candidate);
      assert.deepEqual(refused.sourceFiles, before.sourceFiles);
      assert.equal(refused.redBytes, before.redBytes);
      assert.deepEqual(refused.currentRef, before.currentRef);
      assert.deepEqual(refused.session, before.session);
      assert.deepEqual(refused.immutable, before.immutable);
      assert.equal(refused.redCheckCount, before.redCheckCount);
      assert.equal(fs.readFileSync(ambientPath, 'utf8'), ambientBytes);

      const retried = resume();
      const afterRetry = observe();
      t.diagnostic(
        `PATCH_FOREIGN_TREE ${JSON.stringify({ layout, before, refused, retried, afterRetry })}`,
      );
      assert.notEqual(retried.status, 0);
      assert.match(retried.stderr, /TASK_STRATEGY_PATCH_STALE/);
      assert.deepEqual(afterRetry, refused);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

function createRecoveryFixture(layout: 'overlapping' | 'disjoint') {
  const { repository, counterPath } = createCrossAgentFixture(
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
    const initial = adoptCurrentTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.ok(initial);
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
    const correctionRelativePath =
      layout === 'overlapping' ? 'src/feature.ts' : 'src/correction.ts';
    fs.writeFileSync(
      path.join(repository, correctionRelativePath),
      'export const corrected = true;\n',
    );
    const correction = adoptCurrentTaskStrategyCorrection(
      repository,
      session.sessionId,
    );
    assert.ok(correction);
    assert.deepEqual(initial.record.changedPaths, ['src/feature.ts']);
    assert.deepEqual(correction.record.changedPaths, [correctionRelativePath]);
    assert.equal(initial.record.sourceTree, predecessor.red.candidateTree);
    assert.equal(correction.record.sourceTree, initial.record.candidateTree);
    const context = observeInvestigationRuntimeContext(repository);
    const request = {
      schemaVersion: 1 as const,
      kind: 'task-strategy-red-revision-request' as const,
      sessionId: session.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: `Recover remaining ${layout} correction lineage`,
    };
    const revisionId = taskStrategyRedRevisionId(request);
    const observe = () => {
      const inspection = inspectSession(
        productionChangeContract,
        repository,
        session.sessionId,
      );
      return {
        candidate: previewExactStaging(
          repository,
          inspection.session.baseline.head,
          [...inspection.changedPaths],
        ),
        sourceFiles: fs.existsSync(path.join(repository, 'src'))
          ? snapshotPersistentTree(path.join(repository, 'src'))
          : [],
        redBytes: fs.readFileSync(testPath, 'utf8'),
        redCheckCount: fs.readFileSync(counterPath, 'utf8'),
        journal: readTaskStrategyRedRevisionJournal(
          context.runtime,
          session.sessionId,
          revisionId,
        ),
        currentRef: readTaskStrategyCurrentRef(
          context.runtime,
          session.sessionId,
        ),
        active: readActiveTaskStrategyRedRevision(
          context.runtime,
          session.sessionId,
        ),
        session: inspection.session,
        immutable: {
          patches: [initial, correction].map(({ record }) => ({
            record: readTaskStrategyPatchRecord(
              context.runtime,
              session.sessionId,
              record.patchDigest,
              record.sourceTree,
            ),
            reservation: readTaskStrategyPatchReservation(
              context.runtime,
              session.sessionId,
              record.sourceTree,
            ),
            receipt: readTaskStrategyPatchImportReceipt(
              context.runtime,
              session.sessionId,
              record.patchDigest,
              record.sourceTree,
            ),
            binding: readTaskStrategyPatchCurrentBinding(
              context.runtime,
              session.sessionId,
              record.sourceTree,
            ),
          })),
          rounds: listTaskStrategyCorrectionRounds(
            context.runtime,
            session.sessionId,
            predecessor.recordDigest,
          ),
        },
      };
    };
    const projection =
      productionTaskStrategyCorrection.resolveCurrentTaskStrategyCorrection(
        inspectSession(productionChangeContract, repository, session.sessionId),
      );
    assert.equal(projection.completedCorrectionRounds, 1);
    assert.equal(
      projection.head?.record.recordDigest,
      correction.record.recordDigest,
    );
    const observed = observe();
    assert.deepEqual(observed.immutable.patches, [initial, correction]);
    assert.equal(observed.immutable.rounds.length, 1);
    assert.equal(
      observed.immutable.rounds[0]!.importRecord?.currentPatchHead.recordDigest,
      correction.record.recordDigest,
    );
    return {
      repository,
      session,
      predecessor,
      initial,
      correction,
      request,
      testPath,
      observe,
      resume: () =>
        runWorkflowCli(repository, ['resume', session.sessionId, '--json'], {
          AGENT: 'codex',
          WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
        }),
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

import { createTaskStrategyPatchService } from '../src/application/execute-task/task-strategy-patch.ts';
import {
  taskStrategyPatchOperations,
  productionTaskStrategyPatch,
} from '../src/composition-root/task-strategy-patch-production.ts';
import {
  diffAgainstTree,
  sha256Buffer,
} from './support/task-strategy-execution-fixture.ts';
import type { TaskStrategyPatchOperations } from '../src/application/execute-task/task-strategy-patch-operations.ts';

type EffectCut =
  | 'reservation'
  | 'record'
  | 'apply'
  | 'receipt'
  | 'binding'
  | 'round-reservation'
  | 'round-result'
  | 'round-import'
  | 'tail-owned';
function interruptedPatchService(cut: EffectCut) {
  const failure = new Error(`after actual ${cut}`);
  const effects: string[] = [];
  let interrupted = false;
  let owned = 0;
  const after = <T>(phase: EffectCut, run: () => T): T => {
    const value = run();
    effects.push(phase);
    if (phase === cut && !interrupted) {
      interrupted = true;
      throw failure;
    }
    return value;
  };
  // Clone each decorated surface. All original effects run to completion before injection.
  const operations: TaskStrategyPatchOperations = {
    ...taskStrategyPatchOperations,
    session: { ...taskStrategyPatchOperations.session },
    clock: { ...taskStrategyPatchOperations.clock },
    locks: {
      ...taskStrategyPatchOperations.locks,
      repository: (layout, run) =>
        taskStrategyPatchOperations.locks.repository(layout, (assertOwned) =>
          run(() => {
            assertOwned();
            if (++owned === 2) after('tail-owned', () => undefined);
          }),
        ),
    },
    repository: {
      ...taskStrategyPatchOperations.repository,
      applyPatchToWorktree: (...args) =>
        after('apply', () =>
          taskStrategyPatchOperations.repository.applyPatchToWorktree(...args),
        ),
    },
    observeJournal: (...args) => {
      const original = taskStrategyPatchOperations.observeJournal(...args);
      return {
        ...original,
        implementation: { ...original.implementation },
        correction: {
          ...original.correction,
          reserve: (...a) =>
            after('round-reservation', () => original.correction.reserve(...a)),
          publishResult: (...a) =>
            after('round-result', () =>
              original.correction.publishResult(...a),
            ),
          publishImport: (...a) =>
            after('round-import', () =>
              original.correction.publishImport(...a),
            ),
        },
        patch: {
          ...original.patch,
          reserve: (...a) =>
            after('reservation', () => original.patch.reserve(...a)),
          persistRecord: (...a) =>
            after('record', () => original.patch.persistRecord(...a)),
          createImportReceipt: (...a) =>
            after('receipt', () => original.patch.createImportReceipt(...a)),
          createCurrentBinding: (...a) =>
            after('binding', () => original.patch.createCurrentBinding(...a)),
        },
      };
    },
  };
  return {
    failure,
    effects,
    service: createTaskStrategyPatchService(
      operations,
      productionTaskStrategyCorrection,
    ),
  };
}

function patchRecoveryFixture(single: boolean, caller = false) {
  const { repository } = createCrossAgentFixture(
    'assertion',
    single ? 'tdd-single-agent' : 'cross-agent-tdd',
    { codex: !caller, claude: !caller },
    caller,
    single,
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
    const transaction = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    const context = observeInvestigationRuntimeContext(repository);
    const observe = (sourceTree: string, patchDigest: string) => ({
      reservation: readTaskStrategyPatchReservation(
        context.runtime,
        session.sessionId,
        sourceTree,
      ),
      record: readTaskStrategyPatchRecord(
        context.runtime,
        session.sessionId,
        patchDigest,
        sourceTree,
      ),
      receipt: readTaskStrategyPatchImportReceipt(
        context.runtime,
        session.sessionId,
        patchDigest,
        sourceTree,
      ),
      binding: readTaskStrategyPatchCurrentBinding(
        context.runtime,
        session.sessionId,
        sourceTree,
      ),
    });
    const inspect = () =>
      inspectSession(productionChangeContract, repository, session.sessionId);
    const tree = () => {
      const inspection = inspect();
      return previewExactStaging(repository, session.baseline.head, [
        ...inspection.changedPaths,
      ]).tree;
    };
    const rounds = () =>
      listTaskStrategyCorrectionRounds(
        context.runtime,
        session.sessionId,
        transaction.recordDigest,
      );
    const resume = () =>
      runWorkflowCli(repository, ['resume', session.sessionId, '--json'], {
        AGENT: 'codex',
        WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
      });
    return {
      repository,
      session,
      transaction,
      implementationPath,
      context,
      observe,
      inspect,
      tree,
      rounds,
      resume,
      cleanup: () => fs.rmSync(repository, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

for (const cut of [
  'reservation',
  'record',
  'apply',
  'receipt',
  'binding',
] as const)
  test(`raw same-input replay recovers after actual ${cut} effect`, (t) => {
    const f = patchRecoveryFixture(false);
    try {
      fs.writeFileSync(f.implementationPath, 'export const feature = true;\n');
      const patch = diffAgainstTree(
        f.repository,
        f.transaction.red.candidateTree,
        ['src/feature.ts'],
      );
      fs.rmSync(f.implementationPath);
      const input = { patch, explicitActor: 'claude', environment: {} };
      const digest = sha256Buffer(patch);
      const injected = interruptedPatchService(cut);
      assert.throws(
        () =>
          injected.service.importTaskStrategyPatch(
            f.repository,
            f.session.sessionId,
            input,
          ),
        (e) => e === injected.failure,
      );
      const observed = f.observe(f.transaction.red.candidateTree, digest);
      const candidate = f.tree();
      assert.ok(observed.reservation);
      assert.equal(observed.record !== null, cut !== 'reservation');
      assert.equal(
        observed.receipt !== null,
        ['receipt', 'binding'].includes(cut),
      );
      assert.equal(observed.binding !== null, cut === 'binding');
      assert.equal(
        candidate === f.transaction.red.candidateTree,
        ['reservation', 'record'].includes(cut),
      );
      t.diagnostic(
        `PATCH_EFFECT_EVIDENCE ${JSON.stringify({ authority: 'raw-same-input-api', cut, observed, candidate, effects: injected.effects })}`,
      );
      const imported = productionTaskStrategyPatch.importTaskStrategyPatch(
        f.repository,
        f.session.sessionId,
        input,
      );
      assert.equal(imported.record.createdAt, observed.reservation.createdAt);
      if (observed.receipt)
        assert.equal(imported.receipt.importedAt, observed.receipt.importedAt);
      assert.deepEqual(
        f.observe(f.transaction.red.candidateTree, digest),
        imported,
      );
      assert.equal(f.tree(), imported.record.candidateTree);
      const before = snapshotPersistentTree(f.context.runtime.refs);
      const bytes = fs.readFileSync(f.implementationPath);
      assert.deepEqual(
        productionTaskStrategyPatch.importTaskStrategyPatch(
          f.repository,
          f.session.sessionId,
          input,
        ),
        imported,
      );
      assert.deepEqual(snapshotPersistentTree(f.context.runtime.refs), before);
      assert.deepEqual(fs.readFileSync(f.implementationPath), bytes);
    } finally {
      f.cleanup();
    }
  });

for (const cut of [
  'round-reservation',
  'binding',
  'round-result',
  'round-import',
  'tail-owned',
] as const)
  test(`ordinary local resume recovers correction after actual ${cut} effect`, (t) => {
    const f = patchRecoveryFixture(true);
    try {
      fs.writeFileSync(f.implementationPath, 'export const feature = true;\n');
      const initial = adoptCurrentTaskStrategyImplementation(
        f.repository,
        f.session.sessionId,
      );
      assert.ok(initial);
      assert.throws(
        () =>
          checkSession(
            maintainerManifestOperations,
            productionTaskStrategyExecutionGate,
            productionChangeContract,
            f.repository,
            f.session.sessionId,
            { environment: {} },
          ),
        hasCode('CHECK_FAILED'),
      );
      fs.writeFileSync(
        f.implementationPath,
        'export const corrected = true;\n',
      );
      const patch = diffAgainstTree(
        f.repository,
        initial.record.candidateTree,
        ['src/feature.ts'],
      );
      const digest = sha256Buffer(patch);
      const candidate = f.tree();
      const injected = interruptedPatchService(cut);
      assert.throws(
        () =>
          injected.service.adoptCurrentTaskStrategyCorrection(
            f.repository,
            f.session.sessionId,
          ),
        (e) => e === injected.failure,
      );
      const observed = f.observe(initial.record.candidateTree, digest);
      const rounds = f.rounds();
      assert.equal(rounds.length, 1);
      const round = rounds[0]!;
      assert.equal(
        round.result !== null,
        ['round-result', 'round-import', 'tail-owned'].includes(cut),
      );
      assert.equal(
        round.importRecord !== null,
        ['round-import', 'tail-owned'].includes(cut),
      );
      assert.equal(observed.binding !== null, cut !== 'round-reservation');
      assert.equal(f.tree(), candidate);
      const projection =
        productionTaskStrategyCorrection.resolveCurrentTaskStrategyCorrection(
          f.inspect(),
        );
      assert.equal(
        projection.completedCorrectionRounds,
        ['round-import', 'tail-owned'].includes(cut) ? 1 : 0,
      );
      t.diagnostic(
        `PATCH_EFFECT_EVIDENCE ${JSON.stringify({ authority: 'sealed-local-ordinary-cli', cut, observed, rounds, candidate, projection, effects: injected.effects })}`,
      );
      const result = f.resume();
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(f.tree(), candidate);
      const completed = f.rounds();
      assert.equal(completed.length, 1);
      assert.ok(completed[0]!.result);
      assert.ok(completed[0]!.importRecord);
      assert.equal(
        completed[0]!.reservation.reservationDigest,
        round.reservation.reservationDigest,
      );
      const restored = f.observe(initial.record.candidateTree, digest);
      assert.ok(restored.receipt);
      if (observed.receipt)
        assert.equal(restored.receipt.importedAt, observed.receipt.importedAt);
      assert.equal(
        completed[0]!.importRecord!.importedAt,
        restored.receipt.importedAt,
      );
      const repeat = f.resume();
      assert.equal(repeat.status, 0, repeat.stderr || repeat.stdout);
      assert.deepEqual(f.rounds(), completed);
      assert.deepEqual(
        f.observe(initial.record.candidateTree, digest),
        restored,
      );
    } finally {
      f.cleanup();
    }
  });

import {
  beginTaskStrategyImplementation,
  inspectTaskStrategyImplementation,
} from '../src/composition-root/task-strategy-production.ts';
import {
  completeTaskImplementationProvider,
  taskImplementationOutput,
  callerImplementationGrantRequest,
  collaborationSigner,
} from './support/task-strategy-execution-fixture.ts';
import { authoritativeCollaborationGrantVerifierForTest } from './fixture.ts';
import { issueCollaborationGrant } from '../src/composition-root/collaboration-grant-issuance-production.ts';
import {
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyCallerImplementationBinding,
} from '../src/runtime/storage-journal/task-strategy-provider-store.ts';

for (const authority of ['provider', 'caller'] as const)
  for (const cut of ['apply', 'receipt'] as const)
    test(`ordinary ${authority} CLI recovers after actual ${cut} using durable result authority`, (t) => {
      const f = patchRecoveryFixture(false, authority === 'caller');
      try {
        const waiting = beginTaskStrategyImplementation(
          f.repository,
          f.session.sessionId,
        );
        fs.writeFileSync(
          f.implementationPath,
          'export const feature = true;\n',
        );
        const patch = diffAgainstTree(
          f.repository,
          f.transaction.red.candidateTree,
          ['src/feature.ts'],
        );
        fs.rmSync(f.implementationPath);
        let replayOptions: Parameters<
          typeof beginTaskStrategyImplementation
        >[2];
        if (authority === 'provider') {
          assert.equal(waiting.state, 'waiting-for-provider');
          assert.ok(waiting.state === 'waiting-for-provider');
          assert.equal(
            completeTaskImplementationProvider(
              f.repository,
              waiting.invocationId,
              waiting.assignment.providerId,
              taskImplementationOutput(
                f.session.sessionId,
                f.transaction.red.candidateTree,
                patch,
              ),
            ).state,
            'succeeded',
          );
          assert.throws(
            () =>
              beginTaskStrategyImplementation(
                f.repository,
                f.session.sessionId,
                {
                  testCrashAfter: 'provider-result-persisted',
                },
              ),
            /Simulated task implementation interruption/,
          );
        } else {
          assert.equal(waiting.state, 'collaboration-grant-required');
          assert.ok(waiting.state === 'collaboration-grant-required');
          const policy = JSON.parse(
            fs.readFileSync(
              path.join(f.repository, 'workflow/maintainer-policy.json'),
              'utf8',
            ),
          ) as { trustedSigners: { identity: string }[] };
          const signer = collaborationSigner(
            policy.trustedSigners[0]!.identity,
          );
          const callerId = 'patch-recovery-caller';
          const grant = issueCollaborationGrant(
            f.repository,
            callerImplementationGrantRequest(
              f.session,
              waiting.subject.subjectDigest,
              callerId,
            ),
            { signer },
          );
          replayOptions = {
            collaborationGrant: {
              grantId: grant.grantId,
              verifier: authoritativeCollaborationGrantVerifierForTest(signer),
              callerSupplied: { callerId, assurance: 'self-declared', patch },
            },
          };
          assert.throws(
            () =>
              beginTaskStrategyImplementation(
                f.repository,
                f.session.sessionId,
                {
                  ...replayOptions,
                  testCrashAfter: 'provider-result-persisted',
                },
              ),
            /Simulated task implementation interruption/,
          );
        }
        const subject = waiting.subject.subjectDigest;
        const result =
          authority === 'provider'
            ? readTaskStrategyImplementationResultBinding(
                f.context.runtime,
                f.session.sessionId,
                subject,
              )
            : readTaskStrategyCallerImplementationBinding(
                f.context.runtime,
                f.session.sessionId,
                subject,
              );
        assert.ok(result);
        const injection = interruptedPatchService(cut);
        const initial = taskStrategyPatchOperations.session.loadActive(
          f.repository,
          f.session.sessionId,
        );
        assert.throws(
          () =>
            taskStrategyPatchOperations.locks.repository(
              initial.runtime,
              (owned) =>
                taskStrategyPatchOperations.locks.session(
                  initial.runtime,
                  f.session.sessionId,
                  () =>
                    authority === 'provider'
                      ? injection.service.importTaskStrategyProviderPatchUnderLifecycleLock(
                          f.repository,
                          f.session.sessionId,
                          {
                            patch,
                            implementationSubjectDigest: subject,
                            implementationResultBindingDigest:
                              result.bindingDigest,
                          },
                          owned,
                        )
                      : injection.service.importTaskStrategyCallerPatchUnderLifecycleLock(
                          f.repository,
                          f.session.sessionId,
                          {
                            patch,
                            implementationSubjectDigest: subject,
                            callerImplementationBindingDigest:
                              result.bindingDigest,
                          },
                          owned,
                        ),
                ),
            ),
          (e) => e === injection.failure,
        );
        const before = f.observe(
          f.transaction.red.candidateTree,
          sha256Buffer(patch),
        );
        assert.ok(before.record);
        assert.ok(before.reservation);
        assert.equal(before.receipt !== null, cut === 'receipt');
        assert.equal(before.binding, null);
        assert.equal(f.tree(), before.record.candidateTree);
        const authorityArtifacts = () =>
          snapshotPersistentTree(f.context.runtime.base).filter(
            (item) =>
              item.kind === 'file' &&
              /task-strategy-implementations|invocations|collaboration|grants|execution/.test(
                item.path,
              ),
          );
        const authoritySnapshot = authorityArtifacts();
        const candidate = f.tree();
        const worktreeBefore = fs.statSync(f.implementationPath);
        const indexBefore = fs.readFileSync(
          path.join(f.repository, '.git/index'),
        );
        const recovered = f.resume();
        // The first ordinary CLI must recover before any diagnostic or lower-level API.
        assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
        assert.equal(
          inspectTaskStrategyImplementation(f.repository, f.session.sessionId)
            .state,
          'patch-imported',
        );
        assert.equal(f.tree(), candidate);
        const after = f.observe(
          f.transaction.red.candidateTree,
          sha256Buffer(patch),
        );
        assert.ok(after.binding);
        assert.ok(after.receipt);
        assert.deepEqual(after.record, before.record);
        assert.deepEqual(after.reservation, before.reservation);
        assert.deepEqual(authorityArtifacts(), authoritySnapshot);
        assert.equal(fs.statSync(f.implementationPath).ino, worktreeBefore.ino);
        assert.equal(
          fs.statSync(f.implementationPath).mtimeMs,
          worktreeBefore.mtimeMs,
        );
        assert.deepEqual(
          fs.readFileSync(path.join(f.repository, '.git/index')),
          indexBefore,
        );
        if (before.receipt) assert.deepEqual(after.receipt, before.receipt);
        t.diagnostic(
          `PATCH_FORWARD_RECOVERY_EVIDENCE ${JSON.stringify({
            authority,
            cut,
            before,
            candidate,
            firstCli: recovered,
            after,
            authorityArtifacts: authoritySnapshot.map((item) => ({
              path: item.path,
              sha256: sha256Buffer(Buffer.from(item.content!)),
            })),
            effects: injection.effects,
          })}`,
        );
        const again = f.resume();
        assert.equal(again.status, 0, again.stderr || again.stdout);
        assert.deepEqual(
          f.observe(f.transaction.red.candidateTree, sha256Buffer(patch)),
          after,
        );
        assert.deepEqual(authorityArtifacts(), authoritySnapshot);
        assert.equal(
          fs.statSync(f.implementationPath).mtimeMs,
          worktreeBefore.mtimeMs,
        );
        assert.deepEqual(
          fs.readFileSync(path.join(f.repository, '.git/index')),
          indexBefore,
        );
      } finally {
        f.cleanup();
      }
    });

for (const layout of ['overlapping', 'disjoint'] as const)
  for (const cut of ['reverse-return', 'expected-inspection'] as const)
    test(`ordinary resume after ${layout} actual ${cut} interruption preserves authenticated prefix`, (t) => {
      const f = createRecoveryFixture(layout);
      try {
        const before = f.observe();
        const failure = new Error(cut);
        let reverses = 0;
        const operations: TaskStrategyPatchOperations = {
          ...taskStrategyPatchOperations,
          session: {
            ...taskStrategyPatchOperations.session,
            inspectExpected: (...args) => {
              const observed =
                taskStrategyPatchOperations.session.inspectExpected(...args);
              if (cut === 'expected-inspection') throw failure;
              return observed;
            },
          },
          repository: {
            ...taskStrategyPatchOperations.repository,
            applyPatchToWorktree: (...args) => {
              taskStrategyPatchOperations.repository.applyPatchToWorktree(
                ...args,
              );
              assert.equal(args[2], true);
              reverses++;
              if (cut === 'reverse-return') throw failure;
            },
          },
        };
        const patchService = createTaskStrategyPatchService(
          operations,
          productionTaskStrategyCorrection,
        );
        const redService = createTaskStrategyRedRevisionService(
          {
            ...taskStrategyRedRevisionOperations,
            restoreImplementationToRed:
              patchService.restoreCurrentTaskStrategyImplementationToRedUnderLifecycleLock,
          },
          assertCurrentImplementationReconciliation,
        );
        assert.throws(
          () =>
            redService.beginTaskStrategyRedRevision(f.repository, f.request),
          (e) => e === failure,
        );
        assert.equal(reverses, 1);
        const partial = f.observe();
        assert.equal(partial.candidate.tree, f.initial.record.candidateTree);
        assert.equal(partial.journal?.phase, 'prepared');
        assert.deepEqual(partial.currentRef, before.currentRef);
        assert.deepEqual(partial.immutable, before.immutable);
        assert.equal(partial.redCheckCount, before.redCheckCount);
        assert.equal(
          partial.candidate.previousIndexTree,
          before.candidate.previousIndexTree,
        );
        const opening = f.resume();
        const opened = f.observe();
        assert.match(opening.stderr, /TASK_STRATEGY_RED_REVISION_NO_CHANGE/);
        assert.equal(opened.journal?.phase, 'session-evidence-cleared');
        assert.equal(opened.candidate.tree, f.predecessor.red.candidateTree);
        assert.deepEqual(opened.immutable, before.immutable);
        t.diagnostic(
          `PATCH_REVERSE_EFFECT_EVIDENCE ${JSON.stringify({ layout, cut, partial, opening, opened })}`,
        );
        fs.writeFileSync(
          f.testPath,
          "throw new Error('corrected expectation');\n",
        );
        const resealed = f.resume();
        assert.equal(resealed.status, 0, resealed.stderr);
        assert.equal(f.observe().journal?.phase, 'completed');
        assert.deepEqual(f.observe().immutable, before.immutable);
      } finally {
        fs.rmSync(f.repository, { recursive: true, force: true });
      }
    });
