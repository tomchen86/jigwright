import { planningAssuranceDependencies } from '../src/composition-root/planning-assurance-production.ts';
import { readCurrentPlanningRoleOverridePolicy } from '../src/runtime/repository-transaction/planning-role-provider-policy-reader.ts';
import test from 'node:test';
import {
  inspectProviderRetentionMetrics as inspectWithRuntime,
  pruneProviderRuntime as pruneWithRuntime,
} from '../src/runtime/provider-execution/provider-retention.ts';
import {
  readProviderRetentionReceipt,
  providerRetentionReceiptPath,
  PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
  PROVIDER_RETENTION_MAX_LIMIT,
} from '../src/runtime/provider-execution/provider-retention.ts';
import { classifyProviderRetentionEligibility } from '../src/modules/provider-orchestration/provider-retention.ts';
import {
  inspectProviderRetentionMetrics,
  pruneProviderRuntime,
} from '../src/composition-root/retention-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  inspectExecutionJob,
  listExecutionJobs,
} from '../src/runtime/provider-execution/execution-runtime.ts';
import {
  isWorkflowError,
  sourceRepositoryRoot,
  createFixtureRepository,
  writeReadyV3ExemptChange,
  git,
} from './fixture.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  providerRetentionStagingDirectory,
  type ProviderRetentionArtifactName,
  createProviderRetentionReceipt,
  providerRetentionReceiptId,
} from '../src/runtime/storage-journal/provider-retention-receipt.ts';
import os from 'node:os';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import {
  type ProviderInvocationRequest,
  PROPOSE_POLICY_DIGEST,
  createProviderInvocationRequest,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { storeProviderExecutionPolicySnapshot } from '../src/runtime/storage-journal/provider-invocation-policy.ts';
import {
  createProviderInvocation,
  prepareProviderInvocationAcceptanceBinding,
  readProviderInvocation,
} from '../src/runtime/storage-journal/provider-invocation-state.ts';
import { claimProviderInvocation } from '../src/runtime/storage-journal/provider-invocation-workers.ts';
import {
  failProviderInvocation,
  completeProviderInvocationFromRunner,
} from '../src/runtime/storage-journal/provider-invocation-completion.ts';
import {
  providerInvocationManifestDigest,
  blindSurveyIntentDigest,
} from '../src/runtime/storage-journal/provider-invocation-manifest-validation.ts';
import { BLIND_SURVEY_OUTPUT_SCHEMA } from '../src/modules/provider-orchestration/blind-survey-output.ts';
import type { PlanReviewManifest } from '../src/modules/assurance/provider-review-manifests.ts';
import type { BlindSurveyManifest } from '../src/modules/investigation/manifest/blind-survey-manifest.ts';
import { loadAiAdapterPolicy } from '../src/runtime/provider-policy/ai-adapter-policy.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  createPlanReviewTargetSnapshotNode,
  readPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_OUTPUT_SCHEMA,
} from '../src/modules/assurance/plan-review.ts';
import type { PlanReviewSubject } from '../src/modules/assurance/plan-review-subject.ts';
import { writeEvidenceNode } from '../src/runtime/storage-journal/evidence-object-store.ts';
import { createEvidenceNode } from '../src/foundation/evidence-node/evidence-node.ts';
import { type InvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import {
  PROVIDER_RUNNER_RESIDUALS,
  providerDefinitionExecutableBindingDigest,
} from '../src/modules/provider-orchestration/provider-runtime-evidence.ts';
import { inspectProviderExecutable } from '@jigwright/agent-runtime/provider-executable-identity';
import {
  createAgentRuntimeHostProbeEvidenceV1,
  createAgentRuntimeHostExecutionBindingV1,
} from '../src/modules/provider-orchestration/agent-runtime-host-execution-binding.ts';
import {
  type HostWrapperProviderProfileSnapshot,
  parseAgentProviderConfigToml,
} from '@jigwright/core/agent-provider-config';
import {
  type ProviderWrapperSessionProtocolBinding,
  renderProviderWrapperSessionFrame,
} from '@jigwright/core/harness-jsonl-v2-contracts';
import { createProviderWrapperSessionProtocolParser } from '@jigwright/agent-runtime';
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
  createCentralRoleProviderDefaultSnapshotV1,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  type AgentRolePlanBodyV2,
  agentRolePlanV2Digest,
  renderAgentRolePlanV2,
  createAgentRolePlanV2Snapshot,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  createChangeRoleAssignmentProtectedContextV1,
  resolveChangeRoleAssignmentV1,
} from '../src/modules/provider-orchestration/change-role-assignment.ts';
import { createChangeRoleAssignmentRecordV1 } from '../src/modules/provider-orchestration/change-role-assignment-record.ts';
import { createOrReadExactChangeRoleAssignmentRecordV1 } from '../src/runtime/storage-journal/change-role-assignment-store.ts';
import { projectAgentRuntimeAssignmentBindingV1 } from '../src/modules/provider-orchestration/agent-runtime-durable-authority.ts';
import {
  claimProviderNativeSessionTurnV1,
  completeProviderNativeSessionTurnV1,
  readProviderNativeSessionChainV1,
} from '../src/runtime/storage-journal/provider-native-session-store.ts';
import crypto from 'node:crypto';
import {
  readExecutionJobState,
  executionJobStatePath,
} from '../src/runtime/storage-journal/execution-store.ts';
import { spawnSync } from 'node:child_process';
import { createManifest, CHANGE_ID } from './blind-survey-manifest-fixture.ts';

const OLD_NOW = '2026-08-20T12:00:00.000Z';

test('storage metrics derive exact raw bytes, expired work, pins, and receipts', () => {
  const fixture = createSuccessfulHistory('retention-metrics', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  try {
    const before = inspectProviderRetentionMetrics(fixture.repository, {
      now: OLD_NOW,
    });
    assert.ok(before.rawEvidenceBytesByRetentionClass.active > 0);
    assert.ok(before.rawEvidenceBytesByRetentionClass.debug > 0);
    assert.equal(before.rawEvidenceBytesByRetentionClass.pinned, 0);
    assert.equal(before.expiredPendingDeletion.count, 1);
    assert.ok(before.expiredPendingDeletion.bytes > 0);
    assert.equal(before.pinnedCount, 0);
    assert.equal(before.receiptCount, 0);
    const retainedActiveBytes = before.rawEvidenceBytesByRetentionClass.active;

    pruneProviderRuntime(fixture.repository, { limit: 10, now: OLD_NOW });
    const after = inspectProviderRetentionMetrics(fixture.repository, {
      now: OLD_NOW,
    });
    assert.equal(
      after.rawEvidenceBytesByRetentionClass.active,
      retainedActiveBytes,
    );
    assert.equal(after.rawEvidenceBytesByRetentionClass.debug, 0);
    assert.equal(after.expiredPendingDeletion.count, 0);
    assert.equal(after.expiredPendingDeletion.bytes, 0);
    assert.equal(after.receiptCount, 1);
  } finally {
    fixture.dispose();
  }
});

test('TTL pruning removes only an old late duplicate and preserves accepted/current core', () => {
  const fixture = createSuccessfulHistory('retention-late', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  try {
    const accepted = fixture.invocations[0]!;
    const duplicate = fixture.invocations[1]!;
    const result = pruneProviderRuntime(fixture.repository, {
      limit: 10,
      now: OLD_NOW,
    });

    assert.deepEqual(
      result.pruned.map(({ invocationId }) => invocationId),
      [duplicate.invocationId],
    );
    assert.ok(
      result.denied.some(
        (entry) =>
          entry.invocationId === accepted.invocationId &&
          entry.reason === 'accepted-result-current',
      ),
    );
    assert.equal(fs.existsSync(runtimePath(fixture, accepted)), true);
    assert.deepEqual(fs.readdirSync(runtimePath(fixture, duplicate)), []);
    assert.equal(fs.existsSync(candidatePath(fixture, accepted)), true);
    assert.equal(fs.existsSync(candidatePath(fixture, duplicate)), false);
    for (const name of [
      'execution-policy.json',
      'manifest.json',
      'request.json',
      'state.json',
    ]) {
      assert.equal(
        fs.existsSync(
          path.join(fixture.runtime.invocations, duplicate.invocationId, name),
        ),
        true,
      );
    }

    const receipt = readProviderRetentionReceipt(
      fixture.runtime,
      duplicate.invocationId,
    );
    assert.equal(receipt?.state, 'complete');
    assert.ok(
      Buffer.byteLength(
        fs.readFileSync(
          providerRetentionReceiptPath(fixture.runtime, duplicate.invocationId),
        ),
      ) < PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
    );

    const inspected = inspectExecutionJob(fixture.repository, fixture.jobId);
    assert.equal(inspected.results[0]!.acceptance, 'accepted');
    assert.equal(inspected.results[1]!.acceptance, 'late-duplicate');
  } finally {
    fixture.dispose();
  }
});

test('expired native-terminal host-wrapper failure prunes probe and turn leaves and remains lifecycle-readable', () => {
  const fixture = createHostWrapperFailedDuplicateHistory(
    'retention-host-wrapper-native-terminal',
    'native-terminal',
  );
  const duplicate = fixture.invocations[1]!;
  try {
    assert.equal(listExecutionJobs(fixture.repository).length, 1);

    const result = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: OLD_NOW,
    });
    assert.deepEqual(
      result.pruned.map(({ invocationId }) => invocationId),
      [duplicate.invocationId],
    );
    const receipt = readProviderRetentionReceipt(
      fixture.runtime,
      duplicate.invocationId,
    );
    assert.deepEqual(
      receipt?.artifacts.map(({ name }) => name),
      [
        'host-wrapper-probe-runtime/probe-result.json',
        'host-wrapper-probe-runtime/request.json',
        'host-wrapper-runtime/request.json',
        'host-wrapper-runtime/semantic-output.json',
      ],
    );
    assert.deepEqual(
      fs.readdirSync(hostWrapperProbePath(fixture, duplicate)),
      [],
    );
    assert.deepEqual(
      fs.readdirSync(hostWrapperTurnPath(fixture, duplicate)),
      [],
    );
    assert.ok(
      fs.statSync(
        providerRetentionReceiptPath(fixture.runtime, duplicate.invocationId),
      ).size < PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
    );
    assert.equal(listExecutionJobs(fixture.repository).length, 1);
  } finally {
    fixture.dispose();
  }
});

