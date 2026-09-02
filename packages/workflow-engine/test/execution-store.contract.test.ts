import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { projectProviderInvocationExecution } from '../src/modules/provider-orchestration/execution-core.ts';
import { inspectExecutionJob } from '../src/runtime/provider-execution/execution-runtime.ts';
import {
  acceptProviderAttemptResult,
  executionJobStatePath,
  executionStorePaths,
  listExecutionJobStates,
  materializeProviderExecutionJob,
  providerExecutionAdmissionAuthorityPath,
  readExecutionJobState,
  recoverProviderAttemptResultFromCandidate,
  withExecutionJobStateSnapshot,
} from '../src/runtime/storage-journal/execution-store.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { readProviderInvocationLifecycleProjection } from '../src/runtime/storage-journal/investigation-session-store.ts';
import {
  createProviderInvocationRequest,
  evaluateProviderProcess,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '../src/runtime/provider-execution/built-in-provider-definition.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/modules/provider-orchestration/provider-runtime-evidence.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  assertProviderInvocationAcceptanceBindingCurrent,
  blindSurveyOutputValidator,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  completeProviderInvocation,
  completeProviderInvocationFromRunner,
  createProviderInvocation,
  failProviderInvocation,
  providerInvocationManifestDigest,
  prepareProviderInvocationAcceptanceBinding,
  readProviderInvocation,
  readProviderExecutionPolicySnapshot,
  readProviderInvocationRequest,
  recoverProviderInvocationCompletion,
  storeProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
  type ProviderLeaseClaim,
  type ProviderInvocationAcceptanceBinding,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const CHANGE_ID = 'demo-change';

test('provider creation materializes a private canonical execution aggregate with revision CAS', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-durable-store-1',
      1,
      'investigation-durable-store',
    );
    const record = createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-durable-store',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T08:00:00.000Z',
    });
    const projection = projectProviderInvocationExecution({ record, request });
    const stored = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(stored);
    assert.equal(stored.revision, 0);
    assert.deepEqual(stored.workflow, projection.workflow);
    assert.equal(stored.job.jobId, projection.job.jobId);
    assert.equal(stored.attempts[0]!.attemptId, projection.attempt.attemptId);
    assert.deepEqual(stored.results, []);
    assert.equal(stored.invocationProjection.completeHistory, true);
    assert.deepEqual(stored.invocationProjection.invocations, [
      {
        invocationId: request.invocationId,
        invocationRevision: 0,
        attemptId: projection.attempt.attemptId,
      },
    ]);

    const stores = executionStorePaths(runtime);
    const statePath = executionJobStatePath(runtime, projection.job.jobId);
    assert.equal(fs.statSync(stores.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(stores.jobs).mode & 0o777, 0o700);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    const beforeAccountingOmission = fs.readFileSync(statePath, 'utf8');
    assert.throws(
      () =>
        materializeProviderExecutionJob(runtime, [
          { record, request } as never,
        ]),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_PROJECTION_CONFLICT'),
    );
    assert.equal(fs.readFileSync(statePath, 'utf8'), beforeAccountingOmission);
    assert.throws(
      () =>
        materializeProviderExecutionJob(
          runtime,
          [executionEntryForTest(runtime, record, request)],
          { expectedRevision: 1 },
        ),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_CAS_MISMATCH'),
    );

    const canonicalBytes = fs.readFileSync(statePath, 'utf8');
    fs.writeFileSync(statePath, canonicalBytes.trimEnd(), 'utf8');
    assert.throws(
      () => readExecutionJobState(runtime, projection.job.jobId),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_UNSAFE'),
    );
    fs.writeFileSync(statePath, canonicalBytes, 'utf8');
    const withUnknownField = {
      ...(JSON.parse(canonicalBytes) as Record<string, unknown>),
      unknown: true,
    };
    fs.writeFileSync(statePath, `${canonicalJson(withUnknownField)}\n`, 'utf8');
    assert.throws(
      () => readExecutionJobState(runtime, projection.job.jobId),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_UNSAFE'),
    );

    const currentState = JSON.parse(canonicalBytes) as Record<string, unknown>;
    const retiredProjectionState = structuredClone(currentState);
    const currentProjection = retiredProjectionState.invocationProjection as {
      completeHistory: boolean;
      invocations: Array<{
        invocationId: string;
        invocationRevision: number;
        attemptId: string;
      }>;
    };
    retiredProjectionState.legacyProjection = {
      kind: 'provider-invocation-v1',
      completeHistory: currentProjection.completeHistory,
      invocations: currentProjection.invocations.map(
        ({ invocationId, invocationRevision, attemptId }) => ({
          invocationId,
          legacyRevision: invocationRevision,
          attemptId,
        }),
      ),
    };
    delete retiredProjectionState.invocationProjection;
    fs.writeFileSync(
      statePath,
      `${canonicalJson(retiredProjectionState)}\n`,
      'utf8',
    );
    assert.throws(
      () => readExecutionJobState(runtime, projection.job.jobId),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_UNSAFE'),
    );

    const retiredAttemptState = structuredClone(currentState);
    const retiredAttempt = (
      retiredAttemptState.attempts as Array<Record<string, unknown>>
    )[0]!;
    const currentInvocation = retiredAttempt.providerInvocation as Record<
      string,
      unknown
    >;
    retiredAttempt.legacyInvocation = {
      invocationId: currentInvocation.invocationId,
      legacyAttempt: currentInvocation.invocationAttempt,
      legacyRevision: currentInvocation.invocationRevision,
    };
    delete retiredAttempt.providerInvocation;
    fs.writeFileSync(
      statePath,
      `${canonicalJson(retiredAttemptState)}\n`,
      'utf8',
    );
    assert.throws(
      () => readExecutionJobState(runtime, projection.job.jobId),
      (error) => isWorkflowError(error, 'EXECUTION_STORE_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('store-owned execution snapshots keep synchronous callbacks inside the exact Job lock', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-execution-snapshot-1',
      1,
      'investigation-execution-snapshot',
    );
    const record = createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-execution-snapshot',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T08:30:00.000Z',
    });
    const jobId = projectProviderInvocationExecution({ record, request }).job
      .jobId;
    let callbackCount = 0;
    const observedRevision = withExecutionJobStateSnapshot(
      runtime,
      jobId,
      (snapshot) => {
        callbackCount += 1;
        assert.ok(snapshot);
        assert.equal(snapshot.job.jobId, jobId);
        assert.throws(
          () =>
            materializeProviderExecutionJob(
              runtime,
              [executionEntryForTest(runtime, record, request)],
              { expectedRevision: snapshot.revision },
            ),
          (error) =>
            isWorkflowError(error, 'EXECUTION_STORE_OPERATION_CONFLICT'),
        );
        return snapshot.revision;
      },
    );
    assert.equal(callbackCount, 1);
    assert.equal(observedRevision, 0);

    let promiseCallbackCount = 0;
    assert.throws(
      () =>
        withExecutionJobStateSnapshot(runtime, jobId, (snapshot) => {
          promiseCallbackCount += 1;
          return Promise.resolve(snapshot?.revision ?? -1);
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_STORE_SNAPSHOT_CALLBACK_INVALID'),
    );
    assert.equal(promiseCallbackCount, 1);

    const callbackFailure = new Error('execution snapshot callback failure');
    let failureCallbackCount = 0;
    assert.throws(
      () =>
        withExecutionJobStateSnapshot(runtime, jobId, () => {
          failureCallbackCount += 1;
          throw callbackFailure;
        }),
      (error) => error === callbackFailure,
    );
    assert.equal(failureCallbackCount, 1);
    assert.equal(
      withExecutionJobStateSnapshot(
        runtime,
        jobId,
        (snapshot) => snapshot?.revision,
      ),
      0,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('schema-v4 runtime receipts re-admit the immutable pre-launch execution authority', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-execution-admission-1',
      1,
      'investigation-execution-admission',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-execution-admission',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T08:40:00.000Z',
    });
    const claim = claimProviderInvocation(runtime, request.invocationId, {
      workerId: 'worker-execution-admission',
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-08-03T08:41:00.000Z',
    });
    const acceptance = prepareProviderInvocationAcceptanceBinding(
      runtime,
      request.invocationId,
      'schema-v4',
    );
    const authorityPath = providerExecutionAdmissionAuthorityPath(
      runtime,
      acceptance,
    );
    const authorityBytes = fs.readFileSync(authorityPath, 'utf8');
    assert.equal(
      authorityBytes,
      `${canonicalJson(JSON.parse(authorityBytes))}\n`,
    );

    const semanticOutput = evaluateProviderProcess(
      request,
      providerOutcome(request),
      blindSurveyOutputValidator(request),
    ).output;
    const runnerRuntime = path.join(
      runtime.invocations,
      request.invocationId,
      'runtime',
    );
    fs.mkdirSync(runnerRuntime, { mode: 0o700 });
    for (const [name, value] of [
      ['prompt.json', { requestDigest: request.requestDigest }],
      ['schema.json', BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA],
      ['semantic-output.json', semanticOutput],
    ] as const) {
      fs.writeFileSync(
        path.join(runnerRuntime, name),
        `${canonicalJson(value)}\n`,
        {
          mode: 0o600,
        },
      );
    }
    completeProviderInvocationFromRunner(runtime, request.invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      report: {
        invocationId: request.invocationId,
        providerId: request.providerId,
        purpose: request.purpose,
        requestDigest: request.requestDigest,
        semanticOutput,
        semanticOutputDigest: sha256ForTest(canonicalJson(semanticOutput)),
        assurance: 'unchanged-governed-projection',
        projection: {
          unchanged: true,
          changedCategories: [],
          beforeDigest: 'a'.repeat(64),
          afterDigest: 'a'.repeat(64),
        },
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: {
          candidatePath: '/opt/homebrew/bin/claude',
          realPath: '/opt/homebrew/bin/claude',
          device: '1',
          inode: '2',
          mode: 0o100755,
          uid: 501,
          gid: 20,
          size: 1024,
          mtimeNs: '123456789',
          sha256: 'b'.repeat(64),
        },
        elapsedMs: 1,
        providerDefinitionSnapshot: resolveBuiltInProviderDefinitionSnapshot(
          request.providerId,
          'darwin',
        )!,
      },
      acceptanceBinding: acceptance,
      runtimeProgress: {
        schemaVersion: 1,
        kind: 'agent-runtime-process-progress',
        processState: 'exited',
        eventCount: 1,
        stdoutBytes: 1,
        stderrBytes: 0,
        lastProcessActivityElapsedMs: 1,
        lastProviderActivityElapsedMs: 1,
      },
      now: '2026-08-03T08:41:01.000Z',
    });
    const terminal = readProviderInvocation(runtime, request.invocationId);
    const currentExecution = readExecutionJobState(
      runtime,
      acceptance.executionJobId,
    );
    assert.ok(currentExecution);
    assert.notEqual(
      sha256ForTest(canonicalJson(currentExecution)),
      acceptance.executionStateDigest,
      'terminal result acceptance mutates the current Job after admission',
    );
    assert.ok(terminal.runtimeReceipt);
    assert.equal(terminal.runtimeReceipt.terminalDisposition, 'accepted');
    assert.equal(terminal.runtimeReceipt.failureCode, null);
    const { receiptDigest: _receiptDigest, ...receiptPayload } =
      terminal.runtimeReceipt;
    const terminalState = terminal;
    const statePath = path.join(
      runtime.invocations,
      request.invocationId,
      'state.json',
    );
    assert.equal(
      readProviderInvocationLifecycleProjection(runtime, request.invocationId)
        .state,
      'succeeded',
    );

    const assertUnsafeWithoutRewrite = (expectedBytes: string) => {
      assert.throws(
        () =>
          readProviderInvocationLifecycleProjection(
            runtime,
            request.invocationId,
          ),
        (error) =>
          isWorkflowError(error, 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE'),
      );
      assert.equal(fs.readFileSync(statePath, 'utf8'), expectedBytes);
    };

    const missingPath = `${authorityPath}.missing`;
    fs.renameSync(authorityPath, missingPath);
    const terminalStateBytes = fs.readFileSync(statePath, 'utf8');
    assertUnsafeWithoutRewrite(terminalStateBytes);
    fs.renameSync(missingPath, authorityPath);

    const tamperedAuthority = JSON.parse(authorityBytes) as Record<
      string,
      unknown
    >;
    tamperedAuthority.authorityDigest = '0'.repeat(64);
    const tamperedAuthorityBytes = `${canonicalJson(tamperedAuthority)}\n`;
    fs.writeFileSync(authorityPath, tamperedAuthorityBytes, { mode: 0o600 });
    assertUnsafeWithoutRewrite(terminalStateBytes);
    assert.equal(
      fs.readFileSync(authorityPath, 'utf8'),
      tamperedAuthorityBytes,
    );
    fs.writeFileSync(authorityPath, authorityBytes, { mode: 0o600 });

    const candidatePath = path.join(
      runtime.root,
      'execution',
      'completion-candidates',
      `${sha256ForTest(request.invocationId)}.json`,
    );
    const candidateBytes = fs.readFileSync(candidatePath, 'utf8');
    const flippedBinding = structuredClone(acceptance) as unknown as Record<
      string,
      unknown
    >;
    flippedBinding.receiptRequirement = 'synchronous-no-activity';
    delete flippedBinding.bindingDigest;
    flippedBinding.bindingDigest = sha256ForTest(canonicalJson(flippedBinding));
    const flippedAuthority = JSON.parse(authorityBytes) as Record<
      string,
      unknown
    >;
    flippedAuthority.receiptRequirement = 'synchronous-no-activity';
    flippedAuthority.acceptanceBindingDigest = flippedBinding.bindingDigest;
    flippedAuthority.acceptanceBinding = flippedBinding;
    delete flippedAuthority.authorityDigest;
    flippedAuthority.authorityDigest = sha256ForTest(
      `workflow.provider-execution-admission-authority.v1\n${canonicalJson(
        flippedAuthority,
      )}`,
    );
    const flippedState = structuredClone(terminalState) as unknown as Record<
      string,
      unknown
    >;
    delete flippedState.runtimeReceipt;
    const flippedCandidate = JSON.parse(candidateBytes) as Record<
      string,
      unknown
    >;
    delete flippedCandidate.runtimeReceipt;
    delete flippedCandidate.candidateDigest;
    flippedCandidate.candidateDigest = sha256ForTest(
      canonicalJson(flippedCandidate),
    );
    const flippedStateBytes = `${canonicalJson(flippedState)}\n`;
    const flippedAuthorityBytes = `${canonicalJson(flippedAuthority)}\n`;
    const flippedCandidateBytes = `${canonicalJson(flippedCandidate)}\n`;
    fs.writeFileSync(statePath, flippedStateBytes, { mode: 0o600 });
    fs.writeFileSync(authorityPath, flippedAuthorityBytes, { mode: 0o600 });
    fs.writeFileSync(candidatePath, flippedCandidateBytes, { mode: 0o600 });
    assertUnsafeWithoutRewrite(flippedStateBytes);
    assert.throws(
      () => readProviderInvocation(runtime, request.invocationId),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_STORE_UNSAFE'),
    );
    assert.equal(fs.readFileSync(authorityPath, 'utf8'), flippedAuthorityBytes);
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), flippedCandidateBytes);
    fs.writeFileSync(statePath, terminalStateBytes, { mode: 0o600 });
    fs.writeFileSync(authorityPath, authorityBytes, { mode: 0o600 });
    fs.writeFileSync(candidatePath, candidateBytes, { mode: 0o600 });

    const { bindingDigest: _bindingDigest, ...acceptancePayload } = acceptance;
    const forgedAcceptancePayload = {
      ...acceptancePayload,
      executionStateDigest: '1'.repeat(64),
    };
    const forgedAcceptance = {
      ...forgedAcceptancePayload,
      bindingDigest: sha256ForTest(canonicalJson(forgedAcceptancePayload)),
    };
    const forgedReceiptPayload = {
      ...receiptPayload,
      executionStateDigest: forgedAcceptance.executionStateDigest,
      acceptanceBindingDigest: forgedAcceptance.bindingDigest,
      acceptanceBinding: forgedAcceptance,
    };
    const forgedReceipt = {
      ...forgedReceiptPayload,
      receiptDigest: sha256ForTest(canonicalJson(forgedReceiptPayload)),
    };
    const forgedStateBytes = `${canonicalJson({
      ...terminal,
      runtimeReceipt: forgedReceipt,
    })}\n`;
    fs.writeFileSync(statePath, forgedStateBytes, { mode: 0o600 });
    assertUnsafeWithoutRewrite(forgedStateBytes);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('durable result CAS keeps the first completion and records the loser as late-duplicate', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const requests = [1, 2].map((attempt) =>
      createRequest(
        repository,
        manifest,
        `invocation-durable-race-${attempt}`,
        attempt,
        'investigation-durable-race',
      ),
    );
    for (const [index, request] of requests.entries()) {
      createDirectProviderInvocation(repository, runtime, {
        investigationId: 'investigation-durable-race',
        changeId: CHANGE_ID,
        attempt: index + 1,
        manifest,
        request,
        createdAt: `2026-08-03T09:0${index}:00.000Z`,
      });
    }
    const claims = requests.map((request, index) =>
      claimProviderInvocation(runtime, request.invocationId, {
        workerId: `worker-race-${index + 1}`,
        leaseDurationMs: request.limits.timeoutMs,
        now: `2026-08-03T09:1${index + 8}:00.000Z`,
      }),
    );
    const acceptances = requests.map((request) =>
      prepareProviderInvocationAcceptanceBinding(
        runtime,
        request.invocationId,
        'synchronous-no-activity',
      ),
    );

    completeClaim(
      runtime,
      requests[1]!,
      claims[1]!,
      '2026-08-03T09:20:00.000Z',
      acceptances[1],
    );
    completeClaim(
      runtime,
      requests[0]!,
      claims[0]!,
      '2026-08-03T09:21:00.000Z',
      acceptances[0],
    );

    const projection = projectProviderInvocationExecution({
      record: readProviderInvocation(runtime, requests[0]!.invocationId),
      request: requests[0]!,
    });
    const stored = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(stored);
    const firstAttempt = stored.attempts.find(
      ({ providerInvocation }) =>
        providerInvocation?.invocationId === requests[0]!.invocationId,
    );
    const secondAttempt = stored.attempts.find(
      ({ providerInvocation }) =>
        providerInvocation?.invocationId === requests[1]!.invocationId,
    );
    assert.ok(firstAttempt);
    assert.ok(secondAttempt);
    assert.equal(stored.job.acceptedAttemptId, secondAttempt.attemptId);
    assert.equal(stored.job.status, 'succeeded');
    assert.equal(secondAttempt.status, 'succeeded');
    assert.equal(firstAttempt.status, 'late-duplicate');
    assert.equal(firstAttempt.retention, 'debug');
    const loser = readProviderInvocation(runtime, requests[0]!.invocationId);
    assert.equal(loser.runtimeReceipt, undefined);
    assert.equal(
      fs.existsSync(
        providerExecutionAdmissionAuthorityPath(runtime, acceptances[0]!),
      ),
      true,
    );
    assert.deepEqual(
      stored.results.map(({ attemptId, acceptance }) => ({
        attemptId,
        acceptance,
      })),
      [
        { attemptId: firstAttempt.attemptId, acceptance: 'late-duplicate' },
        { attemptId: secondAttempt.attemptId, acceptance: 'accepted' },
      ],
    );
    const inspection = inspectExecutionJob(repository, stored.job.jobId);
    assert.equal(inspection.acceptedAttemptId, secondAttempt.attemptId);
    assert.equal(inspection.attempts[0]!.status, 'late-duplicate');
    assert.equal(inspection.attempts[1]!.status, 'succeeded');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('async schema-v4 completion refuses a late duplicate before publishing accepted receipt state', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const requests = [1, 2].map((attempt) =>
      createRequest(
        repository,
        manifest,
        `invocation-async-durable-race-${attempt}`,
        attempt,
        'investigation-async-durable-race',
      ),
    );
    for (const [index, request] of requests.entries()) {
      createDirectProviderInvocation(repository, runtime, {
        investigationId: 'investigation-async-durable-race',
        changeId: CHANGE_ID,
        attempt: index + 1,
        manifest,
        request,
        createdAt: `2026-08-03T09:3${index}:00.000Z`,
      });
    }
    const claims = requests.map((request, index) =>
      claimProviderInvocation(runtime, request.invocationId, {
        workerId: `worker-async-race-${index + 1}`,
        leaseDurationMs: request.limits.timeoutMs,
        now: `2026-08-03T09:4${index}:00.000Z`,
      }),
    );
    const acceptances = requests.map((request) =>
      prepareProviderInvocationAcceptanceBinding(
        runtime,
        request.invocationId,
        'schema-v4',
      ),
    );
    const completeAsync = (index: number, now: string) => {
      const request = requests[index]!;
      const claim = claims[index]!;
      const acceptance = acceptances[index]!;
      const semanticOutput = evaluateProviderProcess(
        request,
        providerOutcome(request),
        blindSurveyOutputValidator(request),
      ).output;
      const runnerRuntime = path.join(
        runtime.invocations,
        request.invocationId,
        'runtime',
      );
      fs.mkdirSync(runnerRuntime, { mode: 0o700 });
      for (const [name, value] of [
        ['prompt.json', { requestDigest: request.requestDigest }],
        ['schema.json', BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA],
        ['semantic-output.json', semanticOutput],
      ] as const) {
        fs.writeFileSync(
          path.join(runnerRuntime, name),
          `${canonicalJson(value)}\n`,
          { mode: 0o600 },
        );
      }
      return completeProviderInvocationFromRunner(
        runtime,
        request.invocationId,
        {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          report: {
            invocationId: request.invocationId,
            providerId: request.providerId,
            purpose: request.purpose,
            requestDigest: request.requestDigest,
            semanticOutput,
            semanticOutputDigest: sha256ForTest(canonicalJson(semanticOutput)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: 'a'.repeat(64),
              afterDigest: 'a'.repeat(64),
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: {
              candidatePath: '/opt/homebrew/bin/claude',
              realPath: '/opt/homebrew/bin/claude',
              device: '1',
              inode: '2',
              mode: 0o100755,
              uid: 501,
              gid: 20,
              size: 1024,
              mtimeNs: '123456789',
              sha256: 'b'.repeat(64),
            },
            elapsedMs: 1,
            providerDefinitionSnapshot:
              resolveBuiltInProviderDefinitionSnapshot(
                request.providerId,
                'darwin',
              )!,
          },
          acceptanceBinding: acceptance,
          runtimeProgress: {
            schemaVersion: 1,
            kind: 'agent-runtime-process-progress',
            processState: 'exited',
            eventCount: 1,
            stdoutBytes: 1,
            stderrBytes: 0,
            lastProcessActivityElapsedMs: 1,
            lastProviderActivityElapsedMs: 1,
          },
          now,
        },
      );
    };

    const winner = completeAsync(1, '2026-08-03T09:42:00.000Z');
    assert.equal(winner.runtimeReceipt?.terminalDisposition, 'accepted');
    const loserStatePath = path.join(
      runtime.invocations,
      requests[0]!.invocationId,
      'state.json',
    );
    const loserStateBytes = fs.readFileSync(loserStatePath, 'utf8');
    assert.throws(
      () => completeAsync(0, '2026-08-03T09:43:00.000Z'),
      (error) => isWorkflowError(error, 'PROVIDER_ASYNC_RESULT_LATE_DUPLICATE'),
    );
    assert.equal(fs.readFileSync(loserStatePath, 'utf8'), loserStateBytes);
    const loser = readProviderInvocation(runtime, requests[0]!.invocationId);
    assert.equal(loser.state, 'leased');
    assert.equal(loser.runtimeReceipt, undefined);
    assert.equal(
      fs.existsSync(
        path.join(
          runtime.root,
          'execution',
          'completion-candidates',
          `${sha256ForTest(requests[0]!.invocationId)}.json`,
        ),
      ),
      false,
    );
    const projection = projectProviderInvocationExecution({
      record: loser,
      request: requests[0]!,
    });
    const stored = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(stored);
    const loserAttempt = stored.attempts.find(
      ({ providerInvocation }) =>
        providerInvocation?.invocationId === requests[0]!.invocationId,
    );
    assert.equal(loserAttempt?.status, 'late-duplicate');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('candidate-only recovery accepts and idempotently replays the exact leased Attempt result', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-candidate-result-recovery',
      1,
      'investigation-candidate-result-recovery',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-candidate-result-recovery',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T10:00:00.000Z',
    });
    const claim = claimProviderInvocation(runtime, request.invocationId, {
      workerId: 'worker-candidate-result-recovery',
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-08-03T10:01:00.000Z',
    });
    const entries = [
      executionEntryForTest(runtime, claim.record, request),
    ] as const;
    const projection = projectProviderInvocationExecution({
      record: claim.record,
      request,
    });
    const before = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(before);
    const recoveryInput = {
      entries,
      attemptId: projection.attempt.attemptId,
      leaseGeneration: claim.record.leaseGeneration,
      leaseTokenDigest: sha256ForTest(claim.leaseToken),
      outputDigest: sha256ForTest('candidate-only-result'),
      completedAt: '2026-08-03T10:02:00.000Z',
    } as const;

    const recovered = recoverProviderAttemptResultFromCandidate(runtime, {
      ...recoveryInput,
      expectedRevision: before.revision,
    });
    assert.equal(recovered.accepted, true);
    assert.equal(recovered.result.acceptance, 'accepted');
    assert.equal(
      recovered.state.job.acceptedAttemptId,
      projection.attempt.attemptId,
    );
    assert.equal(recovered.state.attempts[0]!.status, 'succeeded');
    assert.equal(
      recovered.result.outputDigest,
      `sha256:${recoveryInput.outputDigest}`,
    );

    const replay = recoverProviderAttemptResultFromCandidate(
      runtime,
      recoveryInput,
    );
    assert.equal(replay.state.revision, recovered.state.revision);
    assert.deepEqual(replay, recovered);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('candidate-only recovery preserves another exact winner and records a late duplicate', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const investigationId = 'investigation-candidate-result-race';
    const requests = [1, 2].map((attempt) =>
      createRequest(
        repository,
        manifest,
        `invocation-candidate-result-race-${attempt}`,
        attempt,
        investigationId,
      ),
    );
    for (const [index, request] of requests.entries()) {
      createDirectProviderInvocation(repository, runtime, {
        investigationId,
        changeId: CHANGE_ID,
        attempt: index + 1,
        manifest,
        request,
        createdAt: `2026-08-03T11:0${index}:00.000Z`,
      });
    }
    const claims = requests.map((request, index) =>
      claimProviderInvocation(runtime, request.invocationId, {
        workerId: `worker-candidate-result-race-${index + 1}`,
        leaseDurationMs: request.limits.timeoutMs,
        now: `2026-08-03T11:1${index}:00.000Z`,
      }),
    );
    const entries = claims.map((claim, index) =>
      executionEntryForTest(runtime, claim.record, requests[index]!),
    );
    const projections = claims.map((claim, index) =>
      projectProviderInvocationExecution({
        record: claim.record,
        request: requests[index]!,
      }),
    );

    const winner = recoverProviderAttemptResultFromCandidate(runtime, {
      entries,
      attemptId: projections[1]!.attempt.attemptId,
      leaseGeneration: claims[1]!.record.leaseGeneration,
      leaseTokenDigest: sha256ForTest(claims[1]!.leaseToken),
      outputDigest: sha256ForTest('candidate-race-winner'),
      completedAt: '2026-08-03T11:12:00.000Z',
    });
    const duplicate = recoverProviderAttemptResultFromCandidate(runtime, {
      entries,
      attemptId: projections[0]!.attempt.attemptId,
      leaseGeneration: claims[0]!.record.leaseGeneration,
      leaseTokenDigest: sha256ForTest(claims[0]!.leaseToken),
      outputDigest: sha256ForTest('candidate-race-loser'),
      completedAt: '2026-08-03T11:13:00.000Z',
    });

    assert.equal(winner.accepted, true);
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.result.acceptance, 'late-duplicate');
    assert.equal(
      duplicate.state.job.acceptedAttemptId,
      projections[1]!.attempt.attemptId,
    );
    assert.equal(duplicate.state.job.status, 'succeeded');
    assert.equal(duplicate.state.attempts[0]!.status, 'late-duplicate');
    assert.equal(duplicate.state.attempts[1]!.status, 'succeeded');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('candidate-only recovery refuses lease and projected Attempt binding mismatches without mutation', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-candidate-result-mismatch',
      1,
      'investigation-candidate-result-mismatch',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-candidate-result-mismatch',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T12:00:00.000Z',
    });
    const claim = claimProviderInvocation(runtime, request.invocationId, {
      workerId: 'worker-candidate-result-mismatch',
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-08-03T12:01:00.000Z',
    });
    const entry = executionEntryForTest(runtime, claim.record, request);
    const projection = projectProviderInvocationExecution({
      record: claim.record,
      request,
    });
    const statePath = executionJobStatePath(runtime, projection.job.jobId);
    const beforeBytes = fs.readFileSync(statePath, 'utf8');
    const exactInput = {
      entries: [entry],
      attemptId: projection.attempt.attemptId,
      leaseGeneration: claim.record.leaseGeneration,
      leaseTokenDigest: sha256ForTest(claim.leaseToken),
      outputDigest: sha256ForTest('candidate-mismatch-result'),
      completedAt: '2026-08-03T12:02:00.000Z',
    } as const;

    for (const mismatch of [
      {
        ...exactInput,
        leaseGeneration: exactInput.leaseGeneration + 1,
      },
      {
        ...exactInput,
        leaseTokenDigest: sha256ForTest('different-lease-token'),
      },
    ]) {
      assert.throws(
        () => recoverProviderAttemptResultFromCandidate(runtime, mismatch),
        (error) =>
          isWorkflowError(error, 'EXECUTION_STORE_RESULT_RECOVERY_CONFLICT'),
      );
      assert.equal(fs.readFileSync(statePath, 'utf8'), beforeBytes);
    }

    const changedRequestDigest = sha256ForTest('changed-request-binding');
    const driftedEntry = {
      ...entry,
      record: { ...entry.record, requestDigest: changedRequestDigest },
      request: { ...entry.request, requestDigest: changedRequestDigest },
    };
    assert.throws(
      () =>
        recoverProviderAttemptResultFromCandidate(runtime, {
          ...exactInput,
          entries: [driftedEntry],
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_STORE_RESULT_RECOVERY_CONFLICT'),
    );
    assert.equal(fs.readFileSync(statePath, 'utf8'), beforeBytes);

    const changedContextDigest = sha256ForTest('changed-context-binding');
    const driftedContextEntry = {
      ...entry,
      record: { ...entry.record, manifestDigest: changedContextDigest },
      request: {
        ...entry.request,
        inputManifestDigest: changedContextDigest,
      },
    };
    assert.throws(
      () =>
        recoverProviderAttemptResultFromCandidate(runtime, {
          ...exactInput,
          entries: [driftedContextEntry],
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_STORE_RESULT_RECOVERY_CONFLICT'),
    );
    assert.equal(fs.readFileSync(statePath, 'utf8'), beforeBytes);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('recovery repairs a provider lease after durable acceptance crash exactly once and rejects divergent state', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-acceptance-crash-window',
      1,
      'investigation-acceptance-crash-window',
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId: 'investigation-acceptance-crash-window',
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-08-03T10:45:00.000Z',
    });
    const claim = claimProviderInvocation(runtime, request.invocationId, {
      workerId: 'worker-acceptance-crash-window',
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-08-03T10:46:00.000Z',
    });
    assert.throws(
      () =>
        completeProviderInvocation(runtime, request.invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          outcome: providerOutcome(request),
          now: '2026-08-03T10:47:00.000Z',
          simulateCrashAfterExecutionAcceptance: true,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_COMPLETION_SIMULATED_CRASH'),
    );
    const leased = readProviderInvocation(runtime, request.invocationId);
    assert.equal(leased.state, 'leased');
    const projection = projectProviderInvocationExecution({
      record: leased,
      request,
    });
    const accepted = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(accepted);
    assert.equal(accepted.job.acceptedAttemptId, projection.attempt.attemptId);
    assert.equal(accepted.results[0]!.acceptance, 'accepted');

    const statePath = path.join(
      runtime.invocations,
      request.invocationId,
      'state.json',
    );
    const leasedBytes = fs.readFileSync(statePath, 'utf8');
    const divergent = {
      ...leased,
      revision: leased.revision + 1,
      state: 'failed' as const,
      lease: null,
      result: null,
      failure: {
        kind: 'retryable' as const,
        code: 'PROVIDER_PROCESS_CRASH',
        message: 'A conflicting terminal state won the invocation CAS.',
      },
      updatedAt: '2026-08-03T10:47:01.000Z',
    };
    const divergentBytes = `${canonicalJson(divergent)}\n`;
    fs.writeFileSync(statePath, divergentBytes, 'utf8');
    assert.throws(
      () =>
        recoverProviderInvocationCompletion(runtime, request.invocationId, {
          expectedRevision: leased.revision,
        }),
      (error) =>
        isWorkflowError(error, 'PROVIDER_COMPLETION_RECOVERY_CONFLICT'),
    );
    assert.equal(fs.readFileSync(statePath, 'utf8'), divergentBytes);
    fs.writeFileSync(statePath, leasedBytes, 'utf8');

    const worker = runProviderWorker(repository, request.invocationId);
    assert.equal(worker.state, 'succeeded');
    assert.equal(worker.launched, false);
    const succeeded = readProviderInvocation(runtime, request.invocationId);
    assert.equal(succeeded.state, 'succeeded');
    assert.equal(succeeded.revision, leased.revision + 1);
    assert.equal(
      succeeded.result?.outputDigest,
      accepted.results[0]!.outputDigest.replace(/^sha256:/u, ''),
    );
    const replay = recoverProviderInvocationCompletion(
      runtime,
      request.invocationId,
      { expectedRevision: leased.revision },
    );
    assert.equal(replay.repaired, false);
    assert.notEqual(replay.candidateDigest, null);
    assert.deepEqual(replay.record, succeeded);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('validator failure reloads as a bounded repair Attempt and missing durable lineage fails closed', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const investigationId = 'investigation-durable-repair';
    const firstRequest = createRequest(
      repository,
      manifest,
      'invocation-durable-repair-1',
      1,
      investigationId,
    );
    createDirectProviderInvocation(repository, runtime, {
      investigationId,
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request: firstRequest,
      createdAt: '2026-08-03T13:00:00.000Z',
    });
    const firstClaim = claimProviderInvocation(
      runtime,
      firstRequest.invocationId,
      {
        workerId: 'worker-durable-repair-1',
        leaseDurationMs: firstRequest.limits.timeoutMs,
        now: '2026-08-03T13:01:00.000Z',
      },
    );
    failProviderInvocation(runtime, firstRequest.invocationId, {
      expectedRevision: firstClaim.record.revision,
      leaseGeneration: firstClaim.record.leaseGeneration,
      leaseToken: firstClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_NATIVE_OUTPUT_INVALID',
        message: 'Provider output failed full validation.',
      },
      repair: {
        repairKind: 'schema',
        previousOutput: {
          reference: firstRequest.invocationId,
          terms: [],
        },
        validationErrors: [
          {
            path: '/terms',
            code: 'MIN_ITEMS',
            message: 'Expected at least one item.',
          },
        ],
        targetSchema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
      },
      now: '2026-08-03T13:02:00.000Z',
    });

    const secondRequest = createRepairRequest(
      firstRequest,
      'invocation-durable-repair-2',
    );
    const second = createDirectProviderInvocation(repository, runtime, {
      investigationId,
      changeId: CHANGE_ID,
      attempt: 2,
      manifest,
      request: secondRequest,
      createdAt: '2026-08-03T13:03:00.000Z',
    });
    const jobId = projectProviderInvocationExecution({
      record: second,
      request: secondRequest,
    }).job.jobId;
    const reloaded = readExecutionJobState(runtime, jobId);
    assert.ok(reloaded);
    assert.equal(reloaded.job.repairAttemptCount, 1);
    assert.equal(reloaded.attempts[1]!.retryMode, 'repair');
    assert.equal(
      reloaded.attempts[1]!.retryOf,
      reloaded.attempts[0]!.attemptId,
    );
    assert.equal(
      reloaded.attempts[1]!.repairContext?.validationErrors[0]?.path,
      '/terms',
    );
    assert.equal(
      reloaded.attempts[1]!.repairContext?.instruction,
      'return-complete-replacement-object',
    );

    const lineagePath = path.join(
      runtime.invocations,
      secondRequest.invocationId,
      'repair-lineage.json',
    );
    const durableLineage = fs.readFileSync(lineagePath, 'utf8');
    fs.unlinkSync(lineagePath);
    assert.throws(
      () =>
        claimProviderInvocation(runtime, secondRequest.invocationId, {
          workerId: 'worker-missing-repair-lineage',
          leaseDurationMs: secondRequest.limits.timeoutMs,
          now: '2026-08-03T13:04:00.000Z',
        }),
      (error) => isWorkflowError(error, 'PROVIDER_REPAIR_LINEAGE_REQUIRED'),
    );
    assert.equal(
      readProviderInvocation(runtime, secondRequest.invocationId).state,
      'prepared',
    );
    assert.throws(
      () =>
        materializeProviderExecutionJob(runtime, [
          executionEntryForTest(
            runtime,
            readProviderInvocation(runtime, firstRequest.invocationId),
            firstRequest,
          ),
          executionEntryForTest(runtime, second, secondRequest),
        ]),
      (error) => isWorkflowError(error, 'PROVIDER_REPAIR_LINEAGE_REQUIRED'),
    );
    assert.equal(
      readExecutionJobState(runtime, jobId)?.attempts[1]?.retryMode,
      'repair',
    );
    fs.writeFileSync(lineagePath, durableLineage, { mode: 0o600 });
    assert.equal(
      materializeProviderExecutionJob(runtime, [
        executionEntryForTest(
          runtime,
          readProviderInvocation(runtime, firstRequest.invocationId),
          firstRequest,
        ),
        executionEntryForTest(runtime, second, secondRequest),
      ]).attempts[1]?.retryMode,
      'repair',
    );

    claimProviderInvocation(runtime, secondRequest.invocationId, {
      workerId: 'worker-repair-authority-binding',
      leaseDurationMs: secondRequest.limits.timeoutMs,
      now: '2026-08-03T13:05:00.000Z',
    });
    const acceptance = prepareProviderInvocationAcceptanceBinding(
      runtime,
      secondRequest.invocationId,
      'schema-v4',
    );
    assert.equal(
      fs.existsSync(
        providerExecutionAdmissionAuthorityPath(runtime, acceptance),
      ),
      true,
      'acceptance preparation publishes its immutable execution authority',
    );
    assert.doesNotThrow(() =>
      assertProviderInvocationAcceptanceBindingCurrent(runtime, acceptance),
    );
    const parsedLineage = JSON.parse(durableLineage) as Record<string, unknown>;
    const changedLineagePayload: Record<string, unknown> = {
      ...parsedLineage,
      createdAt: '2026-08-03T13:03:30.000Z',
    };
    delete changedLineagePayload.lineageDigest;
    const changedLineage = {
      ...changedLineagePayload,
      lineageDigest: `sha256:${crypto
        .createHash('sha256')
        .update(canonicalJson(changedLineagePayload))
        .digest('hex')}`,
    };
    fs.writeFileSync(lineagePath, `${canonicalJson(changedLineage)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () =>
        assertProviderInvocationAcceptanceBindingCurrent(runtime, acceptance),
      (error) => isWorkflowError(error, 'PROVIDER_REPAIR_AUTHORITY_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createManifest(repository: string): BlindSurveyManifest {
  return {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: CHANGE_ID,
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Exercise the durable execution store.',
      sourceRefs: [],
      explicitPaths: [
        'packages/workflow-engine/src/runtime/storage-journal/execution-store.ts',
      ],
      explicitSymbols: ['readExecutionJobState'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion:
      'How does the execution engine persist one accepted Attempt result?',
    capabilityProfile: 'repository-read-only',
  };
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  invocationId: string,
  attempt: number,
  investigationId: string,
): ProviderInvocationRequest {
  const targetDigest = blindSurveyIntentDigest(manifest);
  return createProviderInvocationRequest({
    invocationId,
    nonce: `${invocationId}-nonce-000000`,
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'plan-reviewer',
      providerId: 'claude',
      sessionId: `provider-session-${investigationId}`,
      targetDigest,
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: manifest.repositoryId,
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: '1'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey.v1',
    policyDigest: loadAiAdapterPolicy(repository).digest,
    limits: {
      timeoutMs: 300_000 + (attempt - 1) * 300_000,
      aggregateOutputBytes: 1_048_576,
    },
  });
}

function createDirectProviderInvocation(
  repository: string,
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  input: Parameters<typeof createProviderInvocation>[1],
) {
  storeProviderExecutionPolicySnapshot(
    runtime,
    input.request,
    loadAiAdapterPolicy(repository),
  );
  return createProviderInvocation(runtime, input);
}

function executionEntryForTest(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  record: ReturnType<typeof readProviderInvocation>,
  request: ProviderInvocationRequest,
) {
  return {
    record,
    request,
    retryAccounting: readProviderExecutionPolicySnapshot(runtime, request)
      .accounting,
  };
}

function createRepairRequest(
  previous: ProviderInvocationRequest,
  invocationId: string,
): ProviderInvocationRequest {
  return createProviderInvocationRequest({
    invocationId,
    nonce: `${invocationId}-nonce-000000`,
    purpose: previous.purpose,
    providerId: previous.providerId,
    roleAssignment: previous.roleAssignment,
    capabilityProfile: previous.capabilityProfile,
    repositoryId: previous.repositoryId,
    baseCommit: previous.baseCommit,
    baseTree: previous.baseTree,
    targetDigest: previous.targetDigest,
    inputManifestDigest: previous.inputManifestDigest,
    authorizationNodeId: previous.authorizationNodeId,
    writeAllowedPaths: [],
    outputSchema: previous.outputSchema,
    evaluatorVersion: previous.evaluatorVersion,
    policyDigest: previous.policyDigest,
    limits: previous.limits,
  });
}

function completeClaim(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
  claim: ProviderLeaseClaim,
  now: string,
  acceptanceBinding?: ProviderInvocationAcceptanceBinding,
): void {
  completeProviderInvocation(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(request),
    ...(acceptanceBinding === undefined ? {} : { acceptanceBinding }),
    now,
  });
}

function providerOutcome(
  request: ProviderInvocationRequest,
): ProviderProcessOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify({
      schemaVersion: 1,
      requestDigest: request.requestDigest,
      invocationId: request.invocationId,
      nonce: request.nonce,
      purpose: request.purpose,
      providerId: request.providerId,
      roleAssignmentDigest: request.roleAssignmentDigest,
      capabilityProfile: request.capabilityProfile,
      repositoryId: request.repositoryId,
      baseCommit: request.baseCommit,
      baseTree: request.baseTree,
      targetDigest: request.targetDigest,
      inputManifestDigest: request.inputManifestDigest,
      authorizationNodeId: request.authorizationNodeId,
      outputSchema: request.outputSchema,
      evaluatorVersion: request.evaluatorVersion,
      policyDigest: request.policyDigest,
      limits: request.limits,
      observedTouchedPaths: [],
      output: {
        reference: request.invocationId,
        terms: [{ kind: 'symbol', value: 'DurableExecutionStore' }],
      },
    }),
    stderr: '',
  };
}

function sha256ForTest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
