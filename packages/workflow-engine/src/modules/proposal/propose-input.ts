/** Pure proposal envelopes and exact binding validation. */
import { parseProviderRetryExplanation } from '../provider-orchestration/provider-retry-explanation.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertChangeId,
  normalizePolicyPath,
} from '../../foundation/repository-path/repository-path.ts';
import type {
  readPlanReviewNode,
  PlanReviewDispositionSubmission,
} from '../assurance/plan-review.ts';
import type {
  ExemptionPlanningContributionEnvelope,
  ExemptionProposeOutput,
  InvestigationExemptionRequest,
  OrdinaryProposeOutput,
  PlanningContributionEnvelope,
  PlanningContributionPayload,
  PlanReviewDispositionsEnvelope,
  PlanReviewProgressEnvelope,
  PlanReviewRetryEnvelope,
  ProposeOutput,
  ProposeStartInput,
  ProposeWork,
  ProviderProgressEnvelope,
  ProviderRetryEnvelope,
  ProposeInput,
  ProposeLifecycleStatus,
  PlanReviewReservation as CanonicalPlanReviewReservation,
} from './propose-types.ts';
import {
  DIGEST,
  MAX_CALLER_JSON_BYTES,
  envelopeKeyDetail,
  hasExactKeys,
  isBaseline,
  isRecord,
  isStringArray,
  planningContributionInvalid,
  proposeInputInvalid,
} from './propose-values.ts';
import type { InvestigationScanSaturationAcceptanceEnvelope } from '../investigation/domain/investigation-session-types.ts';
import type { InvestigationStatus } from '../lifecycle/investigation-status.ts';
import type { ProposeExemptionSession } from '../lifecycle/propose-exemption-session.ts';
import type { GuardContract } from '../planning-provider/planning-artifact-types.ts';
import {
  assertInvestigationCheckpointEnvelope,
  assertInvestigationScanSaturationAcceptanceEnvelope,
} from '../investigation/domain/investigation-checkpoint-contract.ts';
type PlanReviewReservation = {
  subject: Pick<CanonicalPlanReviewReservation['subject'], 'subjectDigest'>;
  request: Pick<
    CanonicalPlanReviewReservation['request'],
    'invocationId' | 'requestDigest'
  >;
};

export function createPlanningContributionEnvelope(
  output: OrdinaryProposeOutput,
  payload: PlanningContributionPayload,
): PlanningContributionEnvelope;

export function createPlanningContributionEnvelope(
  output: ExemptionProposeOutput,
  payload: PlanningContributionPayload,
): ExemptionPlanningContributionEnvelope;

export function createPlanningContributionEnvelope(
  output: ProposeOutput,
  payload: PlanningContributionPayload,
): PlanningContributionEnvelope | ExemptionPlanningContributionEnvelope;

export function createPlanningContributionEnvelope(
  output: ProposeOutput,
  payload: PlanningContributionPayload,
): PlanningContributionEnvelope | ExemptionPlanningContributionEnvelope {
  if (
    output.state !== 'awaiting-planning-contribution' ||
    output.investigation === null
  ) {
    throw workflowError(
      'PLANNING_CONTRIBUTION_NOT_AVAILABLE',
      'The propose wrapper is not waiting for planning input.',
      ExitCode.guard,
    );
  }
  const status = output.investigation;
  if (status.state === 'investigation-exempt') {
    return assertExemptionPlanningContributionEnvelope({
      schemaVersion: 1,
      kind: 'exemption-planning-contribution',
      investigationId: status.investigationId,
      changeId: status.changeId,
      expectedRevision: status.revision,
      baseline: status.baseline,
      intentDigest: status.intentDigest,
      applicabilityDigest: status.applicability.applicabilityDigest,
      payload,
    });
  }
  return assertPlanningContributionEnvelope({
    schemaVersion: 1,
    kind: 'planning-contribution',
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: status.baseline,
    intentDigest: status.intentDigest,
    blindManifestDigest: status.blindManifestDigest,
    payload,
  });
}

