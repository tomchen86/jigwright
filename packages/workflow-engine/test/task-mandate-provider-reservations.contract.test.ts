import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { showAuthorityAuditTask } from '../src/runtime/storage-journal/authority-audit-service.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { createInvestigationCheckpointEnvelope } from '../src/adapters/planning/investigation/investigation-session.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewRetryEnvelope,
  createProviderRetryEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/application/propose/propose-orchestrator.ts';
import { readProposeExemptionSession } from '../src/runtime/storage-journal/propose-exemption-store.ts';
import {
  claimProviderInvocation,
  failProviderInvocation,
  readProviderInvocation,
  readProviderRetryReservation,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  authorizeTaskMandate,
  inspectTaskMandate,
  revokeTaskMandate,
} from '../src/modules/authority/task-mandate.ts';
import {
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
} from './fixture.ts';
import {
  TASK_ID,
  MANDATE_ID,
  externalAuditRoot,
  cleanupRepository,
  auditScope,
  prepareRepository,
  request,
  generateSigningKey,
  realSigningProvider,
} from './task-mandate-fixture.ts';

test('true propose CLI charges the durable Survey reservation once and revoked replay fails closed', () => {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-propose-key-'),
  );
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-propose-input-'),
  );
  const { privateKey, trustedSigner } = generateSigningKey(keyDirectory);
  const repository = prepareRepository(trustedSigner);
  const signer = realSigningProvider(privateKey);
  const changeId = 'mandated-propose';
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  const intentPath = path.join(inputDirectory, 'intent.json');
  try {
    authorizeTaskMandate(repository, request(changeId), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: new Date(),
      signer,
    });
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    fs.writeFileSync(
      intentPath,
      `${JSON.stringify({
        schemaVersion: 1,
        summary: 'Inspect the exact mandate-bound provider reservation.',
        sourceRefs: [],
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      })}\n`,
    );
    const arguments_ = [
      '--experimental-strip-types',
      cli,
      'propose',
      changeId,
      '--intent',
      intentPath,
      '--actor',
      'codex',
      '--mandate',
      TASK_ID,
      '--json',
    ];
    // Every runtime actor hint has to be scrubbed, not just one: the explicit
    // --actor below would otherwise conflict with whichever agent runtime
    // happens to be running the suite, and the engine would correctly refuse
    // to guess between them.
    const environment = {
      ...process.env,
      AGENT: undefined,
      CLAUDECODE: undefined,
      CLAUDE_CODE_ENTRYPOINT: undefined,
      CODEX_SANDBOX: undefined,
      WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
    };
    const started = spawnSync(process.execPath, arguments_, {
      cwd: repository,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(started.status, 0, started.stderr);
    const output = JSON.parse(started.stdout) as {
      result: {
        investigation: {
          investigationId: string;
          providerInvocationId: string;
        };
      };
    };
    const investigationId = output.result.investigation.investigationId;
    const sessionPath = path.join(
      runtimeRoot(repository),
      'investigations/sessions',
      `${investigationId}.json`,
    );
    const reservationPath = path.join(
      runtimeRoot(repository),
      'investigations/refs',
      `${changeId}.investigation-start.json`,
    );
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      mandateBinding: { mandateTaskId: string; changeId: string };
    };
    const reservation = JSON.parse(
      fs.readFileSync(reservationPath, 'utf8'),
    ) as {
      invocationId: string;
      mandateBinding: { mandateTaskId: string; changeId: string };
    };
    assert.deepEqual(session.mandateBinding, reservation.mandateBinding);
    assert.equal(reservation.mandateBinding.mandateTaskId, TASK_ID);
    assert.equal(reservation.mandateBinding.changeId, changeId);
    assert.equal(
      reservation.invocationId,
      output.result.investigation.providerInvocationId,
    );
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.codex,
      { invocations: 1, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume'],
    );

    const replayed = spawnSync(process.execPath, arguments_, {
      cwd: repository,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.codex,
      { invocations: 1, budget: 0 },
    );

    const sessionBytes = fs.readFileSync(sessionPath, 'utf8');
    const reservationBytes = fs.readFileSync(reservationPath, 'utf8');
    revokeTaskMandate(repository, TASK_ID, {
      reason: 'Stop all provider dispatch for this task.',
      signer,
    });
    const revoked = spawnSync(process.execPath, arguments_, {
      cwd: repository,
      encoding: 'utf8',
      env: environment,
    });
    assert.notEqual(revoked.status, 0);
    assert.equal(
      (JSON.parse(revoked.stderr) as { error: { code: string } }).error.code,
      'TASK_MANDATE_REVOKED',
    );
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBytes);
    assert.equal(fs.readFileSync(reservationPath, 'utf8'), reservationBytes);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'revoke', 'error'],
    );
    assert.equal(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.at(-1)
        ?.event.errorCode,
      'TASK_MANDATE_REVOKED',
    );
  } finally {
    cleanupRepository(repository);
    fs.rmSync(keyDirectory, { recursive: true, force: true });
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

test('Survey retry consumes one durable mandate reservation and revoked dispatch replay fails closed', () => {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-retry-key-'),
  );
  const { privateKey, trustedSigner } = generateSigningKey(keyDirectory);
  const repository = prepareRepository(trustedSigner);
  const signer = realSigningProvider(privateKey);
  const changeId = 'mandated-survey-retry';
  try {
    authorizeTaskMandate(repository, request(changeId, 2), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: new Date(),
      signer,
    });
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Exercise exact mandate accounting across Survey retry.',
        sourceRefs: [],
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        taskMandateId: TASK_ID,
        taskMandateValidation: { signer },
      },
    );
    assert.ok(started.investigation);
    const afterMain = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(started.investigation, {
        reference: 'mandated-survey-retry-main-terms',
        terms: [
          {
            kind: 'literal-path',
            value: 'src/.gitkeep',
            rationale: 'The retry remains bound to the same repository survey.',
            expectedRelationship:
              'The replacement must preserve the first Survey scope.',
          },
        ],
      }),
    );
    assert.ok(afterMain.investigation);
    const paths = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const firstInvocationId = afterMain.investigation.providerInvocationId;
    const firstClaim = claimProviderInvocation(paths, firstInvocationId, {
      workerId: 'mandated-retry-first-failure',
      leaseDurationMs: 1_000,
    });
    failProviderInvocation(paths, firstInvocationId, {
      expectedRevision: firstClaim.record.revision,
      leaseGeneration: firstClaim.record.leaseGeneration,
      leaseToken: firstClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'First Survey attempt failed.',
      },
    });
    const failed = getProposeStatus(
      repository,
      afterMain.investigation.investigationId,
    );
    const retryEnvelope = createProviderRetryEnvelope(repository, failed, {
      acknowledgeProviderCost: true,
    });
    const retried = resumePropose(repository, changeId, retryEnvelope);
    assert.ok(retried.investigation);
    const secondInvocationId = retried.investigation.providerInvocationId;
    assert.notEqual(secondInvocationId, firstInvocationId);
    const reservation = readProviderRetryReservation(
      paths,
      retried.investigation.investigationId,
      2,
    );
    assert.equal(reservation?.schemaVersion, 2);
    if (reservation?.schemaVersion !== 2) {
      assert.fail('Expected a v2 provider retry reservation.');
    }
    assert.deepEqual(
      reservation.mandateBinding,
      readProviderInvocation(paths, secondInvocationId).mandateBinding,
    );
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.codex,
      { invocations: 2, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'grant-consume'],
    );

    const dispatched: string[] = [];
    const replayed = resumePropose(repository, changeId, retryEnvelope, {
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.equal(
      replayed.investigation?.providerInvocationId,
      secondInvocationId,
    );
    assert.deepEqual(dispatched, [secondInvocationId]);
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.codex,
      { invocations: 2, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'grant-consume', 'provider-invocation'],
    );

    const sessionPath = path.join(
      paths.sessions,
      `${retried.investigation.investigationId}.json`,
    );
    const reservationPath = path.join(
      paths.refs,
      `${retried.investigation.investigationId}.provider-retry-2.json`,
    );
    const sessionBytes = fs.readFileSync(sessionPath, 'utf8');
    const reservationBytes = fs.readFileSync(reservationPath, 'utf8');
    revokeTaskMandate(repository, TASK_ID, {
      reason: 'Stop the prepared retry before another provider dispatch.',
      signer,
    });
    assert.throws(
      () =>
        resumePropose(repository, changeId, retryEnvelope, {
          providerDispatcher(_cwd, invocationId) {
            dispatched.push(invocationId);
          },
        }),
      (error) => isWorkflowError(error, 'TASK_MANDATE_REVOKED'),
    );
    assert.deepEqual(dispatched, [secondInvocationId]);
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBytes);
    assert.equal(fs.readFileSync(reservationPath, 'utf8'), reservationBytes);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      [
        'task-mandate',
        'grant-consume',
        'grant-consume',
        'provider-invocation',
        'revoke',
      ],
    );
  } finally {
    cleanupRepository(repository);
    fs.rmSync(keyDirectory, { recursive: true, force: true });
  }
});