test('assignment-admitted probe failure prunes its raw empty result and creates the empty turn marker', () => {
  const fixture = createHostWrapperFailedDuplicateHistory(
    'retention-host-wrapper-probe-failure',
    'assignment-admitted',
  );
  const duplicate = fixture.invocations[1]!;
  try {
    assert.equal(
      fs.readFileSync(
        path.join(
          hostWrapperProbePath(fixture, duplicate),
          'probe-result.json',
        ),
        'utf8',
      ),
      '',
    );
    assert.equal(listExecutionJobs(fixture.repository).length, 1);
    const result = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: OLD_NOW,
    });
    assert.deepEqual(
      result.pruned.map(({ invocationId }) => invocationId),
      [duplicate.invocationId],
    );
    const receipt = readProviderRetentionReceipt(
      fixture.runtime,
      duplicate.invocationId,
    );
    assert.deepEqual(
      receipt?.artifacts.map(({ name }) => name),
      [
        'host-wrapper-probe-runtime/probe-result.json',
        'host-wrapper-probe-runtime/request.json',
      ],
    );
    assert.equal(
      receipt?.artifacts.find(
        ({ name }) => name === 'host-wrapper-probe-runtime/probe-result.json',
      )?.bytes,
      0,
    );
    assert.deepEqual(
      fs.readdirSync(hostWrapperProbePath(fixture, duplicate)),
      [],
    );
    assert.deepEqual(
      fs.readdirSync(hostWrapperTurnPath(fixture, duplicate)),
      [],
    );
    assert.equal(listExecutionJobs(fixture.repository).length, 1);

    fs.unlinkSync(
      providerRetentionReceiptPath(fixture.runtime, duplicate.invocationId),
    );
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
    );
  } finally {
    fixture.dispose();
  }
});

test('host-wrapper receipt rejects impossible phase sets', () => {
  assert.doesNotThrow(() =>
    hostWrapperRetentionReceipt('failed', [
      'host-wrapper-probe-runtime/request.json',
    ]),
  );
  assert.doesNotThrow(() =>
    hostWrapperRetentionReceipt('succeeded', [
      'host-wrapper-probe-runtime/request.json',
      'host-wrapper-probe-runtime/probe-result.json',
      'host-wrapper-runtime/request.json',
      'host-wrapper-runtime/semantic-output.json',
    ]),
  );
  for (const [terminalState, names] of [
    ['failed', ['host-wrapper-runtime/request.json']],
    [
      'failed',
      [
        'host-wrapper-probe-runtime/request.json',
        'host-wrapper-runtime/request.json',
      ],
    ],
    [
      'succeeded',
      [
        'host-wrapper-probe-runtime/request.json',
        'host-wrapper-probe-runtime/probe-result.json',
        'host-wrapper-runtime/request.json',
      ],
    ],
  ] as const) {
    assert.throws(
      () => hostWrapperRetentionReceipt(terminalState, names),
      (error) => isWorkflowError(error, 'PROVIDER_RETENTION_RECEIPT_UNSAFE'),
    );
  }
});

test('default seven-day TTL and explicit pin deny physical pruning', () => {
  const recent = createSuccessfulHistory('retention-recent', 2, [
    '2026-08-15T10:00:00.000Z',
    '2026-08-15T10:10:00.000Z',
  ]);
  try {
    const result = pruneProviderRuntime(recent.repository, {
      limit: 10,
      now: OLD_NOW,
    });
    assert.equal(result.pruned.length, 0);
    assert.ok(
      result.denied.some(
        ({ invocationId, reason }) =>
          invocationId === recent.invocations[1]!.invocationId &&
          reason === 'ttl-not-expired',
      ),
    );
    assert.equal(
      fs.existsSync(runtimePath(recent, recent.invocations[1]!)),
      true,
    );
  } finally {
    recent.dispose();
  }

  const pinned = createSuccessfulHistory('retention-pinned', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  try {
    pinAttempt(pinned, pinned.invocations[1]!.invocationId);
    const result = pruneProviderRuntime(pinned.repository, {
      limit: 10,
      now: OLD_NOW,
    });
    assert.equal(result.pruned.length, 0);
    assert.ok(
      result.denied.some(
        ({ invocationId, reason }) =>
          invocationId === pinned.invocations[1]!.invocationId &&
          reason === 'pinned',
      ),
    );
    assert.equal(
      fs.existsSync(runtimePath(pinned, pinned.invocations[1]!)),
      true,
    );
  } finally {
    pinned.dispose();
  }
});

test('old-epoch accepted raw is TTL-eligible while its current-epoch counterpart is retained', () => {
  const common = {
    invocationState: 'succeeded' as const,
    historyComplete: true,
    retention: 'active' as const,
    acceptedAttempt: true,
    latestUnacceptedAttempt: false,
    terminalAt: '2026-07-01T00:00:00.000Z',
    cutoffAt: '2026-08-01T00:00:00.000Z',
  };
  assert.equal(
    classifyProviderRetentionEligibility({
      ...common,
      attemptEpoch: 1,
      currentEpoch: 2,
    }),
    null,
  );
  assert.equal(
    classifyProviderRetentionEligibility({
      ...common,
      attemptEpoch: 2,
      currentEpoch: 2,
    }),
    'accepted-result-current',
  );
});

test('production pruning uses durable provider-context rollover to remove old accepted raw', () => {
  const fixture = createSemanticRolloverHistory('retention-epoch-rollover');
  const oldAccepted = fixture.invocations[0]!;
  const currentAccepted = fixture.invocations[1]!;
  try {
    const result = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: OLD_NOW,
    });
    assert.deepEqual(
      result.pruned.map(({ invocationId }) => invocationId),
      [oldAccepted.invocationId],
    );
    assert.ok(
      result.denied.some(
        ({ invocationId, reason }) =>
          invocationId === currentAccepted.invocationId &&
          reason === 'accepted-result-current',
      ),
    );
    const receipt = readProviderRetentionReceipt(
      fixture.runtime,
      oldAccepted.invocationId,
    );
    assert.equal(receipt?.epoch, 1);
    assert.equal(receipt?.currentEpoch, 2);
    assert.deepEqual(fs.readdirSync(runtimePath(fixture, oldAccepted)), []);
    assert.equal(
      fs.readdirSync(runtimePath(fixture, currentAccepted)).length,
      3,
    );
    assert.equal(listExecutionJobs(fixture.repository).length, 2);
  } finally {
    fixture.dispose();
  }
});