export function createProviderProgressEnvelope(
  status: InvestigationStatus,
): ProviderProgressEnvelope {
  return {
    schemaVersion: 1,
    kind: 'provider-progress',
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: { ...status.baseline },
    intentDigest: status.intentDigest,
    blindManifestDigest: status.blindManifestDigest,
  };
}

export function createPlanReviewProgressEnvelope(
  output: ProposeOutput,
): PlanReviewProgressEnvelope {
  if (!output.investigation || !output.planReview) {
    throw workflowError(
      'PLAN_REVIEW_PROGRESS_NOT_AVAILABLE',
      'The propose wrapper has no current PlanReview invocation.',
      ExitCode.guard,
    );
  }
  return {
    schemaVersion: 1,
    kind: 'plan-review-progress',
    investigationId: output.investigation.investigationId,
    changeId: output.changeId,
    subjectDigest: output.planReview.subjectDigest,
    invocationId: output.planReview.invocationId,
    requestDigest: output.planReview.requestDigest,
  };
}

export function createPlanReviewDispositionsEnvelope(
  output: ProposeOutput,
  dispositions: PlanReviewDispositionSubmission[],
): PlanReviewDispositionsEnvelope {
  if (
    output.state !== 'awaiting-challenge-dispositions' ||
    !output.investigation ||
    !output.planReview?.reviewNodeId ||
    !output.planReview.reviewResultDigest
  ) {
    throw workflowError(
      'PLAN_REVIEW_DISPOSITIONS_NOT_AVAILABLE',
      'The propose wrapper is not waiting for review dispositions.',
      ExitCode.guard,
    );
  }
  return {
    schemaVersion: 1,
    kind: 'plan-review-dispositions',
    investigationId: output.investigation.investigationId,
    changeId: output.changeId,
    subjectDigest: output.planReview.subjectDigest,
    reviewNodeId: output.planReview.reviewNodeId,
    reviewResultDigest: output.planReview.reviewResultDigest,
    dispositions,
  };
}

export function planReviewProgressSchema(
  status: ProposeLifecycleStatus,
  reservation: PlanReviewReservation,
): Record<string, unknown> {
  return withEnvelopeTemplate({
    schemaVersion: 1,
    kind: 'plan-review-progress',
    required: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      subjectDigest: reservation.subject.subjectDigest,
      invocationId: reservation.request.invocationId,
      requestDigest: reservation.request.requestDigest,
    },
  });
}

export function planReviewDispositionSchema(
  status: ProposeLifecycleStatus,
  review: ReturnType<typeof readPlanReviewNode>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'plan-review-dispositions',
    required: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      subjectDigest: review.subjectDigest,
      reviewNodeId: review.nodeId,
      reviewResultDigest: review.resultDigest,
      challengeIds: review.findings.map(({ findingId }) => findingId),
    },
  };
}

/**
 * Every resume input is the flat envelope `{schemaVersion, kind, ...fields}`;
 * the schema keeps its `binding`/`required` description and also carries that
 * envelope verbatim as `template`, so a caller copies instead of reassembling.
 */
export function withEnvelopeTemplate(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const fields = (schema.binding ?? schema.required) as
    Record<string, unknown> | undefined;
  if (fields === undefined) return schema;
  const acknowledgement = (schema.requiredAcknowledgement ?? {}) as Record<
    string,
    unknown
  >;
  return {
    ...schema,
    template: {
      schemaVersion: 1,
      kind: schema.kind,
      ...fields,
      ...acknowledgement,
    },
  };
}

export const AGENT_PLACEHOLDER = '<agent identity>';

export const GENERATED_ARTIFACT_PATH =
  /(?:^|\/)(?:coverage|dist|build|out|\.next|\.turbo|target)\/|(?:^|\/)[^/]*(?:-lock\.(?:json|ya?ml)|\.lock|\.min\.[a-z]+|\.map|\.snap)$/;

/**
 * Skeleton payload for the pending checkpoint. Groups whose every path is a
 * build or coverage artifact arrive pre-classified as `generated`; everything
 * else carries `<...>` placeholders the caller must replace.
 */