test('exempt PlanReview inherits the durable mandate and audits one fail-closed provider dispatch', () => {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-plan-review-key-'),
  );
  const { privateKey, trustedSigner } = generateSigningKey(keyDirectory);
  const repository = prepareRepository(trustedSigner);
  const signer = realSigningProvider(privateKey);
  const changeId = 'mandated-plan-review';
  try {
    authorizeTaskMandate(repository, request(changeId, 2), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: new Date(),
      signer,
    });
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/WORKFLOW.md'),
      '# Workflow\n\nUse the managed workflow.\n',
    );
    git(repository, ['add', 'docs/WORKFLOW.md']);
    git(repository, ['commit', '-m', 'Add PlanReview target']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        kind: 'investigation-exemption-request',
        intent: {
          schemaVersion: 1,
          summary: 'Clarify the workflow documentation wording.',
          sourceRefs: [],
          explicitPaths: ['docs/WORKFLOW.md'],
          explicitSymbols: [],
          explicitConfigKeys: [],
          renamePairs: [],
        },
        exemption: {
          category: 'documentation-only',
          declaredPaths: ['docs/WORKFLOW.md'],
          declaredChangeClasses: ['documentation-only'],
          rationale:
            'The change edits documentation wording and does not rely on runtime behavior.',
          semanticAuthor: {
            id: 'codex',
            provenance: 'runtime-hint:codex',
          },
          nonTrivialBehaviorReliance: 'none-declared',
          researchBudgetMinutes: null,
        },
      },
      {
        explicitActor: 'codex',
        environment: {},
        taskMandateId: TASK_ID,
        taskMandateValidation: { signer },
      },
    );
    assert.equal(started.state, 'awaiting-planning-contribution');
    assert.ok(started.investigation);
    const planningInput = createPlanningContributionEnvelope(started, {
      proposal: '# Proposal\n\nClarify workflow documentation.\n',
      design: '# Design\n\nUpdate documentation wording only.\n',
      specs: [
        {
          path: 'specs/demo/spec.md',
          content: [
            '# Delta',
            '',
            '## ADDED Requirements',
            '',
            '### Requirement: Workflow wording',
            '',
            'The documentation SHALL describe the managed workflow clearly.',
            '',
            '#### Scenario: Maintainer reads the workflow',
            '',
            '- **WHEN** the maintainer opens the workflow guide',
            '- **THEN** the managed transition wording is explicit',
            '',
          ].join('\n'),
        },
      ],
      tasks: '# Tasks\n\n- [ ] 1.1 Clarify workflow documentation\n',
      guard: {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['docs/WORKFLOW.md'],
            requiredChecks: ['fixture'],
          },
        },
      },
      executionTasks: {
        '1.1': {
          strategy: 'direct-reviewed',
          enforcement: 'available',
          allowedPaths: ['docs/WORKFLOW.md'],
          requiredChecks: ['fixture'],
          diffReview: 'policy-required',
          exemptionKind: 'documentation-only',
          exemptionReason:
            'The task edits documentation only and changes no runtime behavior.',
        },
      },
    });
    const materialized = resumePropose(repository, changeId, planningInput);
    assert.equal(materialized.state, 'waiting-for-plan-review');
    assert.ok(materialized.investigation);
    assert.ok(materialized.planReview);
    const context = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const owner = readProposeExemptionSession(
      context,
      materialized.investigation.investigationId,
    );
    const invocation = readProviderInvocation(
      context,
      materialized.planReview.invocationId,
    );
    assert.deepEqual(invocation.mandateBinding, owner.mandateBinding);
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.codex,
      { invocations: 1, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume'],
    );

    const dispatched: string[] = [];
    resumePropose(repository, changeId, planningInput, {
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.deepEqual(dispatched, [materialized.planReview.invocationId]);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'provider-invocation'],
    );

    const firstReviewClaim = claimProviderInvocation(
      context,
      materialized.planReview.invocationId,
      {
        workerId: 'mandated-plan-review-first-failure',
        leaseDurationMs: 1_000,
      },
    );
    failProviderInvocation(context, materialized.planReview.invocationId, {
      expectedRevision: firstReviewClaim.record.revision,
      leaseGeneration: firstReviewClaim.record.leaseGeneration,
      leaseToken: firstReviewClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'First PlanReview attempt failed.',
      },
    });
    const failedReview = getProposeStatus(
      repository,
      materialized.investigation.investigationId,
    );
    const reviewRetryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      failedReview,
      { acknowledgeProviderCost: true },
    );
    const retriedReview = resumePropose(
      repository,
      changeId,
      reviewRetryEnvelope,
    );
    assert.ok(retriedReview.planReview);
    const retryInvocationId = retriedReview.planReview.invocationId;
    assert.notEqual(retryInvocationId, materialized.planReview.invocationId);
    assert.deepEqual(
      readProviderInvocation(context, retryInvocationId).mandateBinding,
      owner.mandateBinding,
    );
    assert.deepEqual(
      inspectTaskMandate(repository, TASK_ID).providerUsage.codex,
      { invocations: 2, budget: 0 },
    );
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      ['task-mandate', 'grant-consume', 'provider-invocation', 'grant-consume'],
    );
    resumePropose(repository, changeId, reviewRetryEnvelope, {
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.deepEqual(dispatched, [
      materialized.planReview.invocationId,
      retryInvocationId,
    ]);

    revokeTaskMandate(repository, TASK_ID, {
      reason: 'Stop PlanReview dispatch.',
      signer,
    });
    assert.throws(
      () =>
        resumePropose(repository, changeId, reviewRetryEnvelope, {
          providerDispatcher(_cwd, invocationId) {
            dispatched.push(invocationId);
          },
        }),
      (error) => isWorkflowError(error, 'TASK_MANDATE_REVOKED'),
    );
    assert.deepEqual(dispatched, [
      materialized.planReview.invocationId,
      retryInvocationId,
    ]);
    assert.deepEqual(
      showAuthorityAuditTask(auditScope(repository), TASK_ID).events.map(
        ({ event }) => event.eventType,
      ),
      [
        'task-mandate',
        'grant-consume',
        'provider-invocation',
        'grant-consume',
        'provider-invocation',
        'revoke',
      ],
    );
  } finally {
    cleanupRepository(repository);
    fs.rmSync(keyDirectory, { recursive: true, force: true });
  }
});
