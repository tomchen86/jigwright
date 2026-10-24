/**
 * Derives grounded investigation facts, assurance, and reusable semantic authoring.
 *
 * Invariants:
 * - Counterpart paths and declared symbols remain grounded in pinned repository facts.
 * - Class compression preserves the current assurance floor and path-role classification.
 * - Reopened checkpoints retain prior class audits and reuse only exact knowledge bindings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assessAssurance,
  ASSURANCE_ASSESSMENT_POLICY_DIGEST,
} from '../../modules/assurance/assurance-assessment-chain.ts';
import {
  expandClassDispositions,
  parseClassDisposition,
} from '../../modules/investigation/domain/class-disposition.ts';
import {
  FLOOR_OVERFLOW_MANDATORY_CONTRIBUTION_RESERVE,
  FLOOR_OVERFLOW_POLICY_DIGEST,
  resolveFloorOverflow,
} from '../../modules/investigation/domain/floor-overflow-pruning.ts';
import type { FloorOverflowDecision } from '../../modules/investigation/domain/floor-overflow-pruning.ts';
import type { InvestigationChangeClass } from '../../modules/investigation/domain/investigation-applicability.ts';
import { deriveEngineFloor } from '../../modules/investigation/domain/investigation-floor.ts';
import type {
  ChangedPathFact,
  ReviewedCounterpartFact,
} from '../../modules/investigation/domain/investigation-floor.ts';
import type { InvestigationFullBlobFact } from '../../modules/investigation/domain/investigation-full-blob.ts';
import { deriveClassGroupsWithContextFromFacts } from '../../modules/investigation/domain/investigation-groups.ts';
import type {
  InvestigationDispositionInput,
  InvestigationGroupFacts,
  ReviewedPathRelationship,
} from '../../modules/investigation/domain/investigation-groups.ts';
import type { InvestigationScanFacts } from '../../modules/investigation/domain/investigation-scan-facts.ts';
import { INVESTIGATION_LIMITS } from '../../modules/investigation/domain/investigation-terms.ts';
import {
  buildInvestigationV3WhyAuthoring,
  deriveInvestigationV3WhyRequirements,
  mapInvestigationWhyCheckpointToV3Sources,
} from '../../modules/investigation/manifest/investigation-why-domain.ts';
import { deriveDeclaredPathSymbols } from '../../modules/source/declared-path-symbols.ts';
import { parsePathRoleRegistry } from '../../modules/source/path-role-registry.ts';
import type { PathRoleRegistry } from '../../modules/source/path-role-registry.ts';
import type { ReuseCoverageRecord } from '../../modules/assurance/review-coverage.ts';
import { sha256 } from '../../modules/proposal/propose-values.ts';
import { reportProposeAssuranceAssessment } from './propose-investigation-manifest.ts';
import {
  reviewerReusableGroupDispositions,
  reviewerReusableWhyAnswers,
} from './propose-output.ts';
import type { EvidenceNode } from '@jigwright/core/evidence-node';
import type {
  GroupDispositionsPayload,
  InvestigationCheckpointEnvelope,
  InvestigationSession,
  WhyAnswersPayload,
} from '../../modules/investigation/domain/investigation-session-types.ts';
import type { ProposeRuntime } from './propose-runtime.ts';
import type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
import type {
  ProposeOutput,
  RebuiltInvestigation,
} from '../../modules/proposal/propose-types.ts';
export function deriveReviewedAssetRelationships(
  services: Pick<ProposeRuntime, 'workspace'>,
  context: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >,
): ReviewedPathRelationship[] {
  return services.workspace
    .planningProviderReviewedAssetMirrors(context)
    .map((asset) => ({
      relationshipId: asset.relationshipId,
      kind: 'mirror',
      subjectPath: pathIdentity(services, asset.mirrorOf),
      counterpartPath: pathIdentity(services, asset.destinationPath),
      reference: asset.reference,
    }));
}

/**
 * Reads the names a declared file publishes, from the pinned tree.
 *
 * The floor is meant to be what the engine can establish on its own, but its
 * symbols came only from the author's own list, so a change could narrow its
 * own search by declaring fewer names than the files it names actually export.
 * Every exported name of a declared path now joins the floor whether or not
 * anyone thought to write it down.
 *
 * A path the change is about to add does not exist in the pinned tree yet, and
 * publishes nothing there; that is a fact about the baseline, not a failure.
 */
