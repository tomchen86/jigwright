import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { parseInvestigationArtifact } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import {
  createInvestigationCoverageNode,
  createInvestigationDispositionNodes,
  deriveInvestigationGroupFacts,
  deriveInvestigationGroups,
} from '../src/modules/investigation/domain/investigation-groups.ts';
import {
  buildInvestigationManifestDraft,
  sealInvestigationManifestDraft,
  validateForAuthority,
  type InvestigationRequirementV3,
  type OrdinaryInvestigationAuthoringState,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { buildGlobalPlanReviewCoverageRequirement } from '../src/modules/assurance/plan-review-coverage.ts';
import {
  projectInvestigationArtifactForTracking,
  type ProjectedInvestigationArtifact,
} from '../src/adapters/planning/investigation/investigation-artifact-projection.ts';
import { createInvestigationApplicability } from '../src/modules/investigation/domain/investigation-applicability.ts';
import {
  adaptInvestigationScanFactsResult,
  scanInvestigationTreeFacts,
} from '../src/modules/investigation/domain/investigation-scanner.ts';
import {
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
} from '../src/modules/investigation/domain/investigation-terms.ts';
import { createMutationClassPolicy } from '../src/modules/source/mutation-class-policy.ts';
import { git } from './fixture.ts';

const PRODUCTION_SCALE_HIT_COUNT = 400;

test('ordinary propose production is v3-only outside shared session and evidence primitives', () => {
  const source = fs.readFileSync(
    path.join(
      import.meta.dirname,
      '../src/application/propose/propose-orchestrator.ts',
    ),
    'utf8',
  );
  const planningInvestigationImports = [
    ...source.matchAll(
      /from '..\/..\/adapters\/planning\/investigation\/([^']+)'/gu,
    ),
  ]
    .map((match) => match[1])
    .filter((moduleName): moduleName is string => moduleName !== undefined);

  assert.deepEqual([...new Set(planningInvestigationImports)].sort(), [
    'evidence-node.ts',
    'investigation-session.ts',
  ]);

  for (const forbidden of [
    'investigation.seal.v2',
    'createInvestigationSealNode',
    'createInvestigationInventoryCurrentnessNode',
    'adaptInvestigationScanFactsResult',
    'deriveInvestigationGroups',
    'createInvestigationDispositionNodes',
    'createInvestigationCoverageNode',
    'createInvestigationWhyNodes',
    'readInvestigationWhyNode',
    'readInvestigationGroupNode',
    'createPlanReviewCoverageRequirementNode',
    'createGlobalPlanReviewCoverageRequirementNode',
    'readPlanReviewCoverageRequirementNode',
    'createImplementationReconciliationRequirementNode',
    'readImplementationReconciliationRequirementNode',
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `ordinary propose must not reference ${forbidden}`,
    );
  }

  assert.match(source, /\bscanInvestigationTreeFacts\b/u);
  assert.match(source, /\bderiveInvestigationGroupFacts\b/u);
});

test('current-v3 production no longer exports historical EvidenceNode replay wrappers', () => {
  for (const [relativePath, retiredExports] of [
    [
      '../src/modules/assurance/plan-review-coverage.ts',
      [
        'createPlanReviewCoverageRequirementNode',
        'createGlobalPlanReviewCoverageRequirementNode',
        'readPlanReviewCoverageRequirementNode',
        'assertPlanReviewCoverageRequirementSatisfied',
      ],
    ],
    [
      '../src/modules/why-knowledge/implementation-reconciliation.ts',
      [
        'createImplementationReconciliationRequirementNode',
        'readImplementationReconciliationRequirementNode',
      ],
    ],
    [
      '../src/runtime/managed-documents/transaction/semantic-ledger-projection.ts',
      [
        'projectInvestigationWhyToLedger',
        'projectReconciledInvestigationWhyToLedger',
      ],
    ],
    [
      '../src/modules/investigation/domain/investigation-groups.ts',
      ['deriveClassGroupsWithContext'],
    ],
  ] as const) {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, relativePath),
      'utf8',
    );
    for (const retiredExport of retiredExports) {
      assert.equal(
        source.includes(`export function ${retiredExport}(`),
        false,
        `${relativePath} must not retain ${retiredExport}`,
      );
    }
  }
});

