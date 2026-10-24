/** Fresh, happy-path milestones for independently runnable propose scenarios. No tests register here. */
import fs from 'node:fs';
import path from 'node:path';
import {
  readEvidenceNode,
  readInvestigationEvidenceRefsClosure,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { createInvestigationCheckpointEnvelope } from '../src/modules/lifecycle/investigation-checkpoint-envelope.ts';
import { getInvestigationStatus } from '../src/runtime/investigation-lifecycle/investigation-session.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewProgressEnvelope,
  createPlanReviewRetryEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/composition-root/propose-production.ts';
import { captureGovernanceSource } from '../src/composition-root/governance-sources-production.ts';
import { productionRoleTopologyResolutionPort } from '../src/composition-root/role-topology-resolution-production.ts';
import { planningInvestigationRoleResultDependency } from '../src/modules/assurance/planning-assurance-validator.ts';
import { type ProviderRunnerReport } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { readInvestigationSession } from '../src/runtime/storage-journal/investigation-session-records.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import { renderPlanningProviderBinding } from '../src/modules/planning-provider/planning-provider-binding.ts';
import { claimProviderInvocation } from '../src/runtime/storage-journal/provider-invocation-workers.ts';
import {
  completeProviderInvocation,
  failProviderInvocation,
} from '../src/runtime/storage-journal/provider-invocation-completion.ts';
import { readProviderInvocationRequest } from '../src/runtime/storage-journal/provider-invocation-artifacts.ts';
import { createFixtureRepository, git } from './fixture.ts';
import { installPlanReviewAuthority } from './plan-review-authority-fixture.ts';
import {
  setFixtureProviderTimeout,
  fakeRunnerReport,
  mainTerm,
  providerWireResult,
  whyAnswer,
} from './investigation-session-fixture.ts';

export function createStartedProposeFixture() {
  const repository = createFixtureRepository();
  try {
    const reviewAuthority = installPlanReviewAuthority(repository);
    const changeId = 'fresh-investigation';
    fs.mkdirSync(path.join(repository, 'docs/archive'), { recursive: true });

    fs.mkdirSync(path.join(repository, 'docs/research'), { recursive: true });

    fs.writeFileSync(
      path.join(repository, 'docs/generated.md'),
      'EngineFloorNeedle generated projection\n',
    );

    fs.writeFileSync(
      path.join(repository, 'docs/CHANGELOG.md'),
      'EngineFloorNeedle append-only history\n',
    );

    fs.writeFileSync(
      path.join(repository, 'docs/archive/legacy.md'),
      'EngineFloorNeedle immutable archive\n',
    );

    fs.writeFileSync(
      path.join(repository, 'docs/research/reference.md'),
      'EngineFloorNeedle historical reference\n',
    );

    fs.writeFileSync(
      path.join(repository, 'workflow/document-policy.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/architecture/**': {
              mode: 'curated',
              refresh: 'reviewed-section',
            },
            'docs/features/**': {
              mode: 'curated',
              refresh: 'reviewed-section',
            },
            'docs/generated.md': { mode: 'generated' },
            'docs/CHANGELOG.md': { mode: 'append-only' },
            'docs/archive/**': { mode: 'immutable' },
            'docs/research/**': { mode: 'reference' },
          },
        },
        null,
        2,
      )}\n`,
    );

    git(repository, ['mv', 'src/.gitkeep', 'src/renamed-fixture.ts']);

    fs.writeFileSync(
      path.join(repository, 'src/investigation-target.ts'),
      [
        'export const EngineFloorNeedle = true;',
        'export const MainSurveyNeedle = true;',
        'export const BlindSurveyNeedle = true;',
        'export const ReviewOnlyNeedle = true;',
        'export const SecondReviewNeedle = true;',
        '',
      ].join('\n'),
    );

    git(repository, [
      'add',
      'src/investigation-target.ts',
      'docs',
      'workflow/document-policy.json',
      'workflow/maintainer-policy.json',
    ]);

    const planningSourceCapture = captureGovernanceSource(repository, {
      semanticAuthor: 'agent',
      capturedBy: 'codex',
      capturedAt: '2026-07-23T23:59:59.000Z',
      contextRef: 'decision:D-019',
      text: 'Retain the exact Source identity in the planning contribution.',
      supersedes: null,
    });

    const planningSource = planningSourceCapture.source;

    git(repository, ['add', planningSourceCapture.relativePath]);

    git(repository, ['commit', '-m', 'Add investigation target']);

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

    const adapterPolicyPath = path.join(
      repository,
      'workflow/ai-adapter-policy.json',
    );

    const adapterPolicyBytes = fs.readFileSync(adapterPolicyPath);

    setFixtureProviderTimeout(repository, 300_000);

    let providerRuns = 0;

    const intent = {
      schemaVersion: 1 as const,
      summary: 'Extend the investigation target without losing consumers.',
      sourceRefs: [planningSource.id],
      explicitPaths: [
        '.codex/skills/openspec-propose/SKILL.md',
        'workflow/openspec-assets/manifest.json',
      ],
      explicitSymbols: ['EngineFloorNeedle'],
      explicitConfigKeys: [],
      renamePairs: [],
    };

    const started = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: {},
      providerDriver: ({ paths, request }) => {
        providerRuns += 1;
        const claim = claimProviderInvocation(paths, request.invocationId, {
          workerId: 'fake-propose-worker',
          leaseDurationMs: 60_000,
        });
        completeProviderInvocation(paths, request.invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          outcome: {
            exitCode: 0,
            signal: null,
            timedOut: false,
            spawnErrorCode: null,
            elapsedMs: 1,
            stdout: JSON.stringify(
              providerWireResult(request, {
                reference: request.invocationId,
                terms: [{ kind: 'symbol', value: 'BlindSurveyNeedle' }],
              }),
            ),
            stderr: '',
          },
        });
      },
    });
    return {
      repository,
      reviewAuthority,
      changeId,
      planningSourceCapture,
      planningSource,
      providerBindingPath,
      adapterPolicyPath,
      adapterPolicyBytes,
      providerRuns,
      intent,
      started,
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

export function createSealedProposeFixture() {
  const fixture = createStartedProposeFixture();
  const { repository, changeId, started } = fixture;
  try {
    const mainTermsInput = createInvestigationCheckpointEnvelope(
      started.investigation!,
      {
        reference: 'main-survey',
        terms: [mainTerm('MainSurveyNeedle')],
      },
    );

    const afterMain = resumePropose(repository, changeId, mainTermsInput);

    const initialGroupIds = new Set(
      afterMain.work!.groups.map(({ groupId }) => groupId),
    );

    const afterDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(afterMain.investigation!, {
        dispositions: afterMain.work!.groups.map((group) => ({
          groupId: group.groupId,
          classification: 'load-bearing' as const,
          rationale: 'This tracked consumer is load-bearing for the change.',
          author: 'codex',
        })),
      }),
    );

    const initialManifestEntryIds = new Set(
      afterDispositions.work!.fullBlobManifest.map(
        ({ manifestEntryId }) => manifestEntryId,
      ),
    );

    const sealed = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(afterDispositions.investigation!, {
        answers: afterDispositions.work!.fullBlobManifest.map((entry) =>
          whyAnswer(entry.manifestEntryId, 'codex-b'),
        ),
      }),
    );

    const changeDirectory = path.join(repository, 'openspec/changes', changeId);

    const trackedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    );

    const runtime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    return {
      ...fixture,
      mainTermsInput,
      afterMain,
      initialGroupIds,
      afterDispositions,
      initialManifestEntryIds,
      sealed,
      changeDirectory,
      trackedInvestigation,
      runtime,
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

export function createMaterializedProposeFixture() {
  const fixture = createSealedProposeFixture();
  const { repository, changeId, sealed } = fixture;
  try {
    const planningInput = createPlanningContributionEnvelope(sealed, {
      proposal: '# Proposal\n\nAdd investigation-first behavior.\n',
      design: [
        '# Design',
        '',
        'Authored prefix.',
        '',
        '## Investigation Ledger',
        '',
        '<!-- workflow:investigation-ledger:start v1 -->',
        '',
        '<!-- workflow:investigation-ledger:end v1 -->',
        '',
        'Authored suffix.',
        '',
      ].join('\n'),
      specs: [
        {
          path: 'specs/demo/spec.md',
          content: [
            '# Delta',
            '',
            '## ADDED Requirements',
            '',
            '### Requirement: Investigation behavior',
            '',
            'The system SHALL retain investigation evidence.',
            '',
            '#### Scenario: Evidence is retained',
            '',
            '- **WHEN** planning is materialized',
            '- **THEN** the evidence remains current',
            '',
          ].join('\n'),
        },
      ],
      tasks: '# Tasks\n\n- [ ] 1.1 Add investigation behavior\n',
      guard: {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['src/**'],
            requiredChecks: ['fixture'],
          },
        },
      },
      executionTasks: {
        '1.1': {
          strategy: 'direct-reviewed',
          enforcement: 'available',
          allowedPaths: ['src/**'],
          requiredChecks: ['fixture'],
          diffReview: 'policy-required',
          exemptionKind: 'narrowly-scoped-non-behavioral',
          exemptionReason:
            'The fixture exercises planning orchestration without product behavior.',
        },
      },
    });

    const materialized = resumePropose(repository, changeId, planningInput, {
      roleTopologyResolution: productionRoleTopologyResolutionPort,
    });
    return { ...fixture, planningInput, materialized };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

export function createRetriedPlanReviewFixture() {
  const fixture = createMaterializedProposeFixture();
  const { repository, changeId, materialized } = fixture;
  try {
    const reviewerRuntime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );

    const initialReviewOutput = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    const planReviewInvocationId = initialReviewOutput.planReview!.invocationId;

    const planReviewRequest = readProviderInvocationRequest(
      reviewerRuntime,
      planReviewInvocationId,
    );

    const planReviewClaim = claimProviderInvocation(
      reviewerRuntime,
      planReviewInvocationId,
      {
        workerId: 'worker-first-plan-review-failure',
        leaseDurationMs: 1_000,
      },
    );

    failProviderInvocation(reviewerRuntime, planReviewInvocationId, {
      expectedRevision: planReviewClaim.record.revision,
      leaseGeneration: planReviewClaim.record.leaseGeneration,
      leaseToken: planReviewClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'PlanReview provider timed out.',
      },
    });

    const failedPlanReview = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    const retryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      failedPlanReview,
      { acknowledgeProviderCost: true },
    );

    setFixtureProviderTimeout(repository, 600_000);

    const retriedInvocations: string[] = [];

    const retriedReview = resumePropose(repository, changeId, retryEnvelope, {
      providerDriver({ request }) {
        retriedInvocations.push(request.invocationId);
      },
    });

    const replacementInvocationId = retriedReview.planReview!.invocationId;

    const replacementClaim = claimProviderInvocation(
      reviewerRuntime,
      replacementInvocationId,
      {
        workerId: 'worker-second-plan-review-failure',
        leaseDurationMs: 1_000,
      },
    );

    failProviderInvocation(reviewerRuntime, replacementInvocationId, {
      expectedRevision: replacementClaim.record.revision,
      leaseGeneration: replacementClaim.record.leaseGeneration,
      leaseToken: replacementClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Replacement PlanReview provider timed out.',
      },
    });

    const secondFailure = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    const secondRetryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      secondFailure,
      { acknowledgeProviderCost: true },
    );

    const secondRetriedInvocations: string[] = [];

    const secondRetry = resumePropose(
      repository,
      changeId,
      secondRetryEnvelope,
      {
        providerDriver({ request }) {
          secondRetriedInvocations.push(request.invocationId);
        },
      },
    );

    const secondReplacementInvocationId = secondRetry.planReview!.invocationId;

    const secondRetryClosure = readInvestigationEvidenceRefsClosure(
      reviewerRuntime,
      changeId,
    );

    const genuineSecondRetryNode = readEvidenceNode(
      reviewerRuntime,
      secondRetryClosure.snapshot.refs!['propose/plan-review-request']!,
    );
    return {
      ...fixture,
      reviewerRuntime,
      initialReviewOutput,
      planReviewInvocationId,
      planReviewRequest,
      planReviewClaim,
      failedPlanReview,
      retryEnvelope,
      retriedInvocations,
      retriedReview,
      replacementInvocationId,
      replacementClaim,
      secondFailure,
      secondRetryEnvelope,
      secondRetriedInvocations,
      secondRetry,
      secondReplacementInvocationId,
      secondRetryClosure,
      genuineSecondRetryNode,
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

export function createReopenedProposeFixture() {
  const fixture = createRetriedPlanReviewFixture();
  const {
    repository,
    changeId,
    trackedInvestigation,
    materialized,
    reviewerRuntime,
  } = fixture;
  try {
    const reviewOutput = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    const surveyRoleResult =
      trackedInvestigation.applicability.semanticDelta.investigationRoleResults.find(
        ({ role }: { role: string }) => role === 'reviewer-pre-anchor',
      );

    const surveyEvidence =
      planningInvestigationRoleResultDependency(surveyRoleResult);

    const preAnchorReviewWorker = runProviderWorker(
      repository,
      reviewOutput.planReview!.invocationId,
      {
        runner(input): ProviderRunnerReport {
          const semanticOutput = {
            verdict: 'advisory-approve' as const,
            scopeEvidence: [
              {
                kind: 'investigation-role-result' as const,
                role: 'reviewer-pre-anchor' as const,
                requestDigest: surveyEvidence.nodeId,
                resultDigest: surveyEvidence.resultDigest,
              },
            ],
            findings: [],
            proposedTerms: [
              { kind: 'symbol' as const, value: 'ReviewOnlyNeedle' },
            ],
            suggestions: [],
            residualRisk:
              'The exact review cannot prove semantic breadth completeness.',
            uncertainty:
              'The provider is observed read-only but not same-user confined.',
          };
          return fakeRunnerReport(
            input.request,
            semanticOutput,
            input.invocationDirectory,
          );
        },
      },
    );

    const succeededReviewStatus = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    const reopened = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(succeededReviewStatus),
    );

    const firstReviewerSession = readInvestigationSession(
      reviewerRuntime,
      reopened.investigation!.investigationId,
    );

    const firstReviewerSource = readEvidenceNode(
      reviewerRuntime,
      firstReviewerSession.milestones.reviewerTermSourceNodeId!,
    );
    const restoredReopened = reopened;
    const reviewerDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        getInvestigationStatus(
          repository,
          restoredReopened.investigation!.investigationId,
        ),
        {
          dispositions: restoredReopened.work!.groups.map((group) => ({
            groupId: group.groupId,
            classification: 'load-bearing' as const,
            rationale: 'The reviewer-expanded group remains load-bearing.',
            author: 'codex',
          })),
        },
      ),
    );
    return {
      ...fixture,
      reviewOutput,
      surveyRoleResult,
      surveyEvidence,
      preAnchorReviewWorker,
      succeededReviewStatus,
      reopened,
      firstReviewerSession,
      firstReviewerSource,
      restoredReopened,
      reviewerDispositions,
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

export function createSecondReplannedProposeFixture() {
  const fixture = createReopenedProposeFixture();
  const {
    repository,
    changeId,
    changeDirectory,
    reviewerRuntime,
    reviewerDispositions,
  } = fixture;
  try {
    const replanned = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        reviewerDispositions.investigation!,
        {
          answers: reviewerDispositions.work!.fullBlobManifest.map((entry) =>
            whyAnswer(entry.manifestEntryId),
          ),
        },
      ),
    );

    const revisedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    );

    runProviderWorker(repository, replanned.planReview!.invocationId, {
      runner(input): ProviderRunnerReport {
        return fakeRunnerReport(
          input.request,
          {
            verdict: 'advisory-approve' as const,
            scopeEvidence: [
              {
                kind: 'repository-location' as const,
                path: 'src/investigation-target.ts',
                line: 4,
                observation:
                  'The reviewer-only term is now represented in the tracked target.',
              },
            ],
            findings: [
              {
                severity: 'medium' as const,
                category: 'missing-scope',
                summary:
                  'Confirm the adjacent provider worker remains covered.',
                evidence: [
                  {
                    kind: 'repository-location' as const,
                    path: 'src/investigation-target.ts',
                    line: 4,
                    observation:
                      'The reviewer-only term is now represented in the tracked target.',
                  },
                ],
              },
            ],
            proposedTerms: [
              { kind: 'symbol' as const, value: 'SecondReviewNeedle' },
            ],
            suggestions: [],
            residualRisk:
              'The exact review cannot prove semantic breadth completeness.',
            uncertainty:
              'The provider is observed read-only but not same-user confined.',
          },
          input.invocationDirectory,
        );
      },
    });

    const secondReopened = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(repository, replanned.investigation!.investigationId),
      ),
    );

    const secondReopenedSession = readInvestigationSession(
      reviewerRuntime,
      secondReopened.investigation!.investigationId,
    );

    const secondReviewerSourceNodeId =
      secondReopenedSession.milestones.reviewerTermSourceNodeId;

    const secondReviewerSource = readEvidenceNode(
      reviewerRuntime,
      secondReviewerSourceNodeId!,
    );

    const secondReviewerDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        getInvestigationStatus(
          repository,
          secondReopened.investigation!.investigationId,
        ),
        {
          dispositions: secondReopened.work!.groups.map((group) => ({
            groupId: group.groupId,
            classification: 'load-bearing' as const,
            rationale:
              'The second reviewer-expanded group remains load-bearing.',
            author: 'codex',
          })),
        },
      ),
    );

    const secondWhyEnvelope = createInvestigationCheckpointEnvelope(
      getInvestigationStatus(
        repository,
        secondReviewerDispositions.investigation!.investigationId,
      ),
      {
        answers: secondReviewerDispositions.work!.fullBlobManifest.map(
          (entry) => whyAnswer(entry.manifestEntryId),
        ),
      },
    );

    const investigationPath = path.join(changeDirectory, 'investigation.json');

    const designPath = path.join(changeDirectory, 'design.md');

    const twiceReplanned = resumePropose(
      repository,
      changeId,
      secondWhyEnvelope,
    );

    const twiceRevisedInvestigation = JSON.parse(
      fs.readFileSync(investigationPath, 'utf8'),
    );
    return {
      ...fixture,
      replanned,
      revisedInvestigation,
      secondReopened,
      secondReopenedSession,
      secondReviewerSourceNodeId,
      secondReviewerSource,
      secondReviewerDispositions,
      secondWhyEnvelope,
      investigationPath,
      designPath,
      twiceReplanned,
      twiceRevisedInvestigation,
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}
