import { createFinalizationService } from '../src/application/finalize/lifecycle.ts';
import { reviewedGeneratedAssets } from '../src/composition-root/planning-provider-authoring-production.ts';
import { finalizeTaskUnlocked } from '../src/application/finalize/projected-finalization.ts';
import type { SystemDocumentDispositionService } from '../src/application/finalize/system-document-dispositions.ts';
import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { taskDiffReview } from '../src/composition-root/task-diff-review-production.ts';
import { assertCurrentImplementationReconciliation } from '../src/composition-root/implementation-reconciliation-production.ts';
import { localEngineSelectionReaders } from './support/local-engine-selection-host.ts';
import { getSession } from '../src/runtime/repository-observation/workflow-session-context.ts';
import { readFinalizeTransaction } from '../src/runtime/storage-journal/finalize-transaction.ts';
import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dispatchAsync } from '../bootstrap/workflow-engine-host.ts';
import { createOpenSpecAdapter } from '../src/composition-root/openspec-adapter-production.ts';
import type { CentralGrantRequestPortV1 } from '@jigwright/core/central-grant-port';
import { createSystemDocumentFailGrantResult } from '../bootstrap/workflow-engine-host.ts';
import { workflowResultNextSteps } from '../src/modules/guidance/next-steps/workflow-guidance.ts';
import {
  createFixtureRepository,
  configureChecks,
  git,
  runtimeRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import {
  hasCode,
  workRegistryGrantPolicy,
} from './governance-intake-fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import {
  finalizeTask,
  finalizeSession,
} from './support/local-engine-selection-host.ts';
import { systemDocumentDispositions } from '../src/composition-root/system-document-disposition-production.ts';
import { SYSTEM_DOCUMENT_GRANT_REASON } from '../src/application/finalize/system-document-grant.ts';
import { createProductionSystemDocumentGrantService } from '../src/composition-root/grant-production.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../src/runtime/lifecycle-ledgers/grant-store.ts';
import {
  readSystemDocumentReviewRecord,
  writeSystemDocumentReviewRecord,
} from '../src/runtime/storage-journal/system-document-review-store.ts';

const {
  inspectSystemDocumentDispositions,
  recordSystemDocumentDispositions,
  assertSystemDocumentDispositions,
} = systemDocumentDispositions;
const {
  createSystemDocumentGrantRequest,
  systemDocumentGrantTransitionDefinitions,
} = createProductionSystemDocumentGrantService();

