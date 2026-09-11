/**
 * Reconstructs current investigation evidence from pinned inputs and durable checkpoints.
 *
 * Invariants:
 * - Terms, scans, groups, and WHY facts derive from the same pinned investigation inputs.
 * - Engine-floor terms and exact scan acceptance survive contribution and budget handling.
 * - Semantic reuse remains visible in review coverage with its current policy provenance.
 */

import { extractFileHeader } from '../../modules/source/file-header.ts';
import { snapshotFromTrackedTree } from '../../modules/source/system-description-snapshot.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  type GlobalPlanReviewCoverageTargetInput,
  buildGlobalPlanReviewCoverageRequirement,
} from '../../modules/assurance/plan-review-coverage.ts';
import { type FloorOverflowDecision } from '../../modules/investigation/domain/floor-overflow-pruning.ts';
import { type InvestigationDispositionDecision } from '../../modules/investigation/domain/investigation-domain.ts';
import {
  deriveEngineFloor,
  derivePinnedDiffPathFacts,
} from '../../modules/investigation/domain/investigation-floor.ts';
import {
  type InvestigationFullBlobFact,
  deriveInvestigationFullBlobFacts,
} from '../../modules/investigation/domain/investigation-full-blob.ts';
import {
  type InvestigationDispositionInput,
  deriveInvestigationGroupFacts,
} from '../../modules/investigation/domain/investigation-groups.ts';
import {
  type InvestigationTermContribution,
  type InvestigationTermRawCounts,
  previewInvestigationTermUnion,
} from '../../modules/investigation/domain/investigation-terms.ts';
import { type InvestigationWhyOverlayV3 } from '../../modules/investigation/manifest/investigation-manifest-types.ts';
import {
  type MaterializedEvidenceView,
  materializeInvestigationEvidenceViewFromFacts,
} from '../../modules/investigation/manifest/investigation-materializer.ts';
import {
  buildInvestigationV3WhyAuthoring,
  deriveInvestigationV3WhyRequirements,
  mapInvestigationWhyCheckpointToV3Sources,
} from '../../modules/investigation/manifest/investigation-why-domain.ts';
import { PROPOSE_POLICY_DIGEST } from '../../modules/provider-orchestration/provider-contracts.ts';
import { type ReuseCoverageRecord } from '../../modules/assurance/review-coverage.ts';
import {
  applyLedgerToFullBlobManifest,
  recordReuseCoverage,
} from '../../modules/why-knowledge/semantic-manifest-reuse.ts';
import { sha256 } from './propose-common.ts';
import {
  createProviderResultNode,
  createTermContributionNode,
  createTermUnionNode,
} from './propose-evidence.ts';
import { assertBlindOutput } from './propose-input.ts';
import {
  createProposeAssuranceAssessmentNode,
  declaredPathSymbolsFromPinnedTree,
  deriveReviewedAssetRelationships,
  deriveReviewedCounterpartFacts,
  expandSubmittedDispositions,
  investigationKnowledgeCarries,
  resolveEngineFloorOverflow,
} from './propose-investigation-facts.ts';
import { reportProposeAssuranceAssessment } from './propose-investigation-manifest.ts';
import { readProposeAuthorization } from './propose-request-validation.ts';
import {
  createBlindSurveyRoleResult,
  readReviewerTermSource,
} from './propose-reviewer-terms.ts';
import type {
  EvidenceNode,
  InvestigationSession,
  ProposeRuntime,
  TrackedTreeSnapshot,
} from './propose-runtime.ts';
import type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
import {
  type CollaborationGrantAccessMode,
  type ProposeResumeOptions,
  type RebuiltInvestigation,
} from './propose-types.ts';

/** Fixed when the investigation ID is created, before any review population. */
function planReviewCoverageSeed(investigationId: string): string {
  return sha256(
    canonicalJson({
      schema: 'workflow-plan-review-coverage-seed.v1',
      investigationId,
    }),
  );
}

