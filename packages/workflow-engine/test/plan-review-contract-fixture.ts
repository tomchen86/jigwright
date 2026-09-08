/** Shared plan-review fixtures; this module registers no tests. */
import crypto from 'node:crypto';
import path from 'node:path';
import {
  createEvidenceNode,
  type EvidenceNode,
} from '../src/adapters/planning/investigation/evidence-node.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { type PlanReviewTermProjection } from '../src/modules/projection/investigation-term-projection.ts';
import {
  createPlanReviewDispositionNode,
  createPlanReviewProviderResultNode,
  createPlanReviewTargetSnapshotNode,
  createPlanReviewSubject,
  PLAN_REVIEW_COVERAGE,
  planReviewProviderSubmission,
  readPlanReviewTargetSnapshotNode,
  readPlanReviewNode,
  type PlanReviewSubmission,
} from '../src/modules/assurance/plan-review.ts';
import {
  createPlanTarget,
  type PlanTarget,
  type PlanTargetInput,
} from '../src/modules/assurance/plan-target.ts';
import {
  createPlanningGeneration,
  type PlanningGeneration,
} from '../src/modules/lifecycle/planning-generation.ts';
import {
  admitRoleResult,
  type RoleAssignment,
} from '../src/modules/provider-orchestration/role-scheduler.ts';
import type {
  ProviderInvocationRequest,
  ProviderProcessResult,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { createCurrentPlanReviewProviderEvidenceForTest } from './fixture.ts';

export const DIGESTS = {
  schema: '1'.repeat(64),
  structured: '2'.repeat(64),
  ledgerRenderer: '3'.repeat(64),
  whyNode: '4'.repeat(64),
  whyResult: '5'.repeat(64),
  workflowPolicy: '6'.repeat(64),
  canonicalizerPolicy: '7'.repeat(64),
  rendererPolicy: '8'.repeat(64),
  reviewPolicy: '9'.repeat(64),
  investigationNode: 'a'.repeat(64),
  investigationResult: 'b'.repeat(64),
} as const;

export const providerResultsById = new Map<string, EvidenceNode>();

export const targetSnapshotsById = new Map<string, EvidenceNode>();

export function planTargetInput(): PlanTargetInput {
  return {
    schemaVersion: 1,
    changeId: 'demo-change',
    schemaName: 'expense-app-v2',
    components: [
      {
        kind: 'structured-json',
        role: 'schema-metadata',
        path: 'openspec/changes/demo-change/.openspec.yaml',
        schemaDigest: DIGESTS.schema,
        value: { schema: 'expense-app-v2', created: '2026-07-15' },
      },
      {
        kind: 'authored-markdown',
        role: 'proposal',
        path: 'openspec/changes/demo-change/proposal.md',
        content: '# Proposal\n\nPreserve the behavior.\n',
      },
      {
        kind: 'mixed-markdown',
        role: 'design',
        path: 'openspec/changes/demo-change/design.md',
        authoredRegions: [
          '# Design\n\n',
          '\n## Decisions\n\nKeep invariants.\n',
        ],
        managedProjection: {
          renderer: 'investigation-ledger.v1',
          rendererDigest: DIGESTS.ledgerRenderer,
          sourceNodes: [
            { nodeId: DIGESTS.whyNode, resultDigest: DIGESTS.whyResult },
          ],
        },
      },
      {
        kind: 'authored-markdown',
        role: 'delta-spec',
        path: 'openspec/changes/demo-change/specs/demo/spec.md',
        content:
          '### Requirement: Demo\n\nThe system SHALL work.\n\n#### Scenario: Works\n\n- **THEN** it works\n',
      },
      {
        kind: 'tasks-markdown',
        role: 'tasks',
        path: 'openspec/changes/demo-change/tasks.md',
        content: '# Tasks\n\n## Work\n\n- [ ] 1.1 Implement behavior\n',
      },
      {
        kind: 'structured-json',
        role: 'guard',
        path: 'openspec/changes/demo-change/guard.json',
        schemaDigest: DIGESTS.structured,
        value: {
          schemaVersion: 1,
          changeId: 'demo-change',
          tasks: {
            '1.1': {
              allowedPaths: ['src/**'],
              requiredChecks: ['fixture'],
            },
          },
        },
      },
      {
        kind: 'structured-json',
        role: 'execution',
        path: 'openspec/changes/demo-change/execution.json',
        schemaDigest: DIGESTS.structured,
        value: { schemaVersion: 1, kind: 'execution-artifact', tasks: {} },
      },
      {
        kind: 'structured-json',
        role: 'investigation',
        path: 'openspec/changes/demo-change/investigation.json',
        schemaDigest: DIGESTS.structured,
        value: {
          schemaVersion: 1,
          kind: 'investigation-artifact',
          currentRefs: { sealedInvestigation: DIGESTS.investigationNode },
        },
      },
      {
        kind: 'requirement-clause',
        role: 'requirement-clause',
        path: 'openspec/changes/demo-change/specs/demo/spec.md',
        requirement: 'Demo',
        scenario: 'Works',
        content:
          '### Requirement: Demo\n\nThe system SHALL work.\n\n#### Scenario: Works\n\n- **THEN** it works\n',
      },
      {
        kind: 'policy',
        role: 'policy',
        path: 'workflow/review-policy',
        name: 'review-policy',
        version: 1,
        digest: DIGESTS.reviewPolicy,
      },
    ],
  };
}

export function generationInput(target: PlanTarget) {
  return {
    schemaVersion: 1 as const,
    target,
    manifestDigest: 'c'.repeat(64),
    investigationTargetDigest: 'd'.repeat(64),
    investigationBaseline: {
      head: '1'.repeat(40),
      tree: '2'.repeat(40),
    },
    investigationDependencies: [
      {
        role: 'reviewer-pre-anchor',
        nodeId: DIGESTS.investigationNode,
        resultDigest: DIGESTS.investigationResult,
      },
      {
        role: 'why-ledger',
        nodeId: DIGESTS.whyNode,
        resultDigest: DIGESTS.whyResult,
      },
    ],
    investigationRequirements: [
      {
        requirementId: 'preserve-demo-contract',
        text: 'Preserve the demo behavior contract.',
        semanticAuthor: {
          id: 'investigation-reviewer',
          provenance: 'review-session',
        },
        provenanceDigest: 'e'.repeat(64),
      },
    ],
    policies: {
      planningPolicyDigest: DIGESTS.workflowPolicy,
      canonicalizerPolicyDigest: DIGESTS.canonicalizerPolicy,
      rendererPolicyDigest: DIGESTS.rendererPolicy,
      reviewPolicyDigest: DIGESTS.reviewPolicy,
    },
  };
}

export function reviewContext(): {
  target: PlanTarget;
  generation: PlanningGeneration;
  subject: ReturnType<typeof createPlanReviewSubject>;
  assignment: RoleAssignment;
  targetSnapshotNode: EvidenceNode;
  providerResult: EvidenceNode;
} {
  const target = createPlanTarget(planTargetInput());
  const generation = createPlanningGeneration(generationInput(target));
  const subject = createPlanReviewSubject({
    generation,
    reviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'session-independent',
  });
  const assignment: RoleAssignment = {
    role: 'plan-reviewer',
    providerId: 'claude',
    sessionId: 'review-session',
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'session-independent',
    achievedIndependence: 'provider-independent',
  };
  const materializationNode = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'test.review-context-materialization.v1',
    evaluator: 'test.review-context-materialization.v1',
    policyDigest: DIGESTS.reviewPolicy,
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'test.review-context-materialization-output.v1',
    output: { testOnly: true },
    runtimeMetadata: {},
  });
  const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
    changeId: 'demo-change',
    changePrefix: 'openspec/changes/demo-change',
    subject,
    materializationNode,
    artifacts: new Map([
      ['proposal.md', Buffer.from('# Proposal\n\nPreserve the behavior.\n')],
    ]),
  });
  const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
    subject,
    assignment,
    submission: challengeSubmission(),
    targetSnapshotNode,
    policyDigest: DIGESTS.reviewPolicy,
    invocationId: 'plan-review-invocation',
    runtimeObservation: 'current',
  });
  const providerResult = rememberProviderResult(
    createPlanReviewProviderResultNode({
      subject,
      assignment,
      request: providerEvidence.request,
      result: providerEvidence.result,
      targetSnapshotNode,
    }),
    targetSnapshotNode,
  );
  return {
    target,
    generation,
    subject,
    assignment,
    targetSnapshotNode,
    providerResult,
  };
}

