import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createInvestigationCheckpointEnvelope,
  getInvestigationStatus,
  publishProviderResultToInvestigation,
  resumeInvestigationSession,
  startInvestigationSession,
} from '../src/adapters/planning/investigation/investigation-session.ts';
import {
  getProposeStatus,
  resumePropose,
} from '../src/application/propose/propose-orchestrator.ts';
import {
  checkpointContributionDigest,
  compareAndSwapInvestigationSession,
  inspectInvestigationQuarantineState,
  inspectInvestigationResolutionState,
  readInvestigationSession,
} from '../src/runtime/storage-journal/investigation-session-store.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  createInvestigationStartReservation,
  createProviderInvocation,
  createProviderRetryReservation,
  failProviderInvocation,
  readBlindSurveyManifest,
  readInvestigationStartReservation,
  readProviderInvocation,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { git, isWorkflowError, runtimeRoot } from './fixture.ts';
import {
  FIRST_INSTANT,
  authorizeProviderRetryFixture,
  investigationFixture,
  providerRequestInput,
  startFixture,
  mainTermsEnvelope,
  mainTerm,
  completeBlindInvocation,
  sessionPath,
  invocationPath,
  invocationManifestPath,
  invocationRequestPath,
  sha256,
} from './investigation-session-fixture.ts';

