import type {
  OrdinaryProposeOutput,
  RebuiltInvestigation,
  ProposeOutput,
  ProposeWork,
  ProposePlanReviewStatus,
  PlanReviewReservation,
} from './propose-types.ts';
import type { EvidenceNode } from '@jigwright/core/evidence-node';
import {
  deriveClassGroupsWithContextFromFacts,
  type InvestigationDispositionInput,
} from '../investigation/domain/investigation-groups.ts';
import { reportProposeAssuranceAssessment } from './propose-investigation-projections.ts';
import {
  planClassSampleAudits,
  classSampleSeed,
} from '../investigation/domain/class-sample-audit.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import { isStringArray, isRecord, sha256 } from './propose-values.ts';
import type { PlanReviewGrantRequirement } from './plan-review-contracts.ts';
import {
  withEnvelopeTemplate,
  planReviewDispositionSchema,
  planReviewProgressSchema,
} from './propose-input.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { readPlanReviewNode } from '../assurance/plan-review.ts';

type InvestigationStatus = NonNullable<OrdinaryProposeOutput['investigation']>;

type WhyAnswersPayload = Extract<
  NonNullable<RebuiltInvestigation['reviewerPriorWhyAnswers']>['envelope'],
  { kind: 'why-answers' }
>['payload'];

export type MaterializedProposePresentation = Readonly<{
  status: NonNullable<ProposeOutput['investigation']>;
  actorResolution: ProposeOutput['actorResolution'];
  createdDate: string;
  work: ProposeWork;
  materializedArtifacts: Record<string, string>;
  planDigest: NonNullable<ProposeOutput['planDigest']>;
  semanticReuse: ProposeOutput['semanticReuse'];
  classSampleAudits: ProposeOutput['classSampleAudits'];
  floorTrimming: ProposeOutput['floorTrimming'];
}>;

type PlanReviewInvocationSnapshot = Readonly<
  Pick<ProposePlanReviewStatus, 'state' | 'failure'> & {
    invocationId: string;
    attempt: number;
    revision: number;
    requestDigest: string;
  }
>;

type TrackedPlanReviewSnapshot = Readonly<{
  reviewNode: EvidenceNode;
  dispositionNode: EvidenceNode | null;
}>;

export function workFromRebuilt(
  rebuilt: RebuiltInvestigation,
  authoredInstructions: ProposeWork['authoredInstructions'],
): ProposeWork {
  const domain = rebuilt.v3Domain;
  const reusableGroupIds = new Set(
    reviewerReusableGroupDispositions(rebuilt).map(({ groupId }) => groupId),
  );
  const reusableManifestEntryIds = new Set(
    reviewerReusableWhyAnswers(rebuilt).map(
      ({ manifestEntryId }) => manifestEntryId,
    ),
  );
  const classGroupsById = new Map(
    (domain === null
      ? []
      : deriveClassGroupsWithContextFromFacts({
          scanFacts: domain.scanFacts,
          groupFacts: domain.groupFacts,
        })
    ).map((group) => [group.groupId, group]),
  );
  return {
    termSources: rebuilt.termSources,
    assuranceAssessment:
      rebuilt.assuranceAssessmentNode === null
        ? null
        : reportProposeAssuranceAssessment(rebuilt.assuranceAssessmentNode),
    groups: (domain?.groupFacts.groups ?? [])
      .map((group) => {
        const withContext = classGroupsById.get(group.key);
        return {
          groupId: group.key,
          termId: group.selector.termId,
          paths: [
            ...new Set(
              group.hits
                .map(({ path: hitPath }) => hitPath.utf8)
                .filter((value): value is string => value !== null),
            ),
          ].sort(),
          hitIds: group.hitKeys,
          hits: (withContext?.hits ?? []).map((hit) => ({
            path: hit.path,
            // A hit the join could not place is reported as a path hit, which
            // is the reading that can claim the least.
            surface: hit.surface ?? 'path',
            window: hit.window?.utf8 ?? null,
            windowTruncated: hit.window?.truncated ?? false,
            matchOffset: hit.matchOffset,
            matchLength: hit.matchLength,
          })),
        };
      })
      .filter(({ groupId }) => !reusableGroupIds.has(groupId)),
    fullBlobManifest: rebuilt.fullBlobManifest
      .filter(
        ({ manifestEntryId }) => !reusableManifestEntryIds.has(manifestEntryId),
      )
      .map((entry) => ({
        manifestEntryId: entry.manifestEntryId,
        path: entry.path.utf8 ?? `base64:${entry.path.rawBase64}`,
        objectId: entry.blob.objectId,
        contentSha256: entry.blob.contentSha256,
      })),
    authoredInstructions,
  };
}

