import { inspectReviewerTermResolutionAuthorization } from '../src/composition-root/investigation-retry-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  compareAndSwapEvidenceRefsDocument,
  readEvidenceNode,
  readInvestigationEvidenceRefsClosure,
  writeEvidenceNode,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import { createEvidenceNode } from '../src/foundation/evidence-node/evidence-node.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createInvestigationCheckpointEnvelope,
  getInvestigationStatus,
  SimulatedHumanResolutionCrash,
} from '../src/adapters/planning/investigation/investigation-session.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/composition-root/propose-production.ts';
import { type ProviderRunnerReport } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { checkpointContributionDigest } from '../src/modules/investigation/domain/investigation-checkpoint-contract.ts';
import {
  compareAndSwapInvestigationSession,
  readInvestigationSession,
} from '../src/runtime/storage-journal/investigation-session-records.ts';
import {
  inspectInvestigationQuarantineState,
  inspectInvestigationResolutionState,
} from '../src/runtime/storage-journal/human-resolution-state.ts';
import { readHumanResolutionJournal } from '../src/runtime/storage-journal/human-resolution-journal.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import { PROPOSE_POLICY_DIGEST } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import {
  writeFixtureProviderRuntime,
  grantCoreHumanResolutionAuthorizationFixture,
  executeGrantCoreHumanResolutionFixture,
  installFixtureMaintainerPolicy,
  investigationFixture,
  fakeRunnerReport,
  startFixture,
  mainTermsEnvelope,
  mainTerm,
  providerWireResult,
  whyAnswer,
  sha256,
} from './investigation-session-fixture.ts';

