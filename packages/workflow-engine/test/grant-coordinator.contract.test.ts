import test from 'node:test';
import assert from 'node:assert/strict';
import {
  grantStorePaths,
  assertGrantLifecycleBarrier,
  createFileGrantRecordStore,
} from '../src/runtime/lifecycle-ledgers/grant-store.ts';
import { isWorkflowError } from './fixture.ts';
import { workflowError, ExitCode } from '../src/foundation/errors/errors.ts';
import {
  grantTransitionPreconditionChanged,
  type TransitionDefinition,
  createTransitionRegistry,
} from '../src/modules/authority/grant-transition-registry.ts';
import {
  type TrustedGrantPresentation,
  type GrantApprovalSession,
  createGrantCoordinatorKernel,
  type GrantAuthenticationRequest,
} from '../src/modules/authority/grant-coordinator.ts';
import {
  parseGrantPolicyV2,
  codeOwnedApprovalModuleRegistry,
  GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
} from '../src/modules/authority/grant-policy.ts';
import {
  type StateBinding,
  type GrantRequestInput,
} from '../src/modules/authority/grant-core.ts';
import {
  type VerifiedApprovalProof,
  assertSshPortableApprovalEvidenceV1,
  sshPortableApprovalEvidenceDigest,
} from '../src/modules/authority/grant-approval.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  withRuntime,
  OPERATION_ID,
  CHALLENGE_ID,
  NOW,
  policyInput,
  humanProof,
  digest,
} from './grant-coordinator-fixture.ts';

test('only a trusted-session decision reaches the exact registered transition', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: ({ operationId }) => {
        assert.equal(operationId, OPERATION_ID);
        effects += 1;
        state = binding('9');
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession(presentation) {
        assertTrustedPresentation(presentation);
        return successfulSession(presentation);
      },
    });

    assert.equal(coordinator.contractVersion, 'central-grant-request-port.v1');
    assert.equal(
      coordinator.challengeContractVersion,
      'central-grant-challenge-port.v1',
    );

    const challenge = await coordinator.requestGrant(request());
    assert.equal(challenge.challengeId, CHALLENGE_ID);
    const presentation = coordinator.inspectChallenge(CHALLENGE_ID);
    assertTrustedPresentation(presentation);

    const result = await coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.transitionId, 'investigation.abort.v1');
    assert.equal(effects, 1);
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'completed',
    );
  });
});

test('SSH is selected instead of local presence and records credential assurance', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        state = binding('9');
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      enableSsh: true,
      openSession(presentation) {
        assert.deepEqual(presentation.approvalMethods, [
          'human-presence',
          'ssh',
        ]);
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              approvalMethod: 'ssh',
              reasonCode: 'cannot-complete-review',
              reason: 'Use the configured interactive SSH credential.',
              sessionNonce: 'nonce-77777777777777777777777777777777',
            };
          },
          async authenticate(request) {
            return [sshProof(request)];
          },
          async close() {},
        };
      },
    });
    await coordinator.requestGrant(request());

    await coordinator.resolveChallenge(CHALLENGE_ID);
    const record = createFileGrantRecordStore(
      grantStorePaths(runtimeRoot),
    ).readGrantRecord(CHALLENGE_ID);
    assert.equal(record.state, 'completed');
    if (record.state !== 'completed') assert.fail('expected terminal record');
    assert.deepEqual(record.audit, {
      approvalMethod: 'ssh',
      authorityClass: 'ssh-credential',
      identity: 'fixture-maintainer',
      identityAssurance: 'policy-trusted-ssh-key',
      presenceAssurance: 'not-asserted',
      proofModules: ['grant-proof-ssh@1'],
    });
  });
});

