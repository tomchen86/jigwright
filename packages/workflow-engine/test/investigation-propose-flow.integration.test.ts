import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  compareAndSwapEvidenceRefsDocument,
  computeInvestigationEvidenceRefsClosure,
  readEvidenceNode,
  readInvestigationEvidenceRefsClosure,
  writeEvidenceNode,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createInvestigationCheckpointEnvelope,
  getInvestigationStatus,
} from '../src/adapters/planning/investigation/investigation-session.ts';
import {
  createPlanningContributionEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/application/propose/propose-orchestrator.ts';
import { productionRoleTopologyResolutionPort } from '../src/composition-root/role-topology-resolution-production.ts';
import { listProviderInvocationLifecycleProjections } from '../src/runtime/storage-journal/investigation-session-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { storeProviderExecutionPolicySnapshot } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { fixtureCurrentSchemaName, git, isWorkflowError } from './fixture.ts';
import {
  mainTerm,
  whyAnswer,
  assertTrackedInvestigationManifestPublication,
  sha256,
} from './investigation-session-fixture.ts';
import {
  createStartedProposeFixture,
  createSealedProposeFixture,
} from './investigation-propose-flow-fixture.ts';

describe('fake-backed propose composes breadth and depth before materializing an uncommitted planning draft', () => {
  test('collects breadth, dispositions and WHY evidence before sealing', async (t) => {
    let { repository, changeId, providerRuns, intent, started } =
      createStartedProposeFixture();
    try {
      assert.equal(started.state, 'awaiting-main-terms');

      assert.equal(started.investigation?.provider.providerId, 'codex');

      assert.equal(providerRuns, 1);

      const replayedStart = startPropose(repository, changeId, intent, {
        explicitActor: 'codex',
        environment: {},
        providerDriver: () => {
          providerRuns += 1;
        },
      });

      assert.equal(
        replayedStart.investigation?.investigationId,
        started.investigation?.investigationId,
      );

      assert.equal(
        replayedStart.investigation?.providerInvocationId,
        started.investigation?.providerInvocationId,
      );

      assert.equal(providerRuns, 1);

      assert.throws(
        () =>
          startPropose(repository, changeId, intent, {
            explicitActor: 'claude',
            environment: {},
          }),
        (error) =>
          isWorkflowError(error, 'CURRENT_INVESTIGATION_ACTOR_CONFLICT'),
      );

      assert.equal(
        getInvestigationStatus(
          repository,
          started.investigation!.investigationId,
        ).provider.providerId,
        'codex',
      );

      assert.equal(
        fs.existsSync(path.join(repository, 'openspec/changes', changeId)),
        false,
      );

      const mainTermsInput = createInvestigationCheckpointEnvelope(
        started.investigation!,
        {
          reference: 'main-survey',
          terms: [mainTerm('MainSurveyNeedle')],
        },
      );

      const afterMain = resumePropose(repository, changeId, mainTermsInput);

      assert.equal(afterMain.state, 'awaiting-group-dispositions');

      assert.deepEqual(afterMain.work?.termSources, {
        engine: 7,
        main: 1,
        reviewer: 0,
        survey: 1,
      });

      assert.ok((afterMain.work?.groups.length ?? 0) > 0);

      const initialGroupIds = new Set(
        afterMain.work!.groups.map(({ groupId }) => groupId),
      );

      assert.ok(
        afterMain.work?.groups.some((group) =>
          group.paths.includes('src/investigation-target.ts'),
        ),
      );

      assert.ok(
        afterMain.work?.groups.some((group) =>
          group.paths.includes('src/renamed-fixture.ts'),
        ),
      );

      assert.ok(
        afterMain.work?.groups.some((group) =>
          group.paths.includes('.codex/skills/openspec-propose/SKILL.md'),
        ),
      );

      assert.ok(
        afterMain.work?.groups.some((group) =>
          group.paths.includes('.agents/skills/openspec-propose/SKILL.md'),
        ),
      );

      assert.ok(
        afterMain.work?.groups.some((group) =>
          group.paths.includes('workflow/openspec-assets/manifest.json'),
        ),
      );

      assert.throws(
        () =>
          resumePropose(
            repository,
            changeId,
            createInvestigationCheckpointEnvelope(afterMain.investigation!, {
              dispositions: [],
            }),
          ),
        (error) => isWorkflowError(error, 'INVESTIGATION_DISPOSITIONS_INVALID'),
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

      assert.equal(afterDispositions.state, 'awaiting-ledger-answers');

      assert.ok((afterDispositions.work?.fullBlobManifest.length ?? 0) > 0);

      const initialManifestEntryIds = new Set(
        afterDispositions.work!.fullBlobManifest.map(
          ({ manifestEntryId }) => manifestEntryId,
        ),
      );

      assert.ok(
        afterDispositions.work?.fullBlobManifest.some((entry) =>
          spawnSync(
            'git',
            ['-C', repository, 'cat-file', '-p', entry.objectId],
            {
              encoding: 'utf8',
            },
          ).stdout.includes('Needle'),
        ),
      );

      const incompleteAnswers = afterDispositions
        .work!.fullBlobManifest.slice(1)
        .map((entry) => whyAnswer(entry.manifestEntryId));

      assert.throws(
        () =>
          resumePropose(
            repository,
            changeId,
            createInvestigationCheckpointEnvelope(
              afterDispositions.investigation!,
              { answers: incompleteAnswers },
            ),
          ),
        (error) => isWorkflowError(error, 'INVESTIGATION_WHY_INVALID'),
      );

      for (const field of [
        'why',
        'protectedInvariant',
        'reviewerQuestion',
        'answer',
      ] as const) {
        for (const invalid of ['', '<fill in>', 'TBD']) {
          const answers = afterDispositions.work!.fullBlobManifest.map(
            (entry) => whyAnswer(entry.manifestEntryId),
          );
          answers[0]![field] = invalid;
          assert.throws(
            () =>
              resumePropose(
                repository,
                changeId,
                createInvestigationCheckpointEnvelope(
                  afterDispositions.investigation!,
                  { answers },
                ),
              ),
            (error) =>
              isWorkflowError(error, 'INVESTIGATION_CHECKPOINT_INVALID'),
            `${field} must reject ${JSON.stringify(invalid)} before sealing`,
          );
        }
      }

      const sealed = resumePropose(
        repository,
        changeId,
        createInvestigationCheckpointEnvelope(
          afterDispositions.investigation!,
          {
            answers: afterDispositions.work!.fullBlobManifest.map((entry) =>
              whyAnswer(entry.manifestEntryId),
            ),
          },
        ),
      );

      assert.equal(sealed.state, 'awaiting-planning-contribution');

      assert.equal(sealed.investigation?.state, 'investigation-sealed');

      const changeDirectory = path.join(
        repository,
        'openspec/changes',
        changeId,
      );

      assert.equal(
        fs.readFileSync(path.join(changeDirectory, '.openspec.yaml'), 'utf8'),
        `schema: ${fixtureCurrentSchemaName(repository)}\ncreated: ${sealed.createdDate}\n`,
      );

      const trackedInvestigation = JSON.parse(
        fs.readFileSync(
          path.join(changeDirectory, 'investigation.json'),
          'utf8',
        ),
      );

      assert.equal(trackedInvestigation.schemaVersion, 3);

      assert.equal(trackedInvestigation.kind, 'manifest-first-investigation');

      assert.match(trackedInvestigation.manifestDigest, /^[0-9a-f]{64}$/);

      assertTrackedInvestigationManifestPublication(
        repository,
        changeId,
        trackedInvestigation,
      );

      const runtime = investigationRuntimePaths(
        discoverRepository(repository).gitCommonDirectory,
        'workflow-engine',
      );

      assert.equal(fs.existsSync(path.join(runtime.root, 'shadow-v3')), false);

      assert.equal(trackedInvestigation.applicability.kind, 'ordinary');

      assert.deepEqual(
        trackedInvestigation.applicability.semanticDelta.investigationRequirements.map(
          (requirement: { kind: string }) => requirement.kind,
        ),
        [
          'implementation-reconciliation-requirement',
          'plan-review-coverage-requirement',
        ],
      );

      assert.equal(
        trackedInvestigation.applicability.replayContract.termContributions
          .length,
        3,
      );

      const engineContribution =
        trackedInvestigation.applicability.replayContract.termContributions.find(
          (contribution: { source: string }) =>
            contribution.source === 'engine',
        );

      assert.ok(engineContribution);

      assert.ok(
        engineContribution.terms.some(
          (term: { value: string }) => term.value === 'renamed-fixture.ts',
        ),
      );

      assert.ok(
        engineContribution.terms.some(
          (term: { value: string }) => term.value === 'renamed-fixture',
        ),
      );

      assert.ok(
        engineContribution.terms.some(
          (term: { value: string }) =>
            term.value === '.codex/skills/openspec-propose/SKILL.md',
        ),
      );

      assert.ok(
        engineContribution.terms.some(
          (term: { value: string }) =>
            term.value === '.agents/skills/openspec-propose/SKILL.md',
        ),
      );

      assert.match(
        trackedInvestigation.applicability.replayContract.inventoryRoot,
        /^[0-9a-f]{64}$/,
      );

      assert.match(
        trackedInvestigation.applicability.replayContract.hitRoot,
        /^[0-9a-f]{64}$/,
      );

      assert.match(
        trackedInvestigation.applicability.replayContract.mechanicalGroupRoot,
        /^[0-9a-f]{64}$/,
      );

      assert.equal(
        trackedInvestigation.applicability.semanticDelta
          .investigationRoleResults.length,
        1,
      );

      assert.equal(
        trackedInvestigation.applicability.semanticDelta
          .investigationRoleResults[0].role,
        'reviewer-pre-anchor',
      );

      assert.equal(
        trackedInvestigation.applicability.semanticDelta
          .investigationRoleResults[0].achievedIndependence,
        'session-independent',
      );

      assert.match(
        trackedInvestigation.investigationApproval.investigationTargetDigest,
        /^[0-9a-f]{64}$/,
      );

      assert.match(
        trackedInvestigation.investigationApproval.sealDigest,
        /^[0-9a-f]{64}$/,
      );

      assert.equal(
        fs.existsSync(path.join(changeDirectory, 'design.md')),
        false,
      );

      assert.equal(
        fs.existsSync(path.join(changeDirectory, 'plan-review.json')),
        false,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  test('materializes planning with pinned topology and rejects divergent replay', async (t) => {
    let {
      repository,
      changeId,
      planningSource,
      providerRuns,
      intent,
      mainTermsInput,
      sealed,
      changeDirectory,
      trackedInvestigation,
    } = createSealedProposeFixture();
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

      const stalePlanningInput = structuredClone(planningInput);

      stalePlanningInput.baseline.tree = 'f'.repeat(40);

      assert.throws(
        () => resumePropose(repository, changeId, stalePlanningInput),
        (error) => isWorkflowError(error, 'PROPOSE_INPUT_STALE'),
      );

      const unmanagedPath = path.join(changeDirectory, 'unexpected.md');

      fs.writeFileSync(unmanagedPath, '# Unmanaged\n');

      assert.throws(
        () => resumePropose(repository, changeId, planningInput),
        (error) => isWorkflowError(error, 'UNMANAGED_PLANNING_CONFLICT'),
      );

      fs.rmSync(unmanagedPath);

      const materialized = resumePropose(repository, changeId, planningInput, {
        roleTopologyResolution: productionRoleTopologyResolutionPort,
      });

      assert.equal(materialized.state, 'waiting-for-plan-review');

      assert.equal(materialized.nextAction, 'wait-for-plan-review');

      const originPath = path.join(changeDirectory, 'origin.json');

      const originBytes = `${canonicalJson({
        schemaVersion: 1,
        sourceRefs: [planningSource.id],
        workItemRefs: [],
      })}\n`;

      assert.equal(fs.readFileSync(originPath, 'utf8'), originBytes);

      assert.equal(
        materialized.materializedArtifacts?.['origin.json'],
        sha256(originBytes),
      );

      const topologyRuntime = investigationRuntimePaths(
        discoverRepository(repository).gitCommonDirectory,
        'workflow-engine',
      );

      const materializedSessionPath = path.join(
        topologyRuntime.sessions,
        `${materialized.investigation!.investigationId}.json`,
      );

      const materializedRefsPath = path.join(
        topologyRuntime.refs,
        `${changeId}.json`,
      );

      const materializedSessionBytes = fs.readFileSync(materializedSessionPath);

      const materializedRefsBytes = fs.readFileSync(materializedRefsPath);

      fs.rmSync(originPath);

      assert.throws(
        () =>
          getProposeStatus(
            repository,
            materialized.investigation!.investigationId,
          ),
        (error) => isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
      );

      assert.equal(fs.existsSync(originPath), false);

      assert.deepEqual(
        fs.readFileSync(materializedSessionPath),
        materializedSessionBytes,
      );

      assert.deepEqual(
        fs.readFileSync(materializedRefsPath),
        materializedRefsBytes,
      );

      fs.writeFileSync(originPath, originBytes);

      const topologyRefs = readInvestigationEvidenceRefsClosure(
        topologyRuntime,
        changeId,
      ).snapshot.refs!;

      const topologyReservation = readEvidenceNode(
        topologyRuntime,
        topologyRefs['propose/plan-review-request']!,
      );

      assert.equal(
        topologyReservation.nodeSchema,
        'workflow.plan-review-request-reservation.v3',
      );

      assert.equal(
        topologyReservation.outputSchema,
        'workflow.plan-review-request-reservation-output.v3',
      );

      assert.deepEqual(
        Object.keys(topologyReservation.exactInputDigests).sort(),
        ['manifest', 'request', 'subject', 'targetSnapshot'],
      );

      assert.deepEqual(
        Object.keys(topologyReservation.provenanceParentNodeIds),
        ['authorization'],
      );

      assert.deepEqual(
        Object.keys(topologyReservation.semanticParentResultDigests),
        ['authorization'],
      );

      assert.equal(
        (topologyReservation.output as { retry: unknown }).retry,
        null,
      );

      for (const retiredVersion of [1, 2] as const) {
        const retiredReservation = createEvidenceNode({
          type: topologyReservation.type,
          nodeSchema: `workflow.plan-review-request-reservation.v${retiredVersion}`,
          evaluator: topologyReservation.evaluator,
          policyDigest: topologyReservation.policyDigest,
          exactInputDigests: { ...topologyReservation.exactInputDigests },
          semanticParentResultDigests: {
            ...topologyReservation.semanticParentResultDigests,
          },
          provenanceParentNodeIds: {
            ...topologyReservation.provenanceParentNodeIds,
          },
          outputSchema: `workflow.plan-review-request-reservation-output.v${retiredVersion}`,
          output: topologyReservation.output,
          runtimeMetadata: {},
        });
        writeEvidenceNode(topologyRuntime, retiredReservation);
        assert.throws(
          () =>
            computeInvestigationEvidenceRefsClosure(topologyRuntime, changeId, {
              'propose/planning-materialization':
                topologyRefs['propose/planning-materialization']!,
              'propose/plan-review-request': retiredReservation.nodeId,
            }),
          (error) => isWorkflowError(error, 'EVIDENCE_REF_INVALID'),
        );
      }

      const topologyAuthorization = readEvidenceNode(
        topologyRuntime,
        topologyReservation.provenanceParentNodeIds.authorization!,
      );

      assert.equal(
        topologyAuthorization.nodeSchema,
        'workflow.plan-review-authorization.v3',
      );

      assert.equal(
        topologyAuthorization.outputSchema,
        'workflow.plan-review-authorization-output.v3',
      );

      const topologyAuthorizationOutput = topologyAuthorization.output as {
        roleTopology: {
          disposition: string;
          exactGrantRolePairs: string[];
          actualRolePairs: Array<{ achieved: string }>;
        };
      };

      assert.equal(
        topologyAuthorizationOutput.roleTopology.disposition,
        'satisfied',
      );

      assert.deepEqual(
        topologyAuthorizationOutput.roleTopology.exactGrantRolePairs,
        [],
      );

      assert.equal(
        topologyAuthorizationOutput.roleTopology.actualRolePairs[0]?.achieved,
        'session-independent',
      );

      assert.equal(
        topologyAuthorization.exactInputDigests.roleTopology,
        crypto
          .createHash('sha256')
          .update(canonicalJson(topologyAuthorizationOutput.roleTopology))
          .digest('hex'),
      );

      const initialReviewInvocationId = materialized.planReview!.invocationId;

      const initialReviewInvocationDirectory = path.join(
        topologyRuntime.invocations,
        initialReviewInvocationId,
      );

      const initialPolicyBytes = fs.readFileSync(
        path.join(initialReviewInvocationDirectory, 'execution-policy.json'),
      );

      for (const entry of fs.readdirSync(initialReviewInvocationDirectory)) {
        if (entry !== 'execution-policy.json') {
          fs.rmSync(path.join(initialReviewInvocationDirectory, entry), {
            recursive: true,
            force: true,
          });
        }
      }

      const recoveredInitialReview = resumePropose(
        repository,
        changeId,
        planningInput,
      );

      assert.equal(
        recoveredInitialReview.planReview?.invocationId,
        initialReviewInvocationId,
      );

      assert.deepEqual(
        fs.readFileSync(
          path.join(initialReviewInvocationDirectory, 'execution-policy.json'),
        ),
        initialPolicyBytes,
      );

      assert.deepEqual(
        fs.readdirSync(initialReviewInvocationDirectory).sort(),
        [
          'execution-policy.json',
          'manifest.json',
          'request.json',
          'review-root',
          'state.json',
        ],
      );

      const initialReservationOutput = topologyReservation.output as Record<
        string,
        unknown
      >;

      const initialReviewRequest =
        initialReservationOutput.request as ProviderInvocationRequest;

      const {
        schemaVersion: _initialRequestSchemaVersion,
        roleAssignmentDigest: _initialRoleAssignmentDigest,
        requestDigest: _initialRequestDigest,
        ...initialReviewRequestInput
      } = initialReviewRequest;

      const poisonedRecoveryRequest = createProviderInvocationRequest({
        ...initialReviewRequestInput,
        invocationId: 'invocation-plan-review-poisoned-v3',
        nonce: 'plan-review-poisoned-v3-nonce-000000000001',
      });

      storeProviderExecutionPolicySnapshot(
        topologyRuntime,
        poisonedRecoveryRequest,
        loadAiAdapterPolicy(repository),
      );

      const poisonedRecoveryReservation = createEvidenceNode({
        type: topologyReservation.type,
        nodeSchema: topologyReservation.nodeSchema,
        evaluator: topologyReservation.evaluator,
        policyDigest: topologyReservation.policyDigest,
        exactInputDigests: {
          ...topologyReservation.exactInputDigests,
          request: poisonedRecoveryRequest.requestDigest,
        },
        semanticParentResultDigests: {
          ...topologyReservation.semanticParentResultDigests,
        },
        provenanceParentNodeIds: {
          ...topologyReservation.provenanceParentNodeIds,
        },
        outputSchema: topologyReservation.outputSchema,
        output: {
          ...initialReservationOutput,
          request: poisonedRecoveryRequest,
        },
        runtimeMetadata: {},
      });

      writeEvidenceNode(topologyRuntime, poisonedRecoveryReservation);

      const poisonedRecoveryChangeId = 'poisoned-plan-review-recovery';

      const poisonedRecoveryRefs = compareAndSwapEvidenceRefsDocument(
        topologyRuntime,
        {
          changeId: poisonedRecoveryChangeId,
          expectedDigest: null,
          nextRefs: {
            'propose/plan-review-request': poisonedRecoveryReservation.nodeId,
          },
        },
      );

      const poisonedRecoveryRefsPath = path.join(
        topologyRuntime.refs,
        `${poisonedRecoveryChangeId}.json`,
      );

      const poisonedRecoveryPolicyPath = path.join(
        topologyRuntime.invocations,
        poisonedRecoveryRequest.invocationId,
        'execution-policy.json',
      );

      const poisonedRecoveryRefsBytes = fs.readFileSync(
        poisonedRecoveryRefsPath,
      );

      const poisonedRecoveryPolicyBytes = fs.readFileSync(
        poisonedRecoveryPolicyPath,
      );

      assert.throws(
        () => listProviderInvocationLifecycleProjections(topologyRuntime),
        (error) =>
          isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
      );

      assert.deepEqual(
        fs.readFileSync(poisonedRecoveryRefsPath),
        poisonedRecoveryRefsBytes,
      );

      assert.deepEqual(
        fs.readFileSync(poisonedRecoveryPolicyPath),
        poisonedRecoveryPolicyBytes,
      );

      compareAndSwapEvidenceRefsDocument(topologyRuntime, {
        changeId: poisonedRecoveryChangeId,
        expectedDigest: poisonedRecoveryRefs.digest,
        nextRefs: null,
      });

      fs.rmSync(
        path.join(
          topologyRuntime.invocations,
          poisonedRecoveryRequest.invocationId,
        ),
        { recursive: true, force: true },
      );

      const durableWrapperStatus = getProposeStatus(
        repository,
        materialized.investigation!.investigationId,
      );

      assert.equal(durableWrapperStatus.state, 'waiting-for-plan-review');

      assert.deepEqual(
        durableWrapperStatus.materializedArtifacts,
        materialized.materializedArtifacts,
      );

      assert.equal(
        fs
          .readFileSync(path.join(changeDirectory, 'design.md'), 'utf8')
          .includes('Authored prefix.'),
        true,
      );

      assert.equal(
        fs
          .readFileSync(path.join(changeDirectory, 'design.md'), 'utf8')
          .includes('Protected invariant:'),
        true,
      );

      assert.equal(
        fs.existsSync(path.join(changeDirectory, 'plan-review.json')),
        false,
      );

      assert.equal(
        git(repository, ['diff', '--cached', '--name-only']).trim(),
        '',
      );

      assert.equal(
        git(repository, ['log', '-1', '--format=%s']).trim(),
        'Add investigation target',
      );

      const materializedTrackedInvestigation = JSON.parse(
        fs.readFileSync(
          path.join(changeDirectory, 'investigation.json'),
          'utf8',
        ),
      );

      assert.equal(materializedTrackedInvestigation.schemaVersion, 3);

      assert.equal(
        materializedTrackedInvestigation.manifestDigest,
        trackedInvestigation.manifestDigest,
      );

      assert.equal(
        Object.hasOwn(materializedTrackedInvestigation, 'nodes'),
        false,
      );

      const beforeReplay = git(repository, ['diff', '--no-ext-diff']);

      const replayedCompletedStart = startPropose(
        repository,
        changeId,
        intent,
        {
          explicitActor: 'codex',
          environment: {},
          providerDriver: () => {
            providerRuns += 1;
          },
        },
      );

      assert.equal(replayedCompletedStart.state, 'waiting-for-plan-review');

      assert.deepEqual(
        replayedCompletedStart.materializedArtifacts,
        materialized.materializedArtifacts,
      );

      assert.equal(providerRuns, 1);

      const replayedCompletedCheckpoint = resumePropose(
        repository,
        changeId,
        mainTermsInput,
      );

      assert.equal(
        replayedCompletedCheckpoint.state,
        'waiting-for-plan-review',
      );

      assert.deepEqual(
        replayedCompletedCheckpoint.materializedArtifacts,
        materialized.materializedArtifacts,
      );

      assert.deepEqual(
        resumePropose(repository, changeId, planningInput),
        materialized,
      );

      assert.equal(git(repository, ['diff', '--no-ext-diff']), beforeReplay);

      const proposalPath = path.join(changeDirectory, 'proposal.md');

      const proposalBytes = fs.readFileSync(proposalPath, 'utf8');

      fs.writeFileSync(proposalPath, `${proposalBytes}drift\n`);

      assert.throws(
        () =>
          getProposeStatus(
            repository,
            materialized.investigation!.investigationId,
          ),
        (error) => isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
      );

      assert.throws(
        () => resumePropose(repository, changeId, planningInput),
        (error) => isWorkflowError(error, 'UNMANAGED_PLANNING_CONFLICT'),
      );

      fs.writeFileSync(proposalPath, proposalBytes);

      const executionPath = path.join(changeDirectory, 'execution.json');

      const executionBytes = fs.readFileSync(executionPath, 'utf8');

      fs.rmSync(executionPath);

      assert.throws(
        () =>
          getProposeStatus(
            repository,
            materialized.investigation!.investigationId,
          ),
        (error) => isWorkflowError(error, 'PLANNING_MATERIALIZATION_STALE'),
      );

      const divergentRecovery = structuredClone(planningInput);

      divergentRecovery.payload.proposal +=
        'A divergent replacement must not be written after a receipt exists.\n';

      assert.throws(
        () => resumePropose(repository, changeId, divergentRecovery),
        (error) => isWorkflowError(error, 'PLANNING_MATERIALIZATION_CONFLICT'),
      );

      assert.equal(fs.existsSync(executionPath), false);

      assert.equal(
        resumePropose(repository, changeId, planningInput).state,
        'waiting-for-plan-review',
      );

      assert.equal(fs.readFileSync(executionPath, 'utf8'), executionBytes);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});
