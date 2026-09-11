import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareAndSwapEvidenceRefsDocument,
  readInvestigationEvidenceRefsClosure,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { createInvestigationCheckpointEnvelope } from '../src/adapters/planning/investigation/investigation-session.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  createPlanReviewRetryEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
  startProposeFromFile,
} from '../src/composition-root/propose-production.ts';
import { readCurrentProposeExemptionSession } from '../src/runtime/storage-journal/propose-exemption-store.ts';
import { readPlanReviewNode } from '../src/modules/assurance/plan-review.ts';
import { type ProviderRunnerReport } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { renderPlanningProviderBinding } from '../src/modules/planning-provider/planning-provider-binding.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import {
  fakeRunnerReport,
  mainTerm,
  runWorkflowCli,
  assertTrackedInvestigationManifestPublication,
} from './investigation-session-fixture.ts';

test('structured investigation exemption starts a durable planning branch without manufactured survey evidence', () => {
  const repository = createFixtureRepository();
  const changeId = 'documentation-exemption';
  try {
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/WORKFLOW.md'),
      '# Workflow\n\nUse the managed workflow.\n',
    );
    git(repository, ['add', 'docs/WORKFLOW.md']);
    git(repository, ['commit', '-m', 'Add workflow documentation']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const providerBindingPath = path.join(
      repository,
      'workflow/change-providers',
      `${changeId}.json`,
    );
    fs.mkdirSync(path.dirname(providerBindingPath), { recursive: true });
    fs.writeFileSync(
      providerBindingPath,
      renderPlanningProviderBinding({
        schemaVersion: 1,
        changeId,
        providerId: 'openspec',
        adapterContractVersion: 1,
        providerRequirement: {
          package: '@fission-ai/openspec',
          version: '1.6.0',
        },
        planningRoot: `openspec/changes/${changeId}`,
      }),
    );
    let providerRuns = 0;
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
        providerDriver: () => {
          providerRuns += 1;
        },
      },
    );

    assert.equal(started.state, 'awaiting-planning-contribution');
    assert.equal(started.nextAction, 'submit-planning-contribution');
    assert.equal(started.investigation?.state, 'investigation-exempt');
    assert.match(
      started.investigation?.investigationId ?? '',
      /^investigation-exemption-[0-9a-f]{64}$/,
    );
    assert.equal(providerRuns, 0);
    assert.deepEqual(started.work, {
      termSources: { engine: 0, main: 0, reviewer: 0, survey: 0 },
      groups: [],
      fullBlobManifest: [],
      authoredInstructions: started.work?.authoredInstructions,
    });
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'investigations/invocations'),
      ),
      false,
    );

    const investigation = JSON.parse(
      fs.readFileSync(
        path.join(
          repository,
          'openspec/changes',
          changeId,
          'investigation.json',
        ),
        'utf8',
      ),
    ) as {
      schemaVersion: number;
      kind: string;
      repositoryId: string;
      changeId: string;
      investigationId: string;
      manifestDigest: string;
      investigationApproval: { investigationTargetDigest: string };
      applicability: { kind: string; category: string };
    };
    assert.equal(investigation.schemaVersion, 3);
    assert.equal(investigation.kind, 'manifest-first-investigation');
    assert.match(investigation.manifestDigest, /^[0-9a-f]{64}$/);
    assert.equal(investigation.applicability.kind, 'exemption');
    assert.equal(investigation.applicability.category, 'documentation-only');
    assert.equal(
      Object.hasOwn(investigation.applicability, 'replayContract'),
      false,
    );
    assertTrackedInvestigationManifestPublication(
      repository,
      changeId,
      investigation,
    );

    const replayed = startPropose(
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
      { explicitActor: 'codex', environment: {} },
    );
    assert.equal(
      replayed.investigation?.investigationId,
      started.investigation?.investigationId,
    );

    const planningInput = createPlanningContributionEnvelope(started, {
      proposal: '# Proposal\n\nClarify workflow documentation.\n',
      design: '# Design\n\nThis change updates documentation wording only.\n',
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
    assert.equal(planningInput.kind, 'exemption-planning-contribution');
    assert.equal(Object.hasOwn(planningInput, 'blindManifestDigest'), false);
    const materialized = resumePropose(repository, changeId, planningInput);
    assert.equal(materialized.state, 'waiting-for-plan-review');
    assert.equal(materialized.planReview?.providerId, 'codex');
    const exemptionRuntime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const ordinaryReviewRequest = readProviderInvocationRequest(
      exemptionRuntime,
      materialized.planReview!.invocationId,
    );
    assert.equal(
      ordinaryReviewRequest.roleAssignment.requiredIndependence,
      'session-independent',
    );
    assert.equal(
      ordinaryReviewRequest.roleAssignment.achievedIndependence,
      'session-independent',
    );
    assert.notEqual(
      ordinaryReviewRequest.roleAssignment.sessionId,
      `plan-author-${materialized.investigation!.investigationId}`,
    );
    assert.equal('grantId' in ordinaryReviewRequest.roleAssignment, false);
    assert.equal(
      fs
        .readFileSync(
          path.join(repository, 'openspec/changes', changeId, 'design.md'),
          'utf8',
        )
        .includes('workflow:investigation-ledger'),
      false,
    );

    let reviewOutput = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );
    const initialExemptionReviewInvocationId =
      reviewOutput.planReview!.invocationId;
    runProviderWorker(repository, initialExemptionReviewInvocationId, {
      runner(input): ProviderRunnerReport {
        return fakeRunnerReport(
          input.request,
          {
            verdict: 'advisory-approve',
            scopeEvidence: [],
            findings: [
              {
                severity: 'medium',
                category: 'missing-scope',
                summary:
                  'Confirm the declared documentation scope has no runtime behavior dependency.',
                evidence: [
                  {
                    kind: 'repository-location',
                    path: 'docs/WORKFLOW.md',
                    line: 1,
                    observation:
                      'The declared target is a tracked Markdown workflow guide.',
                  },
                ],
              },
            ],
            proposedTerms: [],
            suggestions: [],
            residualRisk:
              'The reviewer cannot prove that prose has no indirect behavioral consequence.',
            uncertainty:
              'This intentionally omits scope evidence to exercise native validator failure recovery.',
          },
          input.invocationDirectory,
        );
      },
    });
    const nativeValidationFailure = readProviderInvocation(
      exemptionRuntime,
      initialExemptionReviewInvocationId,
    );
    assert.equal(nativeValidationFailure.state, 'failed');
    assert.equal(nativeValidationFailure.failure?.kind, 'retryable');
    assert.equal(
      nativeValidationFailure.failure?.code,
      'PROVIDER_INVOCATION_RESULT_INVALID',
    );
    const nativeValidationFailureBytes = fs.readFileSync(
      path.join(
        exemptionRuntime.invocations,
        initialExemptionReviewInvocationId,
        'state.json',
      ),
      'utf8',
    );
    const failedExemptionReview = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );
    const exemptionRetryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      failedExemptionReview,
      { acknowledgeProviderCost: true },
    );
    const currentExemptionClosure = readInvestigationEvidenceRefsClosure(
      exemptionRuntime,
      changeId,
    );
    const withoutCurrentExemption = {
      ...currentExemptionClosure.snapshot.refs!,
    };
    delete withoutCurrentExemption['propose/exemption-session'];
    const invocationCountBeforeStaleExemptionRetry = fs
      .readdirSync(exemptionRuntime.invocations)
      .filter((entry) => entry.startsWith('invocation-')).length;
    const displacedExemptionSnapshot = compareAndSwapEvidenceRefsDocument(
      exemptionRuntime,
      {
        changeId,
        expectedDigest: currentExemptionClosure.snapshot.digest!,
        nextRefs: withoutCurrentExemption,
      },
    );
    assert.throws(
      () => resumePropose(repository, changeId, exemptionRetryEnvelope),
      (error) => isWorkflowError(error, 'PROPOSE_INPUT_STALE'),
    );
    assert.equal(
      fs
        .readdirSync(exemptionRuntime.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      invocationCountBeforeStaleExemptionRetry,
    );
    compareAndSwapEvidenceRefsDocument(exemptionRuntime, {
      changeId,
      expectedDigest: displacedExemptionSnapshot.digest,
      nextRefs: currentExemptionClosure.snapshot.refs!,
    });
    reviewOutput = resumePropose(repository, changeId, exemptionRetryEnvelope);
    assert.notEqual(
      reviewOutput.planReview!.invocationId,
      initialExemptionReviewInvocationId,
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          exemptionRuntime.invocations,
          initialExemptionReviewInvocationId,
          'state.json',
        ),
        'utf8',
      ),
      nativeValidationFailureBytes,
    );
    const reviewWorker = runProviderWorker(
      repository,
      reviewOutput.planReview!.invocationId,
      {
        runner(input): ProviderRunnerReport {
          return fakeRunnerReport(
            input.request,
            {
              verdict: 'advisory-approve',
              scopeEvidence: [
                {
                  kind: 'repository-location',
                  path: 'docs/WORKFLOW.md',
                  line: 1,
                  observation:
                    'The declared target is a tracked Markdown workflow guide.',
                },
              ],
              findings: [
                {
                  severity: 'medium',
                  category: 'missing-scope',
                  summary:
                    'Confirm the declared documentation scope has no runtime behavior dependency.',
                  evidence: [
                    {
                      kind: 'repository-location',
                      path: 'docs/WORKFLOW.md',
                      line: 1,
                      observation:
                        'The declared target is a tracked Markdown workflow guide.',
                    },
                  ],
                },
              ],
              proposedTerms: [],
              suggestions: [],
              residualRisk:
                'The reviewer cannot prove that prose has no indirect behavioral consequence.',
              uncertainty:
                'Eligibility remains an advisory semantic judgment over exact tracked scope.',
            },
            input.invocationDirectory,
          );
        },
      },
    );
    assert.equal(
      reviewWorker.state,
      'succeeded',
      JSON.stringify(reviewWorker.failure),
    );
    const awaitingDisposition = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(
          repository,
          materialized.investigation!.investigationId,
        ),
      ),
    );
    assert.equal(
      awaitingDisposition.state,
      'awaiting-challenge-dispositions',
      JSON.stringify(awaitingDisposition.planReview?.failure),
    );
    const admittedInvocationId = awaitingDisposition.planReview!.invocationId;
    const displacedAdmittedInvocationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'admitted-plan-review-retry-'),
    );
    fs.renameSync(
      path.join(exemptionRuntime.invocations, admittedInvocationId),
      path.join(displacedAdmittedInvocationRoot, admittedInvocationId),
    );
    let postAdmissionDispatches = 0;
    assert.throws(
      () =>
        resumePropose(repository, changeId, exemptionRetryEnvelope, {
          providerDriver() {
            postAdmissionDispatches += 1;
          },
        }),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_RETRY_INPUT_STALE'),
    );
    assert.equal(postAdmissionDispatches, 0);
    assert.equal(
      fs.existsSync(
        path.join(exemptionRuntime.invocations, admittedInvocationId),
      ),
      false,
    );
    fs.renameSync(
      path.join(displacedAdmittedInvocationRoot, admittedInvocationId),
      path.join(exemptionRuntime.invocations, admittedInvocationId),
    );
    fs.rmSync(displacedAdmittedInvocationRoot, { recursive: true });
    const trackedPlanReview = JSON.parse(
      fs.readFileSync(
        path.join(repository, 'openspec/changes', changeId, 'plan-review.json'),
        'utf8',
      ),
    );
    const reviewNode = trackedPlanReview.nodes.find(
      (node: { type: string }) => node.type === 'plan-review',
    );
    const challengeId = readPlanReviewNode(reviewNode).findings[0]!.findingId;
    const completed = resumePropose(
      repository,
      changeId,
      createPlanReviewDispositionsEnvelope(awaitingDisposition, [
        {
          challengeId,
          decision: 'mitigated',
          rationale:
            'The task scope and execution exemption are limited to the tracked workflow guide.',
          author: 'codex',
        },
      ]),
    );
    assert.equal(completed.state, 'planning-complete');
    assert.equal(
      completed.planningTransition?.planningAssurance?.applicabilityKind,
      'investigation-exemption',
    );
    assert.equal(
      git(repository, [
        'log',
        '-1',
        '--format=%(trailers:key=Transition,valueonly)',
      ]).trim(),
      'plan',
    );
    assert.equal(
      readCurrentProposeExemptionSession(
        investigationRuntimePaths(
          discoverRepository(repository).gitCommonDirectory,
          'workflow-engine',
        ),
        changeId,
      ),
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('propose CLI persists a fake-backed wait for read-only status in a fresh process', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-propose-cli-'),
  );
  const changeId = 'cli-investigation';
  let mandate: ReturnType<typeof prepareExecutionMandate> | undefined;
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    mandate = prepareExecutionMandate(repository, changeId);
    const intentPath = path.join(inputDirectory, 'intent.json');
    fs.writeFileSync(
      intentPath,
      JSON.stringify({
        schemaVersion: 1,
        summary: 'Inspect the fixture through the durable CLI wrapper.',
        sourceRefs: [],
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      }),
    );

    const started = runWorkflowCli(
      repository,
      [
        'propose',
        changeId,
        '--intent',
        intentPath,
        '--mandate',
        mandate.taskId,
        '--actor',
        'codex',
      ],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(started.status, 0, started.stderr);
    const startedPayload = JSON.parse(started.stdout);
    assert.equal(startedPayload.result.state, 'awaiting-main-terms');
    const investigationId = startedPayload.result.investigation.investigationId;
    const revision = startedPayload.result.investigation.revision;
    assert.equal(
      startedPayload.result.investigation.provider.state,
      'prepared',
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes', changeId)),
      false,
    );
    const sessionFile = path.join(
      runtimeRoot(repository),
      'investigations/sessions',
      `${investigationId}.json`,
    );
    const sessionBytes = fs.readFileSync(sessionFile, 'utf8');
    const sessionMtime = fs.statSync(sessionFile).mtimeMs;

    const beforeStatus = git(repository, ['status', '--porcelain=v1']);
    const status = runWorkflowCli(repository, ['status', investigationId], {});
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(
      statusPayload.result.investigation.investigationId,
      investigationId,
    );
    assert.equal(statusPayload.result.investigation.revision, revision);
    assert.equal(statusPayload.result.state, 'awaiting-main-terms');
    assert.equal(git(repository, ['status', '--porcelain=v1']), beforeStatus);
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), sessionBytes);
    assert.equal(fs.statSync(sessionFile).mtimeMs, sessionMtime);
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', `${changeId}.lock`),
      ),
      false,
    );

    const mainTermsPath = path.join(inputDirectory, 'main-terms.json');
    fs.writeFileSync(
      mainTermsPath,
      JSON.stringify(
        createInvestigationCheckpointEnvelope(
          startedPayload.result.investigation,
          {
            reference: 'cli-main-survey',
            terms: [mainTerm('CliMainNeedle')],
          },
        ),
      ),
    );
    const resumed = runWorkflowCli(
      repository,
      ['propose', changeId, '--resume', '--input', mainTermsPath],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedPayload = JSON.parse(resumed.stdout);
    assert.equal(resumedPayload.result.state, 'waiting-for-provider');
    assert.equal(resumedPayload.result.investigation.revision, revision + 1);
    assert.equal(
      resumedPayload.result.investigation.providerInvocationId,
      startedPayload.result.investigation.providerInvocationId,
    );
    assert.equal(
      fs
        .readdirSync(
          path.join(runtimeRoot(repository), 'investigations/invocations'),
        )
        .filter((name) => name.startsWith('invocation-')).length,
      1,
    );
    const afterResumeStatus = runWorkflowCli(
      repository,
      ['status', investigationId],
      {},
    );
    assert.equal(afterResumeStatus.status, 0, afterResumeStatus.stderr);
    assert.deepEqual(
      JSON.parse(afterResumeStatus.stdout).result.investigation,
      resumedPayload.result.investigation,
    );

    const reorderedReplay = runWorkflowCli(
      repository,
      [
        'propose',
        changeId,
        '--actor',
        'codex',
        '--mandate',
        mandate.taskId,
        '--intent',
        intentPath,
      ],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(reorderedReplay.status, 0, reorderedReplay.stderr);
    assert.equal(
      JSON.parse(reorderedReplay.stdout).result.investigation.investigationId,
      investigationId,
    );

    for (const args of [
      ['propose', changeId, '--resume', '--input'],
      ['propose', changeId, '--intent', intentPath, '--actor'],
    ]) {
      const rejected = runWorkflowCli(repository, args, {});
      assert.equal(rejected.status, 2);
      assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_USAGE');
    }
  } finally {
    mandate?.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

test('propose resolves actor before runtime creation and safely bounds caller files', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-propose-input-'),
  );
  const changeId = 'actor-investigation';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const intent = {
      schemaVersion: 1 as const,
      summary: 'Inspect actor and input safety.',
      sourceRefs: [],
      explicitPaths: ['src/.gitkeep'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    };
    const unresolved = startPropose(repository, changeId, intent, {
      environment: {},
    });
    assert.equal(unresolved.state, 'actor-resolution-required');
    assert.equal(
      unresolved.actorResolution?.outcome,
      'actor-resolution-required',
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);

    const conflicting = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: { CLAUDECODE: '1' },
    });
    assert.equal(conflicting.state, 'actor-resolution-required');
    assert.equal(
      conflicting.actorResolution?.outcome === 'actor-resolution-required'
        ? conflicting.actorResolution.code
        : null,
      'ACTOR_IDENTITY_CONFLICT',
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);

    const intentPath = path.join(inputDirectory, 'intent.json');
    fs.writeFileSync(intentPath, JSON.stringify(intent));
    const symlinkPath = path.join(inputDirectory, 'intent-link.json');
    fs.symlinkSync(intentPath, symlinkPath);
    assert.throws(
      () =>
        startProposeFromFile(repository, changeId, symlinkPath, {
          explicitActor: 'codex',
          environment: {},
        }),
      (error) => isWorkflowError(error, 'PROPOSE_INPUT_FILE_INVALID'),
    );

    const oversizedPath = path.join(inputDirectory, 'oversized.json');
    fs.writeFileSync(oversizedPath, ' '.repeat(4 * 1024 * 1024 + 1));
    assert.throws(
      () =>
        startProposeFromFile(repository, changeId, oversizedPath, {
          explicitActor: 'codex',
          environment: {},
        }),
      (error) => isWorkflowError(error, 'PROPOSE_INPUT_FILE_INVALID'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

test('propose rejects unknown current Source references before durable workspace creation', () => {
  const repository = createFixtureRepository();
  const changeId = 'unknown-source-reference';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const runtimeBefore = fs.existsSync(runtimeRoot(repository));
    const refsBefore = git(repository, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
    ]);

    assert.throws(
      () =>
        startPropose(
          repository,
          changeId,
          {
            schemaVersion: 1,
            summary: 'Reject an unknown current Source before any write.',
            sourceRefs: [`SRC-${'f'.repeat(64)}`],
            explicitPaths: ['src/.gitkeep'],
            explicitSymbols: [],
            explicitConfigKeys: [],
            renamePairs: [],
          } as never,
          { explicitActor: 'codex', environment: {} },
        ),
      (error) => isWorkflowError(error, 'GOVERNANCE_INTAKE_INVALID'),
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), runtimeBefore);
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes', changeId)),
      false,
    );
    assert.equal(
      git(repository, ['for-each-ref', '--format=%(refname) %(objectname)']),
      refsBefore,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
