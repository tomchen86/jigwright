/** Canonical proposal requests, results and reconstructed planning state. */
import type { ProviderRetryExplanation } from '../provider-orchestration/provider-retry-explanation.ts';
import type { ProviderId } from '../provider-orchestration/provider-registry.ts';
import type { AssuranceAssessmentReport } from '../assurance/assurance-assessment-chain.ts';
import type { GlobalPlanReviewCoverageRequirement } from '../assurance/plan-review-coverage.ts';
import type { PlanReviewDispositionSubmission } from '../assurance/plan-review.ts';
import type { PlanReviewSubject } from '../assurance/plan-review-subject.ts';
import type { PlanReviewTargetSnapshot } from '../assurance/plan-review-target-snapshot-record.ts';
import type { InvestigationFirstPlanningSubject } from '../assurance/planning-assurance-validator.ts';
import type { RoleContextSharingGrantLifecyclePortV1 } from '../authority/role-context-sharing-grant-lifecycle-port.ts';
import type { TaskMandateOptions } from '../authority/task-mandate-access-contract.ts';
import type { WorkflowPlanDigest } from '../guidance/renderers/plan-digest.ts';
import type { FloorOverflowDecision } from '../investigation/domain/floor-overflow-pruning.ts';
import type {
  InvestigationChangeClass,
  InvestigationExemptionCategory,
  InvestigationSemanticAuthor,
} from '../investigation/domain/investigation-applicability.ts';
import type { InvestigationDispositionDecision } from '../investigation/domain/investigation-domain.ts';
import { deriveEngineFloor } from '../investigation/domain/investigation-floor.ts';
import type { InvestigationFullBlobFact } from '../investigation/domain/investigation-full-blob.ts';
import type {
  InvestigationDispositionInput,
  InvestigationGroupFacts,
  ReviewedPathRelationship,
} from '../investigation/domain/investigation-groups.ts';
import type { InvestigationScanFacts } from '../investigation/domain/investigation-scan-facts.ts';
import type {
  InvestigationTermContribution,
  InvestigationTermRawCounts,
  PreviewInvestigationTerm,
} from '../investigation/domain/investigation-terms.ts';
import type { MaterializedEvidenceView } from '../investigation/manifest/investigation-materializer.ts';
import { buildInvestigationV3WhyAuthoring } from '../investigation/manifest/investigation-why-domain.ts';
import type { ActorSignal } from '../authority/actor-identity.ts';
import type { ProviderInvocationRequest } from '../provider-orchestration/provider-contracts.ts';
import type { ProviderExecutionGrantAuthorization } from '../provider-orchestration/provider-retry-decision.ts';
import type {
  AdmittedRoleResult,
  ConsumedRoleReplayPort,
  ConsumedRoleResultReplayPort,
} from '../provider-orchestration/role-admission-contracts.ts';
import type {
  ProviderRoleAssignment,
  RecordedRoleParticipant,
} from '../provider-orchestration/role-assignment.ts';
import type {
  RoleTopologyResolutionDependencyPortV1,
  RoleTopologyResolutionV1,
} from '../provider-orchestration/role-topology-resolution.ts';
import type { ReuseCoverageRecord } from '../assurance/review-coverage.ts';
import type { PlanningTransitionResult } from '../lifecycle/planning-transition-result.ts';
import type { EvidenceNode } from '@jigwright/core/evidence-node';
import type {
  ExecutionArtifact,
  GuardContract,
} from '../planning-provider/planning-artifact-types.ts';
import type {
  InvestigationCheckpointEnvelope,
  InvestigationScanSaturationAcceptanceEnvelope,
  InvestigationSession,
  StoredInvestigationCheckpoint,
} from '../investigation/domain/investigation-session-types.ts';
import type { InvestigationStatus } from '../lifecycle/investigation-status.ts';
import type { MaintainerSignerProvider } from '../authority/maintainer-signer-port.ts';
import type { ProposeExemptionSession } from '../lifecycle/propose-exemption-session.ts';
import type { NormalizedChangeIntent } from '../source/change-intent.ts';
import type { MutationClassPolicy } from '../source/mutation-class-policy.ts';
import type { PlanReviewManifest } from '../assurance/provider-review-manifests.ts';
import type { ProviderExecutionPolicySnapshotCurrent } from '../provider-orchestration/provider-execution-policy-snapshot.ts';
import type { ProviderRetryDecisionBinding } from '../provider-orchestration/provider-invocation-reservations.ts';
import type { CollaborationGrantExpectedBinding } from '../authority/collaboration-grant-codec.ts';
import type { RoleContextSharingPlanReviewAuthorizationV1 } from './role-context-sharing-plan-review.ts';
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
export type ProposeProviderDriver = (input: {
  paths: InvestigationRuntimePaths;
  request: ProviderInvocationRequest;
}) => void;

