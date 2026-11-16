/** Canonical planning task, execution and PlanReview artifact data; parsers and storage share these values. */
import type { EvidenceNode } from '@jigwright/core/evidence-node';
// Pure artifact parsing; repository and Manifest authority observations stay in contracts.ts.

export type TaskPolicy = {
  allowedPaths: string[];
  requiredChecks: string[];
  /** Optional repository-defined exclusive resources used by concurrent tasks. */
  exclusiveResources?: string[];
};

export type GuardContract = {
  schemaVersion: 1;
  changeId: string;
  tasks: Record<string, TaskPolicy>;
};

export type ParsedTask = {
  id: string;
  completed: boolean;
  title: string;
};

export type PlanReviewArtifact = {
  schemaVersion: 1;
  kind: 'plan-review-artifact';
  changeId: string;
  nodes: EvidenceNode[];
  currentRefs: Record<string, string>;
  roleResults?: unknown[];
};

type ExecutionCommon = {
  allowedPaths: string[];
  requiredChecks: string[];
  diffReview: 'required' | 'policy-required';
};

export type BehaviorContractRef = {
  specPath: string;
  requirement: string;
  scenario: string | null;
};

export type CrossAgentTddExecution = ExecutionCommon & {
  strategy: 'cross-agent-tdd';
  enforcement: 'planned';
  behaviorContractRefs: BehaviorContractRef[];
  testPathScopes: string[];
  fixturePathScopes: string[];
  implementationPathScopes: string[];
  redCheck: string;
  greenChecks: string[];
  requiredImplementerIndependence: 'session-independent';
};

export type TddSingleAgentExecution = ExecutionCommon & {
  strategy: 'tdd-single-agent';
  enforcement: 'planned';
  behaviorContractRefs: BehaviorContractRef[];
  testPathScopes: string[];
  fixturePathScopes: string[];
  implementationPathScopes: string[];
  redCheck: string;
  greenChecks: string[];
  requiredImplementerIndependence: 'none';
};

export type TransformationTerm = {
  kind: 'path' | 'content' | 'symbol' | 'config';
  value: string;
};

export type TransformationRetainedDisposition = {
  term: TransformationTerm;
  path: string;
  mutationClass: 'append-only' | 'immutable' | 'historical-reference';
  reason: string;
};

export type TransformationContract = {
  rule: string;
  examples: Array<{ before: string; after: string }>;
  fileScopes: string[];
  oldTerms: TransformationTerm[];
  replacementTerms: TransformationTerm[];
  retainedDispositions: TransformationRetainedDisposition[];
  redInapplicableReason: string;
};

export type MechanicalTransformExecution = ExecutionCommon & {
  strategy: 'mechanical-transform';
  enforcement: 'planned';
  transformationContract: TransformationContract;
};

export type DirectReviewedExecution = ExecutionCommon & {
  strategy: 'direct-reviewed';
  enforcement: 'available' | 'planned';
  exemptionKind:
    | 'documentation-only'
    | 'formatting-only'
    | 'dependency-only'
    | 'narrowly-scoped-non-behavioral';
  exemptionReason: string;
};

export type ExecutionTask =
  | CrossAgentTddExecution
  | TddSingleAgentExecution
  | MechanicalTransformExecution
  | DirectReviewedExecution;

export type ExecutionArtifact = {
  schemaVersion: 1;
  kind: 'execution-artifact';
  changeId: string;
  tasks: Record<string, ExecutionTask>;
};