test('a local-presence decision cannot reach authentication or prepare for an ssh-only transition', async () => {
  await withRuntime(async (runtimeRoot) => {
    let authenticated = false;
    let effects = 0;
    const definition = abortDefinition(
      {
        observe: () => binding('1'),
        execute: () => {
          effects += 1;
        },
      },
      ['ssh'],
    );
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      enableSsh: true,
      openSession(presentation) {
        assert.deepEqual(presentation.choices[0]?.allowedApprovalMethods, [
          'ssh',
        ]);
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              approvalMethod: 'human-presence',
              reasonCode: 'cannot-complete-review',
              reason: 'Try local presence against a portable-only transition.',
              sessionNonce: 'nonce-12121212121212121212121212121212',
            };
          },
          async authenticate() {
            authenticated = true;
            return [];
          },
          async close() {},
        };
      },
    });
    await coordinator.requestGrant(request());

    await assert.rejects(coordinator.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'GRANT_APPROVAL_METHOD_NOT_ALLOWED'),
    );
    assert.equal(authenticated, false);
    assert.equal(effects, 0);
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'pending',
    );
  });
});

test('prepared SSH recovery preserves the exact portable proof evidence', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let attempts = 0;
    const definition = abortDefinition(
      {
        observe: () => state,
        execute: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('simulated portable crash');
          state = binding('9');
        },
      },
      ['ssh'],
    );
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      enableSsh: true,
      openSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              approvalMethod: 'ssh',
              reasonCode: 'cannot-complete-review',
              reason: 'Preserve portable proof across recovery.',
              sessionNonce: 'nonce-13131313131313131313131313131313',
            };
          },
          async authenticate(request) {
            return [sshProof(request)];
          },
          async close() {},
        };
      },
    });
    await coordinator.requestGrant(request());
    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated portable crash/u,
    );
    const prepared = createFileGrantRecordStore(
      grantStorePaths(runtimeRoot),
    ).readGrantRecord(CHALLENGE_ID);
    assert.equal(prepared.state, 'prepared');
    if (prepared.state !== 'prepared') assert.fail('expected prepared record');
    const evidence = prepared.proofModules[0]?.portableEvidence;
    assert.equal(evidence?.kind, 'grant-proof-ssh-portable-evidence.v1');

    await coordinator.recoverChallenge(CHALLENGE_ID);
    const terminal = createFileGrantRecordStore(
      grantStorePaths(runtimeRoot),
    ).readGrantRecord(CHALLENGE_ID);
    assert.equal(terminal.state, 'completed');
    if (terminal.state !== 'completed') assert.fail('expected terminal record');
    assert.deepEqual(terminal.proofModules[0]?.portableEvidence, evidence);
    assert.equal(attempts, 2);
  });
});

test('state drift after fresh authentication invalidates the approval before prepare', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        effects += 1;
        state = binding('9');
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession(presentation) {
        return successfulSession(presentation, () => {
          state = binding('d');
        });
      },
    });
    await coordinator.requestGrant(request());

    await assert.rejects(coordinator.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'GRANT_STATE_CHANGED'),
    );
    assert.equal(effects, 0);
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'pending',
    );
  });
});