export type ProposeProviderDispatcher = (
  cwd: string,
  invocationId: string,
) => unknown;

export type ProposeOptions = {
  explicitActor?: string;
  environment?: Record<string, string | undefined>;
  providerDriver?: ProposeProviderDriver;
  providerDispatcher?: ProposeProviderDispatcher;
  taskMandateId?: string;
  taskMandateValidation?: TaskMandateOptions;
  immediateSource?: Readonly<{
    sourceId: `SRC-${string}`;
    exactText: string;
  }>;
  roleTopologyResolution?: RoleTopologyResolutionDependencyPortV1;
  collaborationGrant?: {
    grantId: string;
    now?: Date;
    verifier?: unknown;
  };
};

export type ProposeResumeOptions = {
  providerDispatcher?: ProposeProviderDispatcher;
  providerDriver?: ProposeProviderDriver;
  roleTopologyResolution?: RoleTopologyResolutionDependencyPortV1;
  collaborationGrant?: {
    grantId: string;
    now?: Date;
    verifier?: unknown;
  };
  roleContextSharingGrant?: {
    grantId: string;
    now?: Date;
    verifier?: unknown;
    lifecycle: RoleContextSharingGrantLifecyclePortV1;
  };
  collaborationGrantValidation?: {
    now?: Date;
    verifier?: unknown;
    consumedRoleResultReplay?: ConsumedRoleResultReplayPort;
    consumedPlanReviewReplay?: ConsumedRoleReplayPort;
  };
  executionGrantAuthorization?: ProviderExecutionGrantAuthorization & {
    replacementRequest: ProviderInvocationRequest;
  };
  challengeDispositionAuthority?: {
    now?: Date;
    role?: 'reviewer' | 'domain-owner';
    signer?: MaintainerSignerProvider;
  };
  /**
   * Test-only crash injection: invoked immediately after a PlanReview retry
   * publishes its replacement reservation and before the invocation record is
   * created, which is the exact window the WAL republication must be able to
   * traverse.
   */
  simulateCrashAfterPlanReviewReplacementReservation?: () => void;
};

export type PlanReviewProgressEnvelope = {
  schemaVersion: 1;
  kind: 'plan-review-progress';
  investigationId: string;
  changeId: string;
  subjectDigest: string;
  invocationId: string;
  requestDigest: string;
};

export type PlanReviewRetryEnvelope = {
  timeoutMs?: number;
  retryExplanation?: ProviderRetryExplanation;
  schemaVersion: 1;
  kind: 'plan-review-retry';
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  subjectDigest: string;
  planningGenerationId: string;
  expectedReservationNodeId: string;
  failedInvocation: {
    invocationId: string;
    attempt: number;
    revision: number;
    requestDigest: string;
    failureDigest: string;
  };
  acknowledgeProviderCost: true;
};

export type PlanReviewDispositionsEnvelope = {
  schemaVersion: 1;
  kind: 'plan-review-dispositions';
  investigationId: string;
  changeId: string;
  subjectDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
  dispositions: PlanReviewDispositionSubmission[];
};

export type PlanningContributionPayload = {
  proposal: string;
  design: string;
  specs: Array<{ path: string; content: string }>;
  tasks: string;
  guard: GuardContract;
  executionTasks: ExecutionArtifact['tasks'];
};

export type PlanningContributionEnvelope = {
  schemaVersion: 1;
  kind: 'planning-contribution';
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  payload: PlanningContributionPayload;
};

export type ExemptionPlanningContributionEnvelope = {
  schemaVersion: 1;
  kind: 'exemption-planning-contribution';
  investigationId: string;
  changeId: string;
  expectedRevision: 0;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  applicabilityDigest: string;
  payload: PlanningContributionPayload;
};

export type InvestigationExemptionRequest = {
  schemaVersion: 1;
  kind: 'investigation-exemption-request';
  intent: NormalizedChangeIntent;
  exemption: {
    category: InvestigationExemptionCategory;
    declaredPaths: string[];
    declaredChangeClasses: InvestigationChangeClass[];
    rationale: string;
    semanticAuthor: InvestigationSemanticAuthor;
    nonTrivialBehaviorReliance: 'none-declared';
    researchBudgetMinutes: number | null;
  };
};

export type ProposeStartInput =
  NormalizedChangeIntent | InvestigationExemptionRequest;

export type ProviderProgressEnvelope = {
  schemaVersion: 1;
  kind: 'provider-progress';
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
};

export type ProviderRetryEnvelope = {
  timeoutMs?: number;
  retryExplanation?: ProviderRetryExplanation;
  schemaVersion: 1;
  kind: 'provider-retry';
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  failedInvocation: {
    invocationId: string;
    attempt: number;
    revision: number;
    requestDigest: string;
    failureDigest: string;
  };
  acknowledgeProviderCost: true;
};

