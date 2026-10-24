import assert from 'node:assert/strict';
import { withTaskRevisionPlanningOperation } from '../src/application/revise/task-revision.ts';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type {
  MaintainerSignerFactory,
  MaintainerSignerProvider,
} from '../src/modules/authority/maintainer-signer-port.ts';
import { parseMaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import {
  approveAndApplyMaintainerGrantV2 as approve,
  revokeMaintainerGrantV2 as revoke,
} from '../src/application/control-plane/maintainer-approve.ts';
import { reissueAndApplyMaintainerGrantV2 as reissue } from '../src/application/control-plane/maintainer-approve.ts';
import {
  commitAuthoritySession as commit,
  SimulatedAuthorityCrash,
} from '../src/application/control-plane/maintainer-commit.ts';
import { recoverAuthorityCommit as recover } from '../src/application/control-plane/maintainer-recovery.ts';
import { withAuthorityRefusalAudit } from '../src/composition-root/authority-refusal-production.ts';
import { authorityApplicationReceipts } from '../src/composition-root/authority-application-receipt-production.ts';
import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import {
  maintainerGrantExecutionServices,
  startAuthoritySession,
} from '../bootstrap/maintainer-authority-production.ts';
import { inspectMaintainerGrants } from '../src/runtime/storage-journal/maintainer-store.ts';
import { git, isWorkflowError } from './fixture.ts';
import {
  prepareCandidate,
  fixtureV2SshSigner,
  approveAndApplyMaintainerGrantV2,
  TASK_ID,
  PROFILE_ID,
} from './support/maintainer-grant-v2-fixture.ts';
import type { ProposeDecisionServices } from '../src/application/propose/propose-decision-services.ts';
import { createSecondReplannedProposeFixture } from './investigation-propose-flow-fixture.ts';
import {
  fakeRunnerReport,
  planReviewCoverageEvidence,
} from './investigation-session-fixture.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import {
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
} from '../src/composition-root/propose-production.ts';
import type { EvidenceNode } from '../src/foundation/evidence-node/evidence-node.ts';

const NOW = new Date('2026-08-03T09:00:00.000Z');
const budget = { monotonicNow: () => 0 };
const request = () => ({
  changeId: 'demo-change',
  taskId: TASK_ID,
  externalEffects: [],
  profileId: PROFILE_ID,
  reason: 'Verify the required application signer capability',
  message: 'Apply exact signer binding candidate',
});
const common = (repository: string) =>
  fs.realpathSync(path.join(repository, '.git'));
const policyAt = (repository: string, ref: string) =>
  parseMaintainerPolicy(
    JSON.parse(
      git(repository, ['show', `${ref}:workflow/maintainer-policy.json`]),
    ),
  );
function operations(factory: MaintainerSignerFactory) {
  return {
    approve: approve.bind(
      undefined,
      factory,
      withAuthorityRefusalAudit,
      maintainerGrantExecutionServices,
      authorityApplicationReceipts,
      maintainerManifestOperations,
      taskMandateOperations,
    ),
    commit: commit.bind(
      undefined,
      factory,
      withAuthorityRefusalAudit,
      maintainerGrantExecutionServices,
      authorityApplicationReceipts,
      maintainerManifestOperations,
      taskMandateOperations,
    ),
    recover: recover.bind(
      undefined,
      factory,
      maintainerGrantExecutionServices,
      authorityApplicationReceipts,
      taskMandateOperations,
    ),
    reissue: reissue.bind(
      undefined,
      factory,
      withAuthorityRefusalAudit,
      maintainerGrantExecutionServices,
      authorityApplicationReceipts,
      maintainerManifestOperations,
      taskMandateOperations,
    ),
    revoke: revoke.bind(undefined, factory, withAuthorityRefusalAudit),
  };
}
function recordingFactory(
  repository: string,
  signer: MaintainerSignerProvider,
  events: string[],
  ref = 'HEAD',
): MaintainerSignerFactory {
  const policy = policyAt(repository, ref);
  return (root, observedPolicy) => {
    assert.equal(root, fs.realpathSync(repository));
    assert.deepEqual(observedPolicy, policy);
    events.push('factory');
    return {
      ...signer,
      assertHumanPresent() {
        events.push('presence');
        signer.assertHumanPresent();
      },
    };
  };
}
function issueWithoutApply(
  repository: string,
  signer: MaintainerSignerProvider,
): string {
  const stop = new Error('retain issued candidate');
  let id = '';
  assert.throws(
    () =>
      approveAndApplyMaintainerGrantV2(repository, request(), {
        now: NOW,
        signer,
        testAfterGrantIssued(grant) {
          id = grant.grantId;
          throw stop;
        },
      }),
    (error) => error === stop,
  );
  assert.ok(id);
  return id;
}