export function reviewerReusableGroupDispositions(
  rebuilt: RebuiltInvestigation,
): InvestigationDispositionInput[] {
  const checkpoint = rebuilt.reviewerPriorGroupDispositions?.envelope;
  if (checkpoint?.kind !== 'group-dispositions') {
    return [];
  }
  const currentGroupIds = new Set(
    rebuilt.v3Domain?.groupFacts.groups.map(({ key }) => key) ?? [],
  );
  return checkpoint.payload.dispositions.filter(({ groupId }) =>
    currentGroupIds.has(groupId),
  );
}

export function reviewerReusableWhyAnswers(
  rebuilt: RebuiltInvestigation,
): WhyAnswersPayload['answers'] {
  const checkpoint = rebuilt.reviewerPriorWhyAnswers?.envelope;
  if (checkpoint?.kind !== 'why-answers') {
    return [];
  }
  const currentEntryIds = new Set(
    rebuilt.fullBlobManifest.map(({ manifestEntryId }) => manifestEntryId),
  );
  return checkpoint.payload.answers.filter(({ manifestEntryId }) =>
    currentEntryIds.has(manifestEntryId),
  );
}

/** What each declared class still owes a hand reviewer, and what it has. */
export function classSampleAuditsFor(
  rebuilt: RebuiltInvestigation,
): ProposeOutput['classSampleAudits'] {
  const declared = storedDispositionClasses(rebuilt);
  if (declared.classes.length === 0) return [];
  return planClassSampleAudits(
    classSampleSeed(rebuilt.session.investigationId),
    declared.classes.map(({ classId, members }) => ({ classId, members })),
  ).map(({ classId, memberCount, sampled }) => ({
    classId,
    memberCount,
    sampled: [...sampled],
    answered: declared.audits
      .filter((audit) => audit.classId === classId)
      .map(({ groupId }) => groupId),
  }));
}

/** What the stored dispositions checkpoint declared, if it declared anything. */
export function storedDispositionClasses(rebuilt: RebuiltInvestigation): {
  classes: readonly { classId: string; members: readonly string[] }[];
  audits: readonly { classId: string; groupId: string }[];
} {
  const stored = rebuilt.session.milestones.groupDispositions?.envelope;
  if (stored === undefined || stored.kind !== 'group-dispositions') {
    return { classes: [], audits: [] };
  }
  return {
    classes: stored.payload.classes ?? [],
    audits: stored.payload.sampleAudits ?? [],
  };
}

export function scanSaturationRequirement(error: unknown): {
  saturatedTermIds: string[];
  floorTrimming: ProposeOutput['floorTrimming'];
} | null {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_REQUIRED'
  ) {
    return null;
  }
  const saturatedTermIds = error.details?.saturatedTermIds;
  const floorTrimming = error.details?.floorTrimming;
  if (
    !isStringArray(saturatedTermIds) ||
    saturatedTermIds.length < 1 ||
    !isRecord(floorTrimming) ||
    !isStringArray(floorTrimming.dropped) ||
    typeof floorTrimming.escalated !== 'boolean'
  ) {
    throw error;
  }
  return {
    saturatedTermIds,
    floorTrimming: {
      dropped: floorTrimming.dropped,
      escalated: floorTrimming.escalated,
    },
  };
}