export type ProposeInput =
  | InvestigationCheckpointEnvelope
  | InvestigationScanSaturationAcceptanceEnvelope
  | PlanningContributionEnvelope
  | ExemptionPlanningContributionEnvelope
  | ProviderProgressEnvelope
  | ProviderRetryEnvelope
  | PlanReviewRetryEnvelope
  | PlanReviewProgressEnvelope
  | PlanReviewDispositionsEnvelope;

export type ProposePlanReviewStatus = {
  subjectDigest: string;
  planningGenerationId: string;
  invocationId: string;
  requestDigest: string;
  providerId: ProviderId;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  failure: { kind: string; code: string; message: string } | null;
  reviewNodeId: string | null;
  reviewResultDigest: string | null;
};

export type ProposeGroupWork = {
  groupId: string;
  termId: string;
  paths: string[];
  hitIds: string[];
  /**
   * What each hit looks like where it landed. An author writing a class
   * predicate is claiming something about this text, so withholding it would
   * leave them guessing at the evidence their claim is checked against.
   */
  hits: Array<{
    path: string;
    surface: 'path' | 'content';
    window: string | null;
    windowTruncated: boolean;
    matchOffset: number;
    matchLength: number;
  }>;
};

export type ProposeFullBlobWork = {
  manifestEntryId: string;
  path: string;
  objectId: string;
  contentSha256: string;
};

export type ProposeAssuranceAssessment = AssuranceAssessmentReport & {
  nodeId: string;
  resultDigest: string;
  policyDigest: string;
};

export type ProposeWork = {
  termSources: InvestigationTermRawCounts;
  assuranceAssessment?: ProposeAssuranceAssessment | null;
  groups: ProposeGroupWork[];
  fullBlobManifest: ProposeFullBlobWork[];
  authoredInstructions: Array<{
    artifactId: string;
    outputPath: string;
    instruction: string;
    template: string;
  }>;
};

export type ProposeOutput = {
  schemaVersion: 1;
  kind: 'workflow-propose';
  changeId: string;
  state:
    | InvestigationStatus['state']
    | 'actor-resolution-required'
    | 'awaiting-planning-contribution'
    | 'scan-saturation-acceptance-required'
    | 'plan-review-required'
    | 'waiting-for-plan-review'
    | 'awaiting-challenge-dispositions'
    | 'revision-plan-reviewed'
    | 'planning-complete'
    | 'human-action-required';
  nextAction:
    | InvestigationStatus['nextAction']
    | 'submit-planning-contribution'
    | 'accept-scan-saturation'
    | 'obtain-plan-review'
    | 'wait-for-plan-review'
    | 'retry-plan-review'
    | 'resume-plan-review'
    | 'submit-challenge-dispositions'
    | 'resume-task'
    | 'planning-complete'
    | 'human-action';
  investigation: InvestigationStatus | ProposeExemptionSession | null;
  createdDate: string;
  actorResolution:
    | {
        outcome: 'resolved';
        providerId: ProviderId;
        assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
        signals: ActorSignal[];
      }
    | {
        outcome: 'actor-resolution-required';
        code: 'ACTOR_IDENTITY_REQUIRED' | 'ACTOR_IDENTITY_CONFLICT';
        signals: ActorSignal[];
      }
    | null;
  inputSchema: Record<string, unknown> | null;
  work: ProposeWork | null;
  materializedArtifacts: Record<string, string> | null;
  /**
   * A deterministic one-screen projection of the exact authored plan and its
   * investigation WHY rows. It appears as soon as planning artifacts have
   * materialized and is never accepted as caller-authored authority.
   */
  planDigest?: WorkflowPlanDigest;
  planReview: ProposePlanReviewStatus | null;
  planningTransition: PlanningTransitionResult | null;
  /**
   * What the semantic ledger carried for this propose, and what a reviewer is
   * owed as a result. Reported rather than enforced: the review policy decides
   * nothing from it yet, but a saving nobody can see is a saving nobody can
   * check, and this is the surface that makes it visible.
   */
  semanticReuse: ReuseCoverageRecord | null;
  /**
   * The members of each declared class that must be reviewed by hand before
   * the plan may commit. An author cannot answer a sample they cannot see, and
   * the draw is fixed before the classes exist, so showing it gives nothing
   * away.
   */
  classSampleAudits: Array<{
    classId: string;
    memberCount: number;
    sampled: string[];
    answered: string[];
  }>;
  /**
   * Floor terms the engine had to drop to stay within what a scan may carry,
   * named rather than counted. A floor that had to be cut is exactly the
   * situation a person should be told about, so this is never silent.
   */
  floorTrimming: { dropped: string[]; escalated: boolean };
};