export function checkpointPayloadTemplate(
  kind: 'main-terms' | 'group-dispositions' | 'why-answers',
  work: ProposeWork,
): Record<string, unknown> {
  if (kind === 'main-terms') {
    return {
      reference: '<the owner wording these terms locate>',
      terms: [
        {
          kind: '<literal-content | literal-path | symbol | config-key>',
          value: '<exact term to search for>',
          rationale: '<why this term locates the change>',
          expectedRelationship: '<how its hits relate to the change>',
        },
      ],
    };
  }
  if (kind === 'group-dispositions') {
    return {
      dispositions: work.groups.map((group) =>
        group.paths.length > 0 &&
        group.paths.every((entry) => GENERATED_ARTIFACT_PATH.test(entry))
          ? {
              groupId: group.groupId,
              classification: 'generated',
              rationale:
                'Build, coverage, or lock artifact: tooling output that is never a planning input and never edited by hand.',
              author: AGENT_PLACEHOLDER,
            }
          : {
              groupId: group.groupId,
              classification:
                '<load-bearing | test-or-mirror | generated | incidental-reference | irrelevant>',
              rationale: '<why this classification>',
              author: AGENT_PLACEHOLDER,
            },
      ),
    };
  }
  return {
    answers: work.fullBlobManifest.map((entry) => ({
      manifestEntryId: entry.manifestEntryId,
      why: `<why ${entry.path} is load-bearing for this change>`,
      protectedInvariant: '<behaviour that must survive the change>',
      reviewerQuestion: '<what a reviewer should verify here>',
      answer: '<the answer, from reading the whole file>',
      semanticAuthor: AGENT_PLACEHOLDER,
      readComplete: false,
    })),
  };
}

export function planningContributionSchema(
  status: InvestigationStatus,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'planning-contribution',
    binding: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      expectedRevision: status.revision,
      baseline: status.baseline,
      intentDigest: status.intentDigest,
      blindManifestDigest: status.blindManifestDigest,
    },
    payloadFields: [
      'proposal',
      'design',
      'specs',
      'tasks',
      'guard',
      'executionTasks',
    ],
    engineOwnedFieldsRejected: ['investigation', 'planReview'],
  };
}

export function exemptionPlanningContributionSchema(
  status: ProposeExemptionSession,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'exemption-planning-contribution',
    binding: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      expectedRevision: status.revision,
      baseline: status.baseline,
      intentDigest: status.intentDigest,
      applicabilityDigest: status.applicability.applicabilityDigest,
    },
    payloadFields: [
      'proposal',
      'design',
      'specs',
      'tasks',
      'guard',
      'executionTasks',
    ],
    engineOwnedFieldsRejected: ['investigation', 'planReview'],
  };
}

export function assertExemptionPlanningContributionEnvelope(
  value: unknown,
): ExemptionPlanningContributionEnvelope {
  const KEYS = [
    'schemaVersion',
    'kind',
    'investigationId',
    'changeId',
    'expectedRevision',
    'baseline',
    'intentDigest',
    'applicabilityDigest',
    'payload',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [...KEYS]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'exemption-planning-contribution' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    value.expectedRevision !== 0 ||
    !isBaseline(value.baseline) ||
    typeof value.intentDigest !== 'string' ||
    !DIGEST.test(value.intentDigest) ||
    typeof value.applicabilityDigest !== 'string' ||
    !DIGEST.test(value.applicabilityDigest)
  ) {
    throw proposeInputInvalid(
      envelopeKeyDetail('exemption-planning-contribution', KEYS, value),
    );
  }
  return {
    schemaVersion: 1,
    kind: 'exemption-planning-contribution',
    investigationId: value.investigationId,
    changeId: assertChangeId(value.changeId),
    expectedRevision: 0,
    baseline: value.baseline,
    intentDigest: value.intentDigest,
    applicabilityDigest: value.applicabilityDigest,
    payload: assertPlanningPayload(value.payload),
  };
}