export function declaredPathSymbolsFromPinnedTree(
  services: Pick<ProposeRuntime, 'workspace'>,
  repositoryRoot: string,
  treeOid: string,
  declaredPaths: readonly string[],
): string[] {
  const symbols = new Set<string>();
  for (const declared of declaredPaths) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(declared)) continue;
    const shown = services.workspace.runGit(
      repositoryRoot,
      ['show', `${treeOid}:${declared}`],
      true,
    );
    if (shown === '') continue;
    for (const symbol of deriveDeclaredPathSymbols(shown)) {
      symbols.add(symbol);
    }
  }
  return [...symbols].sort();
}

export function resolveEngineFloorOverflow(
  services: Pick<ProposeRuntime, 'evidence'>,
  session: InvestigationSession,
  floor: ReturnType<typeof deriveEngineFloor>,
  authorizationNode: EvidenceNode,
): {
  floor: ReturnType<typeof deriveEngineFloor>;
  trimming: ProposeOutput['floorTrimming'];
  decision: FloorOverflowDecision | null;
  node: EvidenceNode | null;
} {
  if (floor.outcome !== 'derived') {
    return {
      floor,
      trimming: { dropped: [], escalated: false },
      decision: null,
      node: null,
    };
  }
  const resolution = resolveFloorOverflow(
    floor.terms.map((term) => ({
      termId: term.termId,
      value: term.value,
      floorKind: term.kind,
      kind:
        term.kind === 'symbol'
          ? ('symbol' as const)
          : term.kind === 'config-key'
            ? ('variant' as const)
            : ('literal' as const),
    })),
    INVESTIGATION_LIMITS.maxEffectiveTerms,
    FLOOR_OVERFLOW_MANDATORY_CONTRIBUTION_RESERVE,
  );
  if (!resolution.decision.escalated) {
    return {
      floor,
      trimming: { dropped: [], escalated: false },
      decision: null,
      node: null,
    };
  }
  const keptTermIds = new Set(resolution.terms.map(({ termId }) => termId));
  const decisionNode = services.evidence.createEvidenceNode({
    type: 'investigation-floor-overflow-decision',
    nodeSchema: 'investigation.floor-overflow-decision.v1',
    evaluator: 'workflow-propose.floor-overflow.v1',
    policyDigest: FLOOR_OVERFLOW_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(session.baseline)),
      intent: session.intentDigest,
      originalFloor: sha256(canonicalJson(floor)),
      limit: sha256(canonicalJson(INVESTIGATION_LIMITS.maxEffectiveTerms)),
    },
    semanticParentResultDigests: {
      authorization: authorizationNode.resultDigest,
    },
    provenanceParentNodeIds: {
      authorization: authorizationNode.nodeId,
    },
    outputSchema: 'investigation.floor-overflow-decision-output.v1',
    output: resolution.decision,
    runtimeMetadata: {},
  });
  return {
    floor: {
      ...floor,
      terms: floor.terms.filter(({ termId }) => keptTermIds.has(termId)),
      derivations: floor.derivations.filter(({ termId }) =>
        keptTermIds.has(termId),
      ),
    },
    trimming: {
      dropped: resolution.decision.dropped.map(({ value }) => value),
      escalated: true,
    },
    decision: resolution.decision,
    node: decisionNode,
  };
}