test('reviewer reopen limit preserves exact materialization evidence for human resolution', () => {
  const repository = createFixtureRepository();
  const changeId = 'reviewer-reopen-limit';
  try {
    installFixtureMaintainerPolicy(repository);
    fs.writeFileSync(
      path.join(repository, 'src/reviewer-reopen-target.ts'),
      [
        'export const ReviewerReopenBaseNeedle = true;',
        'export const BlindReviewerNeedle = true;',
        'export const FirstReviewerNeedle = true;',
        'export const SecondReviewerNeedle = true;',
        'export const ThirdReviewerNeedle = true;',
        'export const FourthReviewerNeedle = true;',
        '',
      ].join('\n'),
    );
    git(repository, [
      'add',
      '--',
      'src/reviewer-reopen-target.ts',
      'workflow/maintainer-policy.json',
    ]);
    git(repository, ['commit', '-m', 'Add reviewer reopen fixture']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);

    const intent = {
      schemaVersion: 1 as const,
      summary:
        'Exercise bounded reviewer-term reopening without changing planning evidence.',
      sourceRefs: [],
      explicitPaths: [],
      explicitSymbols: ['ReviewerReopenBaseNeedle'],
      explicitConfigKeys: [],
      renamePairs: [],
    };
    const started = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: {},
      providerDriver: ({ paths, request }) => {
        const claim = claimProviderInvocation(paths, request.invocationId, {
          workerId: 'reviewer-reopen-fixture-worker',
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
                terms: [{ kind: 'symbol', value: 'BlindReviewerNeedle' }],
              }),
            ),
            stderr: '',
          },
        });
      },
    });
    const afterMain = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(started.investigation!, {
        reference: 'reviewer-reopen-main-survey',
        terms: [mainTerm('ReviewerReopenBaseNeedle')],
      }),
    );
    const afterDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(afterMain.investigation!, {
        dispositions: afterMain.work!.groups.map((group) => ({
          groupId: group.groupId,
          classification: 'load-bearing' as const,
          rationale: 'The fixture group is required by the exact review path.',
          author: 'codex',
        })),
      }),
    );
    const sealed = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(afterDispositions.investigation!, {
        answers: afterDispositions.work!.fullBlobManifest.map((entry) =>
          whyAnswer(entry.manifestEntryId),
        ),
      }),
    );
    const planningInput = createPlanningContributionEnvelope(sealed, {
      proposal: '# Proposal\n\nExercise reviewer reopen inspection.\n',
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
            '### Requirement: Reviewer reopen inspection',
            '',
            'The system SHALL preserve exact materialization evidence at the reopen limit.',
            '',
            '#### Scenario: A third reviewer term reaches the limit',
            '',
            '- **WHEN** reviewer-term automatic allowance is exhausted',
            '- **THEN** exact human resolutions remain available',
            '',
          ].join('\n'),
        },
      ],
      tasks: '# Tasks\n\n- [ ] 1.1 Preserve reviewer evidence\n',
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
            'The fixture exercises workflow orchestration without product behavior.',
        },
      },
    });
    let reviewStatus = resumePropose(repository, changeId, planningInput);
    const runtime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const firstReviewClosure = readInvestigationEvidenceRefsClosure(
      runtime,
      changeId,
    );
    const investigationId = reviewStatus.investigation!.investigationId;
    let pendingReviewProgress: ReturnType<
      typeof createPlanReviewProgressEnvelope
    > | null = null;
    const runReviewWithNovelTerm = (term: string) => {
      const invocationId = reviewStatus.planReview!.invocationId;
      const semanticOutput = {
        verdict: 'advisory-approve' as const,
        scopeEvidence: [
          {
            kind: 'repository-location' as const,
            path: 'src/reviewer-reopen-target.ts',
            line: 1,
            observation:
              'The fixture target exposes the reviewer-term symbols.',
          },
        ],
        findings: [
          {
            severity: 'medium' as const,
            category: 'missing-scope',
            summary: 'Keep the reviewer reopen target in scope.',
            evidence: [
              {
                kind: 'repository-location' as const,
                path: 'src/reviewer-reopen-target.ts',
                line: 1,
                observation:
                  'The fixture target exposes the reviewer-term symbols.',
              },
            ],
          },
        ],
        proposedTerms: [{ kind: 'symbol' as const, value: term }],
        suggestions: [],
        residualRisk:
          'The fixture intentionally exercises another reviewer term.',
        uncertainty: 'No uncertainty beyond the bounded fixture.',
      };
      runProviderWorker(repository, invocationId, {
        runner(input): ProviderRunnerReport {
          writeFixtureProviderRuntime(runtime, invocationId, semanticOutput);
          return fakeRunnerReport(input.request, semanticOutput);
        },
      });
      pendingReviewProgress = createPlanReviewProgressEnvelope(
        getProposeStatus(repository, investigationId),
      );
      return resumePropose(repository, changeId, pendingReviewProgress);
    };
    const incorporateReviewerTerm = (
      reopened: ReturnType<typeof resumePropose>,
    ) => {
      const dispositions = resumePropose(
        repository,
        changeId,
        createInvestigationCheckpointEnvelope(
          getInvestigationStatus(repository, investigationId),
          {
            dispositions: reopened.work!.groups.map((group) => ({
              groupId: group.groupId,
              classification: 'load-bearing' as const,
              rationale: 'The reviewer-expanded fixture group is load-bearing.',
              author: 'codex',
            })),
          },
        ),
      );
      return resumePropose(
        repository,
        changeId,
        createInvestigationCheckpointEnvelope(
          getInvestigationStatus(repository, investigationId),
          {
            answers: dispositions.work!.fullBlobManifest.map((entry) =>
              whyAnswer(entry.manifestEntryId),
            ),
          },
        ),
      );
    };

    const firstReopened = runReviewWithNovelTerm('FirstReviewerNeedle');
    assert.equal(firstReopened.state, 'awaiting-group-dispositions');
    reviewStatus = incorporateReviewerTerm(firstReopened);
    const secondReopened = runReviewWithNovelTerm('SecondReviewerNeedle');
    assert.equal(secondReopened.state, 'awaiting-group-dispositions');
    reviewStatus = incorporateReviewerTerm(secondReopened);
    const beforeReviewerBlock = readInvestigationSession(
      runtime,
      investigationId,
    );
    const blocked = runReviewWithNovelTerm('ThirdReviewerNeedle');
    assert.equal(blocked.state, 'human-action-required');

    const blockedSession = readInvestigationSession(runtime, investigationId);
    assert.equal(
      blockedSession.semanticRevision,
      beforeReviewerBlock.semanticRevision,
      'entering a human-action blocker is lifecycle-only',
    );
    assert.equal(
      blockedSession.lifecycleRevision,
      beforeReviewerBlock.lifecycleRevision + 1,
    );
    const blockedClosure = readInvestigationEvidenceRefsClosure(
      runtime,
      changeId,
    );
    const blockedMaterialization = blockedClosure.entries.find(
      ({ refName }) => refName === 'propose/planning-materialization',
    );
    const blockedRequest = blockedClosure.entries.find(
      ({ refName }) => refName === 'propose/plan-review-request',
    );
    assert.ok(blockedMaterialization);
    assert.ok(blockedRequest);
    const materializationOutput = readEvidenceNode(
      runtime,
      blockedMaterialization.nodeId,
    ).output as { semanticRevision: number };
    assert.equal(
      blockedSession.semanticRevision,
      materializationOutput.semanticRevision,
    );
    assert.ok(
      blockedSession.blocker !== null && 'reasonCode' in blockedSession.blocker,
    );
    assert.equal(
      blockedSession.blocker.reasonCode,
      'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED',
    );
    assert.equal(blockedSession.blocker.blockedTransition, 'admit-plan-review');
    assert.equal(blockedSession.blocker.facts.usedReopens, 2);
    assert.equal(blockedSession.blocker.facts.proposedTermCount, 1);
    assert.deepEqual(
      blockedRequest.dependencies.filter(
        ({ role }) => role === 'materialization',
      ),
      [
        {
          role: 'materialization',
          nodeId: blockedMaterialization.nodeId,
          resultDigest: blockedMaterialization.resultDigest,
          envelopeDigest: blockedMaterialization.envelopeDigest,
        },
      ],
    );
    const strictInspection = inspectInvestigationResolutionState(
      runtime,
      investigationId,
      'github:R_fixture',
    );
    const inspection = inspectInvestigationQuarantineState(
      runtime,
      investigationId,
      'github:R_fixture',
    );
    assert.equal(
      inspection.currentStateDigest,
      strictInspection.currentStateDigest,
    );
    assert.equal(inspection.envelope.ambiguityDigest, null);
    assert.notEqual(inspection.envelope.evidenceRefs, null);
    assert.notEqual(inspection.envelope.evidenceRefsClosureDigest, null);
    assert.deepEqual(
      inspection.availableResolutions.map(({ kind }) => kind),
      [
        'resume-with-capability',
        'close-input',
        'waive-assurance',
        'abort',
        'quarantine',
        'supersede',
      ],
    );

    const exactBlockedRefs = blockedClosure.snapshot.refs!;
    const priorMaterialization =
      firstReviewClosure.snapshot.refs?.['propose/planning-materialization'];
    const priorRequest =
      firstReviewClosure.snapshot.refs?.['propose/plan-review-request'];
    assert.ok(priorMaterialization);
    assert.ok(priorRequest);
    assert.notEqual(
      priorMaterialization,
      exactBlockedRefs['propose/planning-materialization'],
    );
    assert.notEqual(
      priorRequest,
      exactBlockedRefs['propose/plan-review-request'],
    );
    const wrongMaterialization = compareAndSwapEvidenceRefsDocument(runtime, {
      changeId,
      expectedDigest: blockedClosure.snapshot.digest!,
      nextRefs: {
        ...exactBlockedRefs,
        'propose/planning-materialization': priorMaterialization,
      },
    });
    assert.deepEqual(
      inspectInvestigationQuarantineState(
        runtime,
        investigationId,
        'github:R_fixture',
      ).availableResolutions.map(({ kind }) => kind),
      ['quarantine'],
    );
    compareAndSwapEvidenceRefsDocument(runtime, {
      changeId,
      expectedDigest: wrongMaterialization.digest,
      nextRefs: { ...exactBlockedRefs },
    });
    const wrongRequest = compareAndSwapEvidenceRefsDocument(runtime, {
      changeId,
      expectedDigest: blockedClosure.snapshot.digest!,
      nextRefs: {
        ...exactBlockedRefs,
        'propose/plan-review-request': priorRequest,
      },
    });
    assert.deepEqual(
      inspectInvestigationQuarantineState(
        runtime,
        investigationId,
        'github:R_fixture',
      ).availableResolutions.map(({ kind }) => kind),
      ['quarantine'],
    );
    compareAndSwapEvidenceRefsDocument(runtime, {
      changeId,
      expectedDigest: wrongRequest.digest,
      nextRefs: { ...exactBlockedRefs },
    });

    const resumeAt = new Date('2026-07-30T10:00:00.000Z');
    const resumedAuthorization = grantCoreHumanResolutionAuthorizationFixture(
      repository,
      investigationId,
      {
        kind: 'resume-with-capability',
        capability: 'reviewer-term-reopen',
        parameters: { additionalUses: 1 },
      },
      {
        continuity: 'preserved',
        assurance: 'unchanged',
        claimsWaived: [],
      },
      'a3111111-1111-4111-8111-111111111111',
    );
    const resumedResolution = executeGrantCoreHumanResolutionFixture(
      repository,
      resumedAuthorization,
      {
        now: new Date(resumeAt.getTime() + 1_000),
      },
    );
    const authorizedButNotReopened = readInvestigationSession(
      runtime,
      investigationId,
    );
    assert.equal(
      authorizedButNotReopened.semanticRevision,
      blockedSession.semanticRevision,
    );
    assert.equal(
      authorizedButNotReopened.lifecycleRevision,
      blockedSession.lifecycleRevision,
    );
    const thirdReopened = resumePropose(
      repository,
      changeId,
      pendingReviewProgress!,
    );
    assert.equal(thirdReopened.state, 'awaiting-group-dispositions');
    assert.equal(thirdReopened.work?.termSources.reviewer, 3);
    assert.equal(
      readInvestigationSession(runtime, investigationId).revision,
      blockedSession.revision + 1,
      'the exact human-authorized semantic reopen advances one revision',
    );
    assert.equal(
      readInvestigationSession(runtime, investigationId).semanticRevision,
      blockedSession.semanticRevision + 1,
      'incorporating the authorized reviewer term advances semantic revision once',
    );
    assert.equal(
      readInvestigationSession(runtime, investigationId).lifecycleRevision,
      blockedSession.lifecycleRevision + 1,
    );
    reviewStatus = incorporateReviewerTerm(thirdReopened);

    const fourthBlocked = runReviewWithNovelTerm('FourthReviewerNeedle');
    assert.equal(fourthBlocked.state, 'human-action-required');
    assert.equal(fourthBlocked.work?.termSources.reviewer, 3);
    const fourthInspection = inspectInvestigationResolutionState(
      runtime,
      investigationId,
      'github:R_fixture',
    );
    assert.notEqual(
      fourthInspection.currentStateDigest,
      strictInspection.currentStateDigest,
    );
    const closeAt = new Date('2026-07-30T10:05:00.000Z');
    const closedAuthorization = grantCoreHumanResolutionAuthorizationFixture(
      repository,
      investigationId,
      {
        kind: 'close-input',
        input: 'reviewer-terms',
        parameters: {},
      },
      {
        continuity: 'preserved',
        assurance: 'degraded',
        claimsWaived: ['reviewer-term-incorporation'],
      },
      'a4111111-1111-4111-8111-111111111111',
    );
    const closedResolution = executeGrantCoreHumanResolutionFixture(
      repository,
      closedAuthorization,
      {
        now: new Date(closeAt.getTime() + 1_000),
      },
    );
    assert.notEqual(
      closedResolution.resolutionNodeId,
      resumedResolution.resolutionNodeId,
    );
    const fourthSession = readInvestigationSession(runtime, investigationId);
    assert.ok(
      fourthSession.blocker !== null && 'reasonCode' in fourthSession.blocker,
    );
    const closeAuthorization = inspectReviewerTermResolutionAuthorization(
      repository,
      investigationId,
      String(fourthSession.blocker.facts.pendingReviewDigest),
    );
    assert.deepEqual(closeAuthorization, {
      outcome: 'close-input',
      resolutionNodeId: closedResolution.resolutionNodeId,
      assurance: 'degraded',
    });
    const stillBlocked = readInvestigationSession(runtime, investigationId);
    assert.equal(stillBlocked.state, 'human-action-required');
    assert.equal(stillBlocked.revision, fourthSession.revision);
    assert.deepEqual(stillBlocked.blocker, fourthSession.blocker);
    const fourthClosure = readInvestigationEvidenceRefsClosure(
      runtime,
      changeId,
    );
    const fourthMaterialization = fourthClosure.entries.find(
      ({ refName }) => refName === 'propose/planning-materialization',
    );
    assert.ok(fourthMaterialization);
    assert.equal(
      stillBlocked.semanticRevision,
      (
        readEvidenceNode(runtime, fourthMaterialization.nodeId).output as {
          semanticRevision: number;
        }
      ).semanticRevision,
    );
    assert.equal(
      inspectInvestigationResolutionState(
        runtime,
        investigationId,
        'github:R_fixture',
      ).envelope.ambiguityDigest,
      null,
    );
    assert.equal(
      fs.existsSync(
        path.join(repository, 'openspec/changes', changeId, 'plan-review.json'),
      ),
      false,
    );
    const drifted = compareAndSwapInvestigationSession(
      runtime,
      investigationId,
      stillBlocked.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      }),
    );
    assert.equal(
      drifted.semanticRevision,
      (
        readEvidenceNode(runtime, fourthMaterialization.nodeId).output as {
          semanticRevision: number;
        }
      ).semanticRevision,
    );
    assert.equal(drifted.lifecycleRevision, stillBlocked.lifecycleRevision + 1);
    assert.doesNotThrow(() =>
      inspectInvestigationResolutionState(
        runtime,
        investigationId,
        'github:R_fixture',
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary planning materialization admission rejects retired V1 and V2 receipts without rewriting quarantine evidence', () => {
  for (const version of [1, 2] as const) {
    const fixture = investigationFixture(
      `invocation-retired-materialization-v${version}`,
    );
    try {
      const started = startFixture(fixture);
      const artifacts = {};
      const sealNodeId = sha256(`retired-materialization-v${version}-seal`);
      const sealResultDigest = sha256(
        `retired-materialization-v${version}-seal-result`,
      );
      const materialization = createEvidenceNode({
        type: 'propose-planning-materialization',
        nodeSchema: `workflow.propose-planning-materialization.v${version}`,
        evaluator: 'workflow-propose.v1',
        policyDigest: PROPOSE_POLICY_DIGEST,
        exactInputDigests: {
          artifacts: sha256(canonicalJson(artifacts)),
          baseline: sha256(canonicalJson(started.baseline)),
          seal: sealNodeId,
        },
        semanticParentResultDigests: { seal: sealResultDigest },
        provenanceParentNodeIds: { seal: sealNodeId },
        outputSchema: `workflow.propose-planning-materialization-output.v${version}`,
        output: {
          changeId: started.changeId,
          investigationId: started.investigationId,
          ...(version === 1
            ? { revision: started.revision }
            : { semanticRevision: started.semanticRevision }),
          baseline: started.baseline,
          artifacts,
          sealNodeId,
          sealResultDigest,
        },
        runtimeMetadata: {},
      });
      writeEvidenceNode(fixture.paths, materialization);
      const evidencePath = path.join(
        fixture.paths.refs,
        `${started.changeId}.json`,
      );
      fs.writeFileSync(
        evidencePath,
        canonicalJson({
          schemaVersion: 1,
          changeId: started.changeId,
          refs: {
            'propose/planning-materialization': materialization.nodeId,
          },
        }),
        { mode: 0o600 },
      );
      const objectPath = path.join(
        fixture.paths.objects,
        materialization.nodeId.slice(0, 2),
        `${materialization.nodeId}.json`,
      );
      const exactEvidence = fs.readFileSync(evidencePath);
      const exactObject = fs.readFileSync(objectPath);

      assert.throws(
        () =>
          readInvestigationEvidenceRefsClosure(fixture.paths, started.changeId),
        (error) => isWorkflowError(error, 'EVIDENCE_REF_INVALID'),
      );
      assert.throws(
        () =>
          inspectInvestigationResolutionState(
            fixture.paths,
            started.investigationId,
            'fixture',
          ),
        (error) => isWorkflowError(error, 'EVIDENCE_REF_INVALID'),
      );
      const quarantined = inspectInvestigationQuarantineState(
        fixture.paths,
        started.investigationId,
        'fixture',
      );
      assert.equal(quarantined.envelope.evidenceRefs, null);
      assert.equal(quarantined.envelope.evidenceRefsClosureDigest, null);
      assert.notEqual(quarantined.envelope.evidenceRefsDigest, null);
      assert.notEqual(quarantined.envelope.ambiguityDigest, null);
      assert.deepEqual(
        quarantined.availableResolutions.map(({ kind }) => kind),
        ['quarantine'],
      );
      assert.deepEqual(fs.readFileSync(evidencePath), exactEvidence);
      assert.deepEqual(fs.readFileSync(objectPath), exactObject);
    } finally {
      fs.rmSync(fixture.repository, { recursive: true, force: true });
    }
  }
});

