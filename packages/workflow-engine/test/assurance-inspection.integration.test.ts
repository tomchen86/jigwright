import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { inspectChangeAssurance } from '../src/runtime/repository-validation/assurance-inspection.ts';
import { deriveInvestigationGroupFacts } from '../src/modules/investigation/domain/investigation-groups.ts';
import { scanInvestigationTreeFacts } from '../src/composition-root/investigation-production.ts';
import {
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
} from '../src/modules/investigation/domain/investigation-terms.ts';
import { sealInvestigationManifestDraft } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { buildInvestigationManifestDraft } from '../src/composition-root/investigation-production.ts';
import {
  type InvestigationAuthoringState,
  type InvestigationManifestV3,
} from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import type { InvestigationRequirementV3 } from '../src/modules/investigation/manifest/investigation-requirement-types.ts';
import { buildGlobalPlanReviewCoverageRequirement } from '../src/modules/assurance/plan-review-coverage.ts';
import { createMutationClassPolicy } from '../src/modules/source/mutation-class-policy.ts';
import { investigationManifestPublicationNamespace } from '../src/modules/investigation/manifest/investigation-publication-contracts.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const CHANGE_ID = 'demo-change';

test('ordinary inspection replays current v3 hit paths from its pinned Manifest', () => {
  const repository = createFixtureRepository();
  try {
    installOrdinaryManifest(repository);

    const inspection = inspectChangeAssurance(repository, CHANGE_ID, {
      now: new Date('2026-08-22T00:00:00.000Z'),
    });

    assert.equal(inspection.hitPathCount, 1);
    assert.deepEqual(inspection.declaredChangeClasses, []);
    assert.equal(inspection.floors.planning, 'individual-only');
    assert.equal(inspection.escalated, true);
    assert.ok(
      inspection.reasons.includes(
        'hit-path-role:lifecycle:src/assurance-critical.ts',
      ),
    );
    assert.equal('shadowMetrics' in inspection, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('exemption inspection reads declared paths and classes from current v3', () => {
  const repository = createFixtureRepository();
  try {
    installExemptionManifest(repository);

    const inspection = inspectChangeAssurance(repository, CHANGE_ID, {
      now: new Date('2026-08-22T00:00:00.000Z'),
    });

    assert.equal(inspection.hitPathCount, 1);
    assert.deepEqual(inspection.declaredChangeClasses, ['documentation-only']);
    assert.equal(inspection.escalated, false);
    assert.ok(inspection.reasons.includes('declared-class:documentation-only'));
    assert.ok(inspection.reasons.includes('scan-hit-paths-all-ordinary:1'));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an assessment reproduces exactly from the same current v3 authority', () => {
  const repository = createFixtureRepository();
  try {
    installOrdinaryManifest(repository);
    const now = new Date('2026-08-22T00:00:00.000Z');

    const first = inspectChangeAssurance(repository, CHANGE_ID, { now });
    const second = inspectChangeAssurance(repository, CHANGE_ID, { now });

    assert.deepEqual(second, first);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current inspection rejects a historical v1 investigation', () => {
  const repository = createFixtureRepository();
  try {
    writeInvestigation(repository, {
      schemaVersion: 1,
      kind: 'investigation-artifact',
      changeId: CHANGE_ID,
      legacyMigration: true,
      nodes: [],
      currentRefs: {},
    });

    assert.throws(
      () => inspectChangeAssurance(repository, CHANGE_ID),
      (error) => isWorkflowError(error, 'SCHEMA_V1_FORBIDDEN'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a v3 Manifest without its exact private current ref is refused', () => {
  const repository = createFixtureRepository();
  try {
    const manifest = installExemptionManifest(repository);
    fs.rmSync(currentRefPath(repository, manifest));

    assert.throws(
      () => inspectChangeAssurance(repository, CHANGE_ID),
      (error) => isWorkflowError(error, 'REVIEW_TARGET_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a change without an investigation is refused, not assumed safe', () => {
  const repository = createFixtureRepository();
  try {
    fs.rmSync(
      path.join(repository, 'openspec/changes/demo-change/investigation.json'),
      { force: true },
    );
    assert.throws(
      () => inspectChangeAssurance(repository, CHANGE_ID),
      (error) => isWorkflowError(error, 'ASSURANCE_INSPECTION_UNAVAILABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function installOrdinaryManifest(repository: string): InvestigationManifestV3 {
  fs.writeFileSync(
    path.join(repository, 'src/assurance-critical.ts'),
    'export const AssuranceInspectionNeedle = true;\n',
  );
  writePathRoles(repository, {
    lifecycle: ['src/assurance-critical.ts'],
    ordinary: ['docs/**', 'openspec/**', 'workflow/**'],
  });
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create assurance inspection baseline']);

  const baseline = baselineOf(repository);
  const termContributions: InvestigationTermContribution[] = [
    {
      source: 'engine',
      reference: 'engine-floor:assurance-inspection',
      terms: [
        {
          kind: 'symbol',
          value: 'AssuranceInspectionNeedle',
        },
      ],
    },
  ];
  const preview = previewInvestigationTermUnion(termContributions);
  if (preview.outcome !== 'ready') assert.fail('term preview must be ready');
  const mutationPolicy = createMutationClassPolicy({ rules: [] });
  const scan = scanInvestigationTreeFacts({
    repositoryRoot: repository,
    treeOid: baseline.treeOid,
    terms: preview.terms,
  });
  if (scan.outcome !== 'ready') assert.fail('scan facts must be ready');
  const grouping = deriveInvestigationGroupFacts({
    scanFacts: scan.facts,
    mutationPolicy,
    declaredRoots: [{ rootId: 'repository', path: '' }],
    reviewedRelationships: [],
  });
  const state: InvestigationAuthoringState = {
    schemaVersion: 1,
    applicabilityKind: 'ordinary',
    repositoryId: 'fixture',
    changeId: CHANGE_ID,
    investigationId: 'assurance-inspection-v3',
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Inspect one exact lifecycle scan hit.',
      sourceRefs: [],
      explicitPaths: [],
      explicitSymbols: ['AssuranceInspectionNeedle'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    authoring: {
      sessionRevision: 1,
      sessionSnapshotDigest: digest('ordinary-session-snapshot'),
    },
    ordinary: {
      baseline,
      termContributions,
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
        rationale: 'The hit exists only to exercise assurance inspection.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:assurance-inspection-dispositions',
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
          grantUse: null,
          roleContextSharingUse: null,
        },
      ],
      floorOverflowDecision: null,
      exceptions: [],
      investigationRequirements: [
        emptyCoverageRequirement({
          investigationId: 'assurance-inspection-v3',
          changeId: CHANGE_ID,
          baseline,
          coverageTier: 'critical',
        }),
      ],
      assuranceFacts: {
        assessmentDigest: digest('assurance-assessment'),
        coverageTier: 'critical',
        escalated: true,
        reasons: ['hit-path-role:lifecycle:src/assurance-critical.ts'],
        provenanceDigest: digest('assurance-provenance'),
      },
    },
  };
  return sealAndInstall(repository, state);
}

function installExemptionManifest(repository: string): InvestigationManifestV3 {
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'docs/assurance.md'), '# Assurance\n');
  writePathRoles(repository, {
    ordinary: ['docs/**', 'openspec/**', 'workflow/**'],
  });
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create assurance exemption baseline']);

  const state: InvestigationAuthoringState = {
    schemaVersion: 1,
    applicabilityKind: 'exemption',
    repositoryId: 'fixture',
    changeId: CHANGE_ID,
    investigationId: 'assurance-inspection-exemption-v3',
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Refresh assurance documentation only.',
      sourceRefs: [],
      explicitPaths: ['docs/assurance.md'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    authoring: {
      sessionRevision: 1,
      sessionSnapshotDigest: digest('exemption-session-snapshot'),
    },
    exemption: {
      category: 'documentation-only',
      baseline: baselineOf(repository),
      declaredPaths: ['docs/assurance.md'],
      declaredChangeClasses: ['documentation-only'],
      rationale: 'The exact declared path contains prose only.',
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:assurance-inspection-exemption',
      },
      nonTrivialBehaviorReliance: 'none-declared',
      researchBudgetMinutes: null,
    },
  };
  return sealAndInstall(repository, state);
}

function sealAndInstall(
  repository: string,
  state: InvestigationAuthoringState,
): InvestigationManifestV3 {
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state,
  });
  if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:assurance-inspection-approval',
      },
      approvalProvenanceDigest: digest('assurance-inspection-approval'),
    },
  });
  if (sealed.outcome !== 'sealed') assert.fail(sealed.blocker.failureCode);
  writeInvestigation(repository, sealed.manifest);
  writeCurrentRef(repository, sealed.manifest);
  return sealed.manifest;
}

function emptyCoverageRequirement(input: {
  investigationId: string;
  changeId: string;
  baseline: { commitOid: string; treeOid: string };
  coverageTier: 'standard' | 'elevated' | 'critical';
}): InvestigationRequirementV3 {
  return {
    kind: 'plan-review-coverage-requirement',
    requirementId: 'plan-review-coverage',
    coverage: buildGlobalPlanReviewCoverageRequirement({
      investigationId: input.investigationId,
      changeId: input.changeId,
      baseline: {
        head: input.baseline.commitOid,
        tree: input.baseline.treeOid,
      },
      coverageTier: input.coverageTier,
      sealedSamplingSeed: digest('assurance-plan-review-coverage-seed'),
      targets: [],
      semanticReuse: {
        schemaVersion: 1,
        kind: 'semantic-reuse-coverage',
        owedCount: 0,
        carriedCount: 0,
        carried: [],
        resolutions: [],
        reviewTargets: [],
      },
    }),
    semanticAuthor: {
      id: 'investigation-reviewer',
      provenance: 'checkpoint:plan-review-coverage',
    },
    provenanceDigest: digest('assurance-plan-review-coverage-provenance'),
  };
}

function writeInvestigation(repository: string, value: unknown): void {
  const target = path.join(
    repository,
    'openspec/changes',
    CHANGE_ID,
    'investigation.json',
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${canonicalJson(value)}\n`);
}

function writeCurrentRef(
  repository: string,
  manifest: InvestigationManifestV3,
): void {
  const refPath = currentRefPath(repository, manifest);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(
    refPath,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'investigation-manifest-current',
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest:
        manifest.investigationApproval.investigationTargetDigest,
      manifestPath: `openspec/changes/${manifest.changeId}/investigation.json`,
    })}\n`,
  );
}

function currentRefPath(
  repository: string,
  manifest: InvestigationManifestV3,
): string {
  return path.join(
    discoverRepository(repository).gitCommonDirectory,
    'workflow-engine',
    investigationManifestPublicationNamespace(manifest),
    'current.json',
  );
}

function writePathRoles(
  repository: string,
  roles: Record<string, string[]>,
): void {
  fs.writeFileSync(
    path.join(repository, 'workflow/path-roles.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'path-role-registry',
      roles,
    })}\n`,
  );
}

function baselineOf(repository: string) {
  return {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