test('old PlanReview snapshots are pruned exactly while current review-root stays physical', () => {
  const fixture = createPlanReviewRolloverHistory(
    'retention-plan-review-rollover',
  );
  const oldAccepted = fixture.invocations[0]!;
  const currentAccepted = fixture.invocations[1]!;
  try {
    const result = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: OLD_NOW,
    });
    assert.deepEqual(
      result.pruned.map(({ invocationId }) => invocationId),
      [oldAccepted.invocationId],
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.runtime.invocations,
          oldAccepted.invocationId,
          'review-root',
        ),
      ),
      [],
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.runtime.invocations,
          currentAccepted.invocationId,
          'review-root',
        ),
      ),
      ['0000.artifact'],
    );
    const receipt = readProviderRetentionReceipt(
      fixture.runtime,
      oldAccepted.invocationId,
    );
    assert.ok(receipt?.artifacts.some(({ name }) => name === 'review-root'));
    assert.ok(
      fs.statSync(
        providerRetentionReceiptPath(fixture.runtime, oldAccepted.invocationId),
      ).size < PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
    );
    assert.equal(listExecutionJobs(fixture.repository).length, 2);

    const receiptPath = providerRetentionReceiptPath(
      fixture.runtime,
      oldAccepted.invocationId,
    );
    const tampered = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
      artifacts: Array<{ name: string; digest: string }>;
    };
    tampered.artifacts.find(({ name }) => name === 'review-root')!.digest =
      'e'.repeat(64);
    fs.writeFileSync(receiptPath, `${canonicalJson(tampered)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
    );
  } finally {
    fixture.dispose();
  }
});

test('the latest failed invocation remains current and is never physically pruned', () => {
  const fixture = createFailedHistory('retention-current-failed');
  try {
    const result = pruneProviderRuntime(fixture.repository, {
      limit: 1,
      now: OLD_NOW,
    });
    assert.equal(result.pruned.length, 0);
    assert.deepEqual(result.denied, [
      {
        invocationId: fixture.invocations[0]!.invocationId,
        reason: 'current-attempt',
      },
    ]);
    assert.equal(
      fs.existsSync(runtimePath(fixture, fixture.invocations[0]!)),
      true,
    );
  } finally {
    fixture.dispose();
  }
});

test('unknown runtime files and unprojected repair evidence default-deny without deletion', () => {
  for (const variant of ['unknown-runtime', 'repair-evidence'] as const) {
    const fixture = createSuccessfulHistory(`retention-${variant}`, 2, [
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:10:00.000Z',
    ]);
    const duplicate = fixture.invocations[1]!;
    try {
      if (variant === 'unknown-runtime') {
        fs.writeFileSync(
          path.join(runtimePath(fixture, duplicate), 'unexpected.log'),
          'must survive',
          { mode: 0o600 },
        );
      } else {
        fs.writeFileSync(
          path.join(
            fixture.runtime.invocations,
            duplicate.invocationId,
            'repair-evidence.json',
          ),
          `${canonicalJson({ retained: true })}\n`,
          { mode: 0o600 },
        );
      }
      const result = pruneProviderRuntime(fixture.repository, {
        limit: 2,
        now: OLD_NOW,
      });
      assert.equal(result.pruned.length, 0);
      assert.ok(
        result.denied.some(
          ({ invocationId, reason }) =>
            invocationId === duplicate.invocationId &&
            reason ===
              (variant === 'unknown-runtime'
                ? 'unsafe-artifact'
                : 'consumed-repair-evidence-unproven'),
        ),
      );
      assert.equal(fs.existsSync(runtimePath(fixture, duplicate)), true);
      assert.equal(fs.existsSync(candidatePath(fixture, duplicate)), true);
      assert.equal(
        fs.existsSync(
          providerRetentionReceiptPath(fixture.runtime, duplicate.invocationId),
        ),
        false,
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('a crash after one staged file fails closed and the next pass completes recovery', () => {
  const fixture = createSuccessfulHistory('retention-crash', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  const duplicate = fixture.invocations[1]!;
  try {
    assert.throws(
      () =>
        pruneProviderRuntime(
          fixture.repository,
          { limit: 2, now: OLD_NOW },
          {
            afterArtifactStaged(count) {
              if (count === 1) throw new Error('simulated-prune-crash');
            },
          },
        ),
      /simulated-prune-crash/,
    );
    assert.equal(
      readProviderRetentionReceipt(fixture.runtime, duplicate.invocationId)
        ?.state,
      'prepared',
    );
    assert.throws(
      () => listExecutionJobs(fixture.repository),
      (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
    );

    const recovered = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: '2026-08-20T12:01:00.000Z',
    });
    assert.deepEqual(recovered.recovered, [duplicate.invocationId]);
    assert.equal(
      readProviderRetentionReceipt(fixture.runtime, duplicate.invocationId)
        ?.state,
      'complete',
    );
    assert.deepEqual(fs.readdirSync(runtimePath(fixture, duplicate)), []);
    assert.equal(listExecutionJobs(fixture.repository).length, 1);
  } finally {
    fixture.dispose();
  }
});

test('a PlanReview crash after staging one snapshot completes prepared receipt recovery', () => {
  const fixture = createPlanReviewRolloverHistory(
    'retention-plan-review-prepared-recovery',
  );
  const oldAccepted = fixture.invocations[0]!;
  try {
    assert.throws(
      () =>
        pruneProviderRuntime(
          fixture.repository,
          { limit: 2, now: OLD_NOW },
          {
            afterArtifactStaged() {
              const reviewRoot = path.join(
                fixture.runtime.invocations,
                oldAccepted.invocationId,
                'review-root',
              );
              if (fs.readdirSync(reviewRoot).length === 0) {
                throw new Error('simulated-plan-review-crash');
              }
            },
          },
        ),
      /simulated-plan-review-crash/,
    );
    assert.equal(
      readProviderRetentionReceipt(fixture.runtime, oldAccepted.invocationId)
        ?.state,
      'prepared',
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.runtime.invocations,
          oldAccepted.invocationId,
          'review-root',
        ),
      ),
      [],
    );

    const recovered = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: '2026-08-20T12:01:00.000Z',
    });
    assert.deepEqual(recovered.recovered, [oldAccepted.invocationId]);
    assert.equal(
      readProviderRetentionReceipt(fixture.runtime, oldAccepted.invocationId)
        ?.state,
      'complete',
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.runtime.invocations,
          oldAccepted.invocationId,
          'review-root',
        ),
      ),
      [],
    );
    assert.equal(listExecutionJobs(fixture.repository).length, 2);
  } finally {
    fixture.dispose();
  }
});

test('a crash after complete receipt publication remains readable and cleanup replays', () => {
  const fixture = createSuccessfulHistory('retention-complete-crash', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  const duplicate = fixture.invocations[1]!;
  const stagingDirectory = providerRetentionStagingDirectory(
    fixture.runtime,
    duplicate.invocationId,
  );
  try {
    assert.throws(
      () =>
        pruneProviderRuntime(
          fixture.repository,
          { limit: 2, now: OLD_NOW },
          {
            afterReceiptCompleted() {
              throw new Error('simulated-complete-receipt-crash');
            },
          },
        ),
      /simulated-complete-receipt-crash/,
    );
    assert.equal(
      readProviderRetentionReceipt(fixture.runtime, duplicate.invocationId)
        ?.state,
      'complete',
    );
    assert.deepEqual(fs.readdirSync(runtimePath(fixture, duplicate)), []);
    assert.equal(fs.readdirSync(stagingDirectory).length, 4);
    assert.equal(listExecutionJobs(fixture.repository).length, 1);

    const recovered = pruneProviderRuntime(fixture.repository, {
      limit: 1,
      now: '2026-08-20T12:01:00.000Z',
    });
    assert.deepEqual(recovered.recovered, [duplicate.invocationId]);
    assert.equal(recovered.examined, 0);
    assert.equal(fs.existsSync(stagingDirectory), false);
    assert.equal(listExecutionJobs(fixture.repository).length, 1);
  } finally {
    fixture.dispose();
  }
});

test('missing or tampered complete receipts make pruned invocation scans fail closed', () => {
  for (const mutation of ['missing', 'tampered'] as const) {
    const fixture = createSuccessfulHistory(`retention-${mutation}`, 2, [
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:10:00.000Z',
    ]);
    const duplicate = fixture.invocations[1]!;
    try {
      pruneProviderRuntime(fixture.repository, { limit: 2, now: OLD_NOW });
      const receiptPath = providerRetentionReceiptPath(
        fixture.runtime,
        duplicate.invocationId,
      );
      if (mutation === 'missing') {
        fs.unlinkSync(receiptPath);
      } else {
        const value = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
          artifacts: Array<{ digest: string }>;
        };
        value.artifacts[0]!.digest = 'f'.repeat(64);
        fs.writeFileSync(receiptPath, `${canonicalJson(value)}\n`, {
          mode: 0o600,
        });
      }
      assert.throws(
        () => listExecutionJobs(fixture.repository),
        (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('receipt parents, link count, mode, and size fail closed before trust or deletion', () => {
  const parentFixture = createFailedHistory('retention-parent-link');
  const external = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'retention-link-'),
  );
  try {
    const checkoutRelativeScratch = path.relative(
      sourceRepositoryRoot,
      external,
    );
    assert.ok(
      path.isAbsolute(checkoutRelativeScratch) ||
        checkoutRelativeScratch === '..' ||
        checkoutRelativeScratch.startsWith(`..${path.sep}`),
      'retention test scratch must stay outside the repository checkout',
    );
    const retentionRoot = path.join(
      parentFixture.runtime.root,
      'provider-retention',
    );
    fs.renameSync(retentionRoot, `${retentionRoot}.fixture-backup`);
    fs.symlinkSync(external, retentionRoot);
    assert.throws(
      () =>
        pruneProviderRuntime(parentFixture.repository, {
          limit: 1,
          now: OLD_NOW,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RETENTION_RECEIPT_UNSAFE'),
    );
    assert.deepEqual(fs.readdirSync(external), []);
  } finally {
    parentFixture.dispose();
    fs.rmSync(external, { recursive: true, force: true });
  }

  for (const mutation of ['hardlink', 'mode', 'oversize'] as const) {
    const fixture = createSuccessfulHistory(`retention-${mutation}`, 2, [
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:10:00.000Z',
    ]);
    try {
      const duplicate = fixture.invocations[1]!;
      pruneProviderRuntime(fixture.repository, { limit: 2, now: OLD_NOW });
      const receiptPath = providerRetentionReceiptPath(
        fixture.runtime,
        duplicate.invocationId,
      );
      if (mutation === 'hardlink') {
        fs.linkSync(receiptPath, `${receiptPath}.alias`);
      } else if (mutation === 'mode') {
        fs.chmodSync(receiptPath, 0o644);
      } else {
        fs.writeFileSync(
          receiptPath,
          'x'.repeat(PROVIDER_RETENTION_MAX_RECEIPT_BYTES),
          { mode: 0o600 },
        );
      }
      assert.throws(
        () => listExecutionJobs(fixture.repository),
        (error) => isWorkflowError(error, 'EXECUTION_RUNTIME_STORE_UNSAFE'),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('oversized sparse retention receipts are rejected before descriptor reads', () => {
  const fixture = createSuccessfulHistory('retention-sparse-receipt', 2, [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:10:00.000Z',
  ]);
  const duplicate = fixture.invocations[1]!;
  const receiptPath = providerRetentionReceiptPath(
    fixture.runtime,
    duplicate.invocationId,
  );
  const originalReadFileSync = fs.readFileSync;
  let descriptorReadAttempted = false;
  try {
    pruneProviderRuntime(fixture.repository, { limit: 2, now: OLD_NOW });
    const descriptor = fs.openSync(receiptPath, fs.constants.O_WRONLY);
    try {
      fs.ftruncateSync(descriptor, 1_073_741_824);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.readFileSync = ((...args: unknown[]) => {
      if (typeof args[0] === 'number') {
        descriptorReadAttempted = true;
        throw new Error('unbounded descriptor read attempted');
      }
      return Reflect.apply(originalReadFileSync, fs, args);
    }) as typeof fs.readFileSync;

    assert.throws(
      () =>
        readProviderRetentionReceipt(fixture.runtime, duplicate.invocationId),
      (error) => isWorkflowError(error, 'PROVIDER_RETENTION_RECEIPT_UNSAFE'),
    );
    assert.equal(descriptorReadAttempted, false);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fixture.dispose();
  }
});

test('unsafe runtime links, mode, and size deny pruning without deleting raw evidence', () => {
  for (const mutation of ['symlink', 'hardlink', 'mode', 'oversize'] as const) {
    const fixture = createSuccessfulHistory(
      `retention-runtime-${mutation}`,
      2,
      ['2026-08-01T10:00:00.000Z', '2026-08-01T10:10:00.000Z'],
    );
    const duplicate = fixture.invocations[1]!;
    const promptPath = path.join(
      runtimePath(fixture, duplicate),
      'prompt.json',
    );
    try {
      if (mutation === 'symlink') {
        const target = path.join(fixture.repository, 'outside-prompt.json');
        fs.writeFileSync(target, '{}\n', { mode: 0o600 });
        fs.unlinkSync(promptPath);
        fs.symlinkSync(target, promptPath);
      } else if (mutation === 'hardlink') {
        fs.linkSync(promptPath, path.join(fixture.repository, 'prompt.alias'));
      } else if (mutation === 'mode') {
        fs.chmodSync(promptPath, 0o644);
      } else {
        fs.writeFileSync(promptPath, 'x'.repeat(1_048_577), { mode: 0o600 });
      }

      const result = pruneProviderRuntime(fixture.repository, {
        limit: 2,
        now: OLD_NOW,
      });
      assert.equal(result.pruned.length, 0);
      assert.ok(
        result.denied.some(
          ({ invocationId, reason }) =>
            invocationId === duplicate.invocationId &&
            reason === 'unsafe-artifact',
        ),
      );
      assert.equal(fs.lstatSync(promptPath).isFile(), mutation !== 'symlink');
      assert.equal(fs.existsSync(candidatePath(fixture, duplicate)), true);
      assert.equal(
        fs.existsSync(
          providerRetentionReceiptPath(fixture.runtime, duplicate.invocationId),
        ),
        false,
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('job prune CLI honors the bounded limit and receipts remain below 4KB', () => {
  const fixture = createSuccessfulHistory('retention-limit', 4, [
    '2026-07-01T10:00:00.000Z',
    '2026-07-01T10:10:00.000Z',
    '2026-07-01T10:20:00.000Z',
    '2026-07-01T10:30:00.000Z',
  ]);
  try {
    const cli = runWorkflowCli(fixture.repository, [
      'job',
      'prune',
      '--limit',
      '2',
      '--json',
    ]);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout) as {
      result: ReturnType<typeof pruneProviderRuntime>;
    };
    assert.equal(parsed.result.policy.limit, 2);
    assert.equal(parsed.result.examined, 2);
    assert.equal(parsed.result.pruned.length, 2);
    assert.equal(
      fixture.invocations.filter(
        (invocation) =>
          fs.readdirSync(runtimePath(fixture, invocation)).length === 0,
      ).length,
      2,
    );
    for (const pruned of parsed.result.pruned) {
      assert.ok(
        fs.statSync(
          providerRetentionReceiptPath(fixture.runtime, pruned.invocationId),
        ).size < PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
      );
    }

    const second = pruneProviderRuntime(fixture.repository, {
      limit: 2,
      now: OLD_NOW,
    });
    assert.equal(second.examined, 2);
    assert.equal(second.pruned.length, 1);
    assert.equal(listExecutionJobs(fixture.repository).length, 1);

    assert.throws(
      () =>
        pruneProviderRuntime(fixture.repository, {
          limit: PROVIDER_RETENTION_MAX_LIMIT + 1,
          now: OLD_NOW,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RETENTION_LIMIT_INVALID'),
    );
    assert.throws(
      () =>
        pruneProviderRuntime(fixture.repository, {
          limit: 1,
          now: OLD_NOW,
          ttlDays: 91,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RETENTION_TTL_INVALID'),
    );
  } finally {
    fixture.dispose();
  }
});

test('durable catalog cursor bounds every pass and reaches all eligible history', () => {
  const fixture = createSuccessfulHistory('retention-catalog-fairness', 5, [
    '2026-07-01T10:00:00.000Z',
    '2026-07-01T10:10:00.000Z',
    '2026-07-01T10:20:00.000Z',
    '2026-07-01T10:30:00.000Z',
    '2026-07-01T10:40:00.000Z',
  ]);
  try {
    const pruned = new Set<string>();
    const denied: Array<{ invocationId: string; reason: string }> = [];
    for (let pass = 0; pass < 5; pass += 1) {
      const result = pruneProviderRuntime(fixture.repository, {
        limit: 1,
        now: OLD_NOW,
      });
      assert.equal(result.examined + result.recovered.length, 1);
      for (const entry of result.pruned) pruned.add(entry.invocationId);
      denied.push(...result.denied);
    }
    assert.deepEqual(
      [...pruned].sort(),
      fixture.invocations
        .slice(1)
        .map(({ invocationId }) => invocationId)
        .sort(),
    );
    assert.ok(
      denied.some(
        ({ invocationId, reason }) =>
          invocationId === fixture.invocations[0]!.invocationId &&
          reason === 'accepted-result-current',
      ),
    );
  } finally {
    fixture.dispose();
  }
});

type Fixture = ReturnType<typeof createSuccessfulHistory>;

function createSuccessfulHistory(
  name: string,
  attempts: number,
  completedAt: string[],
) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const investigationId = `investigation-${name}`;
  const manifest = createManifest(repository, investigationId);
  const invocations: ProviderInvocationRequest[] = [];
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const invocationId = `invocation-${name}-${attempt}`;
      const request = createRequest(
        repository,
        manifest,
        invocationId,
        investigationId,
      );
      storeProviderExecutionPolicySnapshot(
        runtime,
        request,
        loadAiAdapterPolicy(repository),
      );
      createProviderInvocation(runtime, {
        investigationId,
        changeId: CHANGE_ID,
        attempt,
        manifest,
        request,
        createdAt: new Date(
          Date.parse(completedAt[attempt - 1]!) - 60_000,
        ).toISOString(),
      });
      invocations.push(request);
    }
    const claims = invocations.map((request, index) =>
      claimInvocationForCompletion(runtime, request, completedAt[index]!),
    );
    const prepared = invocations.map((request, index) => ({
      claim: claims[index]!,
      acceptanceBinding: prepareProviderInvocationAcceptanceBinding(
        runtime,
        request.invocationId,
        'synchronous-no-activity',
      ),
    }));
    for (const [index, request] of invocations.entries()) {
      completeInvocation(
        runtime,
        request,
        completedAt[index]!,
        prepared[index]!,
      );
    }
    const [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    return {
      repository,
      runtime,
      invocations,
      jobId: inspection.job.jobId,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function createFailedHistory(name: string) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const investigationId = `investigation-${name}`;
  const manifest = createManifest(repository, investigationId);
  const request = createRequest(
    repository,
    manifest,
    `invocation-${name}-1`,
    investigationId,
  );
  try {
    storeProviderExecutionPolicySnapshot(
      runtime,
      request,
      loadAiAdapterPolicy(repository),
    );
    createProviderInvocation(runtime, {
      investigationId,
      changeId: CHANGE_ID,
      attempt: 1,
      manifest,
      request,
      createdAt: '2026-07-01T09:59:00.000Z',
    });
    const claim = claimProviderInvocation(runtime, request.invocationId, {
      workerId: `worker-${request.invocationId}`,
      leaseDurationMs: request.limits.timeoutMs,
      now: '2026-07-01T09:59:30.000Z',
    });
    failProviderInvocation(runtime, request.invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_TIMEOUT',
        message: 'Provider timed out.',
      },
      now: '2026-07-01T10:00:00.000Z',
    });
    createRawRuntime(runtime, request);
    const [inspection] = listExecutionJobs(repository);
    assert.ok(inspection);
    return {
      repository,
      runtime,
      invocations: [request],
      jobId: inspection.job.jobId,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function createHostWrapperFailedDuplicateHistory(
  name: string,
  phase: 'assignment-admitted' | 'native-terminal',
) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const investigationId = `investigation-${name}`;
  const manifest = createManifest(repository, investigationId);
  const invocations: ProviderInvocationRequest[] = [];
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const request = createRequest(
        repository,
        manifest,
        `invocation-${name}-${attempt}`,
        investigationId,
      );
      storeProviderExecutionPolicySnapshot(
        runtime,
        request,
        loadAiAdapterPolicy(repository),
      );
      createProviderInvocation(runtime, {
        investigationId,
        changeId: CHANGE_ID,
        attempt,
        manifest,
        request,
        createdAt: `2026-08-01T10:0${attempt - 1}:00.000Z`,
      });
      invocations.push(request);
    }
    const accepted = invocations[0]!;
    const duplicate = invocations[1]!;
    const acceptedClaim = claimProviderInvocation(
      runtime,
      accepted.invocationId,
      {
        workerId: `worker-${accepted.invocationId}`,
        leaseDurationMs: accepted.limits.timeoutMs,
        now: '2026-08-01T10:00:30.000Z',
      },
    );
    const duplicateClaim = claimProviderInvocation(
      runtime,
      duplicate.invocationId,
      {
        workerId: `worker-${duplicate.invocationId}`,
        leaseDurationMs: duplicate.limits.timeoutMs,
        now: '2026-08-01T10:01:30.000Z',
      },
    );
    const acceptedAcceptanceBinding =
      prepareProviderInvocationAcceptanceBinding(
        runtime,
        accepted.invocationId,
        'synchronous-no-activity',
      );
    const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
      runtime,
      duplicate.invocationId,
      'schema-v4',
    );
    completeInvocation(runtime, accepted, '2026-08-01T10:02:00.000Z', {
      claim: acceptedClaim,
      acceptanceBinding: acceptedAcceptanceBinding,
    });
    const hostRuntime = installHostWrapperFailureRuntime(
      runtime,
      duplicate,
      acceptanceBinding,
      phase,
    );
    failProviderInvocation(runtime, duplicate.invocationId, {
      expectedRevision: duplicateClaim.record.revision,
      leaseGeneration: duplicateClaim.record.leaseGeneration,
      leaseToken: duplicateClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code:
          phase === 'assignment-admitted'
            ? 'AGENT_RUNTIME_V1_PROVIDER_UNAVAILABLE'
            : 'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
        message:
          phase === 'assignment-admitted'
            ? 'The host-wrapper probe failed before attestation.'
            : 'The host-wrapper native turn failed after writing output.',
      },
      runtimeEvidence: {
        acceptanceBinding,
        progress:
          phase === 'assignment-admitted'
            ? {
                schemaVersion: 1,
                kind: 'agent-runtime-process-progress',
                processState: 'not-started',
                eventCount: 0,
                stdoutBytes: 0,
                stderrBytes: 0,
                lastProcessActivityElapsedMs: null,
                lastProviderActivityElapsedMs: null,
              }
            : {
                schemaVersion: 1,
                kind: 'agent-runtime-process-progress',
                processState: 'exited',
                eventCount: hostRuntime.protocolReceipt?.frameCount ?? 0,
                stdoutBytes: hostRuntime.protocolReceipt?.aggregateBytes ?? 0,
                stderrBytes: 0,
                lastProcessActivityElapsedMs: 10,
                lastProviderActivityElapsedMs: 10,
              },
        ...(hostRuntime.protocolReceipt === null
          ? {}
          : { protocolReceipt: hostRuntime.protocolReceipt }),
        hostExecutionBinding: hostRuntime.hostExecutionBinding,
      },
      now: '2026-08-01T10:10:00.000Z',
    });
    const terminal = readProviderInvocation(runtime, duplicate.invocationId);
    assert.equal(terminal.runtimeReceipt?.schemaVersion, 4);
    assert.equal(
      terminal.runtimeReceipt?.schemaVersion === 4
        ? terminal.runtimeReceipt.hostExecutionBinding?.phase
        : null,
      phase,
    );
    return {
      repository,
      runtime,
      invocations,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function createSemanticRolloverHistory(name: string) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const investigationId = `investigation-${name}`;
  const invocations: ProviderInvocationRequest[] = [];
  try {
    for (const [index, completedAt] of [
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:10:00.000Z',
    ].entries()) {
      const manifest = createManifest(
        repository,
        `${investigationId}-semantic-generation-${index + 1}`,
      );
      const request = createRequest(
        repository,
        manifest,
        `invocation-${name}-${index + 1}`,
        investigationId,
      );
      storeProviderExecutionPolicySnapshot(
        runtime,
        request,
        loadAiAdapterPolicy(repository),
      );
      createProviderInvocation(runtime, {
        investigationId,
        changeId: CHANGE_ID,
        attempt: 1,
        manifest,
        request,
        createdAt: new Date(Date.parse(completedAt) - 60_000).toISOString(),
      });
      completeInvocation(runtime, request, completedAt);
      invocations.push(request);
    }
    assert.equal(listExecutionJobs(repository).length, 2);
    return {
      repository,
      runtime,
      invocations,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function createPlanReviewRolloverHistory(name: string) {
  const repository = createFixtureRepository();
  const runtime = loadInvestigationRuntimeContext(repository).runtime;
  const ready = writeReadyV3ExemptChange(repository);
  const contract = loadChangeContract(repository, CHANGE_ID);
  assert.ok(contract.investigation);
  const investigationManifest = contract.investigation.manifest;
  const context = deriveInvestigationFirstPlanningSubject(
    planningAssuranceDependencies,
    repository,
    contract,
    readCurrentPlanningRoleOverridePolicy(repository, contract.changeId),
  );
  const investigationId = investigationManifest.investigationId;
  const assignment = {
    role: 'plan-reviewer' as const,
    providerId: 'claude' as const,
    sessionId: `provider-session-${name}`,
    targetDigest: context.subject.subjectDigest,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence: 'provider-independent' as const,
  };
  const materialization = writeCurrentPlanningMaterialization(
    runtime,
    investigationManifest,
    context.subject.investigationBaseline,
    {
      'proposal.md': sha256(
        fs.readFileSync(
          path.join(repository, 'openspec/changes', CHANGE_ID, 'proposal.md'),
          'utf8',
        ),
      ),
    },
  );
  const invocations: ProviderInvocationRequest[] = [];
  try {
    for (const [index, completedAt] of [
      '2026-08-01T11:00:00.000Z',
      '2026-08-01T11:10:00.000Z',
    ].entries()) {
      const content = Buffer.from(`plan-review-generation-${index + 1}\n`);
      const targetNode = createPlanReviewTargetSnapshotNode({
        changeId: CHANGE_ID,
        changePrefix: `openspec/changes/${CHANGE_ID}`,
        subject: context.subject,
        materializationNode: materialization,
        artifacts: new Map([['proposal.md', content]]),
      });
      writeEvidenceNode(runtime, targetNode);
      const authorization = createEvidenceNode({
        type: 'plan-review-authorization',
        nodeSchema: 'workflow.plan-review-authorization.v3',
        evaluator: 'workflow-propose.v1',
        policyDigest: PROPOSE_POLICY_DIGEST,
        exactInputDigests: {
          assignment: sha256(canonicalJson(assignment)),
          generation: context.subject.planningGenerationId,
          grantAuthorization: sha256(canonicalJson(null)),
          roleTopology: sha256(canonicalJson(null)),
          subject: context.subject.subjectDigest,
          targetSnapshot: targetNode.nodeId,
        },
        semanticParentResultDigests: {
          materialization: materialization.resultDigest,
          targetSnapshot: targetNode.resultDigest,
        },
        provenanceParentNodeIds: {
          materialization: materialization.nodeId,
          targetSnapshot: targetNode.nodeId,
        },
        outputSchema: 'workflow.plan-review-authorization-output.v3',
        output: {
          subject: context.subject,
          assignment,
          author: {
            providerId: 'codex',
            sessionId: 'fixture-author-session',
            principalId: 'fixture-author',
            identityAssurance: 'adapter-assigned',
            engineSpawned: false,
          },
          grantAuthorization: null,
          roleTopology: null,
        },
        runtimeMetadata: {},
      });
      writeEvidenceNode(runtime, authorization);
      const manifest: PlanReviewManifest = {
        schemaVersion: 1,
        kind: 'plan-review-manifest',
        changeId: CHANGE_ID,
        repositoryId: 'fixture',
        baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
        baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
        subject: context.subject,
        capabilityProfile: 'repository-read-only',
        planningTarget: readPlanReviewTargetSnapshotNode(targetNode),
      };
      const invocationId = `invocation-${name}-${index + 1}`;
      const request = createProviderInvocationRequest({
        invocationId,
        nonce: `${invocationId}-nonce-000000`,
        purpose: 'plan-review',
        providerId: 'claude',
        roleAssignment: assignment,
        capabilityProfile: 'repository-read-only',
        repositoryId: 'fixture',
        baseCommit: manifest.baseCommit,
        baseTree: manifest.baseTree,
        targetDigest: context.subject.subjectDigest,
        inputManifestDigest: providerInvocationManifestDigest(manifest),
        authorizationNodeId: authorization.nodeId,
        writeAllowedPaths: [],
        outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
        evaluatorVersion: 'plan-review.v2',
        policyDigest: loadAiAdapterPolicy(repository).digest,
        limits: { timeoutMs: 600_000, aggregateOutputBytes: 1_048_576 },
      });
      storeProviderExecutionPolicySnapshot(
        runtime,
        request,
        loadAiAdapterPolicy(repository),
      );
      createProviderInvocation(runtime, {
        investigationId,
        changeId: CHANGE_ID,
        attempt: 1,
        manifest,
        request,
        planReviewSnapshotFiles: [{ snapshotFile: '0000.artifact', content }],
        createdAt: new Date(Date.parse(completedAt) - 60_000).toISOString(),
      });
      completePlanReviewInvocation(
        runtime,
        request,
        completedAt,
        ready.applicabilityNode.nodeId,
        ready.applicabilityNode.resultDigest,
      );
      invocations.push(request);
    }
    assert.equal(listExecutionJobs(repository).length, 2);
    return {
      repository,
      runtime,
      invocations,
      dispose() {
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function writeCurrentPlanningMaterialization(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  manifest: InvestigationManifestV3,
  baseline: PlanReviewSubject['investigationBaseline'],
  artifacts: Record<string, string>,
) {
  const investigationTargetDigest =
    manifest.investigationApproval.investigationTargetDigest;
  const sessionSnapshotDigest = manifest.authoring.sessionSnapshotDigest;
  const authority = createEvidenceNode({
    type: 'investigation-manifest-authority',
    nodeSchema: 'investigation.manifest-authority.v1',
    evaluator: 'workflow-propose.manifest-authority.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      manifest: manifest.manifestDigest,
      investigationTarget: investigationTargetDigest,
      sessionSnapshot: sessionSnapshotDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.manifest-authority-output.v1',
    output: {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest,
    },
    runtimeMetadata: {},
  });
  const materialization = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'workflow.propose-planning-materialization.v3',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      artifacts: sha256(canonicalJson(artifacts)),
      baseline: sha256(canonicalJson(baseline)),
      manifestAuthority: authority.nodeId,
      manifest: manifest.manifestDigest,
      investigationTarget: investigationTargetDigest,
      sessionSnapshot: sessionSnapshotDigest,
    },
    semanticParentResultDigests: {
      manifestAuthority: authority.resultDigest,
    },
    provenanceParentNodeIds: { manifestAuthority: authority.nodeId },
    outputSchema: 'workflow.propose-planning-materialization-output.v3',
    output: {
      investigationId: manifest.investigationId,
      changeId: manifest.changeId,
      semanticRevision: manifest.authoring.sessionRevision,
      baseline,
      artifacts,
      manifestAuthorityNodeId: authority.nodeId,
      manifestAuthorityResultDigest: authority.resultDigest,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest,
      sessionSnapshotDigest,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authority);
  writeEvidenceNode(runtime, materialization);
  return materialization;
}

function createRequest(
  repository: string,
  manifest: BlindSurveyManifest,
  invocationId: string,
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
    limits: { timeoutMs: 600_000, aggregateOutputBytes: 1_048_576 },
  });
}

function completeInvocation(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
  now: string,
  prepared = prepareInvocationForCompletion(runtime, request, now),
): void {
  const { claim, acceptanceBinding } = prepared;
  const semanticOutput = providerSemanticOutput(request);
  createRawRuntime(runtime, request, semanticOutput);
  completeProviderInvocationFromRunner(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    acceptanceBinding,
    report: providerRunnerReport(request, semanticOutput),
    now,
  });
}

function prepareInvocationForCompletion(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
  now: string,
) {
  const claim = claimInvocationForCompletion(runtime, request, now);
  return {
    claim,
    acceptanceBinding: prepareProviderInvocationAcceptanceBinding(
      runtime,
      request.invocationId,
      'synchronous-no-activity',
    ),
  };
}

function claimInvocationForCompletion(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
  now: string,
) {
  return claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    now: new Date(Date.parse(now) - 30_000).toISOString(),
  });
}

function completePlanReviewInvocation(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
  now: string,
  applicabilityNodeId: string,
  applicabilityResultDigest: string,
): void {
  const claim = claimProviderInvocation(runtime, request.invocationId, {
    workerId: `worker-${request.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    now: new Date(Date.parse(now) - 30_000).toISOString(),
  });
  const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
    runtime,
    request.invocationId,
    'synchronous-no-activity',
  );
  const submission = {
    verdict: 'advisory-approve',
    scopeEvidence: [
      {
        kind: 'investigation-node',
        nodeId: applicabilityNodeId,
        resultDigest: applicabilityResultDigest,
      },
    ],
    findings: [],
    proposedTerms: [],
    suggestions: [],
    residualRisk: 'Retention fixture residual risk.',
    uncertainty: 'Retention fixture uncertainty.',
  };
  createRawRuntime(runtime, request, submission);
  completeProviderInvocationFromRunner(runtime, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    acceptanceBinding,
    report: providerRunnerReport(request, submission),
    now,
  });
}

