import { createInvestigationTreeScanner } from './investigation-scanner.ts';
import { workflowTrackedObjectReaderPort } from '../repository-transaction/tracked-tree-reader.ts';
import { assertPinnedInvestigationBaseline } from './investigation-baseline.ts';
/** Replays baseline, terms, scanner and semantic decisions in authority order. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { deriveInvestigationGroupFacts } from '../../modules/investigation/domain/investigation-groups.ts';
import {
  INVESTIGATION_LIMITS,
  previewInvestigationTermUnion,
} from '../../modules/investigation/domain/investigation-terms.ts';
import type { InvestigationTreeScanner } from '../../modules/investigation/domain/investigation-scanner.ts';
import {
  assertSaturationDecision,
  materializeInvestigationEvidenceViewFromFacts,
  type InvestigationEvidenceReplayer,
} from '../../modules/investigation/manifest/investigation-materializer.ts';
import type { InvestigationV3Baseline } from '../../modules/investigation/manifest/investigation-baseline.ts';

export function createInvestigationEvidenceReplayer(observations: {
  assertBaseline(
    repositoryRoot: string,
    baseline: InvestigationV3Baseline,
  ): void;
  scanInvestigationTreeFacts: InvestigationTreeScanner;
}): InvestigationEvidenceReplayer {
  const { assertBaseline, scanInvestigationTreeFacts } = observations;
  return function materializeInvestigationEvidenceView(input) {
    assertBaseline(input.repositoryRoot, input.authoring.baseline);
    const preview = previewInvestigationTermUnion(
      input.authoring.termContributions,
      input.authoring.scanner.limits ?? { ...INVESTIGATION_LIMITS },
    );
    if (preview.outcome !== 'ready') {
      throw workflowError(
        'TERM_INTEGRITY_MISMATCH',
        'Persisted term contributions do not produce a replayable canonical union.',
        ExitCode.guard,
        { details: { violations: preview.violations } },
      );
    }
    if (
      canonicalJson(preview.terms) !==
      canonicalJson(input.authoring.canonicalTerms)
    ) {
      throw workflowError(
        'TERM_INTEGRITY_MISMATCH',
        'Persisted canonical terms do not match their complete contributions.',
        ExitCode.guard,
      );
    }
    const limits = input.authoring.scanner.limits ?? {
      ...INVESTIGATION_LIMITS,
    };
    const scan = scanInvestigationTreeFacts({
      repositoryRoot: input.repositoryRoot,
      treeOid: input.authoring.baseline.treeOid,
      terms: preview.terms,
      limits,
      allowSaturatedTerms: input.authoring.scanner.allowSaturatedTerms,
    });
    if (scan.outcome !== 'ready') {
      throw workflowError(
        'REPLAY_CLOSURE_UNSUPPORTED',
        'Pinned scanner replay requires deterministic narrowing.',
        ExitCode.guard,
        { details: { violations: scan.violations } },
      );
    }
    assertSaturationDecision(
      scan.saturatedTermIds ?? [],
      input.authoring.scanner.saturationDecision,
    );
    const grouping = deriveInvestigationGroupFacts({
      scanFacts: scan.facts,
      mutationPolicy: input.authoring.grouping.mutationPolicy,
      declaredRoots: input.authoring.grouping.declaredRoots,
      reviewedRelationships: input.authoring.grouping.reviewedRelationships,
    });
    return materializeInvestigationEvidenceViewFromFacts({
      scanFacts: scan.facts,
      grouping,
      canonicalTerms: structuredClone(preview.terms),
      limits: structuredClone(limits),
      semanticGroupDecisions: input.authoring.semanticGroupDecisions,
      dispositionDecisions: input.authoring.dispositionDecisions,
    });
  };
}

export const scanInvestigationTreeFacts = createInvestigationTreeScanner(
  workflowTrackedObjectReaderPort,
);
export const materializeInvestigationEvidenceView =
  createInvestigationEvidenceReplayer({
    assertBaseline: assertPinnedInvestigationBaseline,
    scanInvestigationTreeFacts,
  });
