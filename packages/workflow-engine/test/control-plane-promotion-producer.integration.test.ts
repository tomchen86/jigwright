import { controlPlanePromotionBootstrapObservations } from './control-plane-promotion-fixture.ts';
import { bootstrapInterventionStateRoot } from '../bootstrap/control-plane-trust.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { resolveControlPlaneEngineSelection } from '../bootstrap/control-plane-trust.ts';
import {
  produceControlPlaneApprovalCandidateV3,
  type ControlPlanePromotionReviewSummaryV3,
} from '../src/application/control-plane/control-plane-promotion-producer.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { dispatchProductionControlPlaneUpdaterCommand } from '../src/entrypoints/cli/intervention-control-updater-cli.ts';
import type { ControlPlaneApprovalSummaryV3 } from '../src/application/control-plane/intervention-control-updater.ts';
import {
  CONTROL_PLANE_FIXTURE_GRANT_SIGNER as GRANT_SIGNER,
  CONTROL_PLANE_FIXTURE_REPOSITORY_ID as REPOSITORY_ID,
  CONTROL_PLANE_FIXTURE_REVIEWER as REVIEWER,
  controlPlaneFixtureDigest as digest,
  controlPlaneFixtureUpdaterDependencies as updaterDependencies,
  setupControlPlaneProducerFixture as setupProducerFixture,
} from './control-plane-promotion-fixture.ts';

test('clean frozen Class-C candidate produces exact current reviewed material and updater consumes V3', async () => {
  const fixture = await setupProducerFixture();
  const {
    repository,
    stateRoot,
    initialized,
    beforeManifest,
    frozen,
    candidateArtifact,
    signing,
  } = fixture;
  try {
    const reviewCalls = { present: 0, human: 0, sign: 0 };
    const reviewSummaries: ControlPlanePromotionReviewSummaryV3[] = [];
    const reviewer = signing.signer(REVIEWER, reviewCalls);
    const verifyHumanSignature = signing.verifier;
    const produced = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(repository),
      stateRoot,
      frozen.candidateBundleDigest,
      {
        bootstrapObservations: controlPlanePromotionBootstrapObservations,
        candidateArtifacts: controlPlaneCandidateArtifacts,
        now: () => new Date('2026-08-10T10:03:00.000Z'),
        reviewSigner: reviewer,
        verifyHumanSignature,
        presentReviewSummary(summary) {
          reviewCalls.present += 1;
          reviewSummaries.push(summary);
        },
      },
    );
    assert.equal(produced.replayed, false);
    assert.equal(
      produced.candidate.kind,
      'persisted-control-plane-approval-candidate.v3',
    );
    assert.equal(
      produced.candidate.bundle.material.frozenCandidateBundleDigest,
      `sha256:${frozen.candidateBundleDigest}`,
    );
    assert.notEqual(
      produced.candidate.bundle.material.exactChanges.find(
        ({ path: filePath }) =>
          filePath === 'workflow/protected-capabilities.json',
      )?.beforeDigest,
      beforeManifest.manifestDigest,
      'raw manifest blob digest remains distinct from semantic closure digest',
    );
    assert.equal(
      produced.candidate.bundle.material.beforeClosureDigest,
      beforeManifest.manifestDigest,
    );
    assert.match(
      produced.candidate.bundle.independentReviewAttestation.signature,
      /-----BEGIN SSH SIGNATURE-----/,
    );
    assert.equal(
      produced.candidate.bundle.material.candidateExecutableProvenanceDigest.startsWith(
        'sha256:',
      ),
      true,
    );
    assert.equal(
      produced.candidate.bundle.material.recoveryBundle
        .restartExecutableProvenanceDigest,
      initialized.recordDigest,
    );
    assert.match(
      Buffer.from(
        produced.candidate.bundle.material.recoveryBundle
          .rollbackTestReportBase64,
        'base64',
      ).toString('utf8'),
      /control-plane-rollback-test-report\.v3/,
    );
    assert.deepEqual(reviewCalls, { present: 1, human: 1, sign: 1 });
    assert.equal(reviewSummaries.length, 1);

    const replayed = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(repository),
      stateRoot,
      frozen.candidateBundleDigest,
      {
        bootstrapObservations: controlPlanePromotionBootstrapObservations,
        candidateArtifacts: controlPlaneCandidateArtifacts,
        now: () => new Date('2026-08-10T10:04:00.000Z'),
        reviewSigner: reviewer,
        verifyHumanSignature,
        presentReviewSummary() {
          reviewCalls.present += 1;
        },
      },
    );
    assert.equal(replayed.replayed, true);
    assert.equal(
      replayed.candidate.recordDigest,
      produced.candidate.recordDigest,
    );
    assert.deepEqual(reviewCalls, { present: 1, human: 1, sign: 1 });

    const sameIdentityCalls = { present: 0, human: 0, sign: 0 };
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          bootstrapInterventionStateRoot,
          [
            'approve-and-apply',
            produced.candidate.candidateId,
            '--task',
            frozen.mandateBinding.mandateTaskId,
          ],
          stateRoot,
          updaterDependencies(
            frozen,
            signing.signer(REVIEWER, sameIdentityCalls),
            verifyHumanSignature,
          ),
          fs.realpathSync(repository),
        ),
      hasCode('CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT'),
    );
    assert.equal(sameIdentityCalls.sign, 0);

    const replacementReviewCalls = { present: 0, human: 0, sign: 0 };
    const independentlyReviewed = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(repository),
      stateRoot,
      frozen.candidateBundleDigest,
      {
        bootstrapObservations: controlPlanePromotionBootstrapObservations,
        candidateArtifacts: controlPlaneCandidateArtifacts,
        now: () => new Date('2026-08-10T10:04:30.000Z'),
        reviewSigner: signing.signer(GRANT_SIGNER, replacementReviewCalls),
        verifyHumanSignature,
        presentReviewSummary() {
          replacementReviewCalls.present += 1;
        },
      },
    );
    assert.equal(independentlyReviewed.replayed, false);
    assert.notEqual(
      independentlyReviewed.candidate.candidateId,
      produced.candidate.candidateId,
    );
    assert.deepEqual(replacementReviewCalls, {
      present: 1,
      human: 1,
      sign: 1,
    });

    const grantCalls = { present: 0, human: 0, sign: 0 };
    const approvalSummaries: ControlPlaneApprovalSummaryV3[] = [];
    const dependencies = updaterDependencies(
      frozen,
      signing.signer(REVIEWER, grantCalls),
      verifyHumanSignature,
      approvalSummaries,
    );
    const promoted = dispatchProductionControlPlaneUpdaterCommand(
      bootstrapInterventionStateRoot,
      [
        'approve-and-apply',
        independentlyReviewed.candidate.candidateId,
        '--task',
        frozen.mandateBinding.mandateTaskId,
      ],
      stateRoot,
      dependencies,
      fs.realpathSync(repository),
    );
    assert.equal(promoted.action, 'approve-and-apply');
    assert.equal(promoted.record?.kind, 'persisted-control-plane-update.v3');
    assert.equal(promoted.record?.transaction.updaterVersion, 3);
    assert.equal(promoted.record?.transaction.state, 'FINALIZED');
    assert.match(
      promoted.record?.envelope.signature ?? '',
      /-----BEGIN SSH SIGNATURE-----/,
    );
    assert.equal(
      promoted.supervisor.activeArtifact.artifactId,
      candidateArtifact.artifactId,
    );
    assert.deepEqual(grantCalls, { present: 0, human: 1, sign: 1 });
    assert.equal(approvalSummaries.length, 1);

    // This is the immutable bootstrap consumer gate: the ordinary launcher
    // must select the artifact from the finalized current terminal record.
    const launcherSelection = resolveControlPlaneEngineSelection(
      stateRoot,
      REPOSITORY_ID,
    );
    assert.equal(
      launcherSelection?.activeArtifact.artifactId,
      candidateArtifact.artifactId,
    );
  } finally {
    fixture.cleanup();
  }
});