function providerSemanticOutput(request: ProviderInvocationRequest) {
  return {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'ProviderRetention' }],
  };
}

function providerRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
) {
  const providerDefinitionSnapshot = resolveBuiltInProviderDefinitionSnapshot(
    request.providerId,
    'darwin',
  );
  assert.ok(providerDefinitionSnapshot);
  return {
    invocationId: request.invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
    assurance: 'unchanged-governed-projection' as const,
    projection: {
      unchanged: true as const,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false as const,
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
    elapsedMs: 10,
    providerDefinitionSnapshot,
  };
}

function createRawRuntime(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
  semanticOutput: unknown = providerSemanticOutput(request),
): void {
  const directory = path.join(
    runtime.invocations,
    request.invocationId,
    'runtime',
  );
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', `${canonicalJson({ request: request.requestDigest })}\n`],
    ['schema.json', `${canonicalJson(request.outputSchema)}\n`],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  }
}

function installHostWrapperFailureRuntime(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
  acceptanceBinding: ReturnType<
    typeof prepareProviderInvocationAcceptanceBinding
  >,
  phase: 'assignment-admitted' | 'native-terminal',
) {
  const assignmentAuthority = publishRetentionHostWrapperAssignment(
    runtime,
    request,
  );
  const { assignmentBinding, profile } = assignmentAuthority;
  const executableObservation = inspectProviderExecutable(profile.executable);
  if (
    executableObservation.state !== 'observed' ||
    executableObservation.identity === null
  ) {
    assert.fail('the current Node executable must be observable');
  }
  const providerDefinitionBindingDigest =
    providerDefinitionExecutableBindingDigest(
      profile.profileDigest,
      executableObservation.identity,
    );
  const probeDirectory = hostWrapperProbePath({ runtime }, request);
  const probeRequestPath = path.join(probeDirectory, 'request.json');
  const probeResultPath = path.join(probeDirectory, 'probe-result.json');
  fs.mkdirSync(probeDirectory, { mode: 0o700 });
  writeCanonicalPrivateFile(probeRequestPath, {
    schemaVersion: 1,
    kind: 'agent-runtime-host-wrapper-probe-request.v1',
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    executionAttemptId: acceptanceBinding.executionAttemptId,
    acceptanceBindingDigest: acceptanceBinding.bindingDigest,
    assignmentBindingDigest: assignmentBinding.bindingDigest,
    providerFamily: request.providerId,
    profileDigest: profile.profileDigest,
    providerDefinitionBindingDigest,
    outputFile: probeResultPath,
  });
  if (phase === 'assignment-admitted') {
    fs.writeFileSync(probeResultPath, '', { mode: 0o600, flag: 'wx' });
  } else {
    writeCanonicalPrivateFile(probeResultPath, {
      schemaVersion: 1,
      kind: 'agent-runtime-host-wrapper-probe-result.v1',
      providerVersion: 'retention-host-wrapper-v1',
      authentication: 'authenticated',
    });
  }
  const probeEvidence =
    phase === 'assignment-admitted'
      ? null
      : createAgentRuntimeHostProbeEvidenceV1({
          invocationId: request.invocationId,
          requestDigest: request.requestDigest,
          executionAttemptId: acceptanceBinding.executionAttemptId,
          acceptanceBindingDigest: acceptanceBinding.bindingDigest,
          assignmentBindingDigest: assignmentBinding.bindingDigest,
          providerProfileDigest: profile.profileDigest,
          executable: executableObservation.identity,
          providerDefinitionBindingDigest,
          providerVersion: 'retention-host-wrapper-v1',
          probeRequestFileDigest: sha256(
            fs.readFileSync(probeRequestPath, 'utf8'),
          ),
          probeResultFileDigest: sha256(
            fs.readFileSync(probeResultPath, 'utf8'),
          ),
          governedBeforeDigest: sha256(
            canonicalJson({
              kind: 'retention-host-probe-governed-state',
              invocationId: request.invocationId,
              requestDigest: request.requestDigest,
            }),
          ),
          governedAfterDigest: sha256(
            canonicalJson({
              kind: 'retention-host-probe-governed-state',
              invocationId: request.invocationId,
              requestDigest: request.requestDigest,
            }),
          ),
        });
  const nativeAuthority =
    phase === 'native-terminal'
      ? publishRetentionHostWrapperNativeSessionChain(
          runtime,
          assignmentAuthority,
          request,
          acceptanceBinding,
        )
      : null;
  if (nativeAuthority !== null) {
    const turnDirectory = hostWrapperTurnPath({ runtime }, request);
    fs.mkdirSync(turnDirectory, { mode: 0o700 });
    writeCanonicalPrivateFile(path.join(turnDirectory, 'request.json'), {
      schemaVersion: 1,
      kind: 'agent-runtime-host-wrapper-turn-request.v1',
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      action: nativeAuthority.claim.action,
      prompt: canonicalJson({
        schemaVersion: 1,
        kind: 'agent-runtime-host-wrapper-request.v1',
        request,
      }),
      outputFile: path.join(turnDirectory, 'semantic-output.json'),
    });
    fs.writeFileSync(path.join(turnDirectory, 'semantic-output.json'), '', {
      mode: 0o600,
      flag: 'wx',
    });
  }
  return {
    hostExecutionBinding: createAgentRuntimeHostExecutionBindingV1({
      assignmentBinding,
      probe: probeEvidence,
      nativeSessionClaim: nativeAuthority?.claim ?? null,
      nativeSessionCompletionDigest:
        nativeAuthority?.completion.completionDigest ?? null,
    }),
    protocolReceipt: nativeAuthority?.protocolReceipt ?? null,
  };
}