export function assertPlanningContributionEnvelope(
  value: unknown,
): PlanningContributionEnvelope {
  const KEYS = [
    'schemaVersion',
    'kind',
    'investigationId',
    'changeId',
    'expectedRevision',
    'baseline',
    'intentDigest',
    'blindManifestDigest',
    'payload',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [...KEYS]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'planning-contribution' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    typeof value.intentDigest !== 'string' ||
    !DIGEST.test(value.intentDigest) ||
    typeof value.blindManifestDigest !== 'string' ||
    !DIGEST.test(value.blindManifestDigest)
  ) {
    throw proposeInputInvalid(
      envelopeKeyDetail('planning-contribution', KEYS, value),
    );
  }
  return {
    schemaVersion: 1,
    kind: 'planning-contribution',
    investigationId: value.investigationId,
    changeId: assertChangeId(value.changeId),
    expectedRevision: value.expectedRevision as number,
    baseline: value.baseline,
    intentDigest: value.intentDigest,
    blindManifestDigest: value.blindManifestDigest,
    payload: assertPlanningPayload(value.payload),
  };
}

export function assertPlanReviewProgressEnvelope(
  value: unknown,
): PlanReviewProgressEnvelope {
  const KEYS = [
    'schemaVersion',
    'kind',
    'investigationId',
    'changeId',
    'subjectDigest',
    'invocationId',
    'requestDigest',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [...KEYS]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-progress' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.subjectDigest !== 'string' ||
    !DIGEST.test(value.subjectDigest) ||
    typeof value.invocationId !== 'string' ||
    typeof value.requestDigest !== 'string' ||
    !DIGEST.test(value.requestDigest)
  ) {
    throw proposeInputInvalid(
      envelopeKeyDetail('plan-review-progress', KEYS, value),
    );
  }
  return value as PlanReviewProgressEnvelope;
}

export function assertPlanReviewDispositionsEnvelope(
  value: unknown,
): PlanReviewDispositionsEnvelope {
  const KEYS = [
    'schemaVersion',
    'kind',
    'investigationId',
    'changeId',
    'subjectDigest',
    'reviewNodeId',
    'reviewResultDigest',
    'dispositions',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [...KEYS]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-dispositions' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.subjectDigest !== 'string' ||
    !DIGEST.test(value.subjectDigest) ||
    typeof value.reviewNodeId !== 'string' ||
    !DIGEST.test(value.reviewNodeId) ||
    typeof value.reviewResultDigest !== 'string' ||
    !DIGEST.test(value.reviewResultDigest) ||
    !Array.isArray(value.dispositions)
  ) {
    throw proposeInputInvalid(
      envelopeKeyDetail('plan-review-dispositions', KEYS, value),
    );
  }
  return value as PlanReviewDispositionsEnvelope;
}

export function assertProviderProgressEnvelope(
  value: unknown,
): ProviderProgressEnvelope {
  const KEYS = [
    'schemaVersion',
    'kind',
    'investigationId',
    'changeId',
    'expectedRevision',
    'baseline',
    'intentDigest',
    'blindManifestDigest',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [...KEYS]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-progress' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    typeof value.intentDigest !== 'string' ||
    !DIGEST.test(value.intentDigest) ||
    typeof value.blindManifestDigest !== 'string' ||
    !DIGEST.test(value.blindManifestDigest)
  ) {
    throw proposeInputInvalid(
      envelopeKeyDetail('provider-progress', KEYS, value),
    );
  }
  return value as ProviderProgressEnvelope;
}

