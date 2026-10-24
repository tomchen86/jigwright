import type {
  RebuiltInvestigation,
  ExemptionProposeOutput,
  ProposeAssuranceAssessment,
} from './propose-types.ts';
import type { EvidenceNode } from '@jigwright/core/evidence-node';
import {
  ASSURANCE_ASSESSMENT_POLICY_DIGEST,
  type AssuranceAssessmentReport,
} from '../assurance/assurance-assessment-chain.ts';
import { isRecord, sha256 } from './propose-values.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { InvestigationV3Blocker } from '../investigation/manifest/investigation-manifest-types.ts';

type InvestigationSession = RebuiltInvestigation['session'];

export type ProposeExemptionSession = NonNullable<
  ExemptionProposeOutput['investigation']
>;

export function reportProposeAssuranceAssessment(
  node: EvidenceNode,
): ProposeAssuranceAssessment {
  const output = node.output;
  if (
    node.type !== 'assurance-assessment' ||
    node.policyDigest !== ASSURANCE_ASSESSMENT_POLICY_DIGEST ||
    !isRecord(output) ||
    output.schemaVersion !== 1 ||
    output.kind !== 'assurance-assessment' ||
    typeof output.changeId !== 'string'
  ) {
    throw workflowError(
      'ASSURANCE_ASSESSMENT_INVALID',
      'The propose assurance assessment is malformed or uses another policy.',
      ExitCode.staleState,
    );
  }
  return Object.freeze({
    ...(output as AssuranceAssessmentReport),
    nodeId: node.nodeId,
    resultDigest: node.resultDigest,
    policyDigest: node.policyDigest,
  });
}

export function investigationV3SessionSnapshotDigest(
  session: InvestigationSession | ProposeExemptionSession,
): string {
  return sha256(`${canonicalJson(session)}\n`);
}

export function investigationV3BuildFailure(
  blocker: InvestigationV3Blocker,
): WorkflowError {
  return workflowError(
    blocker.failureCode,
    `Investigation v3 transition failed during ${blocker.attemptedTransition}.`,
    ExitCode.guard,
    {
      details: {
        failureIdentity: blocker.failureIdentity,
        candidateDigest: blocker.candidateDigest,
        detailsDigest: blocker.detailsDigest,
      },
    },
  );
}