test('current materialization survives repeated lifecycle revisions but not a semantic milestone revision', () => {
  const fixture = investigationFixture(
    'invocation-semantic-materialization-revision',
  );
  try {
    const started = startFixture(fixture);
    const artifacts = {
      'proposal.md': sha256('semantic-materialization-proposal'),
    };
    const manifestDigest = sha256('semantic-materialization-manifest');
    const investigationTargetDigest = sha256(
      'semantic-materialization-investigation-target',
    );
    const sessionSnapshotDigest = sha256(`${canonicalJson(started)}\n`);
    const manifestAuthority = createEvidenceNode({
      type: 'investigation-manifest-authority',
      nodeSchema: 'investigation.manifest-authority.v1',
      evaluator: 'workflow-propose.manifest-authority.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        manifest: manifestDigest,
        investigationTarget: investigationTargetDigest,
        sessionSnapshot: sessionSnapshotDigest,
      },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'investigation.manifest-authority-output.v1',
      output: {
        repositoryId: 'fixture',
        changeId: started.changeId,
        investigationId: started.investigationId,
        sessionRevision: started.revision,
        sessionSnapshotDigest,
        manifestDigest,
        investigationTargetDigest,
      },
      runtimeMetadata: {},
    });
    const materialization = createEvidenceNode({
      type: 'propose-planning-materialization',
      nodeSchema: 'workflow.propose-planning-materialization.v3',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        artifacts: sha256(canonicalJson(artifacts)),
        baseline: sha256(canonicalJson(started.baseline)),
        manifestAuthority: manifestAuthority.nodeId,
        manifest: manifestDigest,
        investigationTarget: investigationTargetDigest,
        sessionSnapshot: sessionSnapshotDigest,
      },
      semanticParentResultDigests: {
        manifestAuthority: manifestAuthority.resultDigest,
      },
      provenanceParentNodeIds: {
        manifestAuthority: manifestAuthority.nodeId,
      },
      outputSchema: 'workflow.propose-planning-materialization-output.v3',
      output: {
        changeId: started.changeId,
        investigationId: started.investigationId,
        semanticRevision: started.semanticRevision,
        baseline: started.baseline,
        artifacts,
        manifestAuthorityNodeId: manifestAuthority.nodeId,
        manifestAuthorityResultDigest: manifestAuthority.resultDigest,
        manifestDigest,
        investigationTargetDigest,
        sessionSnapshotDigest,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(fixture.paths, manifestAuthority);
    writeEvidenceNode(fixture.paths, materialization);
    fs.writeFileSync(
      path.join(fixture.paths.refs, `${started.changeId}.json`),
      canonicalJson({
        schemaVersion: 1,
        changeId: started.changeId,
        refs: {
          'propose/planning-materialization': materialization.nodeId,
        },
      }),
      { mode: 0o600 },
    );

    const firstLifecycle = compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      started.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      }),
    );
    const secondLifecycle = compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      firstLifecycle.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      }),
    );
    assert.equal(secondLifecycle.semanticRevision, started.semanticRevision);
    assert.equal(
      secondLifecycle.lifecycleRevision,
      started.lifecycleRevision + 2,
    );
    const closure = readInvestigationEvidenceRefsClosure(
      fixture.paths,
      started.changeId,
    );
    assert.deepEqual(
      closure.entries.map(({ refName }) => refName),
      ['propose/planning-materialization'],
    );
    assert.deepEqual(
      closure.entries[0]?.dependencies.map(({ role }) => role),
      ['manifest-authority'],
    );
    const valid = inspectInvestigationResolutionState(
      fixture.paths,
      started.investigationId,
      'fixture',
    );
    assert.notEqual(valid.envelope.evidenceRefs, null);

    const envelope = mainTermsEnvelope(started);
    const semantic = compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      secondLifecycle.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        state: 'waiting-for-provider',
        milestones: {
          ...current.milestones,
          mainTerms: {
            envelopeDigest: sha256(canonicalJson(envelope)),
            contributionDigest: checkpointContributionDigest(envelope),
            envelope,
          },
        },
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      }),
    );
    assert.equal(
      semantic.semanticRevision,
      secondLifecycle.semanticRevision + 1,
    );
    const quarantined = inspectInvestigationQuarantineState(
      fixture.paths,
      started.investigationId,
      'fixture',
    );
    assert.equal(quarantined.envelope.evidenceRefs, null);
    assert.notEqual(quarantined.envelope.ambiguityDigest, null);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('quarantine preserves exact retired materialization evidence through Grant-authorized recovery', () => {
  const fixture = investigationFixture(
    'invocation-quarantine-stale-materialization',
  );
  const now = new Date('2026-07-29T22:00:00.000Z');
  try {
    const started = startFixture(fixture);
    const artifacts = {};
    const sealNodeId = sha256('quarantine-stale-materialization-seal');
    const sealResultDigest = sha256(
      'quarantine-stale-materialization-seal-result',
    );
    const materialization = createEvidenceNode({
      type: 'propose-planning-materialization',
      nodeSchema: 'workflow.propose-planning-materialization.v1',
      evaluator: 'workflow-propose.v1',
      policyDigest: PROPOSE_POLICY_DIGEST,
      exactInputDigests: {
        artifacts: sha256(canonicalJson(artifacts)),
        baseline: sha256(canonicalJson(started.baseline)),
        seal: sealNodeId,
      },
      semanticParentResultDigests: { seal: sealResultDigest },
      provenanceParentNodeIds: { seal: sealNodeId },
      outputSchema: 'workflow.propose-planning-materialization-output.v1',
      output: {
        changeId: started.changeId,
        investigationId: started.investigationId,
        revision: started.revision,
        baseline: started.baseline,
        artifacts,
        sealNodeId,
        sealResultDigest,
      },
      runtimeMetadata: {},
    });
    writeEvidenceNode(fixture.paths, materialization);
    const evidencePath = path.join(
      fixture.paths.refs,
      `${started.changeId}.json`,
    );
    fs.writeFileSync(
      evidencePath,
      canonicalJson({
        schemaVersion: 1,
        changeId: started.changeId,
        refs: {
          'propose/planning-materialization': materialization.nodeId,
        },
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        readInvestigationEvidenceRefsClosure(fixture.paths, started.changeId),
      (error) => isWorkflowError(error, 'EVIDENCE_REF_INVALID'),
    );

    const origin = 'https://github.com/example/fixture.git';
    git(fixture.repository, ['remote', 'add', 'origin', origin]);
    fs.writeFileSync(
      path.join(fixture.repository, 'workflow/maintainer-policy.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repository: {
            id: 'github:R_fixture',
            origin,
          },
          phase: 'bootstrap',
          auditTagPrefix: 'refs/tags/workflow-grant/',
          signatureNamespace: 'workflow.maintainer-grant.v1',
          maxTtlMinutes: 30,
          maxUses: 1,
          bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
          sealedImmutablePaths: [],
          requiredChecks: ['fixture'],
          trustedSigners: [
            {
              identity: 'fixture-maintainer',
              publicKey:
                'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
              fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    git(fixture.repository, ['add', '--', 'workflow/maintainer-policy.json']);
    git(fixture.repository, ['commit', '-m', 'Add maintainer policy']);

    const observed = inspectInvestigationQuarantineState(
      fixture.paths,
      started.investigationId,
      'github:R_fixture',
    );
    assert.equal(observed.envelope.evidenceRefs, null);
    assert.equal(observed.envelope.evidenceRefsClosureDigest, null);
    assert.notEqual(observed.envelope.evidenceRefsDigest, null);
    assert.notEqual(observed.envelope.ambiguityDigest, null);
    assert.deepEqual(
      observed.availableResolutions.map(({ kind }) => kind),
      ['quarantine'],
    );

    const quarantineAuthorization = (challengeId: string) =>
      grantCoreHumanResolutionAuthorizationFixture(
        fixture.repository,
        started.investigationId,
        {
          kind: 'quarantine',
          parameters: {
            reason:
              'The persisted materialization uses a retired ordinary receipt schema.',
          },
        },
        {
          continuity: 'not-applicable',
          assurance: 'degraded',
          claimsWaived: [],
        },
        challengeId,
        true,
      );
    const exactEvidence = fs.readFileSync(evidencePath);
    const quarantineDirectory = path.join(
      fixture.paths.root,
      'human-resolutions',
      'quarantine',
    );
    const quarantineArtifacts = () =>
      fs.existsSync(quarantineDirectory)
        ? fs.readdirSync(quarantineDirectory).sort()
        : [];
    const currentRefPath = path.join(
      fixture.paths.refs,
      `${started.changeId}.investigation-session.json`,
    );
    const startReservationPath = path.join(
      fixture.paths.refs,
      `${started.changeId}.investigation-start.json`,
    );
    const exactCurrentRef = fs.readFileSync(currentRefPath);
    const exactStartReservation = fs.readFileSync(startReservationPath);
    const staleAuthorization = quarantineAuthorization(
      'd1111111-1111-4111-8111-111111111111',
    );
    const mutatedEvidence = Buffer.concat([exactEvidence, Buffer.from(' ')]);
    fs.writeFileSync(evidencePath, mutatedEvidence);
    assert.throws(
      () =>
        executeGrantCoreHumanResolutionFixture(
          fixture.repository,
          staleAuthorization,
          {
            now: new Date(now.getTime() + 1_000),
          },
        ),
      (error) => isWorkflowError(error, 'GRANT_STATE_CHANGED'),
    );
    assert.equal(
      readHumanResolutionJournal(fixture.paths, staleAuthorization.challengeId),
      null,
    );
    assert.deepEqual(fs.readFileSync(evidencePath), mutatedEvidence);
    assert.deepEqual(fs.readFileSync(currentRefPath), exactCurrentRef);
    assert.deepEqual(
      fs.readFileSync(startReservationPath),
      exactStartReservation,
    );
    assert.deepEqual(quarantineArtifacts(), []);
    fs.writeFileSync(evidencePath, exactEvidence);

    const authorization = quarantineAuthorization(
      'd2111111-1111-4111-8111-111111111111',
    );
    assert.throws(
      () =>
        executeGrantCoreHumanResolutionFixture(
          fixture.repository,
          authorization,
          {
            now: new Date(now.getTime() + 1_000),
            simulateCrashAfter: 'evidence-refs',
          },
        ),
      (error) =>
        error instanceof SimulatedHumanResolutionCrash &&
        error.phase === 'evidence-refs',
    );
    assert.equal(
      readHumanResolutionJournal(fixture.paths, authorization.challengeId)
        ?.phase,
      'evidence-refs-published',
    );
    assert.equal(fs.existsSync(evidencePath), false);
    const evidenceArtifacts = quarantineArtifacts().filter((name) =>
      name.endsWith('.evidence-refs.artifact'),
    );
    assert.equal(evidenceArtifacts.length, 1);
    const quarantinedEvidencePath = path.join(
      quarantineDirectory,
      evidenceArtifacts[0] as string,
    );
    assert.deepEqual(fs.readFileSync(quarantinedEvidencePath), exactEvidence);
    assert.equal(fs.statSync(quarantinedEvidencePath).mode & 0o777, 0o600);
    const result = executeGrantCoreHumanResolutionFixture(
      fixture.repository,
      authorization,
      {
        now: new Date(now.getTime() + 2_000),
      },
    );
    assert.equal(result.recovered, true);
    assert.equal(result.decision.kind, 'quarantine');
    assert.equal(fs.existsSync(currentRefPath), false);
    assert.equal(fs.existsSync(startReservationPath), false);
    assert.deepEqual(fs.readFileSync(quarantinedEvidencePath), exactEvidence);
    const terminal = inspectInvestigationQuarantineState(
      fixture.paths,
      started.investigationId,
      'github:R_fixture',
    );
    assert.equal(terminal.effectiveState, 'quarantined-by-human-resolution');
    assert.equal(terminal.currentRefDigest, null);
    assert.equal(terminal.envelope.startReservationDigest, null);
    assert.equal(terminal.envelope.evidenceRefsDigest, null);
    assert.deepEqual(terminal.availableResolutions, []);
    assert.equal(result.afterStateDigest, terminal.currentStateDigest);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});
