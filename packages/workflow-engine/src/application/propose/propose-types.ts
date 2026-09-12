/**
 * Defines the shared request, result, and reconstructed-state contracts for propose.
 *
 * Invariants:
 * - Envelope discriminants, evidence bindings, and nullable states preserve their exact meaning.
 * - Public result shapes and internal review data remain compatible across propose modules.
 * - These declarations carry no runtime initialization or transition behavior.
 */

import type { ProviderRetryExplanation } from '../../modules/provider-orchestration/provider-retry-explanation.ts';
import { type AssuranceAssessmentReport } from '../../modules/assurance/assurance-assessment-chain.ts';
import { type GlobalPlanReviewCoverageRequirement } from '../../modules/assurance/plan-review-coverage.ts';
import { type PlanReviewDispositionSubmission } from '../../modules/assurance/plan-review.ts';
import type { PlanReviewSubject } from '../../modules/assurance/plan-review-subject.ts';
import type { PlanReviewTargetSnapshot } from '../../modules/assurance/plan-review-target-snapshot-record.ts';
import {
  type ConsumedPlanReviewReplayPort,
  type ConsumedRoleResultReplayPort,
  type InvestigationFirstPlanningSubject,
} from '../../modules/assurance/planning-assurance-validator.ts';
import { type RoleContextSharingGrantLifecyclePortV1 } from '../../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
import { type TaskMandateOptions } from '../../modules/authority/task-mandate-access-contract.ts';
import { type WorkflowPlanDigest } from '../../modules/guidance/renderers/plan-digest.ts';
import { type FloorOverflowDecision } from '../../modules/investigation/domain/floor-overflow-pruning.ts';
import {
  type InvestigationChangeClass,
  type InvestigationExemptionCategory,
  type InvestigationSemanticAuthor,
} from '../../modules/investigation/domain/investigation-applicability.ts';
import { type InvestigationDispositionDecision } from '../../modules/investigation/domain/investigation-domain.ts';
import { deriveEngineFloor } from '../../modules/investigation/domain/investigation-floor.ts';
import { type InvestigationFullBlobFact } from '../../modules/investigation/domain/investigation-full-blob.ts';
import {
  type InvestigationDispositionInput,
  type InvestigationGroupFacts,
  type ReviewedPathRelationship,
} from '../../modules/investigation/domain/investigation-groups.ts';
import { type InvestigationScanFacts } from '../../modules/investigation/domain/investigation-scan-facts.ts';
import {
  type InvestigationTermContribution,
  type InvestigationTermRawCounts,
  type PreviewInvestigationTerm,
} from '../../modules/investigation/domain/investigation-terms.ts';
import { type MaterializedEvidenceView } from '../../modules/investigation/manifest/investigation-materializer.ts';
import { buildInvestigationV3WhyAuthoring } from '../../modules/investigation/manifest/investigation-why-domain.ts';
import { type ActorSignal } from '../../modules/provider-orchestration/actor-identity.ts';
import { type ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import { type ProviderExecutionGrantAuthorization } from '../../modules/provider-orchestration/provider-retry-decision.ts';
import { type AdmittedRoleResult } from '../../modules/provider-orchestration/role-admission-contracts.ts';

import {
  type ProviderRoleAssignment,
  type RecordedRoleParticipant,
} from '../../modules/provider-orchestration/role-assignment.ts';
import {
  type RoleTopologyResolutionDependencyPortV1,
  type RoleTopologyResolutionV1,
} from '../../modules/provider-orchestration/role-topology-resolution.ts';
import { type ReuseCoverageRecord } from '../../modules/assurance/review-coverage.ts';

import { type ProposeGrantAuthorization } from './plan-review-contracts.ts';
import { type PlanningTransitionResult } from './planning-transition.ts';
import type {
  EvidenceNode,
  ExecutionArtifact,
  GuardContract,
  InvestigationCheckpointEnvelope,
  InvestigationScanSaturationAcceptanceEnvelope,
  InvestigationSession,
  InvestigationStatus,
  MaintainerSignerProvider,
  ProposeExemptionSession,
  ProposeRuntime,
  StoredInvestigationCheckpoint,
} from './propose-runtime.ts';
import type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
import type { PlanReviewManifest } from '../../modules/assurance/provider-review-manifests.ts';
import type { ProviderExecutionPolicySnapshotCurrent } from '../../modules/provider-orchestration/provider-execution-policy-snapshot.ts';
import type { ProviderRetryDecisionBinding } from '../../modules/provider-orchestration/provider-invocation-reservations.ts';

export type ProposeProviderDriver = (input: {
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'];
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
    consumedPlanReviewReplay?: ConsumedPlanReviewReplayPort;
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
  providerId: 'codex' | 'claude';
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
        providerId: 'codex' | 'claude';
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
    mutationPolicy: ReturnType<
      ProposeRuntime['workspace']['deriveReviewedMutationClassPolicy']
    >;
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