test('fake OpenSpec reports actual spec files with sorted identities and valid totals', () => {
  const repository = createFixtureRepository();
  try {
    const specs = path.join(repository, 'openspec/specs');
    for (const capability of ['zulu', 'alpha']) {
      fs.mkdirSync(path.join(specs, capability), { recursive: true });
      fs.writeFileSync(path.join(specs, capability, 'spec.md'), '# Contract\n');
    }
    fs.mkdirSync(path.join(specs, 'ignored', 'spec.md'), { recursive: true });
    const validation = createOpenSpecAdapter(repository).validateAllSpecs();
    assert.equal(validation.valid, true);
    assert.deepEqual(
      validation.items.map(({ id }) => id),
      ['alpha', 'zulu'],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('finalize requires exact document decisions before checks and recovers the admitted projection', async () => {
  const fixture = prepare();
  const { repository, sessionId, counter } = fixture;
  try {
    const review = inspectSystemDocumentDispositions(repository, sessionId);
    const inspected = await dispatchAsync(
      ['documents', 'review', sessionId],
      repository,
    );
    assert.deepEqual(inspected.result, review);
    assert.deepEqual(
      review.documents.map(({ path }) => path),
      ['src/README.md', 'src/spec.md'],
    );
    assert.equal(
      review.documents.find(({ kind }) => kind === 'spec')!
        .deltaChangesContract,
      true,
    );
    let failure: unknown;
    assert.throws(
      () => finalizeTask(repository, sessionId),
      (error) => {
        failure = error;
        return hasCode('SYSTEM_DOCUMENT_DISPOSITION_REQUIRED')(error);
      },
    );
    assert.equal(fs.existsSync(counter), false);
    const args = [
      'finalize',
      sessionId,
      '--message',
      'Complete documented task',
    ];
    const requestPort: CentralGrantRequestPortV1 = {
      contractVersion: 'central-grant-request-port.v1',
      async requestGrant(request) {
        assert.equal(request.stateBinding.digest, review.candidateDigest);
        return {
          challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          challengeDigest: `sha256:${'b'.repeat(64)}`,
        };
      },
    };
    const mapped = await createSystemDocumentFailGrantResult(
      args,
      repository,
      failure,
      requestPort,
    );
    assert.match(JSON.stringify(mapped), /workflow-fail-grant-required\.v1/);
    assert.match(JSON.stringify(mapped), /retryAfterDecision/);
    assert.ok(mapped);
    const failGrant = mapped.result as {
      failure: { details: typeof review };
      inputSchema: {
        inspectCommand: string;
        decisionCommand: string;
        retryAfterDecision: string;
      };
    };
    const expectedGuidance = {
      dispositionChoices: [
        {
          disposition: 'still-valid',
          requiredFields: ['path', 'disposition'],
          optionalFields: ['reason', 'followUpRef'],
        },
        {
          disposition: 'updated',
          requiredFields: ['path', 'disposition'],
          optionalFields: ['reason', 'followUpRef'],
        },
        {
          disposition: 'later',
          requiredFields: ['path', 'disposition', 'reason'],
          optionalFields: ['followUpRef'],
        },
      ],
      reviewCommand: `pnpm workflow documents review ${sessionId} --json`,
      recordCommand: `pnpm workflow documents review ${sessionId} --input <review.json> --json`,
      inputTemplate: {
        schemaVersion: 1,
        candidateDigest: review.candidateDigest,
        dispositions: review.documents.map(({ path }) => ({
          path,
          disposition: null,
        })),
      },
    };
    assert.deepEqual(
      [review, failGrant.failure.details].map((publicReview) => ({
        dispositionChoices: publicReview.dispositionChoices?.map(
          ({ disposition, requiredFields, optionalFields }) => ({
            disposition,
            requiredFields,
            optionalFields,
          }),
        ),
        reviewCommand: publicReview.reviewCommand,
        recordCommand: publicReview.recordCommand,
        inputTemplate: publicReview.inputTemplate,
      })),
      [expectedGuidance, expectedGuidance],
    );
    assert.ok(
      review.dispositionChoices.every(({ description }) => description.trim()),
    );
    assert.deepEqual(review.dispositions, []);
    assert.ok(
      workflowResultNextSteps(inspected).some(
        ({ command }) => command === review.recordCommand,
      ),
    );
    const nextCommands = workflowResultNextSteps(mapped, args).map(
      ({ command }) => command,
    );
    assert.equal(nextCommands[0], review.reviewCommand);
    assert.equal(nextCommands.length, 3);
    for (const command of [
      review.reviewCommand,
      failGrant.inputSchema.inspectCommand,
      failGrant.inputSchema.retryAfterDecision,
    ])
      assert.ok(nextCommands.includes(command), command);
    const input = {
      ...review.inputTemplate,
      dispositions: [
        {
          path: 'src/spec.md',
          disposition: review.dispositionChoices.find(
            ({ disposition }) => disposition === 'updated',
          )!.disposition,
        },
        {
          path: 'src/README.md',
          disposition: review.dispositionChoices.find(
            ({ disposition }) => disposition === 'later',
          )!.disposition,
          reason: 'Reassess this explanation in the follow-up.',
        },
      ],
    };
    const inputPath = path.join(
      runtimeRoot(repository),
      'document-review-input.json',
    );
    const recordArgs = review.recordCommand
      .split(' ')
      .slice(2)
      .filter((argument) => argument !== '--json')
      .map((argument) => (argument === '<review.json>' ? inputPath : argument));
    fs.writeFileSync(inputPath, JSON.stringify(review.inputTemplate));
    await assert.rejects(
      dispatchAsync(recordArgs, repository),
      hasCode('SYSTEM_DOCUMENT_REVIEW_INVALID'),
    );
    assert.equal(
      inspectSystemDocumentDispositions(repository, sessionId).status,
      'required',
    );
    fs.writeFileSync(inputPath, JSON.stringify(input));
    const recorded = await dispatchAsync(recordArgs, repository);
    assert.equal((recorded.result as { status: string }).status, 'reviewed');
    fs.appendFileSync(
      path.join(repository, 'src/feature.ts'),
      '// Changed candidate\n',
    );
    await assert.rejects(
      createSystemDocumentFailGrantResult(
        args,
        repository,
        failure,
        requestPort,
      ),
      hasCode('SYSTEM_DOCUMENT_REVIEW_STALE'),
    );
    assert.throws(
      () => recordSystemDocumentDispositions(repository, sessionId, input),
      hasCode('SYSTEM_DOCUMENT_REVIEW_STALE'),
    );
    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('SYSTEM_DOCUMENT_DISPOSITION_REQUIRED'),
    );
    const current = inspectSystemDocumentDispositions(repository, sessionId);
    recordSystemDocumentDispositions(repository, sessionId, {
      ...input,
      candidateDigest: current.candidateDigest,
    });
    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
    satisfyCurrentTaskDiffReview(repository, sessionId);
    const result = finalizeSession(
      repository,
      sessionId,
      'Complete documented task',
    );
    assert.equal(result.session.state, 'committed');
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
    assert.equal(git(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('Central Grant document exception recovers its exact receipt and never marks review passed', async () => {
  const { repository, sessionId, counter } = prepare();
  try {
    const challengeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const crash = new Error('after durable document exception');
    let crashOnce = true;
    const ids = [challengeId, operationId];
    const coordinator = createGrantCoordinatorKernel({
      store: createFileGrantRecordStore(
        grantStorePaths(runtimeRoot(repository)),
      ),
      registry: createTransitionRegistry(
        systemDocumentGrantTransitionDefinitions(repository, {
          afterExceptionRecorded() {
            if (crashOnce) {
              crashOnce = false;
              throw crash;
            }
          },
        }),
      ),
      policy: workRegistryGrantPolicy(),
      now: () => new Date('2026-09-08T00:00:00.000Z'),
      randomUUID: () => ids.shift()!,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              approvalMethod: 'human-presence' as const,
              reasonCode: SYSTEM_DOCUMENT_GRANT_REASON,
              reason: 'Defer these exact document decisions.',
              sessionNonce: 'nonce-77777777777777777777777777777777',
            };
          },
          async authenticate({ approvalSubjectDigest }) {
            return [
              {
                moduleId: 'human-gate-macos',
                version: '1',
                claims: ['fresh-local-device-owner'] as const,
                approvalSubjectDigest,
                proofDigest: `sha256:${'7'.repeat(64)}` as const,
                verifiedAt: '2026-09-08T00:00:00.000Z',
                identity: null,
                portableEvidence: null,
              },
            ];
          },
          async close() {},
        };
      },
      async withLifecycleOperation(_challengeId, operation) {
        return operation(() => {});
      },
    });
    const request = createSystemDocumentGrantRequest(repository, sessionId);
    await coordinator.requestGrant(request);
    await assert.rejects(
      coordinator.resolveChallenge(challengeId),
      (error) => error === crash,
    );
    assert.equal(
      createFileGrantRecordStore(
        grantStorePaths(runtimeRoot(repository)),
      ).readGrantRecord(challengeId).state,
      'prepared',
    );
    const partial = inspectSystemDocumentDispositions(repository, sessionId);
    assert.equal(partial.status, 'required');
    assert.deepEqual(partial.dispositions, []);
    const receipt = readSystemDocumentReviewRecord(
      runtimeRoot(repository),
      partial.candidateDigest,
    )!;
    await coordinator.recoverChallenge(challengeId);
    const completed = inspectSystemDocumentDispositions(repository, sessionId);
    assert.equal(completed.status, 'skipped-by-grant');
    assert.equal(completed.reportId, receipt.reportId);
    assert.deepEqual(completed.dispositions, []);
    writeSystemDocumentReviewRecord(runtimeRoot(repository), {
      ...receipt.record,
      candidateDigest: completed.candidateDigest,
      createdAt: '2026-09-08T01:00:00.000Z',
    });
    assert.throws(
      () => assertSystemDocumentDispositions(repository, sessionId),
      hasCode('SYSTEM_DOCUMENT_DISPOSITION_REQUIRED'),
    );
    writeSystemDocumentReviewRecord(runtimeRoot(repository), {
      ...receipt.record,
      candidateDigest: completed.candidateDigest,
    });
    assert.doesNotThrow(() =>
      assertSystemDocumentDispositions(repository, sessionId),
    );
    assert.equal(fs.existsSync(counter), false);
    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
    fs.appendFileSync(
      path.join(repository, 'src/feature.ts'),
      '// New implementation\n',
    );
    assert.throws(
      () => assertSystemDocumentDispositions(repository, sessionId),
      hasCode('SYSTEM_DOCUMENT_DISPOSITION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function prepare() {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'src/spec.md'),
    '# Feature contracts\ncapabilities: [demo]\n## Purpose\nKeep existing behavior.\n## Requirements\n### Requirement: Existing\nThe system SHALL keep existing behavior.\n',
  );
  fs.writeFileSync(
    path.join(repository, 'src/README.md'),
    `# Feature\n<!-- jigwright:module-why -->\nKeep the existing design rationale.\nConfirmed at commit: \`${'a'.repeat(40)}\`\n<!-- /jigwright:module-why -->\n`,
  );
  const counter = path.join(repository, '.git', 'document-check-count');
  fs.writeFileSync(
    path.join(repository, 'scripts/document-count.mjs'),
    "import fs from 'node:fs';\nconst p=process.argv[2];\nfs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1));\n",
  );
  configureChecks(
    repository,
    {
      counted: {
        command: ['node', 'scripts/document-count.mjs', counter],
        destructiveDatabase: false,
      },
    },
    ['counted'],
  );
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
  const session = startSession(
    productionChangeContract,
    repository,
    'demo-change',
    '1.1',
  );
  fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
  return { repository, sessionId: session.sessionId, counter };
}

function finalizationWithDocuments(
  documents: Pick<
    SystemDocumentDispositionService,
    'assertSystemDocumentDispositions'
  >,
) {
  return createFinalizationService(
    reviewedGeneratedAssets,
    localEngineSelectionReaders,
    maintainerManifestOperations,
    productionTaskStrategyExecutionGate,
    productionChangeContract,
    taskDiffReview,
    managedDocuments,
    assertCurrentImplementationReconciliation,
    documents,
  );
}

test('ordinary finalization uses the injected document receiver at the original gate before checks', () => {
  const { repository, sessionId, counter } = prepare();
  try {
    const failure = new Error('in-memory document decision failed');
    const calls: Array<readonly [string, string]> = [];
    let lookups = 0;
    const documents = {
      get assertSystemDocumentDispositions() {
        lookups += 1;
        return function (this: unknown, cwd: string, id: string): void {
          assert.equal(this, documents);
          calls.push([cwd, id]);
          throw failure;
        };
      },
    };
    const service = finalizationWithDocuments(documents);
    assert.equal(lookups, 0, 'construction must not read the method');
    const before = getSession(repository, sessionId);
    const operations = [
      () => service.finalizeTask(repository, sessionId),
      () =>
        service.finalizeSession(
          repository,
          sessionId,
          'Complete memory-reviewed task',
        ),
      () => service.completeTask(repository, sessionId),
      () =>
        finalizeTaskUnlocked(
          reviewedGeneratedAssets,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          taskDiffReview,
          managedDocuments,
          assertCurrentImplementationReconciliation,
          documents,
          repository,
          sessionId,
          {},
        ),
    ];
    for (const [index, run] of operations.entries()) {
      assert.throws(run, (error) => error === failure);
      assert.equal(lookups, index + 1);
      assert.deepEqual(calls[index], [repository, sessionId]);
      assert.equal(fs.existsSync(counter), false);
      assert.equal(
        readFinalizeTransaction(runtimeRoot(repository), sessionId),
        null,
      );
      assert.deepEqual(getSession(repository, sessionId), before);
      assert.equal(git(repository, ['diff', '--cached', '--name-only']), '');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('durable finalization resume never looks up the injected document method again or repeats passed checks', () => {
  const { repository, sessionId, counter } = prepare();
  try {
    let calls = 0;
    let lookups = 0;
    let resume = false;
    const documents = {
      get assertSystemDocumentDispositions() {
        if (resume) assert.fail('resume read a fresh document gate');
        lookups += 1;
        return function (this: unknown, cwd: string, id: string): void {
          assert.equal(this, documents);
          assert.equal(cwd, repository);
          assert.equal(id, sessionId);
          calls += 1;
        };
      },
    };
    const service = finalizationWithDocuments(documents);
    // The explicit memory service admits this fixture without a production
    // document record; other production capabilities still execute normally.
    assert.throws(
      () => service.finalizeTask(repository, sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    assert.equal(
      calls,
      2,
      'ordinary preliminary and fresh projected gates both use the same service',
    );
    assert.equal(lookups, 2);
    const transaction = readFinalizeTransaction(
      runtimeRoot(repository),
      sessionId,
    );
    assert.equal(transaction?.phase, 'checked');
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
    resume = true;
    satisfyCurrentTaskDiffReview(repository, sessionId);
    const recovered = service.recoverFinalize(repository, sessionId);
    assert.equal(recovered.transactionId, transaction!.transactionId);
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
    const finalized = service.finalizeSession(
      repository,
      sessionId,
      'Complete memory-reviewed task',
    );
    assert.equal(finalized.session.state, 'committed');
    assert.equal(finalized.tree, recovered.tree);
    assert.equal(calls, 2);
    assert.equal(lookups, 2);
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
    assert.equal(git(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