test('approval signer factory preserves policy, refusal ordering and explicit override', () => {
  for (const explicit of [false, true]) {
    const repository = prepareCandidate();
    try {
      const signer = fixtureV2SshSigner(repository);
      const events: string[] = [];
      const sentinel = new Error('signer factory sentinel');
      const fail: MaintainerSignerFactory = () => {
        events.push('unexpected factory');
        throw sentinel;
      };
      const bound = operations(
        explicit ? fail : recordingFactory(repository, signer, events),
      );
      assert.equal(events.length, 0, 'binding must be lazy');
      assert.throws(() =>
        bound.approve(
          repository,
          { ...request(), message: '' },
          { now: NOW, testPostApprovalBudget: budget },
        ),
      );
      assert.equal(events.length, 0, 'invalid input must precede factory');
      if (!explicit) {
        assert.throws(
          () =>
            operations(() => {
              throw sentinel;
            }).approve(repository, request(), {
              now: NOW,
              testPostApprovalBudget: budget,
            }),
          (error) => error === sentinel,
        );
      }
      const applied = bound.approve(repository, request(), {
        now: NOW,
        testPostApprovalBudget: budget,
        ...(explicit ? { signer } : {}),
      });
      assert.equal(
        git(repository, ['rev-parse', 'HEAD']).trim(),
        applied.commitHash,
      );
      assert.equal(
        events.filter((e) => e === 'factory').length,
        explicit ? 0 : 1,
      );
      assert.equal(events.includes('unexpected factory'), false);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('direct commit carries the required signer factory through completion and recovery', () => {
  const repository = prepareCandidate();
  try {
    const signer = fixtureV2SshSigner(repository);
    const id = issueWithoutApply(repository, signer);
    const session = startAuthoritySession(repository, 'demo-change', id, {
      now: NOW,
      signer,
      allowSignedV2Candidate: true,
    });
    const events: string[] = [];
    const bound = operations(recordingFactory(repository, signer, events));
    assert.throws(
      () =>
        bound.commit(repository, session.sessionId, request().message, {
          now: NOW,
          testPostApprovalBudget: budget,
          testCrashAfter: 'commit-created',
        }),
      SimulatedAuthorityCrash,
    );
    assert.equal(events.filter((e) => e === 'factory').length, 1);
    const result = bound.commit(
      repository,
      session.sessionId,
      request().message,
      { now: NOW, testPostApprovalBudget: budget },
    );
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      result.commitHash,
    );
    assert.equal(
      events.filter((e) => e === 'factory').length,
      2,
      'automatic recovery receives the same factory',
    );
    const fail = operations(() => {
      throw new Error('published replay must not construct signer');
    });
    assert.equal(
      fail.commit(repository, session.sessionId, request().message, {
        now: NOW,
        signer,
        testPostApprovalBudget: budget,
      }).commitHash,
      result.commitHash,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('historical reissue and revoke preserve current-policy signer selection', () => {
  for (const action of ['reissue', 'revoke'] as const) {
    const repository = prepareCandidate();
    try {
      const signer = fixtureV2SshSigner(repository);
      let id: string;
      if (action === 'reissue') {
        let clock = NOW;
        assert.throws(
          () =>
            approveAndApplyMaintainerGrantV2(
              repository,
              { ...request(), ttlMinutes: 1 },
              {
                now: NOW,
                signer,
                commitClock: () => clock,
                testBeforeRefUpdate() {
                  clock = new Date('2026-08-03T09:01:00.001Z');
                },
              },
            ),
          (error) =>
            isWorkflowError(error, 'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS'),
        );
        const expired = inspectMaintainerGrants(common(repository)).find(
          (x) => x.state === 'expired',
        );
        assert.ok(expired);
        id = expired.grantId;
      } else id = issueWithoutApply(repository, signer);
      const events: string[] = [];
      const bound = operations(recordingFactory(repository, signer, events));
      if (action === 'reissue') {
        const result = bound.reissue(
          repository,
          {
            priorGrantId: id,
            reason: 'Reissue retained candidate through canonical factory',
          },
          {
            now: new Date('2026-08-03T09:01:01.000Z'),
            testPostApprovalBudget: budget,
          },
        );
        assert.equal(result.applied, true);
      } else {
        bound.revoke(
          repository,
          { grantId: id, reason: 'Revoke through canonical factory' },
          { now: NOW },
        );
        operations(() => {
          throw new Error('explicit verifier must bypass factory');
        }).revoke(
          repository,
          { grantId: id, reason: 'Revoke through canonical factory' },
          { now: NOW, signer },
        );
      }
      assert.equal(events.filter((e) => e === 'factory').length, 1);
      assert.ok(events.includes('presence'));
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('receipt recovery creates a signer only for an unpublished portable receipt', () => {
  const repository = prepareCandidate();
  try {
    const signer = fixtureV2SshSigner(repository);
    assert.throws(
      () =>
        approveAndApplyMaintainerGrantV2(repository, request(), {
          now: NOW,
          signer,
          commitCrashAfter: 'commit-created',
        }),
      SimulatedAuthorityCrash,
    );
    const reserved = inspectMaintainerGrants(common(repository)).find(
      (x) => x.state === 'reserved',
    );
    assert.ok(reserved?.reservationSessionId);
    const events: string[] = [];
    const bound = operations(recordingFactory(repository, signer, events));
    const first = bound.recover(
      repository,
      reserved.reservationSessionId,
      NOW,
      { testPostApprovalBudget: budget },
    );
    assert.deepEqual(events, ['factory', 'presence']);
    const replay = operations(() => {
      throw new Error('existing receipt must bypass signer factory');
    }).recover(repository, reserved.reservationSessionId, NOW, {
      testPostApprovalBudget: budget,
    });
    assert.equal(replay.commitHash, first.commitHash);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      first.commitHash,
    );
    assert.deepEqual(events, ['factory', 'presence']);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('Propose disposition signer preserves receiver, baseline policy and override', () => {
  const fixture = createSecondReplannedProposeFixture();
  const {
    repository,
    reviewAuthority,
    changeId,
    twiceReplanned,
    twiceRevisedInvestigation,
    changeDirectory,
    adapterPolicyPath,
    adapterPolicyBytes,
  } = fixture;
  try {
    const evidence = planReviewCoverageEvidence(twiceRevisedInvestigation);
    runProviderWorker(repository, twiceReplanned.planReview!.invocationId, {
      runner(input) {
        return fakeRunnerReport(
          input.request,
          {
            verdict: 'advisory-approve' as const,
            scopeEvidence: evidence,
            findings: [
              {
                severity: 'medium' as const,
                category: 'missing-scope',
                summary: 'Check the exact signer binding',
                evidence,
              },
            ],
            proposedTerms: [],
            suggestions: [],
            residualRisk: 'Review cannot prove complete semantic coverage.',
            uncertainty: 'Provider execution is not same-user confined.',
          },
          input.invocationDirectory,
        );
      },
    });
    const status = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(
          repository,
          twiceReplanned.investigation!.investigationId,
        ),
      ),
    );
    assert.equal(status.state, 'awaiting-challenge-dispositions');
    const artifact = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'plan-review.json'), 'utf8'),
    ) as { nodes: EvidenceNode[] };
    const review = artifact.nodes.find((n) => n.type === 'plan-review');
    assert.ok(review);
    const finding = (review.output as { findings: { findingId: string }[] })
      .findings[0]!;
    const envelope = createPlanReviewDispositionsEnvelope(status, [
      {
        challengeId: finding.findingId,
        decision: 'rebutted',
        rationale: 'The exact dependency and evidence are reviewed.',
        author: reviewAuthority.identity,
        supersededBy: null,
      },
    ]);
    const events: string[] = [];
    const stop = new Error(
      'observe injected human presence before durable disposition',
    );
    const factory: MaintainerSignerFactory = function (
      this: unknown,
      root,
      policy,
    ) {
      assert.equal(arguments.length, 2);
      assert.ok(
        this &&
          typeof this === 'object' &&
          'createInteractiveSshSigner' in this,
      );
      assert.equal(this.createInteractiveSshSigner, factory);
      assert.equal(root, fs.realpathSync(repository));
      assert.deepEqual(
        policy,
        policyAt(repository, status.investigation!.baseline.head),
      );
      events.push('factory');
      return {
        ...reviewAuthority.signer,
        assertHumanPresent() {
          events.push('presence');
          throw stop;
        },
      };
    };
    const operations = proposeOperations(factory);
    assert.equal(events.length, 0);
    assert.throws(
      () =>
        operations.resumePropose(repository, changeId, envelope, {
          challengeDispositionAuthority: {
            now: new Date('2026-08-10T00:00:00.000Z'),
            role: 'reviewer',
          },
        }),
      (error) => error === stop,
    );
    assert.deepEqual(events, ['factory', 'presence']);
    fs.writeFileSync(adapterPolicyPath, adapterPolicyBytes);
    const completed = operations.resumePropose(repository, changeId, envelope, {
      challengeDispositionAuthority: {
        now: new Date('2026-08-10T00:00:00.000Z'),
        role: 'reviewer',
        signer: reviewAuthority.signer,
      },
    });
    assert.equal(completed.state, 'planning-complete');
    assert.deepEqual(
      events,
      ['factory', 'presence'],
      'supplied signer bypasses factory',
    );
  } finally {
    reviewAuthority.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

import { loadMaintainerPolicyForResolution } from '../src/runtime/repository-observation/human-resolution-grants.ts';
import { createInvestigationHumanActionBlocker } from '../src/composition-root/investigation-retry-production.ts';
import { taskMandateOperations } from '../src/composition-root/task-mandate-production.ts';
import { readPinnedPathDiff } from '../src/runtime/repository-observation/investigation-floor.ts';
import {
  readLedgerEntry,
  readLedgerIndex,
} from '../src/runtime/storage-journal/semantic-ledger-store.ts';
import { planningTransitionExecution as planningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { roleResultAdmission } from '../src/composition-root/role-admission-production.ts';
import {
  bindingFromRoleContextSharingGrantPayloadV1,
  canonicalRoleContextSharingGrantEnvelopeV1,
} from '../src/runtime/grants/optional-grants-package.ts';
import { parsePlanReviewArtifact } from '../src/composition-root/plan-review-artifact-production.ts';
import { investigationFailureObservations } from '../src/composition-root/investigation-failure-production.ts';
import {
  ensureWorkItemPromotionChangeDirectory,
  linkSourceToChange,
} from '../src/composition-root/work-registry-production.ts';
import { workRegistryQueries } from '../src/composition-root/work-registry-read-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import {
  scanInvestigationTreeFacts,
  materializeInvestigationEvidenceView,
} from '../src/composition-root/investigation-production.ts';
import {
  readGovernanceSource,
  captureGovernanceSource,
} from '../src/composition-root/governance-sources-production.ts';
import { planningDraftWorkspace } from '../src/composition-root/planning-workspace-production.ts';
import {
  createPlanningProviderAuthoringPort,
  planningProviderReviewedAssetMirrors,
  reviewedGeneratedAssets,
} from '../src/composition-root/planning-provider-authoring-production.ts';
/** Binds proposal workflows to required current planning and retry observations. */
import { createProposeOperations } from '../src/application/propose/propose-orchestrator.ts';
import {
  productionPlanningAssurance,
  planningAssuranceDependencies,
} from '../src/composition-root/planning-assurance-production.ts';
import { readProviderRetryAccountingEvidence } from '../src/runtime/storage-journal/provider-retry-accounting-reader.ts';

function proposeOperations(
  createInteractiveSshSigner: MaintainerSignerFactory,
) {
  const decisions = {
    createInteractiveSshSigner,
    withTaskRevisionPlanningOperation,
    planningProvider: {
      reviewedGeneratedAssets,
      createAuthoringPort: createPlanningProviderAuthoringPort,
      reviewedAssetMirrors: planningProviderReviewedAssetMirrors,
    },
    loadMaintainerPolicyForResolution,
    createInvestigationHumanActionBlocker,
    taskMandate: taskMandateOperations,
    semanticLedger: { readLedgerEntry, readLedgerIndex },
    planningExecution,
    roleAdmission: roleResultAdmission,
    roleContextSharingGrants: {
      bindingFromRoleContextSharingGrantPayloadV1,
      canonicalRoleContextSharingGrantEnvelopeV1,
    },
    parsePlanReviewArtifact,
    failureObservations: investigationFailureObservations,
    workRegistry: {
      ensureWorkItemPromotionChangeDirectory,
      linkSourceToChange,
      readCurrentChangeOrigin: workRegistryQueries.readCurrentChangeOrigin,
    },
    investigationEvidence: {
      readPinnedPathDiff,
      scanInvestigationTreeFacts,
      materializeInvestigationEvidenceView,
    },
    managedDocuments,
    loadChangeContract,
    sources: { readGovernanceSource, captureGovernanceSource },
    planningWorkspace: planningDraftWorkspace,
    planningAssurance: productionPlanningAssurance,
    planningEvidence: planningAssuranceDependencies,
    readProviderRetryAccountingEvidence,
  } satisfies ProposeDecisionServices;
  return createProposeOperations(decisions);
}
