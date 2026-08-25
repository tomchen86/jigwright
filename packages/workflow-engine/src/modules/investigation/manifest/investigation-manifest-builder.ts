import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import type {
  InvestigationDispositionDecision,
  InvestigationSemanticGroupDecision,
} from '../domain/investigation-domain.ts';
import type { FloorOverflowDecision } from '../domain/floor-overflow-pruning.ts';
import type {
  DeclaredInvestigationRoot,
  InvestigationGroupFacts,
  ReviewedPathRelationship,
} from '../domain/investigation-groups.ts';
import type { InvestigationScanFacts } from '../domain/investigation-scanner.ts';
import type {
  InvestigationLimits,
  InvestigationTermContribution,
  PreviewInvestigationTerm,
} from '../domain/investigation-terms.ts';
import type { InvestigationSemanticAuthor } from '../domain/investigation-applicability.ts';
import type { MutationClassPolicy } from '../../source/mutation-class-policy.ts';
import type { NormalizedChangeIntent } from '../../../runtime/storage-journal/provider-invocation-store.ts';
import {
  buildInvestigationManifestDraft,
  createInvestigationV3Blocker,
  sealInvestigationManifestDraft,
  validateDraftForSeal,
  validateForAuthority,
  type InvestigationAssuranceFacts,
  type InvestigationKnowledgeReuseDecision,
  type InvestigationManifestDraftV3,
  type InvestigationManifestV3,
  type InvestigationRequirementV3,
  type InvestigationSemanticException,
  type InvestigationV3Blocker,
  type InvestigationV3RoleResult,
  type InvestigationWhyOverlayV3,
  type OrdinaryInvestigationAuthoringState,
} from './investigation-manifest.ts';
import {
  materializeInvestigationEvidenceView,
  type InvestigationScanSaturationDecision,
  type InvestigationV3Baseline,
} from './investigation-materializer.ts';

export type InvestigationManifestV3ExpectedCurrentness = {
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
};

export type BuildInvestigationManifestV3Input = {
  repositoryRoot: string;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  normalizedIntent: NormalizedChangeIntent;
  authoring: {
    sessionRevision: number;
    sessionSnapshotDigest: string;
  };
  baseline: InvestigationV3Baseline;
  termContributions: InvestigationTermContribution[];
  canonicalTerms: PreviewInvestigationTerm[];
  scanFacts: InvestigationScanFacts;
  groupFacts: InvestigationGroupFacts;
  scanner: {
    limits?: InvestigationLimits;
    allowSaturatedTerms: boolean;
    saturationDecision: InvestigationScanSaturationDecision | null;
  };
  grouping: {
    mutationPolicy: MutationClassPolicy;
    declaredRoots: DeclaredInvestigationRoot[];
    reviewedRelationships: ReviewedPathRelationship[];
  };
  semanticGroupDecisions: InvestigationSemanticGroupDecision[];
  dispositionDecisions: InvestigationDispositionDecision[];
  whyOverlays: InvestigationWhyOverlayV3[];
  knowledgeReuseDecisions: InvestigationKnowledgeReuseDecision[];
  investigationRoleResults: InvestigationV3RoleResult[];
  floorOverflowDecision: FloorOverflowDecision | null;
  exceptions: InvestigationSemanticException[];
  investigationRequirements: InvestigationRequirementV3[];
  assuranceFacts: InvestigationAssuranceFacts;
  approval: {
    semanticAuthor: InvestigationSemanticAuthor;
    approvalProvenanceDigest: string;
  };
  expected: InvestigationManifestV3ExpectedCurrentness;
};

export type BuildInvestigationManifestV3Result =
  | {
      outcome: 'built';
      draft: InvestigationManifestDraftV3;
      manifest: InvestigationManifestV3;
      manifestDigest: string;
      investigationTargetDigest: string;
    }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };

/**
 * Builds the production Manifest from domain facts, seals it, then verifies it
 * against the caller's exact lifecycle snapshot. The supplied scan and group
 * facts are process-local inputs: pinned replay must reconstruct them exactly.
 */