export function providerResultFor(
  context: ReturnType<typeof reviewContext>,
  submission: PlanReviewSubmission,
): EvidenceNode {
  const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
    subject: context.subject,
    assignment: context.assignment,
    submission,
    targetSnapshotNode: context.targetSnapshotNode,
    policyDigest: DIGESTS.reviewPolicy,
    invocationId: `plan-review-${crypto
      .createHash('sha256')
      .update(canonicalJson(submission))
      .digest('hex')
      .slice(0, 16)}`,
    runtimeObservation: 'current',
  });
  return rememberProviderResult(
    createPlanReviewProviderResultNode({
      subject: context.subject,
      assignment: context.assignment,
      request: providerEvidence.request,
      result: providerEvidence.result,
      targetSnapshotNode: context.targetSnapshotNode,
    }),
    context.targetSnapshotNode,
  );
}

export function rememberProviderResult(
  node: EvidenceNode,
  targetSnapshotNode: EvidenceNode,
): EvidenceNode {
  providerResultsById.set(node.nodeId, node);
  targetSnapshotsById.set(targetSnapshotNode.nodeId, targetSnapshotNode);
  return node;
}

export function providerExecutionFromNode(node: EvidenceNode): {
  request: ProviderInvocationRequest;
  result: ProviderProcessResult;
} {
  return node.output as {
    request: ProviderInvocationRequest;
    result: ProviderProcessResult;
  };
}

