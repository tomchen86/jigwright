import { type InvestigationAuthoringState } from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import type { InvestigationRequirementV3 } from '../src/modules/investigation/manifest/investigation-requirement-types.ts';
import {
  type InvestigationTermContribution,
  previewInvestigationTermUnion,
} from '../src/modules/investigation/domain/investigation-terms.ts';
import assert from 'node:assert/strict';
import { createMutationClassPolicy } from '../src/modules/source/mutation-class-policy.ts';
import { scanInvestigationTreeFacts } from '../src/composition-root/investigation-production.ts';
import { deriveInvestigationGroupFacts } from '../src/modules/investigation/domain/investigation-groups.ts';
import { type BuildInvestigationManifestV3Input } from '../src/modules/investigation/manifest/investigation-manifest-builder.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { git } from './fixture.ts';
import crypto from 'node:crypto';

export function ordinaryAuthoringState(
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

export function directBuilderInput(
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

export function structuredInvestigationRequirements(
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

export function baselineOf(repository: string) {
  return {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
}

export function authorityExpected() {
  return {
    repositoryId: 'expense-app-test',
    changeId: 'manifest-first-v3',
    investigationId: 'investigation-v3-test',
    sessionRevision: 7,
    sessionSnapshotDigest: digest('session-snapshot'),
  };
}

export function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
