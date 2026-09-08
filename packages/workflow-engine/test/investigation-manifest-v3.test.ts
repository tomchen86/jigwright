import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVESTIGATION_V3_ATTEMPTED_TRANSITIONS,
  buildInvestigationManifestDraft,
  validateDraftForSeal,
  sealInvestigationManifestDraft,
  validateForAuthority,
  type OrdinaryInvestigationAuthoringState,
  type InvestigationAuthoringState,
  type InvestigationRequirementV3,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import fs from 'node:fs';
import path from 'node:path';
import { buildInvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest-builder.ts';
import { materializeInvestigationEvidenceView } from '../src/modules/investigation/manifest/investigation-materializer.ts';
import os from 'node:os';
import { runGitBuffer } from '../src/runtime/repository-transaction/git.ts';
import { git } from './fixture.ts';
import {
  type InvestigationTermContribution,
  previewInvestigationTermUnion,
} from '../src/modules/investigation/domain/investigation-terms.ts';
import { createMutationClassPolicy } from '../src/modules/source/mutation-class-policy.ts';
import { scanInvestigationTreeFacts } from '../src/modules/investigation/domain/investigation-scanner.ts';
import { deriveInvestigationGroupFacts } from '../src/modules/investigation/domain/investigation-groups.ts';
import {
  ordinaryAuthoringState,
  digest,
  authorityExpected,
  directBuilderInput,
  structuredInvestigationRequirements,
  baselineOf,
} from './investigation-manifest-fixture.ts';

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
    const emptyOrdinary = structuredClone(draft);
    if (emptyOrdinary.applicability.kind !== 'ordinary')
      assert.fail('ordinary');
    emptyOrdinary.applicability.replayContract.termContributions = [];
    emptyOrdinary.applicability.replayContract.canonicalTerms = [];
    emptyOrdinary.applicability.semanticDelta.investigationRoleResults = [];
    emptyOrdinary.applicability.semanticDelta.dispositions = [];
    emptyOrdinary.applicability.semanticDelta.whyOverlays = [];
    assert.equal(
      validateDraftForSeal({
        repositoryRoot: repository,
        draft: emptyOrdinary,
      }).outcome,
      'blocked',
      'empty ordinary evidence cannot become an exemption',
    );
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

    const unavailable = structuredClone(state);
    if (unavailable.applicabilityKind !== 'ordinary') assert.fail('ordinary');
    unavailable.ordinary.baseline.commitOid = 'f'.repeat(
      unavailable.ordinary.baseline.commitOid.length,
    );
    const missingBaseline = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state: unavailable,
    });
    assert.equal(missingBaseline.outcome, 'blocked');
    if (missingBaseline.outcome === 'blocked') {
      assert.equal(missingBaseline.blocker.failureCode, 'REPLAY_INPUT_MISSING');
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
      const fabricated = validateDraftForSeal({
        repositoryRoot: repository,
        draft: {
          ...built.draft,
          applicability: { ...built.draft.applicability, [absent]: [] },
        },
      });
      assert.equal(fabricated.outcome, 'blocked', absent);
      if (fabricated.outcome === 'blocked') {
        assert.equal(
          fabricated.blocker.failureCode,
          'MANIFEST_UNREPRESENTABLE',
        );
      }
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

    if (built.draft.applicability.kind !== 'ordinary') assert.fail('ordinary');
    assert.deepEqual(
      built.draft.applicability.semanticDelta.whyOverlays[0]!.semanticAuthor,
      state.ordinary.whyOverlays[0]!.semanticAuthor,
    );
    assert.equal(
      built.draft.applicability.semanticDelta.whyOverlays[0]!.semanticAssurance,
      'actor-attested-not-engine-verified',
    );

    const oldBlob = structuredClone(state);
    if (oldBlob.applicabilityKind !== 'ordinary') assert.fail('ordinary');
    oldBlob.ordinary.whyOverlays[0]!.blobOid = 'f'.repeat(
      firstHit.sourceObject.objectId.length,
    );
    const staleBlob = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state: oldBlob,
    });
    assert.equal(staleBlob.outcome, 'blocked');
    if (staleBlob.outcome === 'blocked') {
      assert.equal(staleBlob.blocker.failureCode, 'SOURCE_ANCHOR_UNRESOLVED');
    }

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