test('production-scale v3 measures compact persisted bytes with authority replay', (context) => {
  const repository = createRepository();
  try {
    const baseline = {
      commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
      treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    };
    const contribution: InvestigationTermContribution<'main'> = {
      source: 'main',
      reference: 'main:production-scale-compactness',
      terms: [
        {
          kind: 'literal-content',
          value: 'production-scale-hit',
          rationale: 'Measure compactness against a production-scale hit set.',
          expectedRelationship:
            'Every repeated hit is intentionally irrelevant.',
        },
      ],
    };
    const preview = previewInvestigationTermUnion([contribution]);
    assert.equal(preview.outcome, 'ready');
    if (preview.outcome !== 'ready') assert.fail('term union must be ready');
    const mutationPolicy = createMutationClassPolicy({ rules: [] });
    const scan = scanInvestigationTreeFacts({
      repositoryRoot: repository,
      treeOid: baseline.treeOid,
      terms: preview.terms,
    });
    assert.equal(scan.outcome, 'ready');
    if (scan.outcome !== 'ready') assert.fail('scan must be ready');
    assert.equal(
      scan.facts.terms.reduce((count, term) => count + term.hits.length, 0),
      PRODUCTION_SCALE_HIT_COUNT,
    );
    const legacyScan = adaptInvestigationScanFactsResult(scan);
    assert.equal(legacyScan.outcome, 'ready');
    if (legacyScan.outcome !== 'ready')
      assert.fail('legacy scan must be ready');

    const groupingInput = {
      mutationPolicy,
      declaredRoots: [{ rootId: 'repository', path: '' }],
      reviewedRelationships: [],
    };
    const domainGrouping = deriveInvestigationGroupFacts({
      scanFacts: scan.facts,
      ...groupingInput,
    });
    const v3DispositionDecisions = domainGrouping.groups.map((group) => ({
      groupKey: group.key,
      classification: 'irrelevant' as const,
      rationale: 'The repeated fixture has no bearing on the planned change.',
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:production-scale-disposition',
      },
    }));
    const legacyGroups = deriveInvestigationGroups({
      scanNodes: legacyScan.nodes,
      ...groupingInput,
      exceptions: [],
    });
    const legacyDispositions = createInvestigationDispositionNodes({
      groupNodes: legacyGroups.groupNodes,
      dispositions: legacyGroups.groupNodes.map((node) => ({
        groupId: (node.output as { groupId: string }).groupId,
        classification: 'irrelevant',
        rationale: 'The repeated fixture has no bearing on the planned change.',
        author: 'owner',
      })),
    });
    const legacyCoverage = createInvestigationCoverageNode({
      effectiveTermIds: preview.terms.map(({ termId }) => termId),
      scanNodes: legacyScan.nodes,
      inventoryNode: legacyScan.inventory.evidenceNode,
      hitNodes: legacyGroups.hitNodes,
      groupNodes: legacyGroups.groupNodes,
      dispositionNodes: legacyDispositions,
    });
    const termUnion = createEvidenceNode({
      type: 'investigation-term-union',
      nodeSchema: 'investigation.term-union.compactness-test.v1',
      evaluator: 'investigation-compactness-test.v1',
      policyDigest: digest('term-union-policy'),
      exactInputDigests: {},
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'investigation.term-union-output.compactness-test.v1',
      output: {
        rawCounts: { engine: 0, main: 1, reviewer: 0, survey: 0 },
        terms: preview.terms,
      },
      runtimeMetadata: {},
    });
    const intent = {
      schemaVersion: 1 as const,
      summary: 'Measure Manifest-first Investigation v3 at production scale.',
      explicitPaths: [],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    };
    const applicability = createInvestigationApplicability({
      kind: 'sealed-investigation',
      baseline: { head: baseline.commitOid, tree: baseline.treeOid },
      intentDigest: digest(intent),
      sealNodeId: legacyCoverage.nodeId,
      sealResultDigest: legacyCoverage.resultDigest,
    });
    const v2Full = parseInvestigationArtifact(
      {
        schemaVersion: 1,
        kind: 'investigation-artifact',
        changeId: 'production-scale-compactness',
        legacyMigration: false,
        nodes: [
          termUnion,
          ...legacyScan.nodes,
          legacyScan.inventory.evidenceNode,
          ...legacyGroups.hitNodes,
          ...legacyGroups.groupNodes,
          ...legacyDispositions,
          legacyCoverage,
        ].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        currentRefs: { coverage: legacyCoverage.nodeId },
        applicability,
      },
      'production-scale-compactness',
    );
    const v2Projected = projectInvestigationArtifactForTracking(
      repository,
      v2Full,
    );
    assert.equal(v2Projected.schemaVersion, 2);

    const assuranceFacts = {
      assessmentDigest: digest('production-scale-assessment'),
      coverageTier: 'standard' as const,
      escalated: false,
      reasons: ['production-scale-size-measurement'],
      provenanceDigest: digest('production-scale-assessment-provenance'),
    };
    const state: OrdinaryInvestigationAuthoringState = {
      schemaVersion: 1,
      applicabilityKind: 'ordinary',
      repositoryId: 'expense-app-size-test',
      changeId: 'production-scale-compactness',
      investigationId: 'production-scale-investigation-v3',
      normalizedIntent: intent,
      authoring: {
        sessionRevision: 9,
        sessionSnapshotDigest: digest('production-scale-session'),
      },
      ordinary: {
        baseline,
        termContributions: [contribution],
        canonicalTerms: preview.terms,
        scanner: { allowSaturatedTerms: false, saturationDecision: null },
        grouping: groupingInput,
        semanticGroupDecisions: [],
        dispositionDecisions: v3DispositionDecisions,
        whyOverlays: [],
        knowledgeReuseDecisions: [],
        investigationRoleResults: [
          {
            role: 'blind-surveyor',
            targetDigest: digest('production-scale-role-target'),
            providerId: 'codex',
            sessionId: 'production-scale-session',
            principalId: null,
            requiredIndependence: 'provider-independent',
            achievedIndependence: 'provider-independent',
            requestDigest: digest('production-scale-role-request'),
            outputDigest: digest('production-scale-role-output'),
            contentDigest: digest('production-scale-role-content'),
            policyDigest: digest('production-scale-role-policy'),
            provenanceDigest: digest('production-scale-role-provenance'),
            grantUse: null,
            roleContextSharingUse: null,
          },
        ],
        floorOverflowDecision: null,
        exceptions: [],
        investigationRequirements: [
          emptyCoverageRequirement({
            investigationId: 'production-scale-investigation-v3',
            changeId: 'production-scale-compactness',
            baseline,
          }),
        ],
        assuranceFacts,
      },
    };
    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') {
      assert.fail(
        `${built.blocker.failureCode}:${built.blocker.detailsDigest}`,
      );
    }
    const sealed = sealInvestigationManifestDraft({
      draft: built.draft,
      approval: {
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:production-scale-approval',
        },
        approvalProvenanceDigest: digest('production-scale-approval'),
      },
    });
    if (sealed.outcome !== 'sealed') {
      assert.fail(
        `${sealed.blocker.failureCode}:${sealed.blocker.detailsDigest}`,
      );
    }
    const authority = validateForAuthority({
      repositoryRoot: repository,
      manifest: sealed.manifest,
      expected: {
        repositoryId: state.repositoryId,
        changeId: state.changeId,
        investigationId: state.investigationId,
        sessionRevision: state.authoring.sessionRevision,
        sessionSnapshotDigest: state.authoring.sessionSnapshotDigest,
      },
    });
    if (authority.outcome !== 'verified') {
      assert.fail(
        `${authority.blocker.failureCode}:${authority.blocker.detailsDigest}`,
      );
    }

    const v2Bytes = Buffer.byteLength(canonicalJson(v2Projected));
    const v3Bytes = Buffer.byteLength(canonicalJson(sealed.manifest));
    const ratio = v3Bytes / v2Bytes;
    context.diagnostic(
      `canonical bytes for ${PRODUCTION_SCALE_HIT_COUNT} hits: v2=${v2Bytes}, v3=${v3Bytes}, ratio=${ratio.toFixed(4)}`,
    );
    assert.ok(
      v3Bytes < v2Bytes * 0.4,
      `expected v3 (${v3Bytes}) to use less than 40% of projected v2 (${v2Bytes})`,
    );
    assert.equal(
      canonicalJson(v2Projected as ProjectedInvestigationArtifact).includes(
        legacyGroups.hitNodes[0]!.nodeId,
      ),
      true,
    );
    assert.equal(
      canonicalJson(sealed.manifest).includes(legacyGroups.hitNodes[0]!.nodeId),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function emptyCoverageRequirement(input: {
  investigationId: string;
  changeId: string;
  baseline: { commitOid: string; treeOid: string };
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
      coverageTier: 'standard',
      sealedSamplingSeed: digest('compactness-plan-review-coverage-seed'),
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
    provenanceDigest: digest('compactness-plan-review-coverage-provenance'),
  };
}

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-compactness-v3-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'compactness-v3@example.test']);
  git(repository, ['config', 'user.name', 'Compactness V3 Test']);
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'src/production-scale.ts'),
    `${'production-scale-hit\n'.repeat(PRODUCTION_SCALE_HIT_COUNT)}tail\n`,
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create production-scale size fixture']);
  return repository;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