test('producer rejects a sidecar EngineArtifact whose source is not the frozen candidate diff', async () => {
  const fixture = await setupProducerFixture({
    artifactSourceDigest: digest('caller-selected-unrelated-source'),
  });
  const calls = { present: 0, human: 0, sign: 0 };
  try {
    assert.throws(
      () =>
        produceControlPlaneApprovalCandidateV3(
          fs.realpathSync(fixture.repository),
          fixture.stateRoot,
          fixture.frozen.candidateBundleDigest,
          {
            bootstrapObservations: controlPlanePromotionBootstrapObservations,
            candidateArtifacts: controlPlaneCandidateArtifacts,
            now: () => new Date('2026-08-10T10:03:00.000Z'),
            reviewSigner: fixture.signing.signer(REVIEWER, calls),
            verifyHumanSignature: fixture.signing.verifier,
            presentReviewSummary() {
              calls.present += 1;
            },
          },
        ),
      hasCode('CONTROL_PLANE_PRODUCER_ARTIFACT_SOURCE_MISMATCH'),
    );
    assert.deepEqual(calls, { present: 0, human: 0, sign: 0 });
  } finally {
    fixture.cleanup();
  }
});

test('producer rejects a caller-selected state store before reading or signing', async () => {
  const fixture = await setupProducerFixture();
  const calls = { present: 0, human: 0, sign: 0 };
  try {
    assert.throws(
      () =>
        produceControlPlaneApprovalCandidateV3(
          fs.realpathSync(fixture.repository),
          `${fixture.stateRoot}-other-repository`,
          fixture.frozen.candidateBundleDigest,
          {
            bootstrapObservations: controlPlanePromotionBootstrapObservations,
            candidateArtifacts: controlPlaneCandidateArtifacts,
            now: () => new Date('2026-08-10T10:03:00.000Z'),
            reviewSigner: fixture.signing.signer(REVIEWER, calls),
            verifyHumanSignature: fixture.signing.verifier,
            presentReviewSummary() {
              calls.present += 1;
            },
          },
        ),
      hasCode('CONTROL_PLANE_PRODUCER_STATE_ROOT_MISMATCH'),
    );
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          bootstrapInterventionStateRoot,
          [
            'approve-and-apply',
            digest('nonexistent-persisted-candidate'),
            '--task',
            fixture.frozen.mandateBinding.mandateTaskId,
          ],
          `${fixture.stateRoot}-other-repository`,
          updaterDependencies(
            fixture.frozen,
            fixture.signing.signer(REVIEWER, calls),
            fixture.signing.verifier,
          ),
          fs.realpathSync(fixture.repository),
        ),
      hasCode('CONTROL_PLANE_PRODUCER_STATE_ROOT_MISMATCH'),
    );
    assert.deepEqual(calls, { present: 0, human: 0, sign: 0 });
  } finally {
    fixture.cleanup();
  }
});

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

import { controlPlaneCandidateArtifacts } from './control-plane-promotion-fixture.ts';