export function deriveReviewedCounterpartFacts(
  intent: NormalizedChangeIntent,
  changedPaths: ChangedPathFact[],
  relationships: ReviewedPathRelationship[],
): ReviewedCounterpartFact[] {
  const baseFloor = deriveEngineFloor({
    explicitPaths: intent.explicitPaths,
    symbols: intent.explicitSymbols,
    configKeys: intent.explicitConfigKeys,
    transformations: intent.renamePairs.map((pair, index) => ({
      kind: 'literal-content',
      before: pair.from,
      after: pair.to,
      reference: `intent.renamePairs[${index}]`,
    })),
    changedPaths,
    reviewedCounterparts: [],
  });
  const grounded = new Set(
    baseFloor.outcome === 'derived'
      ? baseFloor.terms.map(({ value }) => value)
      : [],
  );

  const pending = [...relationships];
  const facts: ReviewedCounterpartFact[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex((relationship) => {
      const subject = relationship.subjectPath.utf8;
      const counterpart = relationship.counterpartPath.utf8;
      return (
        subject !== null &&
        counterpart !== null &&
        (grounded.has(subject) || grounded.has(counterpart))
      );
    });
    if (index < 0) {
      break;
    }
    const [relationship] = pending.splice(index, 1);
    const canonical = relationship!.subjectPath.utf8!;
    const mirror = relationship!.counterpartPath.utf8!;
    const subject = grounded.has(canonical) ? canonical : mirror;
    const value = subject === canonical ? mirror : canonical;
    facts.push({
      kind: 'literal-path',
      value,
      subject,
      reference: `${relationship!.reference}:${subject}->${value}`,
    });
    grounded.add(value);
  }
  return facts.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function pathIdentity(
  services: Pick<ProposeRuntime, 'workspace'>,
  relativePath: string,
): {
  rawBase64: string;
  utf8: string;
} {
  const normalized = services.workspace.normalizePolicyPath(relativePath);
  return {
    rawBase64: Buffer.from(normalized, 'utf8').toString('base64'),
    utf8: normalized,
  };
}

/**
 * Reads the registry that decides which paths may be folded into a class.
 *
 * A repository with no registry has classified nothing, and nothing
 * unclassified is ever compressible, so the honest answer is a refusal naming
 * the missing file rather than a crash or a permissive default.
 */
function readPathRoleRegistryForClasses(repositoryRoot: string) {
  const registryPath = path.join(repositoryRoot, 'workflow/path-roles.json');
  if (!fs.existsSync(registryPath)) {
    throw workflowError(
      'CLASS_DISPOSITION_INVALID',
      `A class disposition needs ${'workflow/path-roles.json'} to say which paths may be folded; this repository has not classified any.`,
      ExitCode.usage,
    );
  }
  return parsePathRoleRegistry(
    JSON.parse(fs.readFileSync(registryPath, 'utf8')),
  );
}

function readPathRoleRegistryForAssessment(repositoryRoot: string): {
  registry: PathRoleRegistry;
  sourceDigest: string;
} {
  const registryPath = path.join(repositoryRoot, 'workflow/path-roles.json');
  if (!fs.existsSync(registryPath)) {
    // A missing registry means no path was judged ordinary. Propose may still
    // proceed with individual dispositions, but the assessment must not
    // silently grant compression while it waits for a class to be submitted.
    return {
      registry: Object.freeze({
        schemaVersion: 1,
        kind: 'path-role-registry',
        rules: Object.freeze([]),
      }),
      sourceDigest: sha256(canonicalJson(null)),
    };
  }
  const registry = parsePathRoleRegistry(
    JSON.parse(fs.readFileSync(registryPath, 'utf8')),
  );
  return {
    registry,
    sourceDigest: sha256(canonicalJson(registry)),
  };
}

export function createProposeAssuranceAssessmentNode(
  services: Pick<ProposeRuntime, 'evidence'>,
  input: {
    repositoryRoot: string;
    session: InvestigationSession;
    scanFacts: InvestigationScanFacts;
    groupFacts: InvestigationGroupFacts;
    floorOverflowDecision: FloorOverflowDecision | null;
    floorOverflowDecisionNode: EvidenceNode | null;
  },
): EvidenceNode {
  const hitPaths = [
    ...new Set(
      deriveClassGroupsWithContextFromFacts({
        scanFacts: input.scanFacts,
        groupFacts: input.groupFacts,
      }).flatMap(({ hits }) => hits.map(({ path: hitPath }) => hitPath)),
    ),
  ].sort();
  const pathRoles = readPathRoleRegistryForAssessment(input.repositoryRoot);
  // The ordinary propose intent has no non-reserved declared-change-class
  // field yet. Absence is assessed as behavioral by the shared contract; it is
  // never interpreted as a cheaper class.
  const declaredChangeClasses: InvestigationChangeClass[] = [];
  const assessment = assessAssurance({
    changeId: input.session.changeId,
    declaredChangeClasses,
    registry: pathRoles.registry,
    hitPaths,
    ...(input.floorOverflowDecision === null
      ? {}
      : {
          floorOverflow: {
            escalated: input.floorOverflowDecision.escalated,
            reasons: input.floorOverflowDecision.reasons,
          },
        }),
    at: input.session.createdAt,
  });
  const semanticParentResultDigests: Record<string, string> = {};
  const provenanceParentNodeIds: Record<string, string> = {};
  if (input.floorOverflowDecisionNode !== null) {
    semanticParentResultDigests['floor-overflow'] =
      input.floorOverflowDecisionNode.resultDigest;
    provenanceParentNodeIds['floor-overflow'] =
      input.floorOverflowDecisionNode.nodeId;
  }
  return services.evidence.createEvidenceNode({
    type: 'assurance-assessment',
    nodeSchema: 'assurance.assessment.v1',
    evaluator: 'workflow-propose.assurance-assessment.v1',
    policyDigest: ASSURANCE_ASSESSMENT_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(input.session.baseline)),
      declaredChangeClasses: sha256(canonicalJson(declaredChangeClasses)),
      hitPaths: sha256(canonicalJson(hitPaths)),
      pathRoleRegistry: pathRoles.sourceDigest,
      floorOverflowDecision:
        input.floorOverflowDecisionNode?.resultDigest ??
        sha256(canonicalJson(null)),
    },
    semanticParentResultDigests,
    provenanceParentNodeIds,
    outputSchema: 'assurance.assessment-output.v1',
    output: assessment,
    runtimeMetadata: {},
  });
}