export function challengeSubmission(
  overrides: Partial<PlanReviewSubmission> = {},
): PlanReviewSubmission {
  return {
    schemaVersion: 2,
    verdict: 'advisory-reject',
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'challenges' },
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'missing-scope',
        currentChangeImpact: 'required',
        summary: 'A load-bearing consumer may be missing.',
        evidence: [
          {
            kind: 'repository-location',
            path: 'src/consumer.ts',
            line: 12,
            observation: 'The consumer imports the changed contract.',
          },
        ],
      },
    ],
    proposedTerms: [],
    suggestions: [],
    residualRisk: 'No residual risk beyond the documented challenge.',
    uncertainty: 'No additional uncertainty identified.',
    ...overrides,
  };
}

export function providerSubmission(
  overrides: Record<string, unknown> = {},
  submission: PlanReviewSubmission = challengeSubmission(),
): Record<string, unknown> {
  return { ...planReviewProviderSubmission(submission), ...overrides };
}

export function suggestion(summary: string) {
  return {
    kind: 'suggestion' as const,
    severity: 'low' as const,
    category: 'follow-up' as const,
    currentChangeImpact: 'independent-follow-up' as const,
    summary,
    evidence: [
      {
        kind: 'repository-location' as const,
        path: 'docs/ROADMAP.md',
        line: 1,
        observation: 'The follow-up belongs to later roadmap work.',
      },
    ],
  };
}

export function currentValidationInput(
  context: Pick<
    ReturnType<typeof reviewContext>,
    'target' | 'generation' | 'subject'
  >,
  reviewNode: EvidenceNode,
) {
  const review = readPlanReviewNode(reviewNode);
  const providerResultNode = providerResultsById.get(
    review.providerResultNodeId,
  );
  if (
    providerResultNode === undefined ||
    providerResultNode.resultDigest !== review.providerResultResultDigest
  ) {
    throw new TypeError('Fixture PlanReview provider result is unavailable.');
  }
  const targetSnapshotNode = targetSnapshotsById.get(
    providerResultNode.provenanceParentNodeIds.targetSnapshot,
  );
  if (targetSnapshotNode === undefined) {
    throw new TypeError('Fixture PlanReview target snapshot is unavailable.');
  }
  const planningTarget = readPlanReviewTargetSnapshotNode(targetSnapshotNode);
  const challengeIds = review.findings
    .filter(({ kind }) => kind === 'challenge')
    .map(({ findingId }) => findingId);
  const dispositionNode =
    challengeIds.length === 0
      ? null
      : createPlanReviewDispositionNode({
          reviewNode,
          policyDigest: DIGESTS.reviewPolicy,
          dispositions: challengeIds.map((challengeId) => ({
            challengeId,
            decision: 'mitigated' as const,
            rationale: 'The planning subject now accounts for this finding.',
            author: 'main-agent',
          })),
        });
  return {
    reviewNode,
    providerResultNode,
    dispositionNode,
    subject: context.subject,
    generation: context.generation,
    target: context.target,
    expectedReviewPolicyDigest: DIGESTS.reviewPolicy,
    requiredIndependence: 'session-independent' as const,
    independenceAuthorization: admittedRoleAuthorization(providerResultNode),
    repositoryEvidence: repositoryEvidenceFor(
      reviewNode,
      context.subject.investigationBaseline.tree,
    ),
    planningTarget,
    planningEvidence: {
      snapshotDigest: planningTarget.snapshotDigest,
      locations: [],
    },
  };
}

