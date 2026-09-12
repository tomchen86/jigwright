/** Ordinary/degraded role scheduling and structured collaboration Grant content use. */
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import {
  git,
  isWorkflowError,
  authoritativeCollaborationGrantVerifierForTest,
} from './fixture.ts';
import {
  startPropose,
  createPlanningContributionEnvelope,
  resumePropose,
} from '../src/composition-root/propose-production.ts';
import assert from 'node:assert/strict';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { readProviderInvocationRequest } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  authorizeGrantedOrdinaryRole,
  admitRoleResult,
} from '../src/composition-root/role-admission-production.ts';
import { scheduleOrdinaryRole } from '../src/modules/provider-orchestration/role-assignment.ts';
import type { RoleParticipant } from '../src/modules/provider-orchestration/role-assignment.ts';
import {
  DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import {
  canonicalDirectHumanReviewPayload,
  canonicalDirectHumanReviewAttestation,
  parseDirectHumanReviewAttestation,
  directHumanReviewAttestationDigest,
  assertUniqueCollaborationGrantUses,
} from '../src/runtime/grants/grant-services.ts';
import { createDirectHumanReviewAttestation } from '../src/runtime/grants/collaboration-grant-issuance.ts';
import { COLLABORATION_GRANT_AUTHORIZED_EFFECT } from '../src/modules/authority/collaboration-grant-codec.ts';
import { consumeCollaborationGrant } from '../src/runtime/storage-journal/collaboration-grant-consumption.ts';
import {
  validateCollaborationGrantUseProjection,
  validateCollaborationGrantUseSet,
} from '../src/runtime/grants/grant-services.ts';
import { inspectCollaborationGrants } from '../src/runtime/storage-journal/collaboration-grant-records.ts';
import { assertUniqueGrantUseClaimsV1 } from '@jigwright/grants/grant-lifecycle';
import {
  collaborationFixture,
  reservedFixture,
  TARGET_DIGEST,
  GRANT_ID,
  TRANSITION_DIGEST,
  CONTENT_NODE_ID,
  CONTENT_RESULT_DIGEST,
  NOW,
  POLICY,
  fixtureSignature,
  expectedBinding,
} from './collaboration-grant-signed-fixture.ts';
import {
  participant,
  roleContent,
} from './collaboration-grant-role-fixture.ts';

test('propose uses one provider across fresh Author and Reviewer sessions without a grant', () => {
  const repository = collaborationFixture();
  const changeId = 'single-provider-propose';
  try {
    const adapterPolicyPath = path.join(
      repository,
      'workflow/ai-adapter-policy.json',
    );
    const adapterPolicy = JSON.parse(
      fs.readFileSync(adapterPolicyPath, 'utf8'),
    ) as { providers: { claude: { enabled: boolean } } };
    adapterPolicy.providers.claude.enabled = false;
    fs.writeFileSync(
      adapterPolicyPath,
      `${JSON.stringify(adapterPolicy, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(repository, 'src/granted-survey-target.ts'),
      'export const GrantedSurveyNeedle = true;\n',
    );
    git(repository, [
      'add',
      'workflow/ai-adapter-policy.json',
      'src/granted-survey-target.ts',
    ]);
    git(repository, [
      'commit',
      '-m',
      'Prepare single-provider propose fixture',
    ]);
    git(repository, ['checkout', '-b', `work/${changeId}`]);

    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Extend the survey target.',
        sourceRefs: [],
        explicitPaths: ['src/granted-survey-target.ts'],
        explicitSymbols: ['GrantedSurveyNeedle'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      { explicitActor: 'codex', environment: {} },
    );
    assert.equal(started.state, 'awaiting-main-terms');
    assert.equal(started.investigation?.provider.providerId, 'codex');
    const runtime = investigationRuntimePaths(
      fs.realpathSync(path.join(repository, '.git')),
      'workflow-engine',
    );
    const providerRequest = readProviderInvocationRequest(
      runtime,
      started.investigation!.providerInvocationId,
    );
    assert.equal(providerRequest.roleAssignment.role, 'plan-reviewer');
    assert.equal(providerRequest.roleAssignment.providerId, 'codex');
    assert.equal(
      providerRequest.roleAssignment.requiredIndependence,
      'session-independent',
    );
    assert.equal(
      providerRequest.roleAssignment.achievedIndependence,
      'session-independent',
    );
    assert.equal('grantId' in providerRequest.roleAssignment, false);
    assert.notEqual(providerRequest.roleAssignment.sessionId, 'author-codex');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('exact PlanReview preserves materialized planning while using a fresh same-provider Reviewer session', () => {
  const repository = collaborationFixture();
  const changeId = 'granted-plan-review';
  try {
    const adapterPolicyPath = path.join(
      repository,
      'workflow/ai-adapter-policy.json',
    );
    const adapterPolicy = JSON.parse(
      fs.readFileSync(adapterPolicyPath, 'utf8'),
    ) as { providers: { claude: { enabled: boolean } } };
    adapterPolicy.providers.claude.enabled = false;
    fs.writeFileSync(
      adapterPolicyPath,
      `${JSON.stringify(adapterPolicy, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/granted-review.md'),
      '# Granted review\n',
    );
    git(repository, [
      'add',
      'workflow/ai-adapter-policy.json',
      'docs/granted-review.md',
    ]);
    git(repository, ['commit', '-m', 'Prepare granted review fixture']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);

    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        kind: 'investigation-exemption-request',
        intent: {
          schemaVersion: 1,
          summary: 'Clarify granted review documentation.',
          sourceRefs: [],
          explicitPaths: ['docs/granted-review.md'],
          explicitSymbols: [],
          explicitConfigKeys: [],
          renamePairs: [],
        },
        exemption: {
          category: 'documentation-only',
          declaredPaths: ['docs/granted-review.md'],
          declaredChangeClasses: ['documentation-only'],
          rationale: 'The change is limited to tracked documentation wording.',
          semanticAuthor: {
            id: 'codex',
            provenance: 'runtime-hint:codex',
          },
          nonTrivialBehaviorReliance: 'none-declared',
          researchBudgetMinutes: null,
        },
      },
      { explicitActor: 'codex', environment: {} },
    );
    const planning = createPlanningContributionEnvelope(started, {
      proposal: '# Proposal\n\nClarify granted review documentation.\n',
      design: '# Design\n\nUpdate documentation wording only.\n',
      specs: [
        {
          path: 'specs/demo/spec.md',
          content: [
            '# Delta',
            '',
            '## ADDED Requirements',
            '',
            '### Requirement: Granted review wording',
            '',
            'The guide SHALL remain clear.',
            '',
            '#### Scenario: Reader opens the guide',
            '',
            '- **WHEN** the guide is read',
            '- **THEN** the wording is clear',
            '',
          ].join('\n'),
        },
      ],
      tasks: '# Tasks\n\n- [ ] 1.1 Clarify granted review documentation\n',
      guard: {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['docs/granted-review.md'],
            requiredChecks: ['fixture'],
          },
        },
      },
      executionTasks: {
        '1.1': {
          strategy: 'direct-reviewed',
          enforcement: 'available',
          allowedPaths: ['docs/granted-review.md'],
          requiredChecks: ['fixture'],
          diffReview: 'policy-required',
          exemptionKind: 'documentation-only',
          exemptionReason: 'The task edits documentation only.',
        },
      },
    });
    const waiting = resumePropose(repository, changeId, planning);
    assert.equal(waiting.state, 'waiting-for-plan-review');
    assert.equal(waiting.planReview?.providerId, 'codex');
    assert.equal(
      fs.existsSync(
        path.join(repository, 'openspec/changes', changeId, 'proposal.md'),
      ),
      true,
    );
    const paths = investigationRuntimePaths(
      fs.realpathSync(path.join(repository, '.git')),
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(
      paths,
      waiting.planReview!.invocationId,
    );
    assert.equal(request.roleAssignment.role, 'plan-reviewer');
    assert.equal(request.roleAssignment.providerId, 'codex');
    assert.equal(
      request.roleAssignment.requiredIndependence,
      'session-independent',
    );
    assert.equal(
      request.roleAssignment.achievedIndependence,
      'session-independent',
    );
    assert.equal('grantId' in request.roleAssignment, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('same-provider grants require the only callable provider and a fresh engine session', () => {
  const fixture = reservedFixture('same-provider-fresh-session');
  try {
    const author = participant('codex', 'author-session');
    const assigned = authorizeGrantedOrdinaryRole({
      role: 'plan-reviewer',
      author,
      targetDigest: TARGET_DIGEST,
      reservation: fixture.reservation,
      actualParticipant: participant('codex', 'fresh-session'),
      callableProviderIds: ['codex'],
    });
    assert.deepEqual(
      {
        providerId: assigned.providerId,
        sessionId: assigned.sessionId,
        engineSpawned: assigned.engineSpawned,
        requiredIndependence: assigned.requiredIndependence,
        achievedIndependence: assigned.achievedIndependence,
        providerIndependent: assigned.providerIndependent,
        sessionIndependent: assigned.sessionIndependent,
        orchestration: assigned.orchestration,
      },
      {
        providerId: 'codex',
        sessionId: 'fresh-session',
        engineSpawned: true,
        requiredIndependence: 'provider-independent',
        achievedIndependence: 'session-independent',
        providerIndependent: false,
        sessionIndependent: true,
        orchestration: 'engine-spawned-provider',
      },
    );
    for (const invalid of [
      {
        actualParticipant: participant('codex', 'author-session'),
        callableProviderIds: ['codex'] as const,
      },
      {
        actualParticipant: participant('claude', 'fresh-session'),
        callableProviderIds: ['codex', 'claude'] as const,
      },
      {
        actualParticipant: participant('codex', 'fresh-session'),
        callableProviderIds: ['codex', 'claude'] as const,
      },
      {
        actualParticipant: {
          ...participant('codex', 'fresh-session'),
          engineSpawned: false,
        },
        callableProviderIds: ['codex'] as const,
      },
    ]) {
      assert.throws(
        () =>
          authorizeGrantedOrdinaryRole({
            role: 'plan-reviewer',
            author,
            targetDigest: TARGET_DIGEST,
            reservation: fixture.reservation,
            actualParticipant: invalid.actualParticipant,
            callableProviderIds: [...invalid.callableProviderIds],
          }),
        (error) => isWorkflowError(error, 'COLLABORATION_GRANT_ROLE_INVALID'),
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test('direct-human review requires the current explicit signature namespace', () => {
  const signature =
    '-----BEGIN SSH SIGNATURE-----\nYWJj\n-----END SSH SIGNATURE-----\n';
  const payload = {
    version: 1 as const,
    grantId: GRANT_ID,
    signedEnvelopeDigest: 'a'.repeat(64),
    transitionDigest: 'b'.repeat(64),
    targetDigest: 'c'.repeat(64),
    reviewNodeId: 'd'.repeat(64),
    reviewResultDigest: 'e'.repeat(64),
    signedAt: '2026-08-20T00:00:00.000Z',
    signer: 'fixture-maintainer',
  };
  const payloadBytes =
    `{"version":1,"grantId":"${GRANT_ID}",` +
    `"signedEnvelopeDigest":"${'a'.repeat(64)}",` +
    `"transitionDigest":"${'b'.repeat(64)}",` +
    `"targetDigest":"${'c'.repeat(64)}",` +
    `"reviewNodeId":"${'d'.repeat(64)}",` +
    `"reviewResultDigest":"${'e'.repeat(64)}",` +
    '"signedAt":"2026-08-20T00:00:00.000Z",' +
    '"signer":"fixture-maintainer"}\n';
  const attestation = {
    payload,
    signatureNamespace: DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
    signature,
  };
  const envelopeBytes =
    `{"payload":${payloadBytes.trimEnd()},` +
    `"signatureNamespace":"${DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE}",` +
    `"signature":${JSON.stringify(signature)}}\n`;

  assert.equal(canonicalDirectHumanReviewPayload(payload), payloadBytes);
  assert.equal(
    canonicalDirectHumanReviewAttestation(attestation),
    envelopeBytes,
  );
  assert.deepEqual(
    parseDirectHumanReviewAttestation(envelopeBytes),
    attestation,
  );
  assert.throws(
    () =>
      parseDirectHumanReviewAttestation(
        `{"payload":${payloadBytes.trimEnd()},"signature":${JSON.stringify(signature)}}\n`,
      ),
    (error) => isWorkflowError(error, 'DIRECT_HUMAN_REVIEW_INVALID'),
  );
  assert.throws(
    () =>
      parseDirectHumanReviewAttestation(
        envelopeBytes.replace('{"version":1', '{"version":2'),
      ),
    (error) => isWorkflowError(error, 'DIRECT_HUMAN_REVIEW_INVALID'),
  );
  assert.throws(
    () =>
      parseDirectHumanReviewAttestation(
        `${JSON.stringify({ signature, payload })}\n`,
      ),
    (error) => isWorkflowError(error, 'DIRECT_HUMAN_REVIEW_INVALID'),
  );
});

test('ordinary scheduling never manufactures independence without an author session', () => {
  assert.deepEqual(
    scheduleOrdinaryRole({
      role: 'plan-reviewer',
      author: {
        providerId: undefined,
        sessionId: undefined,
        principalId: undefined,
        identityAssurance: 'self-declared',
        engineSpawned: false,
      },
      targetDigest: TARGET_DIGEST,
      candidates: [
        {
          providerId: 'claude',
          sessionId: 'candidate-session',
          enabled: true,
          available: true,
        },
      ],
    }),
    {
      outcome: 'collaboration-grant-required',
      role: 'plan-reviewer',
      requiredIndependence: 'session-independent',
      reason: 'NO_REQUIRED_INDEPENDENCE_CANDIDATE',
    },
  );
});

test('no-callable degraded forms record no provider invocation or independence', () => {
  for (const degradedForm of [
    'caller-supplied',
    'direct-human-review',
  ] as const) {
    const fixture = reservedFixture(degradedForm);
    try {
      const role = 'plan-reviewer' as const;
      const actualParticipant: RoleParticipant = {
        providerId: undefined,
        sessionId: undefined,
        principalId:
          degradedForm === 'direct-human-review'
            ? 'fixture-maintainer'
            : 'fixture-caller',
        identityAssurance:
          degradedForm === 'direct-human-review'
            ? 'adapter-assigned'
            : 'self-declared',
        engineSpawned: false,
      };
      const directHumanReview =
        degradedForm === 'direct-human-review'
          ? {
              attestation: createDirectHumanReviewAttestation(
                fixture.repository,
                {
                  grantEnvelope: fixture.reservation.envelope,
                  transitionDigest: TRANSITION_DIGEST,
                  reviewNodeId: CONTENT_NODE_ID,
                  reviewResultDigest: CONTENT_RESULT_DIGEST,
                },
                {
                  now: new Date(NOW.getTime() + 90_000),
                  signer: fixture.signer,
                },
              ),
              policy: POLICY,
              verifier: authoritativeCollaborationGrantVerifierForTest(
                fixture.signer,
              ),
              now: new Date(NOW.getTime() + 90_000),
              reviewNodeId: CONTENT_NODE_ID,
              reviewResultDigest: CONTENT_RESULT_DIGEST,
            }
          : undefined;
      if (degradedForm === 'direct-human-review') {
        assert.throws(
          () =>
            authorizeGrantedOrdinaryRole({
              role,
              author: participant('codex', 'author-session'),
              targetDigest: TARGET_DIGEST,
              reservation: fixture.reservation,
              actualParticipant,
              callableProviderIds: [],
            }),
          (error) => isWorkflowError(error, 'COLLABORATION_GRANT_ROLE_INVALID'),
        );
      }
      const assignment = authorizeGrantedOrdinaryRole({
        role,
        author: participant('codex', 'author-session'),
        targetDigest: TARGET_DIGEST,
        reservation: fixture.reservation,
        actualParticipant,
        callableProviderIds: [],
        directHumanReview,
      });
      assert.equal(assignment.providerId, null);
      assert.equal(assignment.sessionId, null);
      assert.equal(assignment.engineSpawned, false);
      assert.equal(assignment.providerIndependent, false);
      assert.equal(assignment.sessionIndependent, false);
      assert.equal(assignment.achievedIndependence, 'none');
      assert.equal(
        assignment.orchestration,
        degradedForm === 'direct-human-review'
          ? 'direct-human-review'
          : 'caller-supplied',
      );
      assert.equal(
        assignment.authorizedEffect,
        COLLABORATION_GRANT_AUTHORIZED_EFFECT,
      );
      assert.equal(
        assignment.directHumanReviewAttestationDigest,
        directHumanReview
          ? directHumanReviewAttestationDigest(directHumanReview.attestation)
          : null,
      );
      assert.equal(
        assignment.participant.identityAssurance,
        degradedForm === 'direct-human-review'
          ? 'maintainer-signed'
          : 'self-declared',
      );
      assert.equal(
        Object.keys(assignment).some((key) => /skip|waive|approve/i.test(key)),
        false,
      );
      if (directHumanReview) {
        assert.ok(
          fixture.namespaces.includes(DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE),
        );
        const tamperedAttestation = structuredClone(
          directHumanReview.attestation,
        );
        tamperedAttestation.signature = fixtureSignature(
          'tampered review bytes',
          DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
        );
        assert.throws(
          () =>
            authorizeGrantedOrdinaryRole({
              role,
              author: participant('codex', 'author-session'),
              targetDigest: TARGET_DIGEST,
              reservation: fixture.reservation,
              actualParticipant,
              callableProviderIds: [],
              directHumanReview: {
                ...directHumanReview,
                attestation: tamperedAttestation,
              },
            }),
          (error) => isWorkflowError(error, 'COLLABORATION_SIGNATURE_INVALID'),
        );
        const consumed = consumeCollaborationGrant(
          fixture.common,
          fixture.grantId,
          {
            transitionDigest: TRANSITION_DIGEST,
            assignment,
            contentAdmission: {
              kind: 'plan-review',
              nodeId: CONTENT_NODE_ID,
              resultDigest: CONTENT_RESULT_DIGEST,
              current: true,
            },
            directHumanReviewAttestation: directHumanReview.attestation,
            now: new Date(NOW.getTime() + 120_000),
            verifier: fixture.verifier,
          },
        );
        assert.ok(consumed.use);
        assert.doesNotThrow(() =>
          validateCollaborationGrantUseProjection(consumed.use, {
            now: new Date(NOW.getTime() + 120_000),
            expectedBinding: expectedBinding(fixture.reservation.envelope),
            policy: POLICY,
            verifier: authoritativeCollaborationGrantVerifierForTest(
              fixture.signer,
            ),
            transitionDigest: TRANSITION_DIGEST,
            expectedAssignment: assignment,
            contentAdmission: {
              kind: 'plan-review',
              nodeId: CONTENT_NODE_ID,
              resultDigest: CONTENT_RESULT_DIGEST,
              current: true,
            },
          }),
        );
        const admitted = admitRoleResult({
          assignment,
          author: assignment.author,
          participant: assignment.participant,
          content: roleContent('plan-review'),
          providerInvocation: null,
          grantUse: consumed.use,
          grantValidation: {
            now: new Date(NOW.getTime() + 120_000),
            expectedBinding: expectedBinding(fixture.reservation.envelope),
            policy: POLICY,
            verifier: authoritativeCollaborationGrantVerifierForTest(
              fixture.signer,
            ),
            transitionDigest: TRANSITION_DIGEST,
          },
        });
        assert.equal(admitted.form, 'direct-human-attestation');
        assert.equal(admitted.providerInvocation, null);
        assert.ok(admitted.directHumanReviewAttestation);
      }

      assert.throws(
        () =>
          authorizeGrantedOrdinaryRole({
            role,
            author: participant('codex', 'author-session'),
            targetDigest: TARGET_DIGEST,
            reservation: fixture.reservation,
            actualParticipant,
            callableProviderIds: ['codex'],
          }),
        (error) => isWorkflowError(error, 'COLLABORATION_GRANT_ROLE_INVALID'),
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('aggregate grant uses reject a duplicate claim across one subject', () => {
  const first = {
    grantId: 'grant-aaaaaaaaaaaaaaaa',
    signedEnvelopeDigest: 'a'.repeat(64),
    transitionDigest: 'b'.repeat(64),
  };
  const second = {
    grantId: 'grant-bbbbbbbbbbbbbbbb',
    signedEnvelopeDigest: 'c'.repeat(64),
    transitionDigest: 'd'.repeat(64),
  };

  assertUniqueCollaborationGrantUses([]);
  assertUniqueCollaborationGrantUses([first, second]);
  assert.doesNotThrow(() => assertUniqueGrantUseClaimsV1([first, second]));

  // Every grant is issued with maxUses: 1, so the same grant replayed at a
  // second transition is a duplicate claim even though each use is well formed.
  assert.throws(
    () =>
      assertUniqueCollaborationGrantUses([
        first,
        { ...first, transitionDigest: 'e'.repeat(64) },
      ]),
    (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_DUPLICATE'),
  );
  // A re-signed envelope replayed under a fresh grant ID is equally rejected.
  assert.throws(
    () =>
      assertUniqueCollaborationGrantUses([
        first,
        { ...second, signedEnvelopeDigest: first.signedEnvelopeDigest },
      ]),
    (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_DUPLICATE'),
  );
  assert.throws(
    () =>
      assertUniqueCollaborationGrantUses([
        { ...first, useProjectionDigest: '0'.repeat(64) },
      ]),
    (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_INVALID'),
  );
});

test('invalid content admission terminally fails a reserved grant', () => {
  const fixture = reservedFixture('caller-supplied');
  try {
    const assignment = authorizeGrantedOrdinaryRole({
      role: 'plan-reviewer',
      author: participant('codex', 'author-session'),
      targetDigest: TARGET_DIGEST,
      reservation: fixture.reservation,
      actualParticipant: {
        providerId: undefined,
        sessionId: undefined,
        principalId: 'fixture-caller',
        identityAssurance: 'self-declared',
        engineSpawned: false,
      },
      callableProviderIds: [],
    });
    assert.throws(
      () =>
        consumeCollaborationGrant(fixture.common, fixture.grantId, {
          transitionDigest: TRANSITION_DIGEST,
          assignment,
          contentAdmission: {
            kind: 'blind-survey',
            nodeId: CONTENT_NODE_ID,
            resultDigest: CONTENT_RESULT_DIGEST,
            current: false,
          } as never,
          now: new Date(NOW.getTime() + 120_000),
          verifier: fixture.verifier,
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_INVALID'),
    );
    assert.equal(
      inspectCollaborationGrants(fixture.common, fixture.grantId)[0]?.state,
      'failed',
    );
  } finally {
    fixture.cleanup();
  }
});

test('grant consumption requires structured survey or review content and retains every assurance obligation', () => {
  const fixture = reservedFixture('caller-supplied');
  try {
    const assignment = authorizeGrantedOrdinaryRole({
      role: 'plan-reviewer',
      author: participant('codex', 'author-session'),
      targetDigest: TARGET_DIGEST,
      reservation: fixture.reservation,
      actualParticipant: {
        providerId: undefined,
        sessionId: undefined,
        principalId: 'fixture-caller',
        identityAssurance: 'self-declared',
        engineSpawned: false,
      },
      callableProviderIds: [],
    });
    const consumed = consumeCollaborationGrant(
      fixture.common,
      fixture.grantId,
      {
        transitionDigest: TRANSITION_DIGEST,
        assignment,
        contentAdmission: {
          kind: 'blind-survey',
          nodeId: CONTENT_NODE_ID,
          resultDigest: CONTENT_RESULT_DIGEST,
          current: true,
        },
        now: new Date(NOW.getTime() + 120_000),
        verifier: fixture.verifier,
      },
    );
    assert.deepEqual(
      consumed.use?.retainedObligations,
      COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
    );
    assert.deepEqual(COLLABORATION_GRANT_RETAINED_OBLIGATIONS, [
      'engine-search-floor',
      'typed-term-contributions',
      'effective-union-scan',
      'hit-dispositions',
      'why-ledger',
      'structured-role-content',
      'challenge-dispositions',
      'registered-checks',
      'allowed-paths',
      'freshness',
      'managed-transition-authority',
    ]);
    const use = consumed.use;
    assert.ok(use);
    assert.doesNotThrow(() =>
      validateCollaborationGrantUseProjection(use, {
        now: new Date(NOW.getTime() + 120_000),
        expectedBinding: expectedBinding(use.envelope),
        policy: POLICY,
        verifier: authoritativeCollaborationGrantVerifierForTest(
          fixture.signer,
        ),
        transitionDigest: TRANSITION_DIGEST,
        expectedAssignment: assignment,
        contentAdmission: {
          kind: 'blind-survey',
          nodeId: CONTENT_NODE_ID,
          resultDigest: CONTENT_RESULT_DIGEST,
          current: true,
        },
      }),
    );
    const validationOptions = {
      now: new Date(NOW.getTime() + 120_000),
      expectedBinding: expectedBinding(use.envelope),
      policy: POLICY,
      verifier: authoritativeCollaborationGrantVerifierForTest(fixture.signer),
      transitionDigest: TRANSITION_DIGEST,
      expectedAssignment: assignment,
      contentAdmission: {
        kind: 'blind-survey' as const,
        nodeId: CONTENT_NODE_ID,
        resultDigest: CONTENT_RESULT_DIGEST,
        current: true as const,
      },
    };
    assert.equal(
      validateCollaborationGrantUseSet([
        { value: use, options: validationOptions },
      ]).length,
      1,
    );
    const admitted = admitRoleResult({
      assignment,
      author: assignment.author,
      participant: assignment.participant,
      content: roleContent('blind-survey'),
      providerInvocation: null,
      grantUse: use,
      grantValidation: {
        now: validationOptions.now,
        expectedBinding: validationOptions.expectedBinding,
        policy: validationOptions.policy,
        verifier: validationOptions.verifier,
        transitionDigest: validationOptions.transitionDigest,
      },
    });
    assert.equal(admitted.form, 'granted-caller-supplied');
    assert.equal(admitted.orchestration, 'caller-supplied');
    assert.equal(admitted.providerInvocation, null);
    assert.match(admitted.resultDigest, /^[0-9a-f]{64}$/);
    assert.throws(
      () =>
        admitRoleResult({
          assignment,
          author: assignment.author,
          participant: assignment.participant,
          content: roleContent('blind-survey'),
          providerInvocation: {
            invocationId: 'fabricated',
            requestDigest: '5'.repeat(64),
            outputDigest: '6'.repeat(64),
            providerId: 'codex',
            sessionId: 'fabricated',
            targetDigest: TARGET_DIGEST,
            engineSpawned: true,
          },
          grantUse: use,
          grantValidation: {
            now: validationOptions.now,
            expectedBinding: validationOptions.expectedBinding,
            policy: validationOptions.policy,
            verifier: validationOptions.verifier,
            transitionDigest: validationOptions.transitionDigest,
          },
        }),
      (error) => isWorkflowError(error, 'ROLE_RESULT_INVALID'),
    );
    assert.throws(
      () =>
        validateCollaborationGrantUseSet([
          { value: use, options: validationOptions },
          { value: structuredClone(use), options: validationOptions },
        ]),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_INVALID'),
    );
    assert.throws(
      () =>
        validateCollaborationGrantUseProjection(
          {
            ...use,
            structuredContent: {
              ...use.structuredContent,
              nodeId: '9'.repeat(64),
            },
          },
          {
            now: new Date(NOW.getTime() + 120_000),
            expectedBinding: expectedBinding(use.envelope),
            policy: POLICY,
            verifier: authoritativeCollaborationGrantVerifierForTest(
              fixture.signer,
            ),
            transitionDigest: TRANSITION_DIGEST,
            expectedAssignment: assignment,
            contentAdmission: {
              kind: 'blind-survey',
              nodeId: CONTENT_NODE_ID,
              resultDigest: CONTENT_RESULT_DIGEST,
              current: true,
            },
          },
        ),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_INVALID'),
    );
  } finally {
    fixture.cleanup();
  }
});