export function buildInvestigationManifestV3(
  input: BuildInvestigationManifestV3Input,
): BuildInvestigationManifestV3Result {
  const ordinary: OrdinaryInvestigationAuthoringState['ordinary'] = {
    baseline: structuredClone(input.baseline),
    termContributions: structuredClone(input.termContributions),
    canonicalTerms: structuredClone(input.canonicalTerms),
    scanner: structuredClone(input.scanner),
    grouping: structuredClone(input.grouping),
    semanticGroupDecisions: structuredClone(input.semanticGroupDecisions),
    dispositionDecisions: structuredClone(input.dispositionDecisions),
    whyOverlays: structuredClone(input.whyOverlays),
    knowledgeReuseDecisions: structuredClone(input.knowledgeReuseDecisions),
    investigationRoleResults: structuredClone(input.investigationRoleResults),
    floorOverflowDecision: structuredClone(input.floorOverflowDecision),
    exceptions: structuredClone(input.exceptions),
    investigationRequirements: structuredClone(input.investigationRequirements),
    assuranceFacts: structuredClone(input.assuranceFacts),
  };

  try {
    const replayed = materializeInvestigationEvidenceView({
      repositoryRoot: input.repositoryRoot,
      authoring: ordinary,
    });
    if (
      canonicalJson(replayed.scanFacts) !== canonicalJson(input.scanFacts) ||
      canonicalJson(replayed.grouping) !== canonicalJson(input.groupFacts)
    ) {
      return rawFactsMismatch(input);
    }
  } catch (error) {
    return blockedFromError(input, error);
  }

  const built = buildInvestigationManifestDraft({
    repositoryRoot: input.repositoryRoot,
    state: {
      schemaVersion: 1,
      applicabilityKind: 'ordinary',
      repositoryId: input.repositoryId,
      changeId: input.changeId,
      investigationId: input.investigationId,
      normalizedIntent: structuredClone(input.normalizedIntent),
      authoring: structuredClone(input.authoring),
      ordinary,
    },
  });
  if (built.outcome !== 'built') return built;

  const draftValidation = validateDraftForSeal({
    repositoryRoot: input.repositoryRoot,
    draft: built.draft,
  });
  if (draftValidation.outcome !== 'verified') return draftValidation;

  const sealed = sealInvestigationManifestDraft({
    draft: draftValidation.draft,
    approval: structuredClone(input.approval),
  });
  if (sealed.outcome !== 'sealed') return sealed;

  const authority = validateForAuthority({
    repositoryRoot: input.repositoryRoot,
    manifest: sealed.manifest,
    expected: structuredClone(input.expected),
  });
  if (authority.outcome !== 'verified') return authority;

  return {
    outcome: 'built',
    draft: draftValidation.draft,
    manifest: authority.manifest,
    manifestDigest: authority.manifestDigest,
    investigationTargetDigest: authority.investigationTargetDigest,
  };
}

function rawFactsMismatch(
  input: BuildInvestigationManifestV3Input,
): BuildInvestigationManifestV3Result {
  return {
    outcome: 'blocked',
    blocker: createInvestigationV3Blocker({
      attemptedTransition: 'build-draft',
      candidate: candidateIdentity(input),
      failureCode: 'RECONSTRUCTION_MISMATCH',
      message:
        'Supplied Investigation domain facts do not match pinned deterministic replay.',
    }),
  };
}

function blockedFromError(
  input: BuildInvestigationManifestV3Input,
  error: unknown,
): BuildInvestigationManifestV3Result {
  const code =
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'RECONSTRUCTION_MISMATCH';
  return {
    outcome: 'blocked',
    blocker: createInvestigationV3Blocker({
      attemptedTransition: 'build-draft',
      candidate: candidateIdentity(input),
      failureCode: code,
      message:
        error instanceof Error
          ? error.message
          : 'Unknown Investigation Manifest construction failure.',
    }),
  };
}

function candidateIdentity(input: BuildInvestigationManifestV3Input) {
  return {
    schemaVersion: 1,
    kind: 'investigation-manifest-candidate',
    repositoryId: input.repositoryId,
    changeId: input.changeId,
    investigationId: input.investigationId,
    authoring: input.authoring,
    baseline: input.baseline,
    scanTreeDigest: input.scanFacts.treeDigest,
    groupingPolicyDigest: input.groupFacts.groupingPolicyDigest,
  };
}
