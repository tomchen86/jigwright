import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareAndSwapEvidenceRefsDocument,
  readEvidenceNode,
  readInvestigationEvidenceRefsClosure,
  writeEvidenceNode,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import {
  canonicalEvidenceNodeEnvelope,
  createEvidenceNode,
  type EvidenceNode,
} from '../src/foundation/evidence-node/evidence-node.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createInvestigationCheckpointEnvelope,
  getInvestigationStatus,
} from '../src/adapters/planning/investigation/investigation-session.ts';
import {
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
} from '../src/composition-root/propose-production.ts';
import { planningInvestigationRoleResultDependency } from '../src/modules/assurance/planning-assurance-validator.ts';
import { type ProviderRunnerReport } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import {
  compareAndSwapInvestigationSession,
  readInvestigationSession,
} from '../src/runtime/storage-journal/investigation-session-records.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { isWorkflowError } from './fixture.ts';
import {
  fakeRunnerReport,
  runReviewerReconciliationCrashChild,
  listReviewerReconciliationTemporaries,
  listInvestigationPublicationCandidates,
  whyAnswer,
} from './investigation-session-fixture.ts';
import {
  createRetriedPlanReviewFixture,
  createReopenedProposeFixture,
} from './investigation-propose-flow-fixture.ts';