test('cancel and timeout leave the challenge pending without authentication or transition effects', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let effects = 0;
    let closed = false;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        effects += 1;
        state = binding('9');
      },
    });
    const cancelled = coordinatorFixture(runtimeRoot, definition, {
      openSession() {
        return {
          async collectDecision() {
            throw workflowError(
              'HUMAN_GATE_CANCELLED',
              'The human cancelled the decision.',
              ExitCode.guard,
            );
          },
          async authenticate() {
            assert.fail('cancelled decision must not authenticate');
          },
          async close() {
            closed = true;
          },
        };
      },
    });
    await cancelled.requestGrant(request());
    await assert.rejects(cancelled.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'HUMAN_GATE_CANCELLED'),
    );
    assert.equal(closed, true);
    assert.equal(effects, 0);
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'pending',
    );
  });

  await withRuntime(async (runtimeRoot) => {
    let current = new Date(NOW);
    let authenticated = false;
    let effects = 0;
    const definition = abortDefinition({
      observe: () => binding('1'),
      execute: () => {
        effects += 1;
      },
    });
    const expired = coordinatorFixture(runtimeRoot, definition, {
      challengeTtlMs: 1,
      now: () => current,
      openSession(presentation) {
        return {
          async collectDecision() {
            current = new Date(NOW.getTime() + 2);
            return {
              choiceId: presentation.choices[0]!.choiceId,
              reasonCode: 'cannot-complete-review',
              reason: 'The decision took longer than the challenge lifetime.',
              approvalMethod: 'human-presence',
              sessionNonce: 'nonce-99999999999999999999999999999999',
            };
          },
          async authenticate() {
            authenticated = true;
            return [];
          },
          async close() {},
        };
      },
    });
    await expired.requestGrant(request());
    await assert.rejects(expired.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'GRANT_CHALLENGE_EXPIRED'),
    );
    assert.equal(authenticated, false);
    assert.equal(effects, 0);
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'pending',
    );
  });
});

test('after durable prepare recovery repeats only the same idempotent transition', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let attempts = 0;
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('simulated process crash');
        if (state.digest === binding('1').digest) {
          effects += 1;
          state = binding('9');
        }
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession: successfulSession,
    });
    await coordinator.requestGrant(request());

    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated process crash/,
    );
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'prepared',
    );

    const recovered = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.outcome, 'completed');
    assert.equal(attempts, 2);
    assert.equal(effects, 1);

    const duplicate = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(duplicate.recovered, true);
    assert.equal(attempts, 2);
    assert.equal(effects, 1);
  });
});

test('prepared recovery converges an idempotent transition that applied before its receipt was durable', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let attempts = 0;
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        attempts += 1;
        if (state.digest === binding('1').digest) {
          effects += 1;
          state = binding('9');
          throw workflowError(
            'SIMULATED_POST_EFFECT_LOCK_STALE',
            'simulated crash after transition effect',
            ExitCode.staleState,
          );
        }
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession: successfulSession,
    });
    await coordinator.requestGrant(request());

    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated crash after transition effect/,
    );
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'prepared',
    );

    const recovered = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.outcome, 'completed');
    assert.equal(recovered.recovered, true);
    assert.equal(attempts, 2);
    assert.equal(effects, 1);
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'completed',
    );
  });
});

test('prepared recovery terminalizes deterministic state drift without applying effects or retaining the lifecycle barrier', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let attempts = 0;
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('simulated process crash');
        if (state.digest !== binding('1').digest) {
          throw grantTransitionPreconditionChanged(
            'FIXTURE_STATE_CHANGED',
            'The fixture state changed before its transition could execute.',
          );
        }
        effects += 1;
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession: successfulSession,
    });
    await coordinator.requestGrant(request());

    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated process crash/,
    );
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'prepared',
    );
    assert.throws(
      () => assertGrantLifecycleBarrier(runtimeRoot),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );

    state = binding('d');
    const recovered = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.deepEqual(recovered, {
      challengeId: CHALLENGE_ID,
      operationId: OPERATION_ID,
      transitionId: 'investigation.abort.v1',
      outcome: 'failed',
      poststateDigest: binding('d').digest,
      recovered: true,
    });
    assert.equal(attempts, 2);
    assert.equal(effects, 0);

    const terminal = createFileGrantRecordStore(
      grantStorePaths(runtimeRoot),
    ).readGrantRecord(CHALLENGE_ID);
    assert.equal(terminal.state, 'failed');
    if (terminal.state !== 'failed') assert.fail('expected terminal failure');
    assert.deepEqual(terminal.outcome, {
      outcome: 'failed',
      details: {
        schemaVersion: 1,
        kind: 'grant-transition-state-drift.v1',
        failureCode: 'GRANT_STATE_CHANGED',
        transitionCompleted: false,
        transitionErrorCode: 'FIXTURE_STATE_CHANGED',
        expectedStateBinding: binding('1'),
        observedStateBinding: binding('d'),
      },
    });
    assert.deepEqual(terminal.audit, {
      approvalMethod: 'human-presence',
      authorityClass: 'local-device-owner',
      identity: null,
      identityAssurance: 'not-asserted',
      presenceAssurance: 'fresh-os-authentication',
      proofModules: ['human-gate-macos@1'],
    });
    assert.doesNotThrow(() => assertGrantLifecycleBarrier(runtimeRoot));

    assert.deepEqual(
      await coordinator.recoverChallenge(CHALLENGE_ID),
      recovered,
    );
    assert.equal(attempts, 2);
    assert.equal(effects, 0);
    await assert.rejects(coordinator.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'GRANT_CHALLENGE_UNAVAILABLE'),
    );
  });
});

