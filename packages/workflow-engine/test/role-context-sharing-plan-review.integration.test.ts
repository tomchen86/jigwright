import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  canonicalRoleContextSharingGrantPayloadV1,
  type RoleContextSharingGrantEnvelopeV1,
} from '@jigwright/grants/role-context-sharing-degradation';

import {
  createRoleContextSharingPlanReviewRequirementV3,
  deriveRoleContextSharingPlanReviewExpectedBinding,
  reserveRoleContextSharingPlanReview,
} from '../src/application/propose/role-context-sharing-plan-review.ts';
import { completeRoleContextSharingPlanReviewAdmission } from '../src/application/propose/propose-orchestrator.ts';
import { runCli } from '../src/cli.ts';
import { loadChangeContract } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import { productionRoleContextSharingGrantLifecyclePort } from '../src/composition-root/role-context-sharing-grant-lifecycle-production.ts';
import {
  ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_TAG_PREFIX_V1,
  ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1,
  assertRoleContextSharingTerminalReceiptUseBijection,
  canonicalRoleContextSharingTerminalReceiptEnvelopeV1,
  canonicalRoleContextSharingTerminalReceiptPayloadV1,
  listVerifiedRoleContextSharingTerminalReceipts,
  publishRoleContextSharingTerminalReceipt,
  roleContextSharingTerminalReceiptTagRef,
} from '../src/composition-root/role-context-sharing-terminal-receipt-production.ts';
import { productionConsumedPlanReviewReplayPort } from '../src/composition-root/grant-verifier-composition.ts';
import { approveAndStoreRoleContextSharingGrantForCurrentRequirement } from '../src/composition-root/role-context-sharing-grant-approval-production.ts';
import { ExitCode } from '../src/foundation/errors/errors.ts';
import { sealAuthoritativeRoleContextSharingGrantVerifier } from '../src/modules/authority/role-context-sharing-grant-verifier-port.ts';
import { ROLE_CONTEXT_SHARING_POLICY_DIGEST } from '../src/modules/authority/role-context-sharing-grant.ts';
import { createMaintainerAuditTag } from '../src/modules/authority/maintainer-grant.ts';
import { verifyBaseAuthorityAttestations } from '../src/entrypoints/ci/ci-attestation.ts';
import { parseMaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import {
  deriveInvestigationFirstPlanningSubject,
  validateInvestigationFirstPlanningReadiness,
} from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  agentRolePlanDigest,
  type AgentRolePlanBodyV1,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
  resolveRoleTopologyV1,
} from '../src/modules/provider-orchestration/role-topology-resolution.ts';
import {
  admitConsumedRoleContextSharingResultReplay,
  admitRoleContextSharingResult,
} from '../src/modules/provider-orchestration/role-scheduler.ts';
import {
  discoverRepository,
  runGit,
} from '../src/runtime/repository-transaction/git.ts';
import {
  readRoleContextSharingRecord,
  roleContextSharingStorePaths,
  storeAvailableRoleContextSharingGrant,
} from '../src/runtime/storage-journal/role-context-sharing-store.ts';
import {
  createFixtureRepository,
  isWorkflowError,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { createSshSignedFixture } from './support/ssh-signed-fixture.ts';

const GRANT_ID = '12345678-1234-4123-8123-123456789abc';
const APPROVAL_GRANT_ID = '87654321-4321-4321-8321-cba987654321';
const UNLISTED_GRANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-08-21T00:01:00.000Z');

test('planning readiness routes terminal R-007 results through its dedicated replay port', () => {
  const repositoryRoot = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repositoryRoot, 'demo-change');
    const contract = structuredClone(
      loadChangeContract(repositoryRoot, 'demo-change'),
    );
    const subject = deriveInvestigationFirstPlanningSubject(
      repositoryRoot,
      contract,
    ).subject;
    const stored = contract.planReview!.roleResults![0] as Record<
      string,
      unknown
    >;
    stored.schemaVersion = 2;
    stored.form = 'granted-role-context-sharing';
    stored.grantUse = null;
    stored.roleContextSharingUse = {
      kind: 'role-context-sharing-consumed-use.v1',
      expectedBinding: {
        repositoryId: 'github:R_fixture',
        repositoryOrigin: 'https://github.com/example/fixture.git',
        policyBlob: '0'.repeat(40),
        roleContextSharingPolicyDigest: '1'.repeat(64),
        centralRoleConfigurationDigest: '2'.repeat(64),
        changeOverrideDigest: '3'.repeat(64),
        providerRegistryDigest: '4'.repeat(64),
        eligibilityPolicyDigest: '5'.repeat(64),
        changeId: contract.changeId,
        taskId: null,
        baselineCommit: subject.investigationBaseline.head,
        baselineTree: subject.investigationBaseline.tree,
        targetDigest: subject.subjectDigest,
        lifecyclePhase: 'plan-review',
        subjectDigest: subject.subjectDigest,
        planningGeneration: subject.planningGenerationId,
        rolePairs: ['author-reviewer'],
        contextGeneration: 1,
        sessionGeneration: 1,
        sharedEngineSessionId: 'fixture-shared-session',
        providerDefinitionDigest: '6'.repeat(64),
        reason: 'Exercise the dedicated terminal replay port.',
      },
    };
    let replayCalls = 0;
    const replaySentinel = new Error('r007-replay-port-called');

    assert.throws(
      () =>
        validateInvestigationFirstPlanningReadiness(repositoryRoot, contract, {
          verify() {
            throw new Error('legacy Collaboration replay must not run');
          },
          verifyRoleContextSharing() {
            replayCalls += 1;
            throw replaySentinel;
          },
        } as never),
      (error) => error === replaySentinel,
    );
    assert.equal(replayCalls, 1);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('R-007 reserve precedes launch, exact result consumes once, and crash replay is receipt-idempotent', (t) => {
  const repositoryRoot = createFixtureRepository();
  const ssh = createSshSignedFixture('fixture-maintainer');
  const untrustedSsh = createSshSignedFixture('untrusted-maintainer');
  t.after(() => {
    untrustedSsh.dispose();
    ssh.dispose();
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  });
  fs.mkdirSync(`${repositoryRoot}/workflow`, { recursive: true });
  fs.writeFileSync(
    `${repositoryRoot}/workflow/maintainer-policy.json`,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: {
          id: 'github:R_fixture',
          origin: 'https://github.com/example/fixture.git',
        },
        phase: 'sealed',
        auditTagPrefix: 'refs/tags/workflow-grant/',
        signatureNamespace: 'workflow.maintainer-grant.v1',
        maxTtlMinutes: 30,
        maxUses: 1,
        bootstrapEligiblePaths: ['workflow/protected-capabilities.json'],
        sealedImmutablePaths: ['workflow/protected-capabilities.json'],
        requiredChecks: ['fixture'],
        trustedSigners: [ssh.trustedSigner],
      },
      null,
      2,
    )}\n`,
  );
  runGit(repositoryRoot, ['add', 'workflow/maintainer-policy.json']);
  runGit(repositoryRoot, ['commit', '-m', 'Add fixture maintainer policy']);
  const repository = discoverRepository(repositoryRoot);
  fs.chmodSync(repository.gitCommonDirectory, 0o700);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  const baselineTree = runGit(repositoryRoot, [
    'rev-parse',
    `${repository.head}^{tree}`,
  ]).trim();
  const planningGeneration = '1'.repeat(64);
  const providerDefinitionDigest = '2'.repeat(64);
  const rolePlanBody: AgentRolePlanBodyV1 = {
    schemaVersion: 1,
    changeId: 'r007-plan-review',
    planningGeneration,
    roleLanes: [],
    pairwiseRequirements: [
      { pair: 'author-reviewer', required: 'session-independent' },
    ],
    customWrapperPolicy: 'forbidden',
    grantReferences: [GRANT_ID, APPROVAL_GRANT_ID],
  };
  const roleTopology = resolveRoleTopologyV1({
    changeId: rolePlanBody.changeId,
    planningGeneration,
    centralConfiguration: CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
    changeOverride: {
      ...rolePlanBody,
      planDigest: agentRolePlanDigest(rolePlanBody),
    },
    providerRegistry: {
      schemaVersion: 1,
      policyDigest: '3'.repeat(64),
      providers: [
        {
          logicalProviderId: 'codex',
          providerFamily: 'codex',
          enabled: true,
          definitionDigest: providerDefinitionDigest,
        },
      ],
    },
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'codex',
        providerDefinitionDigest,
        sessionId: 'author-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'codex',
        providerDefinitionDigest,
        sessionId: 'reviewer-session',
      },
    ],
  });
  assert.equal(roleTopology.disposition, 'exact-grant-required');
  assert.deepEqual(roleTopology.exactGrantRolePairs, ['author-reviewer']);
  const subject = {
    schemaVersion: 1 as const,
    subjectDigest: '4'.repeat(64),
    planningGenerationId: planningGeneration,
    planTargetDigest: '5'.repeat(64),
    manifestDigest: '7'.repeat(64),
    investigationTargetDigest: '8'.repeat(64),
    reviewPolicyDigest: '6'.repeat(64),
    requiredIndependence: 'provider-independent' as const,
    investigationBaseline: { head: repository.head, tree: baselineTree },
    investigationDependencies: [],
    investigationRequirements: [],
  };
  const requirement = createRoleContextSharingPlanReviewRequirementV3({
    investigationId: 'investigation-r007',
    changeId: rolePlanBody.changeId,
    baseline: { head: repository.head, tree: baselineTree },
    subject,
    author: {
      providerId: 'codex',
      sessionId: 'author-session',
      principalId: null,
      identityAssurance: 'adapter-assigned',
      engineSpawned: false,
    },
    roleTopology,
    contextGeneration: 1,
  });
  const policyBlob = runGit(repositoryRoot, [
    'rev-parse',
    `${repository.head}:workflow/maintainer-policy.json`,
  ]).trim();
  const expected = deriveRoleContextSharingPlanReviewExpectedBinding({
    requirement,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob,
    reason: 'Approve this exact PlanReview context-sharing placement.',
  });
  const payload: RoleContextSharingGrantEnvelopeV1['payload'] = {
    version: 1,
    signatureNamespace: ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
    grantId: GRANT_ID,
    ...expected,
    authorizedEffect: ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
    issuedAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-21T00:30:00.000Z',
    maxUses: 1,
    signer: policy.trustedSigners[0]!.identity,
  };
  const envelope: RoleContextSharingGrantEnvelopeV1 = {
    payload,
    signature: ssh.sign(
      canonicalRoleContextSharingGrantPayloadV1(payload),
      ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
    ),
  };
  assert.equal(
    envelope.payload.roleContextSharingPolicyDigest,
    ROLE_CONTEXT_SHARING_POLICY_DIGEST,
  );
  storeAvailableRoleContextSharingGrant(
    repository.gitCommonDirectory,
    envelope,
  );
  const verifierCalls: string[] = [];
  const verifier = sealAuthoritativeRoleContextSharingGrantVerifier(
    {
      assertCurrent() {
        verifierCalls.push('current');
      },
      verify() {
        verifierCalls.push('verify');
      },
    },
    `sha256:${'7'.repeat(64)}`,
  );

  assert.throws(
    () =>
      reserveRoleContextSharingPlanReview({
        gitCommonDirectory: repository.gitCommonDirectory,
        requirementNodeId: '8'.repeat(64),
        requirement,
        grantId: UNLISTED_GRANT_ID,
        policy,
        policyBlob,
        verifier,
        lifecycle: productionRoleContextSharingGrantLifecyclePort,
        now: NOW,
        assertOwned() {},
      }),
    (error) => isWorkflowError(error, 'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE'),
  );
  const events: string[] = [];
  const reserved = reserveRoleContextSharingPlanReview({
    gitCommonDirectory: repository.gitCommonDirectory,
    requirementNodeId: '8'.repeat(64),
    requirement,
    grantId: GRANT_ID,
    policy,
    policyBlob,
    verifier,
    lifecycle: productionRoleContextSharingGrantLifecyclePort,
    now: NOW,
    assertOwned() {},
  });
  events.push('reserved');
  const launch = () => {
    assert.equal(
      readRoleContextSharingRecord(repository.gitCommonDirectory, GRANT_ID)
        .state,
      'reserved',
    );
    events.push('launched');
  };
  launch();
  assert.deepEqual(events, ['reserved', 'launched']);

  const content = {
    kind: 'plan-review' as const,
    nodeId: 'b'.repeat(64),
    resultDigest: 'c'.repeat(64),
    outputSchema: {
      id: 'workflow.plan-review-output',
      version: 1,
      digest: 'd'.repeat(64),
    },
    evaluator: 'workflow-propose.v1',
    policyDigest: 'e'.repeat(64),
    contentDigest: 'c'.repeat(64),
    current: true as const,
  };
  const providerInvocation = {
    invocationId: 'invocation-r007',
    requestDigest: '9'.repeat(64),
    outputDigest: 'f'.repeat(64),
    providerId: reserved.assignment.providerId,
    sessionId: reserved.assignment.sessionId,
    targetDigest: reserved.assignment.targetDigest,
    engineSpawned: true as const,
  };
  const recordPath = `${roleContextSharingStorePaths(repository.gitCommonDirectory).records}/${GRANT_ID}.json`;
  const reservedBytes = fs.readFileSync(recordPath);
  assert.throws(
    () =>
      productionConsumedPlanReviewReplayPort.verifyRoleContextSharing({
        repositoryRoot,
        evidence: {
          kind: 'role-context-sharing-consumed-use.v1',
          grantId: GRANT_ID,
          envelope,
          expectedBinding: expected,
          reservationReceiptDigest:
            reserved.assignment.reservationReceiptDigest,
          terminalReceiptDigest: '0'.repeat(64),
          terminalRecordDigest: reserved.record.recordDigest,
          use: {},
          useProjectionDigest: '0'.repeat(64),
        } as never,
        assignment: reserved.assignment,
        author: requirement.author,
        participant: {
          providerId: reserved.assignment.providerId,
          sessionId: reserved.assignment.sessionId,
          principalId: null,
          identityAssurance: 'adapter-assigned',
          engineSpawned: true,
        },
        content,
        providerInvocation,
      }),
    (error) =>
      isWorkflowError(
        error,
        'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_UNAVAILABLE',
      ),
  );
  assert.deepEqual(fs.readFileSync(recordPath), reservedBytes);
  assert.throws(
    () =>
      completeRoleContextSharingPlanReviewAdmission({
        gitCommonDirectory: repository.gitCommonDirectory,
        requirement,
        authorization: reserved.authorization,
        assignment: reserved.assignment,
        author: requirement.author,
        content: { ...content, contentDigest: '0'.repeat(64) },
        providerInvocation,
        policy,
        verifier,
        lifecycle: productionRoleContextSharingGrantLifecyclePort,
        now: NOW,
        assertOwned() {},
      }),
    (error) => isWorkflowError(error, 'ROLE_RESULT_INVALID'),
  );
  assert.deepEqual(fs.readFileSync(recordPath), reservedBytes);
  const completed = completeRoleContextSharingPlanReviewAdmission({
    gitCommonDirectory: repository.gitCommonDirectory,
    requirement,
    authorization: reserved.authorization,
    assignment: reserved.assignment,
    author: requirement.author,
    content,
    providerInvocation,
    policy,
    verifier,
    lifecycle: productionRoleContextSharingGrantLifecyclePort,
    now: NOW,
    assertOwned() {},
  });
  const consumed = completed.consumed;
  assert.equal(consumed.record.state, 'consumed');
  assert.equal(consumed.record.receiptDigests.length, 2);
  assert.equal(completed.roleResult.schemaVersion, 2);
  assert.equal(completed.roleResult.form, 'granted-role-context-sharing');
  if (completed.roleResult.form !== 'granted-role-context-sharing') {
    throw new Error('Expected one role-context-sharing result.');
  }
  const terminalRoleResult = completed.roleResult;
  assert.equal(completed.roleResult.grantUse, null);
  assert.equal(
    completed.roleResult.roleContextSharingUse.grantId,
    reserved.assignment.roleContextSharingGrantId,
  );
  assert.equal(
    completed.roleResult.roleContextSharingUse.useProjectionDigest,
    consumed.useProjectionDigest,
  );

  const terminalBytes = fs.readFileSync(recordPath);
  assert.throws(
    () =>
      productionConsumedPlanReviewReplayPort.verifyRoleContextSharing({
        repositoryRoot,
        evidence: terminalRoleResult.roleContextSharingUse,
        assignment: terminalRoleResult.assignment,
        author: terminalRoleResult.author,
        participant: terminalRoleResult.participant,
        content: terminalRoleResult.content,
        providerInvocation: terminalRoleResult.providerInvocation,
      }),
    (error) =>
      isWorkflowError(
        error,
        'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_UNAVAILABLE',
      ),
  );
  const publishedReceipt = publishRoleContextSharingTerminalReceipt(
    repositoryRoot,
    GRANT_ID,
    {
      now: new Date('2026-08-21T00:02:00.000Z'),
      signer: ssh.signer(),
      interactiveContext: {
        stdinIsTty: true,
        stdoutIsTty: true,
        stderrIsTty: true,
      },
    },
  );
  assert.equal(
    publishedReceipt.tagRef,
    `refs/tags/workflow-grant/role-context-sharing-use-${GRANT_ID}`,
  );
  assert.equal(publishedReceipt.target, repository.head);
  assert.throws(
    () =>
      canonicalRoleContextSharingTerminalReceiptPayloadV1({
        ...structuredClone(publishedReceipt.envelope.payload),
        admissionDigest: '0'.repeat(64),
      }),
    (error) =>
      isWorkflowError(error, 'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_INVALID'),
  );
  const receiptTagName = publishedReceipt.tagRef.slice('refs/tags/'.length);
  runGit(repositoryRoot, ['tag', '-d', receiptTagName]);
  runGit(repositoryRoot, [
    'commit',
    '--allow-empty',
    '-m',
    'Create a wrong receipt target',
  ]);
  const wrongTarget = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  createMaintainerAuditTag(
    repositoryRoot,
    wrongTarget,
    publishedReceipt.tagRef,
    canonicalRoleContextSharingTerminalReceiptEnvelopeV1(
      publishedReceipt.envelope,
    ),
    publishedReceipt.envelope.payload.signer,
  );
  assert.throws(
    () =>
      productionConsumedPlanReviewReplayPort.verifyRoleContextSharing({
        repositoryRoot,
        evidence: terminalRoleResult.roleContextSharingUse,
        assignment: terminalRoleResult.assignment,
        author: terminalRoleResult.author,
        participant: terminalRoleResult.participant,
        content: terminalRoleResult.content,
        providerInvocation: terminalRoleResult.providerInvocation,
      }),
    (error) =>
      isWorkflowError(error, 'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_INVALID'),
  );
  runGit(repositoryRoot, ['tag', '-d', receiptTagName]);
  const untrustedPayload = {
    ...structuredClone(publishedReceipt.envelope.payload),
    signer: untrustedSsh.trustedSigner.identity,
  };
  const untrustedEnvelope = {
    payload: untrustedPayload,
    signature: untrustedSsh.sign(
      canonicalRoleContextSharingTerminalReceiptPayloadV1(untrustedPayload),
      ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1,
    ),
  };
  createMaintainerAuditTag(
    repositoryRoot,
    repository.head,
    publishedReceipt.tagRef,
    canonicalRoleContextSharingTerminalReceiptEnvelopeV1(untrustedEnvelope),
    untrustedPayload.signer,
  );
  assert.throws(
    () =>
      productionConsumedPlanReviewReplayPort.verifyRoleContextSharing({
        repositoryRoot,
        evidence: terminalRoleResult.roleContextSharingUse,
        assignment: terminalRoleResult.assignment,
        author: terminalRoleResult.author,
        participant: terminalRoleResult.participant,
        content: terminalRoleResult.content,
        providerInvocation: terminalRoleResult.providerInvocation,
      }),
    (error) =>
      isWorkflowError(error, 'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_INVALID'),
  );
  runGit(repositoryRoot, ['tag', '-d', receiptTagName]);
  createMaintainerAuditTag(
    repositoryRoot,
    repository.head,
    publishedReceipt.tagRef,
    canonicalRoleContextSharingTerminalReceiptEnvelopeV1(
      publishedReceipt.envelope,
    ),
    publishedReceipt.envelope.payload.signer,
  );
  const receiptUseIdentity = {
    grantId: terminalRoleResult.roleContextSharingUse.grantId,
    signedEnvelopeDigest: publishedReceipt.envelope.payload.grantEnvelopeDigest,
    transitionDigest:
      terminalRoleResult.roleContextSharingUse.expectedBinding.targetDigest,
    useProjectionDigest:
      terminalRoleResult.roleContextSharingUse.useProjectionDigest,
    admissionDigest:
      terminalRoleResult.roleContextSharingUse.use.admissionDigest,
  };
  const verifiedReceipts =
    listVerifiedRoleContextSharingTerminalReceipts(repositoryRoot);
  assert.equal(verifiedReceipts.length, 1);
  assert.doesNotThrow(() =>
    assertRoleContextSharingTerminalReceiptUseBijection(verifiedReceipts, [
      receiptUseIdentity,
    ]),
  );
  assert.throws(
    () =>
      assertRoleContextSharingTerminalReceiptUseBijection(verifiedReceipts, []),
    (error) =>
      isWorkflowError(
        error,
        'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_BIJECTION_INVALID',
      ),
  );

  const transitionedPolicy = JSON.parse(
    fs.readFileSync(
      `${repositoryRoot}/workflow/maintainer-policy.json`,
      'utf8',
    ),
  ) as { auditTagPrefix: string };
  transitionedPolicy.auditTagPrefix = 'refs/tags/workflow-authority/';
  fs.writeFileSync(
    `${repositoryRoot}/workflow/maintainer-policy.json`,
    `${JSON.stringify(transitionedPolicy, null, 2)}\n`,
  );
  runGit(repositoryRoot, ['add', 'workflow/maintainer-policy.json']);
  runGit(repositoryRoot, ['commit', '-m', 'Transition fixture audit prefix']);
  const transitionedHead = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  assert.equal(
    roleContextSharingTerminalReceiptTagRef(GRANT_ID),
    publishedReceipt.tagRef,
  );
  const transitionedReceipts =
    listVerifiedRoleContextSharingTerminalReceipts(repositoryRoot);
  assert.equal(transitionedReceipts.length, 1);
  assert.doesNotThrow(() =>
    assertRoleContextSharingTerminalReceiptUseBijection(transitionedReceipts, [
      receiptUseIdentity,
    ]),
  );
  assert.throws(
    () =>
      assertRoleContextSharingTerminalReceiptUseBijection(
        transitionedReceipts,
        [],
      ),
    (error) =>
      isWorkflowError(
        error,
        'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_BIJECTION_INVALID',
      ),
  );
  assert.doesNotThrow(() =>
    verifyBaseAuthorityAttestations(repositoryRoot, transitionedHead, NOW),
  );

  const malformedReceiptRef = `${ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_TAG_PREFIX_V1}malformed`;
  createMaintainerAuditTag(
    repositoryRoot,
    repository.head,
    malformedReceiptRef,
    canonicalRoleContextSharingTerminalReceiptEnvelopeV1(
      publishedReceipt.envelope,
    ),
    publishedReceipt.envelope.payload.signer,
  );
  assert.throws(
    () =>
      verifyBaseAuthorityAttestations(repositoryRoot, transitionedHead, NOW),
    (error) =>
      isWorkflowError(error, 'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_INVALID'),
  );
  runGit(repositoryRoot, [
    'tag',
    '-d',
    malformedReceiptRef.slice('refs/tags/'.length),
  ]);
  fs.rmSync(recordPath);
  const terminalProof =
    productionConsumedPlanReviewReplayPort.verifyRoleContextSharing({
      repositoryRoot,
      evidence: terminalRoleResult.roleContextSharingUse,
      assignment: terminalRoleResult.assignment,
      author: terminalRoleResult.author,
      participant: terminalRoleResult.participant,
      content: terminalRoleResult.content,
      providerInvocation: terminalRoleResult.providerInvocation,
    });
  const terminalReplayed = admitConsumedRoleContextSharingResultReplay({
    assignment: terminalRoleResult.assignment,
    author: terminalRoleResult.author,
    participant: terminalRoleResult.participant,
    content: terminalRoleResult.content,
    providerInvocation: terminalRoleResult.providerInvocation,
    replay: terminalProof,
  });
  assert.equal(
    terminalReplayed.resultDigest,
    completed.roleResult.resultDigest,
  );
  assert.equal(fs.existsSync(recordPath), false);
  const exactReplayAdmission = {
    assignment: terminalRoleResult.assignment,
    author: terminalRoleResult.author,
    participant: terminalRoleResult.participant,
    content: terminalRoleResult.content,
    providerInvocation: terminalRoleResult.providerInvocation,
  };
  const reboundAdmissions = [
    {
      label: 'content',
      ...exactReplayAdmission,
      content: {
        ...terminalRoleResult.content,
        resultDigest: '0'.repeat(64),
        contentDigest: '0'.repeat(64),
      },
    },
    {
      label: 'provider output',
      ...exactReplayAdmission,
      providerInvocation: {
        ...terminalRoleResult.providerInvocation,
        outputDigest: '0'.repeat(64),
      },
    },
    {
      label: 'author',
      ...exactReplayAdmission,
      author: {
        ...terminalRoleResult.author,
        principalId: 'forged-author',
      },
    },
    {
      label: 'participant',
      ...exactReplayAdmission,
      participant: {
        ...terminalRoleResult.participant,
        principalId: 'forged-reviewer',
      },
    },
  ] as const;
  for (const { label: _label, ...rebound } of reboundAdmissions) {
    assert.throws(
      () => {
        const reboundProof =
          productionConsumedPlanReviewReplayPort.verifyRoleContextSharing({
            repositoryRoot,
            evidence: terminalRoleResult.roleContextSharingUse,
            ...rebound,
          });
        admitConsumedRoleContextSharingResultReplay({
          ...rebound,
          replay: reboundProof,
        });
      },
      (error) =>
        isWorkflowError(error, 'ROLE_CONTEXT_SHARING_GRANT_REPLAY_INVALID'),
      `terminal replay must not re-mint for changed ${_label}`,
    );
  }
  assert.throws(
    () =>
      admitConsumedRoleContextSharingResultReplay({
        assignment: terminalRoleResult.assignment,
        author: terminalRoleResult.author,
        participant: terminalRoleResult.participant,
        content: {
          ...terminalRoleResult.content,
          resultDigest: '0'.repeat(64),
        },
        providerInvocation: terminalRoleResult.providerInvocation,
        replay: terminalProof,
      }),
    (error) =>
      isWorkflowError(error, 'ROLE_CONTEXT_SHARING_GRANT_REPLAY_INVALID'),
  );
  const forgedEvidence = {
    ...structuredClone(terminalRoleResult.roleContextSharingUse),
    envelope: {
      ...structuredClone(terminalRoleResult.roleContextSharingUse.envelope),
      signature: 'forged-signature',
    },
  };
  assert.throws(
    () =>
      productionConsumedPlanReviewReplayPort.verifyRoleContextSharing({
        repositoryRoot,
        evidence: forgedEvidence,
        assignment: terminalRoleResult.assignment,
        author: terminalRoleResult.author,
        participant: terminalRoleResult.participant,
        content: terminalRoleResult.content,
        providerInvocation: terminalRoleResult.providerInvocation,
      }),
    (error) =>
      isWorkflowError(error, 'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_INVALID'),
  );
  assert.equal(fs.existsSync(recordPath), false);

  assert.throws(
    () =>
      admitRoleContextSharingResult({
        assignment: reserved.assignment,
        author: requirement.author,
        participant: {
          providerId: reserved.assignment.providerId,
          sessionId: reserved.assignment.sessionId,
          principalId: null,
          identityAssurance: 'adapter-assigned',
          engineSpawned: true,
        },
        content,
        providerInvocation,
        // A legacy Collaboration grantUse cannot stand in for R-007 evidence.
        consumedUse: undefined as never,
        grantUse: consumed.evidence,
      } as Parameters<typeof admitRoleContextSharingResult>[0]),
    (error) => isWorkflowError(error, 'ROLE_RESULT_INVALID'),
  );

  const driftedVerifier = sealAuthoritativeRoleContextSharingGrantVerifier(
    {
      assertCurrent() {
        throw new Error('terminal replay must not touch verifier');
      },
      verify() {
        throw new Error('terminal replay must not verify twice');
      },
    },
    `sha256:${'a'.repeat(64)}`,
  );
  fs.writeFileSync(recordPath, terminalBytes, { mode: 0o600 });
  const replayed = completeRoleContextSharingPlanReviewAdmission({
    gitCommonDirectory: repository.gitCommonDirectory,
    requirement,
    authorization: reserved.authorization,
    assignment: reserved.assignment,
    author: requirement.author,
    content,
    providerInvocation,
    policy,
    verifier: driftedVerifier,
    lifecycle: productionRoleContextSharingGrantLifecyclePort,
    now: NOW,
    assertOwned() {},
  });
  assert.equal(
    replayed.consumed.record.recordDigest,
    consumed.record.recordDigest,
  );
  assert.deepEqual(
    replayed.consumed.record.receiptDigests,
    consumed.record.receiptDigests,
  );
  assert.equal(
    replayed.roleResult.resultDigest,
    completed.roleResult.resultDigest,
  );
  assert.deepEqual(verifierCalls, [
    'current',
    'current',
    'verify',
    'current',
    'current',
    'verify',
  ]);

  const candidate = {
    requirementNodeId: '8'.repeat(64),
    grantId: APPROVAL_GRANT_ID,
    reason: 'Approve this exact human R-007 import for PlanReview.',
    ttlMinutes: 15,
  };
  const humanSignerEvents: string[] = [];
  const humanSigner = {
    assertHumanPresent() {
      humanSignerEvents.push('human');
    },
    identity() {
      return policy.trustedSigners[0]!.identity;
    },
    sign() {
      humanSignerEvents.push('sign');
      return 'human-fixture-signature';
    },
    verify() {
      humanSignerEvents.push('verify');
    },
  };
  const approvalVerifier = sealAuthoritativeRoleContextSharingGrantVerifier(
    { assertCurrent() {}, verify() {} },
    `sha256:${'0'.repeat(64)}`,
  );
  const approvalBase = {
    repositoryRoot,
    gitCommonDirectory: repository.gitCommonDirectory,
    requirement,
    policy,
    policyBlob,
  };
  assert.throws(
    () =>
      approveAndStoreRoleContextSharingGrantForCurrentRequirement({
        ...approvalBase,
        candidate,
        options: {
          now: NOW,
          signer: humanSigner,
          verifier: approvalVerifier,
          interactiveContext: {
            stdinIsTty: false,
            stdoutIsTty: true,
            stderrIsTty: true,
          },
        },
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_INTERACTIVE_REQUIRED'),
  );
  assert.throws(
    () =>
      approveAndStoreRoleContextSharingGrantForCurrentRequirement({
        ...approvalBase,
        candidate: { ...candidate, grantId: UNLISTED_GRANT_ID },
      }),
    (error) => isWorkflowError(error, 'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE'),
  );
  const approved = approveAndStoreRoleContextSharingGrantForCurrentRequirement({
    ...approvalBase,
    candidate,
    options: {
      now: NOW,
      signer: humanSigner,
      verifier: approvalVerifier,
      interactiveContext: {
        stdinIsTty: true,
        stdoutIsTty: true,
        stderrIsTty: true,
      },
    },
  });
  assert.equal(approved.record.state, 'available');
  assert.equal(approved.envelope.payload.grantId, APPROVAL_GRANT_ID);
  assert.deepEqual(humanSignerEvents, ['human', 'sign', 'verify']);
  assert.throws(
    () =>
      approveAndStoreRoleContextSharingGrantForCurrentRequirement({
        ...approvalBase,
        candidate,
        options: {
          now: NOW,
          signer: humanSigner,
          verifier: approvalVerifier,
          interactiveContext: {
            stdinIsTty: true,
            stdoutIsTty: true,
            stderrIsTty: true,
          },
        },
      }),
    (error: unknown) =>
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ROLE_CONTEXT_SHARING_JOURNAL_UNAVAILABLE',
  );
  assert.equal(
    readRoleContextSharingRecord(
      repository.gitCommonDirectory,
      APPROVAL_GRANT_ID,
    ).recordDigest,
    approved.record.recordDigest,
  );
});

test('CLI keeps old Collaboration --grant distinct from --role-context-grant', () => {
  const repository = createFixtureRepository();
  const originalWrite = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(
      runCli(
        [
          'maintainer',
          'role-context-sharing-grant',
          'publish-terminal-receipt',
          '--grant',
          GRANT_ID,
        ],
        repository,
      ),
      ExitCode.verification,
    );
    assert.equal(
      runCli(
        [
          'propose',
          'r007-plan-review',
          '--resume',
          '--input',
          '/does/not/exist.json',
          '--grant',
          GRANT_ID,
          '--role-context-grant',
          GRANT_ID,
        ],
        repository,
      ),
      ExitCode.usage,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
});