function publishRetentionHostWrapperAssignment(
  runtime: Fixture['runtime'],
  request: ProviderInvocationRequest,
) {
  const { source, configuration } = retentionHostWrapperConfiguration();
  const profile = configuration.providers[0] as
    HostWrapperProviderProfileSnapshot | undefined;
  if (profile === undefined) assert.fail('retention profile must exist');
  const central = createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author', 'builder', 'reviewer'],
        sessionGroups: [['author'], ['builder'], ['reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: profile.logicalProviderId,
        },
      },
    ],
    globalProviderRanking: [profile.logicalProviderId],
  });
  const caller = {
    logicalProviderId: profile.logicalProviderId,
    profileId: null,
    engineSessionId: null,
    adoptableRoles: [] as const,
  };
  const dataAuthorization = {
    policyDigest: request.policyDigest,
    inputManifestDigest: request.inputManifestDigest,
    relevantTargetDigest: request.targetDigest,
    profiles: [
      {
        profileId: profile.id,
        allowed: true,
        reason: 'RETENTION_FIXTURE_AUTHORIZED',
      },
    ],
  };
  const sessionCapabilities = [
    { profileId: profile.id, canStartFresh: true, canResume: true },
  ];
  const providerRegistry = {
    schemaVersion: 1 as const,
    policyDigest: sha256(
      canonicalJson({
        kind: 'retention-provider-registry-policy',
        providerConfigurationDigest: configuration.configDigest,
        requestPolicyDigest: request.policyDigest,
      }),
    ),
    providers: [
      {
        logicalProviderId: profile.logicalProviderId,
        providerFamily: profile.family,
        enabled: true,
        definitionDigest: profile.profileDigest,
      },
    ],
  };
  const providerRegistryDigest = sha256(canonicalJson(providerRegistry));
  const planningGeneration = sha256(
    canonicalJson({
      kind: 'retention-change-role-assignment-generation',
      changeId: CHANGE_ID,
      inputManifestDigest: request.inputManifestDigest,
      targetDigest: request.targetDigest,
    }),
  );
  const changeOverrideBody: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId: CHANGE_ID,
    baseCentralConfigurationDigest: central.configurationDigest,
    roleLanes: [],
    pairwiseRequirements: [],
    customWrapperPolicy: 'allowed',
    grantReferences: [],
  };
  const changeOverridePlan = {
    ...changeOverrideBody,
    planDigest: agentRolePlanV2Digest(changeOverrideBody),
  };
  const protectedContext = createChangeRoleAssignmentProtectedContextV1({
    classification: 'ordinary',
    pathRoleSourceDigest: sha256(
      canonicalJson({
        kind: 'retention-path-role-source',
        targetDigest: request.targetDigest,
      }),
    ),
    policySourceDigest: sha256(
      canonicalJson({
        kind: 'retention-policy-source',
        policyDigest: request.policyDigest,
      }),
    ),
    inputManifestDigest: request.inputManifestDigest,
    relevantTargetDigest: request.targetDigest,
  });
  const resolved = resolveChangeRoleAssignmentV1({
    changeId: CHANGE_ID,
    planningGeneration,
    providerRegistryDigest,
    centralDefault: central,
    changeOverride: changeOverridePlan,
    providerConfiguration: configuration,
    caller,
    dataAuthorization,
    sessionCapabilities,
    protectedContext,
  });
  if (resolved.outcome === 'unsatisfied') {
    assert.fail('retention role assignment must resolve');
  }
  const centralSource = renderCentralRoleProviderDefault(central);
  const changeOverrideSource = renderAgentRolePlanV2(changeOverridePlan);
  const assignmentCandidate = createChangeRoleAssignmentRecordV1({
    central: createCentralRoleProviderDefaultSnapshotV1({
      pinnedCommit: request.baseCommit,
      blobObjectId: gitBlobObjectId(centralSource),
      configuration: central,
    }),
    host: {
      sourceDigest: sha256(source),
      configuration,
    },
    changeOverride: createAgentRolePlanV2Snapshot({
      pinnedCommit: request.baseCommit,
      blobObjectId: gitBlobObjectId(changeOverrideSource),
      plan: changeOverridePlan,
    }),
    caller,
    dataAuthorization,
    sessionCapabilities,
    providerRegistry,
    resolution: resolved.resolution,
  });
  const verifyCentralSnapshot: Parameters<
    typeof createOrReadExactChangeRoleAssignmentRecordV1
  >[2] = (candidate) => candidate;
  const verifyChangeOverrideSnapshot: Parameters<
    typeof createOrReadExactChangeRoleAssignmentRecordV1
  >[3] = (candidate) => candidate;
  const verifyHostConfiguration: Parameters<
    typeof createOrReadExactChangeRoleAssignmentRecordV1
  >[4] = (candidate) => candidate;
  const verifyProviderRegistry: Parameters<
    typeof createOrReadExactChangeRoleAssignmentRecordV1
  >[5] = (candidate) => candidate;
  const verifyDataAuthorization: Parameters<
    typeof createOrReadExactChangeRoleAssignmentRecordV1
  >[6] = (candidate) => candidate;
  const verifySessionCapabilities: Parameters<
    typeof createOrReadExactChangeRoleAssignmentRecordV1
  >[7] = (candidate) => candidate;
  const verifyProtectedContext: Parameters<
    typeof createOrReadExactChangeRoleAssignmentRecordV1
  >[8] = (candidate) => candidate;
  const assignment = createOrReadExactChangeRoleAssignmentRecordV1(
    runtime,
    assignmentCandidate,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapabilities,
    verifyProtectedContext,
  );
  const assignmentBinding = projectAgentRuntimeAssignmentBindingV1(assignment, {
    purpose: request.purpose,
    providerId: request.providerId,
    inputManifestDigest: request.inputManifestDigest,
    targetDigest: request.targetDigest,
  });
  const slot = assignment.sessionSlots.find(({ roles }) =>
    roles.includes('author'),
  );
  if (slot === undefined || slot.sessionMode !== 'fresh') {
    assert.fail('retention author assignment must use a fresh session');
  }
  assert.equal(assignment.grantRequirement, null);
  return {
    assignment,
    assignmentBinding,
    profile,
    slot,
    verifiers: {
      verifyCentralSnapshot,
      verifyChangeOverrideSnapshot,
      verifyHostConfiguration,
      verifyProviderRegistry,
      verifyDataAuthorization,
      verifySessionCapabilities,
      verifyProtectedContext,
    },
  };
}

