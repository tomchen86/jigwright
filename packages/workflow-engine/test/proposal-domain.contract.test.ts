import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  assertPlanningBinding,
  assertProgressBinding,
  assertProposeInput,
  createPlanningContributionEnvelope,
  createPlanReviewProgressEnvelope,
  createProviderProgressEnvelope,
  createScanSaturationAcceptanceEnvelope,
  planReviewProgressSchema,
  withEnvelopeTemplate,
} from '../src/modules/proposal/propose-input.ts';
import type {
  PlanningContributionEnvelope,
  PlanningContributionPayload,
  ProposeOutput,
} from '../src/modules/proposal/propose-types.ts';
import type { InvestigationStatus } from '../src/modules/lifecycle/investigation-status.ts';
import { createInvestigationCheckpointEnvelope } from '../src/modules/lifecycle/investigation-checkpoint-envelope.ts';
import {
  decideReviewerTermReopen,
  type ReviewerTermResolutionAuthorization,
} from '../src/modules/investigation/domain/reviewer-term-reopen.ts';
import type {
  GroupDispositionsPayload,
  InvestigationCheckpointEnvelope,
  MainTermsPayload,
  WhyAnswersPayload,
} from '../src/modules/investigation/domain/investigation-session-types.ts';
import {
  createRoleContextSharingPlanReviewRequirementV3,
  createRoleContextSharingRequirementEligibilityPort,
  deriveRoleContextSharingPlanReviewExpectedBinding,
} from '../src/modules/proposal/role-context-sharing-plan-review.ts';
import {
  CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
  resolveRoleTopologyV1,
} from '../src/modules/provider-orchestration/role-topology-resolution.ts';
import {
  agentRolePlanV2Digest,
  type AgentRolePlanBodyV2,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';
import { createEvidenceNode } from '../src/foundation/evidence-node/evidence-node.ts';
import { ASSURANCE_ASSESSMENT_POLICY_DIGEST } from '../src/modules/assurance/assurance-assessment-chain.ts';
import { PROPOSE_POLICY_DIGEST } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { reportProposeAssuranceAssessment } from '../src/modules/proposal/propose-investigation-projections.ts';
import {
  readInvestigationManifestAuthorityNode,
  uniqueNodes,
} from '../src/modules/proposal/propose-evidence.ts';
import { mergeReviewerReopenCheckpoint } from '../src/modules/proposal/propose-reviewer-checkpoint.ts';
import type { RebuiltInvestigation } from '../src/modules/proposal/propose-types.ts';

const digest = (character: string) => character.repeat(64);
const GRANT_ID = '12345678-1234-4123-8123-123456789abc';
const baseline = () => ({ head: 'a'.repeat(40), tree: 'b'.repeat(40) });
function status(): InvestigationStatus {
  return {
    kind: 'investigation',
    investigationId: 'investigation-proposal-domain',
    changeId: 'proposal-domain',
    revision: 2,
    semanticRevision: 1,
    lifecycleRevision: 1,
    state: 'investigation-sealed',
    baseline: baseline(),
    intentDigest: digest('c'),
    blindManifestDigest: digest('d'),
    providerInvocationId: 'invocation-proposal-domain',
    provider: {
      state: 'succeeded',
      providerId: 'codex',
      attempt: 1,
      revision: 1,
      leaseGeneration: 1,
      leaseExpiresAt: null,
      failure: null,
      resultDigest: digest('e'),
      activity: {
        state: 'not-observed',
        observedAt: null,
        staleMs: null,
        eventCount: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    },
    checkpoint: null,
    nextAction: 'investigation-complete',
  };
}
function output(): ProposeOutput {
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: 'proposal-domain',
    state: 'awaiting-planning-contribution',
    nextAction: 'submit-planning-contribution',
    investigation: status(),
    createdDate: '2026-10-24',
    actorResolution: null,
    inputSchema: null,
    work: null,
    materializedArtifacts: null,
    planReview: null,
    planningTransition: null,
    semanticReuse: null,
    classSampleAudits: [],
    floorTrimming: { dropped: [], escalated: false },
  };
}
function payload(): PlanningContributionPayload {
  return {
    proposal: 'A bounded proposal.\n',
    design: 'Preserve exact identities.\n',
    specs: [
      {
        path: 'specs/proposal-domain/spec.md',
        content: 'A meaningful requirement.\n',
      },
    ],
    tasks: 'Implement the requirement.\n',
    guard: { schemaVersion: 1, changeId: 'proposal-domain', tasks: {} },
    executionTasks: {},
  };
}
function code(expected: string, exitCode: number = ExitCode.usage) {
  return (error: unknown) =>
    error instanceof WorkflowError &&
    error.code === expected &&
    error.exitCode === exitCode;
}
function binding() {
  const {
    schemaVersion: _schema,
    kind: _kind,
    ...value
  } = createProviderProgressEnvelope(status());
  return value;
}

test('proposal envelope dispatch preserves exact keys and refusal precedence', () => {
  for (const kind of [
    'planning-contribution',
    'exemption-planning-contribution',
    'provider-progress',
    'provider-retry',
    'plan-review-progress',
    'plan-review-dispositions',
    'plan-review-retry',
  ]) {
    assert.throws(
      () => assertProposeInput({ kind, unexpected: true }),
      code('PROPOSE_INPUT_INVALID'),
    );
  }
  for (const kind of [
    'main-terms',
    'group-dispositions',
    'why-answers',
    'unknown',
  ]) {
    assert.throws(
      () => assertProposeInput({ kind }),
      code('INVESTIGATION_CHECKPOINT_INVALID'),
    );
  }
  assert.throws(
    () => assertProposeInput({ kind: 'scan-saturation-acceptance' }),
    code('INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_INVALID'),
  );
  assert.throws(() => assertProposeInput(null), code('PROPOSE_INPUT_INVALID'));
  const envelope = {
    schemaVersion: 1,
    kind: 'planning-contribution',
    ...binding(),
    payload: null,
    changeId: 'INVALID',
  };
  assert.throws(
    () => assertProposeInput({ ...envelope, unexpected: true }),
    (error: unknown) =>
      code('PROPOSE_INPUT_INVALID')(error) &&
      (error as Error).message.includes('unexpected unexpected'),
  );
  assert.throws(() => assertProposeInput(envelope), code('INVALID_CHANGE_ID'));
  assert.throws(
    () => assertProposeInput({ ...envelope, changeId: 'proposal-domain' }),
    code('PLANNING_CONTRIBUTION_INVALID'),
  );
});

test('planning validation reconstructs payload while progress and review retain caller identity', () => {
  const current = status();
  const input = createPlanningContributionEnvelope(
    output(),
    payload(),
  ) as PlanningContributionEnvelope;
  const parsed = assertProposeInput(input);
  assert.notEqual(parsed, input);
  if (parsed.kind !== 'planning-contribution')
    assert.fail('ordinary planning envelope expected');
  assert.equal(parsed.baseline, input.baseline);
  assert.notEqual(parsed.payload, input.payload);
  assert.equal(parsed.payload.guard, input.payload.guard);
  assert.equal(parsed.payload.executionTasks, input.payload.executionTasks);
  assertPlanningBinding(current, input);
  assert.throws(
    () =>
      assertPlanningBinding(current, {
        ...input,
        expectedRevision: current.revision + 1,
      }),
    code('PROPOSE_INPUT_STALE', ExitCode.staleState),
  );
  const progress = createProviderProgressEnvelope(current);
  assert.notEqual(progress.baseline, current.baseline);
  assert.equal(assertProposeInput(progress), progress);
  assert.doesNotThrow(() =>
    assertProgressBinding(current, { ...progress, expectedRevision: 99 }),
  );
  assert.throws(
    () =>
      assertProgressBinding(current, {
        ...progress,
        intentDigest: digest('f'),
      }),
    code('PROPOSE_INPUT_STALE', ExitCode.staleState),
  );
  const review = {
    schemaVersion: 1,
    kind: 'plan-review-progress',
    investigationId: current.investigationId,
    changeId: current.changeId,
    subjectDigest: digest('1'),
    invocationId: 'invocation-review',
    requestDigest: digest('2'),
  };
  assert.equal(assertProposeInput(review), review);
  const dispositions = {
    schemaVersion: 1,
    kind: 'plan-review-dispositions',
    investigationId: current.investigationId,
    changeId: current.changeId,
    subjectDigest: digest('1'),
    reviewNodeId: digest('2'),
    reviewResultDigest: digest('3'),
    dispositions: [],
  };
  assert.equal(assertProposeInput(dispositions), dispositions);
  const { blindManifestDigest: _blind, ...exemptionBinding } = binding();
  const exempt = assertProposeInput({
    schemaVersion: 1,
    kind: 'exemption-planning-contribution',
    ...exemptionBinding,
    expectedRevision: 0,
    applicabilityDigest: digest('4'),
    payload: payload(),
  });
  assert.equal(exempt.kind, 'exemption-planning-contribution');
  assert.throws(
    () => assertProposeInput({ ...exempt, expectedRevision: 1 }),
    code('PROPOSE_INPUT_INVALID'),
  );
});

test('retry optional properties distinguish omission from present invalid values', () => {
  const failedInvocation = {
    invocationId: 'invocation-failed',
    attempt: 1,
    revision: 0,
    requestDigest: digest('1'),
    failureDigest: digest('2'),
  };
  const provider = {
    schemaVersion: 1,
    kind: 'provider-retry',
    ...binding(),
    failedInvocation,
    acknowledgeProviderCost: true,
  };
  const review = {
    schemaVersion: 1,
    kind: 'plan-review-retry',
    investigationId: status().investigationId,
    changeId: 'proposal-domain',
    expectedRevision: 2,
    baseline: baseline(),
    subjectDigest: digest('3'),
    planningGenerationId: digest('4'),
    expectedReservationNodeId: digest('5'),
    failedInvocation,
    acknowledgeProviderCost: true,
  };
  for (const input of [provider, review]) {
    assert.equal(assertProposeInput(input), input);
    assert.equal('timeoutMs' in assertProposeInput(input), false);
    const bounded = { ...input, timeoutMs: 3_600_000 };
    assert.equal(assertProposeInput(bounded), bounded);
    for (const timeoutMs of [undefined, null, 0, 3_600_001])
      assert.throws(
        () => assertProposeInput({ ...input, timeoutMs }),
        code('PROPOSE_INPUT_INVALID'),
      );
    assert.throws(
      () => assertProposeInput({ ...input, acknowledgeProviderCost: false }),
      code('PROPOSE_INPUT_INVALID'),
    );
  }
});

test('checkpoint and saturation dispatch clone and freeze validated data', () => {
  for (const [kind, payload] of [
    [
      'main-terms',
      {
        reference: 'The original proposal',
        terms: [
          {
            kind: 'literal-content',
            value: 'proposal',
            rationale: 'Locate the proposal rule',
            expectedRelationship: 'The rule consumes this input',
          },
        ],
      },
    ],
    ['group-dispositions', { dispositions: [], classes: [], sampleAudits: [] }],
    ['why-answers', { answers: [] }],
  ] as const) {
    const input = {
      schemaVersion: 1,
      kind,
      checkpointId: `checkpoint-${digest('1')}`,
      ...binding(),
      payload,
    };
    const parsed = assertProposeInput(input);
    assert.notEqual(parsed, input);
    assert.deepEqual(parsed, input);
    assert.ok(Object.isFrozen(parsed));
    if (!('payload' in parsed)) assert.fail('checkpoint payload expected');
    assert.ok(Object.isFrozen(parsed.payload));
    assert.equal(Object.isFrozen(input.payload), false);
  }
  const inputSchema = {
    kind: 'scan-saturation-acceptance',
    binding: binding(),
    saturatedTermIds: [digest('1'), digest('2')],
  };
  const envelope = createScanSaturationAcceptanceEnvelope({
    ...output(),
    state: 'scan-saturation-acceptance-required',
    inputSchema,
  });
  assert.ok(Object.isFrozen(envelope.saturatedTermIds));
  assert.notEqual(envelope.saturatedTermIds, inputSchema.saturatedTermIds);
  assert.deepEqual(assertProposeInput(envelope), envelope);
  assert.throws(
    () =>
      assertProposeInput({
        ...envelope,
        saturatedTermIds: [digest('2'), digest('1')],
      }),
    code('INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_INVALID'),
  );
  assert.throws(
    () => createScanSaturationAcceptanceEnvelope(output()),
    code(
      'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_NOT_AVAILABLE',
      ExitCode.guard,
    ),
  );
});

test('public schema accepts the minimal nested reservation and preserves nullable output', () => {
  const schema = planReviewProgressSchema(status(), {
    subject: { subjectDigest: digest('1') },
    request: { invocationId: 'invocation-review', requestDigest: digest('2') },
  });
  assert.deepEqual(schema.template, {
    schemaVersion: 1,
    kind: 'plan-review-progress',
    investigationId: status().investigationId,
    changeId: 'proposal-domain',
    subjectDigest: digest('1'),
    invocationId: 'invocation-review',
    requestDigest: digest('2'),
  });
  const unchanged = { kind: 'no-envelope' };
  assert.equal(withEnvelopeTemplate(unchanged), unchanged);
  assert.throws(
    () =>
      createPlanReviewProgressEnvelope({ ...output(), investigation: null }),
    code('PLAN_REVIEW_PROGRESS_NOT_AVAILABLE', ExitCode.guard),
  );
  assert.throws(
    () =>
      createPlanningContributionEnvelope(
        { ...output(), investigation: null },
        payload(),
      ),
    code('PLANNING_CONTRIBUTION_NOT_AVAILABLE', ExitCode.guard),
  );
});

function requirementInput(): Parameters<
  typeof createRoleContextSharingPlanReviewRequirementV3
>[0] {
  const plan: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId: 'proposal-domain',
    baseCentralConfigurationDigest: digest('0'),
    roleLanes: [],
    pairwiseRequirements: [
      { pair: 'author-reviewer', required: 'provider-independent' },
    ],
    customWrapperPolicy: 'forbidden',
    grantReferences: [GRANT_ID],
  };
  const roleTopology = resolveRoleTopologyV1({
    changeId: plan.changeId,
    planningGeneration: digest('1'),
    baseCentralConfigurationDigest: plan.baseCentralConfigurationDigest,
    centralConfiguration: CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
    changeOverride: { ...plan, planDigest: agentRolePlanV2Digest(plan) },
    providerRegistry: {
      schemaVersion: 1,
      policyDigest: digest('3'),
      providers: [
        {
          logicalProviderId: 'codex',
          providerFamily: 'codex',
          enabled: true,
          definitionDigest: digest('2'),
        },
      ],
    },
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'codex',
        providerDefinitionDigest: digest('2'),
        sessionId: 'author-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'codex',
        providerDefinitionDigest: digest('2'),
        sessionId: 'reviewer-session',
      },
    ],
  });
  return {
    investigationId: status().investigationId,
    changeId: 'proposal-domain',
    baseline: baseline(),
    subject: {
      schemaVersion: 1,
      subjectDigest: digest('4'),
      planningGenerationId: digest('1'),
      planTargetDigest: digest('5'),
      manifestDigest: digest('7'),
      investigationTargetDigest: digest('8'),
      reviewPolicyDigest: digest('6'),
      requiredIndependence: 'session-independent',
      investigationBaseline: baseline(),
      investigationDependencies: [],
      investigationRequirements: [],
    },
    author: {
      providerId: 'codex',
      sessionId: 'author-session',
      principalId: null,
      identityAssurance: 'adapter-assigned',
      engineSpawned: false,
    },
    roleTopology,
    contextGeneration: 1,
  };
}

