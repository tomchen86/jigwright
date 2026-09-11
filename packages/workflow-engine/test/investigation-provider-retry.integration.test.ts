import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  previewExecutionJobRetry,
  requestExecutionJobRetry,
} from '../src/composition-root/execution-retry-production.ts';
import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { projectProviderInvocationExecution } from '../src/modules/provider-orchestration/execution-core.ts';
import { readExecutionJobState } from '../src/runtime/storage-journal/execution-store.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createInvestigationCheckpointEnvelope,
  publishProviderResultToInvestigation,
  resumeInvestigationSession,
  retryInvestigationProvider,
} from '../src/composition-root/investigation-retry-production.ts';
import {
  createProviderRetryEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/composition-root/propose-production.ts';
import { createProviderRunnerForTesting } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import {
  inspectInvestigationQuarantineState,
  inspectInvestigationResolutionState,
} from '../src/runtime/storage-journal/human-resolution-state.ts';
import { readInvestigationSession } from '../src/runtime/storage-journal/investigation-session-records.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
  createProviderInvocation,
  createProviderRetryReservation,
  expireProviderInvocationLease,
  failProviderInvocation,
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  storeProviderExecutionPolicySnapshot,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import {
  FIRST_INSTANT,
  DURING_COMPLETION_GRACE,
  BEFORE_EXPIRY,
  AT_EXPIRY,
  setFixtureProviderTimeout,
  createFailedProviderInvocationFixture,
  authorizeProviderRetryFixture,
  investigationFixture,
  malformedClaudeRunnerHost,
  providerRequestInput,
  startFixture,
  mainTermsEnvelope,
  completeBlindInvocation,
  providerWireResult,
  providerOutcome,
  runWorkflowCli,
  invocationPath,
  sha256,
} from './investigation-session-fixture.ts';

test('provider leases expire, fence stale workers, and never persist raw tokens', () => {
  const fixture = investigationFixture('invocation-lease');
  try {
    storeProviderExecutionPolicySnapshot(
      fixture.paths,
      fixture.request,
      loadAiAdapterPolicy(fixture.repository),
    );
    assert.throws(
      () =>
        createProviderInvocation(fixture.paths, {
          investigationId: '../escape',
          changeId: 'demo-change',
          attempt: 1,
          manifest: fixture.blindManifest,
          request: fixture.request,
          createdAt: FIRST_INSTANT,
        }),
      (error) =>
        isWorkflowError(error, 'INVALID_INVOCATION_ID') ||
        isWorkflowError(error, 'INVALID_INVESTIGATION_ID'),
    );
    assert.throws(
      () => readProviderInvocation(fixture.paths, '../escape'),
      (error) => isWorkflowError(error, 'INVALID_INVOCATION_ID'),
    );

    const created = createProviderInvocation(fixture.paths, {
      investigationId: 'investigation-manual-lease',
      changeId: 'demo-change',
      attempt: 1,
      manifest: fixture.blindManifest,
      request: fixture.request,
      createdAt: FIRST_INSTANT,
    });
    assert.equal(created.state, 'prepared');
    assert.equal(created.revision, 0);

    const firstClaim = claimProviderInvocation(
      fixture.paths,
      fixture.request.invocationId,
      {
        workerId: 'worker-a',
        leaseDurationMs: 1_000,
        now: FIRST_INSTANT,
      },
    );
    assert.equal(firstClaim.record.state, 'leased');
    assert.equal(firstClaim.record.lease?.generation, 1);
    assert.equal(
      firstClaim.record.lease?.tokenDigest,
      sha256(firstClaim.leaseToken),
    );
    assert.equal(
      fs
        .readFileSync(
          invocationPath(fixture, fixture.request.invocationId),
          'utf8',
        )
        .includes(firstClaim.leaseToken),
      false,
    );

    assert.throws(
      () =>
        claimProviderInvocation(fixture.paths, fixture.request.invocationId, {
          workerId: 'worker-b',
          leaseDurationMs: 1_000,
          now: BEFORE_EXPIRY,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_CONFLICT'),
    );

    assert.throws(
      () =>
        claimProviderInvocation(fixture.paths, fixture.request.invocationId, {
          workerId: 'worker-b',
          leaseDurationMs: 1_000,
          now: AT_EXPIRY,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_EXPIRED'),
    );

    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          fixture.request.invocationId,
          {
            expectedRevision: firstClaim.record.revision,
            leaseGeneration: firstClaim.record.leaseGeneration,
            leaseToken: firstClaim.leaseToken,
            outcome: providerOutcome(fixture.request),
            now: AT_EXPIRY,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_LEASE_STALE'),
    );

    const expired = expireProviderInvocationLease(
      fixture.paths,
      fixture.request.invocationId,
      {
        expectedRevision: firstClaim.record.revision,
        now: AT_EXPIRY,
      },
    );
    assert.equal(expired.state, 'failed');
    assert.equal(expired.lease, null);
    assert.equal(expired.failure?.code, 'PROVIDER_INVOCATION_LEASE_EXPIRED');

    const replacementRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-lease-retry', {
        nonce: 'lease-retry-nonce-at-least-16-bytes',
      }),
    );
    storeProviderExecutionPolicySnapshot(
      fixture.paths,
      replacementRequest,
      loadAiAdapterPolicy(fixture.repository),
    );
    createProviderInvocation(fixture.paths, {
      investigationId: 'investigation-manual-lease',
      changeId: 'demo-change',
      attempt: 2,
      manifest: fixture.blindManifest,
      request: replacementRequest,
      createdAt: FIRST_INSTANT,
    });
    const secondClaim = claimProviderInvocation(
      fixture.paths,
      replacementRequest.invocationId,
      {
        workerId: 'worker-b',
        leaseDurationMs: 1_000,
        now: FIRST_INSTANT,
      },
    );
    assert.equal(secondClaim.record.lease?.generation, 1);
    assert.notEqual(secondClaim.leaseToken, firstClaim.leaseToken);

    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          replacementRequest.invocationId,
          {
            expectedRevision: secondClaim.record.revision,
            leaseGeneration: secondClaim.record.leaseGeneration,
            leaseToken: secondClaim.leaseToken,
            outcome: {
              ...providerOutcome(replacementRequest),
              stdout: '{malformed',
            },
            now: DURING_COMPLETION_GRACE,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RESULT_INVALID'),
    );
    assert.deepEqual(
      readProviderInvocation(fixture.paths, replacementRequest.invocationId),
      secondClaim.record,
    );
    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          replacementRequest.invocationId,
          {
            expectedRevision: secondClaim.record.revision,
            leaseGeneration: secondClaim.record.leaseGeneration,
            leaseToken: secondClaim.leaseToken,
            outcome: {
              ...providerOutcome(replacementRequest),
              stdout: JSON.stringify(
                providerWireResult(replacementRequest, {
                  arbitrary: 'caller cannot replace the code-owned validator',
                }),
              ),
            },
            now: DURING_COMPLETION_GRACE,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
    );
    assert.deepEqual(
      readProviderInvocation(fixture.paths, replacementRequest.invocationId),
      secondClaim.record,
    );

    const completed = completeProviderInvocation(
      fixture.paths,
      replacementRequest.invocationId,
      {
        expectedRevision: secondClaim.record.revision,
        leaseGeneration: secondClaim.record.leaseGeneration,
        leaseToken: secondClaim.leaseToken,
        outcome: providerOutcome(replacementRequest),
        now: DURING_COMPLETION_GRACE,
      },
    );
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.lease, null);
    assert.equal(
      readProviderInvocation(fixture.paths, replacementRequest.invocationId)
        .state,
      'succeeded',
    );
    const completedStatePath = invocationPath(
      fixture,
      replacementRequest.invocationId,
    );
    const completedStateBytes = fs.readFileSync(completedStatePath, 'utf8');
    const tamperedState = JSON.parse(completedStateBytes) as {
      result: {
        output: unknown;
        outputDigest: string;
      };
    };
    tamperedState.result.output = {
      arbitrary: 'digest-valid output still must satisfy the code-owned schema',
    };
    tamperedState.result.outputDigest = sha256(
      canonicalJson({
        id: replacementRequest.outputSchema.id,
        version: replacementRequest.outputSchema.version,
        output: tamperedState.result.output,
      }),
    );
    fs.writeFileSync(
      completedStatePath,
      `${canonicalJson(tamperedState)}\n`,
      'utf8',
    );
    assert.throws(
      () =>
        readProviderInvocation(fixture.paths, replacementRequest.invocationId),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_RESULT_INVALID'),
    );
    fs.writeFileSync(completedStatePath, completedStateBytes, 'utf8');

    assert.throws(
      () =>
        completeProviderInvocation(
          fixture.paths,
          replacementRequest.invocationId,
          {
            expectedRevision: secondClaim.record.revision,
            leaseGeneration: secondClaim.record.leaseGeneration,
            leaseToken: secondClaim.leaseToken,
            outcome: providerOutcome(replacementRequest),
            now: DURING_COMPLETION_GRACE,
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_CAS_MISMATCH'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('failed provider work can retry without discarding completed main input', () => {
  const fixture = investigationFixture('invocation-first-attempt');
  try {
    const started = startFixture(fixture);
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(started),
    );
    const claim = claimProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
      {
        workerId: 'worker-failing',
        leaseDurationMs: 1_000,
      },
    );
    const failed = failProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          kind: 'retryable',
          code: 'PROVIDER_PROCESS_FAILED',
          message: 'Provider exited non-zero.',
        },
      },
    );
    assert.equal(failed.state, 'failed');

    const replacement = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-second-attempt', {
        nonce: 'replacement-nonce-at-least-16-bytes',
      }),
    );
    const replacementAuthorization = authorizeProviderRetryFixture(
      fixture,
      failed,
      replacement,
    );
    const retryReservation = createProviderRetryReservation(fixture.paths, {
      investigationId: waiting.investigationId,
      changeId: waiting.changeId,
      attempt: 2,
      previousInvocationId: waiting.providerInvocationId,
      manifest: fixture.blindManifest,
      request: replacement,
      ...replacementAuthorization,
    });
    const retryReservationPath = path.join(
      fixture.paths.refs,
      `${waiting.investigationId}.provider-retry-2.json`,
    );
    const retryReservationDigest = sha256(
      fs.readFileSync(retryReservationPath, 'utf8'),
    );
    const pendingResolutionState = inspectInvestigationResolutionState(
      fixture.paths,
      waiting.investigationId,
      fixture.blindManifest.repositoryId,
    );
    assert.deepEqual(
      (
        pendingResolutionState.envelope as unknown as {
          providerRetryReservations: unknown;
        }
      ).providerRetryReservations,
      [
        {
          attempt: 2,
          previousInvocationId: waiting.providerInvocationId,
          invocationId: replacement.invocationId,
          reservationDigest: retryReservationDigest,
          status: 'pending',
        },
      ],
    );
    createProviderInvocation(fixture.paths, {
      investigationId: 'investigation-other-owner',
      changeId: waiting.changeId,
      attempt: 2,
      manifest: fixture.blindManifest,
      request: replacement,
    });
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          fixture.paths,
          waiting.investigationId,
          fixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
    fs.rmSync(path.join(fixture.paths.invocations, replacement.invocationId), {
      recursive: true,
    });
    storeProviderExecutionPolicySnapshot(
      fixture.paths,
      replacement,
      loadAiAdapterPolicy(fixture.repository),
    );
    createProviderInvocation(fixture.paths, {
      investigationId: waiting.investigationId,
      changeId: waiting.changeId,
      attempt: 2,
      manifest: fixture.blindManifest,
      request: replacement,
    });
    const pendingInvocationResolutionState =
      inspectInvestigationResolutionState(
        fixture.paths,
        waiting.investigationId,
        fixture.blindManifest.repositoryId,
      );
    assert.notEqual(
      pendingInvocationResolutionState.currentStateDigest,
      pendingResolutionState.currentStateDigest,
    );
    assert.equal(
      pendingInvocationResolutionState.envelope.providerInvocationDigests.some(
        ({ invocationId }) => invocationId === replacement.invocationId,
      ),
      true,
    );
    assert.deepEqual(
      (
        pendingInvocationResolutionState.envelope as unknown as {
          providerRetryReservations: unknown;
        }
      ).providerRetryReservations,
      (
        pendingResolutionState.envelope as unknown as {
          providerRetryReservations: unknown;
        }
      ).providerRetryReservations,
    );
    const regeneratedReplacement = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-regenerated-second-attempt', {
        nonce: 'regenerated-retry-nonce-at-least-16-bytes',
      }),
    );
    const retried = retryInvestigationProvider(
      fixture.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        replacementRequest: regeneratedReplacement,
      },
    );
    assert.equal(retried.state, 'waiting-for-provider');
    assert.equal(retried.providerInvocationId, replacement.invocationId);
    assert.equal(retried.revision, waiting.revision + 1);
    assert.equal(
      readProviderInvocation(fixture.paths, replacement.invocationId).state,
      'prepared',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.invocations,
          regeneratedReplacement.invocationId,
        ),
      ),
      false,
    );
    assert.deepEqual(
      readProviderRetryReservation(fixture.paths, waiting.investigationId, 2),
      retryReservation,
    );
    const committedResolutionState = inspectInvestigationResolutionState(
      fixture.paths,
      waiting.investigationId,
      fixture.blindManifest.repositoryId,
    );
    assert.notEqual(
      committedResolutionState.currentStateDigest,
      pendingResolutionState.currentStateDigest,
    );
    assert.deepEqual(
      (
        committedResolutionState.envelope as unknown as {
          providerRetryReservations: unknown;
        }
      ).providerRetryReservations,
      [
        {
          attempt: 2,
          previousInvocationId: waiting.providerInvocationId,
          invocationId: replacement.invocationId,
          reservationDigest: retryReservationDigest,
          status: 'committed',
        },
      ],
    );

    completeBlindInvocation(
      { ...fixture, request: replacement },
      replacement.invocationId,
    );
    const joined = publishProviderResultToInvestigation(
      fixture.repository,
      retried.investigationId,
      {
        expectedRevision: retried.revision,
        invocationId: replacement.invocationId,
      },
    );
    assert.equal(joined.state, 'awaiting-group-dispositions');
    assert.equal(joined.checkpoint?.kind, 'group-dispositions');

    const stableResolutionState = inspectInvestigationResolutionState(
      fixture.paths,
      joined.investigationId,
      fixture.blindManifest.repositoryId,
    );
    const unrelatedFailed = createFailedProviderInvocationFixture(
      fixture,
      'investigation-unrelated-retry',
      'invocation-unrelated-failed',
    );
    const unrelatedRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-unrelated-retry', {
        nonce: 'unrelated-retry-nonce-at-least-16-bytes',
      }),
    );
    const unrelatedAuthorization = authorizeProviderRetryFixture(
      fixture,
      unrelatedFailed,
      unrelatedRequest,
    );
    createProviderRetryReservation(fixture.paths, {
      investigationId: 'investigation-unrelated-retry',
      changeId: waiting.changeId,
      attempt: 2,
      previousInvocationId: unrelatedFailed.invocationId,
      manifest: fixture.blindManifest,
      request: unrelatedRequest,
      ...unrelatedAuthorization,
    });
    assert.equal(
      inspectInvestigationResolutionState(
        fixture.paths,
        joined.investigationId,
        fixture.blindManifest.repositoryId,
      ).currentStateDigest,
      stableResolutionState.currentStateDigest,
    );

    const extraRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-extra-retry', {
        nonce: 'extra-retry-nonce-at-least-16-bytes',
      }),
    );
    const extraAuthorization = authorizeProviderRetryFixture(
      fixture,
      unrelatedFailed,
      extraRequest,
    );
    createProviderRetryReservation(fixture.paths, {
      investigationId: joined.investigationId,
      changeId: waiting.changeId,
      attempt: 4,
      previousInvocationId: unrelatedFailed.invocationId,
      manifest: fixture.blindManifest,
      request: extraRequest,
      ...extraAuthorization,
    });
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          fixture.paths,
          joined.investigationId,
          fixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
    assert.notEqual(
      inspectInvestigationQuarantineState(
        fixture.paths,
        joined.investigationId,
        fixture.blindManifest.repositoryId,
      ).envelope.ambiguityDigest,
      null,
    );
    fs.unlinkSync(
      path.join(
        fixture.paths.refs,
        `${joined.investigationId}.provider-retry-4.json`,
      ),
    );
    fs.rmSync(path.join(fixture.paths.invocations, extraRequest.invocationId), {
      recursive: true,
    });

    const exactRetryReservation = fs.readFileSync(retryReservationPath, 'utf8');
    fs.writeFileSync(retryReservationPath, '{"broken":true}\n');
    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          fixture.paths,
          joined.investigationId,
          fixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
    const firstMalformedDigest = inspectInvestigationQuarantineState(
      fixture.paths,
      joined.investigationId,
      fixture.blindManifest.repositoryId,
    ).envelope.ambiguityDigest;
    fs.writeFileSync(retryReservationPath, '{"broken":false}\n');
    const secondMalformedDigest = inspectInvestigationQuarantineState(
      fixture.paths,
      joined.investigationId,
      fixture.blindManifest.repositoryId,
    ).envelope.ambiguityDigest;
    assert.notEqual(firstMalformedDigest, secondMalformedDigest);
    fs.writeFileSync(retryReservationPath, exactRetryReservation);
    assert.equal(
      inspectInvestigationResolutionState(
        fixture.paths,
        joined.investigationId,
        fixture.blindManifest.repositoryId,
      ).currentStateDigest,
      stableResolutionState.currentStateDigest,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('investigation resolution replay rejects retired V1 provider retry reservations', () => {
  const fixture = investigationFixture('invocation-retired-retry-reader');
  try {
    const started = startFixture(fixture);
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(started),
    );
    const claim = claimProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
      {
        workerId: 'worker-retired-retry-reader',
        leaseDurationMs: 1_000,
      },
    );
    const failed = failProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          kind: 'retryable',
          code: 'PROVIDER_PROCESS_FAILED',
          message: 'Provider exited non-zero.',
        },
      },
    );
    const replacement = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-retired-retry-replacement', {
        nonce: 'retired-retry-reader-nonce-at-least-16-bytes',
      }),
    );
    const authorization = authorizeProviderRetryFixture(
      fixture,
      failed,
      replacement,
    );
    const current = createProviderRetryReservation(fixture.paths, {
      investigationId: waiting.investigationId,
      changeId: waiting.changeId,
      attempt: 2,
      previousInvocationId: waiting.providerInvocationId,
      manifest: fixture.blindManifest,
      request: replacement,
      ...authorization,
    });
    const legacy = structuredClone(current) as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.executionPolicySnapshot;
    delete legacy.retryDecision;
    fs.writeFileSync(
      path.join(
        fixture.paths.refs,
        `${waiting.investigationId}.provider-retry-2.json`,
      ),
      `${canonicalJson(legacy)}\n`,
      'utf8',
    );

    assert.throws(
      () =>
        inspectInvestigationResolutionState(
          fixture.paths,
          waiting.investigationId,
          fixture.blindManifest.repositoryId,
        ),
      (error) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
    );
    assert.notEqual(
      inspectInvestigationQuarantineState(
        fixture.paths,
        waiting.investigationId,
        fixture.blindManifest.repositoryId,
      ).envelope.ambiguityDigest,
      null,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('malformed native output creates bounded durable repair evidence and replacement is fully revalidated', () => {
  const fixture = investigationFixture('invocation-repair-first-attempt');
  const policyDigest = sha256(
    fs.readFileSync(
      path.join(fixture.repository, 'workflow/ai-adapter-policy.json'),
      'utf8',
    ),
  );
  fixture.request = createProviderInvocationRequest(
    providerRequestInput(fixture, fixture.request.invocationId, {
      policyDigest,
    }),
  );
  try {
    const started = startFixture(fixture);
    const waiting = resumeInvestigationSession(
      fixture.repository,
      started.investigationId,
      mainTermsEnvelope(started),
    );
    const malformed = 'not-json secret-that-must-not-enter-repair-evidence';
    const worker = runProviderWorker(
      fixture.repository,
      waiting.providerInvocationId,
      {
        platform: 'darwin',
        runner(input) {
          return createProviderRunnerForTesting(
            malformedClaudeRunnerHost(malformed),
          ).run(input, { platform: 'darwin' });
        },
      },
    );
    assert.equal(worker.state, 'failed');
    assert.equal(worker.failure?.code, 'PROVIDER_NATIVE_OUTPUT_INVALID');
    const failed = readProviderInvocation(
      fixture.paths,
      waiting.providerInvocationId,
    );
    assert.equal(failed.state, 'failed');
    const repairEvidenceBytes = fs.readFileSync(
      path.join(
        fixture.paths.invocations,
        waiting.providerInvocationId,
        'repair-evidence.json',
      ),
      'utf8',
    );
    assert.ok(Buffer.byteLength(repairEvidenceBytes, 'utf8') < 300_000);
    assert.equal(repairEvidenceBytes.includes(malformed), false);
    assert.match(repairEvidenceBytes, /NATIVE_JSON_PARSE_FAILED/);

    const replacementRequest = createProviderInvocationRequest(
      providerRequestInput(fixture, 'invocation-repair-second-attempt', {
        nonce: 'repair-replacement-nonce-at-least-16-bytes',
        policyDigest,
      }),
    );
    const retried = retryInvestigationProvider(
      fixture.repository,
      waiting.investigationId,
      {
        expectedRevision: waiting.revision,
        replacementRequest,
      },
    );
    const replacement = readProviderInvocation(
      fixture.paths,
      replacementRequest.invocationId,
    );
    const jobId = projectProviderInvocationExecution({
      record: replacement,
      request: replacementRequest,
    }).job.jobId;
    const durable = readExecutionJobState(fixture.paths, jobId);
    assert.ok(durable);
    assert.equal(durable.attempts[1]!.retryMode, 'repair');
    assert.equal(durable.job.repairAttemptCount, 1);
    assert.equal(retried.providerInvocationId, replacement.invocationId);

    const replacementClaim = claimProviderInvocation(
      fixture.paths,
      replacement.invocationId,
      {
        workerId: 'worker-schema-repair',
        leaseDurationMs: 1_000,
      },
    );
    const invalidOutcome = providerOutcome(replacementRequest);
    const invalidEnvelope = JSON.parse(invalidOutcome.stdout) as {
      output: { terms: unknown[] };
    };
    invalidEnvelope.output.terms = [];
    assert.throws(
      () =>
        completeProviderInvocation(fixture.paths, replacement.invocationId, {
          expectedRevision: replacementClaim.record.revision,
          leaseGeneration: replacementClaim.record.leaseGeneration,
          leaseToken: replacementClaim.leaseToken,
          outcome: {
            ...invalidOutcome,
            stdout: JSON.stringify(invalidEnvelope),
          },
        }),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_INVALID'),
    );
    const completed = completeProviderInvocation(
      fixture.paths,
      replacement.invocationId,
      {
        expectedRevision: replacementClaim.record.revision,
        leaseGeneration: replacementClaim.record.leaseGeneration,
        leaseToken: replacementClaim.leaseToken,
        outcome: providerOutcome(replacementRequest),
      },
    );
    assert.equal(completed.state, 'succeeded');
    assert.equal(
      readExecutionJobState(fixture.paths, jobId)?.job.acceptedAttemptId,
      durable.attempts[1]!.attemptId,
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('propose retry envelope authorizes one idempotent replacement survey', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-provider-retry-input-'),
  );
  const changeId = 'retry-provider-survey';
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    setFixtureProviderTimeout(repository, 300_000);
    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Exercise the explicit provider retry transition.',
        sourceRefs: [],
        explicitPaths: [
          'packages/workflow-engine/src/entrypoints/worker/provider-worker.ts',
        ],
        explicitSymbols: ['runProviderWorker'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
      },
    );
    const investigationId = started.investigation!.investigationId;
    const afterMain = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(started.investigation!, {
        reference: 'provider-retry-main-terms',
        terms: [
          {
            kind: 'symbol',
            value: 'runProviderWorker',
            rationale:
              'The provider worker owns durable launch and failure handling.',
            expectedRelationship:
              'Retry must preserve the failed invocation before replacement.',
          },
        ],
      }),
    );
    const paths = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const firstInvocationId = afterMain.investigation!.providerInvocationId;
    const firstRequest = readProviderInvocationRequest(
      paths,
      firstInvocationId,
    );
    const firstClaim = claimProviderInvocation(paths, firstInvocationId, {
      workerId: 'worker-first-retryable-failure',
      leaseDurationMs: 1_000,
    });
    failProviderInvocation(paths, firstInvocationId, {
      expectedRevision: firstClaim.record.revision,
      leaseGeneration: firstClaim.record.leaseGeneration,
      leaseToken: firstClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Provider exited non-zero.',
      },
    });
    const firstFailureBytes = fs.readFileSync(
      path.join(paths.invocations, firstInvocationId, 'state.json'),
      'utf8',
    );
    const failed = getProposeStatus(repository, investigationId);
    assert.equal(failed.nextAction, 'retry-provider');
    if (failed.investigation?.kind !== 'investigation') {
      assert.fail('Expected an ordinary investigation retry status.');
    }
    const failedInvestigation = failed.investigation;
    assert.deepEqual(failed.inputSchema, {
      schemaVersion: 1,
      kind: 'provider-retry',
      binding: {
        investigationId,
        changeId,
        expectedRevision: failedInvestigation.revision,
        baseline: failedInvestigation.baseline,
        intentDigest: failedInvestigation.intentDigest,
        blindManifestDigest: failedInvestigation.blindManifestDigest,
        failedInvocation: {
          invocationId: firstInvocationId,
          attempt: failedInvestigation.provider.attempt,
          revision: failedInvestigation.provider.revision,
          requestDigest: firstRequest.requestDigest,
          failureDigest: sha256(
            canonicalJson(failedInvestigation.provider.failure),
          ),
        },
      },
      requiredAcknowledgement: {
        acknowledgeProviderCost: true,
      },
      template: {
        schemaVersion: 1,
        kind: 'provider-retry',

        investigationId,
        changeId,
        expectedRevision: failedInvestigation.revision,
        baseline: failedInvestigation.baseline,
        intentDigest: failedInvestigation.intentDigest,
        blindManifestDigest: failedInvestigation.blindManifestDigest,
        failedInvocation: {
          invocationId: firstInvocationId,
          attempt: failedInvestigation.provider.attempt,
          revision: failedInvestigation.provider.revision,
          requestDigest: firstRequest.requestDigest,
          failureDigest: sha256(
            canonicalJson(failedInvestigation.provider.failure),
          ),
        },
        acknowledgeProviderCost: true,
      },
    });
    assert.throws(
      () =>
        resumePropose(repository, changeId, {
          ...createProviderRetryEnvelope(repository, failed, {
            acknowledgeProviderCost: true,
          }),
          acknowledgeProviderCost: false,
        } as never),
      (error) => isWorkflowError(error, 'PROPOSE_INPUT_INVALID'),
    );

    const retryEnvelope = createProviderRetryEnvelope(repository, failed, {
      acknowledgeProviderCost: true,
    });
    setFixtureProviderTimeout(repository, 600_000);
    assert.throws(
      () =>
        resumePropose(repository, changeId, {
          ...retryEnvelope,
          failedInvocation: {
            ...retryEnvelope.failedInvocation,
            failureDigest: 'f'.repeat(64),
          },
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RETRY_INPUT_STALE'),
    );
    assert.equal(readProviderRetryReservation(paths, investigationId, 2), null);
    assert.equal(
      fs
        .readdirSync(paths.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      1,
    );
    const mainTermsBeforeRetry = structuredClone(
      readInvestigationSession(paths, investigationId).milestones.mainTerms,
    );
    const driven: string[] = [];
    const dispatched: string[] = [];
    const retried = resumePropose(repository, changeId, retryEnvelope, {
      providerDriver({ request }) {
        driven.push(request.invocationId);
      },
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    const secondInvocationId = retried.investigation!.providerInvocationId;
    assert.notEqual(secondInvocationId, firstInvocationId);
    assert.equal(retried.investigation!.provider.attempt, 2);
    assert.equal(
      retried.investigation!.revision,
      failed.investigation!.revision + 1,
    );
    assert.deepEqual(driven, [secondInvocationId]);
    assert.equal(dispatched.length, 0);
    const secondRequest = readProviderInvocationRequest(
      paths,
      secondInvocationId,
    );
    const {
      invocationId: _firstInvocationId,
      nonce: _firstNonce,
      requestDigest: _firstRequestDigest,
      policyDigest: _firstPolicyDigest,
      limits: _firstLimits,
      ...firstBinding
    } = firstRequest;
    const {
      invocationId: _secondInvocationId,
      nonce: _secondNonce,
      requestDigest: _secondRequestDigest,
      policyDigest: _secondPolicyDigest,
      limits: _secondLimits,
      retryExplanation: _secondExplanation,
      ...secondBinding
    } = secondRequest;
    assert.deepEqual(secondBinding, firstBinding);
    assert.equal(firstRequest.limits.timeoutMs, 300_000);
    assert.equal(secondRequest.limits.timeoutMs, 600_000);
    assert.notEqual(secondRequest.policyDigest, firstRequest.policyDigest);
    assert.notEqual(secondRequest.nonce, firstRequest.nonce);
    assert.notEqual(secondRequest.requestDigest, firstRequest.requestDigest);
    assert.equal(
      fs.readFileSync(
        path.join(paths.invocations, firstInvocationId, 'state.json'),
        'utf8',
      ),
      firstFailureBytes,
    );
    const retryReservation = readProviderRetryReservation(
      paths,
      investigationId,
      2,
    );
    assert.equal(retryReservation?.previousInvocationId, firstInvocationId);
    assert.equal(retryReservation?.invocationId, secondInvocationId);
    assert.deepEqual(
      readInvestigationSession(paths, investigationId).milestones.mainTerms,
      mainTermsBeforeRetry,
    );

    const replayedPrepared = resumePropose(
      repository,
      changeId,
      retryEnvelope,
      {
        providerDispatcher(_cwd, invocationId) {
          dispatched.push(invocationId);
        },
      },
    );
    assert.equal(
      replayedPrepared.investigation!.providerInvocationId,
      secondInvocationId,
    );
    assert.equal(
      replayedPrepared.investigation!.revision,
      retried.investigation!.revision,
    );
    assert.deepEqual(driven, [secondInvocationId]);
    assert.deepEqual(dispatched, [secondInvocationId]);

    const secondClaim = claimProviderInvocation(paths, secondInvocationId, {
      workerId: 'worker-second-retryable-failure',
      leaseDurationMs: 1_000,
    });
    failProviderInvocation(paths, secondInvocationId, {
      expectedRevision: secondClaim.record.revision,
      leaseGeneration: secondClaim.record.leaseGeneration,
      leaseToken: secondClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Replacement provider also exited non-zero.',
      },
    });
    const replayedFailed = resumePropose(repository, changeId, retryEnvelope);
    assert.equal(
      replayedFailed.investigation!.providerInvocationId,
      secondInvocationId,
    );
    assert.equal(replayedFailed.investigation!.provider.attempt, 2);
    assert.equal(readProviderRetryReservation(paths, investigationId, 3), null);
    assert.equal(
      fs
        .readdirSync(paths.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      2,
    );
    const retryPath = path.join(inputDirectory, 'provider-retry.json');
    fs.writeFileSync(retryPath, `${canonicalJson(retryEnvelope)}\n`, 'utf8');
    const cliReplay = runWorkflowCli(
      repository,
      ['propose', changeId, '--resume', '--input', retryPath],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(cliReplay.status, 0, cliReplay.stderr);
    const cliReplayOutput = JSON.parse(cliReplay.stdout) as {
      result: {
        investigation: {
          providerInvocationId: string;
          provider: { attempt: number };
        };
      };
    };
    assert.equal(
      cliReplayOutput.result.investigation.providerInvocationId,
      secondInvocationId,
    );
    assert.equal(cliReplayOutput.result.investigation.provider.attempt, 2);
    assert.equal(
      fs
        .readdirSync(paths.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      2,
    );
    const nextRetry = createProviderRetryEnvelope(repository, replayedFailed, {
      acknowledgeProviderCost: true,
    });
    assert.equal(nextRetry.failedInvocation.invocationId, secondInvocationId);
    assert.equal(nextRetry.expectedRevision, retried.investigation!.revision);
    const jobId = projectProviderInvocationExecution({
      record: readProviderInvocation(paths, secondInvocationId),
      request: secondRequest,
    }).job.jobId;
    const cliJobPreview = runWorkflowCli(
      repository,
      ['job', 'retry-preview', jobId],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(cliJobPreview.status, 0, cliJobPreview.stderr);
    const jobPreview = previewExecutionJobRetry(repository, jobId);
    assert.deepEqual(JSON.parse(cliJobPreview.stdout).result, jobPreview);
    assert.equal(jobPreview.status, 'ready');
    assert.equal(
      readProviderRetryReservation(paths, investigationId, 3),
      null,
      'preview must not reserve work',
    );
    const explainedRetry = {
      ...jobPreview.inputTemplate!,
      retryExplanation: {
        failureReason:
          'The provider appears to have run inside the sandbox; cause is not yet confirmed.',
        plannedAction:
          'Retry from the authorized host environment with the same timeout.',
      },
    };
    assert.throws(
      () =>
        requestExecutionJobRetry(repository, jobId, jobPreview.inputTemplate),
      (error) => isWorkflowError(error, 'PROVIDER_RETRY_EXPLANATION_INVALID'),
    );
    const jobRetried = requestExecutionJobRetry(
      repository,
      jobId,
      explainedRetry,
    );
    if (jobRetried.status !== 'retried')
      assert.fail('Expected an admitted job retry.');
    const thirdAttempt = jobRetried.result;
    if (thirdAttempt.investigation?.kind !== 'investigation')
      assert.fail('Expected a survey investigation.');
    const thirdInvocationId = thirdAttempt.investigation!.providerInvocationId;
    assert.equal(thirdAttempt.investigation!.provider.attempt, 3);
    const thirdRequest = readProviderInvocationRequest(
      paths,
      thirdInvocationId,
    );
    assert.deepEqual(thirdRequest.limits, secondRequest.limits);
    assert.deepEqual(
      thirdRequest.retryExplanation,
      explainedRetry.retryExplanation,
    );
    const thirdClaim = claimProviderInvocation(paths, thirdInvocationId, {
      workerId: 'worker-third-repeated-failure',
      leaseDurationMs: 1_000,
    });
    failProviderInvocation(paths, thirdInvocationId, {
      expectedRevision: thirdClaim.record.revision,
      leaseGeneration: thirdClaim.record.leaseGeneration,
      leaseToken: thirdClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Third provider attempt repeated the same failure.',
      },
    });
    fs.writeFileSync(retryPath, JSON.stringify(explainedRetry));
    const jobCliReplay = runWorkflowCli(
      repository,
      ['job', 'retry-request', jobId, '--input', retryPath],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(jobCliReplay.status, 0, jobCliReplay.stderr);
    assert.equal(
      JSON.parse(jobCliReplay.stdout).result.result.investigation
        .providerInvocationId,
      thirdInvocationId,
    );
    assert.equal(
      readProviderRetryReservation(paths, investigationId, 4),
      null,
      'replay must not allocate a fourth attempt',
    );
    assert.throws(
      () =>
        requestExecutionJobRetry(repository, jobId, {
          ...explainedRetry,
          retryExplanation: {
            ...explainedRetry.retryExplanation,
            plannedAction: 'A different request',
          },
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RETRY_INPUT_STALE'),
    );
    const repeatedFailure = getProposeStatus(repository, investigationId);
    const fourthRetry = createProviderRetryEnvelope(
      repository,
      repeatedFailure,
      { acknowledgeProviderCost: true },
    );
    const fourth = resumePropose(repository, changeId, fourthRetry);
    assert.equal(fourth.investigation!.provider.attempt, 4);
    assert.deepEqual(
      readProviderInvocationRequest(
        paths,
        fourth.investigation!.providerInvocationId,
      ).limits,
      thirdRequest.limits,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});