function publishRetentionHostWrapperNativeSessionChain(
  runtime: Fixture['runtime'],
  authority: ReturnType<typeof publishRetentionHostWrapperAssignment>,
  request: ProviderInvocationRequest,
  acceptanceBinding: ReturnType<
    typeof prepareProviderInvocationAcceptanceBinding
  >,
) {
  const { assignment, slot, verifiers } = authority;
  const terminalClaim = claimProviderNativeSessionTurnV1(
    runtime,
    {
      changeId: assignment.changeId,
      planningGeneration: assignment.planningGeneration,
      assignmentRecordDigest: assignment.recordDigest,
      sessionSlotId: slot.sessionSlotId,
      predecessorCompletionDigest: null,
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      attemptId: acceptanceBinding.executionAttemptId,
    },
    verifiers.verifyCentralSnapshot,
    verifiers.verifyChangeOverrideSnapshot,
    verifiers.verifyHostConfiguration,
    verifiers.verifyProviderRegistry,
    verifiers.verifyDataAuthorization,
    verifiers.verifySessionCapabilities,
    verifiers.verifyProtectedContext,
  );
  if (terminalClaim.binding === null) {
    assert.fail('native-session claim must expose a launch binding');
  }
  const completion = completeProviderNativeSessionTurnV1(
    runtime,
    {
      changeId: assignment.changeId,
      planningGeneration: assignment.planningGeneration,
      assignmentRecordDigest: assignment.recordDigest,
      sessionSlotId: slot.sessionSlotId,
      claimDigest: terminalClaim.claim.claimDigest,
      terminal: retentionFailedNativeTerminal(terminalClaim.binding),
    },
    verifiers.verifyCentralSnapshot,
    verifiers.verifyChangeOverrideSnapshot,
    verifiers.verifyHostConfiguration,
    verifiers.verifyProviderRegistry,
    verifiers.verifyDataAuthorization,
    verifiers.verifySessionCapabilities,
    verifiers.verifyProtectedContext,
  );
  assert.equal(completion.disposition, 'error');
  assert.equal(completion.usable, false);
  if (completion.protocolReceipt === null) {
    assert.fail('native-session error must retain its protocol receipt');
  }
  const chain = readProviderNativeSessionChainV1(
    runtime,
    assignment.changeId,
    assignment.planningGeneration,
    assignment.recordDigest,
    slot.sessionSlotId,
    verifiers.verifyCentralSnapshot,
    verifiers.verifyChangeOverrideSnapshot,
    verifiers.verifyHostConfiguration,
    verifiers.verifyProviderRegistry,
    verifiers.verifyDataAuthorization,
    verifiers.verifySessionCapabilities,
    verifiers.verifyProtectedContext,
  );
  assert.equal(chain.state, 'terminal-unusable');
  assert.equal(chain.turns.length, 1);
  return {
    claim: terminalClaim.claim,
    completion,
    protocolReceipt: completion.protocolReceipt,
  };
}