export function assertProviderRetryEnvelope(
  value: unknown,
): ProviderRetryEnvelope {
  const KEYS = [
    'schemaVersion',
    'kind',
    'investigationId',
    'changeId',
    'expectedRevision',
    'baseline',
    'intentDigest',
    'blindManifestDigest',
    'failedInvocation',
    'acknowledgeProviderCost',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      ...KEYS,
      ...('timeoutMs' in value ? ['timeoutMs'] : []),
      ...('retryExplanation' in value ? ['retryExplanation'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retry' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    typeof value.intentDigest !== 'string' ||
    !DIGEST.test(value.intentDigest) ||
    typeof value.blindManifestDigest !== 'string' ||
    !DIGEST.test(value.blindManifestDigest) ||
    !isRecord(value.failedInvocation) ||
    !hasExactKeys(value.failedInvocation, [
      'invocationId',
      'attempt',
      'revision',
      'requestDigest',
      'failureDigest',
    ]) ||
    typeof value.failedInvocation.invocationId !== 'string' ||
    !Number.isInteger(value.failedInvocation.attempt) ||
    (value.failedInvocation.attempt as number) < 1 ||
    !Number.isInteger(value.failedInvocation.revision) ||
    (value.failedInvocation.revision as number) < 0 ||
    typeof value.failedInvocation.requestDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.requestDigest) ||
    typeof value.failedInvocation.failureDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.failureDigest) ||
    value.acknowledgeProviderCost !== true
  ) {
    throw proposeInputInvalid(envelopeKeyDetail('provider-retry', KEYS, value));
  }
  assertRetryOptions(value);
  return value as ProviderRetryEnvelope;
}

export function assertPlanReviewRetryEnvelope(
  value: unknown,
): PlanReviewRetryEnvelope {
  const KEYS = [
    'schemaVersion',
    'kind',
    'investigationId',
    'changeId',
    'expectedRevision',
    'baseline',
    'subjectDigest',
    'planningGenerationId',
    'expectedReservationNodeId',
    'failedInvocation',
    'acknowledgeProviderCost',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      ...KEYS,
      ...('timeoutMs' in value ? ['timeoutMs'] : []),
      ...('retryExplanation' in value ? ['retryExplanation'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-retry' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    typeof value.subjectDigest !== 'string' ||
    !DIGEST.test(value.subjectDigest) ||
    typeof value.planningGenerationId !== 'string' ||
    !DIGEST.test(value.planningGenerationId) ||
    typeof value.expectedReservationNodeId !== 'string' ||
    !DIGEST.test(value.expectedReservationNodeId) ||
    !isRecord(value.failedInvocation) ||
    !hasExactKeys(value.failedInvocation, [
      'invocationId',
      'attempt',
      'revision',
      'requestDigest',
      'failureDigest',
    ]) ||
    typeof value.failedInvocation.invocationId !== 'string' ||
    !Number.isInteger(value.failedInvocation.attempt) ||
    (value.failedInvocation.attempt as number) < 1 ||
    !Number.isInteger(value.failedInvocation.revision) ||
    (value.failedInvocation.revision as number) < 0 ||
    typeof value.failedInvocation.requestDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.requestDigest) ||
    typeof value.failedInvocation.failureDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.failureDigest) ||
    value.acknowledgeProviderCost !== true
  ) {
    throw proposeInputInvalid(
      envelopeKeyDetail('plan-review-retry', KEYS, value),
    );
  }
  assertRetryOptions(value);
  return value as PlanReviewRetryEnvelope;
}

export function assertPlanningBinding(
  status: InvestigationStatus,
  input: PlanningContributionEnvelope,
): void {
  if (
    input.investigationId !== status.investigationId ||
    input.changeId !== status.changeId ||
    input.expectedRevision !== status.revision ||
    canonicalJson(input.baseline) !== canonicalJson(status.baseline) ||
    input.intentDigest !== status.intentDigest ||
    input.blindManifestDigest !== status.blindManifestDigest
  ) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Planning contribution is not bound to the current sealed investigation.',
      ExitCode.staleState,
    );
  }
}

export function assertProgressBinding(
  status: InvestigationStatus,
  input: ProviderProgressEnvelope,
): void {
  if (
    input.investigationId !== status.investigationId ||
    input.changeId !== status.changeId ||
    canonicalJson(input.baseline) !== canonicalJson(status.baseline) ||
    input.intentDigest !== status.intentDigest ||
    input.blindManifestDigest !== status.blindManifestDigest
  ) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Provider progress input is not bound to the current investigation.',
      ExitCode.staleState,
    );
  }
}