test('role-sharing requirement retains aliases, freezes shared data and binds exact eligibility', () => {
  const input = requirementInput();
  const requirement = createRoleContextSharingPlanReviewRequirementV3(input);
  assert.equal(requirement.baseline, input.baseline);
  assert.equal(requirement.subject, input.subject);
  assert.equal(requirement.roleTopology, input.roleTopology);
  assert.ok(Object.isFrozen(input.baseline));
  assert.ok(Object.isFrozen(input.subject.investigationDependencies));
  assert.notEqual(
    requirement.grantReferences,
    input.roleTopology.explicitEligibility.grantReferences,
  );
  assert.deepEqual(requirement.grantReferences, [GRANT_ID]);
  assert.throws(
    () => Object.assign(input.baseline, { head: 'f'.repeat(40) }),
    TypeError,
  );
  const expected = deriveRoleContextSharingPlanReviewExpectedBinding({
    requirement,
    repositoryId: 'repository',
    repositoryOrigin: 'https://example.invalid/repository.git',
    policyBlob: 'e'.repeat(40),
    reason: 'Authorize this exact review',
  });
  assert.equal(expected.targetDigest, input.subject.subjectDigest);
  assert.equal(expected.baselineCommit, input.baseline.head);
  assert.equal(expected.contextGeneration, 1);
  assert.equal(expected.sessionGeneration, 1);
  assert.equal(expected.taskId, null);
  assert.equal(expected.rolePairs, input.roleTopology.exactGrantRolePairs);
  const capture = { requirement, grantId: GRANT_ID, expected };
  const port = createRoleContextSharingRequirementEligibilityPort(capture);
  assert.ok(Object.isFrozen(port));
  assert.doesNotThrow(() => port.assertEligible(structuredClone(expected)));
  assert.throws(
    () => port.assertEligible({ ...expected, contextGeneration: 2 }),
    code('ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE', ExitCode.guard),
  );
  capture.expected = { ...expected, reason: 'Changed exact reason' };
  assert.throws(
    () => port.assertEligible(expected),
    code('ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE', ExitCode.guard),
  );
  assert.doesNotThrow(() => port.assertEligible(capture.expected));
  assert.throws(
    () =>
      createRoleContextSharingRequirementEligibilityPort({
        ...capture,
        grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    code('ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE', ExitCode.guard),
  );
  for (const grantReferences of [[], ['invalid'], [GRANT_ID, GRANT_ID]]) {
    const fresh = requirementInput();
    assert.throws(
      () =>
        createRoleContextSharingPlanReviewRequirementV3({
          ...fresh,
          roleTopology: {
            ...fresh.roleTopology,
            explicitEligibility: {
              ...fresh.roleTopology.explicitEligibility,
              grantReferences,
            },
          },
        }),
      code('ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE', ExitCode.guard),
    );
  }
});

test('checkpoint overloads preserve binding and produce frozen snapshots without freezing caller data', () => {
  const current = status();
  const mainPayload: MainTermsPayload = {
    reference: 'proposal-domain-survey',
    terms: [
      {
        kind: 'symbol',
        value: 'createInvestigationCheckpointEnvelope',
        rationale:
          'This function binds caller input to the investigation checkpoint.',
        expectedRelationship:
          'The lifecycle owner preserves the investigation input contract.',
      },
    ],
  };
  const groupPayload: GroupDispositionsPayload = { dispositions: [] };
  const whyPayload: WhyAnswersPayload = { answers: [] };
  assert.throws(
    () => createInvestigationCheckpointEnvelope(current, mainPayload),
    code('INVESTIGATION_CHECKPOINT_NOT_AVAILABLE', ExitCode.guard),
  );
  current.checkpoint = {
    schemaVersion: 1,
    kind: 'main-terms',
    checkpointId: `checkpoint-${digest('1')}`,
  };
  const main: Extract<InvestigationCheckpointEnvelope, { kind: 'main-terms' }> =
    createInvestigationCheckpointEnvelope(current, mainPayload);
  current.checkpoint.kind = 'group-dispositions';
  const groups: Extract<
    InvestigationCheckpointEnvelope,
    { kind: 'group-dispositions' }
  > = createInvestigationCheckpointEnvelope(current, groupPayload);
  current.checkpoint.kind = 'why-answers';
  const why: Extract<InvestigationCheckpointEnvelope, { kind: 'why-answers' }> =
    createInvestigationCheckpointEnvelope(current, whyPayload);
  assert.deepEqual(
    [main.kind, groups.kind, why.kind],
    ['main-terms', 'group-dispositions', 'why-answers'],
  );
  for (const [envelope, original] of [
    [main, mainPayload],
    [groups, groupPayload],
    [why, whyPayload],
  ] as const) {
    assert.deepEqual(envelope, {
      schemaVersion: 1,
      kind: envelope.kind,
      checkpointId: current.checkpoint.checkpointId,
      investigationId: current.investigationId,
      changeId: current.changeId,
      expectedRevision: current.revision,
      baseline: current.baseline,
      intentDigest: current.intentDigest,
      blindManifestDigest: current.blindManifestDigest,
      payload: original,
    });
    assert.notEqual(envelope.payload, original);
    assert.notEqual(envelope.baseline, current.baseline);
    assert.ok(Object.isFrozen(envelope));
    assert.ok(Object.isFrozen(envelope.payload));
    assert.ok(Object.isFrozen(envelope.baseline));
    assert.equal(Object.isFrozen(original), false);
  }
  for (const items of [
    main.payload.terms,
    groups.payload.dispositions,
    why.payload.answers,
  ])
    assert.ok(Object.isFrozen(items));
  assert.ok(Object.isFrozen(main.payload.terms[0]));
  const originalTerm = { ...mainPayload.terms[0]! };
  mainPayload.terms[0]!.value = 'changedByCaller';
  current.baseline.head = 'f'.repeat(40);
  assert.deepEqual(main.payload.terms[0], originalTerm);
  assert.equal(main.baseline.head, baseline().head);
});

test('reviewer-term decisions preserve the two automatic reopens and human outcomes', () => {
  const none: ReviewerTermResolutionAuthorization = {
    outcome: 'none',
    resolutionNodeId: null,
  };
  const resume: ReviewerTermResolutionAuthorization = {
    outcome: 'resume',
    resolutionNodeId: 'resolution-resume',
  };
  const close: ReviewerTermResolutionAuthorization = {
    outcome: 'close-input',
    resolutionNodeId: 'resolution-close',
    assurance: 'degraded',
  };
  assert.equal(
    decideReviewerTermReopen({
      usedReopens: 2,
      novelTermCount: 0,
      humanResolution: close,
    }),
    'no-novel-terms',
  );
  for (const usedReopens of [0, 1])
    assert.equal(
      decideReviewerTermReopen({
        usedReopens,
        novelTermCount: 1,
        humanResolution: close,
      }),
      'automatic-reopen',
    );
  for (const [humanResolution, expected] of [
    [none, 'human-action-required'],
    [resume, 'human-reopen'],
    [close, 'human-close-input'],
  ] as const)
    assert.equal(
      decideReviewerTermReopen({
        usedReopens: 2,
        novelTermCount: 1,
        humanResolution,
      }),
      expected,
    );
  for (const value of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const field of ['usedReopens', 'novelTermCount'] as const)
      assert.throws(
        () =>
          decideReviewerTermReopen({
            usedReopens: 0,
            novelTermCount: 0,
            humanResolution: none,
            [field]: value,
          }),
        code('INVESTIGATION_REVIEWER_REOPEN_POLICY_INVALID'),
      );
  }
});

test('reviewer checkpoint merge reuses only current facts and retains classes and audits', () => {
  const current = status();
  const envelope = {
    schemaVersion: 1 as const,
    checkpointId: `checkpoint-${digest('1')}`,
    investigationId: current.investigationId,
    changeId: current.changeId,
    expectedRevision: current.revision,
    baseline: current.baseline,
    intentDigest: current.intentDigest,
    blindManifestDigest: current.blindManifestDigest,
  };
  const disposition = (id: string) => ({
    groupId: digest(id),
    classification: 'load-bearing' as const,
    rationale: 'This group carries the behavior under review.',
    author: 'reviewer',
  });
  const answer = (id: string) => ({
    manifestEntryId: digest(id),
    why: 'The caller depends on this behavior.',
    protectedInvariant: 'Keep the existing observation and authority order.',
    reviewerQuestion: 'Does the changed implementation preserve the contract?',
    answer: 'The unchanged contract is covered by the focused evidence.',
    semanticAuthor: 'reviewer',
    readComplete: true as const,
  });
  const groups: Extract<
    InvestigationCheckpointEnvelope,
    { kind: 'group-dispositions' }
  > = {
    ...envelope,
    kind: 'group-dispositions',
    payload: { dispositions: [disposition('b'), disposition('f')] },
  };
  const why: Extract<InvestigationCheckpointEnvelope, { kind: 'why-answers' }> =
    {
      ...envelope,
      kind: 'why-answers',
      payload: { answers: [answer('b'), answer('f')] },
    };
  // Populate exactly the immutable facts read by this merge, without runtime fixtures.
  const rebuilt = {
    v3Domain: { groupFacts: { groups: [{ key: digest('b') }] } },
    fullBlobManifest: [{ manifestEntryId: digest('b') }],
    reviewerPriorGroupDispositions: { envelope: groups },
    reviewerPriorWhyAnswers: { envelope: why },
  } as unknown as RebuiltInvestigation;
  const main: Extract<InvestigationCheckpointEnvelope, { kind: 'main-terms' }> =
    {
      ...envelope,
      kind: 'main-terms',
      payload: { reference: 'existing-main', terms: [] },
    };
  assert.equal(mergeReviewerReopenCheckpoint(rebuilt, main), main);
  for (const extras of [{}, { classes: [], sampleAudits: [] }]) {
    const input = {
      ...groups,
      payload: { ...extras, dispositions: [disposition('a')] },
    };
    const merged = mergeReviewerReopenCheckpoint(rebuilt, input);
    if (merged.kind !== 'group-dispositions')
      assert.fail('group checkpoint expected');
    assert.deepEqual(
      merged.payload.dispositions.map((row) => row.groupId),
      [digest('a'), digest('b')],
    );
    assert.equal(
      Object.hasOwn(merged.payload, 'classes'),
      Object.hasOwn(extras, 'classes'),
    );
    assert.equal(
      Object.hasOwn(merged.payload, 'sampleAudits'),
      Object.hasOwn(extras, 'sampleAudits'),
    );
    assert.ok(Object.isFrozen(merged.payload.dispositions));
    assert.ok(Object.isFrozen(merged.payload.dispositions[0]));
    assert.notEqual(merged.payload, input.payload);
    input.payload.dispositions[0]!.rationale =
      'Changed by the caller after merging.';
    assert.equal(
      merged.payload.dispositions[0]!.rationale,
      disposition('a').rationale,
    );
  }
  assert.throws(
    () => mergeReviewerReopenCheckpoint(rebuilt, groups),
    code('INVESTIGATION_REVIEWER_REOPEN_SCOPE_INVALID', ExitCode.guard),
  );
  const mergedWhy = mergeReviewerReopenCheckpoint(rebuilt, {
    ...why,
    payload: { answers: [answer('a')] },
  });
  if (mergedWhy.kind !== 'why-answers') assert.fail('WHY checkpoint expected');
  assert.deepEqual(
    mergedWhy.payload.answers.map((row) => row.manifestEntryId),
    [digest('a'), digest('b')],
  );
  assert.ok(Object.isFrozen(mergedWhy.payload.answers));
  assert.throws(
    () => mergeReviewerReopenCheckpoint(rebuilt, why),
    code('INVESTIGATION_REVIEWER_REOPEN_SCOPE_INVALID', ExitCode.guard),
  );
});

test('assurance projection keeps canonical node identity and rejects other policies', () => {
  const node = createEvidenceNode({
    type: 'assurance-assessment',
    nodeSchema: 'assurance-assessment.v1',
    evaluator: 'proposal-domain-test',
    policyDigest: ASSURANCE_ASSESSMENT_POLICY_DIGEST,
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'assurance-assessment-output.v1',
    runtimeMetadata: {},
    output: {
      schemaVersion: 1,
      kind: 'assurance-assessment',
      changeId: 'proposal-domain',
      nodeId: 'untrusted-output-id',
      resultDigest: 'untrusted-output-digest',
    },
  });
  const report = reportProposeAssuranceAssessment(node);
  assert.equal(report.nodeId, node.nodeId);
  assert.equal(report.resultDigest, node.resultDigest);
  assert.equal(report.policyDigest, node.policyDigest);
  assert.ok(Object.isFrozen(report));
  for (const altered of [
    { ...node, policyDigest: digest('a') },
    { ...node, output: null },
  ])
    assert.throws(
      () => reportProposeAssuranceAssessment(altered),
      code('ASSURANCE_ASSESSMENT_INVALID', ExitCode.staleState),
    );
});

test('manifest authority validation and evidence collision checks preserve exact bytes', () => {
  const binding = {
    repositoryId: 'proposal-domain',
    changeId: 'proposal-domain',
    investigationId: status().investigationId,
    sessionRevision: 2,
    sessionSnapshotDigest: digest('a'),
    manifestDigest: digest('b'),
    investigationTargetDigest: digest('c'),
  };
  const node = createEvidenceNode({
    type: 'investigation-manifest-authority',
    nodeSchema: 'investigation.manifest-authority.v1',
    evaluator: 'workflow-propose.manifest-authority.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      manifest: binding.manifestDigest,
      investigationTarget: binding.investigationTargetDigest,
      sessionSnapshot: binding.sessionSnapshotDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    runtimeMetadata: {},
    outputSchema: 'investigation.manifest-authority-output.v1',
    output: binding,
  });
  assert.deepEqual(readInvestigationManifestAuthorityNode(node), binding);
  for (const altered of [
    { ...node, output: { ...binding, unexpected: true } },
    {
      ...node,
      exactInputDigests: { ...node.exactInputDigests, manifest: digest('d') },
    },
  ])
    assert.throws(
      () => readInvestigationManifestAuthorityNode(altered),
      code('PLANNING_MATERIALIZATION_STALE', ExitCode.staleState),
    );
  assert.deepEqual(uniqueNodes([node, node]), [node]);
  assert.throws(
    () =>
      uniqueNodes([
        node,
        { ...node, output: { ...binding, sessionRevision: 3 } },
      ]),
    code('INVESTIGATION_EVIDENCE_COLLISION', ExitCode.conflict),
  );
});

const pureEntries = [
  'proposal/plan-review-contracts',
  'proposal/plan-review-grant-authorization',
  'proposal/plan-review-role-topology',
  'proposal/propose-evidence',
  'proposal/propose-investigation-projections',
  'proposal/propose-output',
  'proposal/propose-reviewer-checkpoint',

  'lifecycle/investigation-checkpoint-envelope',
  'investigation/domain/reviewer-term-reopen',
  'lifecycle/investigation-status',
  'lifecycle/planning-transition-result',
  'lifecycle/propose-exemption-session',
  'provider-orchestration/provider-invocation-activity',
  'proposal/propose-input',
  'proposal/propose-types',
  'proposal/propose-values',
  'proposal/role-context-sharing-plan-review',
];
test('all proposal slice owners have pure transitive value and type dependencies', () => {
  for (const entry of pureEntries)
    assert.ok(
      assertPureDependencyClosure(
        path.resolve(import.meta.dirname, `../src/modules/${entry}.ts`),
      ).size >= 1,
    );
});
test('proposal boundaries reject deliberately injected runtime, application and filesystem edges', () => {
  for (const entry of pureEntries) {
    const file = path.resolve(
      import.meta.dirname,
      `../src/modules/${entry}.ts`,
    );
    const runtimeSpecifier = path
      .relative(
        path.dirname(file),
        path.resolve(
          import.meta.dirname,
          '../src/runtime/paths/runtime-paths.ts',
        ),
      )
      .split(path.sep)
      .join('/');
    const applicationSpecifier = path
      .relative(
        path.dirname(file),
        path.resolve(
          import.meta.dirname,
          '../src/application/execute-task/task-strategy-red-revision.ts',
        ),
      )
      .split(path.sep)
      .join('/');
    for (const source of [
      `\nimport type { InvestigationRuntimePaths } from '${runtimeSpecifier}';\n`,
      `\nimport type { createTaskStrategyRedRevisionService } from '${applicationSpecifier}';\n`,
      "\nimport fs from 'node:fs';\n",
    ])
      assert.throws(
        () => assertPureDependencyClosure(file, source),
        /Outward pure dependency|Effect import|Implementation dependency/u,
      );
  }
});