function retentionFailedNativeTerminal(
  binding: ProviderWrapperSessionProtocolBinding,
) {
  const parser = createProviderWrapperSessionProtocolParser({ binding });
  parser.push(
    Buffer.from(
      [
        {
          schemaVersion: 2 as const,
          type: 'hello' as const,
          sequence: 1,
          protocol: 'harness-jsonl-v2' as const,
        },
        {
          schemaVersion: 2 as const,
          type: 'error' as const,
          sequence: 2,
          code: 'PROVIDER_FAILED',
        },
      ]
        .map(renderProviderWrapperSessionFrame)
        .join(''),
    ),
  );
  return {
    kind: 'protocol-outcome' as const,
    outcome: parser.finish({ cancellationForced: false }),
    privateIdentityObservation: null,
  };
}

function writeCanonicalPrivateFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}

function retentionHostWrapperConfiguration() {
  const wrapper = path.join(
    import.meta.dirname,
    'fixtures/provider-wrapper-fixture.mjs',
  );
  const source = `schema_version = 2
global_ranking = ["host-claude"]

[[providers]]
id = "host-claude"
logical_provider_id = "claude"
family = "claude"
capabilities = ["fresh-session", "plan-review", "resumable-session", "survey", "task-diff-review", "task-implementation"]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = "${process.execPath}"
start_args = ["${wrapper}", "host-start", "{request_file}"]
resume_args = ["${wrapper}", "host-resume", "{native_session_id}", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"

[provider_preferences]
author = ["host-claude"]
builder = ["host-claude"]
reviewer = ["host-claude"]
`;
  return {
    source,
    configuration: parseAgentProviderConfigToml(source, {
      platform: process.platform,
    }),
  };
}