export function assertExemptionPlanningBinding(
  session: ProposeExemptionSession,
  input: ExemptionPlanningContributionEnvelope,
): void {
  if (
    input.investigationId !== session.investigationId ||
    input.changeId !== session.changeId ||
    input.expectedRevision !== session.revision ||
    canonicalJson(input.baseline) !== canonicalJson(session.baseline) ||
    input.intentDigest !== session.intentDigest ||
    input.applicabilityDigest !== session.applicability.applicabilityDigest
  ) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Planning contribution is not bound to the current structured investigation exemption.',
      ExitCode.staleState,
    );
  }
}

export function assertPlanningPayload(
  value: unknown,
): PlanningContributionPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'proposal',
      'design',
      'specs',
      'tasks',
      'guard',
      'executionTasks',
    ]) ||
    typeof value.proposal !== 'string' ||
    typeof value.design !== 'string' ||
    !Array.isArray(value.specs) ||
    typeof value.tasks !== 'string' ||
    !isRecord(value.guard) ||
    !isRecord(value.executionTasks)
  ) {
    throw planningContributionInvalid();
  }
  return {
    proposal: value.proposal,
    design: value.design,
    specs: assertSpecContributions(value.specs),
    tasks: value.tasks,
    guard: value.guard as GuardContract,
    executionTasks:
      value.executionTasks as PlanningContributionPayload['executionTasks'],
  };
}

export function assertSpecContributions(
  value: unknown,
): Array<{ path: string; content: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw planningContributionInvalid(
      'At least one delta specification is required.',
    );
  }
  const seen = new Set<string>();
  return value
    .map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ['path', 'content']) ||
        typeof entry.path !== 'string' ||
        typeof entry.content !== 'string' ||
        !/^specs\/[a-z0-9]+(?:-[a-z0-9]+)*\/spec\.md$/.test(entry.path) ||
        seen.has(entry.path)
      ) {
        throw planningContributionInvalid(
          'Delta specification paths or bytes are invalid.',
        );
      }
      seen.add(entry.path);
      return {
        path: entry.path,
        content: assertAuthoredMarkdown(entry.content, entry.path),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function assertAuthoredMarkdown(value: string, label: string): string {
  if (
    value.trim().length === 0 ||
    !value.endsWith('\n') ||
    value.includes('\r') ||
    Buffer.byteLength(value, 'utf8') > MAX_CALLER_JSON_BYTES
  ) {
    throw planningContributionInvalid(
      `Authored ${label} bytes are not valid LF-terminated Markdown.`,
    );
  }
  return value;
}

export function assertGuardContribution(
  value: unknown,
  changeId: string,
  taskIds: string[],
  knownChecks: string[],
): GuardContract {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'changeId', 'tasks']) ||
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    !isRecord(value.tasks)
  ) {
    throw planningContributionInvalid('Guard contribution is malformed.');
  }
  const result: GuardContract = {
    schemaVersion: 1,
    changeId,
    tasks: {},
  };
  if (
    canonicalJson(Object.keys(value.tasks).sort()) !==
    canonicalJson([...taskIds].sort())
  ) {
    throw planningContributionInvalid(
      'Guard tasks do not match authored tasks.',
    );
  }
  for (const taskId of taskIds) {
    const policy = value.tasks[taskId];
    if (
      !isRecord(policy) ||
      !hasExactKeys(policy, ['allowedPaths', 'requiredChecks']) ||
      !isStringArray(policy.allowedPaths) ||
      policy.allowedPaths.length === 0 ||
      !isStringArray(policy.requiredChecks) ||
      policy.requiredChecks.length === 0 ||
      new Set(policy.allowedPaths).size !== policy.allowedPaths.length ||
      new Set(policy.requiredChecks).size !== policy.requiredChecks.length ||
      policy.requiredChecks.some((checkId) => !knownChecks.includes(checkId))
    ) {
      throw planningContributionInvalid(
        `Guard policy for task ${taskId} is malformed.`,
      );
    }
    for (const allowedPath of policy.allowedPaths) {
      normalizePolicyPath(allowedPath);
    }
    result.tasks[taskId] = {
      allowedPaths: [...policy.allowedPaths],
      requiredChecks: [...policy.requiredChecks],
    };
  }
  return result;
}