function assertClassCompressionAllowed(
  assessmentNode: EvidenceNode | null,
): void {
  if (assessmentNode === null) {
    throw workflowError(
      'ASSURANCE_ASSESSMENT_UNAVAILABLE',
      'A class disposition requires a current production assurance assessment.',
      ExitCode.guard,
    );
  }
  const assessment = reportProposeAssuranceAssessment(assessmentNode);
  if (assessment.floors.planning !== 'individual-only') return;
  throw workflowError(
    'ASSURANCE_PLANNING_FLOOR_VIOLATION',
    'The current assessment requires individual dispositions; a declared class cannot lower that floor.',
    ExitCode.verification,
    {
      details: {
        assessmentNodeId: assessment.nodeId,
        assessmentResultDigest: assessment.resultDigest,
        assessmentPolicyDigest: assessment.policyDigest,
        floors: assessment.floors,
        reasons: assessment.reasons,
      },
    },
  );
}

/**
 * Turns whatever an author wrote into the one disposition per group the
 * evidence has always required.
 *
 * A class is an authoring shape, not a weaker claim: the engine expands it into
 * exactly the per-group dispositions the author would otherwise have written by
 * hand, and every downstream check — partition, coverage, DAG — runs unchanged
 * on the result. What a class removes is the obligation to retype the same
 * rationale for hits a machine can show are equivalent.
 *
 * The expansion recomputes admissibility from the scans rather than trusting
 * the submission: membership is checked hit by hit against the class predicate,
 * the predicate must discriminate members from every other hit the same scan
 * produced, and a group whose term saturated is never foldable because its hits
 * are known to be incomplete.
 */
export function expandSubmittedDispositions(
  repositoryRoot: string,
  input: {
    scanFacts: InvestigationScanFacts;
    groupFacts: InvestigationGroupFacts;
    payload: GroupDispositionsPayload;
    saturatedTermIds?: readonly string[];
    assuranceAssessmentNode: EvidenceNode | null;
  },
): InvestigationDispositionInput[] {
  const classes = input.payload.classes ?? [];
  if (classes.length === 0) return input.payload.dispositions;
  const parsedClasses = classes.map((declared) =>
    parseClassDisposition(declared),
  );
  const groups = deriveClassGroupsWithContextFromFacts({
    scanFacts: input.scanFacts,
    groupFacts: input.groupFacts,
  });
  const registry = readPathRoleRegistryForClasses(repositoryRoot);
  assertClassCompressionAllowed(input.assuranceAssessmentNode);
  const expansion = expandClassDispositions(
    // Parsed here, not trusted as stored: the checkpoint keeps what the author
    // wrote, and a predicate only means anything once it has been read by the
    // contract that defines it.
    parsedClasses,
    groups,
    registry,
    input.saturatedTermIds === undefined
      ? {}
      : { saturatedTermIds: input.saturatedTermIds },
  );
  return [
    ...input.payload.dispositions,
    ...expansion.dispositions.map(
      ({ groupId, classification, rationale, author }) => ({
        groupId,
        classification,
        rationale,
        author,
      }),
    ),
  ];
}

