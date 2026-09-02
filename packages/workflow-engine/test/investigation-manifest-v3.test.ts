import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { publishTrackedInvestigationManifestV3 } from '../src/application/propose/propose-orchestrator.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { deriveInvestigationGroupFacts } from '../src/modules/investigation/domain/investigation-groups.ts';
import {
  buildInvestigationManifestDraft,
  createInvestigationV3Blocker,
  INVESTIGATION_V3_ATTEMPTED_TRANSITIONS,
  sealInvestigationManifestDraft,
  validateDraftForSeal,
  validateForAuthority,
  type InvestigationAuthoringState,
  type InvestigationManifestV3,
  type InvestigationRequirementV3,
  type OrdinaryInvestigationAuthoringState,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import {
  buildInvestigationManifestV3,
  type BuildInvestigationManifestV3Input,
} from '../src/modules/investigation/manifest/investigation-manifest-builder.ts';
import { materializeInvestigationEvidenceView } from '../src/modules/investigation/manifest/investigation-materializer.ts';
import { runGitBuffer } from '../src/runtime/repository-transaction/git.ts';
import { scanInvestigationTreeFacts } from '../src/modules/investigation/domain/investigation-scanner.ts';
import {
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
} from '../src/modules/investigation/domain/investigation-terms.ts';
import { createMutationClassPolicy } from '../src/modules/source/mutation-class-policy.ts';
import {
  inspectInvestigationManifestPublication,
  investigationManifestPublicationNamespace,
  publishInvestigationManifestV3,
  readInvestigationPublicationRefState,
  resumeInvestigationManifestPublication,
  type InvestigationManifestPublicationLifecycleIdentity,
  type InvestigationManifestPublicationPaths,
  type InvestigationManifestPublicationPhase,
  type InvestigationManifestPublicationSnapshot,
} from '../src/runtime/managed-documents/transaction/investigation-publication.ts';
import {
  investigationV3FailureObservationPath,
  writeInvestigationV3FailureObservation,
} from '../src/runtime/storage-journal/investigation-v3-failure-store.ts';
import { createFixtureRepository, git } from './fixture.ts';

test('public Manifest v3 surface omits historical inspection', async () => {
  const publicSurface =
    await import('../src/composition-root/public/manifest-v3.ts');
  assert.equal('inspectHistorical' in publicSurface, false);
  assert.equal(
    INVESTIGATION_V3_ATTEMPTED_TRANSITIONS.includes(
      'historical-inspection' as never,
    ),
    false,
  );
});

test('ordinary v3 is built directly, sealed separately, and replayed from pinned Git', () => {
  const repository = createRepository();
  try {
    const state = ordinaryAuthoringState(repository);
    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
    assert.equal(built.outcome, 'built');
    const draft = built.draft;
    assert.equal(draft.schemaVersion, 3);
    assert.equal(draft.kind, 'manifest-first-investigation');
    assert.equal(draft.applicability.kind, 'ordinary');
    assert.equal(draft.investigationApproval, null);
    assert.equal(draft.manifestDigest, null);
    const serialized = canonicalJson(draft);
    for (const forbidden of [
      'nodes',
      'currentRefs',
      'legacyMigration',
      'nodeSchema',
      'outputSchema',
      'provenanceParentNodeIds',
      'semanticParentResultDigests',
    ]) {
      assert.equal(serialized.includes(`"${forbidden}"`), false);
    }

    const draftValidation = validateDraftForSeal({
      repositoryRoot: repository,
      draft,
    });
    if (draftValidation.outcome !== 'verified') {
      assert.fail(canonicalJson(draftValidation.blocker));
    }
    assert.equal(draftValidation.outcome, 'verified');
    const sealed = sealInvestigationManifestDraft({
      draft,
      approval: {
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:investigation-approval',
        },
        approvalProvenanceDigest: digest('approval-provenance'),
      },
    });
    if (sealed.outcome !== 'sealed') {
      assert.fail(sealed.blocker.failureCode);
    }
    assert.equal(sealed.outcome, 'sealed');
    assert.match(
      sealed.manifest.investigationApproval.sealDigest,
      /^[0-9a-f]{64}$/,
    );
    assert.match(sealed.manifest.manifestDigest, /^[0-9a-f]{64}$/);

    fs.writeFileSync(
      path.join(repository, 'src/domain.ts'),
      'dirty worktree content must not affect pinned replay\n',
    );
    const authority = validateForAuthority({
      repositoryRoot: repository,
      manifest: sealed.manifest,
      expected: {
        repositoryId: 'expense-app-test',
        changeId: 'manifest-first-v3',
        investigationId: 'investigation-v3-test',
        sessionRevision: 7,
        sessionSnapshotDigest: digest('session-snapshot'),
      },
    });
    if (authority.outcome !== 'verified') {
      assert.fail(authority.blocker.failureCode);
    }
    assert.equal(authority.outcome, 'verified');
    assert.equal(authority.manifestDigest, sealed.manifest.manifestDigest);

    const overKeyed = structuredClone(sealed.manifest) as unknown as Record<
      string,
      unknown
    >;
    overKeyed.unexpected = true;
    const rejected = validateForAuthority({
      repositoryRoot: repository,
      manifest: overKeyed,
      expected: authorityExpected(),
    });
    assert.equal(rejected.outcome, 'blocked');
    if (rejected.outcome === 'blocked') {
      assert.equal(rejected.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }

    const staleGroupRef = structuredClone(sealed.manifest);
    assert.equal(staleGroupRef.applicability.kind, 'ordinary');
    if (staleGroupRef.applicability.kind !== 'ordinary') {
      assert.fail('ordinary applicability expected');
    }
    staleGroupRef.applicability.semanticDelta.dispositions[0]!.groupRef.index = 999;
    const staleGroupRefResult = validateForAuthority({
      repositoryRoot: repository,
      manifest: staleGroupRef,
      expected: authorityExpected(),
    });
    assert.equal(staleGroupRefResult.outcome, 'blocked');
    if (staleGroupRefResult.outcome === 'blocked') {
      assert.equal(
        staleGroupRefResult.blocker.failureCode,
        'RECONSTRUCTION_MISMATCH',
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('normalized intent requires the exact current sourceRefs key', () => {
  const repository = createRepository();
  try {
    const state = ordinaryAuthoringState(repository);
    const normalizedIntent = {
      ...state.normalizedIntent,
      sourceRefs: [],
    } as Record<string, unknown>;
    delete normalizedIntent.sourceRefs;
    state.normalizedIntent = normalizedIntent as never;

    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    assert.equal(built.outcome, 'blocked');
    if (built.outcome === 'blocked') {
      assert.equal(built.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('production builder deterministically seals raw domain facts and rejects stale authority', () => {
  const repository = createRepository();
  try {
    const input = directBuilderInput(repository);
    const first = buildInvestigationManifestV3(input);
    if (first.outcome !== 'built') {
      assert.fail(canonicalJson(first.blocker));
    }
    const second = buildInvestigationManifestV3(structuredClone(input));
    if (second.outcome !== 'built') {
      assert.fail(canonicalJson(second.blocker));
    }

    assert.equal(first.manifest.schemaVersion, 3);
    assert.equal(first.manifest.kind, 'manifest-first-investigation');
    assert.equal(first.manifest.manifestDigest, first.manifestDigest);
    assert.equal(
      first.manifest.investigationApproval.investigationTargetDigest,
      first.investigationTargetDigest,
    );
    assert.deepEqual(
      first.manifest.applicability.kind === 'ordinary'
        ? first.manifest.applicability.semanticDelta.investigationRoleResults[0]
            ?.grantUse
        : null,
      {
        kind: 'collaboration-grant-use-identity.v1',
        grantId: '123e4567-e89b-42d3-a456-426614174000',
        signedEnvelopeDigest: digest('survey-grant-envelope'),
        transitionDigest: digest('survey-grant-transition'),
      },
    );
    assert.equal(canonicalJson(first.manifest), canonicalJson(second.manifest));

    const stale = buildInvestigationManifestV3({
      ...input,
      expected: {
        ...input.expected,
        sessionRevision: input.expected.sessionRevision + 1,
      },
    });
    assert.equal(stale.outcome, 'blocked');
    if (stale.outcome === 'blocked') {
      assert.equal(stale.blocker.failureCode, 'REVIEW_TARGET_STALE');
    }

    const staleFactsInput = structuredClone(input);
    staleFactsInput.scanFacts.treeDigest = digest('stale-scan-facts');
    const staleFacts = buildInvestigationManifestV3(staleFactsInput);
    assert.equal(staleFacts.outcome, 'blocked');
    if (staleFacts.outcome === 'blocked') {
      assert.equal(staleFacts.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }

    const source = fs.readFileSync(
      new URL(
        '../src/modules/investigation/manifest/investigation-manifest-builder.ts',
        import.meta.url,
      ),
      'utf8',
    );
    for (const forbidden of [
      'investigation-v2',
      'v2Oracle',
      'parity',
      'legacy-v2-shadow',
      'shadow',
      'grant',
      'launch',
    ]) {
      assert.equal(
        source.toLowerCase().includes(forbidden.toLowerCase()),
        false,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication inspects a prepared journal before safe pre-ref recovery', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'prepared-current',
    });
    const interrupted = interruptOrdinaryPublication(
      repository,
      manifest,
      'journal-prepared',
    );
    assert.equal(interrupted.result.outcome, 'blocked');

    publishOrdinaryThroughApplication(repository, manifest);

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: interrupted.context.git.gitCommonDirectory,
      paths: interrupted.paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'committed');
    assert.equal(
      readStoredPublicationOutcome(repository, manifest.investigationId).kind,
      'investigation-v3-failure-cleared',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication refuses a prepared journal for a different direct Manifest identity', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const preparedManifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'prepared-prior',
    });
    const directManifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'prepared-direct',
    });
    assert.notEqual(
      preparedManifest.manifestDigest,
      directManifest.manifestDigest,
    );
    const interrupted = interruptOrdinaryPublication(
      repository,
      preparedManifest,
      'journal-prepared',
    );
    const expectedInspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: interrupted.context.git.gitCommonDirectory,
      paths: interrupted.paths,
      lifecycle: publicationLifecycle(directManifest),
    });
    assert.equal(expectedInspection.outcome, 'recoverable');
    if (
      expectedInspection.outcome !== 'recoverable' ||
      expectedInspection.recoveryKind !== 'pre-ref'
    ) {
      assert.fail('expected a pre-ref recovery inspection');
    }

    let thrown: WorkflowError | null = null;
    try {
      publishOrdinaryThroughApplication(repository, directManifest);
      assert.fail('identity mismatch publication unexpectedly succeeded');
    } catch (error) {
      assert.ok(error instanceof WorkflowError);
      thrown = error;
    }
    assert.equal(thrown.code, 'RECONSTRUCTION_MISMATCH');
    assert.equal(
      fs.existsSync(
        path.join(
          interrupted.context.git.gitCommonDirectory,
          interrupted.paths.currentRefPath,
        ),
      ),
      false,
    );
    const storedBytes = readStoredPublicationBytes(
      repository,
      directManifest.investigationId,
    );
    const stored = JSON.parse(storedBytes) as {
      failure: {
        blocker: { failureCode: string; failureIdentity: string };
        source: {
          observation: { operation: string };
          failureIdentity: string;
        };
      };
    };
    assert.equal(storedBytes, `${canonicalJson(stored)}\n`);
    assert.equal(stored.failure.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    assert.equal(
      stored.failure.blocker.failureIdentity,
      thrown.details?.failureIdentity,
    );
    assert.equal(
      stored.failure.source.failureIdentity,
      stored.failure.blocker.failureIdentity,
    );
    assert.equal(stored.failure.source.observation.operation, 'inspect');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication persists the exact resume failure after current-ref CAS drift', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'cas-current',
    });
    const driftManifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'cas-drift',
    });
    const interrupted = interruptOrdinaryPublication(
      repository,
      manifest,
      'journal-prepared',
    );
    const currentRefPath = path.join(
      interrupted.context.git.gitCommonDirectory,
      interrupted.paths.currentRefPath,
    );
    writeCanonicalTestJson(
      currentRefPath,
      publicationCurrentRef(interrupted.paths.manifestPath, driftManifest),
    );
    const driftBytes = fs.readFileSync(currentRefPath);
    const expectedResume = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: interrupted.context.git.gitCommonDirectory,
      paths: interrupted.paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) =>
        operation(publicationSnapshot(repository, interrupted.paths, manifest)),
    });
    assert.equal(expectedResume.outcome, 'blocked');
    if (expectedResume.outcome !== 'blocked') {
      assert.fail('expected current-ref drift to block recovery');
    }
    assert.equal(expectedResume.blocker.failureCode, 'REVIEW_TARGET_STALE');

    assert.throws(
      () => publishOrdinaryThroughApplication(repository, manifest),
      (error: unknown) =>
        error instanceof WorkflowError && error.code === 'REVIEW_TARGET_STALE',
    );
    assert.deepEqual(fs.readFileSync(currentRefPath), driftBytes);
    assert.equal(
      readStoredPublicationBytes(repository, manifest.investigationId),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'investigation-v3-publication-failure-observation',
        authorityEligible: false,
        failure: expectedResume.failure,
      })}\n`,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication commits an exact post-ref recovery without replacing Manifest bytes', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'post-ref-current',
    });
    const interrupted = interruptOrdinaryPublication(
      repository,
      manifest,
      'current-ref-published',
    );
    const manifestPath = path.join(repository, interrupted.paths.manifestPath);
    const installed = fs.statSync(manifestPath, { bigint: true });

    publishOrdinaryThroughApplication(repository, manifest);

    const recovered = fs.statSync(manifestPath, { bigint: true });
    assert.deepEqual(
      { dev: recovered.dev, ino: recovered.ino },
      { dev: installed.dev, ino: installed.ino },
    );
    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: interrupted.context.git.gitCommonDirectory,
      paths: interrupted.paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'committed');
    assert.equal(
      readStoredPublicationOutcome(repository, manifest.investigationId).kind,
      'investigation-v3-failure-cleared',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication accepts a fresh revision after a committed same-path Manifest', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const revisionN = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'revision-n',
    });
    const revisionNPlusOne = ordinaryPublicationManifest(repository, {
      revision: 8,
      variant: 'revision-n-plus-one',
    });

    publishOrdinaryThroughApplication(repository, revisionN);
    publishOrdinaryThroughApplication(repository, revisionNPlusOne);

    const { context, paths } = ordinaryPublicationState(
      repository,
      revisionNPlusOne,
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(context.git.gitCommonDirectory, paths.currentRefPath),
          'utf8',
        ),
      ),
      publicationCurrentRef(paths.manifestPath, revisionNPlusOne),
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(repository, paths.manifestPath), 'utf8'),
      ).manifestDigest,
      revisionNPlusOne.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication persists an unsafe current-ref read failure byte-for-byte', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'unsafe-ref',
    });
    const { context, paths } = ordinaryPublicationState(repository, manifest);
    const currentRefPath = path.join(
      context.git.gitCommonDirectory,
      paths.currentRefPath,
    );
    const symlinkTarget = path.join(
      context.git.gitCommonDirectory,
      'unsafe-current-ref-target.json',
    );
    fs.mkdirSync(path.dirname(currentRefPath), { recursive: true });
    fs.writeFileSync(symlinkTarget, '{}\n');
    fs.symlinkSync(symlinkTarget, currentRefPath);
    const expectedRead = readInvestigationPublicationRefState({
      repositoryRoot: repository,
      privateRoot: context.git.gitCommonDirectory,
      currentRefPath: paths.currentRefPath,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(expectedRead.outcome, 'blocked');
    if (expectedRead.outcome !== 'blocked') {
      assert.fail('expected unsafe current-ref read to block');
    }

    assert.throws(
      () => publishOrdinaryThroughApplication(repository, manifest),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === expectedRead.blocker.failureCode,
    );
    assert.equal(
      readStoredPublicationBytes(repository, manifest.investigationId),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'investigation-v3-publication-failure-observation',
        authorityEligible: false,
        failure: expectedRead.failure,
      })}\n`,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication success clears a prior generic failure into a tombstone', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'success-clear',
    });
    const { context } = ordinaryPublicationState(repository, manifest);
    writeInvestigationV3FailureObservation({
      runtime: context.runtime,
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      emission: {
        schemaVersion: 1,
        sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
        currentRefDigest: `sha256:${digest('prior-current-ref')}`,
        effectiveState: 'investigation-sealed',
        lifecycleStateDigest: `sha256:${digest('prior-lifecycle-state')}`,
        gitStateDigest: `sha256:${digest('prior-git-state')}`,
      },
      blocker: createInvestigationV3Blocker({
        attemptedTransition: 'build-draft',
        candidate: { variant: 'prior-generic-failure' },
        failureCode: 'RECONSTRUCTION_MISMATCH',
        message: 'Seed a prior generic failure for success clearance.',
      }),
    });

    publishOrdinaryThroughApplication(repository, manifest);

    assert.deepEqual(
      readStoredPublicationOutcome(repository, manifest.investigationId),
      {
        schemaVersion: 1,
        kind: 'investigation-v3-failure-cleared',
        authorityEligible: false,
        repositoryId: manifest.repositoryId,
        changeId: manifest.changeId,
        investigationId: manifest.investigationId,
        sessionRevision: manifest.authoring.sessionRevision,
        sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
        manifestDigest: manifest.manifestDigest,
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v3 requirements preserve distinct structured contracts and reject payload tampering', () => {
  const repository = createRepository();
  try {
    const state = ordinaryAuthoringState(repository);
    assert.equal(state.applicabilityKind, 'ordinary');
    if (state.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    const requirements = structuredInvestigationRequirements(repository);
    state.ordinary.investigationRequirements = requirements;

    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') {
      assert.fail(canonicalJson(built.blocker));
    }
    assert.equal(built.draft.applicability.kind, 'ordinary');
    if (built.draft.applicability.kind !== 'ordinary') {
      assert.fail('ordinary applicability expected');
    }
    const preserved =
      built.draft.applicability.semanticDelta.investigationRequirements;
    assert.deepEqual(
      preserved.map(({ kind }) => kind),
      [
        'implementation-reconciliation-requirement',
        'plan-review-coverage-requirement',
      ],
    );
    assert.deepEqual(preserved, requirements);

    const sealed = sealInvestigationManifestDraft({
      draft: built.draft,
      approval: {
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:investigation-approval',
        },
        approvalProvenanceDigest: digest('structured-requirements-approval'),
      },
    });
    if (sealed.outcome !== 'sealed') {
      assert.fail(canonicalJson(sealed.blocker));
    }
    const authority = validateForAuthority({
      repositoryRoot: repository,
      manifest: sealed.manifest,
      expected: authorityExpected(),
    });
    if (authority.outcome !== 'verified') {
      assert.fail(canonicalJson(authority.blocker));
    }
    assert.deepEqual(
      authority.manifest.applicability.kind === 'ordinary'
        ? authority.manifest.applicability.semanticDelta
            .investigationRequirements
        : [],
      requirements,
    );

    const coverageTamper = structuredClone(state);
    assert.equal(coverageTamper.applicabilityKind, 'ordinary');
    if (coverageTamper.applicabilityKind !== 'ordinary') {
      assert.fail('ordinary state');
    }
    const coverageRequirement =
      coverageTamper.ordinary.investigationRequirements.find(
        (requirement) =>
          requirement.kind === 'plan-review-coverage-requirement',
      );
    if (coverageRequirement?.kind !== 'plan-review-coverage-requirement') {
      assert.fail('plan review coverage requirement expected');
    }
    coverageRequirement.coverage.costProfile.rawBytes += 1;
    const coverageRejected = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state: coverageTamper,
    });
    assert.equal(coverageRejected.outcome, 'blocked');
    if (coverageRejected.outcome === 'blocked') {
      assert.equal(
        coverageRejected.blocker.failureCode,
        'MANIFEST_UNREPRESENTABLE',
      );
    }

    const reconciliationTamper = structuredClone(state);
    assert.equal(reconciliationTamper.applicabilityKind, 'ordinary');
    if (reconciliationTamper.applicabilityKind !== 'ordinary') {
      assert.fail('ordinary state');
    }
    const reconciliationRequirement =
      reconciliationTamper.ordinary.investigationRequirements.find(
        (requirement) =>
          requirement.kind === 'implementation-reconciliation-requirement',
      );
    if (
      reconciliationRequirement?.kind !==
      'implementation-reconciliation-requirement'
    ) {
      assert.fail('implementation reconciliation requirement expected');
    }
    reconciliationRequirement.reconciliation.plannedMutations[0]!.subjectId =
      'file.noncanonical';
    const reconciliationRejected = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state: reconciliationTamper,
    });
    assert.equal(reconciliationRejected.outcome, 'blocked');
    if (reconciliationRejected.outcome === 'blocked') {
      assert.equal(
        reconciliationRejected.blocker.failureCode,
        'MANIFEST_UNREPRESENTABLE',
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary v3 rejects PlanReview coverage bound to another investigation', () => {
  const repository = createRepository();
  try {
    const input = directBuilderInput(repository);
    const coverageRequirement = input.investigationRequirements.find(
      (requirement) => requirement.kind === 'plan-review-coverage-requirement',
    );
    if (coverageRequirement?.kind !== 'plan-review-coverage-requirement') {
      assert.fail('plan review coverage requirement expected');
    }
    coverageRequirement.coverage.investigationId = 'another-investigation';

    const built = buildInvestigationManifestV3(input);
    assert.equal(built.outcome, 'blocked');
    if (built.outcome === 'blocked') {
      assert.equal(built.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }

    const valid = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state: ordinaryAuthoringState(repository),
    });
    if (valid.outcome !== 'built') assert.fail(valid.blocker.failureCode);
    const staleDraft = structuredClone(valid.draft);
    assert.equal(staleDraft.applicability.kind, 'ordinary');
    if (staleDraft.applicability.kind !== 'ordinary') {
      assert.fail('ordinary applicability expected');
    }
    const staleCoverage =
      staleDraft.applicability.semanticDelta.investigationRequirements.find(
        (requirement) =>
          requirement.kind === 'plan-review-coverage-requirement',
      );
    if (staleCoverage?.kind !== 'plan-review-coverage-requirement') {
      assert.fail('plan review coverage requirement expected');
    }
    staleCoverage.coverage.investigationId = 'another-investigation';
    const admitted = validateDraftForSeal({
      repositoryRoot: repository,
      draft: staleDraft,
    });
    assert.equal(admitted.outcome, 'blocked');
    if (admitted.outcome === 'blocked') {
      assert.equal(admitted.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary v3 admits generic and implementation requirements only with one exactly bound coverage requirement', () => {
  const repository = createRepository();
  try {
    const state = ordinaryAuthoringState(repository);
    assert.equal(state.applicabilityKind, 'ordinary');
    if (state.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    state.ordinary.investigationRequirements.push({
      kind: 'investigation-requirement',
      requirementId: 'generic-review-note',
      text: 'Preserve the generic requirement arm.',
      semanticAuthor: {
        id: 'investigation-reviewer',
        provenance: 'checkpoint:generic-requirement',
      },
      provenanceDigest: digest('generic-requirement-provenance'),
    });
    const valid = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (valid.outcome !== 'built') assert.fail(canonicalJson(valid.blocker));

    const cases: Array<{
      name: string;
      mutate(candidate: OrdinaryInvestigationAuthoringState): void;
    }> = [
      {
        name: 'missing coverage',
        mutate(candidate) {
          candidate.ordinary.investigationRequirements =
            candidate.ordinary.investigationRequirements.filter(
              (requirement) =>
                requirement.kind !== 'plan-review-coverage-requirement',
            );
        },
      },
      {
        name: 'duplicate coverage',
        mutate(candidate) {
          const coverage = candidate.ordinary.investigationRequirements.find(
            (requirement) =>
              requirement.kind === 'plan-review-coverage-requirement',
          );
          if (coverage?.kind !== 'plan-review-coverage-requirement') {
            assert.fail('plan review coverage requirement expected');
          }
          candidate.ordinary.investigationRequirements.push({
            ...structuredClone(coverage),
            requirementId: 'plan-review-coverage-duplicate',
          });
        },
      },
      {
        name: 'wrong change',
        mutate(candidate) {
          coverageRequirementOf(candidate).coverage.changeId = 'other-change';
        },
      },
      {
        name: 'wrong baseline commit',
        mutate(candidate) {
          coverageRequirementOf(candidate).coverage.baselineCommit = 'f'.repeat(
            40,
          );
        },
      },
      {
        name: 'wrong baseline tree',
        mutate(candidate) {
          coverageRequirementOf(candidate).coverage.baselineTree = 'e'.repeat(
            40,
          );
        },
      },
      {
        name: 'noncanonical child identity',
        mutate(candidate) {
          coverageRequirementOf(candidate).coverage.investigationId =
            ' investigation-v3-test';
        },
      },
    ];
    for (const testCase of cases) {
      const candidate: OrdinaryInvestigationAuthoringState =
        structuredClone(state);
      assert.equal(candidate.applicabilityKind, 'ordinary');
      if (candidate.applicabilityKind !== 'ordinary') {
        assert.fail('ordinary state');
      }
      testCase.mutate(candidate);
      const built = buildInvestigationManifestDraft({
        repositoryRoot: repository,
        state: candidate,
      });
      assert.equal(built.outcome, 'blocked', testCase.name);
      if (built.outcome === 'blocked') {
        assert.equal(
          built.blocker.failureCode,
          'MANIFEST_UNREPRESENTABLE',
          testCase.name,
        );
      }
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v3 exemption is a strict separate branch with no synthetic proof collections', () => {
  const repository = createRepository();
  try {
    const baseline = baselineOf(repository);
    const state: InvestigationAuthoringState = {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: 'expense-app-test',
      changeId: 'manifest-first-v3-exemption',
      investigationId: 'investigation-v3-exemption',
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Refresh explanatory documentation only.',
        sourceRefs: [],
        explicitPaths: ['docs/example.md'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: {
        sessionRevision: 0,
        sessionSnapshotDigest: digest('exemption-snapshot'),
      },
      exemption: {
        category: 'documentation-only',
        baseline,
        declaredPaths: ['docs/example.md'],
        declaredChangeClasses: ['documentation-only'],
        rationale: 'Only prose changes; no behavior is relied upon.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:exemption',
        },
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      },
    };
    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
    assert.equal(built.outcome, 'built');
    assert.equal(built.draft.applicability.kind, 'exemption');
    const serialized = canonicalJson(built.draft.applicability);
    for (const absent of [
      'replayContract',
      'semanticDelta',
      'derivedCommitments',
      'canonicalTerms',
      'dispositions',
      'whyOverlays',
    ]) {
      assert.equal(serialized.includes(`"${absent}"`), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v3 validation rejects schema v1 through a structured non-grant blocker', () => {
  const repository = createRepository();
  try {
    const result = validateForAuthority({
      repositoryRoot: repository,
      manifest: {
        schemaVersion: 1,
        kind: 'investigation-artifact',
      },
      expected: authorityExpected(),
    });
    assert.equal(result.outcome, 'blocked');
    if (result.outcome === 'blocked') {
      assert.equal(result.blocker.failureCode, 'SCHEMA_V1_FORBIDDEN');
      assert.equal('grantId' in result.blocker, false);
      assert.equal(
        canonicalJson(result.blocker).toLowerCase().includes('grant'),
        false,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('MaterializedEvidenceView is process-local and the direct writer has no projection dependency', () => {
  const repository = createRepository();
  try {
    const state = ordinaryAuthoringState(repository);
    assert.equal(state.applicabilityKind, 'ordinary');
    if (state.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    const view = materializeInvestigationEvidenceView({
      repositoryRoot: repository,
      authoring: state.ordinary,
    });
    assert.throws(
      () => JSON.stringify(view),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'PROJECTION_PIPELINE_FORBIDDEN',
    );
    assert.deepEqual(
      Object.keys(view),
      [],
      'the process-local view must not expose serializable own state',
    );
    assert.deepEqual(
      structuredClone(view),
      {},
      'structured cloning the view must not copy evidence into a durable shape',
    );
    assert.deepEqual(view.canonicalTerms, state.ordinary.canonicalTerms);
    for (const sourceUrl of [
      new URL(
        '../src/modules/investigation/manifest/investigation-manifest.ts',
        import.meta.url,
      ),
      new URL(
        '../src/modules/investigation/manifest/investigation-materializer.ts',
        import.meta.url,
      ),
    ]) {
      const source = fs.readFileSync(sourceUrl, 'utf8');
      assert.equal(source.includes('investigation-artifact-projection'), false);
      assert.equal(source.includes('createEvidenceNode'), false);
      assert.equal(source.includes("from './evidence-node.ts'"), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('every load-bearing path/blob has exactly one complete WHY overlay or fresh knowledge reuse', () => {
  const repository = createRepository();
  try {
    const state = ordinaryAuthoringState(repository);
    assert.equal(state.applicabilityKind, 'ordinary');
    if (state.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    state.ordinary.dispositionDecisions =
      state.ordinary.dispositionDecisions.map((decision) => ({
        ...decision,
        classification: 'load-bearing',
      }));
    const missing = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    assert.equal(missing.outcome, 'blocked');
    if (missing.outcome === 'blocked') {
      assert.equal(
        missing.blocker.failureCode,
        'SEMANTIC_COMPLETENESS_FAILURE',
      );
    }

    const view = materializeInvestigationEvidenceView({
      repositoryRoot: repository,
      authoring: state.ordinary,
    });
    const firstHit = view.grouping.hits[0]!;
    state.ordinary.whyOverlays = [
      {
        overlayId: 'why:domain-source',
        pathIdentity: firstHit.path,
        blobOid: firstHit.sourceObject.objectId,
        contentSha256: firstHit.sourceObject.contentSha256!,
        groupRefs: view.dispositions.map(({ groupRef }) => groupRef),
        anchors: view.grouping.hits.map((hit) => ({
          pathIdentity: hit.path,
          blobOid: hit.sourceObject.objectId,
          byteRange: {
            start: hit.byteOffset,
            end: hit.byteOffset + hit.byteLength,
          },
          termId: hit.termId,
        })),
        why: 'This source defines both Manifest-first fixture identities.',
        protectedInvariant: 'Both exact symbols remain bound to pinned bytes.',
        reviewerQuestion: 'Does the change preserve both source identities?',
        answer: 'Yes; both anchors are explicitly reconciled.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:why',
        },
        readComplete: true,
        semanticAssurance: 'actor-attested-not-engine-verified',
      },
    ];
    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') {
      assert.fail(canonicalJson(built.blocker));
    }
    assert.equal(built.draft.applicability.kind, 'ordinary');

    const stale = structuredClone(state);
    assert.equal(stale.applicabilityKind, 'ordinary');
    if (stale.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    stale.ordinary.whyOverlays[0]!.anchors[0]!.byteRange.end += 1;
    const rejected = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state: stale,
    });
    assert.equal(rejected.outcome, 'blocked');
    if (rejected.outcome === 'blocked') {
      assert.equal(rejected.blocker.failureCode, 'SOURCE_ANCHOR_UNRESOLVED');
    }

    const reused = structuredClone(state);
    assert.equal(reused.applicabilityKind, 'ordinary');
    if (reused.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    reused.ordinary.whyOverlays = [];
    reused.ordinary.knowledgeReuseDecisions = [
      {
        decisionId: 'reuse:domain-source',
        pathIdentity: firstHit.path,
        blobOid: firstHit.sourceObject.objectId,
        knowledgeRef: {
          subjectId: 'knowledge:manifest-first-domain',
          versionDigest: digest('knowledge-version'),
        },
        freshness: {
          decision: 'fresh',
          rationale: 'The immutable knowledge version names these exact bytes.',
          semanticAuthor: {
            id: 'owner',
            provenance: 'checkpoint:knowledge-reuse',
          },
          provenanceDigest: digest('knowledge-freshness'),
        },
      },
    ];
    const reusedBuilt = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state: reused,
    });
    if (reusedBuilt.outcome !== 'built') {
      assert.fail(canonicalJson(reusedBuilt.blocker));
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('raw-byte anchors replay identically for a non-UTF-8 Git path in another clone', () => {
  const repository = createRepository();
  const clone = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-manifest-v3-clone-'),
  );
  try {
    const rawPath = Buffer.concat([
      Buffer.from(`src/`, 'utf8'),
      Buffer.from('raw-', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('-anchor.ts', 'utf8'),
    ]);
    const rawBlob = runGitBuffer(repository, ['hash-object', '-w', '--stdin'], {
      input: Buffer.from('export const rawAnchor = true;\n', 'utf8'),
    })
      .toString('ascii')
      .trim();
    runGitBuffer(repository, ['update-index', '-z', '--index-info'], {
      input: Buffer.concat([
        Buffer.from(`100644 blob ${rawBlob}\t`, 'ascii'),
        rawPath,
        Buffer.from([0]),
      ]),
    });
    git(repository, ['commit', '-m', 'Add non UTF-8 investigation path']);
    const contribution: InvestigationTermContribution<'main'> = {
      source: 'main',
      reference: 'main:raw-path-anchor',
      terms: [
        {
          kind: 'literal-path',
          value: 'anchor.ts',
          rationale: 'Locate the raw-byte path suffix.',
          expectedRelationship: 'The invalid UTF-8 path is load-bearing.',
        },
      ],
    };
    const preview = previewInvestigationTermUnion([contribution]);
    assert.equal(preview.outcome, 'ready');
    if (preview.outcome !== 'ready') assert.fail('expected raw path term');
    const baseline = baselineOf(repository);
    const mutationPolicy = createMutationClassPolicy({ rules: [] });
    const scan = scanInvestigationTreeFacts({
      repositoryRoot: repository,
      treeOid: baseline.treeOid,
      terms: preview.terms,
    });
    assert.equal(scan.outcome, 'ready');
    if (scan.outcome !== 'ready') assert.fail('expected raw path scan');
    const grouping = deriveInvestigationGroupFacts({
      scanFacts: scan.facts,
      mutationPolicy,
      declaredRoots: [{ rootId: 'repository', path: '' }],
      reviewedRelationships: [],
    });
    assert.equal(grouping.hits.length, 1);
    assert.equal(grouping.hits[0]!.path.utf8, null);
    const ordinary: OrdinaryInvestigationAuthoringState['ordinary'] = {
      baseline,
      termContributions: [contribution],
      canonicalTerms: preview.terms,
      scanner: {
        allowSaturatedTerms: false,
        saturationDecision: null,
      },
      grouping: {
        mutationPolicy,
        declaredRoots: [{ rootId: 'repository', path: '' }],
        reviewedRelationships: [],
      },
      semanticGroupDecisions: [],
      dispositionDecisions: grouping.groups.map((group) => ({
        groupKey: group.key,
        classification: 'load-bearing',
        rationale: 'The raw-byte path is part of the planned behavior.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:raw-path-disposition',
        },
      })),
      whyOverlays: [],
      knowledgeReuseDecisions: [],
      investigationRoleResults: [
        {
          role: 'reviewer-pre-anchor' as const,
          targetDigest: digest('raw-role-target'),
          providerId: 'codex',
          sessionId: 'raw-path-session',
          principalId: null,
          requiredIndependence: 'provider-independent',
          achievedIndependence: 'provider-independent',
          requestDigest: digest('raw-role-request'),
          outputDigest: digest('raw-role-output'),
          contentDigest: digest('raw-role-content'),
          policyDigest: digest('raw-role-policy'),
          provenanceDigest: digest('raw-role-provenance'),
          grantUse: {
            kind: 'collaboration-grant-use-identity.v1',
            grantId: '123e4567-e89b-42d3-a456-426614174000',
            signedEnvelopeDigest: digest('survey-grant-envelope'),
            transitionDigest: digest('survey-grant-transition'),
          },
          roleContextSharingUse: null,
        },
      ],
      floorOverflowDecision: null,
      exceptions: [],
      investigationRequirements: structuredInvestigationRequirements(
        repository,
        {
          changeId: 'manifest-first-v3-raw-path',
          investigationId: 'investigation-v3-raw-path',
        },
      ),
      assuranceFacts: {
        assessmentDigest: digest('raw-assessment'),
        coverageTier: 'standard' as const,
        escalated: false,
        reasons: [],
        provenanceDigest: digest('raw-assessment-provenance'),
      },
    };
    const view = materializeInvestigationEvidenceView({
      repositoryRoot: repository,
      authoring: ordinary,
    });
    const hit = view.grouping.hits[0]!;
    ordinary.whyOverlays = [
      {
        overlayId: 'why:raw-path',
        pathIdentity: hit.path,
        blobOid: hit.sourceObject.objectId,
        contentSha256: hit.sourceObject.contentSha256!,
        groupRefs: view.dispositions.map(({ groupRef }) => groupRef),
        anchors: [
          {
            pathIdentity: hit.path,
            blobOid: hit.sourceObject.objectId,
            byteRange: {
              start: hit.byteOffset,
              end: hit.byteOffset + hit.byteLength,
            },
            termId: hit.termId,
          },
        ],
        why: 'The exact raw path identifies the load-bearing source.',
        protectedInvariant:
          'Invalid UTF-8 bytes are never replaced by display text.',
        reviewerQuestion: 'Does replay bind the same raw Git path bytes?',
        answer: 'Yes; rawBase64 and the half-open byte range are exact.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:raw-path-why',
        },
        readComplete: true as const,
        semanticAssurance: 'actor-attested-not-engine-verified' as const,
      },
    ];
    const state: InvestigationAuthoringState = {
      schemaVersion: 1,
      applicabilityKind: 'ordinary',
      repositoryId: 'expense-app-raw-path-test',
      changeId: 'manifest-first-v3-raw-path',
      investigationId: 'investigation-v3-raw-path',
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Bind a non UTF-8 Git path without lossy display conversion.',
        sourceRefs: [],
        explicitPaths: [],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: {
        sessionRevision: 1,
        sessionSnapshotDigest: digest('raw-path-snapshot'),
      },
      ordinary,
    };
    const original = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (original.outcome !== 'built') assert.fail(original.blocker.failureCode);

    fs.rmSync(clone, { recursive: true, force: true });
    git(repository, [
      'clone',
      '--no-hardlinks',
      '--no-checkout',
      repository,
      clone,
    ]);
    fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(clone, 'src/domain.ts'),
      'dirty clone bytes must not affect pinned raw-path replay\n',
    );
    const cloned = buildInvestigationManifestDraft({
      repositoryRoot: clone,
      state,
    });
    if (cloned.outcome !== 'built') assert.fail(cloned.blocker.failureCode);
    assert.equal(canonicalJson(cloned.draft), canonicalJson(original.draft));
    assert.equal(
      cloned.draft.applicability.kind === 'ordinary'
        ? cloned.draft.applicability.semanticDelta.whyOverlays[0]!.pathIdentity
            .utf8
        : 'wrong-branch',
      null,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  }
});

function ordinaryAuthoringState(
  repository: string,
): InvestigationAuthoringState {
  const normalizedIntent = {
    schemaVersion: 1 as const,
    summary: 'Introduce a ManifestFirst implementation.',
    sourceRefs: [],
    explicitPaths: [],
    explicitSymbols: ['ManifestFirst'],
    explicitConfigKeys: [],
    renamePairs: [],
  };
  const contributions: InvestigationTermContribution[] = [
    {
      source: 'engine',
      reference: 'engine-floor:manifest-first-v3',
      terms: [{ kind: 'symbol', value: 'ManifestFirst' }],
    },
    {
      source: 'main',
      reference: 'main:manifest-first-v3',
      terms: [
        {
          kind: 'literal-content',
          value: 'manifest-first',
          rationale: 'Locate the intended direct-writer fixture.',
          expectedRelationship: 'It is the behavior under investigation.',
        },
      ],
    },
  ];
  const preview = previewInvestigationTermUnion(contributions);
  assert.equal(preview.outcome, 'ready');
  if (preview.outcome !== 'ready') assert.fail('expected term union');
  const baseline = baselineOf(repository);
  const mutationPolicy = createMutationClassPolicy({ rules: [] });
  const scan = scanInvestigationTreeFacts({
    repositoryRoot: repository,
    treeOid: baseline.treeOid,
    terms: preview.terms,
  });
  assert.equal(scan.outcome, 'ready');
  if (scan.outcome !== 'ready') assert.fail('expected scan facts');
  const grouping = deriveInvestigationGroupFacts({
    scanFacts: scan.facts,
    mutationPolicy,
    declaredRoots: [{ rootId: 'repository', path: '' }],
    reviewedRelationships: [],
  });
  return {
    schemaVersion: 1,
    applicabilityKind: 'ordinary',
    repositoryId: 'expense-app-test',
    changeId: 'manifest-first-v3',
    investigationId: 'investigation-v3-test',
    normalizedIntent,
    authoring: {
      sessionRevision: 7,
      sessionSnapshotDigest: digest('session-snapshot'),
    },
    ordinary: {
      baseline,
      termContributions: contributions,
      canonicalTerms: preview.terms,
      scanner: {
        allowSaturatedTerms: false,
        saturationDecision: null,
      },
      grouping: {
        mutationPolicy,
        declaredRoots: [{ rootId: 'repository', path: '' }],
        reviewedRelationships: [],
      },
      semanticGroupDecisions: [],
      dispositionDecisions: grouping.groups.map((group) => ({
        groupKey: group.key,
        classification: 'irrelevant',
        rationale: 'The fixture proves replay but is not load-bearing.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:dispositions',
        },
      })),
      whyOverlays: [],
      knowledgeReuseDecisions: [],
      investigationRoleResults: [
        {
          role: 'reviewer-pre-anchor',
          targetDigest: digest('survey-target'),
          providerId: 'codex',
          sessionId: 'survey-session',
          principalId: null,
          requiredIndependence: 'provider-independent',
          achievedIndependence: 'provider-independent',
          requestDigest: digest('survey-request'),
          outputDigest: digest('survey-output'),
          contentDigest: digest('survey-content'),
          policyDigest: digest('survey-policy'),
          provenanceDigest: digest('survey-provenance'),
          grantUse: {
            kind: 'collaboration-grant-use-identity.v1',
            grantId: '123e4567-e89b-42d3-a456-426614174000',
            signedEnvelopeDigest: digest('survey-grant-envelope'),
            transitionDigest: digest('survey-grant-transition'),
          },
          roleContextSharingUse: null,
        },
      ],
      floorOverflowDecision: null,
      exceptions: [],
      investigationRequirements:
        structuredInvestigationRequirements(repository),
      assuranceFacts: {
        assessmentDigest: digest('assurance-assessment'),
        coverageTier: 'standard',
        escalated: false,
        reasons: [],
        provenanceDigest: digest('assurance-provenance'),
      },
    },
  };
}

function directBuilderInput(
  repository: string,
): BuildInvestigationManifestV3Input {
  const state = ordinaryAuthoringState(repository);
  assert.equal(state.applicabilityKind, 'ordinary');
  if (state.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
  const scan = scanInvestigationTreeFacts({
    repositoryRoot: repository,
    treeOid: state.ordinary.baseline.treeOid,
    terms: state.ordinary.canonicalTerms,
  });
  assert.equal(scan.outcome, 'ready');
  if (scan.outcome !== 'ready') assert.fail('expected scan facts');
  const groups = deriveInvestigationGroupFacts({
    scanFacts: scan.facts,
    mutationPolicy: state.ordinary.grouping.mutationPolicy,
    declaredRoots: state.ordinary.grouping.declaredRoots,
    reviewedRelationships: state.ordinary.grouping.reviewedRelationships,
  });
  return {
    repositoryRoot: repository,
    repositoryId: state.repositoryId,
    changeId: state.changeId,
    investigationId: state.investigationId,
    normalizedIntent: state.normalizedIntent,
    authoring: state.authoring,
    baseline: state.ordinary.baseline,
    termContributions: state.ordinary.termContributions,
    canonicalTerms: state.ordinary.canonicalTerms,
    scanFacts: scan.facts,
    groupFacts: groups,
    scanner: state.ordinary.scanner,
    grouping: state.ordinary.grouping,
    semanticGroupDecisions: state.ordinary.semanticGroupDecisions,
    dispositionDecisions: state.ordinary.dispositionDecisions,
    whyOverlays: state.ordinary.whyOverlays,
    knowledgeReuseDecisions: state.ordinary.knowledgeReuseDecisions,
    investigationRoleResults: state.ordinary.investigationRoleResults,
    floorOverflowDecision: state.ordinary.floorOverflowDecision,
    exceptions: state.ordinary.exceptions,
    investigationRequirements: state.ordinary.investigationRequirements,
    assuranceFacts: state.ordinary.assuranceFacts,
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:investigation-approval',
      },
      approvalProvenanceDigest: digest('approval-provenance'),
    },
    expected: authorityExpected(),
  };
}

function structuredInvestigationRequirements(
  repository: string,
  identity: {
    changeId: string;
    investigationId: string;
  } = {
    changeId: 'manifest-first-v3',
    investigationId: 'investigation-v3-test',
  },
): InvestigationRequirementV3[] {
  const baseline = baselineOf(repository);
  const target = {
    source: 'planned-mutation' as const,
    path: 'src/domain.ts',
    targetDigest: `sha256:${digest('review-target-content')}`,
    stratum: 'planned-mutation' as const,
    reusedFromLedger: false,
    subjectId: null,
    ledgerEntryId: null,
    invariants: ['ManifestFirst remains available.'],
    riskFactors: ['The exported symbol could drift.'],
    freshness: 'pinned-investigation-baseline',
    evidenceMode: 'full-blob' as const,
    degradedExtraction: false,
    cost: { rawBytes: 48, reviewUnits: 1 },
  };
  const targetId = `review-target:${digest(
    canonicalJson({ schema: 'plan-review-target-binding.v2', ...target }),
  )}`;
  const targetBinding = {
    targetId,
    ...target,
    evidenceKind: 'planning-or-repository-location' as const,
  };
  const coveragePolicyDigest = digest(
    canonicalJson({
      schemaVersion: 2,
      kind: 'plan-review-coverage-policy',
      activation: 'global',
      sampling: 'review-coverage.v1',
      evidence: 'namespace-correct-exact-location',
      targetFields: [
        'invariants',
        'risk-factors',
        'freshness',
        'evidence-mode',
        'degraded-extraction',
        'cost-profile',
      ],
    }),
  );
  const implementationPolicyDigest = digest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'implementation-reconciliation-policy',
      plannedIdentity: 'semantic-ledger-file-subject.v1',
      changedRanges: 'git-unified-zero-no-renames.v1',
      productionPaths: 'path-role-registry-fail-deep.v1',
      finalizationTermFloor: 'implementation-hunk-term-floor.v1',
      unplannedSubject: 'delta-review-required',
    }),
  );
  const author = {
    id: 'investigation-reviewer',
    provenance: 'checkpoint:structured-requirements',
  };
  return [
    {
      kind: 'implementation-reconciliation-requirement',
      requirementId: 'implementation-reconciliation',
      reconciliation: {
        schemaVersion: 1,
        kind: 'implementation-reconciliation-requirement',
        changeId: identity.changeId,
        baseline: { head: baseline.commitOid, tree: baseline.treeOid },
        policyDigest: implementationPolicyDigest,
        plannedMutations: [
          {
            subjectId: `file.${digest('src/domain.ts')}`,
            path: 'src/domain.ts',
            intendedChange: 'Introduce the ManifestFirst implementation.',
            invariantsToPreserve: ['ManifestFirst remains available.'],
          },
        ],
      },
      semanticAuthor: author,
      provenanceDigest: digest('implementation-reconciliation-provenance'),
    },
    {
      kind: 'plan-review-coverage-requirement',
      requirementId: 'plan-review-coverage',
      coverage: {
        schemaVersion: 2,
        kind: 'plan-review-coverage-requirement',
        activation: 'global',
        investigationId: identity.investigationId,
        changeId: identity.changeId,
        baselineCommit: baseline.commitOid,
        baselineTree: baseline.treeOid,
        coverageTier: 'standard',
        sealedSamplingSeed: digest('sealed-sampling-seed'),
        coveragePolicyDigest,
        manifest: {
          schemaVersion: 1,
          kind: 'review-coverage-manifest',
          tier: 'standard',
          targets: [
            {
              targetId,
              stratum: 'planned-mutation',
              reusedFromLedger: false,
            },
          ],
          populationDigest: digest(`${targetId} planned-mutation`),
        },
        requiredTargetIds: [targetId],
        targetBindings: [targetBinding],
        semanticReuse: {
          schemaVersion: 1,
          kind: 'semantic-reuse-coverage',
          owedCount: 0,
          carriedCount: 0,
          carried: [],
          resolutions: [],
          reviewTargets: [],
        },
        costProfile: { targetCount: 1, rawBytes: 48, reviewUnits: 1 },
      },
      semanticAuthor: author,
      provenanceDigest: digest('plan-review-coverage-provenance'),
    },
  ];
}

function coverageRequirementOf(
  state: OrdinaryInvestigationAuthoringState,
): Extract<
  InvestigationRequirementV3,
  { kind: 'plan-review-coverage-requirement' }
> {
  const requirement = state.ordinary.investigationRequirements.find(
    (candidate) => candidate.kind === 'plan-review-coverage-requirement',
  );
  if (requirement?.kind !== 'plan-review-coverage-requirement') {
    assert.fail('plan review coverage requirement expected');
  }
  return requirement;
}

function createOrdinaryPublicationRepository(): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'src/domain.ts'),
    'export const ManifestFirst = "manifest-first";\n',
  );
  git(repository, ['add', '--', 'src/domain.ts']);
  git(repository, ['commit', '-m', 'Add ordinary publication fixture']);
  fs.mkdirSync(path.join(repository, 'openspec/changes/manifest-first-v3'), {
    recursive: true,
  });
  return repository;
}

function ordinaryPublicationManifest(
  repository: string,
  input: { revision: number; variant: string },
): InvestigationManifestV3 {
  const base = directBuilderInput(repository);
  const sessionSnapshotDigest = digest(
    `publication-session-snapshot:${input.revision}`,
  );
  const built = buildInvestigationManifestV3({
    ...base,
    repositoryId: 'fixture',
    authoring: {
      sessionRevision: input.revision,
      sessionSnapshotDigest,
    },
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:investigation-approval',
      },
      approvalProvenanceDigest: digest(`publication-approval:${input.variant}`),
    },
    expected: {
      repositoryId: 'fixture',
      changeId: base.changeId,
      investigationId: base.investigationId,
      sessionRevision: input.revision,
      sessionSnapshotDigest,
    },
  });
  if (built.outcome !== 'built') {
    assert.fail(canonicalJson(built.blocker));
  }
  return built.manifest;
}

function ordinaryPublicationState(
  repository: string,
  manifest: InvestigationManifestV3,
) {
  const context = loadInvestigationRuntimeContext(repository);
  const lifecycle = publicationLifecycle(manifest);
  const namespace = investigationManifestPublicationNamespace(lifecycle);
  const paths: InvestigationManifestPublicationPaths = {
    manifestPath: `${context.config.changeRoot}/${manifest.changeId}/investigation.json`,
    currentRefPath: `${context.config.runtimeDirectory}/${namespace}/current.json`,
    journalPath: `${context.config.runtimeDirectory}/${namespace}/journal.json`,
  };
  return { context, lifecycle, paths };
}

function publicationLifecycle(
  manifest: InvestigationManifestV3,
): InvestigationManifestPublicationLifecycleIdentity {
  return {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
  };
}

function publicationSnapshot(
  repository: string,
  paths: InvestigationManifestPublicationPaths,
  manifest: InvestigationManifestV3,
): InvestigationManifestPublicationSnapshot {
  const context = loadInvestigationRuntimeContext(repository);
  const lifecycle = publicationLifecycle(manifest);
  const observed = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    privateRoot: context.git.gitCommonDirectory,
    currentRefPath: paths.currentRefPath,
    lifecycle,
  });
  if (observed.outcome !== 'read') {
    assert.fail(canonicalJson(observed.blocker));
  }
  return { ...lifecycle, currentRefDigest: observed.currentRefDigest };
}

function interruptOrdinaryPublication(
  repository: string,
  manifest: InvestigationManifestV3,
  phase: InvestigationManifestPublicationPhase,
) {
  const { context, lifecycle, paths } = ordinaryPublicationState(
    repository,
    manifest,
  );
  const expected = publicationSnapshot(repository, paths, manifest);
  const result = publishInvestigationManifestV3({
    repositoryRoot: repository,
    privateRoot: context.git.gitCommonDirectory,
    paths,
    manifest,
    expected,
    withTransitionLock: (operation) =>
      operation(publicationSnapshot(repository, paths, manifest)),
    observePhase: (observed) => {
      if (observed === phase) throw new Error(`interrupt after ${observed}`);
    },
  });
  return { context, lifecycle, paths, expected, result };
}

function publishOrdinaryThroughApplication(
  repository: string,
  manifest: InvestigationManifestV3,
): void {
  const context = loadInvestigationRuntimeContext(repository);
  publishTrackedInvestigationManifestV3({
    context,
    manifest,
    assertOwned() {},
    assertCurrent() {},
  });
}

function publicationCurrentRef(
  manifestPath: string,
  manifest: InvestigationManifestV3,
) {
  return {
    schemaVersion: 1,
    kind: 'investigation-manifest-current',
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    manifestDigest: manifest.manifestDigest,
    investigationTargetDigest:
      manifest.investigationApproval.investigationTargetDigest,
    manifestPath,
  };
}

function readStoredPublicationBytes(
  repository: string,
  investigationId: string,
): string {
  const context = loadInvestigationRuntimeContext(repository);
  return fs.readFileSync(
    investigationV3FailureObservationPath(context.runtime, investigationId),
    'utf8',
  );
}

function readStoredPublicationOutcome(
  repository: string,
  investigationId: string,
): Record<string, unknown> {
  return JSON.parse(
    readStoredPublicationBytes(repository, investigationId),
  ) as Record<string, unknown>;
}

function writeCanonicalTestJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`);
}

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-manifest-v3-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'manifest-v3@example.test']);
  git(repository, ['config', 'user.name', 'Manifest V3 Test']);
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'src/domain.ts'),
    'export const ManifestFirst = "manifest-first";\n',
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create manifest v3 fixture']);
  return repository;
}

function baselineOf(repository: string) {
  return {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
}

function authorityExpected() {
  return {
    repositoryId: 'expense-app-test',
    changeId: 'manifest-first-v3',
    investigationId: 'investigation-v3-test',
    sessionRevision: 7,
    sessionSnapshotDigest: digest('session-snapshot'),
  };
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