function globalPlanReviewCoverageBindings(
  services: Pick<ProposeRuntime, 'workspace'>,
  input: {
    repositoryRoot: string;
    snapshot: TrackedTreeSnapshot;
    explicitPaths: readonly string[];
    completeManifest: readonly InvestigationFullBlobFact[];
    whyOverlays: readonly InvestigationWhyOverlayV3[];
    carried: readonly Readonly<{
      manifestEntryId: string;
      subjectId: string;
      ledgerEntryId: string;
    }>[];
    semanticReuse: ReuseCoverageRecord;
  },
): GlobalPlanReviewCoverageTargetInput[] {
  const explicitPaths = new Set(input.explicitPaths);
  const carriedByManifest = new Map(
    input.carried.map((entry) => [entry.manifestEntryId, entry]),
  );
  const resolutionBySubject = new Map(
    input.semanticReuse.resolutions.map((entry) => [entry.subjectId, entry]),
  );
  const whyByManifest = new Map(
    input.whyOverlays.map((overlay) => [
      `${overlay.pathIdentity.rawBase64}\0${overlay.blobOid}`,
      overlay,
    ]),
  );
  const bindings = new Map<string, GlobalPlanReviewCoverageTargetInput>();

  for (const entry of input.completeManifest) {
    const targetPath = entry.path.utf8;
    if (targetPath === null) continue;
    const carried = carriedByManifest.get(entry.manifestEntryId);
    const why = whyByManifest.get(
      `${entry.path.rawBase64}\0${entry.blob.objectId}`,
    );
    const ledger =
      carried === undefined
        ? null
        : services.workspace.readLedgerEntry(
            input.repositoryRoot,
            carried.ledgerEntryId,
          );
    const plannedMutation = explicitPaths.has(targetPath);
    const invariants = [
      ...(why === undefined ? [] : [why.protectedInvariant]),
      ...(ledger === null
        ? []
        : (extractFileHeader(
            input.snapshot.entries
              .find((candidate) => candidate.path.utf8 === targetPath)
              ?.content?.toString('utf8') ?? '',
          )?.invariants ?? [])),
      ...(plannedMutation
        ? ['Planned mutations must preserve their declared contract.']
        : []),
    ];
    const riskFactors = [
      ...(plannedMutation ? ['planned-mutation'] : []),
      ...entry.relationshipsToChange.map(
        ({ classification }) => `classification:${classification}`,
      ),
      ...entry.matchedTermIds.map((termId) => `matched-term:${termId}`),
    ];
    const degradedExtraction = isDegradedCoveragePath(targetPath);
    bindings.set(targetPath, {
      source: plannedMutation
        ? 'planned-mutation'
        : carried === undefined
          ? 'investigation-target'
          : 'carried-ledger-subject',
      path: targetPath,
      targetDigest: `sha256:${entry.blob.contentSha256}`,
      stratum: plannedMutation
        ? 'planned-mutation'
        : degradedExtraction
          ? 'degraded-extraction'
          : 'production-consumer',
      reusedFromLedger: carried !== undefined,
      subjectId: carried?.subjectId ?? null,
      ledgerEntryId: carried?.ledgerEntryId ?? null,
      invariants:
        invariants.length === 0
          ? ['Investigation targets must preserve their reviewed behavior.']
          : [...new Set(invariants)].sort(),
      riskFactors:
        riskFactors.length === 0
          ? ['load-bearing-investigation-target']
          : [...new Set(riskFactors)].sort(),
      freshness:
        carried === undefined
          ? 'missing-ledger-entry'
          : (resolutionBySubject.get(carried.subjectId)?.state ?? 'current'),
      evidenceMode: carried === undefined ? 'full-blob' : 'bounded-context',
      degradedExtraction,
      cost: {
        rawBytes: entry.blob.byteSize,
        reviewUnits: Math.max(1, Math.ceil(entry.blob.byteSize / 1024)),
      },
    });
  }

  const snapshotByPath = new Map(
    input.snapshot.entries.flatMap((entry) =>
      entry.path.utf8 === null ? [] : [[entry.path.utf8, entry] as const],
    ),
  );
  for (const explicitPath of [...explicitPaths].sort()) {
    if (bindings.has(explicitPath)) continue;
    const entry = snapshotByPath.get(explicitPath);
    if (
      entry === undefined ||
      typeof entry.contentSha256 !== 'string' ||
      entry.byteSize === null
    ) {
      throw workflowError(
        'REVIEW_COVERAGE_REQUIREMENT_INVALID',
        'Global review coverage requires every explicit planned mutation to resolve to a readable pinned blob.',
        ExitCode.guard,
        { details: { explicitPath } },
      );
    }
    const degradedExtraction = isDegradedCoveragePath(explicitPath);
    bindings.set(explicitPath, {
      source: 'planned-mutation',
      path: explicitPath,
      targetDigest: `sha256:${entry.contentSha256}`,
      stratum: 'planned-mutation',
      reusedFromLedger: false,
      subjectId: null,
      ledgerEntryId: null,
      invariants: ['Planned mutations must preserve their declared contract.'],
      riskFactors: ['planned-mutation'],
      freshness: 'missing-ledger-entry',
      evidenceMode: 'full-blob',
      degradedExtraction,
      cost: {
        rawBytes: entry.byteSize,
        reviewUnits: Math.max(1, Math.ceil(entry.byteSize / 1024)),
      },
    });
  }
  return [...bindings.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function isDegradedCoveragePath(targetPath: string): boolean {
  return !/\.(?:c|cc|cpp|css|go|graphql|html|java|js|json|jsx|kt|md|mjs|py|rb|rs|sh|sql|ts|tsx|yaml|yml)$/i.test(
    targetPath,
  );
}

export function rebuildInvestigation(
  services: Pick<
    ProposeRuntime,
    | 'evidence'
    | 'grants'
    | 'investigation'
    | 'provider'
    | 'workspace'
    | 'planningEvidence'
    | 'roleAdmission'
  >,
  cwd: string,
  investigationId: string,
  grantAccess: CollaborationGrantAccessMode,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  assertOwned?: () => void,
  inspectSaturationAcceptance = false,
): RebuiltInvestigation {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const session = services.investigation.readInvestigationSession(
    context.runtime,
    investigationId,
  );
  const providerRequest = services.provider.readProviderInvocationRequest(
    context.runtime,
    session.currentBlindInvocationId,
  );
  const authorizationNode = services.evidence.readEvidenceNode(
    context.runtime,
    providerRequest.authorizationNodeId,
  );
  const authorization = readProposeAuthorization(
    services,
    context.runtime,
    providerRequest,
  );
  const manifest = services.provider.readBlindSurveyManifest(
    context.runtime,
    session.currentBlindInvocationId,
  );
  const intent = manifest.normalizedIntent;
  const changedPaths = derivePinnedDiffPathFacts(
    services.workspace.readPinnedPathDiff,
    {
      repositoryRoot: context.git.repositoryRoot,
      baseCommit: authorization.protectedBase.commit,
      targetCommit: session.baseline.head,
    },
  );
  const reviewedRelationships = deriveReviewedAssetRelationships(
    services,
    context,
  );
  const reviewedCounterparts = deriveReviewedCounterpartFacts(
    intent,
    changedPaths,
    reviewedRelationships,
  );
  let floor = deriveEngineFloor({
    explicitPaths: intent.explicitPaths,
    // The author's list and what those files actually publish. A declaration
    // that names fewer symbols than its own exports would otherwise shrink the
    // search the change is judged by.
    symbols: [
      ...new Set([
        ...intent.explicitSymbols,
        ...declaredPathSymbolsFromPinnedTree(
          services,
          context.git.repositoryRoot,
          session.baseline.tree,
          intent.explicitPaths,
        ),
      ]),
    ].sort(),
    configKeys: intent.explicitConfigKeys,
    transformations: intent.renamePairs.flatMap((pair, index) => [
      {
        kind: 'literal-content' as const,
        before: pair.from,
        after: pair.to,
        reference: `intent.renamePairs[${index}]`,
      },
    ]),
    changedPaths,
    reviewedCounterparts,
  });
  const floorOverflow = resolveEngineFloorOverflow(
    services,
    session,
    floor,
    authorizationNode,
  );
  floor = floorOverflow.floor;
  const floorTrimming = floorOverflow.trimming;
  const emptyCounts: InvestigationTermRawCounts = {
    engine: floor.outcome === 'derived' ? floor.terms.length : 0,
    main: 0,
    survey: 0,
    reviewer: 0,
  };
  if (
    session.milestones.mainTerms === null ||
    session.milestones.blindResult === null
  ) {
    return emptyRebuilt(
      session,
      intent,
      floor,
      emptyCounts,
      authorizationNode,
      floorTrimming,
      floorOverflow.decision,
      floorOverflow.node,
    );
  }
  const snapshot = services.workspace.readPinnedTrackedTree({
    repositoryRoot: context.git.repositoryRoot,
    treeOid: session.baseline.tree,
  });
  const mutationPolicy =
    services.workspace.deriveReviewedMutationClassPolicy(snapshot);

  const invocation = services.provider.readProviderInvocation(
    context.runtime,
    session.milestones.blindResult.invocationId,
  );
  if (invocation.state !== 'succeeded' || invocation.result === null) {
    throw workflowError(
      'PROVIDER_RESULT_NOT_AVAILABLE',
      'Published blind survey result is unavailable.',
      ExitCode.staleState,
    );
  }
  const blindOutput = assertBlindOutput(invocation.result.output);
  const reviewerSource = readReviewerTermSource(
    services,
    context.runtime,
    session.milestones.reviewerTermSourceNodeId,
    session,
    context.git.repositoryRoot,
    grantValidation?.consumedPlanReviewReplay,
  );
  const main = session.milestones.mainTerms.envelope;
  if (main.kind !== 'main-terms') {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_INVALID',
      'Stored main term checkpoint is malformed.',
      ExitCode.staleState,
    );
  }
  const contributions: InvestigationTermContribution[] = [
    ...(floor.outcome === 'derived'
      ? [
          {
            source: 'engine' as const,
            reference: `engine-floor:${session.intentDigest}`,
            terms: floor.terms.map(({ kind, value }) => ({ kind, value })),
          },
        ]
      : []),
    {
      source: 'main',
      reference: main.payload.reference,
      terms: main.payload.terms,
    },
    {
      source: 'survey',
      reference: blindOutput.reference,
      terms: blindOutput.terms,
    },
    ...(reviewerSource === null
      ? []
      : [
          {
            source: 'reviewer' as const,
            reference: reviewerSource.sourceNode.nodeId,
            terms: reviewerSource.terms,
          },
        ]),
  ];
  const contributionNodes = contributions.map((contribution) =>
    createTermContributionNode(
      session,
      contribution,
      contribution.source === 'reviewer'
        ? (reviewerSource?.sourceNode ?? null)
        : null,
    ),
  );
  const preview = previewInvestigationTermUnion(contributions);
  if (preview.outcome !== 'ready') {
    throw workflowError(
      'INVESTIGATION_TERM_NARROWING_REQUIRED',
      'The current non-floor contributions make the term union exceed the fixed investigation limits; caller input may not evict an engine-floor term.',
      ExitCode.guard,
      { details: { violations: preview.violations, floorTrimming } },
    );
  }
  const termUnionNode = createTermUnionNode(
    session,
    preview.terms,
    preview.rawCounts,
    contributionNodes,
  );
  const providerResultNode = createProviderResultNode(
    session,
    providerRequest,
    invocation.result,
    authorizationNode,
  );
  const providerRoleResult = createBlindSurveyRoleResult(
    services,
    context,
    authorization,
    providerRequest,
    invocation.result,
    providerResultNode,
    grantAccess,
    grantValidation,
    assertOwned,
  );
  const scanFactsResult = services.workspace.scanInvestigationTreeFacts({
    repositoryRoot: context.git.repositoryRoot,
    treeOid: session.baseline.tree,
    terms: preview.terms,
    allowSaturatedTerms:
      inspectSaturationAcceptance ||
      session.scanSaturationAcceptance !== undefined,
  });
  if (scanFactsResult.outcome !== 'ready') {
    const acceptedScan = services.workspace.scanInvestigationTreeFacts({
      repositoryRoot: context.git.repositoryRoot,
      treeOid: session.baseline.tree,
      terms: preview.terms,
      allowSaturatedTerms: true,
    });
    if (
      session.scanSaturationAcceptance === undefined &&
      acceptedScan.outcome === 'ready' &&
      acceptedScan.saturatedTermIds !== undefined &&
      acceptedScan.saturatedTermIds.length > 0
    ) {
      throw workflowError(
        'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_REQUIRED',
        'The investigation scan reached per-term hit ceilings and requires an exact acknowledgement before incomplete evidence may continue.',
        ExitCode.guard,
        {
          details: {
            saturatedTermIds: acceptedScan.saturatedTermIds,
            violations: scanFactsResult.violations,
            floorTrimming,
          },
        },
      );
    }
    throw workflowError(
      'INVESTIGATION_SCAN_NARROWING_REQUIRED',
      'The current scan exceeds fixed investigation limits.',
      ExitCode.guard,
      { details: { violations: scanFactsResult.violations } },
    );
  }
  const acceptedTermIds =
    session.scanSaturationAcceptance?.envelope.saturatedTermIds ?? null;
  if (
    !inspectSaturationAcceptance &&
    acceptedTermIds !== null &&
    canonicalJson(scanFactsResult.saturatedTermIds ?? []) !==
      canonicalJson(acceptedTermIds)
  ) {
    throw workflowError(
      'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_STALE',
      'The durable scan saturation acceptance no longer matches the pinned scan.',
      ExitCode.staleState,
    );
  }
  const groupFacts = deriveInvestigationGroupFacts({
    scanFacts: scanFactsResult.facts,
    mutationPolicy,
    declaredRoots: [{ rootId: 'repository', path: '' }],
    reviewedRelationships,
  });
  const assuranceAssessmentNode = createProposeAssuranceAssessmentNode(
    services,
    {
      repositoryRoot: context.git.repositoryRoot,
      session,
      scanFacts: scanFactsResult.facts,
      groupFacts,
      floorOverflowDecision: floorOverflow.decision,
      floorOverflowDecisionNode: floorOverflow.node,
    },
  );
  let dispositionInputs: InvestigationDispositionInput[] = [];
  let dispositionDecisions: InvestigationDispositionDecision[] = [];
  let evidenceView: MaterializedEvidenceView | null = null;
  if (session.milestones.groupDispositions !== null) {
    const checkpoint = session.milestones.groupDispositions;
    const stored = checkpoint.envelope;
    if (stored.kind !== 'group-dispositions') {
      throw workflowError(
        'INVESTIGATION_CHECKPOINT_INVALID',
        'Stored disposition checkpoint is malformed.',
        ExitCode.staleState,
      );
    }
    dispositionInputs = expandSubmittedDispositions(
      context.git.repositoryRoot,
      {
        scanFacts: scanFactsResult.facts,
        groupFacts,
        payload: stored.payload,
        saturatedTermIds: scanFactsResult.saturatedTermIds,
        assuranceAssessmentNode,
      },
    );
    dispositionDecisions = dispositionInputs.map((disposition) => ({
      groupKey: disposition.groupId,
      classification: disposition.classification,
      rationale: disposition.rationale,
      semanticAuthor: {
        id: disposition.author,
        provenance: `checkpoint:${checkpoint.envelopeDigest}`,
      },
    }));
    evidenceView = materializeInvestigationEvidenceViewFromFacts({
      scanFacts: scanFactsResult.facts,
      grouping: groupFacts,
      canonicalTerms: preview.terms,
      semanticGroupDecisions: [],
      dispositionDecisions,
    });
  }
  const whyRequirements =
    evidenceView === null
      ? []
      : deriveInvestigationV3WhyRequirements(evidenceView);
  const derivedFullBlobManifest =
    evidenceView === null
      ? []
      : deriveInvestigationFullBlobFacts({
          snapshot,
          requirements: whyRequirements,
          dispositions: evidenceView.dispositions,
        });
  // The ledger sets aside only what it already explains for these exact bytes.
  // Everything it carries keeps its group and its disposition; what it loses is
  // the obligation to be explained again by someone with nothing new to say.
  const manifestReuse = applyLedgerToFullBlobManifest(
    services.workspace,
    context.git.repositoryRoot,
    derivedFullBlobManifest,
    // Naming the policy that judges this propose is what makes a raised policy
    // able to invalidate an entry. Letting the call default here would echo
    // each entry's own policy back as the current one, and every entry would
    // agree with itself forever.
    {
      currentPolicyDigest: `sha256:${PROPOSE_POLICY_DIGEST}`,
      snapshot: snapshotFromTrackedTree(snapshot),
    },
  );
  const fullBlobManifest = [...manifestReuse.owed];
  // Taking the saving and recording what it cost are the same act. Every
  // carried entry stays in what a reviewer is shown, marked as carried.
  const reuseCoverage = recordReuseCoverage(manifestReuse);
  let whyAuthoring: ReturnType<typeof buildInvestigationV3WhyAuthoring> | null =
    null;
  if (session.milestones.whyAnswers !== null) {
    const checkpoint = session.milestones.whyAnswers;
    const stored = checkpoint.envelope;
    if (stored.kind !== 'why-answers') {
      throw workflowError(
        'INVESTIGATION_CHECKPOINT_INVALID',
        'Stored WHY checkpoint is malformed.',
        ExitCode.staleState,
      );
    }
    if (evidenceView === null) {
      throw workflowError(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'WHY answers have no current disposition facts.',
        ExitCode.guard,
      );
    }
    const carried = investigationKnowledgeCarries(services, {
      repositoryRoot: context.git.repositoryRoot,
      completeManifest: derivedFullBlobManifest,
      reuseCoverage,
    });
    const mappedWhy = mapInvestigationWhyCheckpointToV3Sources({
      requirements: whyRequirements,
      manifestRows: derivedFullBlobManifest,
      answers: stored.payload.answers,
      carried,
      checkpointProvenanceDigest: checkpoint.envelopeDigest,
    });
    whyAuthoring = buildInvestigationV3WhyAuthoring({
      view: evidenceView,
      answers: mappedWhy.answers,
      knowledgeReuse: mappedWhy.knowledgeReuse,
    });
  }
  const coverageTier = reportProposeAssuranceAssessment(
    assuranceAssessmentNode,
  ).coverageTier;
  const planReviewCoverage =
    whyAuthoring !== null
      ? buildGlobalPlanReviewCoverageRequirement({
          investigationId: session.investigationId,
          changeId: session.changeId,
          baseline: session.baseline,
          coverageTier,
          sealedSamplingSeed: planReviewCoverageSeed(session.investigationId),
          targets: globalPlanReviewCoverageBindings(services, {
            repositoryRoot: context.git.repositoryRoot,
            snapshot,
            explicitPaths: intent.explicitPaths,
            completeManifest: derivedFullBlobManifest,
            whyOverlays: whyAuthoring.whyOverlays,
            carried: manifestReuse.carried,
            semanticReuse: reuseCoverage,
          }),
          semanticReuse: reuseCoverage,
        })
      : null;
  return {
    session,
    intent,
    floor,
    floorTrimming,
    floorOverflowDecision: floorOverflow.decision,
    floorOverflowDecisionNode: floorOverflow.node,
    termSources: preview.rawCounts,
    authorizationNode,
    providerResultNode,
    providerRoleResult,
    reviewerTermSourceNode: reviewerSource?.sourceNode ?? null,
    reviewerTermSourceNodeIds: reviewerSource?.sourceNodeIds ?? [],
    reviewerTermEvidenceNodes: reviewerSource?.evidenceNodes ?? [],
    reviewerTermReopenCount: reviewerSource?.reopenCount ?? 0,
    reviewerTerms: reviewerSource?.terms ?? [],
    reviewerRoleResult: reviewerSource?.roleResult ?? null,
    reviewerPriorGroupDispositions:
      reviewerSource?.priorGroupDispositions ?? null,
    reviewerPriorWhyAnswers: reviewerSource?.priorWhyAnswers ?? null,
    contributionNodes,
    termUnionNode,
    saturatedTermIds: [...(scanFactsResult.saturatedTermIds ?? [])],
    assuranceAssessmentNode,
    planReviewCoverage,
    completeFullBlobManifest: derivedFullBlobManifest,
    fullBlobManifest,
    reuseCoverage,
    whyAuthoring,
    v3Domain: {
      termContributions: structuredClone(contributions),
      canonicalTerms: structuredClone(preview.terms),
      scanFacts: structuredClone(scanFactsResult.facts),
      groupFacts: structuredClone(groupFacts),
      mutationPolicy: structuredClone(mutationPolicy),
      reviewedRelationships: structuredClone(reviewedRelationships),
      dispositionInputs: structuredClone(dispositionInputs),
      dispositionDecisions: structuredClone(dispositionDecisions),
      evidenceView,
    },
  };
}

function emptyRebuilt(
  session: InvestigationSession,
  intent: NormalizedChangeIntent,
  floor: ReturnType<typeof deriveEngineFloor>,
  termSources: InvestigationTermRawCounts,
  authorizationNode: EvidenceNode,
  floorTrimming: { dropped: string[]; escalated: boolean } = {
    dropped: [],
    escalated: false,
  },
  floorOverflowDecision: FloorOverflowDecision | null = null,
  floorOverflowDecisionNode: EvidenceNode | null = null,
): RebuiltInvestigation {
  return {
    session,
    intent,
    floor,
    floorTrimming,
    floorOverflowDecision,
    floorOverflowDecisionNode,
    termSources,
    authorizationNode,
    providerResultNode: null,
    providerRoleResult: null,
    reviewerTermSourceNode: null,
    reviewerTermSourceNodeIds: [],
    reviewerTermEvidenceNodes: [],
    reviewerTermReopenCount: 0,
    reviewerTerms: [],
    reviewerRoleResult: null,
    reviewerPriorGroupDispositions: null,
    reviewerPriorWhyAnswers: null,
    contributionNodes: [],
    termUnionNode: null,
    saturatedTermIds: [],
    assuranceAssessmentNode: null,
    planReviewCoverage: null,
    completeFullBlobManifest: [],
    fullBlobManifest: [],
    // An investigation with nothing in it carried nothing, which is a real
    // answer rather than an absent one.
    reuseCoverage: recordReuseCoverage({
      owed: [],
      carried: [],
      plan: null,
    }),
    whyAuthoring: null,
    v3Domain: null,
  };
}