export function admittedRoleAuthorization(providerResultNode: EvidenceNode) {
  const { request, result } = providerExecutionFromNode(providerResultNode);
  return {
    kind: 'admitted-role-result' as const,
    roleResult: admitRoleResult({
      assignment: request.roleAssignment,
      author: {
        providerId: 'codex',
        sessionId: 'author-session',
        principalId: null,
        identityAssurance: 'runtime-hint',
        engineSpawned: false,
      },
      participant: {
        providerId: request.roleAssignment.providerId,
        sessionId: request.roleAssignment.sessionId,
        principalId: null,
        identityAssurance: 'adapter-assigned',
        engineSpawned: true,
      },
      content: {
        kind: 'plan-review',
        nodeId: providerResultNode.nodeId,
        resultDigest: providerResultNode.resultDigest,
        outputSchema: request.outputSchema,
        evaluator: request.evaluatorVersion,
        policyDigest: request.policyDigest,
        contentDigest: providerResultNode.resultDigest,
        current: true,
      },
      providerInvocation: {
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        outputDigest: result.outputDigest,
        providerId: request.providerId,
        sessionId: request.roleAssignment.sessionId,
        targetDigest: request.targetDigest,
        engineSpawned: true,
      },
      grantUse: null,
      grantValidation: null,
    }),
  };
}

export function repositoryEvidenceFor(reviewNode: EvidenceNode, tree: string) {
  const review = readPlanReviewNode(reviewNode);
  const locations = [
    ...review.findings.flatMap(({ evidence }) => evidence),
    ...review.suggestions.flatMap(({ evidence }) => evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ]
    .filter(
      (
        evidence,
      ): evidence is Extract<
        (typeof review.findings)[number]['evidence'][number],
        { kind: 'repository-location' }
      > => evidence.kind === 'repository-location',
    )
    .reduce((entries, evidence) => {
      const current = entries.get(evidence.path);
      entries.set(evidence.path, Math.max(current ?? 0, evidence.line));
      return entries;
    }, new Map<string, number>());

  return {
    tree,
    locations: [...locations]
      .map(([path, lineCount]) => ({
        path,
        blobOid: 'c'.repeat(tree.length),
        lineCount,
      }))
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.path, 'utf8'),
          Buffer.from(right.path, 'utf8'),
        ),
      ),
  };
}

export function planningTargetFor(
  context: ReturnType<typeof reviewContext>,
  relativePath: string,
  content: string,
) {
  const materializationNode = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'test.materialization.v1',
    evaluator: 'test.materialization.v1',
    policyDigest: DIGESTS.reviewPolicy,
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'test.materialization-output.v1',
    output: { testOnly: true },
    runtimeMetadata: {},
  });
  return readPlanReviewTargetSnapshotNode(
    createPlanReviewTargetSnapshotNode({
      changeId: 'demo-change',
      changePrefix: 'openspec/changes/demo-change',
      subject: context.subject,
      materializationNode,
      artifacts: new Map([[relativePath, Buffer.from(content, 'utf8')]]),
    }),
  );
}

export function authoredComponent(
  input: PlanTargetInput,
  role: 'proposal' | 'delta-spec',
) {
  return input.components.find(
    (component) =>
      component.kind === 'authored-markdown' && component.role === role,
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'authored-markdown' }
  >;
}

export function mixedComponent(input: PlanTargetInput) {
  return input.components.find(
    (component) => component.kind === 'mixed-markdown',
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'mixed-markdown' }
  >;
}

export function tasksComponent(input: PlanTargetInput) {
  return input.components.find(
    (component) => component.kind === 'tasks-markdown',
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'tasks-markdown' }
  >;
}

export function structuredComponent(
  input: PlanTargetInput,
  role: 'schema-metadata' | 'guard' | 'execution' | 'investigation',
) {
  return input.components.find(
    (component) =>
      component.kind === 'structured-json' && component.role === role,
  ) as Extract<
    PlanTargetInput['components'][number],
    { kind: 'structured-json' }
  >;
}

export function policyComponent(input: PlanTargetInput, name: string) {
  return input.components.find(
    (component) => component.kind === 'policy' && component.name === name,
  ) as Extract<PlanTargetInput['components'][number], { kind: 'policy' }>;
}

export function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

void (undefined as unknown as PlanReviewTermProjection);