test('start seals a manifest-bound blind request before accepting main terms', () => {
  const fixture = investigationFixture('invocation-blind-start');
  try {
    const contaminatedManifest = structuredClone(fixture.blindManifest) as {
      normalizedIntent: Record<string, unknown>;
    };
    contaminatedManifest.normalizedIntent.priorConclusions = [
      'A prior agent decided which files matter.',
    ];
    assert.throws(
      () =>
        startInvestigationSession(fixture.repository, {
          changeId: 'demo-change',
          blindManifest: contaminatedManifest as never,
          blindRequest: fixture.request,
        }),
      (error) => isWorkflowError(error, 'BLIND_MANIFEST_INVALID'),
    );

    const unbound = createProviderInvocationRequest({
      ...providerRequestInput(fixture, 'invocation-unbound'),
      inputManifestDigest: 'f'.repeat(64),
    });
    assert.throws(
      () =>
        startInvestigationSession(fixture.repository, {
          changeId: 'demo-change',
          blindManifest: fixture.blindManifest,
          blindRequest: unbound,
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_BLIND_REQUEST_UNBOUND'),
    );
    assert.equal(fs.existsSync(fixture.paths.sessions), false);
    assert.equal(fs.existsSync(fixture.paths.invocations), false);

    const status = startInvestigationSession(fixture.repository, {
      changeId: 'demo-change',
      blindManifest: fixture.blindManifest,
      blindRequest: fixture.request,
    });

    assert.match(status.investigationId, /^investigation-[a-zA-Z0-9-]+$/);
    assert.equal(status.changeId, 'demo-change');
    assert.equal(status.revision, 0);
    assert.equal(status.state, 'awaiting-main-terms');
    assert.equal(status.providerInvocationId, fixture.request.invocationId);
    assert.equal(status.blindManifestDigest, fixture.blindManifestDigest);
    assert.equal(status.intentDigest, fixture.intentDigest);
    assert.deepEqual(status.baseline, {
      head: fixture.blindManifest.baseCommit,
      tree: fixture.blindManifest.baseTree,
    });
    assert.equal(status.checkpoint?.kind, 'main-terms');

    const invocation = readProviderInvocation(
      fixture.paths,
      status.providerInvocationId,
    );
    const storedRequest = readProviderInvocationRequest(
      fixture.paths,
      status.providerInvocationId,
    );
    const storedManifest = readBlindSurveyManifest(
      fixture.paths,
      status.providerInvocationId,
    );
    assert.equal(invocation.investigationId, status.investigationId);
    assert.equal(invocation.requestDigest, fixture.request.requestDigest);
    assert.equal(
      storedRequest.inputManifestDigest,
      fixture.blindManifestDigest,
    );
    assert.deepEqual(storedManifest, fixture.blindManifest);

    const sessionBytes = fs.readFileSync(
      sessionPath(fixture, status.investigationId),
      'utf8',
    );
    const invocationBytes = fs.readFileSync(
      invocationPath(fixture, status.providerInvocationId),
      'utf8',
    );
    const manifestBytes = fs.readFileSync(
      invocationManifestPath(fixture, status.providerInvocationId),
      'utf8',
    );
    const requestBytes = fs.readFileSync(
      invocationRequestPath(fixture, status.providerInvocationId),
      'utf8',
    );
    assert.equal(sessionBytes.includes('MainOnlyTerm'), false);
    assert.equal(invocationBytes.includes('MainOnlyTerm'), false);
    assert.equal(manifestBytes.includes('MainOnlyTerm'), false);
    assert.equal(requestBytes.includes('MainOnlyTerm'), false);

    const envelope = createInvestigationCheckpointEnvelope(status, {
      reference: 'main-agent-survey',
      terms: [mainTerm('MainOnlyTerm')],
    });
    assert.deepEqual(Object.keys(envelope).sort(), [
      'baseline',
      'blindManifestDigest',
      'changeId',
      'checkpointId',
      'expectedRevision',
      'intentDigest',
      'investigationId',
      'kind',
      'payload',
      'schemaVersion',
    ]);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.kind, 'main-terms');
    assert.equal(envelope.expectedRevision, 0);
    assert.equal(envelope.investigationId, status.investigationId);
    assert.equal(envelope.changeId, 'demo-change');
    assert.deepEqual(envelope.baseline, status.baseline);
    assert.equal(envelope.intentDigest, fixture.intentDigest);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('a durable start reservation recovers with its original IDs and nonce', () => {
  const fixture = investigationFixture('invocation-reserved-start');
  try {
    const repositoryState = discoverRepository(fixture.repository);
    const reservation = createInvestigationStartReservation(fixture.paths, {
      changeId: 'demo-change',
      investigationId: 'investigation-reserved-recovery',
      repositoryRoot: repositoryState.repositoryRealPath,
      gitCommonDirectory: repositoryState.gitCommonDirectory,
      branch: repositoryState.branch,
      baseline: {
        head: repositoryState.head,
        tree: repositoryState.tree,
      },
      manifest: fixture.blindManifest,
      request: fixture.request,
      executionPolicy: loadAiAdapterPolicy(fixture.repository),
      createdAt: FIRST_INSTANT,
    });
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.invocations,
          fixture.request.invocationId,
          'state.json',
        ),
      ),
      false,
    );

    const regeneratedRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-regenerated-after-crash', {
        nonce: 'regenerated-nonce-at-least-16-bytes',
      }),
    );
    const recovered = startInvestigationSession(fixture.repository, {
      changeId: 'demo-change',
      blindManifest: fixture.blindManifest,
      blindRequest: regeneratedRequest,
    });

    assert.equal(recovered.investigationId, reservation.investigationId);
    assert.equal(recovered.providerInvocationId, reservation.invocationId);
    assert.equal(
      readProviderInvocationRequest(
        fixture.paths,
        recovered.providerInvocationId,
      ).nonce,
      fixture.request.nonce,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.paths.invocations, regeneratedRequest.invocationId),
      ),
      false,
    );
    assert.deepEqual(
      readInvestigationStartReservation(fixture.paths, 'demo-change'),
      reservation,
    );
    assert.deepEqual(
      startInvestigationSession(fixture.repository, {
        changeId: 'demo-change',
        blindManifest: fixture.blindManifest,
        blindRequest: regeneratedRequest,
      }),
      recovered,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('main terms and provider result join deterministically in either order', () => {
  const mainFirst = investigationFixture('invocation-main-first');
  const providerFirst = investigationFixture('invocation-provider-first');
  try {
    const mainFirstStarted = startFixture(mainFirst);
    const waiting = resumeInvestigationSession(
      mainFirst.repository,
      mainFirstStarted.investigationId,
      mainTermsEnvelope(mainFirstStarted),
    );
    assert.equal(waiting.state, 'waiting-for-provider');
    assert.equal(waiting.revision, 1);

    completeBlindInvocation(mainFirst, waiting.providerInvocationId);
    const mainFirstJoined = publishProviderResultToInvestigation(
      mainFirst.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        invocationId: waiting.providerInvocationId,
      },
    );
    assert.equal(mainFirstJoined.state, 'awaiting-group-dispositions');
    assert.equal(mainFirstJoined.revision, 2);
    assert.equal(mainFirstJoined.checkpoint?.kind, 'group-dispositions');

    const providerFirstStarted = startFixture(providerFirst);
    const concurrentMainEnvelope = mainTermsEnvelope(providerFirstStarted);
    completeBlindInvocation(
      providerFirst,
      providerFirstStarted.providerInvocationId,
    );
    const stillAwaitingMain = resumeInvestigationSession(
      providerFirst.repository,
      providerFirstStarted.investigationId,
    );
    assert.equal(stillAwaitingMain.state, 'awaiting-main-terms');
    assert.equal(stillAwaitingMain.revision, 1);
    assert.equal(stillAwaitingMain.checkpoint?.kind, 'main-terms');
    assert.deepEqual(
      resumeInvestigationSession(
        providerFirst.repository,
        providerFirstStarted.investigationId,
      ),
      stillAwaitingMain,
    );

    const refreshedMainEnvelope = mainTermsEnvelope(stillAwaitingMain);
    assert.equal(
      checkpointContributionDigest(concurrentMainEnvelope),
      checkpointContributionDigest(refreshedMainEnvelope),
    );
    const futureEnvelope = {
      ...concurrentMainEnvelope,
      expectedRevision: 999,
    };
    assert.throws(
      () =>
        resumeInvestigationSession(
          providerFirst.repository,
          stillAwaitingMain.investigationId,
          futureEnvelope,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CAS_MISMATCH'),
    );

    const providerFirstJoined = resumeInvestigationSession(
      providerFirst.repository,
      stillAwaitingMain.investigationId,
      concurrentMainEnvelope,
    );
    assert.equal(providerFirstJoined.state, 'awaiting-group-dispositions');
    assert.equal(providerFirstJoined.revision, 2);
    assert.equal(providerFirstJoined.checkpoint?.kind, 'group-dispositions');
  } finally {
    fs.rmSync(mainFirst.repository, { recursive: true, force: true });
    fs.rmSync(providerFirst.repository, { recursive: true, force: true });
  }
});

test('checkpoint transitions replay exactly and reject divergent stale input', () => {
  const fixture = investigationFixture('invocation-checkpoints');
  try {
    const started = startFixture(fixture);
    const mainEnvelope = mainTermsEnvelope(started);
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainEnvelope,
    );
    const bytesAfterMain = fs.readFileSync(
      sessionPath(fixture, started.investigationId),
      'utf8',
    );

    assert.deepEqual(
      resumeInvestigationSession(
        fixture.repository,
        started.investigationId,
        mainEnvelope,
      ),
      waiting,
    );
    assert.equal(
      fs.readFileSync(sessionPath(fixture, started.investigationId), 'utf8'),
      bytesAfterMain,
    );
    const divergentReplay = structuredClone(mainEnvelope);
    divergentReplay.payload.terms[0]!.value = 'DifferentMainTerm';
    assert.throws(
      () =>
        resumeInvestigationSession(
          fixture.repository,
          started.investigationId,
          divergentReplay,
        ),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_CHECKPOINT_CONFLICT') ||
        isWorkflowError(error, 'INVESTIGATION_CAS_MISMATCH'),
    );

    completeBlindInvocation(fixture, waiting.providerInvocationId);
    const joined = publishProviderResultToInvestigation(
      fixture.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        invocationId: waiting.providerInvocationId,
      },
    );
    assert.deepEqual(
      publishProviderResultToInvestigation(
        fixture.repository,
        waiting.investigationId,
        {
          expectedRevision: waiting.revision,
          invocationId: waiting.providerInvocationId,
        },
      ),
      joined,
    );

    const wrongKind = {
      ...createInvestigationCheckpointEnvelope(joined, {
        dispositions: [],
      }),
      kind: 'why-answers',
    };
    assert.throws(
      () =>
        resumeInvestigationSession(
          fixture.repository,
          joined.investigationId,
          wrongKind as never,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CHECKPOINT_INVALID'),
    );

    const awaitingWhy = resumeInvestigationSession(
      fixture.repository,
      joined.investigationId,
      createInvestigationCheckpointEnvelope(joined, {
        dispositions: [
          {
            groupId: 'a'.repeat(64),
            classification: 'load-bearing',
            rationale: 'The group protects the durable workflow invariant.',
            author: 'codex',
          },
        ],
      }),
    );
    assert.equal(awaitingWhy.state, 'awaiting-ledger-answers');
    assert.equal(awaitingWhy.checkpoint?.kind, 'why-answers');

    const afterWhy = resumeInvestigationSession(
      fixture.repository,
      awaitingWhy.investigationId,
      createInvestigationCheckpointEnvelope(awaitingWhy, {
        answers: [
          {
            manifestEntryId: 'b'.repeat(64),
            why: 'The file owns the durable transition state.',
            protectedInvariant: 'A stale writer cannot replace current state.',
            reviewerQuestion: 'Does every mutation remain CAS guarded?',
            answer:
              'Yes; the persisted revision is checked before replacement.',
            semanticAuthor: 'codex',
            readComplete: true,
          },
        ],
      }),
    );
    assert.equal(afterWhy.revision, awaitingWhy.revision + 1);
    assert.notEqual(afterWhy.state, 'awaiting-ledger-answers');
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('stale orthogonal writer loses CAS without replacing the durable winner', () => {
  const fixture = investigationFixture('invocation-cas-winner');
  try {
    const started = startFixture(fixture);
    completeBlindInvocation(fixture, started.providerInvocationId);
    const providerWinner = publishProviderResultToInvestigation(
      fixture.repository,
      started.investigationId,
      {
        expectedRevision: started.revision,
        invocationId: started.providerInvocationId,
      },
    );

    assert.throws(
      () =>
        compareAndSwapInvestigationSession(
          fixture.paths,
          started.investigationId,
          started.revision,
          (current) => current,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CAS_MISMATCH'),
    );
    assert.deepEqual(
      getInvestigationStatus(fixture.repository, started.investigationId),
      providerWinner,
    );

    const joined = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(providerWinner),
    );
    assert.equal(joined.state, 'awaiting-group-dispositions');
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status rejects an unreserved provider attempt fabricated through raw stores', () => {
  const fixture = investigationFixture('invocation-raw-attempt');
  try {
    const started = startFixture(fixture);
    const fabricatedRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-fabricated-attempt', {
        nonce: 'fabricated-attempt-nonce-0000',
      }),
    );
    storeProviderExecutionPolicySnapshot(
      fixture.paths,
      fabricatedRequest,
      loadAiAdapterPolicy(fixture.repository),
    );
    createProviderInvocation(fixture.paths, {
      investigationId: started.investigationId,
      changeId: started.changeId,
      attempt: 999,
      manifest: fixture.blindManifest,
      request: fabricatedRequest,
    });
    compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      started.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        blindRequestDigest: fabricatedRequest.requestDigest,
        blindInvocationIds: [
          ...current.blindInvocationIds,
          fabricatedRequest.invocationId,
        ],
        currentBlindInvocationId: fabricatedRequest.invocationId,
        updatedAt: new Date().toISOString(),
      }),
    );

    assert.throws(
      () => getInvestigationStatus(fixture.repository, started.investigationId),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_PROVIDER_HISTORY_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status rejects a reserved retry that reuses a prior nonce', () => {
  const fixture = investigationFixture('invocation-raw-nonce');
  try {
    const started = startFixture(fixture);
    const claim = claimProviderInvocation(
      fixture.paths,
      started.providerInvocationId,
      {
        workerId: 'raw-nonce-first-worker',
        leaseDurationMs: 1_000,
      },
    );
    const failed = failProviderInvocation(
      fixture.paths,
      started.providerInvocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          kind: 'retryable',
          code: 'PROVIDER_PROCESS_FAILED',
          message: 'Fixture failure before a fabricated retry.',
        },
      },
    );
    const duplicateNonceRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-duplicate-nonce', {
        nonce: fixture.request.nonce,
      }),
    );
    const retryAuthorization = authorizeProviderRetryFixture(
      fixture,
      failed,
      duplicateNonceRequest,
    );
    createProviderRetryReservation(fixture.paths, {
      investigationId: started.investigationId,
      changeId: started.changeId,
      attempt: 2,
      previousInvocationId: started.providerInvocationId,
      manifest: fixture.blindManifest,
      request: duplicateNonceRequest,
      ...retryAuthorization,
    });
    createProviderInvocation(fixture.paths, {
      investigationId: started.investigationId,
      changeId: started.changeId,
      attempt: 2,
      manifest: fixture.blindManifest,
      request: duplicateNonceRequest,
    });
    compareAndSwapInvestigationSession(
      fixture.paths,
      started.investigationId,
      started.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        blindRequestDigest: duplicateNonceRequest.requestDigest,
        blindInvocationIds: [
          ...current.blindInvocationIds,
          duplicateNonceRequest.invocationId,
        ],
        currentBlindInvocationId: duplicateNonceRequest.invocationId,
        updatedAt: new Date().toISOString(),
      }),
    );

    assert.throws(
      () => getInvestigationStatus(fixture.repository, started.investigationId),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_PROVIDER_HISTORY_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('status is read-only and short transition locks do not survive a call', () => {
  const fixture = investigationFixture('invocation-status');
  try {
    const started = startFixture(fixture);
    const persistedPath = sessionPath(fixture, started.investigationId);
    const beforeBytes = fs.readFileSync(persistedPath);
    const beforeStats = fs.statSync(persistedPath, { bigint: true });

    const first = getInvestigationStatus(
      fixture.repository,
      started.investigationId,
    );
    const second = getInvestigationStatus(
      fixture.repository,
      started.investigationId,
    );

    assert.deepEqual(first, started);
    assert.deepEqual(second, started);
    assert.deepEqual(fs.readFileSync(persistedPath), beforeBytes);
    assert.equal(
      fs.statSync(persistedPath, { bigint: true }).mtimeNs,
      beforeStats.mtimeNs,
    );

    const claim = claimProviderInvocation(
      fixture.paths,
      started.providerInvocationId,
      {
        workerId: 'status-redaction-worker',
        leaseDurationMs: 60_000,
      },
    );
    const leasedStatus = getInvestigationStatus(
      fixture.repository,
      started.investigationId,
    );
    assert.equal(leasedStatus.provider.state, 'leased');
    assert.equal(leasedStatus.provider.leaseGeneration, 1);
    assert.equal(
      JSON.stringify(leasedStatus).includes(claim.leaseToken),
      false,
    );
    assert.equal(
      JSON.stringify(leasedStatus).includes(fixture.request.nonce),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(fixture.repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(fixture.repository),
          'operations',
          `${started.investigationId}.lock`,
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.paths.locks, `${started.investigationId}.lock`),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.paths.locks, `${started.providerInvocationId}.lock`),
      ),
      false,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('session loading rejects a checkpoint copied from another investigation', () => {
  const donor = investigationFixture('invocation-checkpoint-donor');
  const victim = investigationFixture('invocation-checkpoint-victim');
  try {
    const donorStarted = startFixture(donor);
    resumeInvestigationSession(
      donor.repository,
      donorStarted.investigationId,
      mainTermsEnvelope(donorStarted),
    );
    const victimStarted = startFixture(victim);
    const donorSession = JSON.parse(
      fs.readFileSync(sessionPath(donor, donorStarted.investigationId), 'utf8'),
    ) as Record<string, unknown>;
    const victimSession = JSON.parse(
      fs.readFileSync(
        sessionPath(victim, victimStarted.investigationId),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const donorMilestones = donorSession.milestones as Record<string, unknown>;
    const victimMilestones = victimSession.milestones as Record<
      string,
      unknown
    >;
    victimMilestones.mainTerms = donorMilestones.mainTerms;
    victimSession.revision = 1;
    victimSession.state = 'waiting-for-provider';
    victimSession.updatedAt = new Date(
      Date.parse(victimSession.updatedAt as string) + 1,
    ).toISOString();
    fs.writeFileSync(
      sessionPath(victim, victimStarted.investigationId),
      `${canonicalJson(victimSession)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    assert.throws(
      () =>
        getInvestigationStatus(
          victim.repository,
          victimStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_SESSION_INVALID'),
    );
  } finally {
    fs.rmSync(donor.repository, { recursive: true, force: true });
    fs.rmSync(victim.repository, { recursive: true, force: true });
  }
});

test('session loading rejects persisted omission of both current revision clocks', () => {
  const fixture = investigationFixture(
    'invocation-session-revision-clock-omission',
  );
  try {
    const started = startFixture(fixture);
    const persistedPath = sessionPath(fixture, started.investigationId);
    const persisted = JSON.parse(
      fs.readFileSync(persistedPath, 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(persisted.semanticRevision, started.semanticRevision);
    assert.equal(persisted.lifecycleRevision, started.lifecycleRevision);
    delete persisted.semanticRevision;
    delete persisted.lifecycleRevision;
    const poisonedBytes = Buffer.from(`${canonicalJson(persisted)}\n`, 'utf8');
    fs.writeFileSync(persistedPath, poisonedBytes, { mode: 0o600 });

    assert.throws(
      () => readInvestigationSession(fixture.paths, started.investigationId),
      (error) => isWorkflowError(error, 'INVESTIGATION_SESSION_INVALID'),
    );
    assert.deepEqual(fs.readFileSync(persistedPath), poisonedBytes);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('propose status rejects persisted omission of the current PlanReview coverage policy digest', () => {
  const fixture = investigationFixture(
    'invocation-session-plan-review-coverage-policy-omission',
  );
  try {
    const started = startFixture(fixture);
    const persistedPath = sessionPath(fixture, started.investigationId);
    const currentRefPath = path.join(
      fixture.paths.refs,
      `${started.changeId}.investigation-session.json`,
    );
    const persisted = JSON.parse(
      fs.readFileSync(persistedPath, 'utf8'),
    ) as Record<string, unknown>;
    assert.match(
      String(persisted.planReviewCoveragePolicyDigest),
      /^[0-9a-f]{64}$/,
    );
    delete persisted.planReviewCoveragePolicyDigest;
    const poisonedBytes = Buffer.from(`${canonicalJson(persisted)}\n`, 'utf8');
    const currentRefBytes = fs.readFileSync(currentRefPath);
    fs.writeFileSync(persistedPath, poisonedBytes, { mode: 0o600 });

    for (const read of [
      () => readInvestigationSession(fixture.paths, started.investigationId),
      () => getProposeStatus(fixture.repository, started.investigationId),
    ]) {
      assert.throws(read, (error) =>
        isWorkflowError(error, 'INVESTIGATION_SESSION_INVALID'),
      );
    }
    assert.deepEqual(fs.readFileSync(persistedPath), poisonedBytes);
    assert.deepEqual(fs.readFileSync(currentRefPath), currentRefBytes);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('propose status rejects an unknown PlanReview coverage policy digest without rewriting durable state', () => {
  const fixture = investigationFixture(
    'invocation-session-unknown-plan-review-coverage-policy',
  );
  try {
    const started = startFixture(fixture);
    const persistedPath = sessionPath(fixture, started.investigationId);
    const currentRefPath = path.join(
      fixture.paths.refs,
      `${started.changeId}.investigation-session.json`,
    );
    const persisted = JSON.parse(
      fs.readFileSync(persistedPath, 'utf8'),
    ) as Record<string, unknown>;
    persisted.planReviewCoveragePolicyDigest = sha256(
      'unknown-plan-review-coverage-policy',
    );
    const poisonedBytes = Buffer.from(`${canonicalJson(persisted)}\n`, 'utf8');
    const currentRefBytes = fs.readFileSync(currentRefPath);
    fs.writeFileSync(persistedPath, poisonedBytes, { mode: 0o600 });

    for (const read of [
      () => readInvestigationSession(fixture.paths, started.investigationId),
      () => getProposeStatus(fixture.repository, started.investigationId),
    ]) {
      assert.throws(read, (error) =>
        isWorkflowError(error, 'INVESTIGATION_SESSION_INVALID'),
      );
    }
    assert.deepEqual(fs.readFileSync(persistedPath), poisonedBytes);
    assert.deepEqual(fs.readFileSync(currentRefPath), currentRefBytes);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('session loading rejects the retired implementation reconciliation policy tag', () => {
  const fixture = investigationFixture(
    'invocation-session-retired-reconciliation-policy-tag',
  );
  try {
    const started = startFixture(fixture);
    const persistedPath = sessionPath(fixture, started.investigationId);
    const currentRefPath = path.join(
      fixture.paths.refs,
      `${started.changeId}.investigation-session.json`,
    );
    const persisted = JSON.parse(
      fs.readFileSync(persistedPath, 'utf8'),
    ) as Record<string, unknown>;
    persisted.implementationReconciliationPolicyDigest = sha256(
      'retired-investigation-session-reconciliation-policy-tag',
    );
    const poisonedBytes = Buffer.from(`${canonicalJson(persisted)}\n`, 'utf8');
    const currentRefBytes = fs.readFileSync(currentRefPath);
    fs.writeFileSync(persistedPath, poisonedBytes, { mode: 0o600 });

    assert.throws(
      () => getInvestigationStatus(fixture.repository, started.investigationId),
      (error) => isWorkflowError(error, 'INVESTIGATION_SESSION_INVALID'),
    );
    assert.deepEqual(fs.readFileSync(persistedPath), poisonedBytes);
    assert.deepEqual(fs.readFileSync(currentRefPath), currentRefBytes);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('baseline drift and unsafe durable files fail closed', () => {
  const driftFixture = investigationFixture('invocation-baseline-drift');
  const modeFixture = investigationFixture('invocation-session-mode');
  const symlinkFixture = investigationFixture('invocation-state-symlink');
  const policyFixture = investigationFixture('invocation-policy-snapshot');
  try {
    const driftStarted = startFixture(driftFixture);
    fs.writeFileSync(
      path.join(driftFixture.repository, 'src/drift.ts'),
      'export {};\n',
    );
    git(driftFixture.repository, ['add', 'src/drift.ts']);
    git(driftFixture.repository, ['commit', '-m', 'Advance baseline']);
    assert.throws(
      () =>
        getInvestigationStatus(
          driftFixture.repository,
          driftStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CONTEXT_STALE'),
    );
    assert.throws(
      () =>
        resumeInvestigationSession(
          driftFixture.repository,
          driftStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_CONTEXT_STALE'),
    );

    const modeStarted = startFixture(modeFixture);
    fs.chmodSync(sessionPath(modeFixture, modeStarted.investigationId), 0o644);
    assert.throws(
      () =>
        getInvestigationStatus(
          modeFixture.repository,
          modeStarted.investigationId,
        ),
      (error) => isWorkflowError(error, 'INVESTIGATION_SESSION_UNSAFE'),
    );

    const symlinkStarted = startFixture(symlinkFixture);
    const statePath = invocationPath(
      symlinkFixture,
      symlinkStarted.providerInvocationId,
    );
    const displacedPath = path.join(path.dirname(statePath), 'displaced.json');
    fs.renameSync(statePath, displacedPath);
    fs.symlinkSync(displacedPath, statePath);
    assert.throws(
      () =>
        readProviderInvocation(
          symlinkFixture.paths,
          symlinkStarted.providerInvocationId,
        ),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_STORE_UNSAFE'),
    );

    const policyStarted = startFixture(policyFixture);
    const invocationDirectory = path.join(
      policyFixture.paths.invocations,
      policyStarted.providerInvocationId,
    );
    const policySnapshotPath = path.join(
      invocationDirectory,
      'execution-policy.json',
    );
    const exactPolicySnapshot = fs.readFileSync(policySnapshotPath, 'utf8');
    const policySnapshot = JSON.parse(exactPolicySnapshot) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      policySnapshotPath,
      `${canonicalJson({ ...policySnapshot, requestDigest: '9'.repeat(64) })}\n`,
    );
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          policyFixture.paths,
          policyStarted.investigationId,
          policyFixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );

    fs.writeFileSync(policySnapshotPath, exactPolicySnapshot);
    fs.writeFileSync(
      path.join(invocationDirectory, 'unexpected.json'),
      '{}\n',
      {
        mode: 0o600,
      },
    );
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          policyFixture.paths,
          policyStarted.investigationId,
          policyFixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
  } finally {
    fs.rmSync(driftFixture.repository, { recursive: true, force: true });
    fs.rmSync(modeFixture.repository, { recursive: true, force: true });
    fs.rmSync(symlinkFixture.repository, { recursive: true, force: true });
    fs.rmSync(policyFixture.repository, { recursive: true, force: true });
  }
});

test('quarantine classifies a current provider invocation missing its required execution policy snapshot as an unsafe observation', () => {
  const fixture = investigationFixture('invocation-policy-snapshot-required');
  try {
    const started = startFixture(fixture);
    const invocationDirectory = path.join(
      fixture.paths.invocations,
      started.providerInvocationId,
    );
    const policySnapshotPath = path.join(
      invocationDirectory,
      'execution-policy.json',
    );
    const exactInvocationFiles = new Map(
      ['manifest.json', 'request.json', 'state.json'].map(
        (name) =>
          [
            name,
            fs.readFileSync(path.join(invocationDirectory, name)),
          ] as const,
      ),
    );
    fs.rmSync(policySnapshotPath);

    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          fixture.paths,
          started.investigationId,
          fixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );

    const quarantine = inspectInvestigationQuarantineState(
      fixture.paths,
      started.investigationId,
      fixture.blindManifest.repositoryId,
    );
    const invocation = quarantine.envelope.providerInvocationDigests.find(
      ({ invocationId }) => invocationId === started.providerInvocationId,
    );
    assert.ok(invocation);
    assert.deepEqual(
      invocation.files.map(({ name }) => name),
      ['unsafe-observation'],
    );
    assert.notEqual(quarantine.envelope.ambiguityDigest, null);
    assert.deepEqual(
      quarantine.availableResolutions.map(({ kind }) => kind),
      ['quarantine'],
    );
    assert.equal(fs.existsSync(policySnapshotPath), false);
    for (const [name, exactBytes] of exactInvocationFiles) {
      assert.deepEqual(
        fs.readFileSync(path.join(invocationDirectory, name)),
        exactBytes,
      );
    }
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('a rejected propose envelope names the envelope and the offending keys', () => {
  // A caller assembles these by hand, so a refusal that names neither the
  // envelope nor the key sends them to the engine source to find out which of
  // eight shapes was meant.
  assert.throws(
    () =>
      resumePropose('/not/a/git/repository', 'some-change', {
        schemaVersion: 1,
        kind: 'plan-review-progress',
        investigationId: 'investigation-x',
        changeId: 'some-change',
        subjectDigest: 'a'.repeat(64),
        invocationId: 'invocation-x',
      }),
    (error: unknown) => {
      const { code, message } = error as { code?: string; message?: string };
      assert.equal(code, 'PROPOSE_INPUT_INVALID');
      assert.match(String(message), /plan-review-progress/);
      assert.match(String(message), /missing requestDigest/);
      return true;
    },
  );
});