test('reopens reviewer scope and rejects retired reviewer evidence', async (t) => {
  let {
    repository,
    changeId,
    initialGroupIds,
    trackedInvestigation,
    materialized,
    reviewerRuntime,
    secondRetryEnvelope,
    secondReplacementInvocationId,
  } = createRetriedPlanReviewFixture();
  try {
    const reviewOutput = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    const surveyRoleResult =
      trackedInvestigation.applicability.semanticDelta.investigationRoleResults.find(
        ({ role }: { role: string }) => role === 'reviewer-pre-anchor',
      );

    assert.ok(surveyRoleResult);

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

    assert.equal(
      preAnchorReviewWorker.state,
      'succeeded',
      JSON.stringify(preAnchorReviewWorker.failure),
    );

    const succeededReviewStatus = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    assert.equal(
      succeededReviewStatus.planReview?.state,
      'succeeded',
      JSON.stringify(succeededReviewStatus.planReview),
    );

    const reopened = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(succeededReviewStatus),
    );

    assert.equal(reopened.state, 'awaiting-group-dispositions');

    assert.equal(reopened.work?.termSources.reviewer, 1);

    assert.ok((reopened.work?.groups.length ?? 0) > 0);

    assert.equal(
      reopened.work?.groups.some(({ groupId }) => initialGroupIds.has(groupId)),
      false,
    );

    assert.ok(
      reopened.work?.groups.some((group) =>
        group.paths.includes('src/investigation-target.ts'),
      ),
    );

    const firstReviewerSession = readInvestigationSession(
      reviewerRuntime,
      reopened.investigation!.investigationId,
    );

    assert.notEqual(
      firstReviewerSession.milestones.reviewerTermSourceNodeId,
      null,
    );

    const firstReviewerSource = readEvidenceNode(
      reviewerRuntime,
      firstReviewerSession.milestones.reviewerTermSourceNodeId!,
    );

    const retiredReviewerSourceOutput = structuredClone(
      firstReviewerSource.output,
    ) as Record<string, unknown>;

    delete retiredReviewerSourceOutput.previousReviewerTermSourceNodeId;

    delete retiredReviewerSourceOutput.authorizationResolutionNodeId;

    const retiredReviewerSource = createEvidenceNode({
      type: firstReviewerSource.type,
      nodeSchema: 'investigation.reviewer-term-source.v2',
      evaluator: 'workflow-propose.reviewer-term-source.v2',
      policyDigest: firstReviewerSource.policyDigest,
      exactInputDigests: firstReviewerSource.exactInputDigests,
      semanticParentResultDigests:
        firstReviewerSource.semanticParentResultDigests,
      provenanceParentNodeIds: firstReviewerSource.provenanceParentNodeIds,
      outputSchema: 'investigation.reviewer-term-source-output.v2',
      output: retiredReviewerSourceOutput,
      runtimeMetadata: firstReviewerSource.runtimeMetadata,
    });

    writeEvidenceNode(reviewerRuntime, retiredReviewerSource);

    const retiredReviewerSession = compareAndSwapInvestigationSession(
      reviewerRuntime,
      firstReviewerSession.investigationId,
      firstReviewerSession.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        milestones: {
          ...current.milestones,
          reviewerTermSourceNodeId: retiredReviewerSource.nodeId,
          groupDispositions: null,
          whyAnswers: null,
        },
        updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
      }),
    );

    const retiredReviewerSourcePath = path.join(
      reviewerRuntime.objects,
      retiredReviewerSource.nodeId.slice(0, 2),
      `${retiredReviewerSource.nodeId}.json`,
    );

    const reviewerSessionPath = path.join(
      reviewerRuntime.sessions,
      `${retiredReviewerSession.investigationId}.json`,
    );

    const reviewerRefNames = fs.readdirSync(reviewerRuntime.refs).sort();

    const reviewerRefBytes = reviewerRefNames.map((name) =>
      fs.readFileSync(path.join(reviewerRuntime.refs, name)),
    );

    const retiredReviewerSourceBytes = fs.readFileSync(
      retiredReviewerSourcePath,
    );

    const retiredReviewerSessionBytes = fs.readFileSync(reviewerSessionPath);

    await t.test(
      'reviewer-term source loading rejects an authentic retired V2 envelope without fallback or rewrite',
      () => {
        assert.throws(
          () =>
            getProposeStatus(
              repository,
              retiredReviewerSession.investigationId,
            ),
          (error: unknown) =>
            isWorkflowError(error, 'UNSUPPORTED_SCHEMA_VERSION'),
        );
        assert.deepEqual(
          fs.readFileSync(retiredReviewerSourcePath),
          retiredReviewerSourceBytes,
        );
        assert.deepEqual(
          fs.readFileSync(reviewerSessionPath),
          retiredReviewerSessionBytes,
        );
        assert.deepEqual(
          fs.readdirSync(reviewerRuntime.refs).sort(),
          reviewerRefNames,
        );
        assert.deepEqual(
          reviewerRefNames.map((name) =>
            fs.readFileSync(path.join(reviewerRuntime.refs, name)),
          ),
          reviewerRefBytes,
        );
      },
    );

    const restoredReviewerSession = compareAndSwapInvestigationSession(
      reviewerRuntime,
      retiredReviewerSession.investigationId,
      retiredReviewerSession.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        milestones: {
          ...current.milestones,
          reviewerTermSourceNodeId: firstReviewerSource.nodeId,
          groupDispositions: null,
          whyAnswers: null,
        },
        updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
      }),
    );

    const restoredReopened = getProposeStatus(
      repository,
      restoredReviewerSession.investigationId,
    );

    assert.equal(restoredReopened.state, 'awaiting-group-dispositions');

    const reviewerReopenRefs = readInvestigationEvidenceRefsClosure(
      reviewerRuntime,
      changeId,
    ).snapshot;

    const displacedReopenedInvocationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'reopened-plan-review-retry-'),
    );

    fs.renameSync(
      path.join(reviewerRuntime.invocations, secondReplacementInvocationId),
      path.join(displacedReopenedInvocationRoot, secondReplacementInvocationId),
    );

    let reviewerReopenDispatches = 0;

    assert.throws(
      () =>
        resumePropose(repository, changeId, secondRetryEnvelope, {
          providerDriver() {
            reviewerReopenDispatches += 1;
          },
        }),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_RETRY_INPUT_STALE'),
    );

    assert.equal(reviewerReopenDispatches, 0);

    assert.equal(
      fs.existsSync(
        path.join(reviewerRuntime.invocations, secondReplacementInvocationId),
      ),
      false,
    );

    assert.deepEqual(
      readInvestigationEvidenceRefsClosure(reviewerRuntime, changeId).snapshot,
      reviewerReopenRefs,
    );

    fs.renameSync(
      path.join(displacedReopenedInvocationRoot, secondReplacementInvocationId),
      path.join(reviewerRuntime.invocations, secondReplacementInvocationId),
    );

    fs.rmSync(displacedReopenedInvocationRoot, { recursive: true });

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

    assert.equal(reviewerDispositions.state, 'awaiting-ledger-answers');

    assert.equal(reviewerDispositions.work?.fullBlobManifest.length, 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('chains successive reviewer sources and recovers reconciliation publication', async (t) => {
  let {
    repository,
    changeId,
    changeDirectory,
    reviewerRuntime,
    genuineSecondRetryNode,
    reviewOutput,
    reviewerDispositions,
  } = createReopenedProposeFixture();
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

    assert.equal(replanned.state, 'waiting-for-plan-review');

    assert.notEqual(
      replanned.planReview?.subjectDigest,
      reviewOutput.planReview?.subjectDigest,
    );

    const replannedClosure = readInvestigationEvidenceRefsClosure(
      reviewerRuntime,
      changeId,
    );

    const mismatchedReviewSnapshot = compareAndSwapEvidenceRefsDocument(
      reviewerRuntime,
      {
        changeId,
        expectedDigest: replannedClosure.snapshot.digest!,
        nextRefs: {
          ...replannedClosure.snapshot.refs!,
          'propose/plan-review-request': genuineSecondRetryNode.nodeId,
        },
      },
    );

    assert.throws(
      () =>
        getProposeStatus(repository, replanned.investigation!.investigationId),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_REQUEST_STALE'),
    );

    compareAndSwapEvidenceRefsDocument(reviewerRuntime, {
      changeId,
      expectedDigest: mismatchedReviewSnapshot.digest,
      nextRefs: replannedClosure.snapshot.refs!,
    });

    const revisedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    );

    assert.ok(
      revisedInvestigation.applicability.replayContract.termContributions.some(
        (contribution: { source?: string }) =>
          contribution.source === 'reviewer',
      ),
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

    assert.equal(secondReopened.state, 'awaiting-group-dispositions');

    assert.equal(secondReopened.work?.termSources.reviewer, 2);

    const secondReopenedSession = readInvestigationSession(
      reviewerRuntime,
      secondReopened.investigation!.investigationId,
    );

    const secondReviewerSourceNodeId =
      secondReopenedSession.milestones.reviewerTermSourceNodeId;

    assert.notEqual(secondReviewerSourceNodeId, null);

    const secondReviewerSource = readEvidenceNode(
      reviewerRuntime,
      secondReviewerSourceNodeId!,
    );

    assert.equal(
      secondReviewerSource.nodeSchema,
      'investigation.reviewer-term-source.v3',
    );

    const exactReviewerSourceOutput = secondReviewerSource.output as {
      providerResultNode: EvidenceNode;
    };

    assert.equal(
      typeof exactReviewerSourceOutput.providerResultNode.exactInputDigests
        .targetSnapshot,
      'string',
    );

    assert.equal(
      typeof exactReviewerSourceOutput.providerResultNode
        .semanticParentResultDigests.targetSnapshot,
      'string',
    );

    assert.equal(
      typeof exactReviewerSourceOutput.providerResultNode
        .provenanceParentNodeIds.targetSnapshot,
      'string',
    );

    assert.equal(
      typeof exactReviewerSourceOutput.providerResultNode.exactInputDigests
        .subject,
      'string',
    );

    const secondReviewerSourcePath = path.join(
      reviewerRuntime.objects,
      secondReviewerSource.nodeId.slice(0, 2),
      `${secondReviewerSource.nodeId}.json`,
    );

    const exactSecondReviewerSource = fs.readFileSync(secondReviewerSourcePath);

    const reviewerSourceMutations: Array<(node: EvidenceNode) => void> = [
      (node) => {
        delete node.exactInputDigests.targetSnapshot;
        delete node.semanticParentResultDigests.targetSnapshot;
        delete node.provenanceParentNodeIds.targetSnapshot;
      },
      (node) => {
        delete node.semanticParentResultDigests.targetSnapshot;
      },
      (node) => {
        node.exactInputDigests.targetSnapshot = 'f'.repeat(64);
      },
      (node) => {
        node.semanticParentResultDigests.targetSnapshot = 'f'.repeat(64);
      },
      (node) => {
        node.exactInputDigests.subject = 'f'.repeat(64);
      },
    ];

    for (const mutateProviderResultNode of reviewerSourceMutations) {
      const forgedReviewerSourceOutput = structuredClone(
        secondReviewerSource.output,
      ) as {
        providerResultNode: EvidenceNode;
      };
      mutateProviderResultNode(forgedReviewerSourceOutput.providerResultNode);
      const forgedReviewerSource = createEvidenceNode({
        type: secondReviewerSource.type,
        nodeSchema: secondReviewerSource.nodeSchema,
        evaluator: secondReviewerSource.evaluator,
        policyDigest: secondReviewerSource.policyDigest,
        exactInputDigests: secondReviewerSource.exactInputDigests,
        semanticParentResultDigests:
          secondReviewerSource.semanticParentResultDigests,
        provenanceParentNodeIds: secondReviewerSource.provenanceParentNodeIds,
        outputSchema: secondReviewerSource.outputSchema,
        output: forgedReviewerSourceOutput,
        runtimeMetadata: secondReviewerSource.runtimeMetadata,
      });
      assert.equal(forgedReviewerSource.nodeId, secondReviewerSource.nodeId);
      assert.notEqual(
        forgedReviewerSource.resultDigest,
        secondReviewerSource.resultDigest,
      );
      try {
        fs.writeFileSync(
          secondReviewerSourcePath,
          canonicalEvidenceNodeEnvelope(forgedReviewerSource),
        );
        assert.throws(
          () =>
            getProposeStatus(
              repository,
              secondReopened.investigation!.investigationId,
            ),
          (error: unknown) =>
            isWorkflowError(
              error,
              'INVESTIGATION_REVIEWER_TERM_SOURCE_INVALID',
            ),
        );
      } finally {
        fs.writeFileSync(secondReviewerSourcePath, exactSecondReviewerSource);
      }
    }

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

    assert.equal(secondReviewerDispositions.state, 'awaiting-ledger-answers');

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

    const previousInvestigation = fs.readFileSync(investigationPath, 'utf8');

    const previousDesign = fs.readFileSync(designPath, 'utf8');

    const afterInvestigationOpen = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(investigationPath),
      'after-open',
    );

    assert.equal(
      afterInvestigationOpen.signal,
      'SIGKILL',
      String(afterInvestigationOpen.stderr || afterInvestigationOpen.stdout),
    );

    assert.equal(
      fs.readFileSync(investigationPath, 'utf8'),
      previousInvestigation,
    );

    assert.equal(fs.readFileSync(designPath, 'utf8'), previousDesign);

    const duringInvestigationWrite = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(investigationPath),
      'during-write',
    );

    assert.equal(
      duringInvestigationWrite.signal,
      'SIGKILL',
      String(
        duringInvestigationWrite.stderr || duringInvestigationWrite.stdout,
      ),
    );

    assert.equal(
      fs.readFileSync(investigationPath, 'utf8'),
      previousInvestigation,
    );

    assert.equal(fs.readFileSync(designPath, 'utf8'), previousDesign);

    const beforeInvestigationRename = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(investigationPath),
      'before-rename',
    );

    assert.equal(
      beforeInvestigationRename.signal,
      'SIGKILL',
      String(
        beforeInvestigationRename.stderr || beforeInvestigationRename.stdout,
      ),
    );

    assert.equal(
      fs.readFileSync(investigationPath, 'utf8'),
      previousInvestigation,
    );

    assert.equal(fs.readFileSync(designPath, 'utf8'), previousDesign);

    const publicationCandidates =
      listInvestigationPublicationCandidates(changeDirectory);

    assert.equal(publicationCandidates.length, 1);

    assert.ok(fs.statSync(publicationCandidates[0]!).isFile());

    const afterInvestigationRename = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(investigationPath),
    );

    assert.equal(
      afterInvestigationRename.signal,
      'SIGKILL',
      String(
        afterInvestigationRename.stderr || afterInvestigationRename.stdout,
      ),
    );

    assert.notEqual(
      fs.readFileSync(investigationPath, 'utf8'),
      previousInvestigation,
    );

    assert.equal(fs.readFileSync(designPath, 'utf8'), previousDesign);

    assert.deepEqual(
      listReviewerReconciliationTemporaries(
        changeDirectory,
        'investigation.json',
      ),
      [],
    );

    fs.writeFileSync(
      designPath,
      `${previousDesign}\nunauthenticated-third-state\n`,
    );

    assert.throws(
      () => resumePropose(repository, changeId, secondWhyEnvelope),
      (error: unknown) =>
        isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
    );

    fs.writeFileSync(designPath, previousDesign);

    const afterDesignRename = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(designPath),
    );

    assert.equal(
      afterDesignRename.signal,
      'SIGKILL',
      String(afterDesignRename.stderr || afterDesignRename.stdout),
    );

    assert.notEqual(fs.readFileSync(designPath, 'utf8'), previousDesign);

    const repositoryState = discoverRepository(repository);

    const evidenceRefsPath = path.join(
      investigationRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      ).refs,
      `${changeId}.json`,
    );

    const afterReceiptAdvance = runReviewerReconciliationCrashChild(
      repository,
      changeId,
      secondWhyEnvelope,
      fs.realpathSync(evidenceRefsPath),
    );

    assert.equal(
      afterReceiptAdvance.signal,
      'SIGKILL',
      String(afterReceiptAdvance.stderr || afterReceiptAdvance.stdout),
    );

    const currentReceiptTemporary = `${investigationPath}.${process.pid}.${crypto.randomUUID()}.tmp`;

    fs.copyFileSync(investigationPath, currentReceiptTemporary);

    fs.chmodSync(currentReceiptTemporary, 0o644);

    assert.deepEqual(
      listReviewerReconciliationTemporaries(
        changeDirectory,
        'investigation.json',
      ),
      [currentReceiptTemporary],
    );

    assert.throws(
      () => resumePropose(repository, changeId, secondWhyEnvelope),
      (error: unknown) =>
        isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
    );

    assert.equal(fs.existsSync(currentReceiptTemporary), true);

    assert.equal(typeof afterReceiptAdvance.pid, 'number');

    const deadCurrentReceiptTemporary = currentReceiptTemporary.replace(
      `.${process.pid}.`,
      `.${afterReceiptAdvance.pid}.`,
    );

    fs.renameSync(currentReceiptTemporary, deadCurrentReceiptTemporary);

    const twiceReplanned = resumePropose(
      repository,
      changeId,
      secondWhyEnvelope,
    );

    assert.equal(twiceReplanned.state, 'waiting-for-plan-review');

    assert.deepEqual(
      listReviewerReconciliationTemporaries(
        changeDirectory,
        'investigation.json',
      ),
      [],
    );

    const twiceRevisedInvestigation = JSON.parse(
      fs.readFileSync(investigationPath, 'utf8'),
    );

    const reviewerTermSources =
      twiceRevisedInvestigation.applicability.replayContract.termContributions.filter(
        (contribution: { source: string }) =>
          contribution.source === 'reviewer',
      );

    assert.deepEqual(reviewerTermSources, [
      {
        source: 'reviewer',
        reference: secondReviewerSource.nodeId,
        terms: [
          { kind: 'symbol', value: 'ReviewOnlyNeedle' },
          { kind: 'symbol', value: 'SecondReviewNeedle' },
        ],
      },
    ]);

    assert.equal(twiceRevisedInvestigation.applicability.kind, 'ordinary');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