export function isCanonicalSourceReferenceArray(
  value: unknown,
): value is `SRC-${string}`[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry, index): entry is `SRC-${string}` =>
        typeof entry === 'string' &&
        /^SRC-[0-9a-f]{64}$/.test(entry) &&
        (index === 0 || value[index - 1]!.localeCompare(entry) < 0),
    )
  );
}

export function isInvestigationExemptionRequest(
  value: ProposeStartInput,
): value is InvestigationExemptionRequest {
  return (
    isRecord(value) &&
    'kind' in value &&
    value.kind === 'investigation-exemption-request'
  );
}

export function assertBlindOutput(value: unknown): {
  reference: string;
  terms: Array<{
    kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
    value: string;
  }>;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reference', 'terms']) ||
    typeof value.reference !== 'string' ||
    value.reference.length === 0 ||
    !Array.isArray(value.terms)
  ) {
    throw workflowError(
      'PROVIDER_OUTPUT_INVALID',
      'Blind survey output is malformed.',
      ExitCode.staleState,
    );
  }
  const kinds = new Set([
    'literal-content',
    'literal-path',
    'symbol',
    'config-key',
  ]);
  const terms = value.terms.map((term) => {
    if (
      !isRecord(term) ||
      !hasExactKeys(term, ['kind', 'value']) ||
      typeof term.kind !== 'string' ||
      !kinds.has(term.kind) ||
      typeof term.value !== 'string' ||
      term.value.length === 0
    ) {
      throw workflowError(
        'PROVIDER_OUTPUT_INVALID',
        'Blind survey terms are malformed.',
        ExitCode.staleState,
      );
    }
    return term as {
      kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
      value: string;
    };
  });
  return { reference: value.reference, terms };
}

function assertRetryOptions(value: Record<string, unknown>): void {
  if (
    'timeoutMs' in value &&
    (!Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 ||
      (value.timeoutMs as number) > 3_600_000)
  )
    throw proposeInputInvalid();
  if ('retryExplanation' in value)
    parseProviderRetryExplanation(value.retryExplanation);
}

export function assertProposeInput(value: unknown): ProposeInput {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw proposeInputInvalid();
  }
  if (value.kind === 'planning-contribution') {
    return assertPlanningContributionEnvelope(value);
  }
  if (value.kind === 'exemption-planning-contribution') {
    return assertExemptionPlanningContributionEnvelope(value);
  }
  if (value.kind === 'scan-saturation-acceptance') {
    return assertInvestigationScanSaturationAcceptanceEnvelope(value);
  }
  if (value.kind === 'provider-progress') {
    return assertProviderProgressEnvelope(value);
  }
  if (value.kind === 'provider-retry') {
    return assertProviderRetryEnvelope(value);
  }
  if (value.kind === 'plan-review-retry') {
    return assertPlanReviewRetryEnvelope(value);
  }
  if (value.kind === 'plan-review-progress') {
    return assertPlanReviewProgressEnvelope(value);
  }
  if (value.kind === 'plan-review-dispositions') {
    return assertPlanReviewDispositionsEnvelope(value);
  }
  return assertInvestigationCheckpointEnvelope(value);
}

export function createScanSaturationAcceptanceEnvelope(
  output: ProposeOutput,
): InvestigationScanSaturationAcceptanceEnvelope {
  if (
    output.state !== 'scan-saturation-acceptance-required' ||
    !isRecord(output.inputSchema) ||
    output.inputSchema.kind !== 'scan-saturation-acceptance' ||
    !isRecord(output.inputSchema.binding) ||
    !Array.isArray(output.inputSchema.saturatedTermIds)
  ) {
    throw workflowError(
      'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_NOT_AVAILABLE',
      'The propose wrapper is not waiting for scan saturation acceptance.',
      ExitCode.guard,
    );
  }
  return assertInvestigationScanSaturationAcceptanceEnvelope({
    schemaVersion: 1,
    kind: 'scan-saturation-acceptance',
    ...output.inputSchema.binding,
    saturatedTermIds: output.inputSchema.saturatedTermIds,
    acknowledgeIncompleteScan: true,
  });
}