export function renderPlanReviewRequirementOutput(
  presentation: MaterializedProposePresentation,
  grantRequirement: PlanReviewGrantRequirement | null,
): ProposeOutput {
  const {
    status,
    actorResolution,
    createdDate,
    work,
    materializedArtifacts,
    planDigest,
    semanticReuse,
    classSampleAudits,
    floorTrimming,
  } = presentation;
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: status.changeId,
    state:
      grantRequirement === null
        ? 'plan-review-required'
        : 'human-action-required',
    nextAction:
      grantRequirement === null ? 'obtain-plan-review' : 'human-action',
    investigation: status,
    createdDate,
    actorResolution,
    inputSchema:
      grantRequirement === null
        ? null
        : grantRequirement.kind === 'collaboration'
          ? {
              schemaVersion: 1,
              kind: 'collaboration-grant-selection',
              lifecyclePhase: 'plan-review',
              conflictingRole: 'plan-reviewer',
              subjectDigest: grantRequirement.requirement.subject.subjectDigest,
              grantRequest: grantRequirement.requirement.grantRequest,
              allowedDegradedForms:
                grantRequirement.requirement.grantRequest === null
                  ? ['caller-supplied', 'direct-human-review']
                  : ['same-provider-fresh-session'],
              resumeOption: '--grant <grant-id>',
            }
          : {
              schemaVersion: 3,
              kind: 'role-context-sharing-grant-required',
              authorizedEffect: 'role-context-sharing-degradation',
              lifecyclePhase: 'plan-review',
              requirementNodeId: grantRequirement.requirementNodeId,
              subjectDigest: grantRequirement.requirement.subject.subjectDigest,
              exactRolePairs:
                grantRequirement.requirement.roleTopology.exactGrantRolePairs,
              grantReferences: grantRequirement.requirement.grantReferences,
              reviewerPlacement: grantRequirement.requirement.reviewerPlacement,
              executionBinding: {
                contextGeneration:
                  grantRequirement.requirement.contextGeneration,
                sessionGeneration:
                  grantRequirement.requirement.sessionGeneration,
                sharedEngineSessionId:
                  grantRequirement.requirement.sharedEngineSessionId,
                providerDefinitionDigest:
                  grantRequirement.requirement.providerDefinitionDigest,
              },
              binding: {
                centralRoleConfigurationDigest:
                  grantRequirement.requirement.roleTopology
                    .centralRoleConfigurationDigest,
                changeOverrideDigest:
                  grantRequirement.requirement.roleTopology
                    .changeOverrideDigest,
                providerRegistryDigest:
                  grantRequirement.requirement.roleTopology
                    .providerRegistryDigest,
                eligibilityPolicyDigest:
                  grantRequirement.requirement.roleTopology
                    .eligibilityPolicyDigest,
                planningGeneration:
                  grantRequirement.requirement.roleTopology.planningGeneration,
              },
              authorityAvailable: true,
              resumeOption: '--role-context-grant <grant-id>',
            },
    work,
    materializedArtifacts,
    planDigest,
    planReview: null,
    planningTransition: null,
    semanticReuse,
    classSampleAudits,
    floorTrimming,
  };
}