export type OrdinaryProposeOutput = Omit<ProposeOutput, 'investigation'> & {
  investigation: InvestigationStatus | null;
};

export type ExemptionProposeOutput = Omit<ProposeOutput, 'investigation'> & {
  investigation: ProposeExemptionSession | null;
};

export type RebuiltInvestigation = {
  session: InvestigationSession;
  intent: NormalizedChangeIntent;
  floor: ReturnType<typeof deriveEngineFloor>;
  floorTrimming: { dropped: string[]; escalated: boolean };
  floorOverflowDecision: FloorOverflowDecision | null;
  floorOverflowDecisionNode: EvidenceNode | null;
  termSources: InvestigationTermRawCounts;
  authorizationNode: EvidenceNode;
  providerResultNode: EvidenceNode | null;
  providerRoleResult: AdmittedRoleResult | null;
  reviewerTermSourceNode: EvidenceNode | null;
  reviewerTermSourceNodeIds: string[];
  reviewerTermEvidenceNodes: EvidenceNode[];
  reviewerTermReopenCount: number;
  reviewerTerms: ReviewerTermSourceRecord['terms'];
  reviewerRoleResult: AdmittedRoleResult | null;
  reviewerPriorGroupDispositions: StoredInvestigationCheckpoint | null;
  reviewerPriorWhyAnswers: StoredInvestigationCheckpoint | null;
  contributionNodes: EvidenceNode[];
  termUnionNode: EvidenceNode | null;
  saturatedTermIds: string[];
  assuranceAssessmentNode: EvidenceNode | null;
  planReviewCoverage: GlobalPlanReviewCoverageRequirement | null;
  /** Every load-bearing row, including rows carried by the semantic ledger. */
  completeFullBlobManifest: InvestigationFullBlobFact[];
  fullBlobManifest: InvestigationFullBlobFact[];
  /**
   * What the ledger carried and why. Present so the reduced WHY manifest is
   * inspectable rather than merely smaller.
   */
  reuseCoverage: ReuseCoverageRecord;
  whyAuthoring: ReturnType<typeof buildInvestigationV3WhyAuthoring> | null;
  /** Common raw/domain inputs retained only in memory for direct v3 authoring. */
  v3Domain: {
    termContributions: InvestigationTermContribution[];
    canonicalTerms: PreviewInvestigationTerm[];
    scanFacts: InvestigationScanFacts;
    groupFacts: InvestigationGroupFacts;
    mutationPolicy: MutationClassPolicy;
    reviewedRelationships: ReviewedPathRelationship[];
    dispositionInputs: InvestigationDispositionInput[];
    dispositionDecisions: InvestigationDispositionDecision[];
    evidenceView: MaterializedEvidenceView | null;
  } | null;
};

export type ProposeLifecycleStatus =
  InvestigationStatus | ProposeExemptionSession;

export type CollaborationGrantAccessMode = 'consume' | 'replay-consumed';

export type ReviewerTermSourceRecord = {
  sourceNode: EvidenceNode;
  providerResultNode: EvidenceNode;
  reviewNode: EvidenceNode;
  targetSnapshotNode: EvidenceNode | null;
  evidenceNodes: EvidenceNode[];
  roleResult: AdmittedRoleResult;
  priorGroupDispositions: StoredInvestigationCheckpoint;
  priorWhyAnswers: StoredInvestigationCheckpoint;
  sourceNodeIds: string[];
  reopenCount: number;
  terms: Array<{
    kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
    value: string;
  }>;
};

export type ReviewerReconciliationMaterializationReceipt = {
  nodeId: string;
  node: EvidenceNode;
  matchesCurrentSession: boolean;
  artifacts: Record<string, string>;
};

export type PlanReviewReservation = {
  reservationNode: EvidenceNode;
  planning: InvestigationFirstPlanningSubject;
  subject: PlanReviewSubject;
  assignment: ProviderRoleAssignment;
  author: RecordedRoleParticipant;
  materializationNode: EvidenceNode;
  targetSnapshotNode: EvidenceNode;
  manifest: PlanReviewManifest & {
    planningTarget: PlanReviewTargetSnapshot;
  };
  request: ProviderInvocationRequest;
  grantAuthorization: ProposeGrantAuthorization | null;
  roleTopology: RoleTopologyResolutionV1 | null;
  retry: {
    attempt: number;
    previousReservationNodeId: string;
    failedInvocation: PlanReviewRetryEnvelope['failedInvocation'];
    retryDecision: ProviderRetryDecisionBinding;
    executionPolicySnapshot: ProviderExecutionPolicySnapshotCurrent;
  } | null;
};

export type ProposeGrantAuthorization =
  | {
      grantId: string;
      transitionDigest: string;
      expectedBinding: CollaborationGrantExpectedBinding;
    }
  | RoleContextSharingPlanReviewAuthorizationV1;