test('a stale-state error without changed observed state cannot cancel a prepared transition', async () => {
  await withRuntime(async (runtimeRoot) => {
    let attempts = 0;
    const definition = abortDefinition({
      observe: () => binding('1'),
      execute: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('simulated process crash');
        throw workflowError(
          'FIXTURE_TRANSIENT_STALE',
          'The fixture emitted a stale signal without state drift.',
          ExitCode.staleState,
        );
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession: successfulSession,
    });
    await coordinator.requestGrant(request());
    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated process crash/,
    );

    await assert.rejects(coordinator.recoverChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'FIXTURE_TRANSIENT_STALE'),
    );
    assert.equal(attempts, 2);
    assert.equal(
      createFileGrantRecordStore(grantStorePaths(runtimeRoot)).readGrantRecord(
        CHALLENGE_ID,
      ).state,
      'prepared',
    );
    assert.throws(
      () => assertGrantLifecycleBarrier(runtimeRoot),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );
  });
});

function coordinatorFixture(
  runtimeRoot: string,
  definition: TransitionDefinition<{ terminalReason: string }>,
  options: {
    enableSsh?: boolean;
    now?: () => Date;
    challengeTtlMs?: number;
    openSession(
      presentation: TrustedGrantPresentation,
    ): GrantApprovalSession | Promise<GrantApprovalSession>;
  },
) {
  const ids = [CHALLENGE_ID, OPERATION_ID];
  return createGrantCoordinatorKernel({
    store: createFileGrantRecordStore(grantStorePaths(runtimeRoot)),
    registry: createTransitionRegistry([definition]),
    policy: parseGrantPolicyV2(
      options.enableSsh ? sshPolicyInput() : policyInput(),
      {
        registry: codeOwnedApprovalModuleRegistry(),
      },
    ),
    now: options.now ?? (() => new Date(NOW)),
    randomUUID: () => ids.shift()!,
    challengeTtlMs: options.challengeTtlMs ?? 10 * 60_000,
    openApprovalSession: options.openSession,
    async withLifecycleOperation(_challengeId, operation) {
      return operation(() => undefined);
    },
  });
}

function successfulSession(
  presentation: TrustedGrantPresentation,
  afterAuthentication: () => void = () => undefined,
): GrantApprovalSession {
  return {
    async collectDecision() {
      return {
        choiceId: presentation.choices[0]!.choiceId,
        reasonCode: 'cannot-complete-review',
        reason: 'The required reviewer input cannot be recovered.',
        approvalMethod: 'human-presence',
        sessionNonce: 'nonce-55555555555555555555555555555555',
      };
    },
    async authenticate(subject) {
      afterAuthentication();
      return [humanProof(subject.approvalSubjectDigest)];
    },
    async close() {},
  };
}