export function renderPlanReviewProgressOutput(
  presentation: MaterializedProposePresentation,
  reservation: PlanReviewReservation,
  invocation: PlanReviewInvocationSnapshot,
  trackedReview: TrackedPlanReviewSnapshot | null,
): ProposeOutput {
  const {
    status,
    actorResolution,
    createdDate,
    work,
    materializedArtifacts,
    planDigest,
    semanticReuse,
    classSampleAudits,
    floorTrimming,
  } = presentation;
  const planReview: ProposePlanReviewStatus = {
    subjectDigest: reservation.subject.subjectDigest,
    planningGenerationId: reservation.subject.planningGenerationId,
    invocationId: reservation.request.invocationId,
    requestDigest: reservation.request.requestDigest,
    providerId: reservation.request.providerId,
    state: invocation.state,
    failure: invocation.failure,
    reviewNodeId: trackedReview?.reviewNode.nodeId ?? null,
    reviewResultDigest: trackedReview?.reviewNode.resultDigest ?? null,
  };
  if (invocation.state === 'failed') {
    const retryable = invocation.failure?.kind === 'retryable';
    return {
      schemaVersion: 1,
      kind: 'workflow-propose',
      changeId: status.changeId,
      state: retryable ? 'waiting-for-plan-review' : 'human-action-required',
      nextAction: retryable ? 'retry-plan-review' : 'human-action',
      investigation: status,
      createdDate,
      actorResolution,
      inputSchema: retryable
        ? withEnvelopeTemplate({
            schemaVersion: 1,
            kind: 'plan-review-retry',
            binding: {
              investigationId: status.investigationId,
              changeId: status.changeId,
              expectedRevision: status.revision,
              baseline: status.baseline,
              subjectDigest: reservation.subject.subjectDigest,
              planningGenerationId: reservation.subject.planningGenerationId,
              expectedReservationNodeId: reservation.reservationNode.nodeId,
              failedInvocation: {
                invocationId: invocation.invocationId,
                attempt: invocation.attempt,
                revision: invocation.revision,
                requestDigest: invocation.requestDigest,
                failureDigest: sha256(canonicalJson(invocation.failure)),
              },
            },
            requiredAcknowledgement: {
              acknowledgeProviderCost: true,
            },
          })
        : null,
      work,
      materializedArtifacts,
      planDigest,
      planReview,
      planningTransition: null,
      semanticReuse,
      classSampleAudits,
      floorTrimming,
    };
  }
  if (trackedReview !== null) {
    const review = readPlanReviewNode(trackedReview.reviewNode);
    if (review.findings.length > 0 && trackedReview.dispositionNode === null) {
      return {
        schemaVersion: 1,
        kind: 'workflow-propose',
        changeId: status.changeId,
        state: 'awaiting-challenge-dispositions',
        nextAction: 'submit-challenge-dispositions',
        investigation: status,
        createdDate,
        actorResolution,
        inputSchema: planReviewDispositionSchema(status, review),
        work,
        materializedArtifacts,
        planDigest,
        planReview,
        planningTransition: null,
        semanticReuse: null,
        classSampleAudits: [],
        floorTrimming,
      };
    }
  }
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: status.changeId,
    state: 'waiting-for-plan-review',
    nextAction:
      invocation.state === 'succeeded'
        ? 'resume-plan-review'
        : 'wait-for-plan-review',
    investigation: status,
    createdDate,
    actorResolution,
    inputSchema: planReviewProgressSchema(status, reservation),
    work,
    materializedArtifacts,
    planDigest,
    planReview,
    planningTransition: null,
    semanticReuse: null,
    classSampleAudits: [],
    floorTrimming,
  };
}

export function renderScanSaturationOutput(
  status: InvestigationStatus,
  actorResolution: ProposeOutput['actorResolution'],
  createdDate: string,
  requirement: NonNullable<ReturnType<typeof scanSaturationRequirement>>,
): ProposeOutput {
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: status.changeId,
    state: 'scan-saturation-acceptance-required',
    nextAction: 'accept-scan-saturation',
    investigation: status,
    createdDate,
    actorResolution,
    inputSchema: {
      schemaVersion: 1,
      kind: 'scan-saturation-acceptance',
      binding: {
        investigationId: status.investigationId,
        changeId: status.changeId,
        expectedRevision: status.revision,
        baseline: status.baseline,
        intentDigest: status.intentDigest,
        blindManifestDigest: status.blindManifestDigest,
      },
      saturatedTermIds: requirement.saturatedTermIds,
      requiredAcknowledgement: { acknowledgeIncompleteScan: true },
    },
    work: null,
    materializedArtifacts: null,
    planReview: null,
    planningTransition: null,
    semanticReuse: null,
    classSampleAudits: [],
    floorTrimming: requirement.floorTrimming,
  };
}