function gitBlobObjectId(source: string): string {
  return crypto
    .createHash('sha1')
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest('hex');
}

function hostWrapperRetentionReceipt(
  terminalState: 'succeeded' | 'failed',
  requestedNames: readonly ProviderRetentionArtifactName[],
) {
  const artifacts = [...requestedNames]
    .sort()
    .map((name) => ({ name, digest: 'a'.repeat(64), bytes: 1 }));
  const identity = {
    invocationId: 'invocation-host-wrapper-receipt-fixture',
    workflowId: 'workflow-host-wrapper-receipt-fixture',
    jobId: 'job-host-wrapper-receipt-fixture',
    attemptId: 'attempt-host-wrapper-receipt-fixture',
    contextDigest: `sha256:${'b'.repeat(64)}`,
    executionRevision: 1,
    executionStateDigest: 'c'.repeat(64),
    epoch: 1,
    currentEpoch: 2,
    attemptRetention: 'debug' as const,
    acceptedAttemptId: null,
    requestDigest: 'd'.repeat(64),
    manifestDigest: 'e'.repeat(64),
    invocationRevision: 2,
    terminalAt: '2026-08-01T10:00:00.000Z',
    artifacts,
  };
  return createProviderRetentionReceipt({
    schemaVersion: 1,
    kind: 'provider-runtime-prune-receipt',
    state: 'complete',
    receiptId: providerRetentionReceiptId(identity),
    ...identity,
    terminalState,
    ttlDays: 7,
    cutoffAt: '2026-08-13T12:00:00.000Z',
    preparedAt: '2026-08-20T12:00:00.000Z',
    completedAt: '2026-08-20T12:00:01.000Z',
  });
}

function runtimePath(
  fixture: Pick<Fixture, 'runtime'>,
  request: ProviderInvocationRequest,
) {
  return path.join(
    fixture.runtime.invocations,
    request.invocationId,
    'runtime',
  );
}

function hostWrapperProbePath(
  fixture: Pick<Fixture, 'runtime'>,
  request: ProviderInvocationRequest,
) {
  return path.join(
    fixture.runtime.invocations,
    request.invocationId,
    'host-wrapper-probe-runtime',
  );
}

function hostWrapperTurnPath(
  fixture: Pick<Fixture, 'runtime'>,
  request: ProviderInvocationRequest,
) {
  return path.join(
    fixture.runtime.invocations,
    request.invocationId,
    'host-wrapper-runtime',
  );
}

function candidatePath(
  fixture: Pick<Fixture, 'runtime'>,
  request: ProviderInvocationRequest,
) {
  return path.join(
    fixture.runtime.root,
    'execution',
    'completion-candidates',
    `${sha256(request.invocationId)}.json`,
  );
}

function pinAttempt(fixture: Fixture, invocationId: string): void {
  const state = readExecutionJobState(fixture.runtime, fixture.jobId);
  assert.ok(state);
  const source = state.invocationProjection.invocations.find(
    (entry) => entry.invocationId === invocationId,
  );
  assert.ok(source);
  const attempts = state.attempts.map((attempt) =>
    attempt.attemptId === source.attemptId
      ? { ...attempt, retention: 'pinned' as const }
      : attempt,
  );
  fs.writeFileSync(
    executionJobStatePath(fixture.runtime, fixture.jobId),
    `${canonicalJson({ ...state, attempts })}\n`,
    { mode: 0o600 },
  );
}

function runWorkflowCli(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(
        sourceRepositoryRoot,
        'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
      ),
      ...args,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('physical retention resolves runtime lazily after its own validation and preserves resolver errors', () => {
  const sentinel = new Error('runtime resolution reached');
  let calls = 0;
  const resolve = (cwd: string): never => {
    assert.equal(cwd, '/memory');
    calls++;
    throw sentinel;
  };
  const now = '2026-09-01T12:00:00.000Z';
  for (const [invoke, code] of [
    [
      () =>
        pruneWithRuntime(resolve, '/memory', {
          limit: 0,
          ttlDays: 0,
          now: 'invalid',
        }),
      'PROVIDER_RETENTION_LIMIT_INVALID',
    ],
    [
      () =>
        pruneWithRuntime(resolve, '/memory', {
          limit: 1,
          ttlDays: 0,
          now: 'invalid',
        }),
      'PROVIDER_RETENTION_TTL_INVALID',
    ],
    [
      () =>
        pruneWithRuntime(resolve, '/memory', {
          limit: 1,
          ttlDays: 1,
          now: 'invalid',
        }),
      'PROVIDER_RETENTION_NOW_INVALID',
    ],
    [
      () =>
        inspectWithRuntime(resolve, '/memory', { ttlDays: 0, now: 'invalid' }),
      'PROVIDER_RETENTION_TTL_INVALID',
    ],
    [
      () =>
        inspectWithRuntime(resolve, '/memory', { ttlDays: 1, now: 'invalid' }),
      'PROVIDER_RETENTION_NOW_INVALID',
    ],
  ] as const) {
    assert.throws(invoke, (error) => isWorkflowError(error, code));
    assert.equal(calls, 0);
  }
  for (const invoke of [
    () => inspectWithRuntime(resolve, '/memory', { now }),
    () => pruneWithRuntime(resolve, '/memory', { limit: 1, now }),
  ]) {
    calls = 0;
    assert.throws(invoke, (error) => {
      assert.strictEqual(error, sentinel);
      return true;
    });
    assert.equal(calls, 1);
  }
});