export function mergeReviewerReopenCheckpoint(
  services: Pick<ProposeRuntime, 'investigation'>,
  rebuilt: RebuiltInvestigation,
  checkpoint: InvestigationCheckpointEnvelope,
): InvestigationCheckpointEnvelope {
  if (checkpoint.kind === 'main-terms') {
    return checkpoint;
  }
  if (checkpoint.kind === 'group-dispositions') {
    const reusable = reviewerReusableGroupDispositions(rebuilt);
    const reusableIds = new Set(reusable.map(({ groupId }) => groupId));
    if (
      checkpoint.payload.dispositions.some(({ groupId }) =>
        reusableIds.has(groupId),
      )
    ) {
      throw workflowError(
        'INVESTIGATION_REVIEWER_REOPEN_SCOPE_INVALID',
        'Reviewer-term reopening accepts answers only for new or changed groups.',
        ExitCode.guard,
      );
    }
    return services.investigation.assertInvestigationCheckpointEnvelope({
      ...checkpoint,
      payload: {
        // Classes and their audits survive the merge: dropping either would
        // silently turn a covered, reviewed submission into an incomplete one.
        ...(checkpoint.payload.classes === undefined
          ? {}
          : { classes: checkpoint.payload.classes }),
        ...(checkpoint.payload.sampleAudits === undefined
          ? {}
          : { sampleAudits: checkpoint.payload.sampleAudits }),
        dispositions: [...reusable, ...checkpoint.payload.dispositions].sort(
          (left, right) => left.groupId.localeCompare(right.groupId),
        ),
      },
    });
  }
  const reusable = reviewerReusableWhyAnswers(rebuilt);
  const reusableIds = new Set(
    reusable.map(({ manifestEntryId }) => manifestEntryId),
  );
  if (
    checkpoint.payload.answers.some(({ manifestEntryId }) =>
      reusableIds.has(manifestEntryId),
    )
  ) {
    throw workflowError(
      'INVESTIGATION_REVIEWER_REOPEN_SCOPE_INVALID',
      'Reviewer-term reopening accepts WHY answers only for new or changed manifest rows.',
      ExitCode.guard,
    );
  }
  return services.investigation.assertInvestigationCheckpointEnvelope({
    ...checkpoint,
    payload: {
      answers: [...reusable, ...checkpoint.payload.answers].sort(
        (left, right) =>
          left.manifestEntryId.localeCompare(right.manifestEntryId),
      ),
    },
  });
}

export function investigationKnowledgeCarries(
  services: Pick<ProposeRuntime, 'workspace'>,
  input: {
    repositoryRoot: string;
    completeManifest: readonly InvestigationFullBlobFact[];
    reuseCoverage: ReuseCoverageRecord;
  },
) {
  const rowById = new Map(
    input.completeManifest.map((row) => [row.manifestEntryId, row]),
  );
  return input.reuseCoverage.carried.map((carry) => {
    if (!rowById.has(carry.manifestEntryId)) {
      throw workflowError(
        'RECONSTRUCTION_MISMATCH',
        'Semantic reuse cites a missing load-bearing authoring row.',
        ExitCode.verification,
      );
    }
    const entry = services.workspace.readLedgerEntry(
      input.repositoryRoot,
      carry.ledgerEntryId,
    );
    if (entry.subject.subjectId !== carry.subjectId) {
      throw workflowError(
        'RECONSTRUCTION_MISMATCH',
        'Semantic reuse subject no longer matches its immutable knowledge version.',
        ExitCode.verification,
      );
    }
    return {
      manifestEntryId: carry.manifestEntryId,
      subjectId: carry.subjectId,
      versionDigest: entry.entryId,
      freshnessRationale:
        'The semantic freshness plan accepted this exact blob, policy and dependency state.',
      semanticAuthor: {
        id: 'workflow-engine',
        provenance: `semantic-freshness:${entry.entryId}`,
      },
      provenanceDigest: sha256(
        canonicalJson({
          schema: 'investigation-v3-knowledge-freshness.v1',
          carry,
          entryId: entry.entryId,
          resolutions: input.reuseCoverage.resolutions,
        }),
      ),
    };
  });
}

export function buildWhyAuthoringFromCheckpoint(
  services: Pick<ProposeRuntime, 'workspace'>,
  input: {
    repositoryRoot: string;
    rebuilt: RebuiltInvestigation;
    answers: WhyAnswersPayload['answers'];
    checkpointProvenanceDigest: string;
  },
): ReturnType<typeof buildInvestigationV3WhyAuthoring> {
  const view = input.rebuilt.v3Domain?.evidenceView;
  if (view === undefined || view === null) {
    throw workflowError(
      'SEMANTIC_COMPLETENESS_FAILURE',
      'WHY authoring has no current disposition facts.',
      ExitCode.guard,
    );
  }
  const requirements = deriveInvestigationV3WhyRequirements(view);
  const mapped = mapInvestigationWhyCheckpointToV3Sources({
    requirements,
    manifestRows: input.rebuilt.completeFullBlobManifest,
    answers: input.answers,
    carried: investigationKnowledgeCarries(services, {
      repositoryRoot: input.repositoryRoot,
      completeManifest: input.rebuilt.completeFullBlobManifest,
      reuseCoverage: input.rebuilt.reuseCoverage,
    }),
    checkpointProvenanceDigest: input.checkpointProvenanceDigest,
  });
  return buildInvestigationV3WhyAuthoring({
    view,
    answers: mapped.answers,
    knowledgeReuse: mapped.knowledgeReuse,
  });
}
