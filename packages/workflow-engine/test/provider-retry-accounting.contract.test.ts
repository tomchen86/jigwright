/**
 * Verifies conservative provider retry accounting and rejects retired policy readers.
 *
 * Invariants:
 * - Every Attempt consumes one durable charge and retries preserve bounded budgets.
 * - The policy and retry implementation scan keeps the original V1 rejection assertions.
 *
 * Depends on: invocation storage modules, adapter policy, execution projection, and fixture repositories.
 * Failure modes: retries undercharge work, exceed budgets, or accept retired policy state.
 */
import { readProviderRetryAccountingEvidence } from '../src/runtime/storage-journal/provider-retry-accounting-reader.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { ProviderRetryAccountingEvidence } from '../src/modules/provider-orchestration/provider-retry-accounting.ts';

import {
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING,
  loadAiAdapterPolicy,
} from '../src/runtime/provider-policy/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { projectProviderInvocationExecution } from '../src/modules/provider-orchestration/execution-core.ts';
import { readExecutionJobState } from '../src/runtime/storage-journal/execution-store.ts';
import { preflightProviderRepairRetry } from '../src/runtime/storage-journal/provider-execution-governance.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { listProviderInvocationLifecycleProjections } from '../src/runtime/storage-journal/provider-invocation-lifecycle.ts';
import {
  createProviderInvocationRequest,
  recreateProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  claimProviderInvocation,
  createProviderInvocation,
  createProviderRetryReservation,
  failProviderInvocation,
  ensureProviderExecutionPolicySnapshotFromSnapshot,
  providerExecutionPolicySnapshotPath,
  providerInvocationManifestDigest,
  readProviderExecutionPolicySnapshot,
  readProviderRetryReservation,
  storeProviderExecutionPolicySnapshot,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import type { BlindSurveyManifest } from '../src/modules/investigation/manifest/blind-survey-manifest.ts';
import { authorizeAutomaticProviderRetry } from '../src/modules/provider-orchestration/provider-retry-decision.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const CREATED_AT = '2026-08-03T08:00:00.000Z';

test('retry explanations are bound to the persisted request without changing execution limits', () => {
  const repository = createFixtureRepository();
  try {
    const manifest = createManifest(repository);
    const original = createRequest(
      repository,
      manifest,
      'invocation-explanation',
    );
    const { schemaVersion, requestDigest, roleAssignmentDigest, ...input } =
      original;
    const retryExplanation = {
      failureReason:
        'Root cause is uncertain; the sandbox preflight was unavailable.',
      plannedAction:
        'Retry in the authorized host environment using the same timeout.',
    };
    const explained = createProviderInvocationRequest({
      ...input,
      retryExplanation,
    });
    assert.deepEqual(explained.limits, original.limits);
    assert.deepEqual(
      recreateProviderInvocationRequest(JSON.parse(JSON.stringify(explained))),
      explained,
    );
    assert.notEqual(explained.requestDigest, original.requestDigest);
    assert.throws(() =>
      recreateProviderInvocationRequest({
        ...explained,
        retryExplanation: {
          ...retryExplanation,
          plannedAction: 'A different plan',
        },
      }),
    );
    assert.throws(() =>
      createProviderInvocationRequest({
        ...input,
        retryExplanation: { ...retryExplanation, failureReason: ' ' },
      }),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider policy and retry readers contain no V1 cleanup parsers', () => {
  const storeRoot = new URL('../src/runtime/storage-journal/', import.meta.url);
  const invocationStore = fs
    .readdirSync(storeRoot)
    .filter((name) => /^provider-invocation-.*\.ts$/u.test(name))
    .sort()
    .map((name) => fs.readFileSync(new URL(name, storeRoot), 'utf8'))
    .join('\n');
  const adapterPolicy = fs.readFileSync(
    new URL(
      '../src/runtime/provider-policy/ai-adapter-policy.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(
    invocationStore,
    /Provider(?:ExecutionPolicySnapshot|RetryReservation)V1|ForHistoricalCleanup|parseLegacyAiAdapterPolicyDocument|snapshotRecorded|before execution policy snapshots existed/u,
  );
  assert.doesNotMatch(
    adapterPolicy,
    /LegacyAiAdapterPolicy|parseLegacyAiAdapterPolicyDocument/u,
  );
});

test('v4 policy snapshots conservative retry accounting and rebuilds one charge per Attempt', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const policy = loadAiAdapterPolicy(repository);
    assert.equal(policy.policy.schemaVersion, 4);
    assert.deepEqual(
      policy.policy.retryAccounting,
      DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING,
    );
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-accounting-1',
    );
    storeProviderExecutionPolicySnapshot(runtime, request, policy);
    const record = createProviderInvocation(runtime, {
      investigationId: 'investigation-accounting',
      changeId: 'demo-change',
      attempt: 1,
      manifest,
      request,
      createdAt: CREATED_AT,
    });

    const storedSnapshot = readProviderExecutionPolicySnapshot(
      runtime,
      request,
    );
    assert.equal(storedSnapshot.snapshot.schemaVersion, 2);
    assert.deepEqual(storedSnapshot.accounting?.attemptReservation, {
      runtimeMs: 3_600_000,
      providerCostMicros: 10_000_000,
      providerTokens: 500_000,
    });

    const projection = projectProviderInvocationExecution({ record, request });
    const state = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(state);
    assert.equal(state.job.retryPolicy.maxAttempts, 4);
    assert.equal(state.job.retryPolicy.maxCumulativeRuntimeMs, 14_400_000);
    assert.equal(state.job.retryPolicy.maxProviderCostMicros, 40_000_000);
    assert.equal(state.job.retryPolicy.maxProviderTokens, 2_000_000);
    assert.equal(state.job.retryPolicy.deadline, '2026-08-17T08:00:00.000Z');
    assert.deepEqual(state.job.retryPolicy.providerLimits, {
      claude: 4,
      codex: 4,
    });
    assert.equal(state.job.cumulativeRuntimeMs, 3_600_000);
    assert.equal(state.job.providerCostMicros, 10_000_000);
    assert.equal(state.job.providerTokens, 500_000);
    assert.equal(state.attempts[0]!.runtimeMs, 3_600_000);

    const claim = claimProviderInvocation(runtime, request.invocationId, {
      expectedRevision: record.revision,
      workerId: 'accounting-worker',
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-08-03T08:00:01.000Z',
    });
    const failed = failProviderInvocation(runtime, request.invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_TIMEOUT',
        message: 'Provider exceeded its bounded runtime.',
      },
      now: '2026-08-03T09:00:01.000Z',
    });
    const replacementRequest = createReplacementRequest(
      request,
      'invocation-accounting-2',
    );
    let throwingParserCalls = 0;
    assert.throws(
      () =>
        authorizeAutomaticProviderRetry(
          readProviderRetryAccountingEvidence(runtime, failed, request),
          {
            failed,
            failedRequest: request,
            replacementRequest,
            replacementExecutionPolicy: policy,
            dataAuthorizationPolicyPort: {
              parseCurrentDocument() {
                throwingParserCalls += 1;
                throw new Error('fixture parser refusal');
              },
            },
            now: '2026-08-03T09:00:02.000Z',
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RETRY_ACCOUNTING_STALE'),
    );
    assert.equal(throwingParserCalls, 1);

    let mismatchedParserCalls = 0;
    assert.throws(
      () =>
        authorizeAutomaticProviderRetry(
          readProviderRetryAccountingEvidence(runtime, failed, request),
          {
            failed,
            failedRequest: request,
            replacementRequest,
            replacementExecutionPolicy: policy,
            dataAuthorizationPolicyPort: {
              parseCurrentDocument() {
                mismatchedParserCalls += 1;
                return { ...policy, digest: '0'.repeat(64) };
              },
            },
            now: '2026-08-03T09:00:02.000Z',
          },
        ),
      (error) => isWorkflowError(error, 'PROVIDER_RETRY_ACCOUNTING_STALE'),
    );
    assert.equal(mismatchedParserCalls, 1);

    const authorization = authorizeAutomaticProviderRetry(
      readProviderRetryAccountingEvidence(runtime, failed, request),
      {
        failed,
        failedRequest: request,
        replacementRequest,
        replacementExecutionPolicy: policy,
        dataAuthorizationPolicyPort: AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
        now: '2026-08-03T09:00:02.000Z',
      },
    );
    const collected = readProviderRetryAccountingEvidence(
      runtime,
      failed,
      request,
    );
    const pureInput = {
      failed,
      failedRequest: request,
      replacementRequest,
      replacementExecutionPolicy: policy,
      dataAuthorizationPolicyPort: AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
      now: '2026-08-03T09:00:02.000Z',
    };
    const originalOpen = fs.openSync;
    fs.openSync = () => {
      throw new Error('Pure retry decision attempted filesystem I/O.');
    };
    try {
      assert.deepEqual(
        authorizeAutomaticProviderRetry(collected, pureInput),
        authorization,
      );
      assert.deepEqual(
        authorizeAutomaticProviderRetry(collected, pureInput),
        authorization,
      );
      assert.equal(
        authorizeAutomaticProviderRetry(collected, {
          ...pureInput,
          now: CREATED_AT,
        }).evaluatedAt,
        failed.updatedAt,
      );
      assert.throws(
        () =>
          authorizeAutomaticProviderRetry(collected, {
            ...pureInput,
            now: undefined!,
          }),
        (error) => isWorkflowError(error, 'PROVIDER_RETRY_ACCOUNTING_STALE'),
      );
      const cases: Array<
        [
          string,
          (
            value: ProviderRetryAccountingEvidence,
          ) => ProviderRetryAccountingEvidence,
          string,
        ]
      > = [
        [
          'absent Job',
          (value) => ({ ...value, state: null }),
          'PROVIDER_RETRY_ACCOUNTING_REQUIRED',
        ],
        [
          'incomplete history',
          (value) => {
            value.state!.invocationProjection.completeHistory = false;
            return value;
          },
          'PROVIDER_RETRY_ACCOUNTING_REQUIRED',
        ],
        [
          'missing accounting',
          (value) => ({ ...value, invocations: [] }),
          'PROVIDER_RETRY_ACCOUNTING_REQUIRED',
        ],
        [
          'missing snapshot accounting',
          (value) => ({
            ...value,
            invocations: [{ ...value.invocations[0]!, accounting: null }],
          }),
          'PROVIDER_RETRY_ACCOUNTING_REQUIRED',
        ],
        [
          'stale invocation revision',
          (value) => {
            value.state!.invocationProjection.invocations[0]!.invocationRevision += 1;
            return value;
          },
          'PROVIDER_RETRY_ACCOUNTING_STALE',
        ],
        [
          'foreign invocation request',
          (value) => {
            value.invocations[0]!.request.invocationId = 'invocation-other';
            return value;
          },
          'PROVIDER_RETRY_ACCOUNTING_STALE',
        ],
        [
          'inconsistent attempt charge',
          (value) => {
            value.state!.attempts[0]!.providerTokens += 1;
            return value;
          },
          'PROVIDER_RETRY_ACCOUNTING_STALE',
        ],
        [
          'inconsistent Job total',
          (value) => {
            value.state!.job.providerTokens += 1;
            return value;
          },
          'PROVIDER_RETRY_ACCOUNTING_STALE',
        ],
      ];
      for (const [label, mutate, code] of cases) {
        assert.throws(
          () =>
            authorizeAutomaticProviderRetry(
              mutate(structuredClone(collected)),
              pureInput,
            ),
          (error) => isWorkflowError(error, code),
          label,
        );
      }
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(authorization.decision.automatic, true);
    assert.equal(authorization.sameFingerprintCount, 1);
    assert.equal(authorization.providerAttemptCount, 1);
    assert.deepEqual(authorization.nextReservation, {
      runtimeMs: 3_600_000,
      providerCostMicros: 10_000_000,
      providerTokens: 500_000,
    });
    const retryReservation = createProviderRetryReservation(runtime, {
      investigationId: failed.investigationId,
      changeId: failed.changeId,
      attempt: 2,
      previousInvocationId: failed.invocationId,
      manifest,
      request: replacementRequest,
      executionPolicy: policy,
      retryDecision: {
        schemaVersion: 1,
        kind: 'provider-retry-decision-binding',
        executionJobId: authorization.job.jobId,
        executionRevision: authorization.executionRevision,
        failedAttemptId: authorization.attempt.attemptId,
        evidenceDigest: authorization.evidenceDigest,
        evaluatedAt: authorization.evaluatedAt,
      },
    });
    assert.equal(retryReservation.schemaVersion, 2);
    assert.equal(
      retryReservation.schemaVersion === 2
        ? retryReservation.retryDecision.evidenceDigest
        : null,
      authorization.evidenceDigest,
    );
    assert.deepEqual(
      readProviderRetryReservation(runtime, failed.investigationId, 2),
      retryReservation,
    );
    assert.equal(retryReservation.schemaVersion, 2);
    const replacementPolicyPath = providerExecutionPolicySnapshotPath(
      runtime,
      replacementRequest.invocationId,
    );
    fs.unlinkSync(replacementPolicyPath);
    fs.rmdirSync(path.dirname(replacementPolicyPath));
    assert.equal(listProviderInvocationLifecycleProjections(runtime).length, 1);
    ensureProviderExecutionPolicySnapshotFromSnapshot(
      runtime,
      replacementRequest,
      retryReservation.executionPolicySnapshot,
    );
    assert.deepEqual(
      readProviderExecutionPolicySnapshot(runtime, replacementRequest).snapshot,
      retryReservation.executionPolicySnapshot,
    );

    const rebuilt = readExecutionJobState(runtime, projection.job.jobId);
    assert.ok(rebuilt);
    assert.equal(rebuilt.job.cumulativeRuntimeMs, 3_600_000);
    assert.equal(rebuilt.job.providerCostMicros, 10_000_000);
    assert.equal(rebuilt.job.providerTokens, 500_000);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current execution-policy admission rejects a V1 snapshot', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const policy = loadAiAdapterPolicy(repository);
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-accounting-v1',
    );
    storeProviderExecutionPolicySnapshot(runtime, request, policy);
    fs.writeFileSync(
      providerExecutionPolicySnapshotPath(runtime, request.invocationId),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'provider-execution-policy-snapshot',
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        policyDigest: request.policyDigest,
        policyDocument: policy.document,
      })}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => readProviderExecutionPolicySnapshot(runtime, request),
      (error) =>
        isWorkflowError(error, 'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE'),
    );
    assert.throws(
      () =>
        createProviderInvocation(runtime, {
          investigationId: 'investigation-accounting-v1',
          changeId: 'demo-change',
          attempt: 1,
          manifest,
          request,
          createdAt: CREATED_AT,
        }),
      (error) =>
        isWorkflowError(error, 'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current retry admission rejects a V1 reservation', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const manifest = createManifest(repository);
    const request = createRequest(
      repository,
      manifest,
      'invocation-reservation-v1',
    );
    const investigationId = 'investigation-reservation-v1';
    fs.mkdirSync(runtime.refs, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(runtime.refs, `${investigationId}.provider-retry-2.json`),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'provider-retry-reservation',
        investigationId,
        changeId: 'demo-change',
        attempt: 2,
        previousInvocationId: 'invocation-reservation-v1-previous',
        invocationId: request.invocationId,
        manifestDigest: providerInvocationManifestDigest(manifest),
        requestDigest: request.requestDigest,
        request,
        createdAt: CREATED_AT,
      })}\n`,
      { mode: 0o600 },
    );

    assert.throws(
      () => readProviderRetryReservation(runtime, investigationId, 2),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('semantic repair budget is preflighted without publishing a third reservation or invocation', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = loadInvestigationRuntimeContext(repository).runtime;
    const policy = loadAiAdapterPolicy(repository);
    const manifest = createManifest(repository);
    const firstRequest = createRequest(
      repository,
      manifest,
      'invocation-accounting-repair-1',
    );
    storeProviderExecutionPolicySnapshot(runtime, firstRequest, policy);
    const first = createProviderInvocation(runtime, {
      investigationId: 'investigation-accounting-repair',
      changeId: 'demo-change',
      attempt: 1,
      manifest,
      request: firstRequest,
      createdAt: CREATED_AT,
    });
    const firstClaim = claimProviderInvocation(runtime, first.invocationId, {
      workerId: 'repair-worker-1',
      leaseDurationMs: firstRequest.limits.timeoutMs,
      now: '2026-08-03T08:00:01.000Z',
    });
    const firstFailed = failProviderInvocation(runtime, first.invocationId, {
      expectedRevision: firstClaim.record.revision,
      leaseGeneration: firstClaim.record.leaseGeneration,
      leaseToken: firstClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_NATIVE_OUTPUT_INVALID',
        message: 'Provider output requires semantic repair.',
      },
      repair: semanticRepair(firstRequest.invocationId),
      now: '2026-08-03T09:00:01.000Z',
    });

    const secondRequest = createReplacementRequest(
      firstRequest,
      'invocation-accounting-repair-2',
    );
    storeProviderExecutionPolicySnapshot(runtime, secondRequest, policy);
    const second = createProviderInvocation(runtime, {
      investigationId: first.investigationId,
      changeId: first.changeId,
      attempt: 2,
      manifest,
      request: secondRequest,
      createdAt: '2026-08-03T09:00:02.000Z',
    });
    const secondClaim = claimProviderInvocation(runtime, second.invocationId, {
      workerId: 'repair-worker-2',
      leaseDurationMs: secondRequest.limits.timeoutMs,
      now: '2026-08-03T09:00:03.000Z',
    });
    const secondFailed = failProviderInvocation(runtime, second.invocationId, {
      expectedRevision: secondClaim.record.revision,
      leaseGeneration: secondClaim.record.leaseGeneration,
      leaseToken: secondClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_NATIVE_OUTPUT_INVALID',
        message: 'Provider output still requires semantic repair.',
      },
      repair: semanticRepair(secondRequest.invocationId),
      now: '2026-08-03T10:00:03.000Z',
    });
    const before = snapshotTree(runtime.root);
    assert.throws(
      () =>
        preflightProviderRepairRetry(runtime, {
          history: [
            { record: firstFailed, request: firstRequest },
            { record: secondFailed, request: secondRequest },
          ],
          failedRecord: secondFailed,
          failedRequest: secondRequest,
        }),
      (error) => isWorkflowError(error, 'REPAIR_BUDGET_EXHAUSTED'),
    );
    assert.equal(snapshotTree(runtime.root), before);
    assert.equal(
      fs.existsSync(
        path.join(runtime.invocations, 'invocation-accounting-repair-3'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createManifest(repository: string): BlindSurveyManifest {
  return {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: 'demo-change',
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Exercise retry accounting.',
      sourceRefs: [],
      explicitPaths: [
        'packages/workflow-engine/src/runtime/storage-journal/execution-store.ts',
      ],
      explicitSymbols: ['authorizeAutomaticProviderRetry'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion: 'How are provider retry budgets rebuilt durably?',
    capabilityProfile: 'repository-read-only',
  };
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  invocationId: string,
): ProviderInvocationRequest {
  const targetDigest = blindSurveyIntentDigest(manifest);
  const policy = loadAiAdapterPolicy(repository);
  return createProviderInvocationRequest({
    invocationId,
    nonce: `${invocationId}-nonce-000000`,
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'plan-reviewer',
      providerId: 'claude',
      sessionId: 'provider-session-accounting',
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
    policyDigest: policy.digest,
    limits: {
      timeoutMs: 3_600_000,
      aggregateOutputBytes: 1_048_576,
    },
  });
}

function createReplacementRequest(
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

function semanticRepair(reference: string) {
  return {
    repairKind: 'semantic' as const,
    previousOutput: { reference, terms: [] },
    validationErrors: [
      {
        path: '/terms',
        code: 'SEMANTIC_COVERAGE',
        message: 'Expected a semantically complete term set.',
      },
    ],
    targetSchema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  };
}

function snapshotTree(root: string): string {
  const entries: Array<{ path: string; content: string }> = [];
  const visit = (directory: string) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        entries.push({
          path: path.relative(root, absolute),
          content: fs.readFileSync(absolute).toString('base64'),
        });
      }
    }
  };
  visit(root);
  return canonicalJson(entries);
}