function assertTrustedPresentation(
  presentation: TrustedGrantPresentation,
): void {
  assert.equal(presentation.failureCode, 'reviewer-terms-exhausted');
  assert.deepEqual(presentation.approvalMethods, ['human-presence']);
  assert.deepEqual(presentation.choices[0], {
    choiceId: presentation.challenge.choices[0]!.choiceId,
    transitionId: 'investigation.abort.v1',
    title: 'Abort investigation',
    consequences: ['The investigation becomes terminal.'],
    allowedApprovalMethods: ['human-presence', 'ssh'],
    allowedReasonCodes: ['cannot-complete-review'],
    reasonRequired: true,
    proposedReason:
      'The reviewer budget is exhausted and the investigation cannot continue.',
  });
}

function abortDefinition(
  options: {
    observe: () => StateBinding;
    execute: (context: { operationId: string }) => void;
  },
  allowedApprovalMethods: readonly ('human-presence' | 'ssh')[] = [
    'human-presence',
    'ssh',
  ],
): TransitionDefinition<{ terminalReason: string }> {
  return {
    transitionId: 'investigation.abort.v1',
    parameterSchemaDigest: digest('2'),
    consequenceDigest: digest('3'),
    resolutionKind: 'non-retry',
    allowedApprovalMethods,
    validateParameters(value) {
      assert.deepEqual(value, { terminalReason: 'reviewer-terms-exhausted' });
      return value as { terminalReason: string };
    },
    renderTrustedChoice() {
      return {
        title: 'Abort investigation',
        consequences: ['The investigation becomes terminal.'],
      };
    },
    observeState() {
      return options.observe();
    },
    async execute(context) {
      options.execute(context);
      return { outcome: 'completed', details: { terminal: true } };
    },
  };
}

function request(): GrantRequestInput {
  return {
    sourceModuleId: 'investigation',
    failureCode: 'reviewer-terms-exhausted',
    facts: { investigationId: 'investigation-1' },
    stateBinding: binding('1'),
    candidates: [
      {
        transitionId: 'investigation.abort.v1',
        parameters: { terminalReason: 'reviewer-terms-exhausted' },
        allowedReasonCodes: ['cannot-complete-review'],
        reasonRequired: true,
        proposedReason:
          'The reviewer budget is exhausted and the investigation cannot continue.',
      },
    ],
  };
}

function sshPolicyInput() {
  return {
    ...policyInput(),
    profiles: {
      ...policyInput().profiles,
      ssh: { requiredClaims: ['ssh-signature'] },
    },
    approvalModules: [
      ...policyInput().approvalModules,
      {
        moduleId: 'grant-proof-ssh',
        version: '1',
        allowedClaims: ['ssh-signature'],
        configurationDigest: GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
      },
    ],
    optionalSsh: {
      signatureNamespace: 'jigwright.workflow.grant-proof.v1',
      trustedSigners: [
        {
          identity: 'fixture-maintainer',
          publicKey:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
          fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
        },
      ],
    },
  };
}

function sshProof(request: GrantAuthenticationRequest): VerifiedApprovalProof {
  const identity = 'fixture-maintainer';
  const verifiedAt = NOW.toISOString();
  const portableEvidence = assertSshPortableApprovalEvidenceV1({
    schemaVersion: 1,
    kind: 'grant-proof-ssh-portable-evidence.v1',
    payload: canonicalJson({
      schemaVersion: 1,
      kind: 'grant-proof-ssh-subject.v1',
      approvalSubject: request.approvalSubject,
      approvalSubjectDigest: request.approvalSubjectDigest,
      signerIdentity: identity,
    }),
    signature: 'fixture-portable-signature',
    signatureNamespace: 'jigwright.workflow.grant-proof.v1',
    identity,
    verifiedAt,
  });
  return {
    moduleId: 'grant-proof-ssh',
    version: '1',
    claims: ['ssh-signature'],
    approvalSubjectDigest: request.approvalSubjectDigest,
    proofDigest: sshPortableApprovalEvidenceDigest(portableEvidence),
    verifiedAt,
    identity,
    portableEvidence,
  };
}

function binding(character: string): StateBinding {
  return { kind: 'investigation-state', digest: digest(character) };
}
